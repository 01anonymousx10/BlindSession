// public/assets/js/ui.js
// Frontend UI and Session Management Controller

let clientSession = {
  identityPublicKey: null,
  identityPrivateKey: null,
  preKeyPublicKey: null,
  preKeyPrivateKey: null,
  identityKeyHash: null,
  displayName: null,
  contacts: [],          // Array of { fingerprint }
  activeContact: null,   // Selected contact object
  activeSessionKey: null, // Derived symmetric key for active contact
  // ─── New real-time state maps ──────────────
  presence: {},          // fingerprint -> 'online' | 'offline'
  chatActive: {},        // fingerprint -> boolean (recipient viewing our chat)
  typing: {},            // fingerprint -> boolean (recipient is typing)
  readReceipts: {},      // fingerprint -> boolean (last messages read)
  unreadCounts: {},      // fingerprint -> number
  chatConfigs: {},       // fingerprint -> { burnTimer: number | null }
  // ─── Contact metadata ──────────────────────
  shredded: {},          // fingerprint -> true (other side shredded their account)
  // Tracks the timestamp of the last sent message per contact awaiting a
  // delivery receipt, so we can match the 'delivered' frame to the right msg.
  pendingDelivery: {}  // fingerprint -> timestamp (ms) of last sent message
};

// ─── Typing detection state ───────────────────
let typingTimeout = null;
let isCurrentlyTyping = false;

// ─── Bubble entrance-animation tracker ────────
// Records the message count last rendered per conversation so we only fire the
// `new-bubble` entrance animation for messages that genuinely appeared since
// the previous render (avoids re-animating every bubble on a status refresh).
const lastRenderedMsgCount = {};

// ─── Screen transition state ─────────────────
// Guard so a second transition request while one is mid-flight is ignored.
let screenTransitioning = false;

// ─── Async button loading-state helper ──────────
// Disables a button and shows a "Working…" label while an async operation
// runs, then restores it in finally. Usage:
//   const done = setButtonLoading(btn, 'Generating…');
//   try { ... } finally { done(); }
// ─── Haptic feedback (mobile) ──────────────────────
// Triggers a short vibration on supported devices. No-op on desktop.
function haptic(ms = 10) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function setButtonLoading(btn, loadingText) {
  if (!btn) return () => {};
  const originalText = btn.innerHTML;
  const originalDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = loadingText || 'Working…';
  btn.classList.add('is-loading');
  return function restore() {
    btn.disabled = originalDisabled;
    btn.innerHTML = originalText;
    btn.classList.remove('is-loading');
  };
}

/**
 * Cross-fade + scale transition between the auth and chat screens.
 * Pins both full-viewport for 0.5s, fades+shrinks `outId` out while
 * fading+expanding `inId` in, then restores normal layout. Resolves
 * once the animation completes so callers can run post-transition logic.
 * @param {string} outId  id of the screen leaving view
 * @param {string} inId   id of the screen entering view
 * @returns {Promise<void>}
 */
function transitionScreens(outId, inId) {
  return new Promise((resolve) => {
    const outEl = document.getElementById(outId);
    const inEl = document.getElementById(inId);
    if (!outEl || !inEl || screenTransitioning) {
      // Fallback: instant swap if elements are missing or a transition is busy
      if (outEl) outEl.classList.add('hidden');
      if (inEl) inEl.classList.remove('hidden');
      resolve();
      return;
    }

    screenTransitioning = true;

    // 1. Make incoming visible and pin both screens for the animation
    inEl.classList.remove('hidden');
    outEl.classList.add('screen-transition');
    inEl.classList.add('screen-transition');

    // 2. Kick off the cross-fade on the next frame (so classes register)
    requestAnimationFrame(() => {
      outEl.classList.add('leaving');
      inEl.classList.add('entering');
    });

    // 3. After ~0.5s, finalize: hide the outgoing screen and clean up
    const cleanup = () => {
      outEl.classList.remove('leaving', 'screen-transition');
      inEl.classList.remove('entering', 'screen-transition');
      outEl.classList.add('hidden');
      screenTransitioning = false;
      resolve();
    };

    // Prefer animationend, with a safety timeout slightly longer than 0.5s
    let settled = false;
    const onEnd = () => {
      if (settled) return;
      settled = true;
      inEl.removeEventListener('animationend', onEnd);
      cleanup();
    };
    inEl.addEventListener('animationend', onEnd);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
    }, 650);
  });
}

// ─── Window focus tracking for notifications ──
let isWindowFocused = true;
window.addEventListener('blur', () => { 
  isWindowFocused = false; 
  if (clientSession.activeContact) {
    window.SecureSocket.sendChatState(clientSession.activeContact.fingerprint, 'inactive');
  }
});

// ─── Tab close / navigate-away: explicitly disconnect ─────
// Without this the browser eventually tears down the TCP socket but the
// server sees the user as "online" for 30-60 s until the FIN arrives.
window.addEventListener('beforeunload', () => {
  if (window.SecureSocket && window.SecureSocket.isAuthenticated) {
    window.SecureSocket.disconnect();
  }
});
// Safari and iOS rely on pagehide instead of beforeunload.
window.addEventListener('pagehide', () => {
  if (window.SecureSocket && window.SecureSocket.isAuthenticated) {
    window.SecureSocket.disconnect();
  }
});

// ─── Tab-switch visibility: stay online but mark inactive in chat ──
// Previously this disconnected the WebSocket entirely when the tab was
// hidden, which marked the user as offline on all contacts' screens.
// Now we keep the connection alive (so presence stays "online") and just
// send a chat_state: inactive event so the contact knows we're not looking.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Tab hidden → mark as inactive in chat, but stay online
    if (clientSession.activeContact && window.SecureSocket && window.SecureSocket.isAuthenticated) {
      window.SecureSocket.sendChatState(clientSession.activeContact.fingerprint, 'inactive');
    }
  } else if (document.visibilityState === 'visible') {
    // Tab visible again → mark as active in chat + fetch any messages
    // that were queued while we were away (recipient may have sent
    // messages that got queued if our WS dropped for any reason).
    if (clientSession.activeContact && window.SecureSocket && window.SecureSocket.isAuthenticated) {
      window.SecureSocket.sendChatState(clientSession.activeContact.fingerprint, 'active');
    }
    // Fetch offline messages + pending events in case the WS dropped
    // while hidden (network blip, server restart, etc.)
    if (clientSession.identityPublicKey && window.SecureSocket && window.SecureSocket.isAuthenticated) {
      fetchOfflineMessages();
      fetchPendingChatEvents();
      fetchPendingReadReceipts();
    } else if (clientSession.identityPublicKey && clientSession.identityPrivateKey) {
      // WS was disconnected while hidden — reconnect now
      window.SecureSocket.connect(
        clientSession.identityPublicKey,
        clientSession.identityPrivateKey
      ).then(() => {
        const waitForReAuth = setInterval(() => {
          if (window.SecureSocket.isAuthenticated) {
            clearInterval(waitForReAuth);
            subscribeToContactPresence();
            fetchOfflineMessages();
            fetchPendingChatEvents();
            fetchPendingReadReceipts();
          }
        }, 200);
        setTimeout(() => clearInterval(waitForReAuth), 10000);
      });
    }
  }
});

// ─── Strict Read / Visibility Gate ───────────
/**
 * Returns true ONLY if:
 *   - the browser tab is currently visible (not hidden/minimized)
 *   - the window/document has focus
 *   - the user is looking at the correct contact's chat
 */
function isChatActivelyViewed(contactFingerprint) {
  return (
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    clientSession.activeContact != null &&
    clientSession.activeContact.fingerprint === contactFingerprint
  );
}

// ─── Web Audio notification synthesizer ───────
let audioCtx = null;
function playNotificationChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;

    // Neon-synth two-tone ascending chime
    const notes = [880, 1174.66]; // A5, D6
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      gain.gain.setValueAtTime(0.18, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
  } catch (e) {
    // Web Audio not available, silently ignore
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const initApp = async () => {
    // Apply B&W theme button text
    if (localStorage.getItem('bw_theme') === 'true') {
      setTimeout(() => updateThemeButtonText(true), 0);
    }

    try {
      await window.SecureCrypto.init();
      console.log('✅ Client cryptography module ready.');

      if (localStorage.getItem('encrypted_identity')) {
        showAuthTab('login');
        document.getElementById('auth-tabs').style.display = 'flex';
      } else {
        showAuthTab('register');
        document.getElementById('auth-tabs').style.display = 'flex';
      }

      // NOTE: Contacts are loaded inside enterChatDashboard() — NOT here.
      // Loading them before login would inject a previous account's contact
      // list into the session, causing a "new account shows old contacts" bug.
    } catch (err) {
      console.error('Failed to load libsodium WASM wrapper:', err);
      showToast('Failed to initialize security libraries. Please refresh or check browser settings.', 'error', 6000);
    }

    // ─── Socket Status Listener ─────────────────
    window.SecureSocket.onStatusChange((status) => {
      updateConnectionStatus(status);
    });

    // ─── Socket Message Listener ────────────────
    window.SecureSocket.onMessage(async (msg) => {
      await handleIncomingE2eeMessage(msg);
    });

    // ─── Presence Hooks ─────────────────────────
    window.SecureSocket.onPresenceSync((statuses) => {
      Object.entries(statuses).forEach(([hash, status]) => {
        clientSession.presence[hash] = status;
      });
      renderContactsList();
      updateActiveChatPresence();
    });

    window.SecureSocket.onPresenceChange((hash, status) => {
      clientSession.presence[hash] = status;
      // When a contact disconnects, clear stale chat-active and typing states
      // so "Active in chat" badge doesn't stay pinned forever
      if (status === 'offline') {
        delete clientSession.chatActive[hash];
        delete clientSession.typing[hash];
        // Also clear typing indicator if it's showing for this contact
        if (clientSession.activeContact && clientSession.activeContact.fingerprint === hash) {
          renderTypingIndicator(hash, false);
        }
      }
      renderContactsList();
      updateActiveChatPresence();
    });

    // ─── Typing Hook ────────────────────────────
    window.SecureSocket.onTypingChange((senderHash, isTyping) => {
      clientSession.typing[senderHash] = isTyping;
      // Update typing indicator in active chat
      if (clientSession.activeContact && clientSession.activeContact.fingerprint === senderHash) {
        renderTypingIndicator(senderHash, isTyping);
        updateActiveChatPresence(); // refresh header "typing…" state
      }
      // Update sidebar inline typing
      renderContactsList();
    });

    // ─── Chat State Hook ────────────────────────
    window.SecureSocket.onChatStateChange((senderHash, state) => {
      clientSession.chatActive[senderHash] = (state === 'active');
      updateActiveChatPresence();
      // Re-render the sidebar so the contact's green dot reflects the
      // active/inactive state immediately, not just when some other
      // event happens to trigger a re-render.
      renderContactsList();
    });

    // ─── Read Receipt Hook ──────────────────
    window.SecureSocket.onReadReceipt((senderHash) => {
      // The other person read our messages. Mark only sent messages that
      // existed before now as read — NOT future messages. This fixes the
      // bug where all sent messages showed ✓✓ after any read receipt.
      const readTime = Date.now();
      clientSession.readReceipts[senderHash] = readTime;

      // Persist the read status for our sent messages so double-ticks survive reloads.
      // Only mark messages sent BEFORE the read time as read.
      const historyKey = `history_${senderHash}`;
      const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
      let updated = false;
      history.forEach(m => {
        if (m.sender === clientSession.identityKeyHash && !m.readTimestamp) {
          const msgTime = new Date(m.timestamp).getTime();
          if (msgTime <= readTime) {
            m.readTimestamp = readTime;
            updated = true;
          }
        }
      });
      if (updated) {
        localStorage.setItem(historyKey, JSON.stringify(history));
      }

      renderActiveChatMessages();
    });

    // ─── Chat Config Change Hook ────────────────
    window.SecureSocket.onChatConfigChange((senderHash, burnTimer) => {
      const prevConfig = clientSession.chatConfigs[senderHash];
      const prevTimer = prevConfig ? prevConfig.burnTimer : undefined;

      clientSession.chatConfigs[senderHash] = { burnTimer };
      localStorage.setItem(`chat_config_${senderHash}`, JSON.stringify({ burnTimer }));

      // Update dropdown UI if active
      if (clientSession.activeContact && clientSession.activeContact.fingerprint === senderHash) {
        const selector = document.getElementById('disappearing-select');
        if (selector) {
          selector.value = burnTimer === null ? 'off' : burnTimer.toString();
        }
      }

      if (prevTimer !== burnTimer) {
        const timerText = getBurnTimerText(burnTimer);
        const contactName = clientSession.contacts.find(c => c.fingerprint === senderHash)?.displayName
          || window.SecureCrypto.hashToName(senderHash);
        saveMessageToStorage(senderHash, 'system', `Disappearing messages set to ${timerText} by ${contactName}`, new Date().toISOString());
        // Toast popup so the user sees the change even if they don't have
        // this contact's chat currently open.
        showToast(`${contactName} set disappearing messages to ${timerText}`, 'info', 5000);
        if (clientSession.activeContact && clientSession.activeContact.fingerprint === senderHash) {
          renderActiveChatMessages();
        }
        renderContactsList();
      }
    });

    // ─── Clear Chat Hook ─────────────────────
    window.SecureSocket.onClearChat((senderHash) => {
      handleClearChatReceived(senderHash);
    });

    // ─── Delivery Status Hook (tick coloring) ────
    // status: 'realtime' = recipient online, message delivered live
    //         'queued'   = recipient offline, stored for later pull
    //         'delivered' = offline message just pulled by recipient (#3)
    window.SecureSocket.onDelivered((recipientHash, status, messageId) => {
      // Map: realtime → delivered (blue ✓), queued → sent (gray ✓),
      // delivered → delivered (offline message just pulled, blue ✓)
      const mappedStatus = (status === 'realtime' || status === 'delivered') ? 'delivered' : 'sent';
      updateSentMessageStatus(recipientHash, mappedStatus, messageId);
    });

    // ─── Request Notification Permission ────────
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // ─── Visibility / Focus → deferred read receipt ─────
    const maybeSendPendingReadReceipt = () => {
      if (!clientSession.activeContact) return;
      const fp = clientSession.activeContact.fingerprint;

      // Update active/inactive state based on focus and visibility
      if (isChatActivelyViewed(fp)) {
        window.SecureSocket.sendChatState(fp, 'active');
        
        // Mark all received messages as read and fire the receipt
        const historyKey = `history_${fp}`;
        const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        let updated = false;
        history.forEach(m => {
          if (m.sender !== clientSession.identityKeyHash && m.sender !== 'system' && !m.readTimestamp) {
            m.readTimestamp = Date.now();
            updated = true;
          }
        });
        if (updated) {
          localStorage.setItem(historyKey, JSON.stringify(history));
          window.SecureSocket.sendReadReceipt(fp);
          markContactAsRead(fp);
          renderActiveChatMessages();
          renderContactsList();
        }
      } else {
        window.SecureSocket.sendChatState(fp, 'inactive');
      }
    };
    document.addEventListener('visibilitychange', maybeSendPendingReadReceipt);
    window.addEventListener('focus', () => {
      isWindowFocused = true;
      maybeSendPendingReadReceipt();
    });


    // ─── Contact Search Filter ────────────────────
    const contactSearchInput = document.getElementById('contact-search');
    if (contactSearchInput) {
      contactSearchInput.addEventListener('input', (e) => {
        filterContacts(e.target.value);
      });
    }

    // ─── Welcome Overlay Dismiss / CTA ───────────
    const welcomeDismiss = document.getElementById('welcome-dismiss');
    const welcomeCta = document.getElementById('welcome-cta');
    const dismissWelcome = () => {
      const overlay = document.getElementById('welcome-overlay');
      if (overlay) {
        overlay.classList.add('hidden');
        if (_welcomeModalClose) { _welcomeModalClose(); _welcomeModalClose = null; }
        localStorage.setItem('welcome_seen', 'true');
      }
    };
    if (welcomeDismiss) {
      welcomeDismiss.addEventListener('click', dismissWelcome);
    }
    if (welcomeCta) {
      welcomeCta.addEventListener('click', () => {
        dismissWelcome();
        const newContactInput = document.getElementById('new-contact-hash');
        if (newContactInput) newContactInput.focus();
      });
    }

    // ─── Message Input Typing Detection ─────────
    const messageField = document.getElementById('message-field');
    if (messageField) {
      messageField.addEventListener('input', handleTypingInput);
      messageField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSendE2eeMessage();
        }
      });
    }
  };

  if (window._sodiumReady) {
    initApp();
  } else {
    window.addEventListener('sodium-ready', initApp, { once: true });
  }
});

// ─── Typing Detection with Debounce ─────────────
function handleTypingInput() {
  if (!clientSession.activeContact) return;
  const recipientHash = clientSession.activeContact.fingerprint;

  if (!isCurrentlyTyping) {
    isCurrentlyTyping = true;
    window.SecureSocket.sendTyping(recipientHash, true);
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isCurrentlyTyping = false;
    window.SecureSocket.sendTyping(recipientHash, false);
  }, 2000);
}


// ─── Auth Tab Helpers ───────────────────────────
function showAuthTab(tab) {
  const regBtn   = document.getElementById('register-tab-btn');
  const loginBtn = document.getElementById('login-tab-btn');
  const regTab   = document.getElementById('register-tab');
  const loginTab = document.getElementById('login-tab');

  // Always clear any stale inline styles first (legacy cleanup)
  regBtn.style.borderBottom   = '';
  regBtn.style.color          = '';
  loginBtn.style.borderBottom = '';
  loginBtn.style.color        = '';

  if (tab === 'register') {
    regBtn.classList.add('active');
    loginBtn.classList.remove('active');
    regTab.classList.remove('hidden');
    loginTab.classList.add('hidden');
  } else {
    loginBtn.classList.add('active');
    regBtn.classList.remove('active');
    loginTab.classList.remove('hidden');
    regTab.classList.add('hidden');
  }
}

/**
 * 1. Account Identity Generation & Registration
 */
async function handleGenerateIdentity() {
  const passphrase = document.getElementById('reg-passphrase').value;
  if (!passphrase || passphrase.length < 8) {
    showToast('Passphrase must be at least 8 characters long.', 'warning');
    return;
  }

  const btn = document.querySelector('button[onclick="handleGenerateIdentity()"]');
  const restoreBtn = setButtonLoading(btn, 'Generating…');
  const authWrapper = document.querySelector('.auth-wrapper');
  if (authWrapper) authWrapper.setAttribute('aria-busy', 'true');
  try {
    await window.SecureCrypto.init();
    const identityKeys = window.SecureCrypto.generateIdentityKeyPair();
    const preKeys = window.SecureCrypto.generatePreKeyPair();
    const preKeySignature = window.SecureCrypto.signPreKey(identityKeys.privateKey, preKeys.publicKey);

    const response = await fetch(`${window.location.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_identity_key: identityKeys.publicKey,
        public_prekey: preKeys.publicKey,
        prekey_signature: preKeySignature
      })
    });

    if (!response.ok) {
      const errorMsg = await response.json();
      throw new Error(errorMsg.error || 'Server registration failed');
    }

    const data = await response.json();

    clientSession.identityPublicKey = identityKeys.publicKey;
    clientSession.identityPrivateKey = identityKeys.privateKey;
    clientSession.preKeyPublicKey = preKeys.publicKey;
    clientSession.preKeyPrivateKey = preKeys.privateKey;
    clientSession.identityKeyHash = data.identity_key_hash;

    // Wipe all previous account data (contacts, chat history, configs) so a
    // brand-new identity starts with a clean slate.  Without this, leftover
    // entries from a prior registration would bleed into the new session.
    clearAllAccountData();

    encryptAndStoreKeys(passphrase);

    // ── Generate & store Master Recovery Code ────────────────────────────
    const recoveryPhrase = generateRecoveryCode();

    // Encrypt the raw keys JSON *again* under the recovery code phrase,
    // using a separate Argon2id salt. This blob lets the user reset their
    // passphrase without knowing the original one.
    const sodium = window.sodium;
    const recSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const recSaltB64 = sodium.to_base64(recSalt);
    const recKey = window.SecureCrypto.deriveKeyFromPassphrase(recoveryPhrase, recSaltB64);
    const rawKeys = {
      identityPublicKey: clientSession.identityPublicKey,
      identityPrivateKey: clientSession.identityPrivateKey,
      preKeyPublicKey: clientSession.preKeyPublicKey,
      preKeyPrivateKey: clientSession.preKeyPrivateKey,
      identityKeyHash: clientSession.identityKeyHash
    };
    const recEncrypted = window.SecureCrypto.encrypt(JSON.stringify(rawKeys), recKey);
    sodium.memzero(recKey);
    localStorage.setItem('encrypted_recovery_code', JSON.stringify({
      kdf: 'argon2id',
      salt: recSaltB64,
      ciphertext: recEncrypted.ciphertext,
      nonce: recEncrypted.nonce
    }));

    // Display the recovery code in the UI
    const rcDisplay = document.getElementById('recovery-code-display');
    if (rcDisplay) rcDisplay.textContent = recoveryPhrase;

    // Store plain recovery code temporarily for backup export.
    // Removed from localStorage after first backup download or session end.
    localStorage.setItem('recovery_code_plain', recoveryPhrase);

    // Zero-knowledge server sync: store recovery ciphertext in database
    const recoveryBlobStr = localStorage.getItem('encrypted_recovery_code');
    if (recoveryBlobStr) {
      try {
        await fetch(`${window.location.origin}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            public_identity_key: identityKeys.publicKey,
            public_prekey: preKeys.publicKey,
            prekey_signature: preKeySignature,
            recovery_blob: recoveryBlobStr
          })
        });
      } catch (err) {
        console.warn('Remote recovery blob sync skipped:', err.message);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    document.getElementById('fingerprint-display').textContent = data.identity_key_hash;
    document.getElementById('reg-result').classList.remove('hidden');

  } catch (err) {
    console.error('Identity creation failed:', err);
    showToast(`Failed to generate identity: ${err.message}`, 'error', 6000);
  } finally {
    restoreBtn();
    if (authWrapper) authWrapper.removeAttribute('aria-busy');
  }
}

/**
 * Wipe all per-account localStorage entries (contacts, chat history, configs)
 * so a new identity starts with a completely clean slate.
 */
function clearAllAccountData() {
  clientSession.contacts = [];

  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === 'contacts' ||
        key === 'encrypted_recovery_code' ||
        key === 'recovery_code_plain' ||
        key === 'my_display_name' ||
        key.startsWith('history_') ||
        key.startsWith('read_count_') ||
        key.startsWith('chat_config_')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
}

/**
 * Local Key Encryption & Storage
 */
function encryptAndStoreKeys(passphrase) {
  const sodium = window.sodium;
  const rawKeys = {
    identityPublicKey: clientSession.identityPublicKey,
    identityPrivateKey: clientSession.identityPrivateKey,
    preKeyPublicKey: clientSession.preKeyPublicKey,
    preKeyPrivateKey: clientSession.preKeyPrivateKey,
    identityKeyHash: clientSession.identityKeyHash
  };

  // Derive the wrapping key with Argon2id over a fresh per-identity salt.
  // A random salt means the same passphrase on two identities yields different
  // keys and forces attackers to redo the (memory-hard) work per identity.
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES); // 16 bytes
  const saltBase64 = sodium.to_base64(salt);
  const key = window.SecureCrypto.deriveKeyFromPassphrase(passphrase, saltBase64);

  const plainText = JSON.stringify(rawKeys);
  const encrypted = window.SecureCrypto.encrypt(plainText, key);

  // Versioned blob shape: `kdf` tags the derivation so legacy (Blake2b) blobs
  // can still be read and migrated on unlock (see handleUnlockIdentity).
  localStorage.setItem('encrypted_identity', JSON.stringify({
    kdf: 'argon2id',
    salt: saltBase64,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce
  }));

  sodium.memzero(key);
}

/**
 * 2. Identity Unlock & Decryption
 */
async function handleUnlockIdentity() {
  const passphrase = document.getElementById('login-passphrase').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');

  if (!passphrase) {
    showToast('Please enter your passphrase.', 'warning');
    return;
  }

  // ─── Duress Passphrase Check (Silent Panic Shredder) ─────────────
  const duressPassphrase = localStorage.getItem('duress_passphrase');
  if (duressPassphrase && passphrase === duressPassphrase) {
    console.warn('🚨 DURESS PASSPHRASE DETECTED: Triggering silent shredder.');
    handlePanicShredder(true);
    document.getElementById('login-passphrase').value = '';
    errorEl.textContent = 'Invalid passphrase. Decryption failed.';
    errorEl.classList.remove('hidden');
    return;
  }

  const storedData = localStorage.getItem('encrypted_identity');
  if (!storedData) {
    showToast('No identity keys found on this device. Please create an identity.', 'info');
    return;
  }

  const btn = document.querySelector('button[onclick="handleUnlockIdentity()"]');
  const restoreBtn = setButtonLoading(btn, 'Unlocking…');
  const authWrapper = document.querySelector('.auth-wrapper');
  if (authWrapper) authWrapper.setAttribute('aria-busy', 'true');
  try {
    await window.SecureCrypto.init();
    const blob = JSON.parse(storedData);
    const sodium = window.sodium;

    // Branch on the blob's KDF tag. Blobs created before the Argon2id upgrade
    // have no `kdf` field — treat those as legacy 'blake2b' so existing users
    // can still unlock, then transparently re-encrypt to Argon2id below.
    const kdf = blob.kdf || 'blake2b';

    let key;
    let legacy = false;
    if (kdf === 'argon2id') {
      key = window.SecureCrypto.deriveKeyFromPassphrase(passphrase, blob.salt);
    } else {
      // Legacy path: the original (weak) derivation — crypto_generichash(32,
      // passphrase). Kept ONLY so existing blobs can be unlocked + migrated.
      legacy = true;
      key = sodium.crypto_generichash(32, passphrase);
    }

    // decrypt() THROWS on a wrong passphrase (auth-tag mismatch), which falls
    // straight into the outer catch and renders "Invalid passphrase" — no
    // sentinel-string check needed. The key must be zeroed before the throw so
    // it never leaks.
    let decryptedJson;
    try {
      decryptedJson = window.SecureCrypto.decrypt(blob.ciphertext, blob.nonce, key);
    } finally {
      sodium.memzero(key);
    }

    const keys = JSON.parse(decryptedJson);

    clientSession.identityPublicKey = keys.identityPublicKey;
    clientSession.identityPrivateKey = keys.identityPrivateKey;
    clientSession.preKeyPublicKey = keys.preKeyPublicKey;
    clientSession.preKeyPrivateKey = keys.preKeyPrivateKey;
    clientSession.identityKeyHash = keys.identityKeyHash;
    clientSession.unlockedPassphrase = passphrase;

    // Transparent migration: a legacy (Blake2b) blob just unlocked correctly,
    // so rewrite it in the new Argon2id shape so future unlocks use the strong
    // KDF. We do this after the keys are loaded into the session so
    // encryptAndStoreKeys (which reads clientSession) writes the right payload.
    if (legacy) {
      encryptAndStoreKeys(passphrase);
    }

    enterChatDashboard();

  } catch (err) {
    console.error('Unlock failed:', err);
    errorEl.textContent = 'Invalid passphrase. Decryption failed.';
    errorEl.classList.remove('hidden');
  } finally {
    restoreBtn();
    if (authWrapper) authWrapper.removeAttribute('aria-busy');
  }
}

/**
 * Instant Demo Mode
 */
async function handleInstantDemo() {
  try {
    await window.SecureCrypto.init();
    const identityKeys = window.SecureCrypto.generateIdentityKeyPair();
    const preKeys = window.SecureCrypto.generatePreKeyPair();

    const sodium = window.sodium;
    const hashBytes = sodium.crypto_generichash(32, sodium.from_base64(identityKeys.publicKey));
    const identityKeyHash = sodium.to_hex(hashBytes);

    clientSession.identityPublicKey = identityKeys.publicKey;
    clientSession.identityPrivateKey = identityKeys.privateKey;
    clientSession.preKeyPublicKey = preKeys.publicKey;
    clientSession.preKeyPrivateKey = preKeys.privateKey;
    clientSession.identityKeyHash = identityKeyHash;

    enterChatDashboard();

    const mockContactFingerprint = 'e00000000000000000000000000000000000000000000000000000000000000e';
    if (!clientSession.contacts.some(c => c.fingerprint === mockContactFingerprint)) {
      clientSession.contacts.push({ fingerprint: mockContactFingerprint });
      localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
    }

    renderContactsList();

    updateConnectionStatus('offline-mode');
    document.getElementById('connection-label').textContent = 'Demo Mode';

  } catch (err) {
    console.error('Instant Demo initiation failed:', err);
    showToast(`Failed to start demo: ${err.message}`, 'error', 6000);
  }
}

/**
 * Enter SPA Dashboard View
 */
function enterChatDashboard() {
  // Load custom display name from localStorage
  clientSession.displayName = localStorage.getItem('my_display_name') || null;

  // Cross-fade + scale from the auth screen into the chat dashboard
  transitionScreens('auth-screen', 'chat-screen').then(() => {
    // Profile-card population runs after the new screen is in view
    const identiconEl = document.getElementById('profile-identicon');
    const fpDisplayEl = document.getElementById('profile-fingerprint');
    const labelEl = document.querySelector('.profile-label');
    if (identiconEl) {
      identiconEl.innerHTML = generateIdenticon(clientSession.identityKeyHash);
    }
    if (fpDisplayEl) {
      const fp = clientSession.identityKeyHash;
      fpDisplayEl.textContent = `${fp.substring(0, 4)}…${fp.substring(fp.length - 4)}`;
    }
    if (labelEl) {
      labelEl.textContent = clientSession.displayName || window.SecureCrypto.hashToName(clientSession.identityKeyHash);
    }
  });

  // Ensure welcome overlay is visible on load (unless already dismissed before)
  const welcomeOverlay = document.getElementById('welcome-overlay');
  if (welcomeOverlay) {
    if (localStorage.getItem('welcome_seen') === 'true') {
      welcomeOverlay.classList.add('hidden');
    } else {
      welcomeOverlay.classList.remove('hidden');
      if (_welcomeModalClose) _welcomeModalClose();
      _welcomeModalClose = openModalTrap(welcomeOverlay);
      welcomeOverlay.addEventListener('modal-close', () => {
        welcomeOverlay.classList.add('hidden');
        if (_welcomeModalClose) { _welcomeModalClose(); _welcomeModalClose = null; }
        localStorage.setItem('welcome_seen', 'true');
      }, { once: true });
    }
  }

  // Load contacts only now — after the user has unlocked or registered.
  // This prevents stale contacts from a previous account from leaking into
  // a freshly created identity.
  loadContactsFromStorage();

  document.getElementById('my-identity-display').textContent = clientSession.identityKeyHash;

  window.SecureSocket.connect(
    clientSession.identityPublicKey,
    clientSession.identityPrivateKey
  );

  // Compute unread counts on entry
  computeAllUnreadCounts();

  // Detect contacts whose accounts have been shredded (Panic Shredder).
  // Done in the background so a slow/unreachable server never blocks the UI.
  checkShreddedContacts();

  // Automated dynamic prekey rotation on session unlock (limits compromise window).
  // MUST complete before the user can select a contact or fetch offline
  // messages — otherwise the session key is derived with the OLD prekey
  // while the server publishes the NEW one, causing decryption failures on
  // the recipient side (race condition).
  rotatePreKey().then(() => {
    renderContactsList();

    // Subscribe to contact presence + fetch offline messages after connection
    const waitForAuth = setInterval(() => {
      if (window.SecureSocket.isAuthenticated) {
        clearInterval(waitForAuth);
        subscribeToContactPresence();
        // Fetch any messages that were queued while we were offline — this
        // covers the one-way-add scenario where someone sent us a message
        // before we added them as a contact.
        fetchOfflineMessages();
        // Fetch pending chat events (timer changes, clear-chat) that were
        // persisted while we were offline.
        fetchPendingChatEvents();
        // Fetch pending read receipts (✓✓) that were persisted while offline.
        fetchPendingReadReceipts();
      }
    }, 200);
    // Safety timeout: stop waiting after 10s
    setTimeout(() => clearInterval(waitForAuth), 10000);
  }).catch(err => {
    console.warn('Prekey rotation failed, proceeding with current keys:', err.message);
    renderContactsList();
    // Still fetch offline messages even if rotation failed
    const waitForAuth = setInterval(() => {
      if (window.SecureSocket.isAuthenticated) {
        clearInterval(waitForAuth);
        subscribeToContactPresence();
        fetchOfflineMessages();
        fetchPendingChatEvents();
        fetchPendingReadReceipts();
      }
    }, 200);
    setTimeout(() => clearInterval(waitForAuth), 10000);
  });
}

function subscribeToContactPresence() {
  const contactHashes = clientSession.contacts.map(c => c.fingerprint);
  if (contactHashes.length > 0) {
    window.SecureSocket.subscribePresence(contactHashes);
  }
}

/**
 * Detect contacts whose server account has been deleted (Panic Shredder) by
 * diffing the contact list against the server's user directory. Missing
 * fingerprints are marked shredded and rendered with a badge + remove option.
 * In demo/offline mode there's no directory to check, so this is a no-op.
 */
async function checkShreddedContacts() {
  if (!clientSession.identityKeyHash) return;
  // The demo bot fingerprint is a local mock — never shredded.
  const DEMO_FP = 'e00000000000000000000000000000000000000000000000000000000000000e';

  let changed = false;
  // Query each contact status individually to respect privacy without the global directory
  for (const c of clientSession.contacts) {
    if (c.fingerprint === DEMO_FP) continue;
    try {
      const response = await fetch(`${window.location.origin}/api/users/${c.fingerprint}`);
      if (response.status === 404) {
        if (!clientSession.shredded[c.fingerprint]) {
          clientSession.shredded[c.fingerprint] = true;
          changed = true;
        }
      } else if (response.ok) {
        if (clientSession.shredded[c.fingerprint]) {
          delete clientSession.shredded[c.fingerprint];
          changed = true;
        }
      }
    } catch (err) {
      // Network error / server down — silently skip this contact
    }
  }
  if (changed) renderContactsList();
}

/**
 * 3. Contacts Management
 */
function loadContactsFromStorage() {
  const contactsStr = localStorage.getItem('contacts');
  if (contactsStr) {
    clientSession.contacts = JSON.parse(contactsStr);
  }
  // Backfill addedAt for legacy contacts that predate this field, and persist
  // the upgrade so the sort is stable on subsequent loads.
  let dirty = false;
  clientSession.contacts.forEach(c => {
    if (!c.addedAt) {
      // No reliable timestamp: fall back to the earliest message in the chat
      // (if any), else a stable low value so existing contacts keep their
      // relative ordering ahead of brand-new ones.
      const hist = JSON.parse(localStorage.getItem(`history_${c.fingerprint}`) || '[]');
      c.addedAt = hist.length ? new Date(hist[0].timestamp).getTime() : 0;
      dirty = true;
    }
  });
  if (dirty) {
    localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
  }
}

async function handleAddContact() {
  const hash = document.getElementById('new-contact-hash').value.trim();
  if (!hash) {
    showToast('Please enter a contact fingerprint.', 'warning');
    return;
  }

  if (hash === clientSession.identityKeyHash) {
    showToast('You cannot add yourself as a contact.', 'warning');
    return;
  }

  if (clientSession.contacts.some(c => c.fingerprint === hash)) {
    showToast('Contact already added.', 'info');
    return;
  }

  const addBtn = document.querySelector('button[onclick="handleAddContact()"]');
  const restoreBtn = setButtonLoading(addBtn, 'Adding…');

  // Verify the account still exists on the server before adding, so we don't
  // create a ghost entry for a shredded fingerprint. (Demo/offline mode skips
  // this check because there's no directory to query.)
  try {
    const res = await fetch(`${window.location.origin}/api/users/${hash}`);
    if (res.status === 404) {
      showToast('This account no longer exists on the server (it may have been deleted). It cannot be re-added.', 'warning', 6000);
      return;
    }
    // Other failures (server down) → fall through and add optimistically.
  } catch (err) {
    // Network error — allow the add; presence/handshake will surface issues later.
  } finally {
    restoreBtn();
  }

  clientSession.contacts.push({ fingerprint: hash, addedAt: Date.now() });
  localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
  document.getElementById('new-contact-hash').value = '';

  // Re-subscribe presence with new contact
  subscribeToContactPresence();
  renderContactsList();
}

/**
 * Compute unread counts from local storage
 */
function computeAllUnreadCounts() {
  clientSession.contacts.forEach(contact => {
    const historyKey = `history_${contact.fingerprint}`;
    const readKey = `read_count_${contact.fingerprint}`;
    const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
    const readCount = parseInt(localStorage.getItem(readKey) || '0', 10);

    // Count only received messages
    const receivedMessages = history.filter(m => m.sender !== clientSession.identityKeyHash);
    const unread = Math.max(0, receivedMessages.length - readCount);
    clientSession.unreadCounts[contact.fingerprint] = unread;
  });
}

function renderContactsList() {
  const listEl = document.getElementById('contacts-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (clientSession.contacts.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding: 2rem; font-size:0.85rem;">No contacts added yet. Paste a fingerprint above.</div>';
    return;
  }

  // Build enriched contact data with latest message info
  const enriched = clientSession.contacts.map(contact => {
    const historyKey = `history_${contact.fingerprint}`;
    const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
    const lastMsg = history.length > 0 ? history[history.length - 1] : null;
    const unread = clientSession.unreadCounts[contact.fingerprint] || 0;
    const addedAt = contact.addedAt || 0;
    const shredded = !!clientSession.shredded[contact.fingerprint];
    return { ...contact, lastMsg, unread, addedAt, shredded, historyLength: history.length };
  });

  // Sort order (top → bottom):
  //   1. Contacts with unread messages float above read ones
  //   2. Within a group, sort by most recent activity — last message
  //      timestamp, or addedAt for contacts with no messages yet (newest add
  //      near the top). Note: unread ties are broken by RECENCY, not count,
  //      so the freshest conversation always wins (e.g. a "now" chat beats a
  //      "3d ago" chat even if the older one has more unread).
  const recencyOf = (c) => c.lastMsg ? new Date(c.lastMsg.timestamp).getTime() : (c.addedAt || 0);
  enriched.sort((a, b) => {
    // Unread contacts always float above read ones.
    const aUnread = a.unread > 0;
    const bUnread = b.unread > 0;
    if (aUnread !== bUnread) return aUnread ? -1 : 1;

    // Same unread/read group → most recent first.
    return recencyOf(b) - recencyOf(a);
  });

  enriched.forEach(contact => {
    const item = document.createElement('div');
    item.className = 'contact-item';
    item.dataset.fingerprint = contact.fingerprint;
    item.dataset.name = contact.displayName || window.SecureCrypto.hashToName(contact.fingerprint);
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Open chat with ${item.dataset.name}`);
    if (clientSession.activeContact && clientSession.activeContact.fingerprint === contact.fingerprint) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'true');
    }
    if (contact.shredded) {
      item.classList.add('shredded');
    }

    const isOnline = clientSession.presence[contact.fingerprint] === 'online';
    const isTyping = clientSession.typing[contact.fingerprint];
    const unread = contact.unread;
    const isShredded = contact.shredded;

    // Message preview
    let previewText = '';
    let previewTime = '';
    if (contact.lastMsg) {
      const isMine = contact.lastMsg.sender === clientSession.identityKeyHash;
      const raw = contact.lastMsg.text || '';
      if (contact.lastMsg.isImage) {
        previewText = (isMine ? 'You: ' : '') + 'Image';
      } else if (contact.lastMsg.sender === 'system') {
        previewText = raw;
      } else {
        previewText = (isMine ? 'You: ' : '') + (raw.length > 35 ? raw.substring(0, 35) + '…' : raw);
      }
      previewTime = formatRelativeTime(contact.lastMsg.timestamp);
    }

    // Shredded badge replaces typing/preview line for clarity
    const bottomRowInner = isShredded
      ? '<span class="shredded-badge">🗑️ Account shredded</span>'
      : (isTyping
          ? '<span class="contact-typing-inline"><span class="typing-dots"><span></span><span></span><span></span></span> typing...</span>'
          : `<span class="contact-preview">${escapeHTML(previewText) || '<span style="opacity:0.4;">No messages yet</span>'}</span>`);

    item.innerHTML = `
      <div class="contact-row">
        <div class="contact-avatar-wrapper">
          <div class="contact-avatar">${generateIdenticon(contact.fingerprint)}</div>
          <span class="presence-dot ${isOnline ? 'online' : 'offline'}"></span>
        </div>
        <div class="contact-info">
          <div class="contact-top-row">
            <span class="contact-name">${escapeHTML(contact.displayName || window.SecureCrypto.hashToName(contact.fingerprint))}</span>
            ${previewTime ? `<span class="contact-time">${previewTime}</span>` : ''}
          </div>
          <div class="contact-bottom-row">
            ${bottomRowInner}
            ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
        <button class="contact-menu-btn" aria-label="Contact options" title="More options">⋯</button>
      </div>
      <div class="contact-menu hidden">
        <button class="contact-menu-item clear-history-item" data-action="clear-history">🗑️ Clear history</button>
        <button class="contact-menu-item" data-action="remove">${isShredded ? '🗑️ Remove' : '✕ Remove contact'}</button>
      </div>
    `;

    item.onclick = () => handleSelectContact(contact);
    item.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelectContact(contact);
      }
    };

    // ⋯ menu wiring (stop propagation so it doesn't also select the contact)
    const menuBtn = item.querySelector('.contact-menu-btn');
    const menu = item.querySelector('.contact-menu');
    if (menuBtn && menu) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close any other open menus first
        document.querySelectorAll('.contact-menu:not(.hidden)').forEach(m => {
          if (m !== menu) m.classList.add('hidden');
        });
        menu.classList.toggle('hidden');
      });
      menu.querySelectorAll('.contact-menu-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.classList.add('hidden');
          if (btn.dataset.action === 'remove') {
            handleRemoveContact(contact);
          } else if (btn.dataset.action === 'clear-history') {
            handleClearContactHistory(contact);
          }
        });
      });
    }

    listEl.appendChild(item);
  });

  // Update document title and favicon with total unread count
  updateUnreadBadge();
}

// Close any open contact ⋯ menu when clicking elsewhere
document.addEventListener('click', () => {
  document.querySelectorAll('.contact-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
});

// ─── Document title + favicon unread badge ─────────
const _BASE_TITLE = 'BlindSession | Server-Blind End-to-End Encrypted Chat';
const _FAVICON_BASE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2300ff9d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E";

function updateUnreadBadge() {
  let total = 0;
  Object.values(clientSession.unreadCounts || {}).forEach(c => { total += (c || 0); });
  // Update title
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) BlindSession` : _BASE_TITLE;
  // Update favicon with badge number
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  if (total > 0) {
    const badge = total > 99 ? '99' : String(total);
    const badgeColor = '%23ff4d4d';
    link.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='11' width='18' height='11' rx='2' ry='2' fill='none' stroke='%2300ff9d' stroke-width='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4' fill='none' stroke='%2300ff9d' stroke-width='2'/%3E%3Ccircle cx='19' cy='6' r='5' fill='" + badgeColor + "'/%3E%3Ctext x='19' y='9' text-anchor='middle' fill='white' font-size='7' font-family='sans-serif' font-weight='bold'%3E" + (total > 99 ? '99+' : badge) + "%3C/text%3E%3C/svg%3E";
  } else {
    link.href = _FAVICON_BASE;
  }
}

/**
 * 4. Contact Selection & Key Agreement Handshake
 */
async function handleSelectContact(contact) {
  haptic(10);
  // Hide welcome overlay on contact selection
  const welcomeOverlay = document.getElementById('welcome-overlay');
  if (welcomeOverlay) {
    welcomeOverlay.classList.add('hidden');
  }

  // On mobile, close the sidebar drawer after a contact is chosen so the
  // chat area becomes the focus. No-op on desktop.
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();

  // Send inactive state for previous contact and clear local chatActive
  // state so it doesn't show a stale "Active in chat" badge if we switch back.
  if (clientSession.activeContact && clientSession.activeContact.fingerprint !== contact.fingerprint) {
    window.SecureSocket.sendChatState(clientSession.activeContact.fingerprint, 'inactive');
    delete clientSession.chatActive[clientSession.activeContact.fingerprint];
  }

  clientSession.activeContact = contact;

  // Load disappearing message config
  const storedConfig = localStorage.getItem(`chat_config_${contact.fingerprint}`);
  let burnTimer = null;
  if (storedConfig) {
    try {
      const parsed = JSON.parse(storedConfig);
      burnTimer = parsed.burnTimer;
    } catch(e) {}
  }
  clientSession.chatConfigs[contact.fingerprint] = { burnTimer };
  const selector = document.getElementById('disappearing-select');
  if (selector) {
    selector.value = burnTimer === null ? 'off' : burnTimer.toString();
  }

  // Send active state for the new contact unconditionally — the user
  // explicitly clicked this contact, so they are active in this chat.
  // Previously this was gated behind isChatActivelyViewed() which checks
  // document.hasFocus(), but the click event timing can cause hasFocus()
  // to return false at this exact moment, dropping the active state.
  window.SecureSocket.sendChatState(contact.fingerprint, 'active');

  // Mark messages as read
  markContactAsRead(contact.fingerprint);

  // Send read receipt to the contact
  window.SecureSocket.sendReadReceipt(contact.fingerprint);

  renderContactsList();

  document.getElementById('chat-recipient-title').textContent = contact.displayName || window.SecureCrypto.hashToName(contact.fingerprint);
  const formattedFp = formatFingerprint(contact.fingerprint);
  const subtitleEl = document.getElementById('chat-recipient-subtitle');
  subtitleEl.textContent = formattedFp;
  subtitleEl.style.cursor = 'pointer';
  subtitleEl.title = 'Click to copy full fingerprint';
  subtitleEl.onclick = () => {
    copyToClipboard(contact.fingerprint, 'Fingerprint copied to clipboard!');
  };

  // Populate header avatar
  const headerAvatar = document.getElementById('chat-header-avatar');
  if (headerAvatar) {
    headerAvatar.innerHTML = generateIdenticon(contact.fingerprint);
  }
  const isContactOnline = clientSession.presence[contact.fingerprint] === 'online';
  const headerDot = document.getElementById('chat-header-avatar-dot');
  if (headerDot) {
    headerDot.className = `chat-header-avatar-dot ${isContactOnline ? 'online' : 'offline'}`;
  }

  updateActiveChatPresence();

  const messagesBox = document.getElementById('chat-messages');
  messagesBox.innerHTML = getLoadingStateHTML();
  messagesBox.setAttribute('aria-busy', 'true');

  try {
    let bundle;
    if (contact.fingerprint === 'e00000000000000000000000000000000000000000000000000000000000000e') {
      const mockIdentityKeys = window.SecureCrypto.generateIdentityKeyPair();
      const mockPreKeys = window.SecureCrypto.generatePreKeyPair();
      const mockPreKeySignature = window.SecureCrypto.signPreKey(mockIdentityKeys.privateKey, mockPreKeys.publicKey);
      bundle = {
        public_identity_key: mockIdentityKeys.publicKey,
        public_prekey: mockPreKeys.publicKey,
        prekey_signature: mockPreKeySignature
      };
    } else {
      const res = await fetch(`${window.location.origin}/api/users/${contact.fingerprint}`);
      if (!res.ok) {
        if (res.status === 404) {
          // Account was shredded server-side. Flag it so the sidebar shows the
          // badge + offers Remove, instead of looking like a permanent ghost.
          clientSession.shredded[contact.fingerprint] = true;
          renderContactsList();
          throw new Error('This contact no longer exists. They may have deleted their account.');
        }
        throw new Error('Failed to resolve contact public keys');
      }
      bundle = await res.json();
    }

    const isSignatureOk = await window.SecureCrypto.verifySignature(
      bundle.prekey_signature,
      bundle.public_prekey,
      bundle.public_identity_key
    );

    if (!isSignatureOk) {
      throw new Error('Handshake verification failed: Corrupted/Untrusted Prekey Signature');
    }

    clientSession.activeSessionKey = window.SecureCrypto.deriveSessionKey(
      clientSession.preKeyPrivateKey,
      bundle.public_prekey
    );

    console.log('✅ Session key successfully derived for:', contact.fingerprint);

    document.getElementById('message-field').removeAttribute('disabled');
    document.getElementById('send-msg-btn').removeAttribute('disabled');

    await fetchOfflineMessages();
    await fetchPendingChatEvents();
    await fetchPendingReadReceipts();
    renderActiveChatMessages();

  } catch (err) {
    console.error('Key handshake failed:', err);
    messagesBox.innerHTML = getErrorStateHTML(err.message);
    document.getElementById('message-field').setAttribute('disabled', 'true');
    document.getElementById('send-msg-btn').setAttribute('disabled', 'true');
  }
}

function markContactAsRead(fingerprint) {
  const historyKey = `history_${fingerprint}`;
  const readKey = `read_count_${fingerprint}`;
  const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
  
  let updated = false;
  history.forEach(m => {
    if (m.sender !== clientSession.identityKeyHash && m.sender !== 'system' && !m.readTimestamp) {
      m.readTimestamp = Date.now();
      updated = true;
    }
  });
  if (updated) {
    localStorage.setItem(historyKey, JSON.stringify(history));
  }

  const receivedMessages = history.filter(m => m.sender !== clientSession.identityKeyHash && m.sender !== 'system');
  localStorage.setItem(readKey, receivedMessages.length.toString());
  clientSession.unreadCounts[fingerprint] = 0;
}

/**
 * Update the active chat header with presence/chat-state info
 */
function updateActiveChatPresence() {
  if (!clientSession.activeContact) return;

  const fp = clientSession.activeContact.fingerprint;
  const isOnline = clientSession.presence[fp] === 'online';
  const isActive = clientSession.chatActive[fp];
  const isTyping = clientSession.typing[fp];
  const subtitleEl = document.getElementById('chat-recipient-subtitle');
  const headerDot = document.getElementById('chat-header-avatar-dot');

  if (!subtitleEl) return;

  // Build segmented fingerprint (blocks of 8) as the base subtitle text
  const formattedFp = formatFingerprint(fp);
  let statusHtml = `<span class="chat-hash-text" style="cursor:pointer;" title="Click to copy fingerprint" onclick="copyToClipboard('${fp}','Fingerprint copied!');">${formattedFp}</span>`;

  // Typing indicator takes priority over presence tags
  if (isTyping) {
    statusHtml += ` <span class="header-typing">typing<span class="header-typing-dots"><span></span><span></span><span></span></span></span>`;
  } else if (isActive) {
    statusHtml += ' <span class="presence-tag active-in-chat"><span class="tag-dot"></span>Active in chat</span>';
  } else if (isOnline) {
    statusHtml += ' <span class="presence-tag online"><span class="tag-dot"></span>Online</span>';
  }

  subtitleEl.innerHTML = statusHtml;

  // Update header avatar presence dot
  if (headerDot) {
    headerDot.className = `chat-header-avatar-dot ${isOnline ? 'online' : 'offline'}`;
  }
}

/**
 * 5. Fetch & Decrypt Offline Queued Messages
 *
 * Fetches ALL undelivered messages from the server's offline queue and
 * decrypts each one with the correct per-sender session key.  Previously
 * this function used a single `activeSessionKey` for every message, which
 * silently dropped (and deleted) messages from any contact that was not
 * the currently selected one — making one-way contact adds impossible.
 *
 * Now it groups messages by sender, fetches each sender's prekey bundle,
 * derives the matching ECDH session key, and decrypts.  Contacts are
 * auto-added when a message arrives from an unknown sender, mirroring the
 * real-time `handleIncomingE2eeMessage` background path.
 */
async function fetchOfflineMessages() {
  if (!clientSession.identityPrivateKey) return;

  const timestamp = new Date().toISOString();
  const path = '/api/chat/messages';
  const signature = window.SecureCrypto.signRequest(
    clientSession.identityPrivateKey,
    'GET',
    path,
    timestamp,
    ''
  );

  try {
    const response = await fetch(`${window.location.origin}${path}`, {
      method: 'GET',
      headers: {
        'X-Identity-Key': clientSession.identityPublicKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp
      }
    });

    if (!response.ok) throw new Error('Failed to retrieve queue');

    const data = await response.json();

    // Cache sender prekey bundles so we only fetch each sender once.
    const sessionKeyCache = {}; // sender_hash -> Uint8Array

    for (const msg of data.messages) {
      // Resolve (or reuse) the per-sender session key.
      let sessionKey = sessionKeyCache[msg.sender_hash];

      // Fast path: if this message is from the active contact, the
      // activeSessionKey is already derived and verified.
      if (!sessionKey &&
          clientSession.activeContact &&
          msg.sender_hash === clientSession.activeContact.fingerprint &&
          clientSession.activeSessionKey) {
        sessionKey = clientSession.activeSessionKey;
        sessionKeyCache[msg.sender_hash] = sessionKey;
      }

      // Slow path: fetch the sender's prekey bundle and derive the key.
      if (!sessionKey) {
        try {
          const res = await fetch(`${window.location.origin}/api/users/${msg.sender_hash}`);
          if (!res.ok) {
            console.warn(`Skipping offline message: sender ${msg.sender_hash.substring(0, 8)}… not found on server`);
            continue;
          }
          const bundle = await res.json();
          sessionKey = window.SecureCrypto.deriveSessionKey(
            clientSession.preKeyPrivateKey,
            bundle.public_prekey
          );
          sessionKeyCache[msg.sender_hash] = sessionKey;
        } catch (err) {
          console.warn(`Failed to derive key for offline message from ${msg.sender_hash.substring(0, 8)}…`, err);
          continue;
        }
      }

      // decrypt() throws on a corrupt/wrong-key message. The server already
      // DELETEd the whole queue, so a dropped message here is simply lost —
      // it was undecryptable garbage anyway. Skip it and keep processing the
      // rest of the batch; never persist an error string as a fake bubble.
      let decryptedText;
      try {
        decryptedText = window.SecureCrypto.decrypt(
          msg.ciphertext,
          msg.nonce,
          sessionKey
        );
      } catch (err) {
        console.warn(`Skipping undecryptable offline message ${msg.id || '(no id)'}`);
        continue;
      }

      let isImage = false;
      let parsedPayload = null;
      try {
        parsedPayload = JSON.parse(decryptedText);
      } catch(e) {}

      // Profile-update frames are control messages, not chat bubbles.
      if (parsedPayload && parsedPayload.type === 'profile_update' && parsedPayload.displayName) {
        applyContactProfileUpdate(msg.sender_hash, parsedPayload.displayName);
        continue;
      }

      if (parsedPayload && parsedPayload.type === 'image') {
        isImage = true;
      }

      saveMessageToStorage(msg.sender_hash, msg.sender_hash, decryptedText, msg.created_at, isImage);

      // Auto-add contact if not already in the list (mirrors the real-time
      // background-message handler so one-way adds work for offline queue too).
      if (!clientSession.contacts.some(c => c.fingerprint === msg.sender_hash)) {
        clientSession.contacts.push({ fingerprint: msg.sender_hash, addedAt: Date.now() });
        localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
        // Re-subscribe to presence so we can see this new contact's online/offline
        // status. Without this, the green dot only appears for contacts we added
        // ourselves before login — auto-added contacts from one-way adds never
        // get a presence subscription, so we never see their green dot.
        subscribeToContactPresence();
      }

      // Increment unread count for background (non-active) senders.
      if (!clientSession.activeContact || msg.sender_hash !== clientSession.activeContact.fingerprint) {
        clientSession.unreadCounts[msg.sender_hash] = (clientSession.unreadCounts[msg.sender_hash] || 0) + 1;
      }
    }

    // Re-render if any messages were processed.
    if (data.messages.length > 0) {
      if (clientSession.activeContact) {
        renderActiveChatMessages();
      }
      renderContactsList();
    }

  } catch (err) {
    console.error('Error fetching offline messages:', err);
  }
}

/**
 * 5b. Fetch & Apply Pending Chat Events (config changes & clear-chat)
 *
 * Retrieves control events that were persisted on the server while we were
 * offline.  Without this, disappearing-timer changes and clear-chat
 * requests from the other person were silently lost whenever our
 * WebSocket was disconnected (offline, tab hidden, etc.).
 */
async function fetchPendingChatEvents() {
  if (!clientSession.identityPrivateKey) return;

  const timestamp = new Date().toISOString();
  const path = '/api/chat/events';
  const signature = window.SecureCrypto.signRequest(
    clientSession.identityPrivateKey,
    'GET',
    path,
    timestamp,
    ''
  );

  try {
    const response = await fetch(`${window.location.origin}${path}`, {
      method: 'GET',
      headers: {
        'X-Identity-Key': clientSession.identityPublicKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp
      }
    });

    if (!response.ok) throw new Error('Failed to retrieve chat events');

    const data = await response.json();

    for (const evt of data.events) {
      if (evt.event_type === 'chat_config') {
        // Apply the timer change exactly as the real-time handler does.
        const prevConfig = clientSession.chatConfigs[evt.sender_hash];
        const prevTimer = prevConfig ? prevConfig.burnTimer : undefined;
        const burnTimer = evt.burn_timer;

        clientSession.chatConfigs[evt.sender_hash] = { burnTimer };
        localStorage.setItem(`chat_config_${evt.sender_hash}`, JSON.stringify({ burnTimer }));

        // Update dropdown UI if this is the active contact
        if (clientSession.activeContact && clientSession.activeContact.fingerprint === evt.sender_hash) {
          const selector = document.getElementById('disappearing-select');
          if (selector) {
            selector.value = burnTimer === null ? 'off' : burnTimer.toString();
          }
        }

        if (prevTimer !== burnTimer) {
          const timerText = getBurnTimerText(burnTimer);
          const contactName = clientSession.contacts.find(c => c.fingerprint === evt.sender_hash)?.displayName
            || window.SecureCrypto.hashToName(evt.sender_hash);
          saveMessageToStorage(evt.sender_hash, 'system', `Disappearing messages set to ${timerText} by ${contactName}`, new Date().toISOString());
          showToast(`${contactName} set disappearing messages to ${timerText}`, 'info', 5000);
        }
      } else if (evt.event_type === 'clear_chat') {
        // Apply the clear-chat exactly as the real-time handler does.
        handleClearChatReceived(evt.sender_hash);
      }
    }

    if (data.events.length > 0) {
      if (clientSession.activeContact) {
        renderActiveChatMessages();
      }
      renderContactsList();
    }

  } catch (err) {
    console.error('Error fetching pending chat events:', err);
  }
}

/**
 * 5c. Fetch & Apply Pending Read Receipts
 *
 * Retrieves read receipts that were persisted on the server while we were
 * offline. Without this, the double-tick (✓✓) was lost whenever we were
 * offline when the recipient read our messages.
 */
async function fetchPendingReadReceipts() {
  if (!clientSession.identityPrivateKey) return;

  const timestamp = new Date().toISOString();
  const path = '/api/chat/read-receipts';
  const signature = window.SecureCrypto.signRequest(
    clientSession.identityPrivateKey,
    'GET',
    path,
    timestamp,
    ''
  );

  try {
    const response = await fetch(`${window.location.origin}${path}`, {
      method: 'GET',
      headers: {
        'X-Identity-Key': clientSession.identityPublicKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp
      }
    });

    if (!response.ok) throw new Error('Failed to retrieve read receipts');

    const data = await response.json();

    for (const receipt of data.receipts) {
      // Apply the read receipt exactly as the real-time handler does.
      const readTime = new Date(receipt.created_at).getTime() || Date.now();
      clientSession.readReceipts[receipt.sender_hash] = readTime;

      const historyKey = `history_${receipt.sender_hash}`;
      const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
      let updated = false;
      history.forEach(m => {
        if (m.sender === clientSession.identityKeyHash && !m.readTimestamp) {
          const msgTime = new Date(m.timestamp).getTime();
          if (msgTime <= readTime) {
            m.readTimestamp = readTime;
            updated = true;
          }
        }
      });
      if (updated) {
        localStorage.setItem(historyKey, JSON.stringify(history));
      }
    }

    if (data.receipts.length > 0) {
      renderActiveChatMessages();
    }

  } catch (err) {
    console.error('Error fetching pending read receipts:', err);
  }
}

/**
 * 6. Send E2EE Message
 */
async function handleSendE2eeMessage() {
  const inputEl = document.getElementById('message-field');
  const plainText = inputEl.value.trim();

  if (!plainText || !clientSession.activeContact || !clientSession.activeSessionKey) {
    return;
  }

  haptic(10);
  const sendBtn = document.getElementById('send-msg-btn');
  const restoreBtn = setButtonLoading(sendBtn, 'Sending…');

  const recipientHash = clientSession.activeContact.fingerprint;

  // Stop typing indicator
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    clearTimeout(typingTimeout);
    window.SecureSocket.sendTyping(recipientHash, false);
  }

  // Intercept Mock Demo Bot
  if (recipientHash === 'e00000000000000000000000000000000000000000000000000000000000000e') {
    saveMessageToStorage(recipientHash, clientSession.identityKeyHash, plainText, new Date().toISOString());
    renderActiveChatMessages();
    inputEl.value = '';

    showTypingAvatar(recipientHash);

    setTimeout(() => {
      const botReplies = [
        "Hello! I am your local zero-knowledge testing bot.",
        "This message was encrypted using standard XChaCha20-Poly1305 and decrypted locally in your browser sandbox.",
        "No database or network server is required for this demo flow. Pretty secure, isn't it?",
        "Toggle the B&W theme button at the top to see the theme change instantly!",
        "Feel free to type more test messages to explore the E2EE interface!"
      ];
      const randomReply = botReplies[Math.floor(Math.random() * botReplies.length)];
      saveMessageToStorage(recipientHash, recipientHash, randomReply, new Date().toISOString());
      renderActiveChatMessages();

      const indicator = document.querySelector(`.typing-indicator[data-from="${recipientHash}"]`);
      if (indicator) fadeOutTypingIndicator(indicator);
    }, 1200);
    return;
  }

  const encrypted = window.SecureCrypto.encrypt(plainText, clientSession.activeSessionKey);
  inputEl.value = '';

  // Capture one timestamp used for both storage and delivery matching.
  const sentTimestamp = new Date().toISOString();

  const result = await window.SecureSocket.sendMessage(
    recipientHash,
    encrypted.ciphertext,
    encrypted.nonce,
    clientSession.identityPublicKey,
    clientSession.identityPrivateKey
  );

  if (result.success) {
    // Initial status: 'sent' (offline/queued) or 'delivered' (online/realtime).
    // The authoritative status arrives via the 'delivered' frame for the WS path.
    const initialStatus = result.status === 'sent' ? 'sent'
      : (result.status === 'queued' ? 'sent' : 'delivered');
    const msgId = result.message_id || null;
    saveMessageToStorage(recipientHash, clientSession.identityKeyHash, plainText, sentTimestamp, false, initialStatus, msgId);
    // Track the latest pending delivery so the 'delivered' frame can upgrade it.
    clientSession.pendingDelivery[recipientHash] = sentTimestamp;
    renderActiveChatMessages();
    renderContactsList(); // Update preview
  } else {
    showToast(`Failed to send message: ${result.error}`, 'error', 6000);
  }
  restoreBtn();
}

/**
 * 7. Process Incoming E2EE Real-time Socket Message
 */
async function handleIncomingE2eeMessage(msg) {
  if (clientSession.activeContact && msg.sender_hash === clientSession.activeContact.fingerprint) {
    // decrypt() throws on a bad ciphertext — skip silently, don't crash the
    // realtime handler or persist an error string as a fake bubble.
    let decryptedText;
    try {
      decryptedText = window.SecureCrypto.decrypt(
        msg.ciphertext,
        msg.nonce,
        clientSession.activeSessionKey
      );
    } catch (err) {
      console.warn(`Skipping undecryptable realtime message from ${msg.sender_hash}`);
      return;
    }

    let isImage = false;
    let parsedPayload = null;
    try {
      parsedPayload = JSON.parse(decryptedText);
    } catch(e) {}

    // ── Profile Update Frame ────────────────────────────────────────
    if (parsedPayload && parsedPayload.type === 'profile_update' && parsedPayload.displayName) {
      applyContactProfileUpdate(msg.sender_hash, parsedPayload.displayName);
      return; // Don't persist profile frames as chat messages
    }

    if (parsedPayload && parsedPayload.type === 'image') {
      isImage = true;
    }

    saveMessageToStorage(msg.sender_hash, msg.sender_hash, decryptedText, msg.created_at, isImage);
    renderActiveChatMessages();

    // STRICT READ: only send receipt if tab is visible AND focused on this chat
    if (isChatActivelyViewed(msg.sender_hash)) {
      window.SecureSocket.sendReadReceipt(msg.sender_hash);
      markContactAsRead(msg.sender_hash);
    }
  } else {
    // Background message from another contact
    try {
      const res = await fetch(`${window.location.origin}/api/users/${msg.sender_hash}`);
      if (res.ok) {
        const bundle = await res.json();
        const contactSessionKey = window.SecureCrypto.deriveSessionKey(
          clientSession.preKeyPrivateKey,
          bundle.public_prekey
        );

        const decryptedText = window.SecureCrypto.decrypt(
          msg.ciphertext,
          msg.nonce,
          contactSessionKey
        );

        let isImage = false;
        let parsedBg = null;
        try {
          parsedBg = JSON.parse(decryptedText);
        } catch(e) {}

        // ── Profile Update Frame ────────────────────────────────────────
        if (parsedBg && parsedBg.type === 'profile_update' && parsedBg.displayName) {
          applyContactProfileUpdate(msg.sender_hash, parsedBg.displayName);
          return; // Don't persist profile frames as chat messages
        }

        if (parsedBg && parsedBg.type === 'image') {
          isImage = true;
        }

        saveMessageToStorage(msg.sender_hash, msg.sender_hash, decryptedText, msg.created_at, isImage);

        // Auto-add contact if not exists
        if (!clientSession.contacts.some(c => c.fingerprint === msg.sender_hash)) {
          clientSession.contacts.push({ fingerprint: msg.sender_hash, addedAt: Date.now() });
          localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
          // Re-subscribe to presence so we can see this new contact's
          // online/offline status (green dot).
          subscribeToContactPresence();
        }

        // Increment unread count
        clientSession.unreadCounts[msg.sender_hash] = (clientSession.unreadCounts[msg.sender_hash] || 0) + 1;
        renderContactsList();

        // Desktop notification + chime
        const displayBody = isImage ? 'Image' : decryptedText;
        triggerBackgroundNotification(msg.sender_hash, displayBody);
      }
    } catch (err) {
      console.error('Failed to decrypt background message:', err);
    }
  }
}

/**
 * Background Notification (Desktop + Audio)
 */
function triggerBackgroundNotification(senderHash, text) {
  // Play synthesized chime
  playNotificationChime();

  // Desktop notification if window is blurred
  if (!isWindowFocused && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(`New message from User ${senderHash.substring(0, 8)}`, {
      body: text.length > 80 ? text.substring(0, 80) + '…' : text,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="18" font-size="18">🔒</text></svg>',
      tag: `blindsession-${senderHash}`
    });

    notification.onclick = () => {
      window.focus();
      const contact = clientSession.contacts.find(c => c.fingerprint === senderHash);
      if (contact) handleSelectContact(contact);
    };

    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  }
}

/**
 * Chat Storage helper
 */
function saveMessageToStorage(conversationHash, senderHash, text, timestamp, isImage = false, status = null, messageId = null) {
  const historyKey = `history_${conversationHash}`;
  const history = JSON.parse(localStorage.getItem(historyKey) || '[]');

  // Apply burnTimer from active chat config if message is NOT a system message
  const burnTimer = senderHash !== 'system' ? (clientSession.chatConfigs[conversationHash]?.burnTimer || null) : null;

  // Only stamp readTimestamp if the user is actively viewing this conversation
  const isReceived = senderHash !== clientSession.identityKeyHash && senderHash !== 'system';
  const readTimestamp = (isReceived && isChatActivelyViewed(conversationHash)) ? Date.now() : null;

  // Delivery status applies only to MY sent messages. 'read' takes priority
  // and is derived from readTimestamp at render time, so we don't store it.
  const isSent = senderHash === clientSession.identityKeyHash;
  const storedStatus = isSent ? (status || 'sent') : null;

  history.push({
    sender: senderHash,
    text: text,
    timestamp: timestamp,
    isImage: isImage,
    burnTimer: burnTimer,
    readTimestamp: readTimestamp,
    status: storedStatus,
    messageId: messageId
  });

  localStorage.setItem(historyKey, JSON.stringify(history));
}

/**
 * Upgrade the delivery status of a sent message to a contact.
 * Called from the 'delivered' WS frame: status 'realtime' → 'delivered',
 * 'queued' → 'sent' (offline, single gray tick). Never downgrades a message
 * that has already been read.
 *
 * Uses messageId for correlation when available (solves rapid-send race).
 * Falls back to pendingDelivery timestamp for older clients.
 */
function updateSentMessageStatus(recipientHash, status, messageId) {
  const historyKey = `history_${recipientHash}`;
  const history = JSON.parse(localStorage.getItem(historyKey) || '[]');

  let updated = false;
  const pendingTs = clientSession.pendingDelivery[recipientHash];

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.sender !== clientSession.identityKeyHash) continue;

    // Match by messageId if available, otherwise by pending timestamp,
    // otherwise upgrade the most recent sent message.
    let matches = false;
    if (messageId && m.messageId === messageId) {
      matches = true;
    } else if (!messageId && pendingTs && m.timestamp === pendingTs) {
      matches = true;
    } else if (!messageId && !pendingTs) {
      matches = true; // fallback: most recent
    }

    if (matches) {
      if (!m.readTimestamp && (status === 'delivered' || status === 'sent')) {
        // Only upgrade: sent → delivered; never downgrade delivered → sent,
        // and never touch a read message.
        if (status === 'delivered' || m.status !== 'delivered') {
          m.status = status;
          updated = true;
        }
      }
      break;
    }
  }

  if (updated) {
    localStorage.setItem(historyKey, JSON.stringify(history));
    // Clear pending delivery only if this was the pending message
    if (!messageId || (pendingTs && history.find(m => m.messageId === messageId && m.timestamp === pendingTs))) {
      delete clientSession.pendingDelivery[recipientHash];
    }
    renderActiveChatMessages();
  }
}

function renderActiveChatMessages() {
  if (!clientSession.activeContact) return;

  const messagesBox = document.getElementById('chat-messages');
  messagesBox.innerHTML = '';
  messagesBox.removeAttribute('aria-busy');

  const fp = clientSession.activeContact.fingerprint;
  const historyKey = `history_${fp}`;
  const history = JSON.parse(localStorage.getItem(historyKey) || '[]');

  if (history.length === 0) {
    messagesBox.innerHTML = '<div style="color:var(--text-secondary); text-align:center; margin:auto; font-size:0.88rem; opacity:0.6;">No message history yet. Write a message below to start a secure session.</div>';
    return;
  }

  // NOTE: read receipts are now per-message (stored as msg.readTimestamp).
  // We no longer use a global hasReadReceipt flag because it caused all
  // sent messages to show ✓✓ after any read receipt, even new ones.

  // First, filter out messages that are already expired.
  let expiredFound = false;
  const validHistory = [];

  history.forEach((msg) => {
    if (msg.burnTimer && msg.readTimestamp) {
      const remaining = msg.burnTimer - Math.floor((Date.now() - msg.readTimestamp) / 1000);
      if (remaining <= 0) {
        expiredFound = true;
        return; // skip expired
      }
    }
    validHistory.push(msg);
  });

  if (expiredFound) {
    localStorage.setItem(historyKey, JSON.stringify(validHistory));
  }

  if (validHistory.length === 0) {
    messagesBox.innerHTML = '<div style="color:var(--text-secondary); text-align:center; margin:auto; font-size:0.88rem; opacity:0.6;">All messages have expired. Write a new message to continue.</div>';
    return;
  }

  // Unread divider: find the index of the first unread received message
  const readKey = `read_count_${fp}`;
  const readCount = parseInt(localStorage.getItem(readKey) || '0', 10);
  let receivedMsgIndex = 0;
  let unreadDividerInserted = false;

  validHistory.forEach((msg, index) => {
    if (msg.sender === 'system') {
      const systemEl = document.createElement('div');
      systemEl.className = 'message-system';
      systemEl.style = 'align-self: center; background: rgba(255,255,255,0.03); color: var(--text-secondary); padding: 0.4rem 1rem; border-radius: 20px; font-size: 0.8rem; border: 1px solid rgba(255,255,255,0.05); margin: 0.5rem 0; text-align: center;';
      systemEl.textContent = msg.text;
      messagesBox.appendChild(systemEl);
      return;
    }

    // Track received message index for unread divider
    const isReceived = msg.sender !== clientSession.identityKeyHash;
    if (isReceived) {
      if (receivedMsgIndex === readCount && !unreadDividerInserted && readCount > 0) {
        // Insert "Unread messages" divider before the first unread message
        const divider = document.createElement('div');
        divider.className = 'unread-divider';
        divider.innerHTML = '<span class="unread-divider-text">Unread messages</span>';
        messagesBox.appendChild(divider);
        unreadDividerInserted = true;
      }
      receivedMsgIndex++;
    }

    // ── Date separator ─────────────────────────────────
    // Insert a divider when the calendar day changes between messages.
    const msgDate = new Date(msg.timestamp);
    const prevMsg = validHistory[index - 1];
    const prevDate = prevMsg ? new Date(prevMsg.timestamp) : null;
    if (!prevDate || msgDate.toDateString() !== prevDate.toDateString()) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);
      let label;
      if (msgDate.toDateString() === today.toDateString()) {
        label = 'Today';
      } else if (msgDate.toDateString() === yesterday.toDateString()) {
        label = 'Yesterday';
      } else {
        label = msgDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }
      divider.innerHTML = `<span class="date-divider-text">${label}</span>`;
      messagesBox.appendChild(divider);
    }

    const isSent = msg.sender === clientSession.identityKeyHash;
    const msgEl = document.createElement('div');
    msgEl.className = `message ${isSent ? 'sent' : 'received'}`;
    msgEl.setAttribute('tabindex', '0');
    msgEl.setAttribute('role', 'article');

    // Store message data for context menu (copy / delete)
    msgEl.dataset.msgText = msg.isImage ? '' : (msg.text || '');
    msgEl.dataset.msgTimestamp = msg.timestamp;
    msgEl.dataset.msgIsImage = msg.isImage ? 'true' : 'false';
    msgEl.dataset.msgSender = msg.sender;

    // Assign ID to element for timer tracking
    const messageId = `msg-${fp.substring(0, 6)}-${index}-${msg.timestamp}`;
    msgEl.id = messageId;

    // Fire the entrance animation only for messages added since the last render
    const prevCount = lastRenderedMsgCount[fp] ?? 0;
    if (index >= prevCount && msg.sender !== 'system') {
      msgEl.classList.add('new-bubble');
    }

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Sent-message ticks (3 states):
    //   read      → blue ✓✓   (recipient read it — per-message, not per-contact)
    //   delivered → blue ✓    (recipient was online or pulled from queue)
    //   sent      → gray ✓    (recipient offline, message queued / awaiting)
    let receiptIcon = '';
    if (isSent) {
      const isRead = !!msg.readTimestamp;
      if (isRead) {
        receiptIcon = '<span class="read-receipt">✓✓</span>';
      } else if (msg.status === 'delivered') {
        receiptIcon = '<span class="delivered-check">✓</span>';
      } else {
        receiptIcon = '<span class="sent-check">✓</span>';
      }
    }

    // Render either image or decrypted text
    let messageContentHtml = '';
    if (msg.isImage) {
      let dataUrl = msg.text;
      try {
        const parsed = JSON.parse(msg.text);
        if (parsed && parsed.type === 'image') {
          dataUrl = parsed.dataUrl;
        }
      } catch(e) {}
      // Use a data attribute + event delegation instead of inline onclick
      // because the data URL can contain characters that break inline JS.
      messageContentHtml = `<img src="${escapeHTML(dataUrl)}" class="chat-image-preview" data-full="${escapeHTML(dataUrl)}" style="max-width: 100%; max-height: 250px; border-radius: 8px; display: block; border: 1px solid rgba(255,255,255,0.1); cursor: zoom-in;" />`;
    } else {
      let plainText = msg.text;
      try {
        const parsed = JSON.parse(msg.text);
        if (parsed && parsed.type === 'image') {
          plainText = '[Image]';
        }
      } catch(e) {}
      messageContentHtml = `<div>${escapeHTML(plainText)}</div>`;
    }

    // Visual disappearing-message timer:
    //  - ticking hourglass + live seconds counter in a clean badge
    //  - shrinking progress bar pinned to the bottom of the bubble
    //  - pixel-dissolve evaporation when the timer hits zero
    let burnBadgeHtml = '';
    let burnBarHtml = '';
    if (msg.burnTimer && msg.readTimestamp) {
      const remaining = msg.burnTimer - Math.floor((Date.now() - msg.readTimestamp) / 1000);
      const pct = Math.max(0, Math.min(100, (remaining / msg.burnTimer) * 100));
      const urgent = remaining <= Math.max(3, Math.ceil(msg.burnTimer * 0.2));
      // Mark the bubble so it reserves room for the burn bar + clips it
      msgEl.classList.add('has-burn');
      burnBadgeHtml = `
        <span class="burn-badge${urgent ? ' urgent' : ''}">
          <span class="burn-hourglass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M6 2v6a6 6 0 0 0 6 6 6 6 0 0 0 6-6V2M6 22v-6a6 6 0 0 1 6-6 6 6 0 0 1 6 6v6"/></svg></span>
          <span class="burn-seconds-active">${formatBurnCountdown(remaining)}</span>
        </span>`;
      burnBarHtml = `
        <span class="burn-bar">
          <span class="burn-bar-fill${urgent ? ' urgent' : ''}" style="width:${pct}%;"></span>
        </span>`;

      // Live countdown: shrink the bar, tick the hourglass, dissolve on expiry
      const intervalId = setInterval(() => {
        const el = document.getElementById(messageId);
        if (!el) {
          clearInterval(intervalId);
          return;
        }
        const currentRemaining = msg.burnTimer - Math.floor((Date.now() - msg.readTimestamp) / 1000);
        const secEl = el.querySelector('.burn-seconds-active');
        const barEl = el.querySelector('.burn-bar-fill');
        const badgeEl = el.querySelector('.burn-badge');
        if (secEl) {
          if (currentRemaining > 0) {
            secEl.textContent = formatBurnCountdown(currentRemaining);
            if (barEl) {
              const curPct = Math.max(0, Math.min(100, (currentRemaining / msg.burnTimer) * 100));
              barEl.style.width = curPct + '%';
              // Switch to urgent styling in the final ~20% of the countdown
              if (currentRemaining <= Math.max(3, Math.ceil(msg.burnTimer * 0.2))) {
                barEl.classList.add('urgent');
                if (badgeEl) badgeEl.classList.add('urgent');
              }
            }
          } else {
            clearInterval(intervalId);
            // Pixel-dissolve evaporation before DOM removal
            el.classList.add('dissolving');
            setTimeout(() => {
              el.remove();
              // Remove from storage
              const currentHistory = JSON.parse(localStorage.getItem(historyKey) || '[]');
              const filtered = currentHistory.filter(h => h.timestamp !== msg.timestamp || h.text !== msg.text);
              localStorage.setItem(historyKey, JSON.stringify(filtered));
              renderContactsList();
            }, 700); // matches particle-dissolve duration
          }
        }
      }, 1000);
    } else if (msg.burnTimer) {
      // Burn timer is configured but message not read yet — idle hint
      burnBadgeHtml = `
        <span class="burn-badge idle">
          <span class="burn-hourglass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M6 2v6a6 6 0 0 0 6 6 6 6 0 0 0 6-6V2M6 22v-6a6 6 0 0 1 6-6 6 6 0 0 1 6 6v6"/></svg></span>
          <span class="burn-seconds-idle">${getBurnTimerText(msg.burnTimer)}</span>
        </span>`;
    }

    msgEl.innerHTML = `
      ${messageContentHtml}
      <div class="message-meta">
        ${burnBadgeHtml}
        <span class="message-time-text">${timeStr}</span>
        ${receiptIcon}
      </div>
      ${burnBarHtml}
    `;

    messagesBox.appendChild(msgEl);
  });

  // Record how many messages were rendered so the next render only animates
  // the ones that are genuinely new (e.g. a freshly arrived message).
  lastRenderedMsgCount[fp] = validHistory.length;

  // Preserve scroll position if user scrolled up; otherwise stick to bottom.
  // The scroll-to-bottom button visibility is handled by the scroll listener.
  if (!_userScrolledUp) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
  updateScrollBottomBadge();
}

// ─── Scroll-to-bottom button logic ──────────────────
// Tracks whether the user has scrolled up from the bottom of the chat
// messages container, and shows/hides the scroll-to-bottom button with
// an unread count badge.
let _userScrolledUp = false;

document.addEventListener('DOMContentLoaded', () => {
  const messagesBox = document.getElementById('chat-messages');
  const scrollBtn = document.getElementById('scroll-bottom-btn');
  if (!messagesBox || !scrollBtn) return;

  messagesBox.addEventListener('scroll', () => {
    const atBottom = messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 80;
    _userScrolledUp = !atBottom;
    if (atBottom) {
      scrollBtn.classList.add('hidden');
      const badge = document.getElementById('scroll-bottom-badge');
      if (badge) { badge.classList.add('hidden'); badge.textContent = '0'; }
    } else {
      scrollBtn.classList.remove('hidden');
    }
  });

  scrollBtn.addEventListener('click', () => {
    messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: 'smooth' });
    _userScrolledUp = false;
    scrollBtn.classList.add('hidden');
    const badge = document.getElementById('scroll-bottom-badge');
    if (badge) { badge.classList.add('hidden'); badge.textContent = '0'; }
    // Mark messages as read since we jumped to bottom
    if (clientSession.activeContact) {
      const fp = clientSession.activeContact.fingerprint;
      const historyKey = `history_${fp}`;
      const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
      const receivedMessages = history.filter(m => m.sender !== clientSession.identityKeyHash);
      localStorage.setItem(`read_count_${fp}`, receivedMessages.length);
      clientSession.unreadCounts[fp] = 0;
      renderContactsList();
    }
  });
});

function updateScrollBottomBadge() {
  if (!clientSession.activeContact) return;
  const badge = document.getElementById('scroll-bottom-badge');
  if (!badge) return;
  const fp = clientSession.activeContact.fingerprint;
  const unread = clientSession.unreadCounts[fp] || 0;
  if (_userScrolledUp && unread > 0) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── Message context menu (copy / delete) ──────────
let _activeContextMenu = null;

function closeMessageContextMenu() {
  if (_activeContextMenu) {
    _activeContextMenu.remove();
    _activeContextMenu = null;
  }
  document.removeEventListener('click', closeMessageContextMenu);
  document.removeEventListener('keydown', onContextMenuEscape);
}

function onContextMenuEscape(e) {
  if (e.key === 'Escape') closeMessageContextMenu();
}

function openMessageContextMenu(msgEl, clientX, clientY) {
  closeMessageContextMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';
  const isImage = msgEl.dataset.msgIsImage === 'true';
  const text = msgEl.dataset.msgText || '';
  const timestamp = msgEl.dataset.msgTimestamp;
  const sender = msgEl.dataset.msgSender;
  const isSent = sender === clientSession.identityKeyHash;

  const copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const delSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const forwardSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>';

  let buttonsHtml = '';
  if (!isImage && text) {
    buttonsHtml += `<button data-action="copy">${copySvg}Copy text</button>`;
  }
  if (!isImage && text && clientSession.contacts.length > 1) {
    buttonsHtml += `<button data-action="forward">${forwardSvg}Forward</button>`;
  }
  if (isSent) {
    buttonsHtml += `<button data-action="delete" class="danger">${delSvg}Delete</button>`;
  }
  if (!buttonsHtml) return; // nothing to show

  menu.innerHTML = buttonsHtml;
  document.body.appendChild(menu);

  // Position — keep within viewport
  const rect = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  _activeContextMenu = menu;

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      copyToClipboard(text, 'Message copied to clipboard!');
    } else if (action === 'delete') {
      deleteMessage(timestamp, text);
    } else if (action === 'forward') {
      showForwardDialog(text);
    }
    closeMessageContextMenu();
  });

  // Close on outside click or Escape
  setTimeout(() => {
    document.addEventListener('click', closeMessageContextMenu);
    document.addEventListener('keydown', onContextMenuEscape);
  }, 0);
}

function deleteMessage(timestamp, text) {
  if (!clientSession.activeContact) return;
  const fp = clientSession.activeContact.fingerprint;
  const historyKey = `history_${fp}`;
  const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
  const filtered = history.filter(h => h.timestamp !== timestamp || h.text !== text);
  localStorage.setItem(historyKey, JSON.stringify(filtered));
  renderActiveChatMessages();
  renderContactsList();
  showToast('Message deleted.', 'info', 2000);
}

// ─── Forward message to another contact ───────────
let _forwardClose = null;

function showForwardDialog(text) {
  const existing = document.getElementById('forward-modal');
  if (existing) existing.remove();
  if (_forwardClose) { _forwardClose(); _forwardClose = null; }

  const modal = document.createElement('div');
  modal.id = 'forward-modal';
  modal.className = 'image-preview-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Forward message');

  const contactsHtml = clientSession.contacts
    .filter(c => c.fingerprint !== clientSession.activeContact?.fingerprint)
    .map(c => {
      const name = c.displayName || window.SecureCrypto.hashToName(c.fingerprint);
      const shortFp = c.fingerprint.substring(0, 12) + '...';
      return `<button data-fp="${c.fingerprint}" class="forward-contact-btn">${escapeHTML(name)} <span style="color:var(--text-tertiary);font-size:var(--fs-xs);">${shortFp}</span></button>`;
    }).join('');

  modal.innerHTML = `
    <div class="image-preview-card" style="max-width:380px;">
      <h3 style="margin:0 0 0.75rem;font-size:var(--fs-lg);font-weight:var(--fw-semibold);">Forward to...</h3>
      <div style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:1rem;">
        ${contactsHtml || '<p style="color:var(--text-secondary);font-size:var(--fs-sm);">No other contacts available.</p>'}
      </div>
      <div class="image-preview-actions">
        <button type="button" class="image-preview-cancel" id="forward-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const lastFocus = document.activeElement;
  setTimeout(() => {
    const firstBtn = modal.querySelector('.forward-contact-btn');
    if (firstBtn) firstBtn.focus();
    else modal.querySelector('#forward-cancel')?.focus();
  }, 50);

  const close = () => {
    modal.remove();
    if (_forwardClose) { _forwardClose(); _forwardClose = null; }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) {}
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKeyDown);
  _forwardClose = () => document.removeEventListener('keydown', onKeyDown);

  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#forward-cancel').addEventListener('click', close);

  modal.querySelectorAll('.forward-contact-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fp = btn.dataset.fp;
      btn.disabled = true;
      btn.textContent = 'Forwarding...';
      try {
        await forwardMessageTo(fp, text);
        close();
        showToast('Message forwarded.', 'success', 2000);
      } catch (err) {
        console.error('Forward failed:', err);
        showToast('Failed to forward message.', 'error', 4000);
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
  });
}

async function forwardMessageTo(recipientFp, text) {
  // Temporarily switch active contact to derive session key, then send
  const originalContact = clientSession.activeContact;
  const originalKey = clientSession.activeSessionKey;
  const contact = clientSession.contacts.find(c => c.fingerprint === recipientFp);
  if (!contact) throw new Error('Contact not found');

  // Fetch their prekey bundle and derive session key
  const res = await fetch(`${window.location.origin}/api/users/${recipientFp}`);
  if (!res.ok) throw new Error('Failed to resolve contact keys');
  const bundle = await res.json();
  const sessionKey = await window.SecureCrypto.deriveSessionKey(
    bundle.public_identity_key, bundle.public_prekey, bundle.prekey_signature,
    clientSession.identityPrivateKey
  );

  const encrypted = window.SecureCrypto.encrypt(text, sessionKey);
  const sentTimestamp = new Date().toISOString();
  const result = await window.SecureSocket.sendMessage(
    recipientFp, encrypted.ciphertext, encrypted.nonce,
    clientSession.identityPublicKey, clientSession.identityPrivateKey
  );

  if (result.success) {
    const status = result.status === 'sent' ? 'sent'
      : (result.status === 'queued' ? 'sent' : 'delivered');
    saveMessageToStorage(recipientFp, clientSession.identityKeyHash, text, sentTimestamp, false, status, result.message_id || null);
    clientSession.pendingDelivery[recipientFp] = sentTimestamp;
    renderContactsList();
  } else {
    throw new Error(result.error || 'Send failed');
  }
}

// Right-click context menu on messages
document.addEventListener('contextmenu', (e) => {
  const msgEl = e.target.closest('.message');
  if (!msgEl || msgEl.classList.contains('typing-indicator')) return;
  e.preventDefault();
  openMessageContextMenu(msgEl, e.clientX, e.clientY);
});

// Long-press context menu for touch devices
let _longPressTimer = null;
let _longPressTarget = null;
document.addEventListener('touchstart', (e) => {
  const msgEl = e.target.closest('.message');
  if (!msgEl || msgEl.classList.contains('typing-indicator')) return;
  _longPressTarget = msgEl;
  const touch = e.touches[0];
  _longPressTimer = setTimeout(() => {
    if (_longPressTarget) {
      openMessageContextMenu(_longPressTarget, touch.clientX, touch.clientY);
    }
    _longPressTarget = null;
  }, 500);
}, { passive: true });
document.addEventListener('touchend', () => {
  if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  _longPressTarget = null;
});
document.addEventListener('touchmove', () => {
  if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  _longPressTarget = null;
}, { passive: true });


/**
 * Smoothly fade out + remove a typing indicator capsule.
 * @param {HTMLElement} indicator  the .typing-indicator element
 */
function fadeOutTypingIndicator(indicator) {
  if (!indicator || indicator._fadingOut) return;
  indicator._fadingOut = true;
  indicator.classList.add('typing-leaving');
  indicator.addEventListener('animationend', () => indicator.remove(), { once: true });
  // Safety net in case the animationend event doesn't fire
  setTimeout(() => { if (indicator.parentNode) indicator.remove(); }, 400);
}

/**
 * Typing Indicator in Chat Area
 */
function renderTypingIndicator(userId, isTyping) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  // Fade out + remove any existing indicator for this user
  const existing = chatMessages.querySelector(`.typing-indicator[data-from="${userId}"]`);
  if (existing) fadeOutTypingIndicator(existing);

  if (!isTyping) return;

  const indicator = document.createElement('div');
  indicator.className = 'message received typing-indicator';
  indicator.dataset.from = userId;

  indicator.innerHTML = `
    <div class="typing-bubble">
      <span class="typing-dots">
        <span></span><span></span><span></span>
      </span>
    </div>
  `;

  chatMessages.appendChild(indicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Lock session
function handleLockSession() {
  // Send inactive for current contact and clear local chatActive state
  if (clientSession.activeContact) {
    window.SecureSocket.sendChatState(clientSession.activeContact.fingerprint, 'inactive');
    delete clientSession.chatActive[clientSession.activeContact.fingerprint];
  }

  window.SecureSocket.disconnect();
  clientSession.identityPublicKey = null;
  clientSession.identityPrivateKey = null;
  clientSession.preKeyPublicKey = null;
  clientSession.preKeyPrivateKey = null;
  clientSession.activeSessionKey = null;
  clientSession.activeContact = null;
  clientSession.presence = {};
  clientSession.chatActive = {};
  clientSession.typing = {};
  clientSession.readReceipts = {};
  clientSession.unreadCounts = {};
  clientSession.shredded = {};
  clientSession.pendingDelivery = {};

  // Cross-fade + scale back to the auth screen
  transitionScreens('chat-screen', 'auth-screen').then(() => {
    document.getElementById('login-passphrase').value = '';

    // Reset welcome overlay (will be re-hidden by enterChatDashboard if
    // the user already dismissed it before)
    const welcomeOverlay = document.getElementById('welcome-overlay');
    if (welcomeOverlay) {
      welcomeOverlay.classList.remove('hidden');
    }
  });
}

// ─── Utility Helpers ────────────────────────────

function copyFingerprint() {
  // Try the chat dashboard display first, fall back to the registration display
  const chatEl = document.getElementById('my-identity-display');
  const regEl = document.getElementById('fingerprint-display');
  const fp = (chatEl && chatEl.textContent.trim()) || (regEl && regEl.textContent.trim()) || '';
  if (!fp) {
    showToast('No fingerprint available to copy.', 'warning');
    return;
  }
  copyToClipboard(fp, 'Identity fingerprint copied to clipboard!');
}

/**
 * Cross-context clipboard copy.  navigator.clipboard.writeText() requires a
 * secure context (HTTPS or localhost) and a focused document — it fails in
 * HTTP previews, iframes, or when the tab isn't focused.  This wrapper falls
 * back to the legacy execCommand('copy') approach when the async Clipboard
 * API is unavailable or rejects.
 */
function copyToClipboard(text, successMessage) {
  // Fast path: modern async Clipboard API (HTTPS / localhost / focused tab)
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMessage, 'success');
    }).catch(() => {
      // Clipboard API rejected (permissions, iframe, unfocused) → fallback
      if (legacyCopy(text)) {
        showToast(successMessage, 'success');
      } else {
        showToast('Failed to copy to clipboard.', 'error');
      }
    });
  } else {
    // No Clipboard API available → use legacy method directly
    if (legacyCopy(text)) {
      showToast(successMessage, 'success');
    } else {
      showToast('Failed to copy to clipboard.', 'error');
    }
  }
}

/**
 * Legacy clipboard copy via a temporary textarea + execCommand('copy').
 * Works in non-secure contexts (HTTP), iframes, and unfocused documents.
 */
function legacyCopy(text) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (e) {
    return false;
  }
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g,
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// ─── In-Chat Image Lightbox ──────────────────────────
/**
 * Open an image in a full-screen lightbox overlay.
 * Called when the user clicks an image in the chat.
 * Accessibility: moves focus to the close button, sets alt text,
 * and traps keyboard focus inside the dialog while open.
 */
let _lightboxLastFocus = null;

function openImageLightbox(dataUrl, altText) {
  const lightbox = document.getElementById('image-lightbox');
  const img = document.getElementById('image-lightbox-img');
  if (!lightbox || !img) return;
  // Remember the element that triggered the lightbox so we can
  // restore focus when it closes (WCAG 2.4.3).
  _lightboxLastFocus = document.activeElement;
  img.src = dataUrl;
  // Use a meaningful alt if provided; fall back to a generic label
  // rather than empty (empty alt marks an image as decorative).
  img.alt = (altText && typeof altText === 'string' && altText.trim())
    ? altText.trim()
    : 'Encrypted image preview';
  lightbox.style.display = 'flex';
  // Move focus to the close button so keyboard users can act immediately
  const closeBtn = lightbox.querySelector('.image-lightbox-close');
  if (closeBtn) closeBtn.focus();
}

/**
 * Close the image lightbox overlay and restore focus.
 */
function closeImageLightbox() {
  const lightbox = document.getElementById('image-lightbox');
  if (!lightbox) return;
  lightbox.style.display = 'none';
  const img = document.getElementById('image-lightbox-img');
  if (img) img.src = '';
  // Restore focus to the triggering element
  if (_lightboxLastFocus && typeof _lightboxLastFocus.focus === 'function') {
    try { _lightboxLastFocus.focus(); } catch (e) {}
  }
  _lightboxLastFocus = null;
}

// Close lightbox on click of the dark background (not the image itself)
document.addEventListener('click', (e) => {
  const lightbox = document.getElementById('image-lightbox');
  if (lightbox && lightbox.style.display !== 'none' && e.target === lightbox) {
    closeImageLightbox();
  }
});

// Event delegation: click any chat image → open in lightbox
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('chat-image-preview')) {
    const fullUrl = e.target.getAttribute('data-full');
    if (fullUrl) {
      // Try to derive a meaningful alt from sibling/parent context
      let altText = 'Encrypted image';
      const bubble = e.target.closest('.message');
      if (bubble) {
        const meta = bubble.querySelector('.message-time-text');
        if (meta && meta.textContent) altText = `Encrypted image · ${meta.textContent.trim()}`;
      }
      openImageLightbox(fullUrl, altText);
    }
  }
});

// Close lightbox on ESC key + focus trap while open
document.addEventListener('keydown', (e) => {
  const lightbox = document.getElementById('image-lightbox');
  if (!lightbox || lightbox.style.display === 'none') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeImageLightbox();
    return;
  }
  // Focus trap: keep Tab focus within the dialog
  if (e.key === 'Tab') {
    const focusable = lightbox.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ─── Mobile Sidebar Drawer ──────────────────────────
/**
 * Reusable modal focus-trap + Escape handler.
 * Call openModalTrap(overlayEl) when showing a modal; it returns a
 * close() function that removes the listeners and restores focus.
 */
function openModalTrap(overlay) {
  if (!overlay) return () => {};
  const lastFocus = document.activeElement;

  // Focus the first focusable element inside the modal
  const focusable = overlay.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length > 0) {
    // Prefer the dismiss/close button if present
    const closeBtn = overlay.querySelector('.welcome-dismiss, .image-lightbox-close');
    (closeBtn || focusable[0]).focus();
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      overlay.dispatchEvent(new CustomEvent('modal-close'));
      return;
    }
    if (e.key === 'Tab') {
      const f = overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKeyDown);

  return function close() {
    document.removeEventListener('keydown', onKeyDown);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) {}
    }
  };
}

// Active modal traps — one at a time
let _verifyModalClose = null;
let _profileModalClose = null;
let _welcomeModalClose = null;

function openMobileSidebar() {
  const sidebar = document.getElementById('chat-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('sidebar-toggle-btn');
  if (!sidebar) return;
  sidebar.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.classList.add('is-open');
  }
}

/**
 * Close the mobile sidebar drawer.
 */
function closeMobileSidebar() {
  const sidebar = document.getElementById('chat-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('sidebar-toggle-btn');
  if (!sidebar) return;
  sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('is-open');
  }
}

/**
 * Toggle the mobile sidebar drawer open/closed.
 */
function toggleMobileSidebar() {
  const sidebar = document.getElementById('chat-sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
}

// ─── Themed Toast Notification (replaces native alert) ──────────
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) {
    console.warn('Toast container missing, falling back to console:', message);
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span class="toast-message">${escapeHTML(String(message))}</span>
    <button class="toast-close" aria-label="Dismiss notification">&times;</button>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('toast-visible');
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
}

// ─── Themed Confirmation Modal (replaces native confirm) ────────
function showConfirm(message, options = {}) {
  const {
    title = 'Please Confirm',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
    icon = null
  } = options;

  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    const iconEl = document.getElementById('confirm-icon');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const confirmBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    if (!overlay || !confirmBtn || !cancelBtn) {
      console.warn('Confirm modal missing, falling back to native confirm');
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmBtn.classList.toggle('danger', danger);
    // Sync the danger accent onto the card itself (neon bottom border)
    const cardEl = overlay.querySelector('.confirm-card');
    if (cardEl) cardEl.classList.toggle('danger', danger);
    if (iconEl) iconEl.innerHTML = icon || (danger
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>');

    overlay.classList.add('visible');

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove('visible');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onOverlay = (e) => { if (e.target === overlay) finish(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') finish(true);
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);

    // For destructive actions, focus Cancel so an accidental Enter is safe
    setTimeout(() => (danger ? cancelBtn : confirmBtn).focus(), 50);
  });
}

function formatRelativeTime(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay < 7) return `${diffDay}d`;
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function updateConnectionStatus(status) {
  const halo = document.getElementById('connection-halo');
  const label = document.getElementById('connection-label');

  // Reset classes
  if (halo) halo.className = 'connection-halo';
  if (label) label.className = 'connection-label';

  if (status === 'connected') {
    if (halo) halo.classList.add('connected');
    if (label) { label.textContent = 'Connected'; label.classList.add('connected'); }
  } else if (status === 'connecting' || status === 'authenticating') {
    if (halo) halo.classList.add('connecting');
    if (label) { label.textContent = 'Connecting...'; label.classList.add('connecting'); }
  } else if (status === 'offline-mode') {
    if (halo) halo.classList.add('rest-mode');
    if (label) { label.textContent = 'REST Mode'; label.classList.add('rest-mode'); }
  } else {
    if (halo) halo.classList.add('offline');
    if (label) { label.textContent = 'Offline'; label.classList.add('offline'); }
  }
}

// B&W theme toggling
function toggleGrayscaleTheme() {
  const isBw = document.body.classList.toggle('bw-theme');
  localStorage.setItem('bw_theme', isBw);
  updateThemeButtonText(isBw);
}

function updateThemeButtonText(isBw) {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.textContent = isBw ? 'Color' : 'B&W';
  }
}

function showTypingAvatar(userId) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const existing = chatMessages.querySelector(`.typing-indicator[data-from="${userId}"]`);
  if (existing) fadeOutTypingIndicator(existing);

  const indicator = document.createElement('div');
  indicator.className = 'message received typing-indicator';
  indicator.dataset.from = userId;

  indicator.innerHTML = `
    <div class="typing-bubble">
      <span style="opacity: 0.7; margin-right: 8px; display:inline-flex;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg></span>
      <span class="typing-dots">
        <span></span><span></span><span></span>
      </span>
    </div>
  `;

  chatMessages.appendChild(indicator);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ─── Deterministic Colorful Geometric SVG Identicon Generator ─────
function generateIdenticon(hash) {
  if (!hash) return '';
  const primaryColor = '#' + hash.substring(0, 6);
  const secondaryColor = '#' + hash.substring(6, 12);
  
  // 5x5 symmetric grid
  let grid = [];
  for (let r = 0; r < 5; r++) {
    const rowHex = hash.substring(12 + r * 3, 12 + r * 3 + 3);
    const r1 = parseInt(rowHex[0], 16) % 2 === 0;
    const r2 = parseInt(rowHex[1], 16) % 2 === 0;
    const r3 = parseInt(rowHex[2], 16) % 2 === 0;
    grid.push([r1, r2, r3, r2, r1]);
  }
  
  let svgContent = '';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (grid[r][c]) {
        svgContent += `<rect x="${c * 10}" y="${r * 10}" width="10" height="10" fill="${primaryColor}" />`;
      } else {
        svgContent += `<rect x="${c * 10}" y="${r * 10}" width="10" height="10" fill="${secondaryColor}" opacity="0.15" />`;
      }
    }
  }
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" style="border-radius: 50%; width: 100%; height: 100%; display: block;">${svgContent}</svg>`;
}

// ─── Security Dashboard Empty-State Generator ──────────────────────
function getSecurityDashboardHTML() {
  return `
    <div class="security-dashboard">
      <div class="dashboard-shield-wrap">
        <div class="dashboard-pulse-ring"></div>
        <div class="dashboard-pulse-ring"></div>
        <div class="dashboard-pulse-ring"></div>
        <div class="dashboard-shield-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
      </div>
      <h3 class="dashboard-title">BlindSession Security Dashboard</h3>
      <p class="dashboard-subtitle">Select a contact to begin an end-to-end encrypted session</p>
      <div class="security-metrics">
        <div class="metric-card">
          <div class="metric-label">Handshake</div>
          <div class="metric-value">ECDH Curve25519</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Encryption</div>
          <div class="metric-value">XChaCha20-Poly1305</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Local Store</div>
          <div class="metric-value">Encrypted Storage</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Server Status</div>
          <div class="metric-value">Zero-Knowledge</div>
        </div>
      </div>
    </div>`;
}

function getLoadingStateHTML() {
  return `<div class="chat-loading-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="M12 8v4"/><circle cx="12" cy="16" r="0.5"/>
    </svg>
    <p>Resolving secure session keys...</p>
  </div>`;
}

function getErrorStateHTML(message) {
  return `<div class="chat-error-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    <p style="font-size: 0.9rem; font-weight: 600;">Key Handshake Error</p>
    <p style="font-size: 0.8rem; opacity: 0.8; margin-top: 0.25rem;">${escapeHTML(message)}</p>
  </div>`;
}

// ─── Disappearing Message Timer Helpers ───────────────────────────
function getBurnTimerText(seconds) {
  if (seconds === null) return 'Off';
  if (seconds === 5) return 'Immediately (5s)';
  if (seconds === 60) return '1 Minute';
  if (seconds === 3600) return '1 Hour';
  if (seconds === 86400) return '24 Hours';
  return `${seconds} seconds`;
}

/**
 * Format a remaining-seconds countdown as a compact human-readable string.
 * e.g. 86400 → "24h 0m 0s", 3661 → "1h 1m 1s", 65 → "1m 5s", 5 → "5s"
 */
function formatBurnCountdown(totalSeconds) {
  if (totalSeconds <= 0) return '0s';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function handleDisappearingTimerChange(selectVal) {
  if (!clientSession.activeContact) return;
  const recipientHash = clientSession.activeContact.fingerprint;

  let burnTimer = null;
  if (selectVal !== 'off') {
    burnTimer = parseInt(selectVal, 10);
  }

  // Update session state & LocalStorage config
  clientSession.chatConfigs[recipientHash] = { burnTimer };
  localStorage.setItem(`chat_config_${recipientHash}`, JSON.stringify({ burnTimer }));

  // Send config updates via WebSocket
  window.SecureSocket.sendChatConfig(recipientHash, burnTimer);

  // Add system message and render
  const timerText = getBurnTimerText(burnTimer);
  saveMessageToStorage(recipientHash, 'system', `Disappearing messages set to ${timerText} by you`, new Date().toISOString());
  renderActiveChatMessages();
  renderContactsList();
}

// ─── Drag-and-Drop / Paste Image Sharing ──────────────────────────
function handleImageUpload(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Only image files are supported.', 'warning');
    return;
  }
  if (file.size > 5000000) {
    showToast('Image is too large. Please select an image under 5MB.', 'warning');
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64Data = e.target.result;
    // Auto-compress images over 500KB via canvas resize.
    // Small images pass through untouched; large ones are resized to
    // max 1200x1200 and JPEG-compressed to keep payloads small.
    const processed = await compressImageIfNeeded(base64Data, 500000, 1200, 0.85);
    // Show preview modal before sending
    showImagePreviewModal(processed);
  };
  reader.readAsDataURL(file);
}

// ─── Image preview modal before send ───────────────
let _imagePreviewClose = null;

function showImagePreviewModal(dataUrl) {
  // Remove any existing preview modal
  const existing = document.getElementById('image-preview-modal');
  if (existing) existing.remove();
  if (_imagePreviewClose) { _imagePreviewClose(); _imagePreviewClose = null; }

  const modal = document.createElement('div');
  modal.id = 'image-preview-modal';
  modal.className = 'image-preview-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Preview image before sending');
  modal.innerHTML = `
    <div class="image-preview-card">
      <img src="${escapeHTML(dataUrl)}" alt="Image preview" />
      <input type="text" id="image-preview-caption" placeholder="Add a caption (optional)..." maxlength="200" />
      <div class="image-preview-actions">
        <button type="button" class="image-preview-cancel" id="image-preview-cancel-btn">Cancel</button>
        <button type="button" class="image-preview-send" id="image-preview-send-btn">Send Image</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const lastFocus = document.activeElement;
  const sendBtn = modal.querySelector('#image-preview-send-btn');
  const cancelBtn = modal.querySelector('#image-preview-cancel-btn');
  const captionInput = modal.querySelector('#image-preview-caption');

  // Focus the send button so keyboard users can act immediately
  setTimeout(() => sendBtn.focus(), 50);

  const close = () => {
    modal.remove();
    if (_imagePreviewClose) { _imagePreviewClose(); _imagePreviewClose = null; }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) {}
    }
  };

  // Focus trap
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKeyDown);
  _imagePreviewClose = () => document.removeEventListener('keydown', onKeyDown);

  // Backdrop click closes
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  cancelBtn.addEventListener('click', close);

  sendBtn.addEventListener('click', async () => {
    const caption = captionInput.value.trim();
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      if (caption) {
        // Send caption as a separate text message first, then the image
        await sendE2eeTextMessage(caption);
      }
      await sendE2eeImage(dataUrl);
      close();
    } catch (err) {
      console.error('Image send failed:', err);
      showToast('Failed to send image.', 'error', 4000);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Image';
    }
  });

  // Enter in caption field triggers send
  captionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
}

// Helper: send a plain text message (used by image caption)
async function sendE2eeTextMessage(plainText) {
  if (!plainText || !clientSession.activeContact || !clientSession.activeSessionKey) return;
  const recipientHash = clientSession.activeContact.fingerprint;
  const encrypted = window.SecureCrypto.encrypt(plainText, clientSession.activeSessionKey);
  const sentTimestamp = new Date().toISOString();
  const result = await window.SecureSocket.sendMessage(
    recipientHash, encrypted.ciphertext, encrypted.nonce,
    clientSession.identityPublicKey, clientSession.identityPrivateKey
  );
  if (result.success) {
    const initialStatus = result.status === 'sent' ? 'sent'
      : (result.status === 'queued' ? 'sent' : 'delivered');
    saveMessageToStorage(recipientHash, clientSession.identityKeyHash, plainText, sentTimestamp, false, initialStatus, result.message_id || null);
    clientSession.pendingDelivery[recipientHash] = sentTimestamp;
    renderActiveChatMessages();
    renderContactsList();
  }
}

/**
 * Compress an image data URL if it exceeds the size threshold.
 * Uses canvas to resize to maxDimensions and re-encode as JPEG at the
 * given quality. If the image is already small enough or compression
 * doesn't help, the original data URL is returned unchanged.
 *
 * @param {string} dataUrl - Original image as a data URL
 * @param {number} thresholdBytes - Compress only if larger than this
 * @param {number} maxDim - Max width/height in pixels (preserves aspect ratio)
 * @param {number} quality - JPEG quality 0-1
 * @returns {Promise<string>} Compressed or original data URL
 */
function compressImageIfNeeded(dataUrl, thresholdBytes, maxDim, quality) {
  return new Promise((resolve) => {
    // Estimate base64 size: roughly 3/4 of the string length
    const estimatedBytes = Math.floor(dataUrl.length * 0.75);
    if (estimatedBytes <= thresholdBytes) {
      resolve(dataUrl);
      return;
    }

    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // Scale down preserving aspect ratio
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height / width) * maxDim);
          width = maxDim;
        } else {
          width = Math.round((width / height) * maxDim);
          height = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // PNG with transparency stays PNG; everything else becomes JPEG
      const isPng = dataUrl.startsWith('data:image/png');
      const mimeType = isPng ? 'image/png' : 'image/jpeg';
      const compressed = canvas.toDataURL(mimeType, quality);

      // Only use compressed version if it's actually smaller
      if (compressed.length < dataUrl.length) {
        resolve(compressed);
      } else {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl); // fallback to original on error
    img.src = dataUrl;
  });
}

async function sendE2eeImage(dataUrl) {
  if (!clientSession.activeContact || !clientSession.activeSessionKey) return;
  const recipientHash = clientSession.activeContact.fingerprint;

  const payload = JSON.stringify({
    type: 'image',
    dataUrl: dataUrl
  });

  const encrypted = window.SecureCrypto.encrypt(payload, clientSession.activeSessionKey);

  // Capture one timestamp used for both storage and delivery matching.
  const sentTimestamp = new Date().toISOString();

  const result = await window.SecureSocket.sendMessage(
    recipientHash,
    encrypted.ciphertext,
    encrypted.nonce,
    clientSession.identityPublicKey,
    clientSession.identityPrivateKey
  );

  if (result.success) {
    const initialStatus = result.status === 'sent' ? 'sent'
      : (result.status === 'queued' ? 'sent' : 'delivered');
    saveMessageToStorage(recipientHash, clientSession.identityKeyHash, payload, sentTimestamp, true, initialStatus);
    clientSession.pendingDelivery[recipientHash] = sentTimestamp;
    renderActiveChatMessages();
    renderContactsList();
  } else {
    showToast(`Failed to send image: ${result.error}`, 'error', 6000);
  }
}

// ─── Close / Deselect Active Chat ────────────────────────────
// Returns the chat pane to the empty placeholder WITHOUT deleting anything:
// the contact, its history, config and unread state all stay intact. Sends
// chat_state 'inactive' to the previously-open contact so their "Active in
// chat" badge clears, and zeroes the active-contact/session-key references.
function handleCloseChat() {
  const prev = clientSession.activeContact;
  if (!prev) return; // nothing open

  // 1. Tell the previously-open contact we're no longer active in their chat
  window.SecureSocket.sendChatState(prev.fingerprint, 'inactive');
  // Also clear local chatActive state so it doesn't show stale "Active in chat"
  delete clientSession.chatActive[prev.fingerprint];

  // 2. Clear active references (session key held in JS memory is dropped)
  clientSession.activeContact = null;
  clientSession.activeSessionKey = null;

  // 3. Reset the header
  document.getElementById('chat-recipient-title').textContent = 'Select a Contact';
  const subtitleEl = document.getElementById('chat-recipient-subtitle');
  if (subtitleEl) subtitleEl.innerHTML = '';
  const headerAvatar = document.getElementById('chat-header-avatar');
  if (headerAvatar) headerAvatar.innerHTML = '';
  const headerDot = document.getElementById('chat-header-avatar-dot');
  if (headerDot) headerDot.className = 'chat-header-avatar-dot offline';

  // 4. Disable + clear the composer
  const messageField = document.getElementById('message-field');
  const sendBtn = document.getElementById('send-msg-btn');
  if (messageField) {
    messageField.value = '';
    messageField.setAttribute('disabled', 'true');
  }
  if (sendBtn) sendBtn.setAttribute('disabled', 'true');

  // 5. Show the security dashboard empty state
  const messagesBox = document.getElementById('chat-messages');
  if (messagesBox) {
    messagesBox.innerHTML = `
      <div id="drag-overlay" class="drag-overlay hidden">
        <div class="drag-overlay-content">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width: 3rem; height: 3rem; color: var(--primary);"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <p style="margin-top: 8px; font-weight: 600;">Drop image here to encrypt & share</p>
        </div>
      </div>
      ${getSecurityDashboardHTML()}`;
  }

  // 6. Re-render sidebar so the active highlight drops
  renderContactsList();
}

// ─── Remove Contact (local-only wipe) ───────────────────────
async function handleRemoveContact(contact) {
  if (!contact || !contact.fingerprint) return;
  const fp = contact.fingerprint;
  const isShredded = !!clientSession.shredded[fp];

  const message = isShredded
    ? 'Remove this shredded contact from your list? Their chat history (already empty on the server) will be deleted from this device.'
    : 'Remove this contact? This deletes the contact and the ENTIRE chat history on THIS DEVICE ONLY. The other person keeps their copy of the conversation and keeps you in their list. This cannot be undone.';

  const confirmed = await showConfirm(message, {
    title: isShredded ? 'Remove Shredded Contact' : 'Remove Contact',
    confirmText: 'Remove',
    danger: true,
    icon: '🗑️'
  });
  if (!confirmed) return;

  // 1. Drop the contact entry
  clientSession.contacts = clientSession.contacts.filter(c => c.fingerprint !== fp);
  localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));

  // 2. Wipe all per-contact local data (history, unread counter, config)
  localStorage.removeItem(`history_${fp}`);
  localStorage.removeItem(`read_count_${fp}`);
  localStorage.removeItem(`chat_config_${fp}`);

  // 3. Clean in-memory state maps
  delete clientSession.presence[fp];
  delete clientSession.chatActive[fp];
  delete clientSession.typing[fp];
  delete clientSession.readReceipts[fp];
  delete clientSession.unreadCounts[fp];
  delete clientSession.chatConfigs[fp];
  delete clientSession.shredded[fp];
  delete clientSession.pendingDelivery[fp];

  // 4. If the removed contact was open in the chat pane, reset the view
  if (clientSession.activeContact && clientSession.activeContact.fingerprint === fp) {
    clientSession.activeContact = null;
    clientSession.activeSessionKey = null;

    document.getElementById('chat-recipient-title').textContent = 'Select a Contact';
    const subtitleEl = document.getElementById('chat-recipient-subtitle');
    if (subtitleEl) subtitleEl.innerHTML = '';
    const headerAvatar = document.getElementById('chat-header-avatar');
    if (headerAvatar) headerAvatar.innerHTML = '';
    const headerDot = document.getElementById('chat-header-avatar-dot');
    if (headerDot) headerDot.className = 'chat-header-avatar-dot offline';
    document.getElementById('message-field').setAttribute('disabled', 'true');
    document.getElementById('send-msg-btn').setAttribute('disabled', 'true');

    const messagesBox = document.getElementById('chat-messages');
    if (messagesBox) {
      messagesBox.innerHTML = `
        <div id="drag-overlay" class="drag-overlay hidden">
          <div class="drag-overlay-content">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width: 3rem; height: 3rem; color: var(--primary);"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <p style="margin-top: 8px; font-weight: 600;">Drop image here to encrypt & share</p>
          </div>
        </div>
        ${getSecurityDashboardHTML()}`;
    }
  }

  // 5. Re-subscribe presence for the remaining contacts (drop the removed hash)
  subscribeToContactPresence();
  renderContactsList();

  showToast(
    isShredded ? 'Shredded contact removed.' : 'Contact removed and chat history wiped on this device.',
    'success'
  );
}

// ─── Clear Chat (Local Trigger) ───────────────────────────────
async function handleClearChat() {
  if (!clientSession.activeContact) return;
  const confirmed = await showConfirm(
    'Clear all messages in this chat? Both sides will be wiped instantly.',
    {
      title: 'Clear Chat',
      confirmText: 'Clear',
      danger: true,
      icon: '🗑️'
    }
  );
  if (!confirmed) return;
  const fp = clientSession.activeContact.fingerprint;

  // 1. Vanish animation on all visible message bubbles
  const msgs = document.querySelectorAll('#chat-messages .message:not(.typing-indicator)');
  msgs.forEach(m => m.classList.add('dissolving'));

  // 2. After animation: wipe storage and re-render (matches particle-dissolve duration)
  setTimeout(() => {
    localStorage.removeItem(`history_${fp}`);
    localStorage.removeItem(`read_count_${fp}`);
    clientSession.unreadCounts[fp] = 0;
    renderActiveChatMessages();
    renderContactsList();
  }, 700);

  // 3. Notify the other side
  window.SecureSocket.sendClearChat(fp);
}

// ─── Clear Chat (Remote Trigger) ──────────────────────────────
function handleClearChatReceived(senderHash) {
  // Vanish animation if this conversation is currently open
  if (clientSession.activeContact && clientSession.activeContact.fingerprint === senderHash) {
    const msgs = document.querySelectorAll('#chat-messages .message:not(.typing-indicator)');
    msgs.forEach(m => m.classList.add('dissolving'));
    setTimeout(() => {
      localStorage.removeItem(`history_${senderHash}`);
      localStorage.removeItem(`read_count_${senderHash}`);
      clientSession.unreadCounts[senderHash] = 0;
      renderActiveChatMessages();
      renderContactsList();
    }, 700); // matches particle-dissolve duration
  } else {
    // Clear silently in background
    localStorage.removeItem(`history_${senderHash}`);
    localStorage.removeItem(`read_count_${senderHash}`);
    clientSession.unreadCounts[senderHash] = 0;
    renderContactsList();
  }
}

// ─── Panic Shredder (Local + Server Wipe) ──────────────────────
async function handlePanicShredder(silent = false) {
  if (!silent) {
    const confirmed = await showConfirm(
      'Panic Shredder will permanently delete your account from the server, wipe all keys, contacts, and message history on this device, and request your contacts to erase their copies. This action cannot be undone.',
      {
        title: 'Panic Shredder',
        confirmText: 'Shred Everything',
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      }
    );
    if (!confirmed) {
      return;
    }
  }

  let serverDeleted = false;

  // 0. Delete account from server (while we still have keys to sign the request)
  try {
    if (clientSession.identityPrivateKey && clientSession.identityPublicKey) {
      const timestamp = new Date().toISOString();
      const path = '/api/auth/account';
      const signature = window.SecureCrypto.signRequest(
        clientSession.identityPrivateKey,
        'DELETE',
        path,
        timestamp,
        ''
      );

      const response = await fetch(`${window.location.origin}${path}`, {
        method: 'DELETE',
        headers: {
          'X-Identity-Key': clientSession.identityPublicKey,
          'X-Signature': signature,
          'X-Timestamp': timestamp
        }
      });

      serverDeleted = response.ok;
      if (!serverDeleted) {
        const errData = await response.json().catch(() => ({}));
        console.error('Server account deletion failed:', response.status, errData.error);
      }
    }
  } catch (err) {
    console.error('Server account deletion network error:', err);
    // Continue with local wipe even if server call fails
  }

  // 1. Notify all contacts to clear their local chat history (Fix #3)
  const contactsCopy = [...clientSession.contacts];
  for (const contact of contactsCopy) {
    try {
      window.SecureSocket.sendClearChat(contact.fingerprint);
    } catch (e) { /* best-effort */ }
  }
  // Give WS a moment to flush before disconnecting
  await new Promise(r => setTimeout(r, 300));

  // 2. Zero out memory buffers
  if (window.sodium) {
    if (clientSession.activeSessionKey) {
      try {
        window.sodium.memzero(clientSession.activeSessionKey);
      } catch (e) {
        console.error('Failed to zero session key buffer:', e);
      }
    }
  }

  // 3. Clear all local storage keys related to this app
  const keysToClear = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === 'encrypted_identity' ||
        key === 'encrypted_recovery_code' ||
        key === 'recovery_code_plain' ||
        key === 'my_display_name' ||
        key === 'duress_passphrase' ||
        key === 'contacts' ||
        key.startsWith('history_') ||
        key.startsWith('read_count_') ||
        key.startsWith('chat_config_') ||
        key === 'bw_theme') {
      keysToClear.push(key);
    }
  }
  keysToClear.forEach(k => localStorage.removeItem(k));

  // 4. Disconnect WebSocket
  window.SecureSocket.disconnect();

  // 5. Reset client session state
  clientSession = {
    identityPublicKey: null,
    identityPrivateKey: null,
    preKeyPublicKey: null,
    preKeyPrivateKey: null,
    identityKeyHash: null,
    displayName: null,
    contacts: [],
    activeContact: null,
    activeSessionKey: null,
    presence: {},
    chatActive: {},
    typing: {},
    readReceipts: {},
    unreadCounts: {},
    chatConfigs: {},
    shredded: {},
    pendingDelivery: {}
  };

  // 6. Hide chat, show auth, clear inputs
  showAuthTab('register');
  document.getElementById('reg-passphrase').value = '';
  document.getElementById('login-passphrase').value = '';
  document.getElementById('reg-result').classList.add('hidden');
  document.getElementById('new-contact-hash').value = '';

  if (!silent) {
    // Cross-fade + scale back to the auth screen
    await transitionScreens('chat-screen', 'auth-screen');

    if (serverDeleted) {
      showToast('🔒 Account deleted from server and this device wiped. All data shredded.', 'success', 6000);
    } else {
      showToast('This device is wiped, but server account deletion may have failed. Try again or contact support.', 'warning', 8000);
    }
  }
}

// ─── Clear Contact History (local-only, no contact removal) ────
async function handleClearContactHistory(contact) {
  if (!contact || !contact.fingerprint) return;
  const fp = contact.fingerprint;

  const confirmed = await showConfirm(
    'Clear the entire chat history for this contact on this device? The contact will remain in your list.',
    {
      title: 'Clear Chat History',
      confirmText: 'Clear',
      danger: true,
      icon: '🗑️'
    }
  );
  if (!confirmed) return;

  localStorage.removeItem(`history_${fp}`);
  localStorage.removeItem(`read_count_${fp}`);
  clientSession.unreadCounts[fp] = 0;

  // If this contact is currently open, re-render the chat pane
  if (clientSession.activeContact && clientSession.activeContact.fingerprint === fp) {
    renderActiveChatMessages();
  }

  renderContactsList();
  showToast('Chat history cleared for this contact.', 'success');
}

// ─── Contact Search / Filter ──────────────────────────────────
function filterContacts(query) {
  const listEl = document.getElementById('contacts-list');
  if (!listEl) return;

  const items = listEl.querySelectorAll('.contact-item');
  const normalizedQuery = query.toLowerCase().trim();
  let visibleCount = 0;

  items.forEach(item => {
    if (!normalizedQuery) {
      item.style.display = '';
      visibleCount++;
      return;
    }
    const fp = (item.dataset.fingerprint || '').toLowerCase();
    // Match against the rendered contact name (data-name) and fingerprint
    const name = (item.dataset.name || '').toLowerCase();
    if (fp.includes(normalizedQuery) || name.includes(normalizedQuery)) {
      item.style.display = '';
      visibleCount++;
    } else {
      item.style.display = 'none';
    }
  });

  // Empty search state — show "No contacts match" when all are filtered out
  let emptyMsg = listEl.querySelector('.search-empty-state');
  if (visibleCount === 0 && normalizedQuery) {
    if (!emptyMsg) {
      emptyMsg = document.createElement('div');
      emptyMsg.className = 'search-empty-state';
      listEl.appendChild(emptyMsg);
    }
    emptyMsg.textContent = `No contacts match "${query.trim()}"`;
    emptyMsg.style.display = '';
  } else if (emptyMsg) {
    emptyMsg.style.display = 'none';
  }
}

// ─── About / Help modal ────────────────────────────
let _aboutClose = null;

function showAboutModal() {
  const modal = document.getElementById('about-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const lastFocus = document.activeElement;
  const closeBtn = modal.querySelector('.image-preview-cancel');
  setTimeout(() => closeBtn?.focus(), 50);

  const close = () => {
    modal.classList.add('hidden');
    if (_aboutClose) { _aboutClose(); _aboutClose = null; }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) {}
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = modal.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKeyDown);
  _aboutClose = () => document.removeEventListener('keydown', onKeyDown);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  closeBtn.onclick = close;
}

function closeAboutModal() {
  const modal = document.getElementById('about-modal');
  if (modal) modal.classList.add('hidden');
  if (_aboutClose) { _aboutClose(); _aboutClose = null; }
}

// ─── In-chat message search ────────────────────────
function toggleChatSearch() {
  const bar = document.getElementById('chat-search-bar');
  if (!bar) return;
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    const input = document.getElementById('chat-search-input');
    if (input) input.focus();
  } else {
    clearChatSearch();
  }
}

function closeChatSearch() {
  const bar = document.getElementById('chat-search-bar');
  if (bar) bar.classList.add('hidden');
  clearChatSearch();
}

function clearChatSearch() {
  const messagesBox = document.getElementById('chat-messages');
  if (messagesBox) {
    messagesBox.querySelectorAll('.message.search-match').forEach(el => el.classList.remove('search-match'));
    messagesBox.querySelectorAll('.message.search-hidden').forEach(el => el.classList.remove('search-hidden'));
  }
  const count = document.getElementById('chat-search-count');
  if (count) count.textContent = '';
  const input = document.getElementById('chat-search-input');
  if (input) input.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('chat-search-input');
  if (!searchInput) return;
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performChatSearch(e.target.value), 200);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeChatSearch(); }
  });
});

function performChatSearch(query) {
  const messagesBox = document.getElementById('chat-messages');
  if (!messagesBox) return;
  const countEl = document.getElementById('chat-search-count');
  const normalized = query.toLowerCase().trim();

  messagesBox.querySelectorAll('.message.search-match').forEach(el => el.classList.remove('search-match'));
  messagesBox.querySelectorAll('.message.search-hidden').forEach(el => el.classList.remove('search-hidden'));

  if (!normalized) {
    if (countEl) countEl.textContent = '';
    return;
  }

  const messages = messagesBox.querySelectorAll('.message');
  let matchCount = 0;
  messages.forEach(msg => {
    if (msg.classList.contains('typing-indicator')) return;
    const text = (msg.textContent || '').toLowerCase();
    if (text.includes(normalized)) {
      msg.classList.add('search-match');
      matchCount++;
    } else {
      msg.classList.add('search-hidden');
    }
  });

  if (countEl) {
    countEl.textContent = matchCount > 0 ? `${matchCount} match${matchCount > 1 ? 'es' : ''}` : 'No results';
  }

  const firstMatch = messagesBox.querySelector('.message.search-match');
  if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Global Keyboard Shortcuts ─────────────────────
document.addEventListener('keydown', (e) => {
  // Ignore shortcuts when typing in an input/textarea (except Escape)
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  const ctrlOrCmd = e.ctrlKey || e.metaKey;

  // Ctrl/Cmd+K → focus contact search
  if (ctrlOrCmd && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const search = document.getElementById('contact-search');
    if (search) { search.focus(); search.select(); }
    return;
  }

  // Ctrl/Cmd+L → lock session
  if (ctrlOrCmd && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    if (typeof handleLockSession === 'function') handleLockSession();
    return;
  }

  // Escape → close active chat (if no modal is open)
  if (e.key === 'Escape' && !typing) {
    const openModal = document.querySelector('.image-lightbox:not(.hidden), #image-preview-modal, .msg-context-menu');
    if (openModal) return; // let modal-specific Escape handlers work
    if (clientSession.activeContact && typeof handleCloseChat === 'function') {
      handleCloseChat();
    }
  }
});

// ─── Drag-and-Drop & Paste Listeners Initializer ─────────────────
document.addEventListener('DOMContentLoaded', () => {
  const chatMessages = document.getElementById('chat-messages');
  const dragOverlay = document.getElementById('drag-overlay');

  if (chatMessages && dragOverlay) {
    window.addEventListener('dragenter', (e) => {
      if (!clientSession.activeContact) return;
      e.preventDefault();
      dragOverlay.classList.remove('hidden');
    });

    dragOverlay.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    dragOverlay.addEventListener('dragleave', (e) => {
      e.preventDefault();
      // Only hide if we actually dragged out of the screen
      if (e.relatedTarget === null || e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        dragOverlay.classList.add('hidden');
      }
    });

    dragOverlay.addEventListener('drop', (e) => {
      e.preventDefault();
      dragOverlay.classList.add('hidden');
      if (!clientSession.activeContact) return;
      const files = e.dataTransfer.files;
      if (files && files[0]) {
        handleImageUpload(files[0]);
      }
    });
  }

  const messageField = document.getElementById('message-field');
  if (messageField) {
    messageField.addEventListener('paste', (e) => {
      if (!clientSession.activeContact) return;
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf('image') === 0) {
          const file = item.getAsFile();
          handleImageUpload(file);
        }
      }
    });
  }

  // ─── Paperclip / File Attach Button ────────────────────
  const attachInput = document.getElementById('attach-file-input');
  if (attachInput) {
    attachInput.addEventListener('change', (e) => {
      if (!clientSession.activeContact) return;
      const file = e.target.files[0];
      if (file) handleImageUpload(file);
      attachInput.value = ''; // Reset so same file can be re-selected
    });
  }
});

// ─── Deterministic Naming & Verification Helpers ───────────────────

/**
 * Formats a 64-character fingerprint into space-separated blocks of 8 characters.
 */
function formatFingerprint(fp) {
  if (!fp || fp.length !== 64) return fp;
  const parts = [];
  for (let i = 0; i < 64; i += 8) {
    parts.push(fp.substring(i, i + 8));
  }
  return parts.join(' ');
}

/**
 * Populates and opens the visual verification modal ("Safety Numbers") for E2EE validation.
 */
function handleVerifySessionModal() {
  if (!clientSession.activeContact) {
    showToast('No active contact selected.', 'warning');
    return;
  }

  const myFp = clientSession.identityKeyHash;
  const contactFp = clientSession.activeContact.fingerprint;

  const myName = window.SecureCrypto.hashToName(myFp);
  const contactName = clientSession.activeContact.displayName || window.SecureCrypto.hashToName(contactFp);

  const myFpEl = document.getElementById('verify-my-fp');
  const myNameEl = document.getElementById('verify-my-name');
  const contactFpEl = document.getElementById('verify-contact-fp');
  const contactNameEl = document.getElementById('verify-contact-name');

  if (myNameEl) myNameEl.textContent = myName;
  if (myFpEl) myFpEl.textContent = formatFingerprint(myFp);

  if (contactNameEl) contactNameEl.textContent = contactName;
  if (contactFpEl) contactFpEl.textContent = formatFingerprint(contactFp);

  const overlay = document.getElementById('verify-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    if (_verifyModalClose) _verifyModalClose();
    _verifyModalClose = openModalTrap(overlay);
    overlay.addEventListener('modal-close', closeVerifyModal, { once: true });
  }
}

/**
 * Closes the visual verification modal overlay.
 */
function closeVerifyModal() {
  const overlay = document.getElementById('verify-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    if (_verifyModalClose) { _verifyModalClose(); _verifyModalClose = null; }
  }
}

// ─── Phase 3: Profile Name Sync ──────────────────────────────────────

/**
 * Applies a received profile update from a contact:
 * updates in-memory contact list, persists to localStorage, refreshes the UI.
 */
function applyContactProfileUpdate(senderHash, newName) {
  const sanitized = newName.trim().substring(0, 64); // max 64 chars
  if (!sanitized) return;

  // Update in-memory contact record
  const contact = clientSession.contacts.find(c => c.fingerprint === senderHash);
  if (contact) {
    contact.displayName = sanitized;
    localStorage.setItem('contacts', JSON.stringify(clientSession.contacts));
  }

  // If the active chat is open for this contact, update the header
  if (clientSession.activeContact && clientSession.activeContact.fingerprint === senderHash) {
    clientSession.activeContact.displayName = sanitized;
    document.getElementById('chat-recipient-title').textContent = sanitized;
  }

  // Re-render the sidebar contact list to reflect the new name
  renderContactsList();

  showToast(`Contact updated their name to "${sanitized}"`, 'info', 4000);
}

/**
 * Opens the Profile Name Editor modal, pre-filling with any saved display name and duress passphrase.
 */
function openProfileModal() {
  const input = document.getElementById('edit-display-name-input');
  if (input) {
    input.value = clientSession.displayName || '';
  }
  const duressInput = document.getElementById('edit-duress-passphrase-input');
  if (duressInput) {
    duressInput.value = localStorage.getItem('duress_passphrase') || '';
  }
  const overlay = document.getElementById('profile-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    if (_profileModalClose) _profileModalClose();
    _profileModalClose = openModalTrap(overlay);
    overlay.addEventListener('modal-close', closeProfileModal, { once: true });
  }
}

/**
 * Closes the Profile Name Editor modal without saving.
 */
function closeProfileModal() {
  const overlay = document.getElementById('profile-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    if (_profileModalClose) { _profileModalClose(); _profileModalClose = null; }
  }
}

/**
 * Saves the user's custom display name locally and broadcasts an E2EE
 * profile_update frame to every contact that has an active session key.
 * Also persists or clears the duress passphrase.
 */
async function handleSaveProfileName() {
  const input = document.getElementById('edit-display-name-input');
  const newName = (input ? input.value.trim() : '').substring(0, 64);

  if (!newName) {
    showToast('Please enter a display name.', 'warning');
    return;
  }

  // Persist locally
  clientSession.displayName = newName;
  localStorage.setItem('my_display_name', newName);

  // Duress passphrase handling
  const duressInput = document.getElementById('edit-duress-passphrase-input');
  const duressPass = duressInput ? duressInput.value.trim() : '';
  if (duressPass) {
    localStorage.setItem('duress_passphrase', duressPass);
  } else {
    localStorage.removeItem('duress_passphrase');
  }

  // Update sidebar profile card label
  const labelEl = document.querySelector('.profile-label');
  if (labelEl) {
    labelEl.textContent = newName;
  }

  // Broadcast the profile update as an E2EE frame to all contacts
  const profileFrame = JSON.stringify({ type: 'profile_update', displayName: newName });
  let sentCount = 0;

  for (const contact of clientSession.contacts) {
    try {
      // Derive a session key for this contact to encrypt the profile frame
      const res = await fetch(`${window.location.origin}/api/users/${contact.fingerprint}`);
      if (!res.ok) continue;
      const bundle = await res.json();
      const sessionKey = window.SecureCrypto.deriveSessionKey(
        clientSession.preKeyPrivateKey,
        bundle.public_prekey
      );
      const encrypted = window.SecureCrypto.encrypt(profileFrame, sessionKey);
      await window.SecureSocket.sendMessage(
        contact.fingerprint,
        encrypted.ciphertext,
        encrypted.nonce,
        clientSession.identityPublicKey,
        clientSession.identityPrivateKey
      );
      sentCount++;
    } catch (err) {
      // Contact offline or unavailable — they'll receive it next time they message
      console.warn(`Profile sync skipped for ${contact.fingerprint.substring(0, 8)}:`, err.message);
    }
  }

  closeProfileModal();
  showToast(`Settings saved${sentCount > 0 ? ` and synced to ${sentCount} contact(s)` : ' locally'}!`, 'success', 4000);
}

// ─── Phase 4: Cross-Device Key Backup & Passphrase Recovery ──────────────────

/**
 * Curated 256-word BIP-39-style word list for recovery codes.
 * Kept short here — full 2048-word list would be ideal in production.
 */
const RECOVERY_WORDS = [
  'apple','brave','cedar','dance','eagle','flame','grape','honey',
  'ivory','jewel','karma','lemon','maple','north','ocean','pearl',
  'queen','river','solar','tiger','ultra','vault','wheat','xenon',
  'yacht','zebra','amber','blaze','coral','delta','ember','frost',
  'globe','hazel','inlet','joker','knoll','lunar','marsh','noble',
  'olive','plaza','quill','raven','stone','trace','umbra','vivid',
  'waltz','xenia','yield','zonal','aided','baron','cliff','drake',
  'elbow','finch','glass','heron','index','joust','knave','lance',
  'merit','nymph','orbit','pixel','quota','ridge','spike','tower',
  'unify','vigor','winch','extra','young','zones','artic','brook',
  'chant','drift','equal','flint','grail','hatch','image','joins',
  'kitty','lowly','minor','ninth','oaken','pivot','quake','roost',
  'skull','thorn','until','viper','witch','xeric','yeast','zappy',
  'album','bench','civic','drawn','eight','flare','guava','hinge',
  'ideal','jiffy','kiosk','lilac','manor','nerve','oasis','prism',
  'quartz','relay','steel','tulip','upper','verse','wound','xerus',
  'yarns','zippy','atoll','blunt','camel','depot','equip','forge',
  'grove','haiku','imply','jaunt','kinky','llano','magic','nexus',
  'onion','pinch','quirk','rivet','scone','truce','unity','valve',
  'wafer','xylem','yearn','zonal','agile','brine','comet','debug',
  'eject','forge','grain','hover','igloo','jiber','kudos','laser',
  'melon','notch','optic','pilot','quoth','reset','slick','tabby',
  'ultra','vapid','wispy','xeric','yield','zeros','arcane','blend',
  'cycle','debug','evoke','fence','glare','hyena','input','joker',
  'knack','ledge','moose','nadir','oxide','plank','query','realm',
  'swamp','triad','umbra','venom','whirl','xeric','yours','zesty'
];

/**
 * Generates a cryptographically random 12-word recovery code.
 * Uses sodium.randombytes_uniform for uniform selection from the word list.
 */
function generateRecoveryCode() {
  const sodium = window.sodium;
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = sodium.randombytes_uniform(RECOVERY_WORDS.length);
    words.push(RECOVERY_WORDS[idx]);
  }
  return words.join(' ');
}

/**
 * Copies the displayed recovery code to clipboard.
 */
function copyRecoveryCode() {
  const el = document.getElementById('recovery-code-display');
  if (el) {
    copyToClipboard(el.textContent, 'Recovery code copied!');
  }
}

/**
 * Toggles the visibility of the recovery panel on the login screen.
 */
function toggleRecoveryView() {
  const panel = document.getElementById('recovery-panel');
  if (!panel) return;

  const isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');

  // Only run detection when opening the panel
  if (!isHidden) return;

  // Auto-detect: if encrypted_recovery_code is in localStorage, we're on the
  // same device (or a backup was just imported). Hide the fingerprint field.
  // If not, show it so the user can fetch the recovery blob from the server.
  const hasLocalRecovery = !!localStorage.getItem('encrypted_recovery_code');
  const fpGroup = document.getElementById('recovery-fp-group');

  if (fpGroup) {
    if (hasLocalRecovery) {
      fpGroup.classList.add('hidden');
    } else {
      fpGroup.classList.remove('hidden');
    }
  }

  // If a plain recovery code was pre-filled from a backup import, show a hint
  const rcInput = document.getElementById('recovery-code-input');
  if (rcInput && rcInput.value.trim()) {
    const hintEl = document.getElementById('recovery-code-hint');
    if (hintEl) hintEl.classList.remove('hidden');
  }
}

/**
 * Exports an encrypted identity backup JSON file for cross-device portability.
 * The file contains: the encrypted identity blob, encrypted recovery code blob,
 * plain-text recovery code, contacts list, and display name.
 * Private keys remain encrypted — the backup file is useless without the
 * user's passphrase OR recovery code.
 */
function handleExportBackup() {
  const encrypted = localStorage.getItem('encrypted_identity');
  const encryptedRecovery = localStorage.getItem('encrypted_recovery_code');
  if (!encrypted) {
    showToast('No identity to export. Create or unlock an identity first.', 'warning');
    return;
  }

  const recoveryCodePlain = localStorage.getItem('recovery_code_plain') || null;

  const backup = {
    version: 3,
    created_at: new Date().toISOString(),
    fingerprint: clientSession.identityKeyHash || 'unknown',
    display_name: clientSession.displayName || null,
    encrypted_identity: JSON.parse(encrypted),
    encrypted_recovery_code: encryptedRecovery ? JSON.parse(encryptedRecovery) : null,
    recovery_code_plain: recoveryCodePlain,
    contacts: JSON.parse(localStorage.getItem('contacts') || '[]')
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fp = (clientSession.identityKeyHash || 'blindsession').substring(0, 12);
  a.href = url;
  a.download = `blindsession-backup-${fp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Backup downloaded! Keep this file safe — it contains your recovery code.', 'success', 5000);
}

/**
 * Imports an identity from a backup JSON file.
 * Restores encrypted_identity, encrypted_recovery_code, contacts, and display name
 * to localStorage, then shows a clear choice: unlock with passphrase or use
 * recovery code if the backup includes one.
 */
function handleImportBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const backup = JSON.parse(e.target.result);

      if (!backup.encrypted_identity || !backup.encrypted_identity.ciphertext) {
        showToast('Invalid backup file — no encrypted identity found.', 'error');
        return;
      }

      // Restore encrypted blobs and metadata to localStorage
      localStorage.setItem('encrypted_identity', JSON.stringify(backup.encrypted_identity));

      if (backup.encrypted_recovery_code) {
        localStorage.setItem('encrypted_recovery_code', JSON.stringify(backup.encrypted_recovery_code));
      }

      if (backup.contacts && Array.isArray(backup.contacts)) {
        localStorage.setItem('contacts', JSON.stringify(backup.contacts));
      }

      if (backup.display_name) {
        localStorage.setItem('my_display_name', backup.display_name);
      }

      // Store plain recovery code if present in backup (v3+)
      if (backup.recovery_code_plain) {
        localStorage.setItem('recovery_code_plain', backup.recovery_code_plain);
      }

      const fp = backup.fingerprint || 'unknown';
      const fpShort = fp.substring(0, 16);

      // Switch to Login tab
      document.getElementById('register-tab-btn').classList.remove('active');
      document.getElementById('login-tab-btn').classList.add('active');
      document.getElementById('register-tab').classList.add('hidden');
      document.getElementById('login-tab').classList.remove('hidden');

      // Pre-fill recovery code into the recovery panel if available
      if (backup.recovery_code_plain) {
        const rcInput = document.getElementById('recovery-code-input');
        if (rcInput) rcInput.value = backup.recovery_code_plain;
      }

      // Show fingerprint in the recovery fingerprint field if present
      if (backup.fingerprint) {
        const fpInput = document.getElementById('recovery-fingerprint-input');
        if (fpInput) fpInput.value = backup.fingerprint;
      }

      // Show guidance toast
      if (backup.recovery_code_plain) {
        showToast(`Backup imported — Fingerprint: ${fpShort}… Enter your passphrase to unlock, or use "Forgot Passphrase" below if you forgot it.`, 'success', 8000);
      } else {
        showToast(`Backup imported — Fingerprint: ${fpShort}… Enter your passphrase to unlock.`, 'success', 6000);
      }

    } catch (err) {
      showToast('Failed to read backup file: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

/**
 * Validates the entered 12-word recovery code against the stored
 * encrypted_recovery_code blob (or fetched remotely from the server), then
 * re-encrypts the identity keys under the new passphrase if validation succeeds.
 */
async function handleRecoveryReset() {
  const enteredCode = (document.getElementById('recovery-code-input').value || '').trim().toLowerCase();
  const newPassphrase = (document.getElementById('recovery-new-passphrase').value || '').trim();
  const fpInput = (document.getElementById('recovery-fingerprint-input')?.value || '').trim();
  const errorEl = document.getElementById('recovery-error');

  errorEl.classList.add('hidden');

  const words = enteredCode.split(/\s+/).filter(w => w.length > 0);
  if (words.length !== 12) {
    errorEl.textContent = 'Please enter all 12 words of your recovery code.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (newPassphrase.length < 8) {
    errorEl.textContent = 'New passphrase must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }

  let encryptedRecovery = localStorage.getItem('encrypted_recovery_code');
  if (!encryptedRecovery && fpInput) {
    try {
      const res = await fetch(`${window.location.origin}/api/auth/recovery/${fpInput}`);
      if (res.ok) {
        const data = await res.json();
        encryptedRecovery = data.recovery_blob;
        localStorage.setItem('encrypted_recovery_code', encryptedRecovery);
      }
    } catch (err) {
      console.warn('Remote recovery lookup failed:', err);
    }
  }

  if (!encryptedRecovery) {
    errorEl.textContent = 'No recovery code is stored for this identity. If using a new device, enter your fingerprint above.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const blob = JSON.parse(encryptedRecovery);
    const sodium = window.sodium;

    // Derive the recovery wrapping key from the recovery code phrase
    const recoveryKey = window.SecureCrypto.deriveKeyFromPassphrase(enteredCode, blob.salt);

    let decryptedJson;
    try {
      decryptedJson = window.SecureCrypto.decrypt(blob.ciphertext, blob.nonce, recoveryKey);
    } finally {
      sodium.memzero(recoveryKey);
    }

    const keys = JSON.parse(decryptedJson);

    // Load keys into session
    clientSession.identityPublicKey = keys.identityPublicKey;
    clientSession.identityPrivateKey = keys.identityPrivateKey;
    clientSession.preKeyPublicKey = keys.preKeyPublicKey;
    clientSession.preKeyPrivateKey = keys.preKeyPrivateKey;
    clientSession.identityKeyHash = keys.identityKeyHash;

    // Re-encrypt under the new passphrase
    encryptAndStoreKeys(newPassphrase);

    showToast('Passphrase reset successfully! Entering messenger…', 'success', 4000);
    setTimeout(() => enterChatDashboard(), 1500);

  } catch (err) {
    errorEl.textContent = 'Incorrect recovery code. Decryption failed.';
    errorEl.classList.remove('hidden');
  }
}

// ─── Phase 5: Automated Prekey Rotation & Advanced Security ───────────

/**
 * Periodically rotates the client's X25519 prekey keypair upon session unlock.
 * Signs the new prekey with the long-term Ed25519 identity key and publishes it to the server.
 */
async function rotatePreKey() {
  if (!clientSession.identityPrivateKey || !clientSession.identityPublicKey) return;
  try {
    const newPreKeys = window.SecureCrypto.generatePreKeyPair();
    const newSig = window.SecureCrypto.signPreKey(clientSession.identityPrivateKey, newPreKeys.publicKey);

    const res = await fetch(`${window.location.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_identity_key: clientSession.identityPublicKey,
        public_prekey: newPreKeys.publicKey,
        prekey_signature: newSig
      })
    });

    if (res.ok) {
      clientSession.preKeyPublicKey = newPreKeys.publicKey;
      clientSession.preKeyPrivateKey = newPreKeys.privateKey;

      if (clientSession.unlockedPassphrase) {
        encryptAndStoreKeys(clientSession.unlockedPassphrase);
      }
      console.log('🔄 Automated X25519 prekey rotation completed successfully.');
    }
  } catch (err) {
    console.warn('Automated prekey rotation skipped:', err.message);
  }
}
