const cron = require('node-cron');
const { setupDatabase } = require('../config/database');
const { initializeWeb3Service } = require('../services/Web3Service');
const logger = require('../utils/logger');

class AuctionCron {
  constructor() {
    this.web3Service = null;
    this.isRunning = false;
  }
  
  async initialize() {
    try {
      await setupDatabase();
      this.web3Service = await initializeWeb3Service(null); // No socket.io for cron
      logger.info('Auction cron job initialized');
    } catch (error) {
      logger.error('Failed to initialize auction cron:', error);
      throw error;
    }
  }
  
  async start() {
    const cronExpression = process.env.AUCTION_CHECK_INTERVAL || '*/1 * * * *'; // Every minute
    
    cron.schedule(cronExpression, async () => {
      if (this.isRunning) {
        logger.warn('Previous auction check still running, skipping this cycle');
        return;
      }
      
      this.isRunning = true;
      try {
        await this.web3Service.endExpiredAuctions();
      } catch (error) {
        logger.error('Error in scheduled auction check:', error);
      } finally {
        this.isRunning = false;
      }
    });
    
    logger.info(`Auction cron job started with schedule: ${cronExpression}`);
  }
}

// Run if called directly
if (require.main === module) {
  const auctionCron = new AuctionCron();
  
  auctionCron.initialize()
    .then(() => auctionCron.start())
    .catch(error => {
      logger.error('Failed to start auction cron:', error);
      process.exit(1);
    });
}

module.exports = { AuctionCron };
