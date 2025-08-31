const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const meetingService = require('../services/MeetingService');
const paraService = require('../services/ParaService');
const { pool } = require('../config/database');
const ethers = require('ethers');
const MeetingAuctionABI = require('../contracts/MeetingAuction.json');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize meeting service
meetingService.initialize().catch(err => {
  logger.error('Failed to initialize meeting service:', err);
});

// Create simple Para-authenticated meeting
router.post('/create-simple', authenticateToken, async (req, res) => {
  try {
    const { guestUserId, meetingName, duration = 60 } = req.body;
    const hostUser = req.user;

    if (!guestUserId) {
      return res.status(400).json({
        error: 'Guest user ID is required',
        required: ['guestUserId']
      });
    }

    // Get guest user info
    const guestQuery = 'SELECT * FROM users WHERE id = $1';
    const guestResult = await pool.query(guestQuery, [guestUserId]);

    if (guestResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Guest user not found'
      });
    }

    const guestUser = guestResult.rows[0];

    // Create meeting
    const result = await meetingService.createSimpleMeeting({
      hostUser,
      guestUser,
      meetingName,
      duration
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to create meeting',
        details: result.error
      });
    }

    logger.info(`Simple meeting created by user ${hostUser.id} with guest ${guestUserId}`);
    
    res.json({
      success: true,
      meeting: result.meeting,
      participants: result.participants,
      note: 'Meeting created successfully. Both users can join with their respective URLs.'
    });
    
  } catch (error) {
    logger.error('Create simple meeting error:', error);
    res.status(500).json({ 
      error: 'Failed to create meeting',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Create NFT-gated meeting
router.post('/create-gated', authenticateToken, async (req, res) => {
  try {
    const { nftContract, nftTokenId, meetingName, duration = 60, windowStart, windowEnd } = req.body;
    const hostUser = req.user;

    if (!nftContract || !nftTokenId) {
      return res.status(400).json({
        error: 'NFT contract and token ID are required',
        required: ['nftContract', 'nftTokenId']
      });
    }

    // Verify host owns the NFT (optional check)
    if (hostUser.wallet_address) {
      const verification = await paraService.verifyWalletOwnership(hostUser.wallet_address);
      if (!verification.success) {
        logger.warn(`Host wallet verification failed for user ${hostUser.id}`);
      }
    }

    // Create gated meeting
    const result = await meetingService.createGatedMeeting({
      hostUser,
      nftContract,
      nftTokenId,
      meetingName,
      duration,
      windowStart,
      windowEnd
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to create gated meeting',
        details: result.error
      });
    }

    logger.info(`Gated meeting created by user ${hostUser.id} for NFT ${nftContract}:${nftTokenId}`);

    res.json({
      success: true,
      meeting: result.meeting,
      host: result.host,
      note: 'NFT-gated meeting created. Users must verify NFT ownership to join.'
    });

  } catch (error) {
    logger.error('Create gated meeting error:', error);
    res.status(500).json({
      error: 'Failed to create gated meeting',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Join gated meeting (requires NFT verification)
router.post('/join-gated/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { nftProof } = req.body;
    const user = req.user;

    if (!user.wallet_address) {
      return res.status(400).json({
        error: 'Wallet address required for NFT verification',
        hint: 'User must import Para session with wallet access'
      });
    }

    // Join gated meeting
    const result = await meetingService.joinGatedMeeting({
      roomId,
      user,
      nftProof
    });

    if (!result.success) {
      return res.status(401).json({
        error: 'Failed to join meeting',
        details: result.error
      });
    }

    logger.info(`User ${user.id} joined gated meeting ${roomId}`);

    res.json({
      success: true,
      token: result.token,
      url: result.url,
      meeting: result.meeting,
      note: 'NFT ownership verified. You can now join the meeting.'
    });

  } catch (error) {
    logger.error('Join gated meeting error:', error);
    res.status(500).json({
      error: 'Failed to join meeting',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get meeting info
router.get('/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;

    const result = await meetingService.getMeetingInfo(roomId);

    if (!result.success) {
      return res.status(404).json({
        error: 'Meeting not found',
        details: result.error
      });
    }
    
    res.json({
      success: true,
      meeting: result.meeting
    });
    
  } catch (error) {
    logger.error('Get meeting info error:', error);
    res.status(500).json({ 
      error: 'Failed to get meeting info',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// List user's meetings
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = `
      SELECT m.*, 
             h.display_name as host_name,
             g.display_name as guest_name
      FROM meetings m
      LEFT JOIN users h ON m.host_user_id = h.id
      LEFT JOIN users g ON m.guest_user_id = g.id
      WHERE m.host_user_id = $1 OR m.guest_user_id = $1
      ORDER BY m.created_at DESC
      LIMIT 20
    `;

    const result = await pool.query(query, [userId]);

    const meetings = result.rows.map(meeting => ({
      id: meeting.id,
      roomId: meeting.room_id,
      url: `https://8x8.vc/${meeting.room_id}`,
      hostName: meeting.host_name,
      guestName: meeting.guest_name,
      policy: meeting.policy ? JSON.parse(meeting.policy) : null,
      status: meeting.status,
      expiresAt: meeting.expires_at,
      createdAt: meeting.created_at
    }));
    
    res.json({ 
      success: true, 
      meetings
    });
    
  } catch (error) {
    logger.error('List meetings error:', error);
    res.status(500).json({ 
      error: 'Failed to list meetings',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Test meeting creation (simple test endpoint)
router.post('/test-create', async (req, res) => {
  try {
    const { hostEmail = 'host@test.com', guestEmail = 'guest@test.com' } = req.body;

    // Create test users if they don't exist
    const createUser = async (email) => {
      const userQuery = `
        INSERT INTO users (para_user_id, email, auth_type, display_name, created_at)
        VALUES ($1, $2, 'email', $3, CURRENT_TIMESTAMP)
        ON CONFLICT (para_user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `;
      const paraUserId = `test_${Buffer.from(email).toString('base64').slice(0, 16)}`;
      const result = await pool.query(userQuery, [paraUserId, email, email]);
      return result.rows[0];
    };

    const hostUser = await createUser(hostEmail);
    const guestUser = await createUser(guestEmail);

    // Create simple meeting
    const result = await meetingService.createSimpleMeeting({
      hostUser,
      guestUser,
      meetingName: 'Test Meeting',
      duration: 30
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to create test meeting',
        details: result.error
      });
    }

    res.json({
      success: true,
      meeting: result.meeting,
      participants: result.participants,
      note: 'Test meeting created successfully'
    });

  } catch (error) {
    logger.error('Test create meeting error:', error);
    res.status(500).json({
      error: 'Failed to create test meeting',
      message: error.message
    });
  }
});

// ========================================
// AUCTION MEETING ROUTES
// ========================================

/**
 * Get "My Meetings" - For auction creators to see their meeting links
 */
router.get('/my-meetings', authenticateToken, async (req, res) => {
  try {
    const userWallet = req.user.walletAddress;
    
    if (!userWallet) {
      return res.status(400).json({
        success: false,
        error: 'User wallet address not found'
      });
    }

    // Get all auctions created by this user that have meetings
    const result = await pool.query(`
      SELECT 
        a.id as auction_id,
        a.title,
        a.description,
        a.meeting_duration,
        a.created_at as auction_created,
        m.jitsi_room_id,
        m.room_url,
        m.creator_access_token,
        m.scheduled_at,
        m.expires_at
      FROM auctions a
      LEFT JOIN meetings m ON a.id = m.auction_id
      WHERE a.creator_wallet = $1 
        AND m.id IS NOT NULL
      ORDER BY a.created_at DESC
    `, [userWallet.toLowerCase()]);

    const meetings = result.rows.map(row => ({
      auctionId: row.auction_id,
      title: row.title,
      description: row.description,
      duration: row.meeting_duration,
      meetingUrl: `${row.room_url}?jwt=${row.creator_access_token}`,
      scheduledAt: row.scheduled_at,
      expiresAt: row.expires_at,
      status: 'active'
    }));

    res.json({
      success: true,
      meetings: meetings,
      total: meetings.length
    });

  } catch (error) {
    logger.error('Error fetching user meetings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch meetings'
    });
  }
});

/**
 * Access meeting as auction winner - Verifies NFT ownership first
 */
router.post('/access-winner-meeting', authenticateToken, async (req, res) => {
  try {
    const { auctionId, nftTokenId } = req.body;
    const userWallet = req.user.walletAddress;

    if (!userWallet) {
      return res.status(400).json({
        success: false,
        error: 'User wallet address not found'
      });
    }

    if (!auctionId || !nftTokenId) {
      return res.status(400).json({
        success: false,
        error: 'Auction ID and NFT Token ID are required'
      });
    }

    // Initialize contract
    const contractAddress = process.env.CONTRACT_ADDRESS || '0xceBD87246e91C7D70C82D5aE5C196a0028543933';
    const rpcUrl = process.env.RPC_URL || process.env.AVALANCHE_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, MeetingAuctionABI, provider);

    // Verify NFT ownership
    try {
      const owner = await contract.ownerOf(nftTokenId);
      if (owner.toLowerCase() !== userWallet.toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'You do not own this NFT'
        });
      }
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'NFT not found or does not exist'
      });
    }

    // Check if NFT can be burned for meeting access
    const canBurn = await contract.canBurnForMeeting(nftTokenId, userWallet);
    if (!canBurn) {
      return res.status(403).json({
        success: false,
        error: 'NFT cannot be used for meeting access. Meeting may not be scheduled or NFT already used.'
      });
    }

    // Get meeting data from database
    const meetingResult = await pool.query(`
      SELECT 
        m.jitsi_room_id,
        m.room_url,
        m.winner_access_token,
        m.expires_at,
        a.title,
        a.description,
        a.meeting_duration
      FROM meetings m
      JOIN auctions a ON m.auction_id = a.id
      WHERE m.auction_id = $1
    `, [auctionId]);
    
    if (meetingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Meeting not found for this auction'
      });
    }
    
    const meeting = meetingResult.rows[0];
    
    // Check if meeting has expired
    if (meeting.expires_at && new Date() > new Date(meeting.expires_at)) {
      return res.status(410).json({
        success: false,
        error: 'Meeting has expired'
      });
    }
    
    res.json({
      success: true,
      meeting: {
        auctionId: auctionId,
        nftTokenId: nftTokenId,
        title: meeting.title,
        description: meeting.description,
        duration: meeting.meeting_duration,
        meetingUrl: `${meeting.room_url}?jwt=${meeting.winner_access_token}`,
        expiresAt: meeting.expires_at,
        requiresBurn: true,
        message: 'You can access this meeting. Note: Your NFT will be burned when you join.'
      }
    });
    
  } catch (error) {
    logger.error('Error accessing winner meeting:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to verify meeting access'
    });
  }
});

/**
 * Burn NFT and get final meeting access - Called after blockchain burn transaction
 */
router.post('/burn-nft-access', authenticateToken, async (req, res) => {
  try {
    const { auctionId, nftTokenId, transactionHash } = req.body;
    const userWallet = req.user.walletAddress;

    if (!userWallet || !auctionId || !nftTokenId || !transactionHash) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required: auctionId, nftTokenId, transactionHash'
      });
    }

    // Verify transaction on blockchain
    const rpcUrl = process.env.RPC_URL || process.env.AVALANCHE_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    
    try {
      const receipt = await provider.getTransactionReceipt(transactionHash);
      
      if (!receipt) {
        return res.status(400).json({
          success: false,
          error: 'Transaction not found or not confirmed'
        });
      }

      // Verify transaction was successful
      if (receipt.status !== 1) {
        return res.status(400).json({
          success: false,
          error: 'Transaction failed'
        });
      }

      // Verify transaction is from the correct user
      if (receipt.from.toLowerCase() !== userWallet.toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'Transaction not from your wallet'
        });
      }

      // TODO: Add more sophisticated verification of burn event in transaction logs

    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Failed to verify transaction'
      });
    }

    // Check if this transaction has already been used
    const existingLog = await pool.query(
      'SELECT id FROM meeting_access_logs WHERE transaction_hash = $1',
      [transactionHash]
    );

    if (existingLog.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'This transaction has already been used'
      });
    }

    // Get meeting data
    const meetingResult = await pool.query(`
      SELECT 
        m.jitsi_room_id,
        m.room_url,
        m.winner_access_token,
        m.expires_at,
        a.title,
        a.description,
        a.meeting_duration
      FROM meetings m
      JOIN auctions a ON m.auction_id = a.id
      WHERE m.auction_id = $1
    `, [auctionId]);
    
    if (meetingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Meeting not found'
      });
    }
    
    const meeting = meetingResult.rows[0];
    
    // Log the access
    await pool.query(`
      INSERT INTO meeting_access_logs (
        auction_id, user_para_id, wallet_address, nft_token_id, 
        transaction_hash, access_method
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      auctionId,
      req.user.paraUserId,
      userWallet,
      nftTokenId,
      transactionHash,
      'nft_burn'
    ]);

    res.json({
      success: true,
      message: 'NFT burned successfully! You can now access the meeting.',
      meeting: {
        auctionId: auctionId,
        title: meeting.title,
        description: meeting.description,
        duration: meeting.meeting_duration,
        meetingUrl: `${meeting.room_url}?jwt=${meeting.winner_access_token}`,
        expiresAt: meeting.expires_at
      }
    });

  } catch (error) {
    logger.error('Error processing NFT burn access:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process NFT burn access'
    });
  }
});

/**
 * Get auction winner's NFTs - Helper to find which NFTs can be burned
 */
router.get('/my-auction-nfts', authenticateToken, async (req, res) => {
  try {
    const userWallet = req.user.walletAddress;

    if (!userWallet) {
      return res.status(400).json({
        success: false,
        error: 'User wallet address not found'
      });
    }

    // Initialize contract
    const contractAddress = process.env.CONTRACT_ADDRESS || '0xceBD87246e91C7D70C82D5aE5C196a0028543933';
    const rpcUrl = process.env.RPC_URL || process.env.AVALANCHE_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, MeetingAuctionABI, provider);

    // Get NFTs owned by user
    const [tokenIds, auctionIds] = await contract.getNFTsOwnedByUser(userWallet);

    const nfts = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const tokenId = tokenIds[i];
      const auctionId = auctionIds[i];

      // Get NFT metadata
      const metadata = await contract.getNFTMetadata(tokenId);
      
      // Check if can burn for meeting
      const canBurn = await contract.canBurnForMeeting(tokenId, userWallet);

      // Get auction details from database
      const auctionResult = await pool.query(
        'SELECT title, description FROM auctions WHERE id = $1',
        [auctionId.toString()]
      );

      const auctionData = auctionResult.rows[0];

      nfts.push({
        tokenId: tokenId.toString(),
        auctionId: auctionId.toString(),
        title: auctionData?.title || `Auction ${auctionId}`,
        description: auctionData?.description || '',
        hostTwitterId: metadata.hostTwitterId,
        meetingDuration: metadata.meetingDuration.toString(),
        mintTimestamp: metadata.mintTimestamp.toString(),
        canBurnForMeeting: canBurn
      });
    }
    
    res.json({
      success: true,
      nfts: nfts,
      total: nfts.length
    });
    
  } catch (error) {
    logger.error('Error fetching user NFTs:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch NFTs'
    });
  }
});

module.exports = router;