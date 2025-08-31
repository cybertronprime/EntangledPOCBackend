const { getJitsiService } = require('./JitsiService');
const { LitService } = require('./LitService');
const paraService = require('./ParaService');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

/**
 * INTEGRATED MEETING SERVICE
 * Combines Para auth + Jitsi meetings + Lit Protocol NFT gating
 */
class MeetingService {
  constructor() {
    this.jitsi = getJitsiService();
    this.lit = new LitService();
    this.initialized = false;
  }

  async initialize() {
    try {
      // Initialize Lit Protocol
      const litReady = await this.lit.initialize();
      if (litReady) {
        logger.info('Meeting Service: Lit Protocol ready');
      } else {
        logger.warn('Meeting Service: Lit Protocol not configured');
      }

      this.initialized = true;
      logger.info('Meeting Service initialized');
      return true;

    } catch (error) {
      logger.error('Failed to initialize Meeting Service:', error);
      return false;
    }
  }

  // Create a gated meeting (for auctions/NFT holders)
  async createGatedMeeting({ 
    hostUser, 
    nftContract, 
    nftTokenId, 
    meetingName,
    duration = 60,
    windowStart = null,
    windowEnd = null 
  }) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Create Jitsi room
      const room = this.jitsi.createRoom({
        roomName: meetingName || `meeting-${Date.now()}`,
        displayName: `NFT Gated Meeting`,
        duration,
        maxParticipants: 10
      });

      // Create policy for Lit Protocol gating
      const policy = {
        room: room.roomId,
        erc721: nftContract,
        litActionCid: this.lit.actionIpfsCid,
        windowStart,
        windowEnd
      };

      // Generate host token (moderator access)
      const hostToken = this.jitsi.generateToken({
        roomName: room.roomId,
        userId: hostUser.para_user_id,
        userName: hostUser.display_name,
        email: hostUser.email,
        role: 'moderator',
        expiresIn: Math.ceil(duration / 60) + 1
      });

      // Store meeting in database
      const meetingQuery = `
        INSERT INTO meetings (
          room_id, host_user_id, nft_contract, nft_token_id,
          policy, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const meetingResult = await pool.query(meetingQuery, [
        room.roomId,
        hostUser.id,
        nftContract,
        nftTokenId,
        JSON.stringify(policy),
        room.expiresAt
      ]);

      const meeting = meetingResult.rows[0];

      logger.info(`Gated meeting created: ${room.roomId} for NFT ${nftContract}:${nftTokenId}`);

      return {
        success: true,
        meeting: {
          id: meeting.id,
          roomId: room.roomId,
          url: room.url,
          policy,
          expiresAt: room.expiresAt
        },
        host: {
          token: hostToken,
          url: this.jitsi.generateMeetingUrl({
            roomId: room.roomId,
            token: hostToken,
            userName: hostUser.display_name,
            userEmail: hostUser.email,
            role: 'moderator'
          })
        }
      };

    } catch (error) {
      logger.error('Failed to create gated meeting:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Create simple Para-authenticated meeting (no NFT gating)
  async createSimpleMeeting({ hostUser, guestUser, meetingName, duration = 60 }) {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      // Create Jitsi room
      const room = this.jitsi.createRoom({
        roomName: meetingName || `simple-meeting-${Date.now()}`,
        displayName: `Meeting: ${hostUser.display_name} & ${guestUser.display_name}`,
        duration,
        maxParticipants: 2
      });

      // Generate tokens for both users
      const hostToken = this.jitsi.generateToken({
        roomName: room.roomId,
        userId: hostUser.para_user_id,
        userName: hostUser.display_name,
        email: hostUser.email,
        role: 'moderator',
        expiresIn: Math.ceil(duration / 60) + 1
      });

      const guestToken = this.jitsi.generateToken({
        roomName: room.roomId,
        userId: guestUser.para_user_id,
        userName: guestUser.display_name,
        email: guestUser.email,
        role: 'participant',
        expiresIn: Math.ceil(duration / 60) + 1
      });

      // Store meeting in database
      const meetingQuery = `
        INSERT INTO meetings (
          room_id, host_user_id, guest_user_id, 
          expires_at, created_at
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const meetingResult = await pool.query(meetingQuery, [
        room.roomId,
        hostUser.id,
        guestUser.id,
        room.expiresAt
      ]);

      const meeting = meetingResult.rows[0];

      logger.info(`Simple meeting created: ${room.roomId} between users ${hostUser.id} and ${guestUser.id}`);

      return {
        success: true,
        meeting: {
          id: meeting.id,
          roomId: room.roomId,
          url: room.url,
          expiresAt: room.expiresAt
        },
        participants: {
          host: {
            token: hostToken,
            url: this.jitsi.generateMeetingUrl({
              roomId: room.roomId,
              token: hostToken,
              userName: hostUser.display_name,
              userEmail: hostUser.email,
              role: 'moderator'
            })
          },
          guest: {
            token: guestToken,
            url: this.jitsi.generateMeetingUrl({
              roomId: room.roomId,
              token: guestToken,
              userName: guestUser.display_name,
              userEmail: guestUser.email,
              role: 'participant'
            })
          }
        }
      };

    } catch (error) {
      logger.error('Failed to create simple meeting:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Join gated meeting (requires NFT verification)
  async joinGatedMeeting({ roomId, user, nftProof }) {
    try {
      // Get meeting policy
      const meetingQuery = 'SELECT * FROM meetings WHERE room_id = $1 AND expires_at > CURRENT_TIMESTAMP';
      const meetingResult = await pool.query(meetingQuery, [roomId]);

      if (meetingResult.rows.length === 0) {
        return {
          success: false,
          error: 'Meeting not found or expired'
        };
      }

      const meeting = meetingResult.rows[0];
      const policy = JSON.parse(meeting.policy);

      // Verify NFT ownership with Lit Protocol
      if (this.lit.initialized) {
        const verification = await this.lit.verifyNFTOwnership({
          userAddress: user.wallet_address,
          contractAddress: policy.erc721,
          tokenId: meeting.nft_token_id,
          proof: nftProof
        });

        if (!verification.success) {
          return {
            success: false,
            error: 'NFT ownership verification failed',
            details: verification.error
          };
        }
      } else {
        logger.warn('Lit Protocol not available - skipping NFT verification');
      }

      // Generate attendee token
      const attendeeToken = this.jitsi.generateToken({
        roomName: roomId,
        userId: user.para_user_id,
        userName: user.display_name,
        email: user.email,
        role: 'participant',
        expiresIn: 2 // 2 hours max
      });

      logger.info(`User ${user.id} joined gated meeting ${roomId}`);

      return {
        success: true,
        token: attendeeToken,
        url: this.jitsi.generateMeetingUrl({
          roomId,
          token: attendeeToken,
          userName: user.display_name,
          userEmail: user.email,
          role: 'participant'
        }),
        meeting: {
          roomId,
          expiresAt: meeting.expires_at
        }
      };

    } catch (error) {
      logger.error('Failed to join gated meeting:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get meeting info
  async getMeetingInfo(roomId) {
    try {
      const query = 'SELECT * FROM meetings WHERE room_id = $1';
      const result = await pool.query(query, [roomId]);

      if (result.rows.length === 0) {
        return {
          success: false,
          error: 'Meeting not found'
        };
      }

      const meeting = result.rows[0];
      const policy = meeting.policy ? JSON.parse(meeting.policy) : null;

      return {
        success: true,
        meeting: {
          id: meeting.id,
          roomId: meeting.room_id,
          url: `https://8x8.vc/${meeting.room_id}`,
          policy,
          hostUserId: meeting.host_user_id,
          guestUserId: meeting.guest_user_id,
          expiresAt: meeting.expires_at,
          createdAt: meeting.created_at
        }
      };

    } catch (error) {
      logger.error('Failed to get meeting info:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new MeetingService();
