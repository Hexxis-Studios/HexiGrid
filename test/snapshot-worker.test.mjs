import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptBackup, encryptBackup } from '../lib/backup.mjs';
import { EncryptedStateStore } from '../lib/local-state.mjs';
import { advanceScheduleAfterRun, beginBackupOperation, createWholeAppManifest, normalizeBackupSchedule,
  verifyWholeAppManifest, wholeAppBackupAreas, writeEncryptedSnapshot } from '../lib/whole-app-backup.mjs';
const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
test('scheduled and manual snapshots share one execution and disabling during failure is preserved', async () => {
  let rejectRun; const running = new Promise((resolve, reject) => { rejectRun = reject; });
  const disabled = { enabled: false }; const receipts = [];
  const context = vm.createContext({ state: { settings: { backupSchedule: { enabled: true, intervalHours: 24 } } }, normalizeBackupSchedule: value => ({ ...value }), beginBackupOperation, runScheduledBackup: () => running, addReceipt: value => receipts.push(value), saveState: async () => {}, setInterval: () => ({ unref() {} }) });
  vm.runInContext(source.slice(source.indexOf('let scheduledBackupRunning = false;'), source.indexOf('\nasync function route')), context);
  const first = context.executeScheduledBackup();
  await assert.rejects(context.executeScheduledBackup(), /already running/);
  context.state.settings.backupSchedule = disabled; rejectRun(Error('Synthetic write failure'));
  await assert.rejects(first, /Synthetic write failure/);
  assert.equal(context.state.settings.backupSchedule, disabled); assert.equal(receipts[0].status, 'failed');
  await assert.rejects(context.executeScheduledBackup(), /Set up automatic/);
});
test('completed snapshot does not restore a disabled or replaced schedule', async () => {
  let finishWrite; const writing = new Promise(resolve => { finishWrite = resolve; });
  const disabled = { enabled: false }; let saved = 0;
  const context = vm.createContext({ state: { settings: { backupSchedule: { enabled: true, intervalHours: 24, directory: 'synthetic' } } }, normalizeBackupSchedule: value => ({ ...value }), credentialVault: { get: async () => 'public synthetic passphrase' }, backupPayload: async () => ({}), verifyWholeAppManifest() {}, encryptBackup: () => ({}), writeEncryptedSnapshot: () => writing, DEFAULT_BACKUP_DIR: 'synthetic', backupFilename: () => 'synthetic', now: () => new Date().toISOString(), addReceipt() {}, saveState: async () => { saved++; } });
  vm.runInContext(source.slice(source.indexOf('async function runScheduledBackup()'), source.indexOf('\nasync function restoreState')), context);
  const first = context.runScheduledBackup(); await Promise.resolve(); await Promise.resolve();
  context.state.settings.backupSchedule = disabled; finishWrite(); await first;
  assert.equal(context.state.settings.backupSchedule, disabled); assert.equal(saved, 1);
});

test('real encrypted snapshots recur after a persisted restart and never run early or after disable', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-scheduled-snapshots-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const directory = path.join(root, 'snapshots');
  const secrets = new Map([['whole-app-backup-passphrase', 'synthetic scheduler backup passphrase']]);
  const vault = { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); } };
  const stateFile = path.join(root, 'state.json');
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  class SchedulerDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let snapshotName = 'before restart';
  function fixture(state) {
    let tick;
    const store = new EncryptedStateStore(stateFile, vault);
    const context = vm.createContext({
      Date: SchedulerDate, state, normalizeBackupSchedule, advanceScheduleAfterRun, beginBackupOperation,
      credentialVault: vault, DEFAULT_BACKUP_DIR: directory, encryptBackup,
      verifyWholeAppManifest, writeEncryptedSnapshot,
      backupPayload: async () => {
        const payload = { agents: [{ id: 'synthetic', name: snapshotName }], rooms: [],
          privateFiles: { version: 1, areas: [...wholeAppBackupAreas], files: [] }, backup: { version: 3 } };
        payload.backup.manifest = createWholeAppManifest(payload);
        return payload;
      },
      addReceipt: receipt => context.state.receipts.push(receipt),
      saveState: () => store.write(context.state),
      setInterval: callback => { tick = callback; return { unref() {} }; }
    });
    const append = source.slice(source.indexOf('function backupFilename('), source.indexOf('\nasync function restoreState'));
    const worker = source.slice(source.indexOf('let scheduledBackupRunning = false;'), source.indexOf('\nasync function route'));
    vm.runInContext(`${append}\n${worker}\nglobalThis.snapshotBusy = () => scheduledBackupRunning;`, context);
    context.startBackupWorker();
    return { context, tick: () => tick() };
  }
  async function finish(run) {
    const deadline = Date.now() + 10_000;
    while (run.context.snapshotBusy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.context.snapshotBusy(), false, 'the actual encrypted write must finish');
  }
  const initial = { version: 2, receipts: [], settings: { backupSchedule:
    normalizeBackupSchedule({ enabled: true, intervalHours: 6, directory }) } };
  const first = fixture(initial);
  first.tick(); await finish(first);
  const firstNames = await readdir(directory);
  assert.equal(firstNames.length, 1);
  const firstBytes = await readFile(path.join(directory, firstNames[0]));
  const persisted = await new EncryptedStateStore(stateFile, vault).read();
  const due = Date.parse(persisted.settings.backupSchedule.nextRunAt);
  assert.equal(due - clock, 6 * 60 * 60 * 1000);
  assert.equal(persisted.receipts.at(-1).status, 'completed');
  clock = due - 1;
  first.tick();
  assert.equal(first.context.snapshotBusy(), false, 'a timer tick before the deadline must not write');
  assert.equal((await readdir(directory)).length, 1);

  const restarted = fixture(persisted);
  snapshotName = 'after restart'; clock = due;
  restarted.tick(); await finish(restarted);
  const names = (await readdir(directory)).sort();
  assert.equal(names.length, 2);
  const opened = [];
  for (const name of names) {
    const payload = decryptBackup(JSON.parse(await readFile(path.join(directory, name), 'utf8')), secrets.get('whole-app-backup-passphrase'));
    verifyWholeAppManifest(payload); opened.push(payload.agents[0].name);
  }
  assert.deepEqual(opened, ['before restart', 'after restart']);
  assert.deepEqual(await readFile(path.join(directory, firstNames[0])), firstBytes, 'the earlier snapshot is retained exactly');
  const saved = await new EncryptedStateStore(stateFile, vault).read();
  assert.equal(Date.parse(saved.settings.backupSchedule.nextRunAt), due + 6 * 60 * 60 * 1000);
  assert.equal(saved.receipts.filter(receipt => receipt.status === 'completed').length, 2);
  restarted.context.state.settings.backupSchedule.enabled = false;
  clock = due + 6 * 60 * 60 * 1000;
  restarted.tick();
  assert.equal(restarted.context.snapshotBusy(), false, 'disabled schedules must stay stopped');
  assert.equal((await readdir(directory)).length, 2);
});
