import crypto from 'crypto';
import fp from 'fastify-plugin';
import db from '../../config/db.js';
import { verifySignature, buildVerificationMessage } from '../crypto/verify.js';

export class WebSocketManager {
  constructor(fastify) {
    this.fastify = fastify;
    // Map of identityKeyHash -> Set of active WebSocket connections
    this.connections = new Map();
    // In-memory presence subscription tracker
    // Maps identityKeyHash -> Set of contact hashes they are watching
    this.subscriptions = new Map();
  }

  // Register a connection by identity key hash
  register(identityKeyHash, socket) {
    if (!this.connections.has(identityKeyHash)) {
      this.connections.set(identityKeyHash, new Set());
    }
    this.connections.get(identityKeyHash).add(socket);
    this.fastify.log.info(`Hash ${identityKeyHash.substring(0, 8)}... connected. Total active hashes: ${this.connections.size}`);

    // Broadcast online status to all subscribers watching this hash
    this.broadcastPresence(identityKeyHash, 'online');
  }

  // Unregister a connection
  unregister(identityKeyHash, socket) {
    const sockets = this.connections.get(identityKeyHash);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.connections.delete(identityKeyHash);
        // Only broadcast offline when ALL sockets for this hash are gone
        this.broadcastPresence(identityKeyHash, 'offline');
        // Clean up subscriptions for this hash
        this.subscriptions.delete(identityKeyHash);
      }
    }
    this.fastify.log.info(`Hash ${identityKeyHash.substring(0, 8)}... disconnected. Total active hashes: ${this.connections.size}`);
  }

  // Check if a hash has any active connections
  isOnline(identityKeyHash) {
    const sockets = this.connections.get(identityKeyHash);
    return sockets && sockets.size > 0;
  }

  // Force-close ALL sockets for a hash (used when account is deleted)
  unregisterAll(identityKeyHash) {
    const sockets = this.connections.get(identityKeyHash);
    if (sockets) {
      for (const socket of sockets) {
        try { socket.close(4005, 'Account deleted'); } catch (e) { /* already closed */ }
      }
      this.connections.delete(identityKeyHash);
      this.subscriptions.delete(identityKeyHash);
      this.fastify.log.info(`Force-closed all sockets for deleted hash ${identityKeyHash.substring(0, 8)}...`);
    }
  }

  // Send a real-time message to all sockets of a user by hash
  sendToHash(identityKeyHash, data) {
    const sockets = this.connections.get(identityKeyHash);
    if (sockets && sockets.size > 0) {
      const payload = JSON.stringify(data);
      for (const socket of sockets) {
        if (socket.readyState === 1) { // OPEN state
          socket.send(payload);
        }
      }
      return true;
    }
    return false;
  }

  // Broadcast presence changes to all subscribers watching a given hash
  broadcastPresence(targetHash, status) {
    for (const [subscriberHash, watchedHashes] of this.subscriptions.entries()) {
      if (watchedHashes.has(targetHash)) {
        this.sendToHash(subscriberHash, {
          type: 'presence',
          hash: targetHash,
          status: status
        });
      }
    }
  }

  // Register presence subscriptions for a user
  subscribePresence(identityKeyHash, contactHashes) {
    this.subscriptions.set(identityKeyHash, new Set(contactHashes));

    // Send initial statuses for all requested contacts
    const statuses = {};
    for (const contactHash of contactHashes) {
      statuses[contactHash] = this.isOnline(contactHash) ? 'online' : 'offline';
    }

    this.sendToHash(identityKeyHash, {
      type: 'presence_sync',
      statuses: statuses
    });
  }

  // Forward a typed event to the recipient
  forwardTyping(senderHash, recipientHash, isTyping) {
    this.sendToHash(recipientHash, {
      type: 'typing',
      sender_hash: senderHash,
      is_typing: isTyping
    });
  }

  // Forward chat state to the recipient. Returns true if delivered.
  forwardChatState(senderHash, recipientHash, state) {
    return this.sendToHash(recipientHash, {
      type: 'chat_state',
      sender_hash: senderHash,
      state: state // 'active' or 'inactive'
    });
  }

  // Forward read receipt to the sender. Returns true if delivered.
  forwardReadReceipt(senderHash, recipientHash) {
    return this.sendToHash(recipientHash, {
      type: 'read_receipt',
      sender_hash: senderHash
    });
  }

  // Forward clear-chat event to the recipient. Returns true if delivered.
  forwardClearChat(senderHash, recipientHash) {
    return this.sendToHash(recipientHash, {
      type: 'clear_chat',
      sender_hash: senderHash
    });
  }
}

/**
 * Registers the websocket handler route.
 *
 * Wrapped in fastify-plugin so the `websocketServerManager` decoration is
 * applied to the root Fastify instance rather than this plugin's encapsulated
 * context — sibling route plugins (e.g. src/routes/chat.js) can then access
 * `fastify.websocketServerManager` to attempt live WS delivery.
 */
async function websocketRoutes(fastify, options) {
  const manager = new WebSocketManager(fastify);
  // Attach manager to fastify context so HTTP routes can access it
  fastify.decorate('websocketServerManager', manager);

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    // 1. Authenticate connection via query params
    const { identityKey, signature, timestamp } = request.query;

    if (!identityKey || !signature || !timestamp) {
      socket.close(4001, 'Missing authentication query parameters');
      return;
    }

    // Check timestamp drift (60s limit)
    const reqTime = new Date(timestamp).getTime();
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > 60 * 1000) {
      socket.close(4002, 'Expired or invalid timestamp');
      return;
    }

    // Verify signature of the connection handshake string
    const verificationMessage = buildVerificationMessage('CONNECT', '/ws', timestamp, '');
    const isValid = await verifySignature(signature, verificationMessage, identityKey);
    if (!isValid) {
      socket.close(4003, 'Invalid signature');
      return;
    }

    // Fetch user from DB
    const identityKeyHash = crypto.createHash('sha256').update(identityKey).digest('hex');
    const userResult = await db.query('SELECT id FROM users WHERE identity_key_hash = $1', [identityKeyHash]);

    if (userResult.rows.length === 0) {
      socket.close(4004, 'Identity key not registered');
      return;
    }

    const user = userResult.rows[0];
    const userId = user.id;

    // Register socket connection by hash
    manager.register(identityKeyHash, socket);

    // Send connection success acknowledgement
    socket.send(JSON.stringify({ type: 'authenticated', success: true }));

    // ─── Server-side heartbeat ─────────────────────
    // Ping every 15 s. If the client doesn't respond with a pong within
    // 10 s we assume the connection is dead and terminate it so the server
    // immediately broadcasts 'offline' to subscribers.
    let isAlive = true;
    socket.on('pong', () => { isAlive = true; });
    const heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        // No pong since last ping → dead connection
        fastify.log.info(`Heartbeat timeout for hash ${identityKeyHash.substring(0, 8)}... — terminating stale socket`);
        clearInterval(heartbeatInterval);
        return socket.terminate();
      }
      isAlive = false;
      try { socket.ping(); } catch (e) { /* socket already closing */ }
    }, 15_000);


    // Listen for incoming websocket messages
    socket.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString());

        if (payload.type === 'message') {
          const { recipient_hash, ciphertext, nonce, message_id } = payload;
          if (!recipient_hash || !ciphertext || !nonce) {
            socket.send(JSON.stringify({ type: 'error', error: 'Missing parameters in message payload' }));
            return;
          }

          // Resolve recipient
          const recipientResult = await db.query('SELECT id FROM users WHERE identity_key_hash = $1', [recipient_hash]);
          if (recipientResult.rows.length === 0) {
            socket.send(JSON.stringify({ type: 'error', error: 'Recipient user not found' }));
            return;
          }

          const recipientId = recipientResult.rows[0].id;
          const msgCreatedAt = new Date().toISOString();

          // Attempt real-time delivery via hash
          const isOnline = manager.sendToHash(recipient_hash, {
            type: 'message',
            message: {
              sender_hash: identityKeyHash,
              ciphertext,
              nonce,
              created_at: msgCreatedAt,
              message_id: message_id || null
            }
          });

          if (!isOnline) {
            // Queue in database for offline retrieval
            const insertResult = await db.query(
              'INSERT INTO messages (sender_id, recipient_id, ciphertext, nonce) VALUES ($1, $2, $3, $4) RETURNING id',
              [userId, recipientId, ciphertext, nonce]
            );
            const dbMessageId = insertResult.rows[0].id;
            socket.send(JSON.stringify({
              type: 'delivered',
              status: 'queued',
              recipient: recipient_hash,
              message_id: message_id || null,
              db_message_id: dbMessageId
            }));
          } else {
            socket.send(JSON.stringify({
              type: 'delivered',
              status: 'realtime',
              recipient: recipient_hash,
              message_id: message_id || null
            }));
          }

        } else if (payload.type === 'subscribe_presence') {
          // Register presence subscriptions
          const { contacts } = payload;
          if (Array.isArray(contacts)) {
            manager.subscribePresence(identityKeyHash, contacts);
          }

        } else if (payload.type === 'typing') {
          // Forward typing indicator to recipient
          const { recipient_hash, is_typing } = payload;
          if (recipient_hash != null) {
            manager.forwardTyping(identityKeyHash, recipient_hash, !!is_typing);
          }

        } else if (payload.type === 'chat_state') {
          // Forward active/inactive chat state
          const { recipient_hash, state } = payload;
          if (recipient_hash && (state === 'active' || state === 'inactive')) {
            const delivered = manager.forwardChatState(identityKeyHash, recipient_hash, state);
            if (!delivered) {
              // Chat state is ephemeral — no persistence needed. When the
              // recipient reconnects, the sender will send a fresh state
              // if they're still viewing the chat.
              fastify.log.debug(`chat_state ${state} for ${recipient_hash.substring(0, 8)}... not delivered (offline)`);
            }
          }

        } else if (payload.type === 'read_receipt') {
          // Forward read receipt to the original sender. If the sender is
          // offline, persist to the read_receipts table so they get the
          // double-tick (✓✓) when they reconnect.
          const { recipient_hash } = payload;
          if (recipient_hash) {
            const delivered = manager.forwardReadReceipt(identityKeyHash, recipient_hash);
            if (!delivered) {
              try {
                const senderResult = await db.query('SELECT id FROM users WHERE identity_key_hash = $1', [recipient_hash]);
                if (senderResult.rows.length > 0) {
                  await db.query(
                    'INSERT INTO read_receipts (sender_id, recipient_id) VALUES ($1, $2)',
                    [userId, senderResult.rows[0].id]
                  );
                }
              } catch (persistErr) {
                fastify.log.error('Failed to persist read_receipt:', persistErr);
              }
            }
          }

        } else if (payload.type === 'chat_config') {
          // Forward chat config (disappearing messages settings)
          const { recipient_hash, burn_timer } = payload;
          if (recipient_hash) {
            const delivered = manager.sendToHash(recipient_hash, {
              type: 'chat_config',
              sender_hash: identityKeyHash,
              burn_timer
            });

            // Persist to chat_events if recipient is offline so the event
            // survives until they reconnect. Without this, timer changes
            // were silently lost whenever the recipient's WS was down.
            if (!delivered) {
              try {
                const recipientResult = await db.query('SELECT id FROM users WHERE identity_key_hash = $1', [recipient_hash]);
                if (recipientResult.rows.length > 0) {
                  await db.query(
                    `INSERT INTO chat_events (sender_id, recipient_id, event_type, burn_timer)
                     VALUES ($1, $2, 'chat_config', $3)`,
                    [userId, recipientResult.rows[0].id, burn_timer === undefined ? null : burn_timer]
                  );
                }
              } catch (persistErr) {
                fastify.log.error('Failed to persist chat_config event:', persistErr);
              }
            }
          }

        } else if (payload.type === 'clear_chat') {
          // Forward clear-chat event to recipient
          const { recipient_hash } = payload;
          if (recipient_hash) {
            const delivered = manager.forwardClearChat(identityKeyHash, recipient_hash);

            // Persist to chat_events if recipient is offline so the clear
            // request survives until they reconnect.
            if (!delivered) {
              try {
                const recipientResult = await db.query('SELECT id FROM users WHERE identity_key_hash = $1', [recipient_hash]);
                if (recipientResult.rows.length > 0) {
                  await db.query(
                    `INSERT INTO chat_events (sender_id, recipient_id, event_type, burn_timer)
                     VALUES ($1, $2, 'clear_chat', NULL)`,
                    [userId, recipientResult.rows[0].id]
                  );
                }
              } catch (persistErr) {
                fastify.log.error('Failed to persist clear_chat event:', persistErr);
              }
            }
          }

        } else if (payload.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }

      } catch (err) {
        fastify.log.error('WebSocket message parsing/processing error', err);
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid frame payload or processing error' }));
      }
    });

    // Handle connection close
    socket.on('close', () => {
      clearInterval(heartbeatInterval);
      manager.unregister(identityKeyHash, socket);
    });

    socket.on('error', (err) => {
      clearInterval(heartbeatInterval);
      fastify.log.error(`WebSocket connection error for hash ${identityKeyHash.substring(0, 8)}...:`, err);
      manager.unregister(identityKeyHash, socket);
    });
  });
}

export default fp(websocketRoutes);
