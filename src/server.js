const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const { setupDatabase } = require('./config/database');
const { initializeWeb3Service } = require('./services/Web3Service');
const { getJitsiService } = require('./services/JitsiService');
const { initializeLitService } = require('./services/LitService');
const authRoutes = require('./routes/auth');
const auctionRoutes = require('./routes/auctions');
const meetingRoutes = require('./routes/meetings');
const { authenticateSocket } = require('./middleware/auth');
const logger = require('./utils/logger');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      database: process.env.DATABASE_URL ? 'configured' : 'demo mode',
      blockchain: process.env.ETH_WSS_ENDPOINT ? 'configured' : 'demo mode',
      para: process.env.PARA_API_KEY ? 'configured' : 'demo mode',
      jitsi: process.env.JITSI_SECRET ? 'configured' : 'demo mode'
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/meetings', require('./routes/meetings'));

// Socket.IO for real-time updates
io.use(authenticateSocket);
io.on('connection', (socket) => {
  logger.info('Client connected:', socket.id);
  
  socket.on('join-auction', (auctionId) => {
    socket.join(`auction-${auctionId}`);
    logger.info(`Socket ${socket.id} joined auction ${auctionId}`);
  });
  
  socket.on('leave-auction', (auctionId) => {
    socket.leave(`auction-${auctionId}`);
  });
  
  socket.on('disconnect', () => {
    logger.info('Client disconnected:', socket.id);
  });
});

async function startServer() {
  try {
    // Initialize services
    await setupDatabase();
    // Web3Service initialization - commented out for meeting testing
    // await initializeWeb3Service(io);
    // Lit Protocol initialization - optional for basic meetings
    // await initializeLitService();
    
    // Start auction cron service
    const { getAuctionCronService } = require('./services/AuctionCronService');
    const auctionCron = getAuctionCronService();
    auctionCron.start();
    logger.info('Auction cron service started');
    
    // Initialize Jitsi service
    getJitsiService();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info('Para integration backend initialized successfully');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = { app, io };
