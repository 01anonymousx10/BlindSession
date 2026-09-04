// public/assets/js/socket.js
// Client WebSocket Connection Manager

class SecureSocket {
  constructor() {
    this.socket = null;
    this.serverUrl = 'ws://localhost:3000/ws';
    // Base origin only (no '/api' suffix) so route paths below can carry the
    // full '/api/...' prefix. A '/api' suffix here used to combine with a
    // '/api/chat/send' path into '/api/api/chat/send' → 404 'Not Found'.
    this.httpUrl = 'http://localhost:3000';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isAuthenticated = false;
    // True when WE closed the socket intentionally (lock / shred / logout).
    // The onclose handler checks this to skip the auto-reconnect logic, so a
    // user-initiated disconnect isn't immediately undone by the reconnect
    // loop. `connect()` resets it at the start of a fresh handshake.
    this.intentionalClose = false;
    // Core callbacks
    this.onMessageCallback = null;
    this.onStatusCallback = null;

    // New real-time event callbacks
    this.onPresenceChangeCallback = null;
    this.onTypingChangeCallback = null;
    this.onChatStateChangeCallback = null;
    this.onReadReceiptCallback = null;
    this.onPresenceSyncCallback = null;
    this.onChatConfigChangeCallback = null;
    this.onClearChatCallback = null;
    this.onDeliveredCallback = null;
  }

  // ─── Core Event Registration ──────────────────────
  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onStatusChange(callback) {
    this.onStatusCallback = callback;
  }

  // ─── New Event Registration ───────────────────────
  onPresenceChange(callback) {
    this.onPresenceChangeCallback = callback;
  }

  onPresenceSync(callback) {
    this.onPresenceSyncCallback = callback;
  }

  onTypingChange(callback) {
    this.onTypingChangeCallback = callback;
  }

  onChatStateChange(callback) {
    this.onChatStateChangeCallback = callback;
  }

  onReadReceipt(callback) {
    this.onReadReceiptCallback = callback;
  }

  onChatConfigChange(callback) {
    this.onChatConfigChangeCallback = callback;
  }

  onClearChat(callback) {
    this.onClearChatCallback = callback;
  }

  /**
   * Delivery-status callback.
   * Fires with (recipientHash, status) where status is:
   *   'realtime' — recipient was online, message pushed over WS
   *   'queued'   — recipient offline, message stored for later pull
   */
  onDelivered(callback) {
    this.onDeliveredCallback = callback;
  }

  // ─── Outgoing Dispatchers ─────────────────────────

  /**
   * Subscribe to presence updates for a list of contact hashes.
   * If the WebSocket is not yet connected, the subscription is queued
   * and sent once authentication completes.
   */
  subscribePresence(contacts) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'subscribe_presence',
        contacts: contacts
      }));
    } else {
      // Queue the subscription — will be flushed on authentication
      this._pendingPresenceSubscription = contacts;
    }
  }

  /**
   * Notify the recipient that we are typing or stopped typing.
   */
  sendTyping(recipientHash, isTyping) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'typing',
        recipient_hash: recipientHash,
        is_typing: isTyping
      }));
    }
  }

  /**
   * Notify the recipient that we opened (active) or closed (inactive) their chat.
   * If the WebSocket is not yet connected, the state is queued in memory and
   * flushed once authentication completes — so the event is never silently
   * dropped during the brief window between login and WS readiness.
   */
  sendChatState(recipientHash, state) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'chat_state',
        recipient_hash: recipientHash,
        state: state
      }));
    } else {
      // Queue the state — only keep the latest per recipient (no need to
      // replay a sequence of active→inactive→active, just the final value).
      if (!this._pendingChatStates) this._pendingChatStates = {};
      this._pendingChatStates[recipientHash] = state;
    }
  }

  /**
   * Flush any queued chat states after WS authentication completes.
   * Called from the 'authenticated' handler in onmessage.
   */
  _flushPendingChatStates() {
    if (!this._pendingChatStates) return;
    const pending = this._pendingChatStates;
    this._pendingChatStates = {};
    for (const [recipientHash, state] of Object.entries(pending)) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
        this.socket.send(JSON.stringify({
          type: 'chat_state',
          recipient_hash: recipientHash,
          state: state
        }));
      }
    }
  }

  /**
   * Notify the recipient that we have read their messages.
   */
  sendReadReceipt(recipientHash) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'read_receipt',
        recipient_hash: recipientHash
      }));
    }
  }

  sendChatConfig(recipientHash, burnTimer) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'chat_config',
        recipient_hash: recipientHash,
        burn_timer: burnTimer
      }));
    } else {
      // WS not available — persist via HTTP so the event survives until
      // the recipient comes online. Without this fallback the timer
      // change was silently lost whenever the recipient was offline.
      this.sendEventViaHttp(recipientHash, 'chat_config', { burn_timer: burnTimer });
    }
  }

  /**
   * Notify the recipient to clear their local chat history for this conversation.
   */
  sendClearChat(recipientHash) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'clear_chat',
        recipient_hash: recipientHash
      }));
    } else {
      // WS not available — persist via HTTP so the clear event survives
      // until the recipient comes online.
      this.sendEventViaHttp(recipientHash, 'clear_chat', {});
    }
  }

  /**
   * HTTP fallback for chat control events (chat_config / clear_chat).
   * Stores the event on the server so it can be delivered when the
   * recipient next connects. Also attempts live WS delivery from the
   * server side.
   */
  async sendEventViaHttp(recipientHash, eventType, extraFields) {
    // Need identity keys to sign the request. These are set on connect()
    // but may not be available if the socket was never connected. In that
    // case we cannot authenticate, so the event is lost — log a warning.
    if (!this._identityPublicKey || !this._identityPrivateKey) {
      console.warn(`Cannot send ${eventType} via HTTP: identity keys not available`);
      return { success: false, error: 'Identity keys not available' };
    }

    const timestamp = new Date().toISOString();
    const path = '/api/chat/event';
    const body = { recipient_hash: recipientHash, event_type: eventType, ...extraFields };
    const bodyString = JSON.stringify(body);

    const signature = window.SecureCrypto.signRequest(
      this._identityPrivateKey,
      'POST',
      path,
      timestamp,
      bodyString
    );

    try {
      const response = await fetch(`${this.httpUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Identity-Key': this._identityPublicKey,
          'X-Signature': signature,
          'X-Timestamp': timestamp
        },
        body: bodyString
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'HTTP event send failed');
      }

      return { success: true };
    } catch (err) {
      console.error(`HTTP ${eventType} event error:`, err);
      return { success: false, error: err.message };
    }
  }

  // ─── Connection ───────────────────────────────────

  async connect(identityPublicKey, identityPrivateKey) {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // A fresh connect is user-initiated; clear any prior intentional-close so
    // the onclose handler will auto-reconnect if this connection later drops.
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    // Cache identity keys so the HTTP fallback (sendEventViaHttp) can sign
    // requests even when the WebSocket is not connected.
    this._identityPublicKey = identityPublicKey;
    this._identityPrivateKey = identityPrivateKey;

    this.notifyStatus('connecting');

    try {
      const timestamp = new Date().toISOString();
      const signature = window.SecureCrypto.signRequest(
        identityPrivateKey,
        'CONNECT',
        '/ws',
        timestamp,
        ''
      );

      const params = new URLSearchParams({
        identityKey: identityPublicKey,
        signature: signature,
        timestamp: timestamp
      });

      const wsUrl = `${this.serverUrl}?${params.toString()}`;
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.notifyStatus('authenticating');
      };

      this.socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);

          switch (payload.type) {
            case 'authenticated':
              this.isAuthenticated = true;
              this.notifyStatus('connected');
              // Flush any chat states that were queued while WS was connecting
              this._flushPendingChatStates();
              // Flush any pending presence subscription
              if (this._pendingPresenceSubscription) {
                const contacts = this._pendingPresenceSubscription;
                this._pendingPresenceSubscription = null;
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                  this.socket.send(JSON.stringify({
                    type: 'subscribe_presence',
                    contacts: contacts
                  }));
                }
              }
              break;

            case 'message':
              if (this.onMessageCallback) {
                this.onMessageCallback(payload.message);
              }
              break;

            case 'delivered':
              if (this.onDeliveredCallback) {
                this.onDeliveredCallback(payload.recipient, payload.status, payload.message_id || null);
              }
              break;

            case 'presence':
              if (this.onPresenceChangeCallback) {
                this.onPresenceChangeCallback(payload.hash, payload.status);
              }
              break;

            case 'presence_sync':
              if (this.onPresenceSyncCallback) {
                this.onPresenceSyncCallback(payload.statuses);
              }
              break;

            case 'typing':
              if (this.onTypingChangeCallback) {
                this.onTypingChangeCallback(payload.sender_hash, payload.is_typing);
              }
              break;

            case 'chat_state':
              if (this.onChatStateChangeCallback) {
                this.onChatStateChangeCallback(payload.sender_hash, payload.state);
              }
              break;

            case 'read_receipt':
              if (this.onReadReceiptCallback) {
                this.onReadReceiptCallback(payload.sender_hash);
              }
              break;

            case 'chat_config':
              if (this.onChatConfigChangeCallback) {
                this.onChatConfigChangeCallback(payload.sender_hash, payload.burn_timer);
              }
              break;

            case 'clear_chat':
              if (this.onClearChatCallback) {
                this.onClearChatCallback(payload.sender_hash);
              }
              break;

            case 'error':
              console.error('Socket protocol error:', payload.error);
              break;

            default:
              console.log('Unknown socket event type:', payload.type);
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message frame', err);
        }
      };

      this.socket.onclose = (event) => {
        this.isAuthenticated = false;
        this.notifyStatus('disconnected');
        // Only auto-reconnect for *unintentional* drops (network blip, server
        // restart). When WE called disconnect() for lock/shred/logout, stay
        // down — otherwise the loop reconnects behind the user's back and
        // defeats the lock (or hammers the server after a shred).
        if (!this.intentionalClose) {
          this.attemptReconnect(identityPublicKey, identityPrivateKey);
        }
      };

      this.socket.onerror = (err) => {
        console.error('WebSocket connection error:', err);
        this.socket.close();
      };

    } catch (err) {
      console.error('Failed to initialize WebSocket handshake:', err);
      this.notifyStatus('disconnected');
    }
  }

  // Reconnection logic with exponential backoff
  attemptReconnect(publicKey, privateKey) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000;
      console.log(`Reconnecting to server in ${delay / 1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      setTimeout(() => this.connect(publicKey, privateKey), delay);
    } else {
      console.warn('Max WebSocket reconnection attempts reached. Switched to polling / fallback mode.');
      this.notifyStatus('offline-mode');
    }
  }

  // Disconnect from server (intentional — suppresses auto-reconnect).
  disconnect() {
    // Set the flag BEFORE close() so the onclose handler sees it and skips
    // attemptReconnect(). Without this, lock/shred would close the socket only
    // to have it silently re-established moments later.
    this.intentionalClose = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isAuthenticated = false;
    this.notifyStatus('disconnected');
  }

  // Send message over WebSocket, or fallback to signed HTTP post
  async sendMessage(recipientHash, ciphertext, nonce, identityPublicKey, identityPrivateKey) {
    // Generate a unique message ID for delivery-ack correlation. This
    // solves the rapid-send problem where pendingDelivery was overwritten
    // on each send, causing delivered frames to match the wrong message.
    const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.isAuthenticated) {
      this.socket.send(JSON.stringify({
        type: 'message',
        recipient_hash: recipientHash,
        ciphertext: ciphertext,
        nonce: nonce,
        message_id: messageId
      }));
      // Status starts as 'sent' (handed to the network). The authoritative
      // 'realtime'/'queued' value arrives a moment later via the 'delivered'
      // frame and updates the tick via onDelivered.
      return { success: true, method: 'websocket', status: 'sent', message_id: messageId };
    } else {
      console.log('WebSocket not active. Falling back to HTTP delivery...');
      return this.sendViaHttp(recipientHash, ciphertext, nonce, identityPublicKey, identityPrivateKey, messageId);
    }
  }

  // REST API fall-back
  async sendViaHttp(recipientHash, ciphertext, nonce, identityPublicKey, identityPrivateKey, messageId) {
    const timestamp = new Date().toISOString();
    const path = '/api/chat/send';
    const body = { recipient_hash: recipientHash, ciphertext, nonce, message_id: messageId };
    const bodyString = JSON.stringify(body);

    const signature = window.SecureCrypto.signRequest(
      identityPrivateKey,
      'POST',
      path,
      timestamp,
      bodyString
    );

    try {
      const response = await fetch(`${this.httpUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Identity-Key': identityPublicKey,
          'X-Signature': signature,
          'X-Timestamp': timestamp
        },
        body: bodyString
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'HTTP send failed');
      }

      const data = await response.json();
      // Forward the server's authoritative status so the client renders the
      // correct delivery tick: 'realtime' (recipient was online, pushed live)
      // vs 'queued' (recipient offline, stored for later pull).
      return { success: true, method: 'http', message_id: data.message_id, status: data.status || 'queued' };
    } catch (err) {
      console.error('HTTP send error:', err);
      return { success: false, error: err.message };
    }
  }

  // Notify connection status updates
  notifyStatus(status) {
    if (this.onStatusCallback) {
      this.onStatusCallback(status);
    }
  }
}

// Export a global instance
window.SecureSocket = new SecureSocket();
