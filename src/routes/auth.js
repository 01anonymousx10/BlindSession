import crypto from 'crypto';
import db from '../../config/db.js';
import { verifySignature } from '../crypto/verify.js';
import { authenticateRequest } from '../crypto/authMiddleware.js';

export default async function authRoutes(fastify, options) {
  
  // Registration endpoint
  fastify.post('/register', async (request, reply) => {
    const { public_identity_key, public_prekey, prekey_signature, recovery_blob } = request.body;

    if (!public_identity_key || !public_prekey || !prekey_signature) {
      return reply.code(400).send({ error: 'Missing required registration parameters' });
    }

    try {
      // 1. Verify prekey self-signature
      // This validates that the prekey belongs to the owner of the identity key
      const isSignatureValid = await verifySignature(
        prekey_signature,
        public_prekey,
        public_identity_key
      );

      if (!isSignatureValid) {
        return reply.code(400).send({ error: 'Invalid prekey signature verification' });
      }

      // 2. Generate identity key hash (fingerprint)
      const identity_key_hash = crypto
        .createHash('sha256')
        .update(public_identity_key)
        .digest('hex');

      // 3. Save to database
      const insertQuery = `
        INSERT INTO users (identity_key_hash, public_identity_key, public_prekey, prekey_signature, recovery_blob)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (identity_key_hash) 
        DO UPDATE SET 
          public_prekey = EXCLUDED.public_prekey, 
          prekey_signature = EXCLUDED.prekey_signature,
          recovery_blob = COALESCE(EXCLUDED.recovery_blob, users.recovery_blob)
        RETURNING id, identity_key_hash;
      `;

      const result = await db.query(insertQuery, [
        identity_key_hash,
        public_identity_key,
        public_prekey,
        prekey_signature,
        recovery_blob || null
      ]);

      const user = result.rows[0];

      return reply.code(201).send({
        success: true,
        user_id: user.id,
        identity_key_hash: user.identity_key_hash
      });

    } catch (err) {
      fastify.log.error('Registration failed:', err);
      return reply.code(500).send({ error: 'Internal server error during registration' });
    }
  });

  // Retrieve encrypted recovery blob by identity key fingerprint (for zero-knowledge passphrase recovery on new devices)
  fastify.get('/recovery/:identity_key_hash', async (request, reply) => {
    const { identity_key_hash } = request.params;
    if (!identity_key_hash) {
      return reply.code(400).send({ error: 'Identity key hash is required' });
    }
    try {
      const res = await db.query(
        'SELECT recovery_blob FROM users WHERE identity_key_hash = $1',
        [identity_key_hash]
      );
      if (res.rows.length === 0 || !res.rows[0].recovery_blob) {
        return reply.code(404).send({ error: 'No recovery blob found for this identity' });
      }
      return reply.send({
        identity_key_hash,
        recovery_blob: res.rows[0].recovery_blob
      });
    } catch (err) {
      fastify.log.error('Recovery lookup failed:', err);
      return reply.code(500).send({ error: 'Internal server error during recovery lookup' });
    }
  });

  // Account deletion endpoint (used by Panic Shredder)
  // Requires signed authentication headers (same as chat routes)
  fastify.delete('/account', { preHandler: authenticateRequest }, async (request, reply) => {
    const userId = request.user.id;

    try {
      // Delete the user row. ON DELETE CASCADE on messages.sender_id
      // and messages.recipient_id automatically purges queued ciphertext.
      // one_time_prekeys also cascade-deleted.
      const deleteResult = await db.query('DELETE FROM users WHERE id = $1 RETURNING identity_key_hash', [userId]);

      if (deleteResult.rowCount === 0) {
        return reply.code(404).send({ error: 'Account not found' });
      }

      // Notify all active WebSocket connections for this user to clean up
      const deletedHash = deleteResult.rows[0].identity_key_hash;
      if (fastify.websocketServerManager) {
        fastify.websocketServerManager.unregisterAll(deletedHash);
      }

      fastify.log.info({ userId, identity_key_hash: deletedHash }, 'Account deleted via Panic Shredder');

      return reply.send({
        success: true,
        deleted_identity_key_hash: deletedHash
      });

    } catch (err) {
      fastify.log.error('Account deletion failed:', err);
      return reply.code(500).send({ error: 'Internal server error during account deletion' });
    }
  });
}
