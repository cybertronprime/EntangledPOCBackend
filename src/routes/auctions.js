const express = require('express');
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const ethers = require('ethers');

// Use same approach as cron service - direct ethers instead of Web3Service
const MeetingAuctionABI = require('../contracts/MeetingAuction.json');

const router = express.Router();

const createAuctionSchema = Joi.object({
  title: Joi.string().min(1).max(255).required(),
  description: Joi.string().max(1000).optional().allow(''),
  duration: Joi.number().min(30).max(1440).required(),
  reservePrice: Joi.number().min(0.001).max(1000).required(),
  meetingDuration: Joi.number().min(15).max(180).required(),
  creatorWallet: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
  transactionHash: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required()
});

// Record auction creation (after frontend creates it on blockchain)
router.post('/created', authenticateToken, async (req, res) => {
  try {
    const { error, value } = createAuctionSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.details[0].message 
      });
    }
    
    const { 
      title, description, duration, reservePrice, meetingDuration, 
      creatorWallet, transactionHash 
    } = value;
    const { paraUserId } = req.user;
    
    // Use ethers directly like cron service
    const contractAddress = process.env.CONTRACT_ADDRESS || '0xceBD87246e91C7D70C82D5aE5C196a0028543933';
    const rpcUrl = process.env.RPC_URL || process.env.AVALANCHE_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    
    // Verify transaction exists and get auction ID
    const receipt = await provider.getTransactionReceipt(transactionHash);
    
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Invalid or failed transaction' });
    }
    
    // For now, we'll use a simple approach - get auction ID from database or increment
    // In a real implementation, you'd parse the transaction logs
    // But for testing, let's use a simpler approach
    const latestAuctionResult = await pool.query('SELECT MAX(id) as max_id FROM auctions');
    const auctionId = (latestAuctionResult.rows[0].max_id || 0) + 1;
    
    // Store in database
    const insertQuery = `
      INSERT INTO auctions (
        id, contract_address, creator_para_id, creator_wallet,
        title, description, metadata_ipfs, meeting_duration
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    
    const metadataIPFS = `metadata_${auctionId}_${Date.now()}`;
    
    const result = await pool.query(insertQuery, [
      auctionId,
      contractAddress,
      paraUserId,
      creatorWallet.toLowerCase(),
      title,
      description || '',
      metadataIPFS,
      meetingDuration
    ]);
    
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Auction already recorded' });
    }
    
    logger.info(`Auction ${auctionId} recorded for Para user ${paraUserId}`);
    
    res.json({
      success: true,
      auctionId,
      transactionHash,
      blockNumber: receipt.blockNumber
    });
    
  } catch (error) {
    logger.error('Record auction error:', error);
    res.status(500).json({ 
      error: 'Failed to record auction',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get active auctions
router.get('/active', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    
    // Get active auctions from database with user info
    const query = `
      SELECT 
        a.*, 
        u.display_name as creator_name,
        u.auth_type,
        u.oauth_method
      FROM auctions a
      JOIN users u ON a.creator_para_id = u.para_user_id
      WHERE a.auto_ended = false
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    
    const result = await pool.query(query, [limit, offset]);
    const auctions = [];
    
    // Use ethers directly like cron service - same pattern that works!
    const contractAddress = process.env.CONTRACT_ADDRESS || '0xceBD87246e91C7D70C82D5aE5C196a0028543933';
    const rpcUrl = process.env.RPC_URL || process.env.AVALANCHE_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, MeetingAuctionABI, provider);
    
    // Enrich with blockchain data
    for (const auction of result.rows) {
      try {
        const contractAuction = await contract.getAuction(auction.id);
        
        if (!contractAuction.ended) {
          auctions.push({
            id: auction.id,
            title: auction.title,
            description: auction.description,
            creatorParaId: auction.creator_para_id,
            creatorWallet: auction.creator_wallet,
            creatorName: auction.creator_name,
            authType: auction.auth_type,
            oAuthMethod: auction.oauth_method,
            meetingDuration: auction.meeting_duration,
            reservePrice: ethers.utils.formatEther(contractAuction.reservePrice || '0'),
            highestBid: ethers.utils.formatEther(contractAuction.highestBid || '0'),
            highestBidder: contractAuction.highestBidder,
            startBlock: contractAuction.startBlock ? contractAuction.startBlock.toNumber() : 0,
            endBlock: contractAuction.endBlock ? contractAuction.endBlock.toNumber() : 0,
            createdAt: auction.created_at
          });
        }
      } catch (error) {
        logger.warn(`Failed to get blockchain data for auction ${auction.id}:`, error.message);
        // Include auction with database data only if blockchain fails
        auctions.push({
          id: auction.id,
          title: auction.title,
          description: auction.description,
          creatorParaId: auction.creator_para_id,
          creatorWallet: auction.creator_wallet,
          creatorName: auction.creator_name,
          authType: auction.auth_type,
          oAuthMethod: auction.oauth_method,
          meetingDuration: auction.meeting_duration,
          createdAt: auction.created_at,
          blockchainError: error.message
        });
      }
    }
    
    res.json({ 
      success: true, 
      auctions,
      total: auctions.length,
      offset,
      limit 
    });
    
  } catch (error) {
    logger.error('Get active auctions error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch auctions',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get user's created auctions
router.get('/user/created', authenticateToken, async (req, res) => {
  try {
    const { paraUserId } = req.user;
    
    const query = `
      SELECT a.*, 
        CASE WHEN m.id IS NOT NULL THEN true ELSE false END as has_meeting
      FROM auctions a 
      LEFT JOIN meetings m ON a.id = m.auction_id
      WHERE a.creator_para_id = $1 
      ORDER BY a.created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(query, [paraUserId]);
    res.json({ success: true, auctions: result.rows });
    
  } catch (error) {
    logger.error('Get user auctions error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user auctions',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get auction details
router.get('/:auctionId', async (req, res) => {
  try {
    const { auctionId } = req.params;
    
    if (!auctionId || isNaN(auctionId)) {
      return res.status(400).json({ error: 'Invalid auction ID' });
    }
    
    // Get from database first
    const dbQuery = `
      SELECT a.*, u.display_name as creator_name, u.auth_type, u.oauth_method
      FROM auctions a
      JOIN users u ON a.creator_para_id = u.para_user_id
      WHERE a.id = $1
    `;
    const dbResult = await pool.query(dbQuery, [auctionId]);
    
    if (dbResult.rows.length === 0) {
      return res.status(404).json({ error: 'Auction not found' });
    }
    
    const auction = dbResult.rows[0];
    
    // Get blockchain data
    const web3Service = getWeb3Service();
    const contractAuction = await web3Service.getAuction(auctionId);
    
    if (contractAuction.id === '0') {
      return res.status(404).json({ error: 'Auction not found on blockchain' });
    }
    
    const enrichedAuction = {
      ...auction,
      reservePrice: web3Service.web3.utils.fromWei(contractAuction.reservePrice, 'ether'),
      highestBid: web3Service.web3.utils.fromWei(contractAuction.highestBid, 'ether'),
      highestBidder: contractAuction.highestBidder,
      startBlock: contractAuction.startBlock,
      endBlock: contractAuction.endBlock,
      ended: contractAuction.ended,
      meetingScheduled: contractAuction.meetingScheduled,
      nftTokenId: contractAuction.nftTokenId
    };
    
    res.json({ success: true, auction: enrichedAuction });
    
  } catch (error) {
    logger.error('Get auction error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch auction',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;
