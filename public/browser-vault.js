(() => {
  const DB_NAME = 'hexigrid-standalone-v1';
  const STORE = 'vault';
  const RECORD = 'encrypted-state';
  let memoryKey = null;
  let memoryState = null;
  let queue = Promise.resolve();

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('This browser could not open its private storage.'));
    });
  }

  async function record(mode, value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const request = mode === 'readonly' ? store.get(RECORD) : store.put(value, RECORD);
      let result;
      request.onsuccess = () => { result = request.result; if (mode === 'readonly') { db.close(); resolve(result); } };
      request.onerror = () => { db.close(); reject(new Error('This browser could not access its encrypted storage.')); };
      transaction.oncomplete = () => { if (mode === 'readwrite') { db.close(); resolve(result); } };
      transaction.onabort = () => { db.close(); reject(new Error('This browser could not save its encrypted storage.')); };
    });
  }

  async function status() {
    const envelope = await record('readonly');
    return { configured: Boolean(envelope), unlocked: Boolean(memoryKey && memoryState) };
  }

  async function setup(passcode, initialState) {
    if ((await status()).configured) throw new Error('A browser vault already exists on this device.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    memoryKey = await window.HexiGridBrowserCrypto.deriveKey(passcode, salt);
    memoryState = structuredClone(initialState);
    const envelope = await window.HexiGridBrowserCrypto.seal({ marker: 'hexigrid-standalone-state', state: memoryState }, memoryKey, { salt: window.HexiGridBrowserCrypto.bytesToBase64(salt) });
    await record('readwrite', envelope);
  }

  async function unlock(passcode) {
    const envelope = await record('readonly');
    if (!envelope?.salt) throw new Error('Create a browser passcode first.');
    const key = await window.HexiGridBrowserCrypto.deriveKey(passcode, window.HexiGridBrowserCrypto.base64ToBytes(envelope.salt), Number(envelope.iterations) || window.HexiGridBrowserCrypto.ITERATIONS);
    const value = await window.HexiGridBrowserCrypto.open(envelope, key);
    if (value?.marker !== 'hexigrid-standalone-state' || !value.state) throw new Error('The browser vault is not valid.');
    memoryKey = key;
    memoryState = value.state;
    return structuredClone(memoryState);
  }

  function lock() { memoryKey = null; memoryState = null; }

  function read() {
    if (!memoryKey || !memoryState) throw new Error('Unlock this browser first.');
    return structuredClone(memoryState);
  }

  function write(nextState) {
    if (!memoryKey) return Promise.reject(new Error('Unlock this browser first.'));
    memoryState = structuredClone(nextState);
    queue = queue.then(async () => {
      const current = await record('readonly');
      const envelope = await window.HexiGridBrowserCrypto.seal({ marker: 'hexigrid-standalone-state', state: memoryState }, memoryKey, { salt: current.salt });
      await record('readwrite', envelope);
    });
    return queue;
  }

  async function replaceFromBackup(state) {
    const prior = read();
    memoryState = structuredClone(state);
    await write(memoryState);
    return prior;
  }

  window.HexiGridBrowserVault = Object.freeze({ status, setup, unlock, lock, read, write, replaceFromBackup });
})();
