const { ethers } = require('ethers');
require('dotenv').config();

// Contract configuration
const CONTRACT_CONFIG = {
  FUJI: {
    address: '0x17199dd9acB0Cf8f6b58c7DB1BDA6f26dF875B00',
    chainId: 43113,
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorer: 'https://testnet.snowtrace.io'
  },
  AVALANCHE: {
    address: '', // Will be set after mainnet deployment
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io'
  }
};

// Contract ABI (simplified for backend)
const CONTRACT_ABI = [
  // Events
  "event AuctionCreated(uint256 indexed auctionId, address indexed host, string twitterId, uint256 reservePrice, uint256 endBlock, string metadataIPFS)",
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 newEndBlock)",
  "event AuctionEnded(uint256 indexed auctionId, address indexed winner, address indexed host, uint256 winningBid)",
  "event MeetingScheduled(uint256 indexed auctionId, string meetingAccessHash)",
  "event FundsWithdrawn(uint256 indexed auctionId, address indexed recipient, uint256 amount)",
  
  // View functions
  "function getAuction(uint256 _auctionId) external view returns (tuple(uint256 id, address host, uint256 startBlock, uint256 endBlock, uint256 reservePrice, uint256 highestBid, address highestBidder, string meetingMetadataIPFS, string hostTwitterId, bool ended, bool meetingScheduled, uint256 duration))",
  "function getActiveAuctions() external view returns (uint256[])",
  "function getPendingReturn(uint256 _auctionId, address _bidder) external view returns (uint256)",
  "function auctionCounter() external view returns (uint256)",
  "function platformFee() external view returns (uint256)",
  "function owner() external view returns (address)",
  
  // State-changing functions
  "function createAuction(address _host, string memory _twitterId, uint256 _duration, uint256 _reservePrice, string memory _metadataIPFS, uint256 _meetingDuration) external returns (uint256)",
  "function placeBid(uint256 _auctionId) external payable",
  "function endAuction(uint256 _auctionId) external",
  "function scheduleMeeting(uint256 _auctionId, string memory _meetingAccessHash) external",
  "function withdrawBid(uint256 _auctionId) external"
];

class Web3Service {
  constructor(network = 'FUJI') {
    this.network = network;
    this.config = CONTRACT_CONFIG[network];
    this.provider = null;
    this.contract = null;
    this.wallet = null;
    this.initialize();
  }

  initialize() {
    try {
      // Initialize provider
      this.provider = new ethers.providers.JsonRpcProvider(this.config.rpcUrl);
      
      // Initialize wallet with private key
      const privateKey = process.env.PRIVATE_KEY;
      if (!privateKey) {
        throw new Error('PRIVATE_KEY not found in environment variables');
      }
      
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      
      // Initialize contract
      this.contract = new ethers.Contract(
        this.config.address,
        CONTRACT_ABI,
        this.wallet
      );
      
      console.log(`✅ Web3Service initialized for ${this.network} network`);
      console.log(`📋 Contract address: ${this.config.address}`);
      console.log(`👤 Wallet address: ${this.wallet.address}`);
      
    } catch (error) {
      console.error('❌ Failed to initialize Web3Service:', error);
      throw error;
    }
  }

  // Get contract instance
  getContract() {
    return this.contract;
  }

  // Get provider
  getProvider() {
    return this.provider;
  }

  // Get wallet
  getWallet() {
    return this.wallet;
  }

  // Get network configuration
  getNetworkConfig() {
    return this.config;
  }

  // Create a new auction (backend only - requires owner privileges)
  async createAuction(host, twitterId, duration, reservePrice, metadataIPFS, meetingDuration) {
    try {
      console.log(`📝 Creating auction for host: ${host}`);
      console.log(`🐦 Twitter ID: ${twitterId}`);
      console.log(`💰 Reserve price: ${reservePrice} AVAX`);
      
      const reservePriceWei = ethers.utils.parseEther(reservePrice.toString());
      
      const tx = await this.contract.createAuction(
        host,
        twitterId,
        duration,
        reservePriceWei,
        metadataIPFS,
        meetingDuration
      );
      
      console.log(`⏳ Waiting for transaction: ${tx.hash}`);
      const receipt = await tx.wait();
      
      console.log(`✅ Auction created successfully!`);
      console.log(`📋 Transaction hash: ${receipt.transactionHash}`);
      console.log(`📦 Block number: ${receipt.blockNumber}`);
      
      // Get the auction ID from the event
      const event = receipt.events?.find(e => e.event === 'AuctionCreated');
      const auctionId = event?.args?.auctionId?.toNumber();
      
      return {
        success: true,
        auctionId,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber
      };
      
    } catch (error) {
      console.error('❌ Failed to create auction:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get auction details
  async getAuction(auctionId) {
    try {
      const auction = await this.contract.getAuction(auctionId);
      
      return {
        id: auction.id.toNumber(),
        host: auction.host,
        startBlock: auction.startBlock.toNumber(),
        endBlock: auction.endBlock.toNumber(),
        reservePrice: ethers.utils.formatEther(auction.reservePrice),
        highestBid: ethers.utils.formatEther(auction.highestBid),
        highestBidder: auction.highestBidder,
        meetingMetadataIPFS: auction.meetingMetadataIPFS,
        hostTwitterId: auction.hostTwitterId,
        ended: auction.ended,
        meetingScheduled: auction.meetingScheduled,
        duration: auction.duration.toNumber()
      };
      
    } catch (error) {
      console.error(`❌ Failed to get auction ${auctionId}:`, error);
      throw error;
    }
  }

  // Get all active auctions
  async getActiveAuctions() {
    try {
      const activeAuctions = await this.contract.getActiveAuctions();
      return activeAuctions.map(id => id.toNumber());
    } catch (error) {
      console.error('❌ Failed to get active auctions:', error);
      throw error;
    }
  }

  // Get contract statistics
  async getContractStats() {
    try {
      const [auctionCounter, platformFee, owner] = await Promise.all([
        this.contract.auctionCounter(),
        this.contract.platformFee(),
        this.contract.owner()
      ]);
      
      return {
        auctionCounter: auctionCounter.toNumber(),
        platformFee: platformFee.toNumber(),
        owner
      };
    } catch (error) {
      console.error('❌ Failed to get contract stats:', error);
      throw error;
    }
  }

  // Schedule meeting (backend only - requires owner privileges)
  async scheduleMeeting(auctionId, meetingAccessHash) {
    try {
      console.log(`📅 Scheduling meeting for auction ${auctionId}`);
      
      const tx = await this.contract.scheduleMeeting(auctionId, meetingAccessHash);
      const receipt = await tx.wait();
      
      console.log(`✅ Meeting scheduled successfully!`);
      console.log(`📋 Transaction hash: ${receipt.transactionHash}`);
      
      return {
        success: true,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber
      };
      
    } catch (error) {
      console.error('❌ Failed to schedule meeting:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Monitor contract events
  async monitorEvents() {
    console.log('🎧 Starting event monitoring...');
    
    // Monitor AuctionCreated events
    this.contract.on('AuctionCreated', (auctionId, host, twitterId, reservePrice, endBlock, metadataIPFS) => {
      console.log('🎉 New auction created:');
      console.log(`   Auction ID: ${auctionId.toString()}`);
      console.log(`   Host: ${host}`);
      console.log(`   Twitter ID: ${twitterId}`);
      console.log(`   Reserve Price: ${ethers.utils.formatEther(reservePrice)} AVAX`);
      console.log(`   End Block: ${endBlock.toString()}`);
      console.log(`   Metadata: ${metadataIPFS}`);
    });
    
    // Monitor BidPlaced events
    this.contract.on('BidPlaced', (auctionId, bidder, amount, newEndBlock) => {
      console.log('💰 New bid placed:');
      console.log(`   Auction ID: ${auctionId.toString()}`);
      console.log(`   Bidder: ${bidder}`);
      console.log(`   Amount: ${ethers.utils.formatEther(amount)} AVAX`);
      console.log(`   New End Block: ${newEndBlock.toString()}`);
    });
    
    // Monitor AuctionEnded events
    this.contract.on('AuctionEnded', (auctionId, winner, host, winningBid) => {
      console.log('🏆 Auction ended:');
      console.log(`   Auction ID: ${auctionId.toString()}`);
      console.log(`   Winner: ${winner}`);
      console.log(`   Host: ${host}`);
      console.log(`   Winning Bid: ${ethers.utils.formatEther(winningBid)} AVAX`);
    });
    
    // Monitor MeetingScheduled events
    this.contract.on('MeetingScheduled', (auctionId, meetingAccessHash) => {
      console.log('📅 Meeting scheduled:');
      console.log(`   Auction ID: ${auctionId.toString()}`);
      console.log(`   Meeting Access Hash: ${meetingAccessHash}`);
    });
  }

  // Get wallet balance
  async getBalance() {
    try {
      const balance = await this.wallet.getBalance();
      return ethers.utils.formatEther(balance);
    } catch (error) {
      console.error('❌ Failed to get balance:', error);
      throw error;
    }
  }
}

module.exports = Web3Service;
