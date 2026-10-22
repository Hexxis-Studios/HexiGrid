import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pauseDesktopAudio, publicDesktopMedia, publishMicrophoneChunk, resetDesktopMediaForTests, startDesktopMedia } from '../lib/desktop-media.mjs';
import { endVoiceCall, publicVoiceCall, resetVoiceCallForTests, startVoiceCall } from '../lib/voice-call.mjs';
import { isPresenceFarewell, OnRequestPresenceController } from '../lib/on-request-presence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.beforeEach(() => { resetVoiceCallForTests(); resetDesktopMediaForTests(); });

test('synthetic wake composes a listening call and recedes without leaving capture active', async () => {
  let scheduled = null;
  let shellVisible = false;
  startDesktopMedia({ linkId: 'exampleagent-link', microphoneGranted: true, speakerGranted: true });
  startVoiceCall({ linkId: 'exampleagent-link', microphoneGranted: true, speakerGranted: true });
  shellVisible = true;
  const controller = new OnRequestPresenceController({
    timeoutMs: 30_000,
    setTimer: (callback, delay) => { scheduled = { callback, delay, unref() {} }; return scheduled; },
    clearTimer: () => { scheduled = null; },
    onRecede: async ({ linkId, reason }) => {
      endVoiceCall(linkId, reason);
      pauseDesktopAudio(linkId, reason);
      shellVisible = false;
    }
  });
  const active = controller.activate({ linkId: 'exampleagent-link', agentId: 'exampleagent' });
  assert.equal(active.state, 'listening');
  assert.equal(publicVoiceCall().phase, 'listening');
  assert.equal(shellVisible, true);
  assert.equal(scheduled.delay, 30_000);

  publishMicrophoneChunk('exampleagent-link', { mimeType: 'audio/webm', data: Buffer.from('synthetic').toString('base64'), durationMs: 500 });
  assert.equal(publicDesktopMedia().microphoneActive, true);
  await scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().active, false);
  assert.equal(publicVoiceCall().status, 'ended');
  assert.equal(publicVoiceCall().phase, 'idle');
  assert.equal(publicDesktopMedia().microphoneActive, false);
  assert.equal(publicDesktopMedia().speakerActive, false);
  assert.equal(publicDesktopMedia().microphoneGranted, true);
  assert.equal(publicDesktopMedia().speakerGranted, true);
  assert.equal(shellVisible, false);
});

test('manual shell hiding does not end the call, while explicit recede does', async () => {
  startDesktopMedia({ linkId: 'exampleagent-link', microphoneGranted: true, speakerGranted: true });
  startVoiceCall({ linkId: 'exampleagent-link', microphoneGranted: true, speakerGranted: true });
  const controller = new OnRequestPresenceController({ onRecede: async ({ linkId, reason }) => { endVoiceCall(linkId, reason); pauseDesktopAudio(linkId, reason); } });
  controller.activate({ linkId: 'exampleagent-link', agentId: 'exampleagent' });
  const shellVisible = false;
  assert.equal(shellVisible, false);
  assert.equal(publicVoiceCall().status, 'offered');
  assert.equal(controller.status().active, true);
  await controller.recede('owner-ended');
  assert.equal(publicVoiceCall().status, 'ended');
  assert.equal(controller.status().state, 'idle');
});

test('farewell detection is bounded and does not treat ordinary speech as an ending', () => {
  for (const phrase of ['Goodbye.', 'bye bye', 'Talk to you later!', 'Thanks, goodbye']) assert.equal(isPresenceFarewell(phrase), true, phrase);
  for (const phrase of ['Tell me about goodbyes', 'I said bye yesterday', 'Thanks for the answer']) assert.equal(isPresenceFarewell(phrase), false, phrase);
});

test('browser and server composition fails closed without grants and adds no idle polling loop', async () => {
  const [ui, routes, controller] = await Promise.all([
    fs.readFile(path.join(ROOT, 'public', 'wake-word-ui.js'), 'utf8'),
    fs.readFile(path.join(ROOT, 'lib', 'desktop-bridge-routes.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'lib', 'on-request-presence.mjs'), 'utf8')
  ]);
  const wakeRequest = ui.indexOf("'/api/desktop-bridge/presence/wake'");
  const mediaStart = ui.indexOf('HexiGridDesktopMedia.start');
  assert.ok(wakeRequest >= 0 && wakeRequest < mediaStart, 'presence authorization must complete before command capture starts');
  assert.match(ui, /HexiGridDesktopMedia\.start\(\{ microphone: true, speaker: true/);
  assert.match(ui, /presence\/recede[\s\S]*capture-failed/);
  assert.match(routes, /microphone-listen[\s\S]*speaker-output[\s\S]*microphoneGranted[\s\S]*speakerGranted/);
  assert.match(routes, /No call or capture was started/);
  assert.doesNotMatch(controller, /setInterval|fetch\(|WebSocket|http:/);
});
