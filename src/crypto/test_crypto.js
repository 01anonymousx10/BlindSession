import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

async function runTests() {
  await sodium.ready;
  console.log('🚀 Starting Client-Side Cryptographic Tests...');

  let testPassed = true;

  try {
    // 1. Generate Keypairs
    console.log('\nStep 1: Generating Keypairs for Alice & Bob...');
    const aliceIdentity = sodium.crypto_sign_keypair();
    const alicePrekey = sodium.crypto_box_keypair();

    const bobIdentity = sodium.crypto_sign_keypair();
    const bobPrekey = sodium.crypto_box_keypair();

    console.log('✅ Keypairs generated.');

    // 2. Proof-of-Ownership Signatures
    console.log('\nStep 2: Testing Prekey Signature & Verification...');
    const bobPrekeyPubBase64 = sodium.to_base64(bobPrekey.publicKey);
    
    // Bob signs his prekey with his identity key
    const signature = sodium.crypto_sign_detached(bobPrekey.publicKey, bobIdentity.privateKey);
    const signatureBase64 = sodium.to_base64(signature);

    // Verify Bob's signature on his prekey
    const isSignatureValid = sodium.crypto_sign_verify_detached(
      sodium.from_base64(signatureBase64),
      sodium.from_base64(bobPrekeyPubBase64),
      bobIdentity.publicKey
    );

    if (isSignatureValid) {
      console.log('✅ Bob prekey signature verified successfully.');
    } else {
      console.error('❌ Bob prekey signature verification failed.');
      testPassed = false;
    }

    // 3. Diffie-Hellman Key Agreement (X25519) & Key Derivation (GenericHash/Blake2b)
    console.log('\nStep 3: Simulating DH Key Agreement between Alice & Bob...');
    
    // Alice derives shared secret and session key using Bob's public prekey
    const aliceSharedSecret = sodium.crypto_scalarmult(alicePrekey.privateKey, bobPrekey.publicKey);
    const aliceSessionKey = sodium.crypto_generichash(32, aliceSharedSecret);

    // Bob derives shared secret and session key using Alice's public prekey
    const bobSharedSecret = sodium.crypto_scalarmult(bobPrekey.privateKey, alicePrekey.publicKey);
    const bobSessionKey = sodium.crypto_generichash(32, bobSharedSecret);

    // Verify that both derived the same key
    const keysMatch = sodium.memcmp(aliceSessionKey, bobSessionKey);
    if (keysMatch) {
      console.log('✅ Key Agreement Succeeded! Symmetric session keys match.');
    } else {
      console.error('❌ Key Agreement Failed: Session keys do not match.');
      testPassed = false;
    }

    // Clean memory
    sodium.memzero(aliceSharedSecret);
    sodium.memzero(bobSharedSecret);

    // 4. XChaCha20-Poly1305 Symmetric Message Encryption & Decryption
    console.log('\nStep 4: Simulating E2EE Message transmission...');
    const plainText = "Secret message: Antigravity is pairs coding with User!";
    const plainTextBytes = sodium.from_string(plainText);

    // Alice encrypts message with the derived session key
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plainTextBytes,
      null,
      null,
      nonce,
      aliceSessionKey
    );

    console.log(`- Ciphertext (Base64): ${sodium.to_base64(ciphertext)}`);
    console.log(`- Nonce (Base64): ${sodium.to_base64(nonce)}`);

    // Bob decrypts message with his session key
    const decryptedBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      bobSessionKey
    );
    const decryptedText = sodium.to_string(decryptedBytes);

    if (decryptedText === plainText) {
      console.log(`✅ Decryption Succeeded! Plaintext matches: "${decryptedText}"`);
    } else {
      console.error(`❌ Decryption Failed: Decrypted text does not match.`);
      testPassed = false;
    }

    // 5. Symmetric Message Ratchet (Double Ratchet Lite) Simulation
    console.log('\nStep 5: Testing Symmetric Message Ratchet (Double Ratchet Lite)...');
    
    // Alice and Bob start with initial synchronized chain key
    let aliceChainKey = sodium.crypto_generichash(32, aliceSessionKey);
    let bobChainKey = sodium.crypto_generichash(32, bobSessionKey);

    const msgKeyTag = sodium.from_string('MESSAGE_KEY');
    const chainKeyTag = sodium.from_string('CHAIN_KEY');

    // Message 1 from Alice to Bob
    const aliceMsgKey1 = sodium.crypto_generichash(32, msgKeyTag, aliceChainKey);
    aliceChainKey = sodium.crypto_generichash(32, chainKeyTag, aliceChainKey);

    const rNonce1 = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const rCiphertext1 = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      sodium.from_string("Ratcheted message 1"),
      null, null, rNonce1, aliceMsgKey1
    );
    sodium.memzero(aliceMsgKey1);

    // Bob processes Message 1
    const bobMsgKey1 = sodium.crypto_generichash(32, msgKeyTag, bobChainKey);
    bobChainKey = sodium.crypto_generichash(32, chainKeyTag, bobChainKey);

    const rDecrypted1 = sodium.to_string(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, rCiphertext1, null, rNonce1, bobMsgKey1)
    );
    sodium.memzero(bobMsgKey1);

    if (rDecrypted1 === "Ratcheted message 1") {
      console.log('✅ Ratchet Message 1 encrypted & decrypted successfully.');
    } else {
      console.error('❌ Ratchet Message 1 failed.');
      testPassed = false;
    }

    // Message 2 from Alice to Bob (with stepped chain keys)
    const aliceMsgKey2 = sodium.crypto_generichash(32, msgKeyTag, aliceChainKey);
    aliceChainKey = sodium.crypto_generichash(32, chainKeyTag, aliceChainKey);

    const rNonce2 = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const rCiphertext2 = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      sodium.from_string("Ratcheted message 2 (new one-time key)"),
      null, null, rNonce2, aliceMsgKey2
    );
    sodium.memzero(aliceMsgKey2);

    // Bob processes Message 2
    const bobMsgKey2 = sodium.crypto_generichash(32, msgKeyTag, bobChainKey);
    bobChainKey = sodium.crypto_generichash(32, chainKeyTag, bobChainKey);

    const rDecrypted2 = sodium.to_string(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, rCiphertext2, null, rNonce2, bobMsgKey2)
    );
    sodium.memzero(bobMsgKey2);

    if (rDecrypted2 === "Ratcheted message 2 (new one-time key)") {
      console.log('✅ Ratchet Message 2 encrypted & decrypted successfully with fresh forward-secret key.');
    } else {
      console.error('❌ Ratchet Message 2 failed.');
      testPassed = false;
    }

  } catch (err) {
    console.error('❌ Exception thrown during test execution:', err);
    testPassed = false;
  }

  console.log('\n=========================================');
  if (testPassed) {
    console.log('🎉 ALL CRYPTOGRAPHIC TESTS PASSED!');
    process.exitCode = 0;
  } else {
    console.error('❌ ONE OR MORE TESTS FAILED.');
    process.exitCode = 1;
  }
}

runTests();
