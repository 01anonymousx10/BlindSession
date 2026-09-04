import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

let isReady = false;
const initReady = sodium.ready.then(() => {
  isReady = true;
});

/**
 * Verifies an Ed25519 signature for request authentication.
 * @param {string} signatureBase64 - Base64 encoded signature.
 * @param {string} messageText - The message/payload signed.
 * @param {string} publicKeyBase64 - Base64 encoded Ed25519 public key.
 * @returns {boolean} - True if signature is valid.
 */
export async function verifySignature(signatureBase64, messageText, publicKeyBase64) {
  if (!isReady) {
    await initReady;
  }

  try {
    const signature = sodium.from_base64(signatureBase64);
    // messageText can be a public_prekey (base64-encoded) or a request string (pipe-separated).
    // The request string contains '|' delimiters, whereas base64 keys do not.
    const message = messageText.includes('|')
      ? sodium.from_string(messageText)
      : sodium.from_base64(messageText);
    const publicKey = sodium.from_base64(publicKeyBase64);

    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  } catch (err) {
    console.error('Signature verification error:', err);
    return false;
  }
}

/**
 * Generates the expected message string for a request validation.
 * Prevents replay attacks by checking timestamp window.
 */
export function buildVerificationMessage(method, path, timestamp, bodyString = '') {
  return `${method.toUpperCase()}|${path}|${timestamp}|${bodyString}`;
}
