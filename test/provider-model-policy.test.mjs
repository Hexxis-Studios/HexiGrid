import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { requiresProviderKey } from '../lib/providers.mjs';
const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const from = source.indexOf('function allowedModel('), to = source.indexOf('\nfunction isSafeMemoryLearningModelId(', from);
assert.ok(from >= 0 && to > from);
function fixture(policy, overrides = {}) {
  const provider = { id: 'synthetic', baseUrl: 'https://api.openai.com/v1', local: false, enabled: true, hasKey: true, modelIds: ['known'], ...overrides };
  const context = vm.createContext({ state: { providers: [provider], settings: { modelPolicy: policy } }, modelCatalog: [{ id: 'native-free', free: true }, { id: 'native-paid', free: false }], requiresProviderKey, isOnDeviceProvider: () => false });
  vm.runInContext(source.slice(from, to), context);
  return context;
}
test('server routing applies no-cost policy to configured remote providers as well as native catalog models', () => {
  const restricted = fixture('free-only');
  assert.equal(restricted.allowedModel('provider:synthetic:known'), null);
  assert.equal(restricted.allowedModel('native-paid'), null);
  assert.equal(restricted.allowedModel('native-free').id, 'native-free');
  assert.equal(fixture('all-models').allowedModel('provider:synthetic:known').remoteModel, 'known');
  assert.equal(fixture('free-only', { baseUrl: 'http://127.0.0.1:1234/v1', local: true, hasKey: false }).allowedModel('provider:synthetic:known').remoteModel, 'known');
});
test('changing the current model policy immediately blocks a retained cloud choice without restoring disabled or unauthenticated providers', () => {
  const context = fixture('all-models');
  assert.ok(context.allowedModel('provider:synthetic:known'));
  context.state.settings.modelPolicy = 'free-only';
  assert.equal(context.allowedModel('provider:synthetic:known'), null);
  for (const override of [{ enabled: false }, { hasKey: false }]) assert.equal(fixture('all-models', override).allowedModel('provider:synthetic:known'), null);
  assert.equal(fixture('all-models').allowedModel('provider:synthetic:unknown'), null);
});

test('policy fallback selects an available permitted provider and never falls back to a blocked paid model', () => {
  const context = fixture('free-only');
  context.modelCatalog = [{ id: 'native-paid', free: false }];
  assert.equal(context.firstAllowedModelId(), '');
  context.state.providers.push({ id: 'local', baseUrl: 'http://127.0.0.1:1234/v1', local: true, enabled: true, modelIds: ['cpu'] });
  assert.equal(context.firstAllowedModelId(), 'provider:local:cpu');
  context.state.providers[1].enabled = false;
  assert.equal(context.firstAllowedModelId(), '');
  context.state.settings.modelPolicy = 'all-models';
  assert.equal(context.firstAllowedModelId(), 'native-paid');
});

test('actual owner APIs refuse cloud model selection and fall back to a configured local model under no-cost policy', { timeout: 30000 }, async () => {
  const prefix = 'hexigrid-provider-policy-', qa = await mkdtemp(path.join(os.tmpdir(), prefix));
  const profile = path.join(qa, 'profile'); await mkdir(profile);
  async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
  const ownerPort = await port(), relayPort = await port(), origin = `http://127.0.0.1:${ownerPort}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: 'ignore', env: {
    SystemRoot: process.env.SystemRoot || '', HEXIGRID_PORT: String(ownerPort), HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`, HEXIGRID_DATA_DIR: path.join(qa, 'data'), HEXIGRID_DISABLE_OS_VAULT: '1', HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile, CODEX_CLI: path.join(qa, 'missing-codex'), OPENCODE_CLI: path.join(qa, 'missing-opencode'), CLAUDE_CLI: path.join(qa, 'missing-claude')
  } });
  const cookies = new Map();
  async function call(route, method = 'GET', body) {
    const headers = { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-hexigrid-csrf'] = decodeURIComponent(cookies.get('hexigrid_csrf') || '');
    const response = await fetch(origin + route, { method, headers, signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
    const value = await response.json(); assert.ok(response.ok, `synthetic owner API ${response.status}`); return value;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/system/identity', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} assert.equal(child.exitCode, null); await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'owned synthetic server started');
    await call('/api/auth/status'); await call('/api/auth/setup', 'POST', { password: 'synthetic-provider-policy-only' });
    // Explicit model IDs avoid discovery. No model server exists and no inference is requested.
    const local = (await call('/api/providers', 'POST', { name: 'Synthetic local', baseUrl: 'http://127.0.0.1:1/v1', models: 'cpu' })).provider;
    const cloud = (await call('/api/providers', 'POST', { name: 'Synthetic remote', baseUrl: 'https://model-policy.invalid/v1', models: 'remote' })).provider;
    const localId = `provider:${local.id}:cpu`, cloudId = `provider:${cloud.id}:remote`;
    await call('/api/settings', 'PATCH', { modelPolicy: 'free-only', model: localId });
    assert.equal((await call('/api/settings', 'PATCH', { model: cloudId })).settings.model, localId);
    const agent = (await call('/api/agents', 'POST', { name: 'Policy fixture', model: cloudId, useMemories: false, learnFromConversations: false })).agent;
    assert.equal(agent.model, localId);
    assert.equal((await call(`/api/agents/${agent.id}`, 'PATCH', { model: cloudId })).agent.model, localId);
    assert.equal((await call('/api/settings', 'PATCH', { modelPolicy: 'all-models', model: cloudId })).settings.model, cloudId);
    assert.equal((await call('/api/settings', 'PATCH', { modelPolicy: 'free-only' })).settings.model, localId);
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));
    child.kill(); await exited;
    const realTemp = await realpath(os.tmpdir()), realRoot = await realpath(qa), relative = path.relative(realTemp, realRoot);
    assert.ok(path.basename(realRoot).startsWith(prefix) && relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(realRoot, { recursive: true, force: true });
  }
});
