import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesizeLocalSpeech } from '../lib/local-tts.mjs';

test('local speech rejects empty, oversized, unsupported, and cancelled requests', async () => {
  await assert.rejects(() => synthesizeLocalSpeech(''), /1–240/);
  await assert.rejects(() => synthesizeLocalSpeech('x'.repeat(241)), /1–240/);
  await assert.rejects(() => synthesizeLocalSpeech('hello', { platform: 'linux' }), /Windows SAPI/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => synthesizeLocalSpeech('hello', { platform: 'win32', signal: controller.signal }), /cancelled/);
});

test('Windows local speech returns an in-memory WAV without a model provider', { skip: process.platform !== 'win32' }, async () => {
  const generated = await synthesizeLocalSpeech('This is a local voice test.');
  assert.equal(generated.mimeType, 'audio/wav');
  assert.equal(generated.bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(generated.bytes.subarray(8, 12).toString(), 'WAVE');
  assert.ok(generated.bytes.length > 44);
});
