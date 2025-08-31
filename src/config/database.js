const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/meeting_auction',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
  try {
    // Check if database URL is configured
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('demo_mode') || process.env.DATABASE_URL.includes('YOUR_')) {
      logger.warn('Database not configured, running in demo mode');
      return;
    }
    
    // Test connection
    const client = await pool.connect();
    client.release();
    logger.info('PostgreSQL connected');
    
    // Create tables
    await createTables();
    logger.info('Database setup completed successfully');
    
  } catch (error) {
    logger.error('Database setup failed:', error);
    logger.warn('Running in demo mode without database');
  }
}

async function createTables() {
  try {
    // Read the schema.sql file
    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the entire schema as one transaction
    await pool.query(schemaSQL);
    
    logger.info('Database tables created/verified from schema.sql');
  } catch (error) {
    logger.error('Failed to create tables from schema.sql:', error);
    throw error;
  }
}

// Migration function for existing databases
async function migrate() {
  try {
    logger.info('Starting database migration...');
    
    // Check if old tables exist and migrate data if needed
    const oldTablesExist = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users' 
        AND table_schema = 'public'
      );
    `);
    
    if (oldTablesExist.rows[0].exists) {
      logger.info('Old tables detected, migration not needed');
      return;
    }
    
    logger.info('Migration completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  }
}

module.exports = { pool, setupDatabase, migrate };