-- schema.sql
-- Production database schema for E2EE blind messaging platform

-- Enable uuid extension for ID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identity_key_hash VARCHAR(64) UNIQUE NOT NULL, -- Hex or Base64 fingerprint of Identity Key
    public_identity_key TEXT NOT NULL,           -- Ed25519 Public Key for request authentication
    public_prekey TEXT NOT NULL,                 -- X25519 Public Key for Diffie-Hellman key exchange
    prekey_signature TEXT NOT NULL,              -- Ed25519 Signature of public_prekey
    recovery_blob TEXT,                          -- Optional zero-knowledge encrypted recovery ciphertext (added via migration: ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_blob TEXT)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. One-Time Prekeys (For PFS / X3DH handshake)
CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Messages Queue Table (Ephemeral)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,                    -- Encrypted payload (XChaCha20-Poly1305 payload)
    nonce VARCHAR(48) NOT NULL,                  -- Random cryptographic nonce
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP WITH TIME ZONE        -- Populate upon delivery. Cleaned up periodically.
);

-- 4. Chat Events Table (disappearing-timer config changes & clear-chat events)
-- Persists control events so they survive until the recipient comes online,
-- mirroring the offline message queue. Without this, chat_config and
-- clear_chat events sent over WebSocket were silently dropped when the
-- recipient was offline (or had their tab hidden, which disconnects WS).
CREATE TABLE IF NOT EXISTS chat_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(20) NOT NULL,    -- 'chat_config' | 'clear_chat'
    burn_timer INTEGER,                 -- NULL for clear_chat, seconds for chat_config
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Read Receipts Table
-- Persists read receipts so the sender gets the double-tick (✓✓) even if
-- they were offline when the recipient read the message. Without this, the
-- read_receipt WS frame was silently dropped when the sender was offline.
CREATE TABLE IF NOT EXISTS read_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,   -- who READ the message
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE, -- who SENT the message (gets the receipt)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance & quick message queries
CREATE INDEX IF NOT EXISTS idx_users_identity_key_hash ON users(identity_key_hash);
CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(recipient_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_events_pending ON chat_events(recipient_id);
CREATE INDEX IF NOT EXISTS idx_read_receipts_pending ON read_receipts(recipient_id);
