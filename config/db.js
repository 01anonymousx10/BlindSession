import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

// SSL: controlled by DB_SSL env var.
// - Docker local: DB_SSL=false (PostgreSQL container has no SSL)
// - Railway/Render/managed DB: DB_SSL=true (managed databases require SSL)
// - Default: false (safe for local dev and Docker)
const useSsl = process.env.DB_SSL === 'true';

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

// Log pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

export default {
  query: (text, params) => pool.query(text, params),
  getPool: () => pool
};
