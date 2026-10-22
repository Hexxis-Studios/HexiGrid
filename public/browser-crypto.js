(() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const ITERATIONS = 600000;

  function bytesToBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function deriveKey(passcode, salt, iterations = ITERATIONS) {
    if (typeof passcode !== 'string' || passcode.length < 10) throw new Error('Use a passcode with at least 10 characters.');
    const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function seal(value, key, extra = {}) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    return { format: 'hexigrid-browser-vault', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext), ...extra };
  }

  async function open(envelope, key) {
    if (!envelope || envelope.format !== 'hexigrid-browser-vault' || envelope.version !== 1) throw new Error('This is not a supported HexiGrid browser vault.');
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
      return JSON.parse(decoder.decode(plaintext));
    } catch {
      throw new Error('That passcode is not correct, or the saved browser data is damaged.');
    }
  }

  async function encryptWithPassphrase(value, passphrase, purpose = 'backup') {
    if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Use a backup phrase with at least 12 characters.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    return seal(value, key, { purpose, salt: bytesToBase64(salt), createdAt: new Date().toISOString() });
  }

  async function decryptWithPassphrase(envelope, passphrase, purpose = 'backup') {
    if (envelope?.purpose !== purpose || !envelope?.salt) throw new Error('This encrypted file has the wrong purpose or format.');
    const key = await deriveKey(passphrase, base64ToBytes(envelope.salt), Number(envelope.iterations) || ITERATIONS);
    return open(envelope, key);
  }

  window.HexiGridBrowserCrypto = Object.freeze({ ITERATIONS, bytesToBase64, base64ToBytes, deriveKey, seal, open, encryptWithPassphrase, decryptWithPassphrase });
})();
