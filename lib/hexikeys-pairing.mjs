import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';

export const HEXIKEYS_PAIRING_CREDENTIAL_ID = 'hexikeys-pairing';
export const HEXIKEYS_PAIRING_DESCRIPTOR_FILENAME = 'hexikeys-pairing.dpapi';
export const MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES = 4096;

const PIPE_ID_RE = /^hexikeys-[0-9a-f]{32}$/;
const HMAC_KEY_RE = /^[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS = ['version', 'pipeId', 'hmacKey'];
const vaultQueues = new WeakMap();

function pairingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unavailableError() {
  return pairingError('HEXKEYS_PAIRING_UNAVAILABLE', 'The operating system credential vault or Windows DPAPI is unavailable.');
}

function invalidDescriptorError() {
  return pairingError('HEXKEYS_PAIRING_INVALID', 'The protected HexiKeys pairing descriptor is invalid.');
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDescriptorError();
  const keys = Object.keys(value);
  if (keys.length !== DESCRIPTOR_KEYS.length || DESCRIPTOR_KEYS.some(key => !Object.hasOwn(value, key))) throw invalidDescriptorError();
  if (value.version !== 1 || typeof value.pipeId !== 'string' || !PIPE_ID_RE.test(value.pipeId)) throw invalidDescriptorError();
  if (typeof value.hmacKey !== 'string' || !HMAC_KEY_RE.test(value.hmacKey)) throw invalidDescriptorError();
  return value;
}

function parseDescriptorBytes(plaintext) {
  if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES) {
    throw invalidDescriptorError();
  }
  let serialized;
  let value;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    value = JSON.parse(serialized);
  } catch {
    throw invalidDescriptorError();
  }
  return validateDescriptor(value);
}

function parseStoredPairing(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES) throw invalidDescriptorError();
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw invalidDescriptorError(); }
  return validateDescriptor(parsed);
}

function requireCredentialVault(vault, { requireRemove = false } = {}) {
  if (!vault || typeof vault.isAvailable !== 'function'
    || !vault.isAvailable() || typeof vault.get !== 'function'
    || typeof vault.set !== 'function' || (requireRemove && typeof vault.remove !== 'function')) throw unavailableError();
  return vault;
}

function requireAuthorize(authorize) {
  if (typeof authorize !== 'function') throw pairingError('HEXKEYS_PAIRING_UNAUTHORIZED', 'HexiKeys pairing requires an authorized owner action.');
  return authorize;
}

async function checkAuthorized(authorize, phase) {
  let decision;
  try { decision = await authorize(Object.freeze({ pairing: 'hexikeys', phase })); }
  catch { throw pairingError('HEXKEYS_PAIRING_UNAUTHORIZED', 'HexiKeys pairing authorization is no longer valid.'); }
  if (decision === false) throw pairingError('HEXKEYS_PAIRING_UNAUTHORIZED', 'HexiKeys pairing authorization is no longer valid.');
}

async function serializeByVault(vault, action) {
  const previous = vaultQueues.get(vault) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  vaultQueues.set(vault, queued);
  await previous.catch(() => {});
  try { return await action(); }
  finally {
    release();
    if (vaultQueues.get(vault) === queued) vaultQueues.delete(vault);
  }
}

async function restorePriorIfCurrent(vault, currentValue, previousValue) {
  let current;
  try { current = await vault.get(HEXIKEYS_PAIRING_CREDENTIAL_ID); }
  catch { throw pairingError('HEXKEYS_PAIRING_ROLLBACK_FAILED', 'The prior HexiKeys pairing state could not be confirmed.'); }
  if (current !== currentValue) return;
  try {
    if (previousValue === '' || previousValue === null || previousValue === undefined) {
      await vault.remove(HEXIKEYS_PAIRING_CREDENTIAL_ID, { requireAvailable: true });
    } else {
      await vault.set(HEXIKEYS_PAIRING_CREDENTIAL_ID, previousValue);
    }
  } catch {
    throw pairingError('HEXKEYS_PAIRING_ROLLBACK_FAILED', 'The prior HexiKeys pairing state could not be restored.');
  }
}

function decodeCanonicalBase64(value) {
  const encoded = value.trim();
  if (!encoded || encoded.length > 8192 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw unavailableError();
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES || bytes.toString('base64') !== encoded) {
    throw unavailableError();
  }
  return bytes;
}

/**
 * Decrypt the protected handoff using Windows DPAPI CurrentUser. The protected
 * bytes are sent on stdin and the script and key are never placed in argv.
 */
function unprotectWindowsPairingDescriptor(ciphertext, {
  spawnImpl = spawn,
  timeoutMs = 15_000,
} = {}) {
  if (process.platform !== 'win32') return Promise.reject(unavailableError());
  if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES) {
    return Promise.reject(invalidDescriptorError());
  }
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $encoded=[Console]::In.ReadToEnd(); $inputBytes=[Convert]::FromBase64String($encoded); $outputBytes=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))";
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const chunks = [];
    let outputLength = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(unavailableError());
    }, timeoutMs);
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(unavailableError());
      return;
    }
    child.stdout.on('data', chunk => {
      outputLength += chunk.length;
      if (outputLength > 8192) {
        child.kill();
        finish(unavailableError());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(unavailableError()));
    child.on('close', code => {
      if (code !== 0) {
        finish(unavailableError());
        return;
      }
      try { finish(null, decodeCanonicalBase64(Buffer.concat(chunks).toString('ascii'))); }
      catch { finish(unavailableError()); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(ciphertext.toString('base64'));
  });
}

async function readProtectedFile(descriptorPath) {
  if (typeof descriptorPath !== 'string' || !descriptorPath || descriptorPath.length > 32_768) throw invalidDescriptorError();
  let before;
  try { before = await fs.lstat(descriptorPath); } catch { throw invalidDescriptorError(); }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES) {
    throw invalidDescriptorError();
  }
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const binary = fsConstants.O_BINARY || 0;
  let handle;
  try {
    handle = await fs.open(descriptorPath, fsConstants.O_RDONLY | noFollow | binary);
    const current = await handle.stat();
    if (!current.isFile() || current.size < 1 || current.size > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES
      || (before.ino && current.ino && (before.dev !== current.dev || before.ino !== current.ino))) {
      throw invalidDescriptorError();
    }
    const buffer = Buffer.alloc(MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (!total || total > MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES) throw invalidDescriptorError();
    return Buffer.from(buffer.subarray(0, total));
  } catch (error) {
    if (error?.code === 'HEXKEYS_PAIRING_INVALID') throw error;
    throw invalidDescriptorError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Import a DPAPI descriptor into the injected OS CredentialVault. Re-importing
 * the exact same pairing is idempotent; a different active pairing is never
 * silently replaced. Only the nonsecret pipe ID is returned.
 */
export async function importHexiKeysPairing({
  descriptorPath,
  vault,
  authorize,
  decrypt,
  spawnImpl = spawn,
} = {}) {
  requireCredentialVault(vault, { requireRemove: true });
  requireAuthorize(authorize);
  if (decrypt !== undefined && typeof decrypt !== 'function') throw unavailableError();
  return serializeByVault(vault, async () => {
    await checkAuthorized(authorize, 'before-read');
    const ciphertext = await readProtectedFile(descriptorPath);
    await checkAuthorized(authorize, 'before-decrypt');
    let plaintext;
    try {
      plaintext = await (decrypt
        ? decrypt(ciphertext)
        : unprotectWindowsPairingDescriptor(ciphertext, { spawnImpl }));
    }
    catch { throw unavailableError(); }
    const descriptor = parseDescriptorBytes(plaintext);

    let existing;
    try { existing = await vault.get(HEXIKEYS_PAIRING_CREDENTIAL_ID); }
    catch { throw unavailableError(); }
    await checkAuthorized(authorize, 'before-commit');
    if (existing !== '' && existing !== null && existing !== undefined) {
      const current = parseStoredPairing(existing);
      if (current.pipeId === descriptor.pipeId && current.hmacKey === descriptor.hmacKey) {
        await checkAuthorized(authorize, 'after-read');
        return Object.freeze({ pipeId: descriptor.pipeId });
      }
      throw pairingError('HEXKEYS_PAIRING_EXISTS', 'A different HexiKeys pairing is already stored.');
    }
    const serialized = JSON.stringify(descriptor);
    try { await vault.set(HEXIKEYS_PAIRING_CREDENTIAL_ID, serialized); }
    catch {
      await restorePriorIfCurrent(vault, serialized, existing ?? '');
      throw unavailableError();
    }
    try { await checkAuthorized(authorize, 'after-write'); }
    catch (error) {
      await restorePriorIfCurrent(vault, serialized, existing ?? '');
      throw error;
    }
    return Object.freeze({ pipeId: descriptor.pipeId });
  });
}

/** Read the nonsecret identifier without returning any pairing key material. */
export async function readHexiKeysPairingMetadata(vault) {
  requireCredentialVault(vault);
  return serializeByVault(vault, async () => {
    let stored;
    try { stored = await vault.get(HEXIKEYS_PAIRING_CREDENTIAL_ID); }
    catch { throw unavailableError(); }
    if (stored === '' || stored === null || stored === undefined) return null;
    const descriptor = parseStoredPairing(stored);
    return Object.freeze({ pipeId: descriptor.pipeId });
  });
}

/**
 * Give the pairing key only to an explicitly supplied trusted local host
 * helper. The mutable key buffer is cleared when that call settles.
 */
export async function withHexiKeysPairing(vault, trustedHostHelper) {
  if (typeof trustedHostHelper !== 'function') throw new TypeError('A trusted local host helper is required.');
  requireCredentialVault(vault);
  return serializeByVault(vault, async () => {
    let stored;
    try { stored = await vault.get(HEXIKEYS_PAIRING_CREDENTIAL_ID); }
    catch { throw unavailableError(); }
    if (stored === '' || stored === null || stored === undefined) {
      throw pairingError('HEXKEYS_PAIRING_MISSING', 'HexiKeys has not been paired.');
    }
    const descriptor = parseStoredPairing(stored);
    const key = Buffer.from(descriptor.hmacKey, 'hex');
    try {
      return await trustedHostHelper(Object.freeze({ pipeId: descriptor.pipeId, hmacKey: key }));
    } finally {
      key.fill(0);
    }
  });
}

/** Remove the one fixed pairing entry without affecting any other credential. */
export async function removeHexiKeysPairing({ vault, authorize } = {}) {
  requireCredentialVault(vault, { requireRemove: true });
  requireAuthorize(authorize);
  return serializeByVault(vault, async () => {
    await checkAuthorized(authorize, 'before-read');
    let previous;
    try { previous = await vault.get(HEXIKEYS_PAIRING_CREDENTIAL_ID); }
    catch { throw unavailableError(); }
    await checkAuthorized(authorize, 'before-remove');
    if (previous === '' || previous === null || previous === undefined) {
      await checkAuthorized(authorize, 'after-read');
      return Object.freeze({ removed: false });
    }
    try { await vault.remove(HEXIKEYS_PAIRING_CREDENTIAL_ID, { requireAvailable: true }); }
    catch {
      await restorePriorIfCurrent(vault, '', previous);
      throw unavailableError();
    }
    try { await checkAuthorized(authorize, 'after-write'); }
    catch (error) {
      await restorePriorIfCurrent(vault, '', previous);
      throw error;
    }
    return Object.freeze({ removed: true });
  });
}
