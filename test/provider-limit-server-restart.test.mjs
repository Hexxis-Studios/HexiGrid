import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('provider limits and their receipt survive a complete local server restart', { timeout: 45000 }, async () => {
  const prefix = 'hexigrid-provider-restart-';
  const qa = await mkdtemp(path.join(os.tmpdir(), prefix));
  const profile = path.join(qa, 'profile');
  await mkdir(profile);
  const port = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const value = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return value;
  };
  const ownerPort = await port();
  const relayPort = await port();
  const origin = `http://127.0.0.1:${ownerPort}`;
  const env = {
    ...process.env,
    SystemRoot: process.env.SystemRoot || '',
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: profile,
    LOCALAPPDATA: profile,
    HEXIGRID_HOST: '127.0.0.1',
    HEXIGRID_PORT: String(ownerPort),
    HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
    HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
    HEXIGRID_DATA_DIR: path.join(qa, 'data'),
    HEXIGRID_DISABLE_OS_VAULT: '1',
    HEXIGRID_RELEASE_MANAGER_ROOT: '',
    CODEX_CLI: path.join(qa, 'missing-codex'),
    OPENCODE_CLI: path.join(qa, 'missing-opencode'),
    CLAUDE_CLI: path.join(qa, 'missing-claude')
  };
  const root = fileURLToPath(new URL('..', import.meta.url));
  let child = null;
  const cookies = new Map();

  function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    return child;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    const closed = new Promise(resolve => current.once('close', resolve));
    current.kill();
    await closed;
    child = null;
  }
  async function ready() {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Synthetic HexiGrid server exited before becoming ready (${child.exitCode ?? child.signalCode}).`);
      try {
        const response = await fetch(`${origin}/api/system/identity`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Synthetic HexiGrid server did not become ready.');
  }
  async function request(route, method = 'GET', body) {
    const headers = { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-hexigrid-csrf'] = decodeURIComponent(cookies.get('hexigrid_csrf') || '');
    const response = await fetch(`${origin}${route}`, {
      method,
      headers,
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const payload = await response.json();
    assert.ok(response.ok, `Synthetic owner API ${method} ${route} returned ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  }

  try {
    start();
    await ready();
    await request('/api/auth/status');
    await request('/api/auth/setup', 'POST', { password: 'synthetic-provider-restart-passphrase' });
    const created = await request('/api/providers', 'POST', {
      name: 'Synthetic local restart provider',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: 'synthetic-restart-model'
    });
    const providerId = created.provider.id;
    const saved = await request(`/api/providers/${providerId}/limits`, 'PATCH', {
      maxInputTokens: 12000,
      maxOutputTokens: 4096
    });
    assert.equal(saved.provider.maxInputTokens, 12000);
    assert.equal(saved.provider.maxOutputTokens, 4096);
    assert.equal(saved.receipt.status, 'completed');

    await stop();
    cookies.clear();
    start();
    await ready();
    await request('/api/auth/status');
    await request('/api/auth/login', 'POST', { password: 'synthetic-provider-restart-passphrase' });
    const restored = await request('/api/bootstrap');
    const provider = restored.providers.find(item => item.id === providerId);
    assert.ok(provider, 'the same provider remains after process restart');
    assert.equal(provider.maxInputTokens, 12000);
    assert.equal(provider.maxOutputTokens, 4096);
    assert.equal(restored.receipts.find(item => item.id === saved.receipt.id)?.action, `provider:${providerId}:limits`);
    assert.equal(restored.receipts.find(item => item.id === saved.receipt.id)?.status, 'completed');
  } finally {
    await stop();
    const realTemp = await realpath(os.tmpdir());
    const realRoot = await realpath(qa);
    const relative = path.relative(realTemp, realRoot);
    assert.ok(path.basename(realRoot).startsWith(prefix) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(realRoot, { recursive: true, force: true });
  }
});
