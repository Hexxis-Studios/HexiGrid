import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeCall, validateRealtimeCall } from '../lib/realtime-provider.mjs';

const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

test('realtime call validation bounds browser SDP and requires a model', () => {
  assert.equal(validateRealtimeCall({ sdp: offer, model: 'gpt-realtime' }).model, 'gpt-realtime');
  assert.throws(() => validateRealtimeCall({ sdp: 'not-sdp', model: 'gpt-realtime' }), /valid WebRTC offer/);
  assert.throws(() => validateRealtimeCall({ sdp: offer }), /realtime model/);
});

test('realtime handshake keeps the API key server-side and validates the SDP answer', async () => {
  const result = await createRealtimeCall({ baseUrl: 'https://api.example/v1', apiStyle: 'openai-responses' }, 'private-key', { sdp: offer, model: 'gpt-realtime', voice: 'voice_1234', instructions: 'Be concise.' }, { fetcher: async (url, options) => {
    assert.equal(url, 'https://api.example/v1/realtime/calls');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer private-key');
    assert.equal(options.body instanceof FormData, true);
    assert.deepEqual(JSON.parse(await options.body.get('session').text()).audio.output.voice, { id: 'voice_1234' });
    return new Response(answer, { status: 201, headers: { 'content-type': 'application/sdp' } });
  } });
  assert.equal(result.answerSdp, answer);
  await assert.rejects(createRealtimeCall({ baseUrl: 'https://api.example/v1', apiStyle: 'anthropic' }, 'key', { sdp: offer, model: 'realtime' }), /OpenAI-compatible/);
});

test('caller cancellation reaches the provider request and preserves the abort outcome', async () => {
  const controller = new AbortController();
  let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  const call = createRealtimeCall({ baseUrl: 'https://api.example/v1', apiStyle: 'openai-responses' }, 'synthetic-key', { sdp: offer, model: 'realtime' }, {
    signal: controller.signal,
    fetcher: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      dispatched(signal);
    })
  });
  const signal = await started; controller.abort();
  assert.equal(signal.aborted, true);
  await assert.rejects(call, { name: 'AbortError' });
});
