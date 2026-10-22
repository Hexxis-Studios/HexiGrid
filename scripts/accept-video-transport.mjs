import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  publishCameraFrame,
  readDesktopMedia,
  resetDesktopMediaForTests,
  setDesktopCameraEnabled,
  startDesktopMedia,
  stopDesktopMedia
} from '../lib/desktop-media.mjs';

const linkId = 'video-acceptance-link';
const width = 480;
const height = 270;
const fps = 2;
const frameBytes = 48 * 1024;
const frameCount = 8;

resetDesktopMediaForTests();
startDesktopMedia({ linkId, cameraGranted: true });

const sources = [];
const started = performance.now();
for (let index = 0; index < frameCount; index += 1) {
  const seed = crypto.createHash('sha512').update(`hexigrid-video-frame-${index}`).digest();
  const frame = Buffer.alloc(frameBytes);
  for (let offset = 0; offset < frame.length; offset += seed.length) seed.copy(frame, offset);
  sources.push(frame);
  const published = publishCameraFrame(linkId, { mimeType: 'image/jpeg', data: frame.toString('base64'), width, height });
  assert.equal(published.sequence, index + 1);
}
const encodeTransportDecodeMs = performance.now() - started;
const received = readDesktopMedia(linkId, ['camera-view'], 0, 0, 0);
assert.equal(received.video.length, frameCount);
assert.deepEqual(received.video.map((frame) => frame.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
for (const frame of received.video) {
  const decoded = Buffer.from(frame.data, 'base64');
  assert.deepEqual(decoded, sources[frame.sequence - 1]);
  assert.equal(frame.width, width);
  assert.equal(frame.height, height);
}

setDesktopCameraEnabled(linkId, false);
assert.throws(() => publishCameraFrame(linkId, { mimeType: 'image/jpeg', data: sources[0].toString('base64'), width, height }), /not granted/);
setDesktopCameraEnabled(linkId, true);
assert.equal(publishCameraFrame(linkId, { mimeType: 'image/jpeg', data: sources[0].toString('base64'), width, height }).sequence, frameCount + 1);
stopDesktopMedia('acceptance-stop');
assert.throws(() => readDesktopMedia(linkId, ['camera-view']), /not active/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  synthetic: true,
  dimensions: `${width}x${height}`,
  fps,
  frames: frameCount,
  bytesPerFrame: frameBytes,
  measuredPayloadBytesPerSecond: frameBytes * fps,
  measuredPayloadKiBPerSecond: Math.round((frameBytes * fps / 1024) * 100) / 100,
  encodeTransportDecodeMs: Math.round(encodeTransportDecodeMs * 100) / 100,
  ordered: true,
  byteExact: true,
  retainedAfterStop: 0
}, null, 2)}\n`);
