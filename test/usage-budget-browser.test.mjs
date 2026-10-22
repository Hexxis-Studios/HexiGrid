import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { usageBudgetFeedback } from '../lib/budget-feedback.mjs';

const read = file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const exhausted = [{ createdAt: new Date().toISOString(), inputTokens: 100, outputTokens: 0 }];

test('browser and server budget projections agree, including bad counts and rolling expiry', async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await read('browser-providers.js'), context);
  const records = [...exhausted, { ...exhausted[0], inputTokens: -500, outputTokens: Infinity }];
  const now = Date.now();
  for (const limit of [null, 100, 200]) {
    assert.deepEqual(JSON.parse(JSON.stringify(context.window.HexiGridBrowserProviders.usageBudgetFeedback(limit, records, now))), usageBudgetFeedback(limit, records, now));
  }
});

test('production on-device entry refuses exhausted or unavailable preflight before touching GPU', async () => {
  const app = await read('app.js');
  const start = app.indexOf('window.hexigridCheckUsageBudget =');
  const end = app.indexOf('\nfunction migrateLocalPreferences', start);
  assert.ok(start >= 0 && end > start);
  let gateCalls = 0, gpuChecks = 0;
  const context = vm.createContext({ window: {}, api: async path => {
    assert.equal(path, '/api/usage/budget'); gateCalls++;
    return { budget: { flag: 'exhausted' } };
  }, navigator: { get gpu() { gpuChecks++; throw Error('GPU must not be used'); } } });
  vm.runInContext(app.slice(start, end), context);
  vm.runInContext(await read('on-device-inference.js'), context);
  await assert.rejects(() => context.window.HexiGridOnDevice.complete({ modelId: 'synthetic-model', messages: [{ role: 'user', content: 'harmless' }] }), /budget is exhausted/);
  context.api = async () => { throw Error('synthetic budget service unavailable'); };
  await assert.rejects(() => context.window.HexiGridOnDevice.complete({ modelId: 'synthetic-model', messages: [{ role: 'user', content: 'harmless' }] }), /budget service unavailable/);
  assert.equal(gateCalls, 1);
  assert.equal(gpuChecks, 0);
});

test('standalone assistant and room reply check the local ledger before provider fetch', async () => {
  let saved, requests = 0;
  const vault = { status: async () => ({ configured: Boolean(saved), unlocked: true }),
    setup: async (_password, initial) => { saved = structuredClone(initial); },
    read: () => structuredClone(saved), write: async value => { saved = structuredClone(value); } };
  const context = vm.createContext({ window: {}, crypto: webcrypto, URL, AbortController, AbortSignal, Response, structuredClone,
    location: { origin: 'https://synthetic.example', protocol: 'https:' }, navigator: { onLine: true }, console,
    fetch: async () => { requests++; throw Error('fetch must not run'); } });
  context.window = context;
  context.HexiGridBrowserVault = vault;
  vm.runInContext(await read('browser-providers.js'), context);
  vm.runInContext(await read('standalone-runtime.js'), context);
  const api = (path, method = 'GET', body) => context.HexiGridStandalone.request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  await api('/api/auth/setup', 'POST', { password: 'synthetic test passphrase' });
  const { provider } = await api('/api/providers', 'POST', { name: 'Synthetic', baseUrl: 'https://synthetic.example/v1', models: 'test-model' });
  const { agent } = await api('/api/agents', 'POST', { name: 'Synthetic', model: `provider:${provider.id}:test-model` });
  const { room } = await api('/api/rooms', 'POST', { name: 'Synthetic' });
  await api(`/api/rooms/${room.id}`, 'PATCH', { agentIds: [agent.id] });
  saved.settings.tokenBudget7d = 100;
  saved.settings.model = agent.model;
  saved.usage = exhausted;
  assert.equal((await api('/api/usage/budget')).budget.flag, 'exhausted');
  await assert.rejects(() => api('/api/assistant', 'POST', { content: 'harmless' }), /budget is exhausted/);
  await assert.rejects(() => api(`/api/rooms/${room.id}/messages`, 'POST', { content: 'harmless', agentIds: [agent.id] }), /budget is exhausted/);
  assert.equal(requests, 0);

  const change = body => api('/api/usage/budget', 'PUT', body);
  await assert.rejects(() => change({ tokens: null, expectedTokens: 99, approved: true }), /budget changed/);
  await assert.rejects(() => change({ tokens: 0, expectedTokens: 100, approved: true }), /positive/);
  await assert.rejects(() => change({ tokens: null, expectedTokens: 100 }), /Approve/);
  saved.settings.workMode = 'plan';
  await assert.rejects(() => change({ tokens: null, expectedTokens: 100, approved: true }), /Planning/);
  saved.settings.workMode = 'converse';
  const write = vault.write;
  vault.write = async () => { throw Error('synthetic persistence failure'); };
  await assert.rejects(() => change({ tokens: null, expectedTokens: 100, approved: true }), /persistence/);
  assert.equal(saved.settings.tokenBudget7d, 100);
  vault.write = write;
  const cleared = await change({ tokens: null, expectedTokens: 100, approved: true });
  assert.equal(cleared.tokenBudget7d, null);
  assert.ok(cleared.receiptId);
  assert.equal((await api('/api/bootstrap')).usageBudget.flag, 'unconfigured');

  let release;
  vault.write = next => new Promise(resolve => { release = () => { saved = structuredClone(next); resolve(); }; });
  const pending = change({ tokens: 200, expectedTokens: null, approved: true });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => change({ tokens: 300, expectedTokens: null, approved: true }), /in progress/);
  release();
  await pending;
  assert.equal(saved.settings.tokenBudget7d, 200);
});
