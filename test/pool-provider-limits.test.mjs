import test from 'node:test';
import assert from 'node:assert/strict';
import { completeWithProvider, validateProvider } from '../lib/providers.mjs';

const providerInput = overrides => ({
  name: 'Example provider',
  baseUrl: 'https://example.com/v1',
  models: 'example-model',
  ...overrides
});

test('provider output token limits are optional integers from 1 through 32768', () => {
  const withoutLimit = validateProvider(providerInput({}));
  assert.equal(Object.hasOwn(withoutLimit, 'maxOutputTokens'), false);
  assert.equal(validateProvider(providerInput({ maxOutputTokens: 1 })).maxOutputTokens, 1);
  assert.equal(validateProvider(providerInput({ maxOutputTokens: 32768 })).maxOutputTokens, 32768);

  for (const maxOutputTokens of [0, -1, 32769, 1.5, NaN, Infinity, null, '128', '']) {
    assert.throws(
      () => validateProvider(providerInput({ maxOutputTokens })),
      /Output token limit must be an integer from 1 to 32768/
    );
  }
});

test('provider output token limits use each API style field and preserve defaults when omitted', async () => {
  const cases = [
    {
      style: 'openai-chat',
      baseUrl: 'https://example.com/v1',
      url: 'https://example.com/v1/chat/completions',
      response: { choices: [{ message: { content: 'reply' } }] },
      limited: { model: 'example-model', messages: [{ role: 'user', content: 'hello' }], stream: false, max_tokens: 1234 },
      unchanged: { model: 'example-model', messages: [{ role: 'user', content: 'hello' }], stream: false }
    },
    {
      style: 'openai-responses',
      baseUrl: 'https://example.com/v1',
      url: 'https://example.com/v1/responses',
      response: { output_text: 'reply' },
      limited: { model: 'example-model', input: 'hello', max_output_tokens: 1234 },
      unchanged: { model: 'example-model', input: 'hello' }
    },
    {
      style: 'anthropic',
      baseUrl: 'https://example.com/v1',
      url: 'https://example.com/v1/messages',
      response: { content: [{ type: 'text', text: 'reply' }] },
      limited: { model: 'example-model', max_tokens: 1234, messages: [{ role: 'user', content: 'hello' }] },
      unchanged: { model: 'example-model', max_tokens: 4096, messages: [{ role: 'user', content: 'hello' }] }
    },
    {
      style: 'google-gemini',
      baseUrl: 'https://example.com/v1',
      url: 'https://example.com/v1/models/example-model:generateContent',
      response: { candidates: [{ content: { parts: [{ text: 'reply' }] } }] },
      limited: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 1234 } },
      unchanged: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 4096 } }
    }
  ];

  for (const item of cases) {
    for (const [maxOutputTokens, expected] of [[1234, item.limited], [undefined, item.unchanged]]) {
      let requestCount = 0;
      await completeWithProvider({ baseUrl: item.baseUrl, apiStyle: item.style, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }, '', 'example-model', 'hello', {
        fetcher: async (url, options) => {
          requestCount++;
          assert.equal(url, item.url);
          assert.equal(options.method, 'POST');
          assert.deepEqual(JSON.parse(options.body), expected);
          return new Response(JSON.stringify(item.response), { status: 200 });
        }
      });
      assert.equal(requestCount, 1);
    }
  }
});
