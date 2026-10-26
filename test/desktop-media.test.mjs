import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDesktopSpeaker,
  desktopMediaKindOwnerPaused,
  publishCameraFrame,
  publishMicrophoneChunk,
  publishSpeakerChunk,
  pauseDesktopMediaKind,
  readDesktopMedia,
  readDesktopMicrophone,
  readDesktopSpeaker,
  resetDesktopMediaForTests,
  setDesktopMediaKind,
  setDesktopCameraEnabled,
  startDesktopMedia,
  stopDesktopMedia,
  stopDesktopMediaKind,
  waitForDesktopMicrophone,
  clearDesktopMicrophone
} from '../lib/desktop-media.mjs';

test.beforeEach(() => resetDesktopMediaForTests());

test('desktop media stays session-only and scoped to the exact link and capabilities', () => {
  const started = startDesktopMedia({ linkId: 'link-1', cameraGranted: true, microphoneGranted: true, speakerGranted: true });
  assert.equal(started.cameraActive, false);
  publishCameraFrame('link-1', { mimeType: 'image/jpeg', data: Buffer.from('camera').toString('base64') });
  publishMicrophoneChunk('link-1', { mimeType: 'audio/webm', data: Buffer.from('microphone').toString('base64'), durationMs: 900 });
  publishSpeakerChunk('link-1', { mimeType: 'audio/webm', data: Buffer.from('speaker').toString('base64'), durationMs: 900 });
  const both = readDesktopMedia('link-1', ['camera-view', 'microphone-listen'], 0);
  assert.equal(both.media.cameraActive, true);
  assert.equal(both.media.microphoneActive, true);
  assert.equal(both.audio.length, 1);
  assert.deepEqual(both.speaker, []);
  const fullMedia = readDesktopMedia('link-1', ['camera-view', 'microphone-listen', 'speaker-output'], 0, 0);
  assert.equal(fullMedia.media.speakerActive, true);
  assert.equal(fullMedia.speaker.length, 1);
  assert.equal(readDesktopSpeaker('link-1', 0).speaker.length, 1);
  const cameraOnly = readDesktopMedia('link-1', ['camera-view'], 0);
  assert.ok(cameraOnly.camera);
  assert.deepEqual(cameraOnly.audio, []);
  assert.throws(() => readDesktopMedia('link-2', ['camera-view'], 0), /not active/);
});

test('owner can stop camera and microphone independently and global stop removes all data', () => {
  startDesktopMedia({ linkId: 'link-1', cameraGranted: true, microphoneGranted: true, speakerGranted: true });
  publishCameraFrame('link-1', { mimeType: 'image/webp', data: Buffer.from('camera').toString('base64') });
  publishMicrophoneChunk('link-1', { mimeType: 'audio/ogg', data: Buffer.from('microphone').toString('base64') });
  const cameraStopped = stopDesktopMediaKind('camera');
  assert.equal(cameraStopped.cameraGranted, false);
  assert.equal(cameraStopped.microphoneGranted, true);
  const microphoneStopped = stopDesktopMediaKind('microphone');
  assert.equal(microphoneStopped.microphoneGranted, false);
  const speakerStopped = stopDesktopMediaKind('speaker');
  assert.equal(speakerStopped.speakerGranted, false);
  const stopped = stopDesktopMedia('emergency-stop');
  assert.equal(stopped.linkId, '');
  assert.equal(stopped.stopReason, 'emergency-stop');
});

test('ending a call stops live streams but preserves grants, and owner pauses restore as explicit stops', () => {
  startDesktopMedia({ linkId: 'link-call-end', cameraGranted: true, microphoneGranted: true, speakerGranted: true });
  publishCameraFrame('link-call-end', { mimeType: 'image/jpeg', data: Buffer.from('frame').toString('base64') });
  publishMicrophoneChunk('link-call-end', { mimeType: 'audio/webm', data: Buffer.from('mic').toString('base64') });
  publishSpeakerChunk('link-call-end', { mimeType: 'audio/webm', data: Buffer.from('speaker').toString('base64') });

  const paused = pauseDesktopMediaKind('all', 'voice-call-ended');
  assert.equal(paused.cameraGranted, true);
  assert.equal(paused.microphoneGranted, true);
  assert.equal(paused.speakerGranted, true);
  assert.equal(paused.cameraActive, false);
  assert.equal(paused.microphoneActive, false);
  assert.equal(paused.speakerActive, false);
  assert.deepEqual(readDesktopMedia('link-call-end', ['camera-view', 'microphone-listen', 'speaker-output'], 0).audio, []);

  const restored = startDesktopMedia({ linkId: 'link-call-end', microphoneGranted: true, speakerGranted: true, ownerPausedMediaKinds: ['microphone'] });
  assert.equal(restored.microphoneGranted, true);
  assert.equal(restored.microphoneActive, false);
  assert.equal(desktopMediaKindOwnerPaused('link-call-end', 'microphone'), true);
  assert.throws(() => setDesktopMediaKind('link-call-end', 'microphone', true, { source: 'agent-policy' }), /owner paused/);
});

test('a live bridge can start one media kind after service restart without reviving old capture', () => {
  const camera = setDesktopMediaKind('link-1', 'camera', true);
  assert.equal(camera.linkId, 'link-1');
  assert.equal(camera.cameraGranted, true);
  assert.equal(camera.microphoneGranted, false);
  assert.equal(setDesktopMediaKind('link-1', 'speaker', true).speakerGranted, true);
  assert.equal(setDesktopMediaKind('link-1', 'camera', false).cameraGranted, false);
  assert.equal(readDesktopMedia('link-1', ['camera-view', 'speaker-output']).camera, null);
  assert.throws(() => setDesktopMediaKind('link-2', 'microphone', true), /not active/);
});

test('concurrent Links retain separate audio queues and share camera only with enabled recipients', () => {
  resetDesktopMediaForTests();
  startDesktopMedia({linkId: 'one', cameraGranted: true, microphoneGranted: true, speakerGranted: true});
  publishMicrophoneChunk('one', {mimeType: 'audio/webm', data: 'b25l'});
  publishSpeakerChunk('one', {mimeType: 'audio/wav', data: 'b25l'});
  startDesktopMedia({linkId: 'two', cameraGranted: true, microphoneGranted: true, speakerGranted: true});
  publishMicrophoneChunk('two', {mimeType: 'audio/webm', data: 'dHdv'});
  publishSpeakerChunk('two', {mimeType: 'audio/wav', data: 'dHdv'});
  const scopes = ['camera-view', 'microphone-listen', 'speaker-output'];
  assert.deepEqual(readDesktopMedia('one', scopes).audio.map(item => item.data), ['b25l']);
  assert.deepEqual(readDesktopMedia('two', scopes).speaker.map(item => item.data), ['dHdv']);
  publishCameraFrame('two', {mimeType: 'image/jpeg', data: 'eA==', width: 1, height: 1});
  assert.equal(readDesktopMedia('one', scopes).camera.data, 'eA==');
  stopDesktopMediaKind('camera', 'owner-media-stop', 'one');
  publishCameraFrame('two', {mimeType: 'image/jpeg', data: 'eQ==', width: 1, height: 1});
  assert.equal(readDesktopMedia('one', scopes).camera, null);
  assert.equal(readDesktopMedia('two', scopes).camera.data, 'eQ==');
  stopDesktopMedia('link-revoked', 'one');
  assert.throws(() => readDesktopMedia('one', scopes), /not active/);
  assert.equal(readDesktopMedia('two', scopes).audio[0].data, 'dHdv');
  stopDesktopMedia('owner-stop');
  assert.throws(() => readDesktopMedia('two', scopes), /not active/);
});

test('self-managed media grants cannot override an explicit owner pause', () => {
  startDesktopMedia({ linkId: 'link-owner-pause', microphoneGranted: true, speakerGranted: true });
  stopDesktopMediaKind('microphone', 'owner-media-stop');
  assert.equal(desktopMediaKindOwnerPaused('link-owner-pause', 'microphone'), true);
  assert.throws(() => setDesktopMediaKind('link-owner-pause', 'microphone', true, { source: 'agent-policy' }), /owner paused microphone/);
  assert.equal(readDesktopMedia('link-owner-pause', ['microphone-listen']).media.microphoneGranted, false);
  assert.equal(setDesktopMediaKind('link-owner-pause', 'microphone', true).microphoneGranted, true, 'an explicit owner resume clears the pause');
  assert.equal(desktopMediaKindOwnerPaused('link-owner-pause', 'microphone'), false);

  stopDesktopMediaKind('speaker', 'capability-paused');
  assert.equal(desktopMediaKindOwnerPaused('link-owner-pause', 'speaker'), false, 'agent policy revocation is reversible by that policy');
  assert.equal(setDesktopMediaKind('link-owner-pause', 'speaker', true, { source: 'agent-policy' }).speakerGranted, true);
});

test('media publisher rejects ungranted types, wrong links, and oversized payloads', () => {
  startDesktopMedia({ linkId: 'link-1', cameraGranted: true, microphoneGranted: false });
  assert.throws(() => publishMicrophoneChunk('link-1', { mimeType: 'audio/webm', data: 'eA==' }), /not granted/);
  assert.throws(() => publishCameraFrame('link-2', { mimeType: 'image/jpeg', data: 'eA==' }), /not granted/);
  assert.throws(() => publishCameraFrame('link-1', { mimeType: 'image/png', data: 'eA==' }), /invalid/);
  assert.throws(() => publishCameraFrame('link-1', { mimeType: 'image/jpeg', data: 'a'.repeat(1300000) }), /too large/);
  assert.throws(() => publishSpeakerChunk('link-1', { mimeType: 'audio/webm', data: 'eA==' }), /not granted/);
  startDesktopMedia({ linkId: 'link-1', speakerGranted: true });
  assert.throws(() => publishSpeakerChunk('link-1', { mimeType: 'audio/wav', data: 'a'.repeat(1000000) }), /too large/);
});

test('media reads expose a bounded replay window and identify an unrecoverable gap', () => {
  startDesktopMedia({ linkId: 'link-replay', microphoneGranted: true });
  for (let index = 0; index < 15; index += 1) publishMicrophoneChunk('link-replay', { mimeType: 'audio/webm', data: Buffer.from(`audio-${index}`).toString('base64') });
  const replay = readDesktopMedia('link-replay', ['microphone-listen'], 13);
  assert.equal(replay.audio.length, 2);
  assert.equal(replay.replay.audio.gap, false);
  const missed = readDesktopMedia('link-replay', ['microphone-listen'], 0);
  assert.equal(missed.replay.audio.gap, true);
  assert.equal(missed.replay.audio.oldestAvailable, 4);
});

test('camera transport preserves ordered bytes, bounds replay, and supports owner pause/resume', () => {
  startDesktopMedia({ linkId: 'link-video', cameraGranted: true });
  const originals = [];
  for (let index = 0; index < 10; index += 1) {
    const bytes = Buffer.from(`synthetic-jpeg-frame-${String(index).padStart(2, '0')}`);
    originals.push(bytes);
    const result = publishCameraFrame('link-video', { mimeType: 'image/jpeg', data: bytes.toString('base64'), width: 480, height: 270 });
    assert.equal(result.sequence, index + 1);
  }
  const replay = readDesktopMedia('link-video', ['camera-view'], 0, 0, 2);
  assert.equal(replay.video.length, 8);
  assert.equal(replay.replay.camera.gap, false);
  assert.deepEqual(replay.video.map((frame) => frame.sequence), [3, 4, 5, 6, 7, 8, 9, 10]);
  for (const frame of replay.video) assert.deepEqual(Buffer.from(frame.data, 'base64'), originals[frame.sequence - 1]);
  const missed = readDesktopMedia('link-video', ['camera-view'], 0, 0, 0);
  assert.equal(missed.replay.camera.gap, true);
  assert.equal(missed.replay.camera.oldestAvailable, 3);
  const paused = setDesktopCameraEnabled('link-video', false);
  assert.equal(paused.cameraGranted, false);
  assert.equal(paused.cameraCanResume, true);
  assert.throws(() => publishCameraFrame('link-video', { mimeType: 'image/jpeg', data: 'eA==' }), /not granted/);
  const resumed = setDesktopCameraEnabled('link-video', true);
  assert.equal(resumed.cameraGranted, true);
  assert.equal(resumed.cameraActive, false);
  assert.equal(publishCameraFrame('link-video', { mimeType: 'image/webp', data: Buffer.from('resumed').toString('base64'), width: 320, height: 180 }).sequence, 11);
});

test('call mute can clear queued speaker audio without revoking the session grant', () => {
  startDesktopMedia({ linkId: 'link-call', speakerGranted: true });
  publishSpeakerChunk('link-call', { mimeType: 'audio/wav', data: Buffer.from('old').toString('base64') });
  assert.throws(() => clearDesktopSpeaker('another-link'), /not active/);
  const muted = clearDesktopSpeaker('link-call');
  assert.equal(muted.speakerGranted, true);
  assert.equal(muted.speakerActive, false);
  assert.equal(readDesktopSpeaker('link-call', 0).speaker.length, 0);
  publishSpeakerChunk('link-call', { mimeType: 'audio/wav', data: Buffer.from('new').toString('base64') });
  assert.equal(readDesktopSpeaker('link-call', 1).speaker.length, 1);
});

test('call microphone long-poll wakes on the next exact-link segment and carries speech activity', async () => {
  startDesktopMedia({ linkId: 'link-stream', microphoneGranted: true, speakerGranted: true, cameraGranted: true });
  const waiting = waitForDesktopMicrophone('link-stream', 0, { waitMs: 2000 });
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = Buffer.from('synthetic-owner-voice');
  publishMicrophoneChunk('link-stream', { mimeType: 'audio/webm', data: bytes.toString('base64'), durationMs: 850, speechActive: true });
  const result = await waiting;
  assert.equal(result.audio.length, 1);
  assert.equal(result.audio[0].speechActive, true);
  assert.deepEqual(Buffer.from(result.audio[0].data, 'base64'), bytes);
  assert.equal('camera' in result, false);
  assert.equal('speaker' in result, false);
  assert.deepEqual(readDesktopMicrophone('link-stream', 1).audio, []);
  assert.throws(() => readDesktopMicrophone('another-link', 0), /not active/);
});

test('ending call media wakes waiters and pre-call microphone chunks are discarded', async () => {
  startDesktopMedia({ linkId: 'link-stream', microphoneGranted: true, speakerGranted: true });
  publishMicrophoneChunk('link-stream', { mimeType: 'audio/webm', data: Buffer.from('pre-call').toString('base64') });
  const callStartState = clearDesktopMicrophone('link-stream');
  assert.equal(callStartState.microphoneGranted, true);
  assert.equal(callStartState.microphoneActive, false);
  assert.deepEqual(readDesktopMicrophone('link-stream', 0).audio, []);
  const waiting = waitForDesktopMicrophone('link-stream', 1, { waitMs: 2000 });
  await new Promise((resolve) => setImmediate(resolve));
  stopDesktopMediaKind('microphone', 'owner-muted');
  await assert.rejects(waiting, /not granted/);
});
