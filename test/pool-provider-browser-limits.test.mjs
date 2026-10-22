import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const baseContext = (extra = {}) => vm.createContext({
  crypto: webcrypto, URL, AbortSignal, AbortController, Response, structuredClone,
  location: { origin: 'https://hexigrid.example', protocol: 'https:' }, navigator: { onLine: true }, console,
  ...extra
});

test('browser provider completions preserve output-token defaults and apply configured limits', async () => {
  const cases = [
    { style: 'openai-chat', url: '/chat/completions', field: 'max_tokens', defaultValue: undefined, response: { choices: [{ message: { content: 'reply' } }] } },
    { style: 'openai-responses', url: '/responses', field: 'max_output_tokens', defaultValue: undefined, response: { output_text: 'reply' } },
    { style: 'anthropic', url: '/messages', field: 'max_tokens', defaultValue: 4096, response: { content: [{ type: 'text', text: 'reply' }] } },
    { style: 'google-gemini', url: '/models/test-model:generateContent', container: 'generationConfig', field: 'maxOutputTokens', defaultValue: 4096, response: { candidates: [{ content: { parts: [{ text: 'reply' }] } }] } }
  ];

  for (const item of cases) {
    for (const limit of [undefined, 1234]) {
      const requests = [];
      const fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(item.response), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const context = baseContext({ fetch });
      context.window = context;
      vm.runInContext(await read('browser-providers.js'), context);
      await context.HexiGridBrowserProviders.complete({
        baseUrl: 'https://provider.example/v1', apiStyle: item.style,
        ...(limit === undefined ? {} : { maxOutputTokens: limit })
      }, '', 'test-model', [{ role: 'user', content: 'hello' }]);

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, `https://provider.example/v1${item.url}`);
      const body = JSON.parse(requests[0].options.body);
      const generated = item.container ? body[item.container] : body;
      assert.equal(generated[item.field], limit ?? item.defaultValue);
      assert.equal(Object.hasOwn(generated, item.field), limit !== undefined || item.defaultValue !== undefined);
    }
  }
});

test('standalone provider creation preserves a numeric output limit and uses it for direct completion', async () => {
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
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'limited reply' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const context = baseContext({ fetch });
  context.window = context;
  context.HexiGridBrowserVault = vault;
  vm.runInContext(await read('browser-providers.js'), context);
  vm.runInContext(await read('standalone-runtime.js'), context);

  await context.HexiGridStandalone.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: 'long browser passcode' }) });
  const connected = await context.HexiGridStandalone.request('/api/providers', { method: 'POST', body: JSON.stringify({
    name: 'Direct', baseUrl: 'https://provider.example/v1', apiStyle: 'openai-chat', models: 'limited-model', apiKey: 'private-key', maxOutputTokens: 1234
  }) });
  assert.equal(connected.provider.maxOutputTokens, 1234);
  assert.equal(connected.provider.secret, undefined);
  assert.equal(connected.provider.hasKey, true);
  assert.equal(vault.read().providers[0].maxOutputTokens, 1234);
  assert.equal(vault.read().providers[0].secret, 'private-key');

  const created = await context.HexiGridStandalone.request('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'Tester', model: `provider:${connected.provider.id}:limited-model` }) });
  const room = await context.HexiGridStandalone.request('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Test' }) });
  await context.HexiGridStandalone.request(`/api/rooms/${room.room.id}`, { method: 'PATCH', body: JSON.stringify({ agentIds: [created.agent.id] }) });
  await context.HexiGridStandalone.request(`/api/rooms/${room.room.id}/messages/user`, { method: 'POST', body: JSON.stringify({ content: 'hello', agentIds: [created.agent.id] }) });
  await context.HexiGridStandalone.request(`/api/rooms/${room.room.id}/messages`, { method: 'POST', body: JSON.stringify({ agentIds: [created.agent.id], includeUserMessage: false }) });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://provider.example/v1/chat/completions');
  assert.equal(JSON.parse(requests[0].options.body).max_tokens, 1234);
  const withoutLimit = await context.HexiGridStandalone.request('/api/providers', { method: 'POST', body: JSON.stringify({
    name: 'Default', baseUrl: 'https://provider.example/v1', models: 'default-model'
  }) });
  assert.equal(Object.hasOwn(withoutLimit.provider, 'maxOutputTokens'), false);
  for (const maxOutputTokens of [0, 32769, 1.5, '1234', null]) {
    await assert.rejects(() => context.HexiGridStandalone.request('/api/providers', { method: 'POST', body: JSON.stringify({
      name: 'Invalid', baseUrl: 'https://provider.example/v1', models: 'invalid-model', maxOutputTokens
    }) }), /Output token limit must be an integer from 1 to 32768/);
  }
});
