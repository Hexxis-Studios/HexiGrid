import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLocalCamera, videoDevices } from '../lib/local-camera.mjs';
import { ensureAgentCamera, publicDesktopMedia, readDesktopMedia, resetDesktopMediaForTests, setDesktopMediaKind, stopDesktopMediaKind } from '../lib/desktop-media.mjs';
import { assertAgentLinkCapabilityUpdate, normalizeAgentLinks, publicAgentLink, toggleOwnerAgentLinkCapabilities, updateAgentLinkCapabilities } from '../lib/agent-link.mjs';
import { setOwnerAgentTrust } from '../lib/owner-agent-access.mjs';

test('camera self-removal preserves grant policy through normalization and repeated owner trust', () => {
  const state = { agentLinks: [{ id: 'camera-qa', tokenHash: 'qa', status: 'connected', trustLevel: 'owner',
    capabilities: ['messages', 'camera-view'], ownerGrantedCapabilities: ['messages', 'camera-view'], identity: {}, events: [], messages: [] }] };
  normalizeAgentLinks(state);
  toggleOwnerAgentLinkCapabilities(state.agentLinks[0], ['messages']);
  setOwnerAgentTrust(state.agentLinks[0], 'owner');
  normalizeAgentLinks(state);
  const link = state.agentLinks[0];
  assert.equal(link.capabilities.includes('camera-view'), false);
  assert.equal(publicAgentLink(link).selfManageableCapabilities.includes('camera-view'), true);
  assert.deepEqual(toggleOwnerAgentLinkCapabilities(link, ['messages', 'camera-view']).added, ['camera-view']);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(link, ['vision']), /vision.*owner has not granted/);
  toggleOwnerAgentLinkCapabilities(link, ['messages']);
  toggleOwnerAgentLinkCapabilities(link, ['messages', 'camera-view']);
  assert.equal(link.capabilities.includes('camera-view'), true);
  updateAgentLinkCapabilities(link, ['messages']);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(link, ['messages', 'camera-view']), /camera-view/);
  setOwnerAgentTrust(link, 'owner');
  assert.equal(link.ownerGrantedCapabilities.includes('owner-process'), false, 'repeated trust cannot restore revoked system scopes');
  assert.throws(() => assertAgentLinkCapabilityUpdate(link, ['messages', 'camera-view']), /camera-view.*changed before confirmation/);
});

test('local camera uses bounded FFmpeg pipe and rejects bad frames without exposing process errors', async () => {
  assert.deepEqual(videoDevices('"Webcam" (video)\n"Mic" (audio)'), ['Webcam']);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('-list_devices')) throw { stderr: Buffer.from('"Webcam" (video)') };
    return { stdout: Buffer.from([255, 216, 1, 255, 217]) };
  };
  const frame = await captureLocalCamera({ runner, platform: 'win32', executable: 'ffmpeg', device: '' });
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(calls[1].args.includes('video=Webcam'), true);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.timeout, 8000);
  await assert.rejects(captureLocalCamera({ platform: 'win32', runner: async () => { throw Error('private process detail'); } }), error => !error.message.includes('private'));
});

test('camera starts on authorized read; revocation aborts in-flight capture and prevents late publication after regrant', async () => {
  resetDesktopMediaForTests();
  let allowed = true, calls = 0;
  const authorize = () => { if (!allowed) throw Object.assign(Error('camera-view revoked'), { status: 403 }); };
  const frame = { mimeType: 'image/jpeg', data: 'eA==', width: 640, height: 480 };
  const capture = async () => { calls++; return frame; };
  await ensureAgentCamera('qa', authorize, { capture });
  await ensureAgentCamera('qa', authorize, { capture });
  assert.equal(calls, 1);
  assert.equal(readDesktopMedia('qa', ['camera-view']).camera.sequence, 1);
  let finish, captureSignal;
  const delayed = ensureAgentCamera('qa', authorize, { afterCameraSequence: 1, capture: ({ signal }) => { captureSignal = signal; return new Promise(resolve => { finish = resolve; }); } });
  stopDesktopMediaKind('camera', 'capability-paused');
  assert.equal(captureSignal.aborted, true);
  setDesktopMediaKind('qa', 'camera', true);
  finish(frame);
  await assert.rejects(delayed, /changed during capture/);
  assert.equal(readDesktopMedia('qa', ['camera-view']).camera, null);
  await ensureAgentCamera('qa', authorize, { capture });
  assert.equal(readDesktopMedia('qa', ['camera-view']).camera.sequence, 2);
  stopDesktopMediaKind('camera', 'owner-camera-off');
  await assert.rejects(ensureAgentCamera('qa', authorize, { capture }), /paused/);
  allowed = false;
  await assert.rejects(ensureAgentCamera('qa', authorize, { capture }), /revoked/);
  assert.equal(publicDesktopMedia().cameraActive, false);
  resetDesktopMediaForTests();
});
