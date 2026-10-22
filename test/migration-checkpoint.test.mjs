import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedStateStore } from '../lib/local-state.mjs';

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-migration-point-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const values = new Map();
  const vault = {
    isAvailable: () => true,
    get: async key => values.get(key),
    set: async (key, value) => values.set(key, value)
  };
  const file = path.join(directory, 'state.json');
  return { directory, file, vault, store: new EncryptedStateStore(file, vault) };
}

test('writes an exact encrypted checkpoint for legacy version 1 state', async t => {
  const { file, store } = await createStore(t);
  const original = { version: 1, rooms: [{ id: 'room-a', messages: ['synthetic legacy text'] }], preferences: { theme: 'dim' } };

  await store.writeMigrationPoint(original);

  assert.deepEqual(await store.readMigrationPoint(), original);
  assert.equal(store.migrationPointFile, `${file}.migration-point`);
  const envelope = JSON.parse(await fs.readFile(store.migrationPointFile, 'utf8'));
  assert.equal(envelope.format, 'hexigrid-local-state');
  assert.equal(envelope.version, 1);
  await assert.rejects(fs.access(file));
});

test('preserves exact legacy state with no version field', async t => {
  const { store } = await createStore(t);
  const original = { agents: [{ id: 'agent-a', notes: ['original note'] }], selectedRoom: 'room-a' };

  await store.writeMigrationPoint(original);

  assert.deepEqual(await store.readMigrationPoint(), original);
  assert.equal(Object.hasOwn(await store.readMigrationPoint(), 'version'), false);
});

test('ordinary current saves and restart leave migration and backup restore points intact', async t => {
  const { file, vault, store } = await createStore(t);
  const original = { version: 1, agents: [{ id: 'agent-a', chats: ['before migration'] }] };
  const restore = { version: 2, agents: [{ id: 'agent-b' }], reason: 'user backup' };
  await store.write({ version: 2, sequence: 0 });
  await store.writeMigrationPoint(original);
  await store.writeRestorePoint(restore);
  const migrationBytes = await fs.readFile(store.migrationPointFile, 'utf8');
  const restoreBytes = await fs.readFile(store.restorePointFile, 'utf8');

  await store.write({ version: 2, sequence: 1 });
  await store.write({ version: 2, sequence: 2 });
  const restarted = new EncryptedStateStore(file, vault);

  assert.deepEqual(await restarted.readMigrationPoint(), original);
  assert.deepEqual(await restarted.readRestorePoint(), restore);
  assert.equal(await fs.readFile(store.migrationPointFile, 'utf8'), migrationBytes);
  assert.equal(await fs.readFile(store.restorePointFile, 'utf8'), restoreBytes);
  assert.notEqual(store.migrationPointFile, store.previousFile);
  assert.notEqual(store.migrationPointFile, store.restorePointFile);
});

test('replaces a migration point only when another one is explicitly written', async t => {
  const { store } = await createStore(t);
  const first = { version: 1, value: 'first exact snapshot' };
  const second = { version: 2, value: 'second exact snapshot' };

  await store.writeMigrationPoint(first);
  await store.write({ version: 2, value: 'ordinary save' });
  assert.deepEqual(await store.readMigrationPoint(), first);
  await store.writeMigrationPoint(second);
  assert.deepEqual(await store.readMigrationPoint(), second);
});

test('rejects a tampered migration point', async t => {
  const { store } = await createStore(t);
  await store.writeMigrationPoint({ version: 1, value: 'synthetic checkpoint' });
  const envelope = JSON.parse(await fs.readFile(store.migrationPointFile, 'utf8'));
  envelope.tag = Buffer.alloc(16, 7).toString('base64url');
  await fs.writeFile(store.migrationPointFile, JSON.stringify(envelope), 'utf8');

  await assert.rejects(store.readMigrationPoint(), /could not be decrypted/);
});

test('a failed checkpoint rename leaves its prior point and canonical bytes unchanged', async t => {
  const { file, store } = await createStore(t);
  await store.write({ version: 2, value: 'canonical synthetic state' });
  const first = { version: 1, value: 'saved migration point' };
  await store.writeMigrationPoint(first);
  const canonicalBytes = await fs.readFile(file, 'utf8');
  const migrationBytes = await fs.readFile(store.migrationPointFile, 'utf8');
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === store.migrationPointFile) throw new Error('synthetic rename failure');
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(store.writeMigrationPoint({ version: 2, value: 'replacement' }), /synthetic rename failure/);
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(await fs.readFile(file, 'utf8'), canonicalBytes);
  assert.equal(await fs.readFile(store.migrationPointFile, 'utf8'), migrationBytes);
  assert.deepEqual(await store.readMigrationPoint(), first);
  await assert.rejects(fs.access(`${store.migrationPointFile}.${process.pid}.pending`));
});

test('refuses malformed and future-schema checkpoint payloads', async t => {
  const { store } = await createStore(t);
  for (const payload of [null, [], { version: 0 }, { version: '2' }, { version: 3 }]) {
    await assert.rejects(
      store.writeMigrationPoint(payload),
      error => error.code === 'STATE_VERSION_UNSUPPORTED'
    );
  }
  await assert.rejects(fs.access(store.migrationPointFile));
});
