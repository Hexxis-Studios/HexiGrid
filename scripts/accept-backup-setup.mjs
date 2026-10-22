// Disposable owner snapshot-setup failure acceptance. Run with a PTY; stop cleans up.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-backup-setup-'));
const origin = 'http://127.0.0.1:44778';
const app = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44778', HEXIGRID_AGENT_RELAY_PORT: '44779', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44779', HEXIGRID_DATA_DIR: root, HEXIGRID_DISABLE_OS_VAULT: '1', OPENCODE_CLI: 'missing-setup-qa-model' } });
let cookie = '', stopped = false;
async function call(route, method = 'GET', body) { const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] }; }
async function stop() {
  if (stopped) return; stopped = true;
  if (app.exitCode === null) { const done = new Promise(r => app.once('exit', r)); app.kill(); await done; }
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('hexigrid-backup-setup-')) throw Error('Unexpected QA cleanup root');
  await rm(root, { recursive: true, force: true });
}
process.on('SIGINT', () => stop().then(() => process.exit()));
try {
  let ready = false; for (let i = 0; i < 80; i++) { if (app.exitCode !== null) throw Error('Synthetic host exited'); try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  if (!ready) throw Error('Synthetic host unavailable');
  const login = await call('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' }); assert.equal(login.status, 200); cookie = login.cookie;
  console.log('Disposable44778 ready: OS vault deliberately unavailable; no real Link or state. Enter verify after owner setup attempt, then stop.');
  const input = readline.createInterface({ input: process.stdin });
  for await (const command of input) {
    if (command === 'verify') { const current = (await call('/api/bootstrap')).body; assert.equal(current.settings.backupSchedule.enabled, false); assert.equal(current.receipts.some(r => r.action === 'backup:schedule-enable'), false); console.log('PASS: failed setup leaves schedule disabled and no completed enable receipt.'); }
    if (command === 'stop') { input.close(); await stop(); console.log('Disposable setup fixture cleaned up.'); break; }
  }
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }
