const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

class JitsiService {
  constructor() {
    // Basic Jitsi configuration  
    this.domain = process.env.JITSI_DOMAIN || '8x8.vc'; // JaaS domain
    this.appId = process.env.JITSI_APP_ID || process.env.JAAS_APP_ID || 'meeting-app';
    
    // JaaS JWT configuration
    this.privateKey = process.env.JITSI_PRIVATE_KEY || process.env.JAAS_PRIVATE_KEY;
    this.kid = process.env.JITSI_KID || process.env.JAAS_KID;
    this.sub = process.env.JAAS_SUB || this.appId;
    
    // Configuration status
    this.jwtEnabled = !!(this.privateKey && this.kid && this.sub);
    
    if (!this.jwtEnabled) {
      logger.warn('JaaS JWT not configured - meetings will use basic URLs without pre-authentication');
      logger.info('To enable JWT tokens, set: JAAS_APP_ID, JAAS_PRIVATE_KEY, JAAS_KID, JAAS_SUB');
    } else {
      logger.info('JaaS JWT configuration found - tokens will be generated');
    }
  }
  
  // Create a meeting room
  createRoom({ roomName, displayName, duration = 60, maxParticipants = 10 }) {
    try {
      // Generate unique room ID (without app prefix - will be added later)
      const timestamp = Date.now();
      const roomId = `${roomName}-${timestamp}`;
      
      const expiresAt = new Date(Date.now() + (duration * 60 * 1000));
      
      // Room configuration optimized for meetings
      const roomConfig = {
        // Core settings
        enableWelcomePage: false,
        enableClosePage: false,
        prejoinPageEnabled: false,
        requireDisplayName: true,
        
        // Audio/Video
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        
        // UI optimization
        interfaceConfig: {
          TOOLBAR_BUTTONS: [
            'microphone', 'camera', 'hangup', 'chat', 
            'desktop', 'fullscreen', 'settings', 'raisehand'
          ],
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          filmStripOnly: false
        },
        
        // Meeting settings
        subject: displayName || 'Meeting',
        enableTalkWhileMuted: true,
        disableModeratorIndicator: false
      };
      
      // Generate room URL with full qualified name for JaaS
      const fullRoomName = `${this.appId}/${roomId}`;
      const roomUrl = `https://${this.domain}/${fullRoomName}`;
      
      logger.info(`Meeting room created: ${roomId} (expires: ${expiresAt})`);
      
      return {
        roomId,
        roomName,
        displayName,
        url: roomUrl,
        config: roomConfig,
        expiresAt,
        duration,
        maxParticipants,
        domain: this.domain,
        appId: this.appId,
        jwtEnabled: this.jwtEnabled
      };
      
    } catch (error) {
      logger.error('Failed to create meeting room:', error);
      throw error;
    }
  }
  
  // Generate JWT token (if JaaS is configured)
  generateToken({ roomName, userId, userName, email, role = 'participant', expiresIn = 2 }) {
    if (!this.jwtEnabled) {
      logger.warn('JWT token requested but JaaS not configured');
      return null;
    }
    
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // CORRECTED JaaS JWT payload - room must be full qualified name
      const fullRoomName = `${this.appId}/${roomName}`;
      
      const payload = {
        aud: 'jitsi',
        iss: 'chat',
        sub: this.appId,
        room: '*', // Use '*' for universal access as per official docs
        exp: now + (expiresIn * 60 * 60),
        nbf: now - 10, // Not before (10 seconds ago for clock skew)
        context: {
          user: {
            id: userId,
            name: userName,
            email: email || '',
            moderator: role === 'moderator' ? 'true' : 'false', // STRING not boolean!
            avatar: ''
          },
          features: {
            livestreaming: role === 'moderator' ? 'true' : 'false', // STRING not boolean!
            recording: role === 'moderator' ? 'true' : 'false',     // STRING not boolean!
            transcription: 'false',
            'outbound-call': 'false'
          }
        }
      };
      
      // Sign with RS256 (simplified header like official docs)
      const token = jwt.sign(payload, this.privateKey, { 
        algorithm: 'RS256',
        header: { 
          kid: this.kid
        }
      });
      
      logger.info(`JWT token generated for ${userName} (${role}) in room ${roomName}`);
      return token;
      
    } catch (error) {
      logger.error('Failed to generate JWT token:', error);
      return null;
    }
  }
  
  // Generate meeting URL with optional JWT
  generateMeetingUrl({ roomId, token = null, userName = null, userEmail = null }) {
    // Use full qualified room name for JaaS
    const fullRoomName = `${this.appId}/${roomId}`;
    let url = `https://${this.domain}/${fullRoomName}`;
    
    if (token) {
      // Use JWT token for authentication
      url += `?jwt=${token}`;
    } else if (userName) {
      // Use URL parameters for basic setup
      url += `?displayName=${encodeURIComponent(userName)}`;
      if (userEmail) {
        url += `&userEmail=${encodeURIComponent(userEmail)}`;
      }
    }
    
    return url;
  }
  
  // Create meeting for auction participants (host only initially)
  createAuctionMeeting({ auctionId, hostData, duration = 60 }) {
    try {
      // Create room
      const room = this.createRoom({
        roomName: `auction-${auctionId}`,
        displayName: `Auction ${auctionId} Meeting`,
        duration,
        maxParticipants: 2
      });
      
      // Generate host token (if JWT enabled)
      const hostToken = this.generateToken({
        roomName: room.roomId,
        userId: hostData.paraId,
        userName: hostData.name,
        email: hostData.email,
        role: 'moderator',
        expiresIn: Math.ceil(duration / 60) + 1
      });
      
      // Generate host URL
      const hostUrl = this.generateMeetingUrl({
        roomId: room.roomId,
        token: hostToken,
        userName: hostData.name,
        userEmail: hostData.email
      });
      
      logger.info(`Auction meeting created: ${room.roomId} for auction ${auctionId}`);
      
      return {
        success: true,
        meeting: {
          roomId: room.roomId,
          url: room.url,
          expiresAt: room.expiresAt,
          duration: room.duration
        },
        host: {
          token: hostToken,
          url: hostUrl,
          role: 'moderator'
        },
        // Attendee access will be generated later after verification
        attendeeAccess: {
          roomId: room.roomId,
          available: false,
          note: 'Attendee access granted after verification'
        }
      };
      
    } catch (error) {
      logger.error('Failed to create auction meeting:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Generate attendee access (after verification)
  generateAttendeeAccess({ roomId, attendeeData, expiresIn = 2 }) {
    try {
      // Generate attendee token (if JWT enabled)
      const attendeeToken = this.generateToken({
        roomName: roomId,
        userId: attendeeData.paraId,
        userName: attendeeData.name,
        email: attendeeData.email,
        role: 'participant',
        expiresIn
      });
      
      // Generate attendee URL
      const attendeeUrl = this.generateMeetingUrl({
        roomId,
        token: attendeeToken,
        userName: attendeeData.name,
        userEmail: attendeeData.email
      });
      
      logger.info(`Attendee access generated for ${attendeeData.name} in room ${roomId}`);
      
      return {
        success: true,
        attendee: {
          token: attendeeToken,
          url: attendeeUrl,
          role: 'participant',
          expiresIn: `${expiresIn} hours`
        }
      };
      
    } catch (error) {
      logger.error('Failed to generate attendee access:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Utility methods
  getRoomInfo(roomId) {
    return {
      roomId,
      url: `https://${this.domain}/${roomId}`,
      domain: this.domain,
      jwtEnabled: this.jwtEnabled
    };
  }
}

let jitsiService;

function getJitsiService() {
  if (!jitsiService) {
    jitsiService = new JitsiService();
  }
  return jitsiService;
}

module.exports = { JitsiService, getJitsiService };
