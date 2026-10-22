// Verify two real scheduled snapshots on Windows using only disposable state.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decryptBackup } from '../lib/backup.mjs';
import { verifyWholeAppManifest } from '../lib/whole-app-backup.mjs';

if (process.platform !== 'win32') throw new Error('This acceptance runner verifies the Windows backup path.');
const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-backup-recurrence-'));
const smoke = process.argv.includes('--smoke');
if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('hexigrid-backup-recurrence-')) throw new Error('Unexpected synthetic root.');
const stateDir = path.join(root, 'state');
const backupDir = path.join(root, 'snapshots');
const passphrase = `synthetic-${randomUUID()}`;
const password = `disposable-${randomUUID()}`;
const repo = path.resolve(import.meta.dirname, '..');
let app;
let cookie = '';
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise(resolve => app.once('exit', resolve));
  app.kill();
  await exited;
}

async function request(origin, route, method = 'GET', body) {
  const response = await fetch(origin + route, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

try {
  const port = await freePort();
  let relayPort = await freePort();
  while (relayPort === port) relayPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, {
    HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
    HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
    HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
    HEXIGRID_DATA_DIR: stateDir, OPENCODE_CLI: 'missing-backup-recurrence-qa-model'
  });
  app = spawn(process.execPath, ['server.mjs'], { cwd: repo, windowsHide: true, stdio: 'ignore', env });
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error('Disposable HexiGrid engine exited before becoming ready.');
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (i === 119) throw new Error('Disposable HexiGrid engine did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const setup = await request(origin, '/api/auth/setup', 'POST', { password });
  assert.equal(setup.status, 200);
  cookie = setup.cookie;
  assert.equal((await request(origin, '/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const enabled = await request(origin, '/api/backup/schedule', 'PATCH', {
    enabled: true, directory: backupDir, passphrase, intervalHours: 6, confirmed: true
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.schedule.intervalHours, 6);
  console.log(smoke ? 'Disposable Windows scheduler running; checking its first real scheduled snapshot.' : 'Disposable Windows scheduler running; waiting for two real six-hour scheduled snapshots.');

  const deadline = Date.now() + (smoke ? 3 * 60 * 1000 : 8 * 60 * 60 * 1000);
  let firstRunAt = null;
  let complete = false;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Acceptance run interrupted before recurrence completed.');
    if (app.exitCode !== null) throw new Error('Disposable HexiGrid engine exited during the recurrence window.');
    const current = await request(origin, '/api/bootstrap');
    assert.equal(current.status, 200);
    const schedule = current.body.settings.backupSchedule;
    const completed = current.body.receipts.filter(item => item.action === 'backup:scheduled' && item.status === 'completed');
    if (!firstRunAt && completed.length >= 1) {
      firstRunAt = Date.parse(schedule.lastRunAt);
      assert.ok(Number.isFinite(firstRunAt));
      console.log(`First scheduled snapshot completed at ${schedule.lastRunAt}.`);
    }
    if (smoke && firstRunAt) {
      const names = (await readdir(backupDir)).filter(name => /^hexigrid-backup-.*\.json$/.test(name));
      assert.equal(names.length, 1);
      const envelope = JSON.parse(await readFile(path.join(backupDir, names[0]), 'utf8'));
      verifyWholeAppManifest(decryptBackup(envelope, passphrase));
      assert.equal(Date.parse(schedule.nextRunAt) - firstRunAt, 6 * 60 * 60 * 1000);
      console.log('PASS first scheduled Windows snapshot decrypts and the real next-run deadline persisted.');
      complete = true;
      break;
    }
    if (completed.length >= 2) {
      const secondRunAt = Date.parse(schedule.lastRunAt);
      assert.ok(secondRunAt - firstRunAt >= 6 * 60 * 60 * 1000, 'the second snapshot must follow the real six-hour interval');
      assert.ok(secondRunAt - firstRunAt <= 6 * 60 * 60 * 1000 + 90_000, 'the worker must run within one polling interval after the due time');
      const names = (await readdir(backupDir)).filter(name => /^hexigrid-backup-.*\.json$/.test(name));
      assert.equal(names.length, 2);
      for (const name of names) {
        const envelope = JSON.parse(await readFile(path.join(backupDir, name), 'utf8'));
        verifyWholeAppManifest(decryptBackup(envelope, passphrase));
      }
      assert.equal(schedule.lastError, '');
      console.log(`PASS two decryptable Windows snapshots; elapsed ${Math.round((secondRunAt - firstRunAt) / 60_000)} minutes; next run persisted.`);
      complete = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  if (!complete) throw new Error(smoke ? 'First scheduled snapshot was not observed before the isolated acceptance timeout.' : 'Two scheduled snapshots were not observed before the isolated acceptance timeout.');
} finally {
  await stopApp();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('hexigrid-backup-recurrence-')) throw new Error('Refusing cleanup outside the generated test root.');
  await rm(root, { recursive: true, force: true });
}
