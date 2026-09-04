import { buildApp } from './app.js';
import db from '../config/db.js';
import dotenv from 'dotenv';

dotenv.config();

const port = process.env.PORT || 3000;
const host = '0.0.0.0'; // Bind to all interfaces for accessibility

// Logger config: use pino-pretty for readable console output.
// In production, pino-pretty is now a production dependency so it's
// available inside Docker. If it somehow isn't installed, fall back
// to raw JSON logging instead of crashing.
const loggerConfig = {
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info'
};
try {
  // Test if pino-pretty is resolvable before using it as a transport
  await import('pino-pretty');
  loggerConfig.transport = {
    target: 'pino-pretty',
    options: { colorize: true }
  };
} catch (_e) {
  // pino-pretty not installed — use default JSON logger
  console.log('pino-pretty not found, using default JSON logger');
}

const app = buildApp({ logger: loggerConfig });

const start = async () => {
  try {
    // 1. Test database connection on startup
    console.log('Testing connection to PostgreSQL database...');
    try {
      const dbTest = await db.query('SELECT NOW()');
      console.log(`✅ PostgreSQL connected successfully: ${dbTest.rows[0].now}`);

      // Auto-migrate: ensure chat_events table exists for existing databases
      // that were created before this table was added to schema.sql.
      await db.query(`
        CREATE TABLE IF NOT EXISTS chat_events (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
            recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
            event_type VARCHAR(20) NOT NULL,
            burn_timer INTEGER,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_chat_events_pending ON chat_events(recipient_id)');

      // Auto-migrate: ensure read_receipts table exists for persisting read
      // receipts when the sender is offline.
      await db.query(`
        CREATE TABLE IF NOT EXISTS read_receipts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
            recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_read_receipts_pending ON read_receipts(recipient_id)');
      console.log('✅ Database schema verified (chat_events + read_receipts tables ready).');
    } catch (dbErr) {
      console.warn('⚠️ Warning: Failed to connect to PostgreSQL database. Running in offline/degraded mode:', dbErr.message);
    }

    // 2. Start server
    await app.listen({ port, host });
    console.log(`🚀 E2EE Chat Server listening on http://localhost:${port}`);
  } catch (err) {
    app.log.error('Fatal startup error:', err);
    process.exit(1);
  }
};

// Handle process termination gracefully
const gracefulShutdown = async () => {
  console.log('\nReceived kill signal, shutting down gracefully...');
  try {
    await app.close();
    console.log('Closed HTTP server.');
    
    const pool = db.getPool();
    await pool.end();
    console.log('PostgreSQL pool connection closed.');
    
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start();
