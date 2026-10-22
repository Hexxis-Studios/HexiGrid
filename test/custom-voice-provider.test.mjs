import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomVoice, validateCustomVoiceRequest } from '../lib/custom-voice-provider.mjs';

const audio = `data:audio/webm;base64,${Buffer.from('audio-bytes').toString('base64')}`;

test('custom voice input requires explicit consent and bounded supported audio', () => {
  assert.equal(validateCustomVoiceRequest({ name: 'Atlas', language: 'en-US', consentAudio: audio, sampleAudio: audio, consentConfirmed: true }).name, 'Atlas');
  assert.throws(() => validateCustomVoiceRequest({ name: 'Atlas', language: 'en-US', consentAudio: audio, sampleAudio: audio }), /explicitly confirm/);
  assert.throws(() => validateCustomVoiceRequest({ name: 'Atlas', language: 'english', consentAudio: audio, sampleAudio: audio, consentConfirmed: true }), /language tag/);
});

test('custom voice creation uploads consent then sample without returning recordings', async () => {
  const calls = [];
  const result = await createCustomVoice({ baseUrl: 'https://voice.example/v1', apiStyle: 'openai-chat' }, 'secret', { name: 'Atlas', language: 'en-US', consentAudio: audio, sampleAudio: audio, consentConfirmed: true }, { fetcher: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, 'Bearer secret');
    if (url.endsWith('/voice_consents')) return Response.json({ id: 'cons_1234', name: 'Atlas', language: 'en-US' });
    return Response.json({ id: 'voice_1234', name: 'Atlas' });
  } });
  assert.deepEqual(result, { voiceId: 'voice_1234', voiceName: 'Atlas', consentId: 'cons_1234' });
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(result, 'consentAudio'), false);
});

test('failed voice creation attempts to remove the uploaded consent record', async () => {
  const urls = [];
  await assert.rejects(createCustomVoice({ baseUrl: 'https://voice.example/v1', apiStyle: 'openai-chat' }, 'secret', { name: 'Atlas', language: 'en-US', consentAudio: audio, sampleAudio: audio, consentConfirmed: true }, { fetcher: async (url) => {
    urls.push(url);
    if (url.endsWith('/voice_consents')) return Response.json({ id: 'cons_1234' });
    if (url.endsWith('/audio/voices')) return Response.json({ error: 'failed' }, { status: 500 });
    return Response.json({ deleted: true });
  } }), /creation failed/);
  assert.equal(urls.at(-1), 'https://voice.example/v1/audio/voice_consents/cons_1234');
});
