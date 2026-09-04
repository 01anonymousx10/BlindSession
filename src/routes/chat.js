import db from '../../config/db.js';
import { authenticateRequest } from '../crypto/authMiddleware.js';

export default async function chatRoutes(fastify, options) {
  
  // Register authentication hook for all chat routes
  fastify.addHook('preHandler', authenticateRequest);

  // Send an E2EE message (HTTP fallback / offline queuing)
  fastify.post('/send', async (request, reply) => {
    const { recipient_hash, ciphertext, nonce, message_id } = request.body;

    if (!recipient_hash || !ciphertext || !nonce) {
      return reply.code(400).send({ error: 'Missing parameter: recipient_hash, ciphertext, or nonce' });
    }

    try {
      // 1. Resolve recipient ID
      const recipientResult = await db.query(
        'SELECT id FROM users WHERE identity_key_hash = $1',
        [recipient_hash]
      );

      if (recipientResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Recipient not found' });
      }

      const recipientId = recipientResult.rows[0].id;
      const senderId = request.user.id;

      // 2. Attempt live delivery over WebSocket first (mirrors the WS message
      // path in connection.js). Only if the recipient is unreachable in real
      // time do we persist to the offline queue — never both.
      if (fastify.websocketServerManager) {
        const delivered = fastify.websocketServerManager.sendToHash(recipient_hash, {
          type: 'message',
          message: {
            sender_hash: request.user.identity_key_hash,
            ciphertext,
            nonce,
            created_at: new Date().toISOString(),
            message_id: message_id || null
          }
        });

        if (delivered) {
          return reply.send({ success: true, status: 'realtime', message_id: message_id || null });
        }
      }

      // 3. Recipient is offline (or WS manager unavailable): queue in DB.
      const insertQuery = `
        INSERT INTO messages (sender_id, recipient_id, ciphertext, nonce)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at;
      `;

      const result = await db.query(insertQuery, [senderId, recipientId, ciphertext, nonce]);
      const message = result.rows[0];

      return reply.send({
        success: true,
        message_id: message_id || null,
        created_at: message.created_at,
        status: 'queued'
      });

    } catch (err) {
      fastify.log.error('Failed to queue message:', err);
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });

  // Retrieve undelivered messages from the offline queue (Server-blind ephemeral store)
  fastify.get('/messages', async (request, reply) => {
    const userId = request.user.id;

    try {
      // 1. Query all undelivered messages for this recipient
      const selectQuery = `
        SELECT m.id, u.identity_key_hash as sender_hash, m.ciphertext, m.nonce, m.created_at
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.recipient_id = $1 AND m.delivered_at IS NULL
        ORDER BY m.created_at ASC;
      `;

      const result = await db.query(selectQuery, [userId]);
      const messages = result.rows;

      if (messages.length > 0) {
        const messageIds = messages.map(m => m.id);

        // 2. E2EE Privacy Policy: Delete the messages or mark as delivered immediately to minimize metadata.
        // We will update delivered_at and clean them up (or delete them entirely to stay metadata-blind).
        // Let's delete them from the queue so they no longer live on the server database.
        const deleteQuery = `
          DELETE FROM messages
          WHERE id = ANY($1::uuid[]);
        `;
        await db.query(deleteQuery, [messageIds]);

        // 3. Notify each sender that their queued message was just delivered.
        // This upgrades the sender's gray ✓ to a blue ✓ (delivered) even
        // though the message was originally queued while they were offline.
        if (fastify.websocketServerManager) {
          for (const msg of messages) {
            if (msg.sender_hash) {
              fastify.websocketServerManager.sendToHash(msg.sender_hash, {
                type: 'delivered',
                recipient: request.user.identity_key_hash,
                status: 'delivered',
                message_id: null
              });
            }
          }
        }
      }

      return reply.send({ success: true, messages });

    } catch (err) {
      fastify.log.error('Failed to retrieve messages:', err);
      return reply.code(500).send({ error: 'Failed to query message queue' });
    }
  });

  // ─── Read Receipts (persisted for offline senders) ──────────────

  // Retrieve pending read receipts and delete them
  fastify.get('/read-receipts', async (request, reply) => {
    const userId = request.user.id;

    try {
      const selectQuery = `
        SELECT rr.id, u.identity_key_hash AS sender_hash, rr.created_at
        FROM read_receipts rr
        LEFT JOIN users u ON rr.sender_id = u.id
        WHERE rr.recipient_id = $1
        ORDER BY rr.created_at ASC;
      `;

      const result = await db.query(selectQuery, [userId]);
      const receipts = result.rows;

      if (receipts.length > 0) {
        const receiptIds = receipts.map(r => r.id);
        await db.query('DELETE FROM read_receipts WHERE id = ANY($1::uuid[])', [receiptIds]);
      }

      return reply.send({ success: true, receipts });

    } catch (err) {
      fastify.log.error('Failed to retrieve read receipts:', err);
      return reply.code(500).send({ error: 'Failed to query read receipts' });
    }
  });

  // ─── Chat Events (disappearing-timer config & clear-chat) ──────────
  // These endpoints persist control events so they survive until the
  // recipient comes online — mirroring the offline message queue. Without
  // them, chat_config and clear_chat events sent over WebSocket were
  // silently dropped when the recipient was offline.

  // Store a chat event and attempt live WS delivery
  fastify.post('/event', async (request, reply) => {
    const { recipient_hash, event_type, burn_timer } = request.body;

    if (!recipient_hash || !event_type) {
      return reply.code(400).send({ error: 'Missing recipient_hash or event_type' });
    }
    if (event_type !== 'chat_config' && event_type !== 'clear_chat') {
      return reply.code(400).send({ error: 'Invalid event_type (must be chat_config or clear_chat)' });
    }

    try {
      // 1. Resolve recipient ID
      const recipientResult = await db.query(
        'SELECT id FROM users WHERE identity_key_hash = $1',
        [recipient_hash]
      );

      if (recipientResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Recipient not found' });
      }

      const recipientId = recipientResult.rows[0].id;
      const senderId = request.user.id;
      const senderHash = request.user.identity_key_hash;

      // 2. Attempt live delivery over WebSocket first
      if (fastify.websocketServerManager) {
        const payload = {
          type: event_type,
          sender_hash: senderHash
        };
        if (event_type === 'chat_config') {
          payload.burn_timer = burn_timer === undefined ? null : burn_timer;
        }

        const delivered = fastify.websocketServerManager.sendToHash(recipient_hash, payload);
        if (delivered) {
          return reply.send({ success: true, status: 'realtime' });
        }
      }

      // 3. Recipient offline (or WS unavailable): persist to chat_events
      await db.query(
        `INSERT INTO chat_events (sender_id, recipient_id, event_type, burn_timer)
         VALUES ($1, $2, $3, $4)`,
        [senderId, recipientId, event_type, burn_timer === undefined ? null : burn_timer]
      );

      return reply.send({ success: true, status: 'queued' });

    } catch (err) {
      fastify.log.error('Failed to store chat event:', err);
      return reply.code(500).send({ error: 'Failed to store chat event' });
    }
  });

  // Retrieve pending chat events (config changes & clear-chat) and delete them
  fastify.get('/events', async (request, reply) => {
    const userId = request.user.id;

    try {
      const selectQuery = `
        SELECT ce.id, u.identity_key_hash AS sender_hash, ce.event_type, ce.burn_timer, ce.created_at
        FROM chat_events ce
        LEFT JOIN users u ON ce.sender_id = u.id
        WHERE ce.recipient_id = $1
        ORDER BY ce.created_at ASC;
      `;

      const result = await db.query(selectQuery, [userId]);
      const events = result.rows;

      if (events.length > 0) {
        const eventIds = events.map(e => e.id);
        // Delete fetched events so they aren't processed again
        await db.query('DELETE FROM chat_events WHERE id = ANY($1::uuid[])', [eventIds]);
      }

      return reply.send({ success: true, events });

    } catch (err) {
      fastify.log.error('Failed to retrieve chat events:', err);
      return reply.code(500).send({ error: 'Failed to query chat events' });
    }
  });
}
