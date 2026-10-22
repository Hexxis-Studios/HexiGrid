import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { completeWithProvider, validateProvider } from '../lib/providers.mjs';

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const baseContext = (extra = {}) => vm.createContext({
  crypto: webcrypto, URL, AbortSignal, AbortController, Response, structuredClone,
  location: { origin: 'https://hexigrid.example', protocol: 'https:' }, navigator: { onLine: true }, console,
  ...extra
});

const providerInput = (overrides = {}) => ({ name: 'Example provider', baseUrl: 'https://example.com/v1', models: 'example-model', ...overrides });

test('provider input-context limit is optional and bounded to integers from 1 through 1000000', () => {
  const withoutLimit = validateProvider(providerInput());
  assert.equal(Object.hasOwn(withoutLimit, 'maxInputTokens'), false);
  assert.equal(validateProvider(providerInput({ maxInputTokens: 1 })).maxInputTokens, 1);
  assert.equal(validateProvider(providerInput({ maxInputTokens: 1000000 })).maxInputTokens, 1000000);

  for (const maxInputTokens of [0, -1, 1000001, 1.5, NaN, Infinity, null, '128', '']) {
    assert.throws(() => validateProvider(providerInput({ maxInputTokens })), /Input-context token limit must be an integer from 1 to 1000000/);
  }
});

test('server provider rejects over-budget text and configured image input before fake fetch dispatch', async () => {
  const provider = validateProvider(providerInput({ maxInputTokens: 1 }));
  let fetchCount = 0;
  const fetcher = async () => { fetchCount++; throw new Error('fetch must not run'); };

  await assert.rejects(() => completeWithProvider(provider, '', 'example-model', '12345', { fetcher }), /estimated 2 tokens; limit 1/);
  await assert.rejects(() => completeWithProvider(provider, '', 'example-model', {
    text: 'short', imageDataUrl: `data:image/png;base64,${Buffer.from('x').toString('base64')}`
  }, { fetcher }), /cannot be checked for image input/);
  assert.equal(fetchCount, 0);
});

test('server provider with no input limit keeps the existing request and output cap behavior', async () => {
  const provider = validateProvider(providerInput({ maxOutputTokens: 1234 }));
  let fetchCount = 0;
  await completeWithProvider(provider, '', 'example-model', 'hello', {
    fetcher: async (url, options) => {
      fetchCount++;
      assert.equal(url, 'https://example.com/v1/chat/completions');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'example-model', messages: [{ role: 'user', content: 'hello' }], stream: false, max_tokens: 1234
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200 });
    }
  });
  assert.equal(fetchCount, 1);
  assert.equal(Object.hasOwn(provider, 'maxInputTokens'), false);
});

test('browser provider guards the whole conversation, keeps optional limits compatible, and blocks unmeasurable images', async () => {
  const requests = [];
  const context = baseContext({ fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  context.window = context;
  vm.runInContext(await read('browser-providers.js'), context);
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }];

  await assert.rejects(() => context.HexiGridBrowserProviders.complete({ baseUrl: 'https://provider.example/v1', maxInputTokens: 1 }, '', 'test-model', messages), /estimated 3 tokens; limit 1/);
  await assert.rejects(() => context.HexiGridBrowserProviders.complete({ baseUrl: 'https://provider.example/v1', maxInputTokens: 10 }, '', 'test-model', [
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }
  ]), /cannot be checked for image input/);
  assert.equal(requests.length, 0);

  await context.HexiGridBrowserProviders.complete({ baseUrl: 'https://provider.example/v1', maxOutputTokens: 1234 }, '', 'test-model', messages);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).max_tokens, 1234);
  assert.equal(context.HexiGridBrowserProviders.estimateTextTokens('hello'), 2);
});

test('standalone provider creation stores the limit and rejects before a direct browser request', async () => {
  let saved = null;
  let unlocked = false;
  const vault = {
    status: async () => ({ configured: Boolean(saved), unlocked }),
    setup: async (_passcode, initial) => { saved = structuredClone(initial); unlocked = true; },
    unlock: async () => { unlocked = true; return structuredClone(saved); },
    lock: () => { unlocked = false; },
    read: () => { if (!unlocked) throw new Error('Unlock this browser first.'); return structuredClone(saved); },
    write: async (next) => { saved = structuredClone(next); },
    replaceFromBackup: async (next) => { saved = structuredClone(next); }
  };
  const requests = [];
  const context = baseContext({ fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  context.window = context;
  context.HexiGridBrowserVault = vault;
  vm.runInContext(await read('browser-providers.js'), context);
  vm.runInContext(await read('standalone-runtime.js'), context);

  await context.HexiGridStandalone.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: 'test-only browser passphrase' }) });
  const connected = await context.HexiGridStandalone.request('/api/providers', { method: 'POST', body: JSON.stringify({
    name: 'Direct', baseUrl: 'https://provider.example/v1', models: 'limited-model', maxInputTokens: 1
  }) });
  assert.equal(connected.provider.maxInputTokens, 1);
  assert.equal(vault.read().providers[0].maxInputTokens, 1);

  const agent = await context.HexiGridStandalone.request('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Tester', model: `provider:${connected.provider.id}:limited-model` }) });
  const room = await context.HexiGridStandalone.request('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Test' }) });
  await context.HexiGridStandalone.request(`/api/rooms/${room.room.id}`, { method: 'PATCH', body: JSON.stringify({ agentIds: [agent.agent.id] }) });
  await context.HexiGridStandalone.request(`/api/rooms/${room.room.id}/messages/user`, { method: 'POST', body: JSON.stringify({ content: 'This input is over the configured estimate.', agentIds: [agent.agent.id] }) });
  await assert.rejects(() => context.HexiGridStandalone.request(`/api/rooms/${room.room.id}/messages`, { method: 'POST', body: JSON.stringify({ agentIds: [agent.agent.id], includeUserMessage: false }) }), /input-context limit/);
  assert.equal(requests.length, 0);
});
