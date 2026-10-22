import assert from 'node:assert/strict';
import test from 'node:test';
import { readDesktopSpeaker, resetDesktopMediaForTests, startDesktopMedia } from '../lib/desktop-media.mjs';
import { answerVoiceCall, endVoiceCall, muteVoiceCall, publicVoiceCall, resetVoiceCallForTests, startVoiceCall } from '../lib/voice-call.mjs';
import { publishVoiceReply, publishVoiceReplyAudio, publishVoiceReplyText, splitVoiceReply } from '../lib/voice-reply.mjs';

test.beforeEach(() => { resetVoiceCallForTests(); resetDesktopMediaForTests(); });

function openCall() {
  startDesktopMedia({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  startVoiceCall({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  answerVoiceCall('link-voice');
}

test('agent response text becomes bounded speaker segments on the same active link', async () => {
  openCall();
  const seen = [];
  const result = await publishVoiceReply('link-voice', 'A short agent response.', { synthesize: async (part) => {
    seen.push(part); return { mimeType: 'audio/wav', bytes: Buffer.from('synthetic-wav') };
  } });
  assert.equal(result.segments, 1);
  assert.deepEqual(seen, ['A short agent response.']);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 1);
  await assert.rejects(() => publishVoiceReply('another-link', 'No.', { synthesize: async () => ({}) }), /No live voice call/);
  assert.ok(splitVoiceReply('one '.repeat(40)).every((part) => part.length <= 90));
});

test('text replies are delivered as agent identity for the owner device voice instead of Windows SAPI', () => {
  openCall();
  const result = publishVoiceReplyText('link-voice', 'Hello from ExampleAgent.');
  assert.equal(result.deliveryStatus, 'text-ready');
  assert.equal(result.playbackVerified, false);
  assert.equal(publicVoiceCall().latestReply.text, 'Hello from ExampleAgent.');
  assert.equal(publicVoiceCall().latestReply.outputMode, 'browser-voice');
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
});

test('agent-native provider audio is queued for this exact active call with its reply transcript', () => {
  openCall();
  const audio = Buffer.from('RIFF-provider-generated-call-voice').toString('base64');
  const result = publishVoiceReplyAudio('link-voice', 'A reply in my own voice.', { mimeType: 'audio/wav', data: audio, durationMs: 700 });
  assert.equal(result.deliveryStatus, 'queued');
  assert.equal(result.playbackVerified, false);
  assert.equal(readDesktopSpeaker('link-voice').speaker[0].data, audio);
  assert.equal(publicVoiceCall().latestReply.text, 'A reply in my own voice.');
  assert.equal(publicVoiceCall().latestReply.outputMode, 'audio');
});

test('native audio is not queued for an unanswered, muted, or ended call', () => {
  const audio = { mimeType: 'audio/mpeg', data: Buffer.from('synthetic-provider-audio').toString('base64') };
  startDesktopMedia({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  startVoiceCall({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  assert.throws(() => publishVoiceReplyAudio('link-voice', 'Too early.', audio), /No live voice call/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
  answerVoiceCall('link-voice');
  muteVoiceCall('link-voice');
  assert.throws(() => publishVoiceReplyAudio('link-voice', 'Muted.', audio), /muted/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
  endVoiceCall('link-voice');
  assert.throws(() => publishVoiceReplyAudio('link-voice', 'Too late.', audio), /No live voice call/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
});

test('mute and end cancel a reply before audio is published', async () => {
  openCall();
  let resolveSpeech;
  const pending = publishVoiceReply('link-voice', 'Interrupt me.', { synthesize: () => new Promise((resolve) => { resolveSpeech = resolve; }) });
  muteVoiceCall('link-voice');
  resolveSpeech({ mimeType: 'audio/wav', bytes: Buffer.from('late-audio') });
  await assert.rejects(pending, /interrupted/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
  muteVoiceCall('link-voice', false);
  const pendingEnd = publishVoiceReply('link-voice', 'Interrupt me again.', { synthesize: () => new Promise((resolve) => { resolveSpeech = resolve; }) });
  endVoiceCall('link-voice');
  resolveSpeech({ mimeType: 'audio/wav', bytes: Buffer.from('late-audio') });
  await assert.rejects(pendingEnd, /interrupted/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 0);
});

test('first speech segment reaches the owner queue before the rest of TTS completes', async () => {
  openCall();
  let resolveSecond; let secondStarted;
  const started = new Promise((resolve) => { secondStarted = resolve; });
  const text = `First part is ready. ${'More words follow. '.repeat(8)}`;
  const reply = publishVoiceReply('link-voice', text, { synthesize: async (part) => {
    if (part.startsWith('First part')) return { mimeType: 'audio/wav', bytes: Buffer.from('RIFF-first-segment') };
    secondStarted();
    return new Promise((resolve) => { resolveSecond = resolve; });
  } });
  await started;
  const early = readDesktopSpeaker('link-voice').speaker;
  assert.equal(early.length, 1);
  assert.equal(Buffer.from(early[0].data, 'base64').toString(), 'RIFF-first-segment');
  resolveSecond({ mimeType: 'audio/wav', bytes: Buffer.from('RIFF-second-segment') });
  const result = await reply;
  assert.equal(result.partial, false);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 2);
});

test('partial TTS completion is explicit so callers do not repeat audio already queued', async () => {
  openCall();
  let pieces = 0;
  const result = await publishVoiceReply('link-voice', `First phrase. ${'More words. '.repeat(8)}`, { synthesize: async () => {
    pieces += 1;
    if (pieces === 1) return { mimeType: 'audio/wav', bytes: Buffer.from('RIFF-partial') };
    throw new Error('second segment failed');
  } });
  assert.equal(result.partial, true);
  assert.equal(result.segments, 1);
  assert.match(result.error, /do not retry automatically/);
  assert.equal(readDesktopSpeaker('link-voice').speaker.length, 1);
});
