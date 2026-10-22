// Disposable snapshot failure/restart/owner-UI fixture; no real state or Link.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { decryptBackup } from '../lib/backup.mjs';
import { verifyWholeAppManifest } from '../lib/whole-app-backup.mjs';
const verifyExisting = process.argv[2] === '--verify-recovered';
const root = verifyExisting ? path.resolve(process.argv[3] || '') : await mkdtemp(path.join(os.tmpdir(), 'hexigrid-snapshot-qa-'));
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('hexigrid-snapshot-qa-')) throw Error('Unexpected synthetic root');
const directory = path.join(root, 'snapshots');
const origin = 'http://127.0.0.1:44768';
const passphrase = 'public-synthetic-backup-only';
let app, cookie = '', stopped = false;
function start() { app = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44768', HEXIGRID_AGENT_RELAY_PORT: '44769', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44769', HEXIGRID_DATA_DIR: path.join(root, 'state'), OPENCODE_CLI: 'missing-snapshot-qa-model' } }); }
async function ready() { for (let i = 0; i < 80; i++) { if (app.exitCode !== null) throw Error('Synthetic host exited'); try { if ((await fetch(origin)).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw Error('Synthetic host not ready'); }
async function stopApp() { if (app?.exitCode === null) { const done = new Promise(r => app.once('exit', r)); app.kill(); await done; } }
async function stop() { if (stopped) return; stopped = true; await stopApp(); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('hexigrid-snapshot-qa-')) throw Error('Cleanup path escaped'); await rm(root, { recursive: true, force: true }); }
process.on('SIGINT', () => stop().then(() => process.exit()));
async function call(route, method = 'GET', body) { const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] }; }
async function restart() { await stopApp(); start(); await ready(); const login = await call('/api/auth/login', 'POST', { password: 'public-disposable-QA-fixture-only' }); assert.equal(login.status, 200); cookie = login.cookie; }
async function verifyRecovered() {
      const current = (await call('/api/bootstrap')).body; assert.equal(current.settings.backupSchedule.lastError, ''); assert.ok(current.settings.backupSchedule.lastRunAt);
      const names = await readdir(directory); assert.equal(names.length, 1); assert.match(names[0], /^hexigrid-backup-.*\.json$/);
      const envelope = JSON.parse(await readFile(path.join(directory, names[0]), 'utf8')); verifyWholeAppManifest(decryptBackup(envelope, passphrase));
      assert.ok(current.receipts.some(r => r.action === 'backup:scheduled' && r.status === 'failed')); assert.ok(current.receipts.some(r => r.action === 'backup:scheduled' && r.status === 'completed'));
      await restart(); const persisted = (await call('/api/bootstrap')).body.settings.backupSchedule; assert.equal(persisted.lastError, ''); assert.ok(persisted.lastRunAt); console.log('PASS actual encrypted snapshot/manifest, failed+completed receipts, recovered standing persists through restart.');

}
try {
  if (verifyExisting) {
    start(); await ready(); const login = await call('/api/auth/login', 'POST', { password: 'public-disposable-QA-fixture-only' }); assert.equal(login.status, 200); cookie = login.cookie;
    await verifyRecovered();
    console.log('Recovered owner UI ready for reload; use Ctrl+C to clean up.');
  } else {
  await writeFile(directory, 'synthetic destination blocker');
  start(); await ready(); const login = await call('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' }); assert.equal(login.status, 200); cookie = login.cookie;
  assert.equal((await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  assert.equal((await call('/api/backup/schedule', 'PATCH', { enabled: true, directory, passphrase, intervalHours: 24, confirmed: true })).status, 200);
  assert.equal((await call('/api/settings', 'PATCH', { workMode: 'plan' })).status, 200);
  assert.equal((await call('/api/backup/snapshot', 'POST', { approved: true })).status, 403);
  assert.equal((await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'ask' })).status, 200);
  assert.equal((await call('/api/backup/snapshot', 'POST', {})).status, 409);
  assert.equal((await call('/api/settings', 'PATCH', { approvalPolicy: 'full' })).status, 200);
  const failed = await call('/api/backup/snapshot', 'POST', {}); assert.equal(failed.status, 502); assert.ok(failed.body.schedule.lastError);
  await restart(); const before = (await call('/api/bootstrap')).body; assert.ok(before.settings.backupSchedule.lastError); assert.equal(before.settings.backupSchedule.lastRunAt, null);
  console.log('PASS failure persisted through restart; Plan403 and Ask409. Owner QA44768 ready. Commands: repair, verify, stop.');
  const input = readline.createInterface({ input: process.stdin });
  for await (const command of input) {
    if (command === 'repair') { await rm(directory); await mkdir(directory); console.log('Synthetic destination repaired; owner Retry snapshot now can run.'); }
    if (command === 'verify') {
      await verifyRecovered();
    }
    if (command === 'stop') { input.close(); await stop(); break; }
  }
  }
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }

