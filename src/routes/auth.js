const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const paraService = require('../services/ParaService');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();




// Para verification token authentication (Step 1: Basic Auth)
router.post('/para-auth', async (req, res) => {
  try {
    const { verificationToken } = req.body;
    
    if (!verificationToken) {
      return res.status(400).json({ 
        error: 'Verification token is required',
        required: 'Frontend: const token = await para.getVerificationToken(); then send { verificationToken: token }'
      });
    }
    
    // Verify with Para API
    const verification = await paraService.verifySession(verificationToken);
    
    if (!verification.success) {
      return res.status(401).json({ 
        error: 'Para verification failed', 
        details: verification.error,
        hint: 'Ensure frontend provides valid verification token from authenticated Para session'
      });
    }
    
    const { authType, identifier, oAuthMethod } = verification.userData;
    
    // Store user in database
    const userStore = await paraService.storeVerificationUser(verification.userData);
    
    if (!userStore.success) {
      return res.status(500).json({ 
        error: 'Failed to store user data',
        details: userStore.error
      });
    }
    
    const user = userStore.user;
    
    // Generate JWT token
    const token = jwt.sign({
      userId: user.id,
      paraUserId: user.para_user_id,
      authType: user.auth_type,
      identifier,
      email: user.email,
      displayName: user.display_name,
      role: 'para_user',
      hasWallet: false // Verification token doesn't provide wallet info
    }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    logger.info(`Para verification auth successful for user: ${user.para_user_id}`);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        paraUserId: user.para_user_id,
        email: user.email,
        authType: user.auth_type,
        oAuthMethod: user.oauth_method,
        displayName: user.display_name,
        role: 'para_user',
        hasWallet: false
      },
      note: 'Basic authentication complete. Use /import-session for wallet operations.'
    });
    
  } catch (error) {
    logger.error('Para auth error:', error);
    res.status(500).json({ 
      error: 'Authentication failed', 
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Para session import (Step 2: Full Session with Wallet Access)
router.post('/import-session', async (req, res) => {
  try {
    const { session } = req.body; // Note: 'session' not 'serializedSession' per Para docs
    
    if (!session) {
      return res.status(400).json({ 
        error: 'Session is required',
        required: 'Frontend: const session = await para.exportSession(); then send { session }'
      });
    }
    
    const sessionResult = await paraService.importSession(session);
    
    if (!sessionResult.success) {
      return res.status(401).json({ 
        error: 'Session import failed',
        details: sessionResult.error,
        hint: 'Ensure frontend provides valid session from para.exportSession()'
      });
    }
    
    // Store full user data with wallet info
    const userStore = await paraService.storeUserFromJWT(sessionResult.userData);
    
    if (!userStore.success) {
      return res.status(500).json({ 
        error: 'Failed to store user data',
        details: userStore.error
      });
    }
    
    const user = userStore.user;
    const primaryWallet = userStore.primaryWallet;
    
    // Generate JWT with full wallet access
    const token = jwt.sign({
      userId: user.id,
      paraUserId: user.para_user_id,
      authType: user.auth_type,
      email: user.email,
      displayName: user.display_name,
      walletAddress: primaryWallet.address.toLowerCase(),
      hasWallet: true,
      sessionActive: true,
      role: 'para_user'
    }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    logger.info(`Para session imported successfully for user: ${user.para_user_id}`);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        paraUserId: user.para_user_id,
        email: user.email,
        authType: user.auth_type,
        displayName: user.display_name,
        walletAddress: primaryWallet.address,
        hasWallet: true,
        role: 'para_user'
      },
      wallet: {
        address: primaryWallet.address,
        type: primaryWallet.type
      },
      note: 'Full session imported. User can perform wallet operations.'
    });
    
  } catch (error) {
    logger.error('Para session import error:', error);
    res.status(500).json({ 
      error: 'Session import failed',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Verify token
router.get('/verify', authenticateToken, (req, res) => {
  res.json({ 
    success: true, 
    user: req.user,
    timestamp: new Date().toISOString()
  });
});



module.exports = router;
