import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encryptBackup, decryptBackup } from '../lib/backup.mjs';
import { collectPortableFiles, restorePortableFiles } from '../lib/portable-files.mjs';
import { configureBackupSchedule, createWholeAppManifest, verifyWholeAppManifest, wholeAppBackupAreas, writeEncryptedSnapshot } from '../lib/whole-app-backup.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('changing the scheduled-backup folder preserves its protected passphrase and run schedule', () => {
  const current = {
    enabled: true, intervalHours: 168, directory: path.join(os.tmpdir(), 'old-backups'),
    lastRunAt: '2026-10-20T12:00:00.000Z', nextRunAt: '2026-10-27T12:00:00.000Z', lastError: 'old disk error'
  };
  const selected = path.join(os.tmpdir(), 'owner-selected-backups');
  const change = configureBackupSchedule(current, { enabled: true, directory: selected }, path.join(os.tmpdir(), 'default'), '2026-10-21T12:00:00.000Z');
  assert.equal(change.preservePassphrase, true);
  assert.equal(change.schedule.directory, path.resolve(selected));
  assert.equal(change.schedule.intervalHours, 168);
  assert.equal(change.schedule.lastRunAt, current.lastRunAt);
  assert.equal(change.schedule.nextRunAt, current.nextRunAt);
  assert.equal(change.schedule.lastError, '');
  assert.throws(() => configureBackupSchedule(current, { enabled: true, directory: 'relative-folder' }, path.join(os.tmpdir(), 'default'), '2026-10-21T12:00:00.000Z'), /absolute local backup folder/);
});

test('new scheduled backups still require passphrase setup and use the default folder when omitted', () => {
  const result = configureBackupSchedule({ enabled: false }, { enabled: true, intervalHours: 168, passphrase: 'synthetic passphrase' }, path.join(os.tmpdir(), 'default-backups'), '2026-10-21T12:00:00.000Z');
  assert.equal(result.preservePassphrase, false);
  assert.equal(result.schedule.intervalHours, 168);
  assert.equal(result.schedule.directory, path.resolve(os.tmpdir(), 'default-backups'));
  assert.equal(result.schedule.nextRunAt, '2026-10-21T12:00:00.000Z');
});

async function roots(base) {
  const result = {};
  for (const area of wholeAppBackupAreas) {
    result[area] = path.join(base, area);
    await mkdir(result[area], { recursive: true });
  }
  return result;
}

test('whole-app snapshot encrypts, manifests, verifies, restores, and byte-compares durable state', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-whole-source-'));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-whole-target-'));
  try {
    const source = await roots(sourceRoot);
    const target = await roots(targetRoot);
    const fixtures = {
      workspace: ['owner.txt', 'workspace bytes'], media: ['avatar.glb', 'media bytes'], plugins: ['safe/plugin.mjs', 'plugin bytes'],
      'dated-memory': ['lineage-test/2026-09-21.json', 'dated memory bytes'], 'memory-index': ['lineage-test.sqlite', 'sqlite index bytes']
    };
    for (const [area, [relative, text]] of Object.entries(fixtures)) {
      await mkdir(path.dirname(path.join(source[area], relative)), { recursive: true });
      await writeFile(path.join(source[area], relative), text);
    }
    const payload = {
      agents: [{ id: 'agent-test', continuityDraft: { protectedAtRest: 'encrypted-control-room-state' } }], rooms: [],
      settings: { wakeWord: { enabled: true }, hologramPresence: { x: 12, y: 34 }, backupSchedule: { enabled: false } },
      privateFiles: await collectPortableFiles(source),
      backup: { format: 'hexigrid-local-data', version: 3, excluded: ['embedding-models', 'memory-sync-staging', 'transcription-temp', 'ephemeral-media'] }
    };
    payload.backup.manifest = createWholeAppManifest(payload);
    assert.equal(verifyWholeAppManifest(payload).legacy, false);
    const envelope = encryptBackup(payload, 'whole app backup passphrase');
    assert.doesNotMatch(JSON.stringify(envelope), /dated memory bytes|workspace bytes/);
    const opened = decryptBackup(envelope, 'whole app backup passphrase');
    verifyWholeAppManifest(opened);
    await restorePortableFiles(opened.privateFiles, target);
    for (const [area, [relative, text]] of Object.entries(fixtures)) assert.equal(await readFile(path.join(target[area], relative), 'utf8'), text);
    assert.equal(opened.settings.hologramPresence.x, 12);
    assert.deepEqual(opened.backup.excluded, ['embedding-models', 'memory-sync-staging', 'transcription-temp', 'ephemeral-media']);
  } finally { await rm(sourceRoot, { recursive: true, force: true }); await rm(targetRoot, { recursive: true, force: true }); }
});

test('whole-app manifest rejects tampering before restore and scheduled files are atomically encrypted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-whole-tamper-'));
  try {
    const source = await roots(path.join(root, 'source'));
    await writeFile(path.join(source.workspace, 'value.txt'), 'original');
    const payload = { agents: [], rooms: [], settings: {}, privateFiles: await collectPortableFiles(source), backup: { format: 'hexigrid-local-data', version: 3 } };
    payload.backup.manifest = createWholeAppManifest(payload);
    payload.privateFiles.files.find((file) => file.area === 'workspace').data = Buffer.from('changed').toString('base64');
    assert.throws(() => verifyWholeAppManifest(payload), /integrity|verification/);
    const clean = { agents: [], rooms: [], settings: {}, privateFiles: await collectPortableFiles(source), backup: { format: 'hexigrid-local-data', version: 3 } };
    clean.backup.manifest = createWholeAppManifest(clean);
    const envelope = encryptBackup(clean, 'scheduled backup passphrase');
    const written = await writeEncryptedSnapshot({ directory: path.join(root, 'durable'), envelope, filename: 'hexigrid-backup-test.json' });
    assert.equal(sha256(await readFile(written)), sha256(Buffer.from(JSON.stringify(envelope))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy backups remain readable without a v3 manifest', () => {
  assert.deepEqual(verifyWholeAppManifest({ agents: [], rooms: [], backup: { version: 2 } }), { legacy: true });
});

test('snapshot publish failure removes only its staging file and preserves existing destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-snapshot-failure-'));
  try {
    const target = path.join(root, 'hexigrid-backup-conflict.json');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), 'existing owner data');
    await assert.rejects(writeEncryptedSnapshot({ directory: root, envelope: { ciphertext: 'synthetic' }, filename: path.basename(target) }));
    assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'existing owner data');
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(root), [path.basename(target)]);
    // A prior process's partial encrypted staging file cannot become a finished backup.
    const interrupted = 'hexigrid-backup-next.json.999.interrupted.pending';
    await writeFile(path.join(root, interrupted), '{"ciphertext":');
    const written = await writeEncryptedSnapshot({ directory: root, envelope: { ciphertext: 'complete' }, filename: 'hexigrid-backup-next.json' });
    assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), { ciphertext: 'complete' });
    assert.equal(await readFile(path.join(root, interrupted), 'utf8'), '{"ciphertext":');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot refuses ancestor junctions before creating folders or replacing bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-snapshot-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'retained');
  await mkdir(destination);
  const filename = 'hexigrid-backup-existing.json';
  await writeFile(path.join(destination, filename), 'existing complete backup');
  const alias = path.join(root, 'alias');
  await symlink(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const directory of [alias, path.join(alias, 'must-not-create', 'nested')]) {
    await assert.rejects(writeEncryptedSnapshot({ directory, envelope: { ciphertext: 'synthetic' }, filename }), /real directories/);
    assert.deepEqual(await readdir(destination), [filename]);
    assert.equal(await readFile(path.join(destination, filename), 'utf8'), 'existing complete backup');
  }
});

test('invalid snapshot name does not create a selected backup directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-snapshot-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(writeEncryptedSnapshot({ directory: path.join(root, 'must-not-create'),
    envelope: { ciphertext: 'synthetic' }, filename: 'invalid.json' }), /filename/);
  assert.deepEqual(await readdir(root), []);
});
