import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function unusedLocalPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntil(predicate, { timeoutMs = 35_000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Watchdog exited before recovery (code ${child.exitCode}).`);
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the isolated watchdog recovery.');
}

test('Windows watchdog launches the current HexiGrid engine into an isolated data root', {
  skip: process.platform !== 'win32', timeout: 45_000
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-watchdog-recovery-'));
  const port = await unusedLocalPort();
  const watchdogFile = path.join(root, 'scripts', 'HexiGrid-Watchdog.ps1');
  let watchdog;
  let enginePid;
  try {
    watchdog = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', watchdogFile,
      '-CheckIntervalSeconds', '5', '-HealthyResetSeconds', '5'], {
      cwd: root, windowsHide: true,
      env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    watchdog.stderr.on('data', (chunk) => { stderr += chunk; });
    watchdog.on('error', (error) => { stderr += error.message; });

    const identity = await waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/system/identity`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return null;
        const value = await response.json();
        return value.product === 'hexigrid' && Number(value.port) === port ? value : null;
      } catch { return null; }
    }, { child: watchdog });
    assert.equal(identity.product, 'hexigrid');
    const runtime = JSON.parse(await readFile(path.join(dataDir, '.runtime.json'), 'utf8'));
    enginePid = Number(runtime.pid);
    assert.equal(enginePid, Number(identity.pid));
    assert.equal(runtime.port, port);

    await waitUntil(async () => {
      try { return (await readFile(path.join(dataDir, 'watchdog.log'), 'utf8')).includes('HexiGrid is healthy.'); }
      catch { return false; }
    }, { timeoutMs: 10_000, child: watchdog }).catch((error) => { throw new Error(`${error.message} ${stderr}`); });
  } finally {
    if (watchdog && watchdog.exitCode === null) watchdog.kill();
    if (enginePid && Number.isSafeInteger(enginePid)) {
      try { process.kill(enginePid); } catch {}
      await waitUntil(async () => {
        try { await fetch(`http://127.0.0.1:${port}/api/system/identity`, { signal: AbortSignal.timeout(250) }); return false; }
        catch { return true; }
      }, { timeoutMs: 5_000 }).catch(() => {});
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
