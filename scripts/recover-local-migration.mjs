import crypto from 'node:crypto';
import { lstatSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CredentialVault } from '../lib/vault.mjs';
import { assertSupportedLocalState, EncryptedStateStore } from '../lib/local-state.mjs';

const CANONICAL_FILE = 'control-room.json';
const USAGE = 'Usage: node scripts/recover-local-migration.mjs <status|restore|undo> --data-dir <existing-directory> [--confirm]';
const processExists = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
const validIdentity = value => value && typeof value === 'object' && !Array.isArray(value)
  && value.product === 'hexigrid' && Number.isSafeInteger(value.pid) && value.pid > 0
  && typeof value.instanceId === 'string' && value.instanceId.length > 0;
const validLock = value => validIdentity(value) && typeof value.version === 'string' && value.version.length > 0
  && typeof value.createdAt === 'string' && value.createdAt.length > 0;
const ownsLock = (record, own) => validLock(record) && record.product === own.product && record.pid === own.pid
  && record.instanceId === own.instanceId && record.version === own.version && record.createdAt === own.createdAt;

function rejectSymlink(file, required = false, kind = 'file') {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Recovery paths cannot be symbolic links.');
    if (required && !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new Error(`The recovery ${kind} path is invalid.`);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    throw error;
  }
}

function safePaths(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('An existing data directory is required.');
  const root = path.resolve(dataDir);
  if (root === path.parse(root).root) throw new Error('A filesystem root cannot be used for recovery.');
  rejectSymlink(root, true, 'directory');
  const file = path.join(root, CANONICAL_FILE);
  const store = new EncryptedStateStore(file, null);
  for (const candidate of [file, store.migrationPointFile, store.migrationUndoPointFile,
    store.previousFile, store.restorePointFile, store.fallbackKeyFile, path.join(root, 'vault'),
    path.join(root, 'vault', 'local-state-master-key.protected'),
    path.join(root, '.instance.lock'), path.join(root, '.runtime.json')]) rejectSymlink(candidate, candidate === file);
  const vaultStat = rejectSymlink(path.join(root, 'vault'));
  if (vaultStat && !vaultStat.isDirectory()) throw new Error('The local vault path must be a directory.');
  return { store, lockFile: path.join(root, '.instance.lock'), runtimeFile: path.join(root, '.runtime.json'), vaultDir: path.join(root, 'vault') };
}

async function readRecord(file, lock = false) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    let value;
    try { value = JSON.parse(raw); } catch { return { raw, valid: false }; }
    return { raw, value, valid: Boolean(lock ? validLock(value) : validIdentity(value)) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writerState(lockFile, runtimeFile) {
  const lock = await readRecord(lockFile, true), runtime = await readRecord(runtimeFile);
  const liveLock = Boolean(lock?.valid && processExists(lock.value.pid));
  const liveRuntime = Boolean(runtime?.valid && processExists(runtime.value.pid));
  return { requiresStoppedEngine: liveLock || liveRuntime || Boolean(lock && !lock.valid) || Boolean(runtime && !runtime.valid),
    writerLockPresent: Boolean(lock) };
}

async function acquireLock(paths) {
  const state = await writerState(paths.lockFile, paths.runtimeFile);
  // Never unlink a supposedly stale lock: a concurrently starting watchdog
  // could replace it between our read and unlink. Exclusive creation lets
  // exactly one writer win; stale records require explicit operator review.
  if (state.requiresStoppedEngine || state.writerLockPresent) throw new Error('A writer record prevents recovery. Stop HexiGrid normally; review any stale lock before retrying.');
  const own = { product: 'hexigrid', version: 'recovery', instanceId: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  await fs.writeFile(paths.lockFile, JSON.stringify(own), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return own;
}

function assertOwnLock(lockFile, own) {
  try {
    rejectSymlink(lockFile, true);
    const record = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (!ownsLock(record, own)) throw new Error();
  } catch { throw new Error('Recovery no longer owns the data-folder writer lock.'); }
}

async function releaseLock(lockFile, own) {
  try {
    const stat = await fs.lstat(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const record = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (ownsLock(record, own)) await fs.unlink(lockFile);
  } catch { /* leave absent or replaced locks untouched */ }
}

function versionOf(payload) {
  const version = payload?.version ?? 1;
  return Number.isInteger(version) && version >= 1 ? version : null;
}

export async function recoverLocalMigration({ action, dataDir, confirm = false, vaultFactory = directory => new CredentialVault(directory) } = {}) {
  if (!['status', 'restore', 'undo'].includes(action)) throw new Error('Unknown recovery action.');
  if (action === 'status' ? confirm : confirm !== true) throw new Error('Mutations require the literal --confirm flag.');
  const paths = safePaths(dataDir);
  if (action === 'status') {
    const writers = await writerState(paths.lockFile, paths.runtimeFile);
    paths.store.vault = await vaultFactory(paths.vaultDir);
    const current = await paths.store.read();
    let migration = null;
    try { migration = await paths.store.readMigrationPoint(); } catch { /* report only checkpoint metadata */ }
    return { currentVersion: versionOf(current), migrationVersion: migration ? versionOf(migration) : null,
      availability: migration ? 'available' : 'unavailable', requiresStoppedEngine: writers.requiresStoppedEngine,
      writerLockPresent: writers.writerLockPresent };
  }

  const own = await acquireLock(paths);
  try {
    paths.store.vault = await vaultFactory(paths.vaultDir);
    const current = assertSupportedLocalState(await paths.store.read());
    let target;
    if (action === 'restore') target = await paths.store.readMigrationPoint();
    else target = await paths.store.readMigrationUndoPoint();
    if (action === 'restore') await paths.store.writeMigrationUndoPoint(current);
    await paths.store.write(target, { assertAuthorized: () => assertOwnLock(paths.lockFile, own) });
    return { action, restored: true };
  } finally { await releaseLock(paths.lockFile, own); }
}

function parseArgs(args) {
  if (!args.length) return null;
  const [action, ...options] = args;
  if (!['status', 'restore', 'undo'].includes(action)) throw new Error('Invalid command.');
  let dataDir, confirm = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--data-dir') {
      if (dataDir !== undefined || !options[i + 1] || options[i + 1].startsWith('--')) throw new Error('Invalid --data-dir argument.');
      dataDir = options[++i];
    } else if (options[i] === '--confirm') {
      if (confirm) throw new Error('Duplicate --confirm argument.');
      confirm = true;
    } else throw new Error('Unknown argument.');
  }
  if (!dataDir || (action === 'status' && confirm) || (action !== 'status' && !confirm)) throw new Error('Invalid recovery arguments.');
  return { action, dataDir, confirm };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log(USAGE);
    else {
      const result = await recoverLocalMigration(args);
      console.log(args.action === 'status' ? JSON.stringify(result) : args.action === 'restore' ? 'Migration restored.' : 'Migration undo restored.');
    }
  } catch {
    console.error('Recovery failed. Check arguments, stop HexiGrid, and verify the local recovery files.');
    process.exitCode = 1;
  }
}
