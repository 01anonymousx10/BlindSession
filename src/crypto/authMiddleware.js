import crypto from 'crypto';
import db from '../../config/db.js';
import { verifySignature, buildVerificationMessage } from './verify.js';

/**
 * Fastify preHandler hook to verify client signatures.
 * Requires headers:
 * - X-Identity-Key (Base64 Ed25519 Public Key)
 * - X-Signature (Base64 signature of "METHOD|PATH|TIMESTAMP|BODY")
 * - X-Timestamp (ISO 8601 Timestamp)
 */
export async function authenticateRequest(request, reply) {
  const identityKey = request.headers['x-identity-key'];
  const signature = request.headers['x-signature'];
  const timestamp = request.headers['x-timestamp'];

  if (!identityKey || !signature || !timestamp) {
    return reply.code(401).send({ error: 'Authentication headers missing (X-Identity-Key, X-Signature, X-Timestamp)' });
  }

  // 1. Verify timestamp to prevent replay attacks (60s drift tolerance)
  const reqTime = new Date(timestamp).getTime();
  const now = Date.now();
  const timeDriftLimit = 60 * 1000; // 60 seconds

  if (isNaN(reqTime) || Math.abs(now - reqTime) > timeDriftLimit) {
    return reply.code(401).send({ error: 'Request timestamp is invalid or has expired' });
  }

  // 2. Build signed message representation
  const method = request.method;
  const path = request.routerPath || request.url; // Use route pattern or actual url
  const bodyString = request.body ? JSON.stringify(request.body) : '';
  const messageText = buildVerificationMessage(method, path, timestamp, bodyString);

  // 3. Perform cryptographic verification
  const isValid = await verifySignature(signature, messageText, identityKey);
  if (!isValid) {
    return reply.code(401).send({ error: 'Invalid request signature' });
  }

  // 4. Retrieve user record from database
  const identityKeyHash = crypto
    .createHash('sha256')
    .update(identityKey)
    .digest('hex');

  const result = await db.query(
    'SELECT id, identity_key_hash FROM users WHERE identity_key_hash = $1',
    [identityKeyHash]
  );

  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Unregistered identity key' });
  }

  // 5. Attach authenticated user to request object
  request.user = result.rows[0];
}
