import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSpeechWithProvider, validateSpeechRequest } from '../lib/speech-provider.mjs';

test('speech request is bounded and requires model, voice, and text', () => {
  assert.deepEqual(validateSpeechRequest({ model: 'tts-model', voice: 'custom-voice', text: 'Hello' }), { model: 'tts-model', voice: 'custom-voice', text: 'Hello' });
  assert.throws(() => validateSpeechRequest({ model: 'tts-model', text: 'Hello' }), /voice/i);
});

test('OpenAI-compatible speech stays on the configured origin and accepts audio only', async () => {
  const result = await generateSpeechWithProvider({ baseUrl: 'https://speech.example/v1', apiStyle: 'openai-responses' }, 'private-key', { model: 'tts-model', voice: 'voice-id', text: 'Hello' }, { fetcher: async (url, options) => {
    assert.equal(url, 'https://speech.example/v1/audio/speech');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer private-key');
    assert.deepEqual(JSON.parse(options.body), { model: 'tts-model', voice: 'voice-id', input: 'Hello', response_format: 'mp3' });
    return new Response(Buffer.from('audio-bytes'), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.bytes.toString(), 'audio-bytes');
  await assert.rejects(generateSpeechWithProvider({ baseUrl: 'https://speech.example/v1', apiStyle: 'anthropic' }, 'key', { model: 'm', voice: 'v', text: 't' }), /OpenAI-compatible/);
  await assert.rejects(generateSpeechWithProvider({ baseUrl: 'https://speech.example/v1', apiStyle: 'openai-chat' }, 'key', { model: 'm', voice: 'v', text: 't' }, { fetcher: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }), /unsupported audio/);
});

test('provider-issued custom voice IDs use the custom voice object format', async () => {
  await generateSpeechWithProvider({ baseUrl: 'https://speech.example/v1', apiStyle: 'openai-chat' }, 'key', { model: 'tts-model', voice: 'voice_1234', text: 'Hello' }, { fetcher: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).voice, { id: 'voice_1234' });
    return new Response(Buffer.from('audio'), { headers: { 'content-type': 'audio/mpeg' } });
  } });
});
