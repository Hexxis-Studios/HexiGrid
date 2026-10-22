import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FORMAT = 'hexigrid-local-state';
const LEGACY_FORMAT = 'aveniq-local-state';
const VERSION = 1;
const CIPHER = 'aes-256-gcm';
const vaultAvailable = (vault) => typeof vault?.isAvailable !== 'function' || vault.isAvailable();

export function assertSupportedLocalState(payload, supportedVersion = 2) {
  const error = () => Object.assign(
    new Error('Local state is invalid or uses an unsupported schema version. Restore a compatible backup or update the application.'),
    { code: 'STATE_VERSION_UNSUPPORTED' }
  );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error();
  const version = payload.version == null ? 1 : payload.version;
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(supportedVersion) || version > supportedVersion) throw error();
  return payload;
}

function assertSynchronousAuthority(assertAuthorized) {
  const result = assertAuthorized();
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new TypeError('State-write authorization must be synchronous.');
  }
  if (result === false || result?.allowed === false) throw Object.assign(new Error('State write is no longer authorized.'), { status: 403 });
}

/** Snapshot at the serialized write boundary. A private projection is published
 * to shared memory only after its guarded encrypted write succeeds. */
export function createStateSaveQueue({ getState, store }) {
  let queue = Promise.resolve();
  return ({ assertAuthorized = () => {}, prepareSnapshot = snapshot => snapshot, commit = () => {} } = {}) => {
    const operation = queue.catch(() => {}).then(async () => {
      assertSynchronousAuthority(assertAuthorized);
      const snapshot = prepareSnapshot(structuredClone(getState()));
      await store.write(snapshot, { assertAuthorized });
      commit();
    });
    queue = operation;
    return operation;
  };
}

function decodeKey(encoded) {
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new Error('The protected local-state key is invalid.');
  return key;
}

function encrypt(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    cipher: CIPHER,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
    writtenAt: new Date().toISOString()
  };
}

function decrypt(envelope, key) {
  if (!envelope || ![FORMAT, LEGACY_FORMAT].includes(envelope.format) || envelope.version !== VERSION || envelope.cipher !== CIPHER) {
    throw new Error('The encrypted local-state format is not supported.');
  }
  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Local data could not be decrypted. It may be damaged or belong to another operating-system account.');
  }
}

export class EncryptedStateStore {
  constructor(file, vault, { keyId = 'local-state-master-key' } = {}) {
    this.file = file;
    this.previousFile = `${file}.previous`;
    this.restorePointFile = `${file}.restore-point`;
    this.migrationPointFile = `${file}.migration-point`;
    this.migrationUndoPointFile = `${file}.migration-undo-point`;
    this.vault = vault;
    this.keyId = keyId;
    this.fallbackKeyFile = `${file}.state-key`;
    this.key = null;
    this.loadedPlaintext = false;
    this.degraded = false;
  }

  async getKey(create = true) {
    if (this.key) return this.key;
    let encoded;
    let vaultReadError;
    try { encoded = await this.vault.get(this.keyId); }
    catch (error) {
      if (create) throw error;
      vaultReadError = error;
    }
    if (!create && !encoded) {
      try { encoded = (await fs.readFile(this.fallbackKeyFile, 'utf8')).trim(); } catch { /* no fallback key exists */ }
      if (encoded) {
        this.key = decodeKey(encoded);
        return this.key;
      }
      if (vaultReadError) throw vaultReadError;
    }
    if (!vaultAvailable(this.vault)) this.degraded = true;
    if (!encoded && create) {
      encoded = crypto.randomBytes(32).toString('base64url');
      if (vaultAvailable(this.vault)) {
        try { await this.vault.set(this.keyId, encoded); }
        catch (error) {
          if (error?.code !== 'VAULT_UNAVAILABLE') throw error;
          this.degraded = true;
        }
      }
      if (!vaultAvailable(this.vault) || this.degraded) {
        this.degraded = true;
        await fs.mkdir(path.dirname(this.fallbackKeyFile), { recursive: true });
        await fs.writeFile(this.fallbackKeyFile, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(async (error) => {
          if (error.code !== 'EEXIST') throw error;
          encoded = (await fs.readFile(this.fallbackKeyFile, 'utf8')).trim();
        });
      }
    }
    if (!encoded && this.degraded) {
      try { encoded = (await fs.readFile(this.fallbackKeyFile, 'utf8')).trim(); } catch { /* no degraded key exists */ }
    }
    if (!encoded) {
      const error = new Error('The encrypted local-state key is unavailable. Restore the protected OS vault or recover this workspace from an encrypted backup.');
      error.code = 'STATE_KEY_UNAVAILABLE';
      throw error;
    }
    this.key = decodeKey(encoded);
    return this.key;
  }

  async read() {
    const raw = await fs.readFile(this.file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('The local state file is not valid JSON.'); }
    if ([FORMAT, LEGACY_FORMAT].includes(parsed?.format)) {
      if (parsed.format === LEGACY_FORMAT) this.loadedPlaintext = true;
      return decrypt(parsed, await this.getKey(false));
    }
    this.loadedPlaintext = true;
    return parsed;
  }

  async write(payload, { assertAuthorized = () => {} } = {}) {
    const guard = () => assertSynchronousAuthority(assertAuthorized);
    guard();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const envelope = encrypt(payload, await this.getKey(true));
    const temporary = `${this.file}.${process.pid}.pending`;
    try {
      guard();
      await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      if (this.loadedPlaintext) {
        // A legacy plaintext file must never be copied into the rollback slot.
        // Migration replaces it in place and starts a fresh encrypted history.
        await fs.rm(this.previousFile, { force: true });
      } else {
        try {
          await fs.copyFile(this.file, this.previousFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      guard();
      await fs.rename(temporary, this.file);
      this.loadedPlaintext = false;
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async readPrevious() {
    const parsed = JSON.parse(await fs.readFile(this.previousFile, 'utf8'));
    if (![FORMAT, LEGACY_FORMAT].includes(parsed?.format)) throw new Error('The previous state snapshot predates encrypted storage.');
    return decrypt(parsed, await this.getKey(false));
  }

  // A restore point must survive ordinary saves and process restarts. The
  // rolling previous-save slot is crash history, not an undo-restore record.
  async writeRestorePoint(payload) {
    await this.#writeEncryptedPoint(this.restorePointFile, payload);
  }

  async readRestorePoint() {
    return decrypt(JSON.parse(await fs.readFile(this.restorePointFile, 'utf8')), await this.getKey(false));
  }

  async writeMigrationPoint(payload) {
    assertSupportedLocalState(payload);
    await this.#writeEncryptedPoint(this.migrationPointFile, payload);
  }

  async readMigrationPoint() {
    const payload = decrypt(JSON.parse(await fs.readFile(this.migrationPointFile, 'utf8')), await this.getKey(false));
    return assertSupportedLocalState(payload);
  }

  async writeMigrationUndoPoint(payload) {
    assertSupportedLocalState(payload);
    await this.#writeEncryptedPoint(this.migrationUndoPointFile, payload);
  }

  async readMigrationUndoPoint() {
    const payload = decrypt(JSON.parse(await fs.readFile(this.migrationUndoPointFile, 'utf8')), await this.getKey(false));
    return assertSupportedLocalState(payload);
  }

  async #writeEncryptedPoint(file, payload) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const envelope = encrypt(payload, await this.getKey(true));
    const temporary = `${file}.${process.pid}.pending`;
    try {
      await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

export const localStateFormat = FORMAT;
