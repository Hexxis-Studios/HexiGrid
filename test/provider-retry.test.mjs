import test from 'node:test';
import assert from 'node:assert/strict';
import { completeWithProvider } from '../lib/providers.mjs';

const provider = { baseUrl: 'https://provider.example/v1', apiStyle: 'openai-chat' };
const ok = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
const failed = status => ({ ok: false, status });

test('429, 5xx, and network failures retry with capped exponential backoff', async () => {
  for (const failure of [() => failed(429), () => failed(503), () => { throw new TypeError('network'); }]) {
    let calls = 0; const delays = [];
    await assert.rejects(completeWithProvider(provider, '', 'm', 'p', {
      maxAttempts: 4, fetcher: async () => { calls++; return failure(); }, sleep: async ms => delays.push(ms)
    }));
    assert.equal(calls, 4);
    assert.deepEqual(delays, [250, 500, 1000]);
  }
  let calls = 0; const delays = [];
  const result = await completeWithProvider(provider, '', 'm', 'p', {
    maxAttempts: 4, fetcher: async () => ++calls < 3 ? failed(503) : ok(), sleep: async ms => delays.push(ms)
  });
  assert.equal(result.content, 'ok'); assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);
});

test('401, 403, and invalid request statuses fail immediately', async () => {
  for (const status of [400, 401, 403, 422]) {
    let calls = 0;
    await assert.rejects(completeWithProvider(provider, '', 'm', 'p', { fetcher: async () => { calls++; return failed(status); }, sleep: async () => {} }));
    assert.equal(calls, 1);
  }
});

test('abort during backoff cancels before another attempt', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(completeWithProvider(provider, '', 'm', 'p', {
    signal: controller.signal,
    fetcher: async () => { calls++; return failed(429); },
    sleep: async (_ms, signal) => { controller.abort(); assert.equal(signal, controller.signal); }
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('abort interrupts the default provider retry wait instead of waiting out backoff', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = completeWithProvider(provider, '', 'm', 'p', {
    signal: controller.signal,
    fetcher: async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return failed(503);
    }
  });
  const settledPromptly = await Promise.race([
    pending.then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  assert.equal(settledPromptly, true, 'the cancelled request should not wait for the 250 ms retry backoff');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});
