import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedStateStore } from '../lib/local-state.mjs';
import { recoverLocalMigration } from '../scripts/recover-local-migration.mjs';

async function fixture(t, current = { version: 2, current: 'synthetic-current' }, migration = { version: 1, migration: 'synthetic-original' }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-migration-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const values = new Map(), calls = { set: 0 };
  const vault = { get: async id => values.get(id), set: async (id, value) => { calls.set++; values.set(id, value); } };
  const file = path.join(directory, 'control-room.json'), store = new EncryptedStateStore(file, vault);
  await store.write(current);
  if (migration !== null) await store.writeMigrationPoint(migration);
  return { directory, file, store, vault, values, calls, current, migration };
}

async function bytes(file) { return fs.readFile(file, 'utf8'); }

test('status returns only safe metadata and does not change files or vault values', async t => {
  const f = await fixture(t);
  const before = await fs.readdir(f.directory), canonical = await bytes(f.file), checkpoint = await bytes(f.store.migrationPointFile);
  const keys = [...f.values];
  const status = await recoverLocalMigration({ action: 'status', dataDir: f.directory, vaultFactory: () => f.vault });
  assert.deepEqual(status, { currentVersion: 2, migrationVersion: 1, availability: 'available', requiresStoppedEngine: false, writerLockPresent: false });
  assert.deepEqual(Object.keys(status).sort(), ['availability', 'currentVersion', 'migrationVersion', 'requiresStoppedEngine', 'writerLockPresent']);
  assert.deepEqual(await fs.readdir(f.directory), before);
  assert.equal(await bytes(f.file), canonical);
  assert.equal(await bytes(f.store.migrationPointFile), checkpoint);
  assert.deepEqual([...f.values], keys);
  assert.equal(f.calls.set, 1);
});

test('restore, ordinary saves, and undo preserve an unversioned legacy payload and the backup restore point', async t => {
  const legacy = { legacyText: 'synthetic legacy payload', nested: { exact: true } };
  const f = await fixture(t, legacy, { version: 1, migratedFrom: 'synthetic checkpoint' });
  const backup = { version: 2, backupOnly: 'synthetic backup undo' };
  await f.store.writeRestorePoint(backup);
  const backupBytes = await bytes(f.store.restorePointFile);
  await recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault });
  assert.deepEqual(await new EncryptedStateStore(f.file, f.vault).read(), f.migration);
  assert.deepEqual(await new EncryptedStateStore(f.file, f.vault).readMigrationUndoPoint(), legacy);
  const undoBytes = await bytes(f.store.migrationUndoPointFile);
  assert.equal(JSON.parse(undoBytes).format, 'hexigrid-local-state');
  assert.notEqual(f.store.migrationUndoPointFile, f.store.restorePointFile);
  await assert.rejects(f.store.writeMigrationUndoPoint({ version: 3, unsupported: true }), error => error.code === 'STATE_VERSION_UNSUPPORTED');
  assert.equal(await bytes(f.store.migrationUndoPointFile), undoBytes);
  const ordinary = new EncryptedStateStore(f.file, f.vault);
  await ordinary.read();
  await ordinary.write({ version: 2, ordinarySave: 1 });
  await ordinary.write({ version: 2, ordinarySave: 2 });
  assert.deepEqual(await ordinary.readMigrationUndoPoint(), legacy);
  await recoverLocalMigration({ action: 'undo', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault });
  const restored = await new EncryptedStateStore(f.file, f.vault).read();
  assert.deepEqual(restored, legacy);
  assert.equal(Object.hasOwn(restored, 'version'), false);
  assert.equal(await bytes(f.store.restorePointFile), backupBytes);
});

test('no confirmation and unknown CLI arguments make no changes', async t => {
  const f = await fixture(t), canonical = await bytes(f.file), entries = await fs.readdir(f.directory);
  await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, vaultFactory: () => { throw new Error('must not read vault'); } }), /confirm/);
  const cli = path.resolve(import.meta.dirname, '../scripts/recover-local-migration.mjs');
  const result = spawnSync(process.execPath, [cli, 'status', '--data-dir', f.directory, '--unknown'], { encoding: 'utf8', env: {} });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Recovery failed/);
  assert.deepEqual(await fs.readdir(f.directory), entries);
  assert.equal(await bytes(f.file), canonical);
  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: {} });
  assert.equal(usage.status, 0);
  assert.match(usage.stdout, /Usage:/);
});

test('the real CLI status, restore, and undo paths work with a disabled OS vault and synthetic key', async t => {
  const f = await fixture(t, { version: 2, original: 'synthetic-cli-current' }, { version: 1, original: 'synthetic-cli-migration' });
  await fs.writeFile(f.store.fallbackKeyFile, f.values.get(f.store.keyId), { mode: 0o600 });
  const cli = path.resolve(import.meta.dirname, '../scripts/recover-local-migration.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { HEXIGRID_DISABLE_OS_VAULT: '1' } });
  const status = run('status', '--data-dir', f.directory);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { currentVersion: 2, migrationVersion: 1, availability: 'available', requiresStoppedEngine: false, writerLockPresent: false });
  const restored = run('restore', '--data-dir', f.directory, '--confirm');
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, 'Migration restored.\n');
  assert.deepEqual(await new EncryptedStateStore(f.file, f.vault).read(), f.migration);
  const undone = run('undo', '--data-dir', f.directory, '--confirm');
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(undone.stdout, 'Migration undo restored.\n');
  assert.deepEqual(await new EncryptedStateStore(f.file, f.vault).read(), f.current);
});

test('a live current-PID lock or runtime record refuses mutation', async t => {
  for (const slot of ['.instance.lock', '.runtime.json']) await t.test(slot, async t2 => {
    const f = await fixture(t2), file = path.join(f.directory, slot), canonical = await bytes(f.file);
    const record = { product: 'hexigrid', version: 'synthetic', instanceId: `live-${slot}`, pid: process.pid, createdAt: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify(record));
    const status = await recoverLocalMigration({ action: 'status', dataDir: f.directory, vaultFactory: () => f.vault });
    assert.equal(status.requiresStoppedEngine, true);
    await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }), /writer record/);
    assert.equal(await bytes(f.file), canonical);
    assert.equal(await bytes(file), JSON.stringify(record));
  });
});

test('a dead writer lock stays intact for review rather than racing a restarting engine', async t => {
  const f = await fixture(t), lock = path.join(f.directory, '.instance.lock');
  const record = JSON.stringify({ product: 'hexigrid', version: 'synthetic', instanceId: 'dead', pid: Number.MAX_SAFE_INTEGER, createdAt: new Date().toISOString() });
  const canonical = await bytes(f.file);
  await fs.writeFile(lock, record);
  const status = await recoverLocalMigration({ action: 'status', dataDir: f.directory, vaultFactory: () => f.vault });
  assert.equal(status.writerLockPresent, true);
  await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }), /writer record/);
  assert.equal(await bytes(lock), record);
  assert.equal(await bytes(f.file), canonical);
});

test('malformed and foreign locks are never reclaimed', async t => {
  for (const content of ['{bad', JSON.stringify({ product: 'other', pid: Number.MAX_SAFE_INTEGER, instanceId: 'foreign' })]) await t.test('refusal', async t2 => {
    const f = await fixture(t2), lock = path.join(f.directory, '.instance.lock'), canonical = await bytes(f.file);
    await fs.writeFile(lock, content);
    await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }), /writer record/);
    assert.equal(await bytes(lock), content);
    assert.equal(await bytes(f.file), canonical);
  });
});

test('missing, corrupt, and future migration points fail before canonical changes', async t => {
  for (const mode of ['missing', 'corrupt', 'future']) await t.test(mode, async t2 => {
    const f = await fixture(t2), canonical = await bytes(f.file);
    if (mode === 'missing') await fs.unlink(f.store.migrationPointFile);
    if (mode === 'corrupt') {
      const envelope = JSON.parse(await bytes(f.store.migrationPointFile));
      envelope.tag = Buffer.alloc(16, 9).toString('base64url');
      await fs.writeFile(f.store.migrationPointFile, JSON.stringify(envelope));
    }
    if (mode === 'future') {
      const key = Buffer.from(f.values.get(f.store.keyId), 'base64url');
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify({ version: 3, future: 'synthetic' })), cipher.final()]);
      await fs.writeFile(f.store.migrationPointFile, JSON.stringify({ format: 'hexigrid-local-state', version: 1, cipher: 'aes-256-gcm',
        iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url'), writtenAt: new Date().toISOString() }));
    }
    await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }));
    assert.equal(await bytes(f.file), canonical);
  });
});

test('a failed undo capture leaves canonical bytes unchanged', async t => {
  const f = await fixture(t), canonical = await bytes(f.file), originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === f.store.migrationUndoPointFile) throw new Error('synthetic undo capture failure');
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }), /synthetic undo capture failure/);
  } finally { fs.rename = originalRename; }
  assert.equal(await bytes(f.file), canonical);
});

test('an unavailable key fails before canonical changes', async t => {
  const f = await fixture(t), canonical = await bytes(f.file), unavailable = { get: async () => '', set: async () => { throw new Error('must not create a key'); } };
  await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => unavailable }));
  assert.equal(await bytes(f.file), canonical);
});

test('a directory junction or symlink cannot redirect the recovery data root', async t => {
  const f = await fixture(t);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-migration-root-link-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const linkedRoot = path.join(other, 'linked-root');
  await fs.symlink(f.directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const canonical = await bytes(f.file);
  await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: linkedRoot, confirm: true, vaultFactory: () => f.vault }), /symbolic links/);
  assert.equal(await bytes(f.file), canonical);
});

test('filesystem root and state-file symlinks are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(recoverLocalMigration({ action: 'status', dataDir: path.parse(f.directory).root, vaultFactory: () => f.vault }), /filesystem root/);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-migration-link-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const target = path.join(other, 'target.json'), linked = path.join(f.directory, 'control-room.json');
  await fs.writeFile(target, '{"version":2}');
  await fs.unlink(linked);
  try { await fs.symlink(target, linked, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('This host cannot create a synthetic file symlink.');
    throw error;
  }
  await assert.rejects(recoverLocalMigration({ action: 'status', dataDir: f.directory, vaultFactory: () => f.vault }), /symbolic links/);
});

test('a replaced owned lock is detected immediately before canonical publication', async t => {
  const f = await fixture(t), canonical = await bytes(f.file), lock = path.join(f.directory, '.instance.lock');
  const originalCopy = fs.copyFile;
  let replaced = false;
  fs.copyFile = async (source, destination, ...args) => {
    const result = await originalCopy(source, destination, ...args);
    if (destination === f.store.previousFile && !replaced) {
      replaced = true;
      await fs.writeFile(lock, JSON.stringify({ product: 'hexigrid', version: 'synthetic', pid: Number.MAX_SAFE_INTEGER,
        instanceId: 'replacement', createdAt: new Date().toISOString() }));
    }
    return result;
  };
  try {
    await assert.rejects(recoverLocalMigration({ action: 'restore', dataDir: f.directory, confirm: true, vaultFactory: () => f.vault }), /no longer owns/);
  } finally { fs.copyFile = originalCopy; }
  assert.equal(replaced, true);
  assert.equal(await bytes(f.file), canonical);
  assert.equal(JSON.parse(await bytes(lock)).instanceId, 'replacement');
});
