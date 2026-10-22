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

function runLauncher(port, dataDir, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(root, 'Start-Control-Room.ps1'), '-NoBrowser', '-StartupTimeoutSeconds', '10'], { cwd: root, windowsHide: true, env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runServerAttempt(port, dataDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Windows launcher verifies a new and existing HexiGrid process and rejects a foreign listener', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-launcher-')); let launchedPid;
  const reserve = http.createServer(); await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  try {
    const started = await runLauncher(port, dataDir); assert.equal(started.code, 0, started.stderr); assert.match(started.stdout, /HexiGrid verified/);
    const runtime = JSON.parse(await readFile(path.join(dataDir, '.runtime.json'), 'utf8')); launchedPid = runtime.pid; assert.equal(runtime.product, 'hexigrid'); assert.equal(runtime.port, port);
    const existing = await runLauncher(port, dataDir); assert.equal(existing.code, 0, existing.stderr); assert.match(existing.stdout, new RegExp(`process ${launchedPid}`));
    const secondReserve = http.createServer(); await new Promise((resolve) => secondReserve.listen(0, '127.0.0.1', resolve)); const secondPort = secondReserve.address().port; await new Promise((resolve) => secondReserve.close(resolve));
    const duplicate = await runServerAttempt(secondPort, dataDir); assert.notEqual(duplicate.code, 0); assert.match(duplicate.stderr, /already using this private data folder/);
    process.kill(launchedPid); launchedPid = null;
    for (let attempt = 0; attempt < 30; attempt += 1) { try { await fetch(`http://127.0.0.1:${port}/api/system/identity`); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { break; } }
    const foreign = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ product: 'not-hexigrid' })); }); await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve));
    try { const blocked = await runLauncher(port, dataDir); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /another or unverifiable program/); } finally { await new Promise((resolve) => foreign.close(resolve)); }
  } finally { if (launchedPid) try { process.kill(launchedPid); } catch {} await rm(dataDir, { recursive: true, force: true }); }
});

test('Windows launcher rejects invalid port configuration before starting anything', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-launcher-'));
  try { const result = await runLauncher('not-a-port', dataDir); assert.notEqual(result.code, 0); assert.match(result.stderr, /whole number/); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
});
