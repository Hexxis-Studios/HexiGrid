import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerVoiceCall,
  endVoiceCall,
  muteVoiceCall,
  publicVoiceCall,
  resetVoiceCallForTests,
  startVoiceCall,
  setVoiceCallMicrophoneSequenceStart,
  voiceCallMicrophoneSequenceStart
} from '../lib/voice-call.mjs';

test.beforeEach(() => resetVoiceCallForTests());

test('voice call lifecycle is link-scoped, session-only, and requires both audio grants', () => {
  assert.throws(() => startVoiceCall({ linkId: 'link-voice', microphoneGranted: true }), /both microphone listening and agent speaker output/);
  const offered = startVoiceCall({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  assert.equal(offered.status, 'offered');
  assert.equal(offered.linkId, 'link-voice');
  assert.equal(answerVoiceCall('link-voice').status, 'active');
  assert.throws(() => muteVoiceCall('another-link', true), /No live voice call/);
  assert.throws(() => endVoiceCall('another-link', 'wrong-link'), /belongs to another Hexonaut link/);
  assert.equal(muteVoiceCall('link-voice', true).ownerMuted, true);
  assert.equal(muteVoiceCall('link-voice', false).ownerMuted, false);
  const ended = endVoiceCall('link-voice', 'owner-ended');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.ownerMuted, true);
  assert.equal(ended.stopReason, 'owner-ended');
  assert.equal(endVoiceCall('another-link', 'stale-cleanup').stopReason, 'owner-ended', 'stale ended call state does not block or get rewritten by another Link');
});

test('voice-call state never retains audio payloads', () => {
  startVoiceCall({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true });
  answerVoiceCall('link-voice');
  assert.equal('audio' in publicVoiceCall(), false);
  assert.equal('data' in publicVoiceCall(), false);
  assert.equal('microphoneSequenceStart' in publicVoiceCall(), false);
});

test('call microphone boundary stays internal and remains exact-link scoped', () => {
  startVoiceCall({ linkId: 'link-voice', microphoneGranted: true, speakerGranted: true, microphoneSequenceStart: 7 });
  assert.equal(voiceCallMicrophoneSequenceStart('link-voice'), 7);
  setVoiceCallMicrophoneSequenceStart('link-voice', 12);
  assert.equal(voiceCallMicrophoneSequenceStart('link-voice'), 12);
  assert.throws(() => voiceCallMicrophoneSequenceStart('another-link'), /No live voice call/);
  assert.equal('microphoneSequenceStart' in publicVoiceCall(), false);
});
