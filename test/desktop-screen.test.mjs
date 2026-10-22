import test from 'node:test';
import assert from 'node:assert/strict';
import { clearBrowserDesktopFrame, publishBrowserDesktopFrame, readBrowserDesktopFrame, resetBrowserDesktopFrameForTests } from '../lib/desktop-screen.mjs';

test.beforeEach(() => resetBrowserDesktopFrameForTests());

test('owner browser screen frames are bounded, session-only, and readable by the bridge', () => {
  const payload = Buffer.from('valid-screen-frame').toString('base64');
  const published = publishBrowserDesktopFrame({ mimeType: 'image/jpeg', data: payload, capturedAt: new Date().toISOString() });
  assert.equal(published.source, 'owner-browser');
  const frame = readBrowserDesktopFrame();
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(frame.data.toString(), 'valid-screen-frame');
  clearBrowserDesktopFrame();
  assert.equal(readBrowserDesktopFrame(), null);
});

test('owner browser screen frames reject unsupported formats and oversized payloads', () => {
  assert.throws(() => publishBrowserDesktopFrame({ mimeType: 'text/plain', data: 'dGVzdA==' }), /invalid screen frame/);
  assert.throws(() => publishBrowserDesktopFrame({ mimeType: 'image/jpeg', data: 'a'.repeat(12_000_000) }), /too large/);
});
