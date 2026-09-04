// public/assets/js/crypto.js
// Client-side Cryptography Module using Libsodium (WASM)

class SecureCrypto {
  constructor() {
    this.sodium = null;
  }

  // Initialize libsodium
  async init() {
    if (this.sodium) return;
    // Wait for the WASM build to load
    await window.sodium.ready;
    this.sodium = window.sodium;
  }

  /**
   * Generates a long-term Ed25519 Signing Keypair for identity and authentication.
   */
  generateIdentityKeyPair() {
    const keyPair = this.sodium.crypto_sign_keypair();
    return {
      publicKey: this.sodium.to_base64(keyPair.publicKey),
      privateKey: this.sodium.to_base64(keyPair.privateKey)
    };
  }

  /**
   * Generates an Ephemeral X25519 Keypair for Diffie-Hellman key exchange.
   */
  generatePreKeyPair() {
    const keyPair = this.sodium.crypto_box_keypair();
    return {
      publicKey: this.sodium.to_base64(keyPair.publicKey),
      privateKey: this.sodium.to_base64(keyPair.privateKey)
    };
  }

  /**
   * Signs the X25519 Prekey with the Ed25519 Identity Private Key.
   */
  signPreKey(identityPrivateKeyBase64, preKeyPublicKeyBase64) {
    const identityPrivateKey = this.sodium.from_base64(identityPrivateKeyBase64);
    const preKeyPublicKey = this.sodium.from_base64(preKeyPublicKeyBase64);
    
    const signature = this.sodium.crypto_sign_detached(preKeyPublicKey, identityPrivateKey);
    return this.sodium.to_base64(signature);
  }

  /**
   * Derives a 32-byte symmetric key from a passphrase + salt using Argon2id.
   *
   * This replaces the old derivation (crypto_generichash(passphrase)) used to
   * encrypt the local identity blob, which had no salt and no work factor — a
   * weak passphrase could be brute-forced offline in milliseconds. Argon2id is
   * memory-hard and takes a per-identity random salt, so each identity has its
   * own work target and identical passphrases don't collide.
   *
   * @param {string} passphrase - User passphrase (UTF-8 text).
   * @param {string} saltBase64 - Per-identity random salt, base64 (stored
   *   alongside the ciphertext in the blob).
   * @returns {Uint8Array} 32-byte derived key. Caller MUST sodium.memzero it.
   */
  deriveKeyFromPassphrase(passphrase, saltBase64) {
    // crypto_pwhash needs a salt of exactly crypto_pwhash_SALTBYTES (16) bytes.
    const salt = this.sodium.from_base64(saltBase64);

    // ALG_ARGON2ID13 is the Argon2id algorithm constant in this libsodium
    // build (also what ALG_DEFAULT resolves to). Pinned explicitly so the KDF
    // is stable regardless of any future default change.
    const key = this.sodium.crypto_pwhash(
      32, // 256-bit output, matching the XChaCha20 key size
      passphrase,
      salt,
      this.sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, // ~2 ops, sane for interactive unlock
      this.sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, // ~64 MiB, raises brute-force cost
      this.sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    return key; // Uint8Array of size 32
  }

  /**
   * Performs X25519 DH key agreement and derives a 256-bit symmetric session key.
   */
  deriveSessionKey(myPrivateKeyBase64, recipientPublicKeyBase64) {
    const myPrivateKey = this.sodium.from_base64(myPrivateKeyBase64);
    const recipientPublicKey = this.sodium.from_base64(recipientPublicKeyBase64);

    // Compute shared secret using Scalar Multiplication (Diffie-Hellman over Curve25519)
    const sharedSecret = this.sodium.crypto_scalarmult(myPrivateKey, recipientPublicKey);

    // Derive symmetric key by hashing the shared secret (using GenericHash / Blake2b)
    const sessionKey = this.sodium.crypto_generichash(32, sharedSecret);
    
    // Clear sensitive buffers
    this.sodium.memzero(sharedSecret);

    return sessionKey; // Uint8Array of size 32
  }

  /**
   * Encrypts a message string using XChaCha20-Poly1305 AEAD.
   */
  encrypt(plainText, sessionKey) {
    const messageBytes = this.sodium.from_string(plainText);
    
    // Generate a random 24-byte nonce (required for XChaCha20)
    const nonce = this.sodium.randombytes_buf(this.sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    
    const ciphertext = this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      messageBytes,
      null, // No additional authenticated data
      null, // Secures decryption validation
      nonce,
      sessionKey
    );

    return {
      ciphertext: this.sodium.to_base64(ciphertext),
      nonce: this.sodium.to_base64(nonce)
    };
  }

  /**
   * Decrypts an XChaCha20-Poly1305 ciphertext payload.
   *
   * THROWS on failure (tampered ciphertext, wrong key, Poly1305 tag mismatch).
   * It never returns an error string — callers must handle the exception and
   * drop the undecryptable message silently rather than persist it.
   * Returns the plaintext string on success.
   */
  decrypt(ciphertextBase64, nonceBase64, sessionKey) {
    const ciphertext = this.sodium.from_base64(ciphertextBase64);
    const nonce = this.sodium.from_base64(nonceBase64);

    // Let the AEAD decrypt throw naturally on integrity failure. We rethrow a
    // clean Error so callers get a stable message regardless of the underlying
    // libsodium exception text.
    let decryptedBytes;
    try {
      decryptedBytes = this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        null,
        nonce,
        sessionKey
      );
    } catch (err) {
      throw new Error('Decryption failed: integrity check failed or wrong key');
    }

    return this.sodium.to_string(decryptedBytes);
  }

  /**
   * Performs a symmetric ratchet step from a chain key to derive a message key and next chain key.
   * Provides forward & backward secrecy via Blake2b KDF step.
   * @param {Uint8Array|string} chainKey - Current 32-byte chain key (Uint8Array or base64).
   * @returns {{ messageKey: Uint8Array, nextChainKey: Uint8Array }}
   */
  ratchetStep(chainKey) {
    const keyBytes = typeof chainKey === 'string' ? this.sodium.from_base64(chainKey) : chainKey;
    const msgKeyTag = this.sodium.from_string('MESSAGE_KEY');
    const chainKeyTag = this.sodium.from_string('CHAIN_KEY');

    const messageKey = this.sodium.crypto_generichash(32, msgKeyTag, keyBytes);
    const nextChainKey = this.sodium.crypto_generichash(32, chainKeyTag, keyBytes);

    return { messageKey, nextChainKey };
  }

  /**
   * Encrypts a message using a one-time message key derived from the symmetric ratchet chain key.
   * Immediately clears the one-time message key from memory.
   */
  ratchetEncrypt(plainText, chainKey) {
    const { messageKey, nextChainKey } = this.ratchetStep(chainKey);
    try {
      const encrypted = this.encrypt(plainText, messageKey);
      return {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        nextChainKey: nextChainKey
      };
    } finally {
      this.sodium.memzero(messageKey);
    }
  }

  /**
   * Decrypts a message using a one-time message key derived from the symmetric ratchet chain key.
   * Immediately clears the one-time message key from memory.
   */
  ratchetDecrypt(ciphertextBase64, nonceBase64, chainKey) {
    const { messageKey, nextChainKey } = this.ratchetStep(chainKey);
    try {
      const plainText = this.decrypt(ciphertextBase64, nonceBase64, messageKey);
      return {
        plainText: plainText,
        nextChainKey: nextChainKey
      };
    } finally {
      this.sodium.memzero(messageKey);
    }
  }

  /**
   * Computes a SHA-256 fingerprint hash of a public key.
   */
  computeHash(publicKeyBase64) {
    const publicKey = this.sodium.from_base64(publicKeyBase64);
    const hash = this.sodium.crypto_hash_sha256(publicKey);
    return this.sodium.to_hex(hash);
  }

  /**
   * Verifies an Ed25519 signature of a signed message (typically base64 encoded).
   */
  async verifySignature(signatureBase64, messageText, publicKeyBase64) {
    if (!this.sodium) {
      await this.init();
    }
    try {
      const signature = this.sodium.from_base64(signatureBase64);
      const message = messageText.includes('|')
        ? this.sodium.from_string(messageText)
        : this.sodium.from_base64(messageText);
      const publicKey = this.sodium.from_base64(publicKeyBase64);

      return this.sodium.crypto_sign_verify_detached(signature, message, publicKey);
    } catch (err) {
      console.error('Signature verification error:', err);
      return false;
    }
  }

  /**
   * Signs API requests to authenticate identity.
   */
  signRequest(privateKeyBase64, method, path, timestamp, bodyString = '') {
    const privateKey = this.sodium.from_base64(privateKeyBase64);
    const payloadString = `${method.toUpperCase()}|${path}|${timestamp}|${bodyString}`;
    const payloadBytes = this.sodium.from_string(payloadString);
    
    const signature = this.sodium.crypto_sign_detached(payloadBytes, privateKey);
    return this.sodium.to_base64(signature);
  }

  /**
   * Deterministically maps a hex session ID hash to an Adjective + Noun name.
   * @param {string} hash - The hex string to map.
   * @returns {string} Deterministic name (e.g. "Crimson Falcon").
   */
  hashToName(hash) {
    if (!hash || hash.length < 4) return 'Unknown User';
    
    // Parse the first two bytes as indices (value 0-255)
    const b0 = parseInt(hash.substring(0, 2), 16);
    const b1 = parseInt(hash.substring(2, 4), 16);

    const adjIndex = isNaN(b0) ? 0 : b0;
    const nounIndex = isNaN(b1) ? 0 : b1;

    const adjectives = [
      'Quiet', 'Silent', 'Swift', 'Fast', 'Slow', 'Calm', 'Brave', 'Bold', 'Bright', 'Dark',
      'Light', 'Shiny', 'Dull', 'Sharp', 'Blunt', 'Wild', 'Tame', 'Deep', 'Shallow', 'High',
      'Low', 'Great', 'Grand', 'Tiny', 'Huge', 'Vast', 'Smart', 'Wise', 'Clever', 'Agile',
      'Quick', 'Rapid', 'Gentle', 'Fierce', 'Strong', 'Weak', 'Hefty', 'Sturdy', 'Candid', 'Vivid',
      'Warm', 'Cold', 'Cool', 'Hot', 'Crisp', 'Frosty', 'Sunny', 'Stormy', 'Windy', 'Breezy',
      'Misty', 'Foggy', 'Hazy', 'Clear', 'Pure', 'Sweet', 'Sour', 'Bitter', 'Salty', 'Fresh',
      'Stale', 'Ripe', 'Green', 'Red', 'Blue', 'Pink', 'Gold', 'Silver', 'Bronze', 'Copper',
      'Iron', 'Steel', 'Stone', 'Wood', 'Clay', 'Soft', 'Hard', 'Smooth', 'Rough', 'Tough',
      'Loose', 'Tight', 'Near', 'Far', 'First', 'Last', 'Next', 'Prior', 'Old', 'Young',
      'New', 'Safe', 'Grim', 'Jolly', 'Merry', 'Happy', 'Sad', 'Proud', 'Humble', 'Polite',
      'Rude', 'Kind', 'Cruel', 'Fair', 'Just', 'Noble', 'Royal', 'Elite', 'Prime', 'Chief',
      'Major', 'Minor', 'Basic', 'Core', 'Vocal', 'Mute', 'Active', 'Idle', 'Lazy', 'Busy',
      'Heavy', 'Thin', 'Thick', 'Wide', 'Narrow', 'Flat', 'Round', 'Square', 'Brilliant', 'Cunning',
      'Keen', 'Eager', 'Alert', 'Wary', 'Cautious', 'Stern', 'Grave', 'Solemn', 'Earnest', 'Frank',
      'Open', 'Plain', 'Simple', 'Nifty', 'Slick', 'Snazzy', 'Spry', 'Fleet', 'Nimble', 'Speedy',
      'Prompt', 'Hasty', 'Brisk', 'Lively', 'Peppy', 'Zesty', 'Spicy', 'Sweet', 'Mild', 'Bland',
      'Rich', 'Fancy', 'Cozy', 'Snug', 'Roomy', 'Broad', 'Ample', 'Large', 'Giant', 'Epic',
      'Heroic', 'Super', 'Mega', 'Hyper', 'Ultra', 'Apex', 'Optimum', 'Peak', 'Top', 'Lush',
      'Verdant', 'Radiant', 'Glowing', 'Beaming', 'Vibrant', 'Cheery', 'Jovial', 'Blissful', 'Joyful', 'Glad',
      'Playful', 'Frisky', 'Daring', 'Valiant', 'Gutsy', 'Spunky', 'Audacious', 'Fearless', 'Dauntless', 'Intrepid',
      'Stout', 'Hardy', 'Rugged', 'Robust', 'Hale', 'Fit', 'Lithe', 'Spirited', 'Gilded', 'Rust',
      'Amber', 'Citron', 'Azure', 'Cobalt', 'Violet', 'Indigo', 'Crimson', 'Onyx', 'Pearl', 'Coral',
      'Sienna', 'Ocher', 'Plum', 'Teal', 'Olive', 'Khaki', 'Ivory', 'Ebony', 'Fawn', 'Taupe',
      'Beige', 'Sand', 'Ash', 'Flint', 'Slate', 'Lead', 'Zinc', 'Tin', 'Mint', 'Lime',
      'Sage', 'Pine', 'Fir', 'Elm', 'Oak', 'Yew', 'Fern', 'Moss', 'Kelp', 'Rose',
      'Lily', 'Iris', 'Lotus', 'Thyme', 'Dappled', 'Sleek', 'Dusky', 'Sable', 'Grizzly', 'Tawny',
      'Dashing', 'Glossy'
    ];

    const nouns = [
      'Falcon', 'Eagle', 'Hawk', 'Raven', 'Crow', 'Owl', 'Lark', 'Wren', 'Robin', 'Dove',
      'Swan', 'Heron', 'Crane', 'Gull', 'Tern', 'Jay', 'Finch', 'Swift', 'Martin', 'Swallow',
      'Lion', 'Tiger', 'Leopard', 'Jaguar', 'Panther', 'Cougar', 'Puma', 'Cheetah', 'Wolf', 'Fox',
      'Coyote', 'Jackal', 'Dingo', 'Bear', 'Panda', 'Badger', 'Otter', 'Marten', 'Weasel', 'Ferret',
      'Mink', 'Sable', 'Beaver', 'Squirrel', 'Rabbit', 'Hare', 'Deer', 'Elk', 'Moose', 'Caribou',
      'Bison', 'Buffalo', 'Yak', 'Ibex', 'Oryx', 'Gazelle', 'Antelope', 'Goat', 'Sheep', 'Ram',
      'Bull', 'Stallion', 'Mare', 'Colt', 'Filly', 'Mustang', 'Pony', 'Zebra', 'Donkey', 'Mule',
      'Camel', 'Llama', 'Alpaca', 'Dolphin', 'Whale', 'Orca', 'Seal', 'Walrus', 'Platypus', 'Shark',
      'Ray', 'Salmon', 'Trout', 'Bass', 'Pike', 'Perch', 'Cod', 'Tuna', 'Marlin', 'Swordfish',
      'Crab', 'Lobster', 'Shrimp', 'Clam', 'Oyster', 'Octopus', 'Squid', 'Snail', 'Slug', 'Gecko',
      'Lizard', 'Iguana', 'Chameleon', 'Turtle', 'Tortoise', 'Frog', 'Toad', 'Newt', 'Salamander',
      'Dragon', 'Phoenix', 'Griffin', 'Sphinx', 'Pegasus', 'Unicorn', 'Centaur', 'Minotaur', 'Wyvern', 'Basilisk',
      'Kraken', 'Hydra', 'Chimera', 'Gargoyle', 'Golem', 'Wraith', 'Ghost', 'Spirit', 'Shadow', 'Phantom',
      'Specter', 'Apparition', 'Oak', 'Pine', 'Maple', 'Birch', 'Willow', 'Cedar', 'Redwood', 'Sequoia',
      'Cypress', 'Spruce', 'Fir', 'Larch', 'Ash', 'Elm', 'Beech', 'Chestnut', 'Walnut', 'Hickory',
      'Alder', 'Poplar', 'Rowan', 'Hazel', 'Yew', 'Holly', 'Ivy', 'Fern', 'Moss', 'Lichen',
      'Clover', 'Rose', 'Lily', 'Tulip', 'Daisy', 'Orchid', 'Lotus', 'Iris', 'Violet', 'Jasmine',
      'Lavender', 'Mint', 'Sage', 'Thyme', 'Basil', 'Reed', 'Bamboo', 'Stone', 'Rock', 'Boulder',
      'Pebble', 'Gravel', 'Sand', 'Dust', 'Clay', 'Silt', 'Mud', 'Soil', 'Earth', 'Gold',
      'Silver', 'Copper', 'Bronze', 'Iron', 'Steel', 'Brass', 'Glass', 'Crystal', 'Amber', 'Ruby',
      'Emerald', 'Sapphire', 'Opal', 'Pearl', 'Jade', 'Quartz', 'Flint', 'Obsidian', 'Basalt', 'Granite',
      'Marble', 'Slate', 'Shale', 'Coal', 'Cloud', 'Mist', 'Fog', 'Haze', 'Rain', 'Storm',
      'Wind', 'Gale', 'Breeze', 'Zephyr', 'Wave', 'Tide', 'Current', 'Eddy', 'Vortex', 'Flame',
      'Spark', 'Ember', 'Ashes', 'Smoke', 'Light', 'Beam', 'Ray', 'Glow', 'Halo', 'Ring',
      'Crescent', 'Star', 'Meteor', 'Comet', 'Planet', 'Moon', 'Sun', 'Nova', 'Galaxy', 'Cosmos',
      'Apex', 'Zenith', 'Summit', 'Peak', 'Ridge', 'Canyon', 'Valley'
    ];

    const adj = adjectives[adjIndex % adjectives.length];
    const noun = nouns[nounIndex % nouns.length];
    return `${adj} ${noun}`;
  }
}

// Export a global instance
window.SecureCrypto = new SecureCrypto();
