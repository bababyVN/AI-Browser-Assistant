/**
 * lib/crypto.js — Secure API Key Encryption using Web Crypto API (AES-GCM)
 * Uses Structured Clone to store CryptoKey objects directly in chrome.storage.local
 */

const KEY_NAME = 'encryption_key_v1';

/**
 * Gets the existing CryptoKey or creates a new one.
 * The CryptoKey object is saved directly to chrome.storage.local using Structured Clone.
 * @returns {Promise<CryptoKey>}
 */
async function getOrCreateKey() {
  const data = await chrome.storage.local.get(KEY_NAME);
  if (data[KEY_NAME]) {
    try {
      if (data[KEY_NAME] instanceof CryptoKey) {
        return data[KEY_NAME];
      }
      const key = await crypto.subtle.importKey(
        'jwk',
        data[KEY_NAME],
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt']
      );
      return key;
    } catch (err) {
      console.warn('[Crypto] Failed to import key, generating new one:', err);
    }
  }

  // Generate a new AES-GCM key
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    ['encrypt', 'decrypt']
  );

  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chrome.storage.local.set({ [KEY_NAME]: jwk });
  return key;
}

/**
 * Encrypts a plain-text API key.
 * @param {string} plainText - The API key in plain text
 * @returns {Promise<{ ciphertext: number[], iv: number[] }|null>}
 */
export async function encryptKey(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 12-byte IV for AES-GCM
    const encoder = new TextEncoder();
    const encoded = encoder.encode(plainText);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );

    return {
      ciphertext: Array.from(new Uint8Array(ciphertext)),
      iv: Array.from(iv)
    };
  } catch (err) {
    console.error('[Crypto] Encryption failed:', err);
    return null;
  }
}

/**
 * Decrypts an encrypted API key object.
 * @param {{ ciphertext: number[], iv: number[] }|string} encryptedObj - The encrypted key object
 * @returns {Promise<string|null>} The decrypted key in plain text, or the input if it was not encrypted
 */
export async function decryptKey(encryptedObj) {
  if (!encryptedObj) return null;
  
  // If it's already a plain text string (legacy/not encrypted yet), return it directly
  if (typeof encryptedObj === 'string') {
    return encryptedObj;
  }

  if (!encryptedObj.ciphertext || !encryptedObj.iv) {
    return null;
  }

  try {
    const key = await getOrCreateKey();
    const ciphertext = new Uint8Array(encryptedObj.ciphertext);
    const iv = new Uint8Array(encryptedObj.iv);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (err) {
    console.error('[Crypto] Decryption failed:', err);
    return null;
  }
}
