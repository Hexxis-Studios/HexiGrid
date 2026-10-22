import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 43931;
let child;
let dataDir;

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The server did not start with the OS vault disabled.');
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-vault-fallback-'));
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir, HEXIGRID_DISABLE_OS_VAULT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitUntilReady();
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => child?.once('close', resolve) || resolve());
  await rm(dataDir, { recursive: true, force: true });
});

test('server starts in degraded vault mode and keeps secret features fail-closed', async () => {
  const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json();
  assert.equal(bootstrap.security.credentialVaultAvailable, false);
  assert.equal(bootstrap.security.secretFeaturesAvailable, false);
  assert.match(bootstrap.security.notice, /OS credential vault is unavailable/);
  const encryptedState = JSON.parse(await readFile(path.join(dataDir, 'control-room.json'), 'utf8'));
  assert.equal(encryptedState.format, 'hexigrid-local-state');
  const localKey = await readFile(path.join(dataDir, 'control-room.json.state-key'), 'utf8');
  assert.match(localKey.trim(), /^[A-Za-z0-9_-]{43}$/);
  const provider = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Unavailable vault provider', baseUrl: 'https://provider.example/v1', models: 'model', apiStyle: 'openai-chat', apiKey: 'must-not-be-stored' }) });
  assert.equal(provider.status, 503);
  assert.match((await provider.json()).error, /credential vault is unavailable/i);
});


test('strict credential deletion rejects unavailable vault instead of reporting success', async () => {
  const { CredentialVault } = await import('../lib/vault.mjs');
  const vault = new CredentialVault(os.tmpdir());
  vault.available = false;
  await assert.rejects(vault.remove('disposable', { requireAvailable: true }), error => error.code === 'VAULT_UNAVAILABLE');
  await vault.remove('disposable');
});
