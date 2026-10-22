import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishCameraFrame,
  publishMicrophoneChunk,
  readDesktopMedia,
  resetDesktopMediaForTests,
  setDesktopMediaKind,
  startDesktopMedia,
  stopDesktopMediaKind
} from '../lib/desktop-media.mjs';
import { resetVoiceCallForTests, startVoiceCall } from '../lib/voice-call.mjs';

const cameraFrame = { mimeType: 'image/jpeg', data: Buffer.from('frame').toString('base64') };
const microphoneChunk = { mimeType: 'audio/webm', data: Buffer.from('chunk').toString('base64') };
const expectStatus = (status, action) => {
  assert.throws(action, (error) => error.status === status);
};

test.beforeEach(() => {
  resetDesktopMediaForTests();
  resetVoiceCallForTests();
});

test('revoked link reconnect stays inactive until each device grant is renewed', () => {
  const linkId = 'link-reconnect';
  const original = startDesktopMedia({ linkId, cameraGranted: true, microphoneGranted: true });
  assert.equal(original.cameraGranted, true);
  assert.equal(original.microphoneGranted, true);
  publishCameraFrame(linkId, cameraFrame);
  publishMicrophoneChunk(linkId, microphoneChunk);

  const cameraRevoked = stopDesktopMediaKind('camera');
  assert.equal(cameraRevoked.cameraGranted, false);
  assert.equal(cameraRevoked.cameraCanResume, true);
  expectStatus(403, () => publishCameraFrame(linkId, cameraFrame));
  assert.equal(readDesktopMedia(linkId, ['camera-view']).camera, null);

  const microphoneRevoked = stopDesktopMediaKind('microphone');
  assert.equal(microphoneRevoked.microphoneGranted, false);
  expectStatus(403, () => publishMicrophoneChunk(linkId, microphoneChunk));
  assert.deepEqual(readDesktopMedia(linkId, ['microphone-listen']).audio, []);

  const reconnected = startDesktopMedia({ linkId });
  assert.equal(reconnected.cameraGranted, false);
  assert.equal(reconnected.microphoneGranted, false);
  assert.equal(reconnected.cameraCanResume, false);
  expectStatus(403, () => publishCameraFrame(linkId, cameraFrame));
  expectStatus(403, () => publishMicrophoneChunk(linkId, microphoneChunk));
  const inactive = readDesktopMedia(linkId, ['camera-view', 'microphone-listen']);
  assert.equal(inactive.media.cameraActive, false);
  assert.equal(inactive.media.microphoneActive, false);
  assert.equal(inactive.camera, null);
  assert.deepEqual(inactive.audio, []);

  const speakerGrant = setDesktopMediaKind(linkId, 'speaker', true);
  assert.equal(speakerGrant.speakerGranted, true);
  expectStatus(403, () => startVoiceCall({ linkId, microphoneGranted: false, speakerGranted: true }));

  const renewedCamera = setDesktopMediaKind(linkId, 'camera', true);
  assert.equal(renewedCamera.cameraGranted, true);
  assert.equal(renewedCamera.cameraCanResume, true);
  assert.equal(renewedCamera.cameraActive, false);
  assert.equal(publishCameraFrame(linkId, cameraFrame).media.cameraActive, true);

  const renewedMicrophone = setDesktopMediaKind(linkId, 'microphone', true);
  assert.equal(renewedMicrophone.microphoneGranted, true);
  assert.equal(renewedMicrophone.microphoneActive, false);
  assert.equal(startVoiceCall({ linkId, microphoneGranted: true, speakerGranted: true }).status, 'offered');
  assert.equal(publishMicrophoneChunk(linkId, microphoneChunk).media.microphoneActive, true);
});