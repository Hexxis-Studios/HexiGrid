import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  applyProviderLimitPatch, commitProviderLimitPatch, createProviderLimitRequest,
  normalizeProviderLimitPatch
} from '../lib/provider-limits.mjs';

const providerFixture = () => ({
  id: 'provider-1', name: 'Local API', baseUrl: 'http://127.0.0.1:9999/v1',
  modelIds: ['model-a'], apiKey: 'preserved-secret', hasKey: true,
  maxInputTokens: 12000, maxOutputTokens: 2048, enabled: true
});

test('overlapping writes refuse early and failed saves preserve unrelated concurrent receipts', async () => {
  const provider = providerFixture();
  const prior = { id: 'prior' }, concurrent = { id: 'concurrent' };
  const state = { receipts: [prior] };
  let rejectSave;
  const hooks = { addReceipt(values) { const receipt = { id: 'failed', ...values }; state.receipts.unshift(receipt); return receipt; },
    saveState: () => new Promise((_resolve, reject) => { rejectSave = reject; }) };
  const pending = commitProviderLimitPatch(state, provider, { maxOutputTokens: 6000 }, hooks);
  await assert.rejects(() => commitProviderLimitPatch(state, provider, { maxOutputTokens: null }, hooks), { status: 409 });
  state.receipts.unshift(concurrent);
  rejectSave(Error('synthetic failure'));
  await assert.rejects(() => pending, /synthetic failure/);
  assert.equal(provider.maxOutputTokens, 2048);
  assert.deepEqual(state.receipts, [concurrent, prior]);
});

test('partial updates preserve omissions and null clears an existing limit', () => {
  const updated = applyProviderLimitPatch(providerFixture(), { maxOutputTokens: null });
  assert.equal(updated.maxOutputTokens, undefined);
  assert.equal(updated.maxInputTokens, 12000);
  assert.equal(updated.apiKey, 'preserved-secret');
  assert.equal(updated.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.deepEqual(updated.modelIds, ['model-a']);
  assert.equal(updated.enabled, true);
  assert.deepEqual(normalizeProviderLimitPatch({ maxInputTokens: 500 }), { maxInputTokens: 500 });
});

test('empty, unknown, non-integer and out-of-range patches fail before mutation', async () => {
  const provider = providerFixture();
  const before = structuredClone(provider);
  for (const body of [{}, { maxInputTokens: 10, baseUrl: 'https://elsewhere.invalid' },
    { maxInputTokens: 1.5 }, { maxOutputTokens: 32769 }, { maxInputTokens: 0 },
    { maxInputTokens: 1000001 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }, []]) {
    assert.throws(() => applyProviderLimitPatch(provider, body));
  }
  assert.deepEqual(provider, before);
  const state = { providers: [provider], receipts: [{ id: 'old-receipt' }], activity: [{ id: 'old-activity' }] };
  await assert.rejects(commitProviderLimitPatch(state, provider, { enabled: false }, {
    addReceipt: () => assert.fail('invalid patch must not create a receipt'), saveState: () => assert.fail('invalid patch must not save')
  }));
  assert.deepEqual(provider, before);
  assert.deepEqual(state.receipts, [{ id: 'old-receipt' }]);
});

test('successful commit changes only limits and adds a provider receipt', async () => {
  const provider = providerFixture();
  const state = { providers: [provider], receipts: [{ id: 'prior' }], settings: { model: 'provider-1:model-a' }, activity: [{ id: 'kept' }] };
  const before = structuredClone(state);
  let saved = false;
  const result = await commitProviderLimitPatch(state, provider, { maxInputTokens: 8000 }, {
    addReceipt: (values) => {
      const receipt = { id: 'new-receipt', ...values };
      state.receipts.unshift(receipt);
      return receipt;
    },
    saveState: async () => { saved = true; }
  });
  assert.equal(saved, true);
  assert.equal(result.provider.maxInputTokens, 8000);
  assert.equal(result.provider.maxOutputTokens, before.providers[0].maxOutputTokens);
  assert.equal(result.provider.apiKey, before.providers[0].apiKey);
  assert.equal(result.provider.baseUrl, before.providers[0].baseUrl);
  assert.deepEqual(result.provider.modelIds, before.providers[0].modelIds);
  assert.equal(result.provider.enabled, before.providers[0].enabled);
  assert.equal(state.settings.model, before.settings.model);
  assert.deepEqual(state.activity, before.activity);
  assert.equal(state.receipts[0].action, 'provider:provider-1:limits');
  assert.equal(result.receipt.status, 'completed');
});

test('persistence failure rolls back limits and receipt changes', async () => {
  const provider = providerFixture();
  const state = { providers: [provider], receipts: [{ id: 'prior', detail: 'retained' }] };
  const beforeProvider = structuredClone(provider);
  const beforeReceipts = structuredClone(state.receipts);
  await assert.rejects(commitProviderLimitPatch(state, provider, { maxInputTokens: null, maxOutputTokens: 6000 }, {
    addReceipt: (values) => {
      const receipt = { id: 'new-receipt', ...values };
      state.receipts.unshift(receipt);
      return receipt;
    },
    saveState: async () => { throw new Error('persistence unavailable'); }
  }), /persistence unavailable/);
  assert.deepEqual(provider, beforeProvider);
  assert.deepEqual(state.receipts, beforeReceipts);
});

test('browser request builder dispatches the exact PATCH path and body', () => {
  assert.deepEqual(createProviderLimitRequest('provider-1', { maxInputTokens: 1000, maxOutputTokens: null }), {
    path: '/api/providers/provider-1/limits', method: 'PATCH',
    body: '{"maxInputTokens":1000,"maxOutputTokens":null}'
  });
});

test('standalone router commits supported limits without model or provider discovery calls', async () => {
  const source = await readFile(new URL('../public/standalone-runtime.js', import.meta.url), 'utf8');
  const provider = { ...providerFixture(), kind: 'browser-cloud', secret: 'browser-secret' };
  const state = { settings: { model: 'provider-1:model-a' }, providers: [provider], agents: [], receipts: [], activity: [] };
  let writes = 0;
  const window = {
    HexiGridProviderLimits: await import('../lib/provider-limits.mjs'),
    HexiGridBrowserVault: { read: () => state, write: async () => { writes += 1; } }
  };
  vm.runInNewContext(source, {
    window, location: { origin: 'http://local.test' }, URL, crypto: webcrypto,
    structuredClone, Date, console
  });
  const result = await window.HexiGridStandalone.request('/api/providers/provider-1/limits', {
    method: 'PATCH', body: JSON.stringify({ maxOutputTokens: 4096 })
  });
  assert.equal(result.provider.maxOutputTokens, 4096);
  assert.equal(result.provider.maxInputTokens, 12000);
  assert.equal(result.provider.secret, undefined);
  assert.equal(result.receipt.action, 'provider:provider-1:limits');
  assert.equal(writes, 1);

  const before = structuredClone(state);
  await assert.rejects(window.HexiGridStandalone.request('/api/providers/provider-1/limits', {
    method: 'PATCH', body: JSON.stringify({ maxOutputTokens: 4000, apiKey: 'other-secret' })
  }), /Unknown provider limit field/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), before);
  assert.equal(writes, 1);

  state.providers[0] = { id: 'device-1', name: 'On-device', kind: 'browser-webllm', maxOutputTokens: 1000 };
  const beforeDevice = structuredClone(state);
  await assert.rejects(window.HexiGridStandalone.request('/api/providers/device-1/limits', {
    method: 'PATCH', body: JSON.stringify({ maxOutputTokens: 2000 })
  }), /on-device provider/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), beforeDevice);
  assert.equal(writes, 1);
});

test('host owner gate, browser editor and both agent catalogs expose the focused route', async () => {
  const [server, browser, hostCatalog, standalone] = await Promise.all([
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/providers.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/agent-interface.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/standalone-runtime.js', import.meta.url), 'utf8')
  ]);
  assert.match(server, /method === 'PATCH' && providerMatch\[2\] === 'limits' && \(!isHostRequest\(req\) \|\| !authenticatedMemoryOwner\(req\)\)/);
  assert.match(server, /isOnDeviceProvider\(provider\)/);
  assert.match(browser, /<summary>Edit token limits<\/summary>/);
  assert.match(browser, /data-provider-limits-save/);
  assert.match(browser, /createProviderLimitRequest\(id/);
  assert.match(hostCatalog, /updateProviderLimits: \{ method: 'PATCH', pathTemplate: '\/api\/providers\/\{providerId\}\/limits'/);
  assert.match(standalone, /updateProviderLimits: \{ method: 'PATCH', path: '\/api\/providers\/\{providerId\}\/limits'/);
});

test('provider limit editor submits through the owner route and recovers from invalid input or save errors', async () => {
  const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
  const start = source.indexOf("document.addEventListener('click',async(event)=>{");
  const marker = source.indexOf('\n});', start);
  assert.ok(start >= 0 && marker > start, 'provider click handler exists');
  const handler = source.slice(start, marker + 4);

  async function clickLimitSave({ valid = true, fail = false } = {}) {
    const listeners = [], requests = [], notices = [];
    const button = { dataset: { providerLimitsSave: 'provider-1' }, disabled: false };
    const values = { '[data-provider-max-input]': { value: '' }, '[data-provider-max-output]': { value: '4096' } };
    const form = { reportValidity: () => valid, querySelector: selector => values[selector] };
    const original = providerFixture();
    const state = { data: { providers: [original] } };
    let renders = 0;
    const document = {
      addEventListener(type, listener) { if (type === 'click') listeners.push(listener); },
      querySelector(selector) { assert.equal(selector, '[data-provider-limits-form="provider-1"]'); return form; }
    };
    const context = vm.createContext({
      document,
      window: { HexiGridProviderLimits: await import('../lib/provider-limits.mjs') },
      state,
      async api(url, options) {
        requests.push({ url, options });
        if (fail) throw new Error('Synthetic settings write failure');
        return { provider: { ...original, maxInputTokens: undefined, maxOutputTokens: 4096 }, receipt: { status: 'completed' } };
      },
      renderProviders() { renders++; },
      notify(message, error) { notices.push({ message, error }); }
    });
    vm.runInNewContext(handler, context);
    let prevented = false;
    await listeners[0]({
      target: { closest(selector) { assert.match(selector, /data-provider-limits-save/); return button; } },
      preventDefault() { prevented = true; }
    });
    return { button, notices, original, prevented, renders, requests, state };
  }

  const success = await clickLimitSave();
  assert.equal(success.prevented, true);
  assert.deepEqual(success.requests.map(({ url, options }) => ({ url, method: options.method, body: JSON.parse(options.body) })), [
    { url: '/api/providers/provider-1/limits', method: 'PATCH', body: { maxInputTokens: null, maxOutputTokens: 4096 } }
  ]);
  assert.equal(success.state.data.providers[0].maxOutputTokens, 4096);
  assert.equal(success.renders, 1);
  assert.deepEqual(success.notices, [{ message: 'Provider token limits updated.', error: undefined }]);
  assert.equal(success.button.disabled, false);

  const invalid = await clickLimitSave({ valid: false });
  assert.equal(invalid.requests.length, 0);
  assert.equal(invalid.renders, 0);
  assert.deepEqual(invalid.notices, []);
  assert.equal(invalid.button.disabled, false);

  const failed = await clickLimitSave({ fail: true });
  assert.equal(failed.requests.length, 1);
  assert.equal(failed.state.data.providers[0], failed.original);
  assert.equal(failed.renders, 0);
  assert.deepEqual(failed.notices, [{ message: 'Synthetic settings write failure', error: true }]);
  assert.equal(failed.button.disabled, false);
});
