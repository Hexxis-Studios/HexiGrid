import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { linkSignature, signedLinkRequest, stableJson } from '../public/agent-link-browser-client.js';
import { AGENT_LINK_BROWSER_ACTIONS, availableAgentLinkActions, prepareAgentLinkAction } from '../public/agent-link-actions.js';
import { signatureFor } from '../lib/agent-link.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('browser HMAC exactly matches the signed Link protocol', async () => {
  const input = { token: 'browser-token-that-is-at-least-32-characters', method: 'POST', pathname: '/agent-link/v1/desktop/input', timestamp: '2026-09-20T01:02:03.000Z', nonce: 'browser-test-nonce', body: { input: { y: 4, kind: 'mouse.move', x: 2 } } };
  assert.equal(stableJson(input.body), '{"input":{"kind":"mouse.move","x":2,"y":4}}');
  assert.equal(await linkSignature(input), signatureFor(input));
});

test('browser signed requests do not use cookies and include fresh signature headers', async () => {
  let captured;
  const result = await signedLinkRequest('/agent-link/v1/desktop/input', {
    token: 'browser-token-that-is-at-least-32-characters', method: 'POST', body: { input: { kind: 'key.press', key: 'Enter' } },
    now: () => new Date('2026-09-20T01:02:03.000Z'), randomUUID: () => 'browser-request-nonce',
    fetchFn: async (pathname, options) => { captured = { pathname, options }; return { ok: true, json: async () => ({ ok: true }) }; }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.options.credentials, 'omit');
  assert.match(captured.options.headers.authorization, /^Bearer /);
  assert.equal(captured.options.headers['x-hexigrid-nonce'], 'browser-request-nonce');
  assert.equal(captured.options.body, '{"input":{"kind":"key.press","key":"Enter"}}');
});

test('browser pairing keeps scoped agent actions available without desktop access or token persistence', async () => {
  const source = await readFile(path.join(root, 'public', 'agent-link-connect.js'), 'utf8');
  const routes = await readFile(path.join(root, 'lib', 'agent-link-routes.mjs'), 'utf8');
  assert.match(source, /'desktop-view', 'desktop-control', 'camera-view', 'microphone-listen', 'speaker-output'/);
  assert.match(source, /openAgentWorkspace\(\)/);
  assert.match(source, /agentOrientation\.textContent = JSON\.stringify\(body\.orientation/);
  assert.match(source, /if \(linkSession\.capabilities\.includes\('desktop-view'\)\)/);
  assert.doesNotMatch(source, /if \(!linkSession\.capabilities\.includes\('desktop-view'\)\).*endSession/);
  assert.match(source, /agent-link\/v1\/desktop\/media/);
  assert.match(source, /agent-link\/v1\/desktop\/speaker/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i);
  assert.match(source, /pagehide/);
  assert.match(source, /closingRelay\?\.close\(\)/);
  assert.match(routes, /agent-link-browser-client\.js/);
});

test('browser agent actions cover the scoped social door and reject capabilities not granted', async () => {
  const [html, assets] = await Promise.all([
    readFile(path.join(root, 'public', 'agent-link-connect.html'), 'utf8'),
    readFile(path.join(root, 'lib', 'static-assets.mjs'), 'utf8')
  ]);
  assert.match(html, /id="agentActionForm"/);
  assert.match(html, /id="agentOrientation"/);
  assert.match(html, /id="agentActionResult"/);
  assert.match(assets, /agent-link-actions\.js/);
  assert.equal(availableAgentLinkActions(['messages']).length, 2);
  assert.deepEqual(availableAgentLinkActions(['messages']).map((item) => item.id), ['messages-read', 'messages-send']);
  assert.equal(AGENT_LINK_BROWSER_ACTIONS.filter((item) => item.id.startsWith('hexipet-')).length, 3);
  assert.throws(() => prepareAgentLinkAction('post-publish', ['messages'], '{}'), /not available/);
  assert.throws(() => prepareAgentLinkAction('messages-send', ['messages'], '{oops'), /valid JSON/);
  const prepared = prepareAgentLinkAction('post-publish', ['hexispace-posts'], '{"profileId":"one","body":"Hi","visibility":"private"}', () => 'stable-request-id');
  assert.equal(prepared.action.pathname, '/agent-link/v1/hexispace/post');
  assert.equal(prepared.body.requestId, 'stable-request-id');
  assert.equal(JSON.parse(prepared.input).requestId, 'stable-request-id');
  assert.equal(prepareAgentLinkAction('post-publish', ['hexispace-posts'], prepared.input, () => 'wrong-id').body.requestId, 'stable-request-id');
});

test('public browser pairing uses encrypted relay transport with tab-only state', async () => {
  const source = await readFile(path.join(root, 'public', 'agent-link-relay-client.js'), 'utf8');
  assert.match(source, /AES-GCM/);
  assert.match(source, /RTCPeerConnection/);
  assert.match(source, /relay\/v1\/browser\/poll/);
  assert.match(source, /transport = 'https'/);
  assert.match(source, /requestedTransport.*=== 'webrtc' \? 'webrtc' : 'https'/);
  assert.match(source, /if \(this\.requestedTransport === 'webrtc'\)/);
  assert.match(source, /relayResponseKey/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i);
  assert.match(source, /failAll/);
});

test('remote media surface is capability-scoped and its audio playback is allowed by relay CSP', async () => {
  const [client, html, relay] = await Promise.all([
    readFile(path.join(root, 'public', 'agent-link-connect.js'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-link-connect.html'), 'utf8'),
    readFile(path.join(root, 'lib', 'public-agent-relay.mjs'), 'utf8')
  ]);
  assert.match(html, /id="desktopCamera"/);
  assert.match(html, /id="desktopAudioEnable"/);
  assert.match(client, /readDesktopMedia|desktop\/media|afterAudioSequence/);
  assert.match(client, /scheduleMediaPoll/);
  assert.match(client, /sendSpeakerAudio/);
  assert.match(client, /agent-link\/v1\/desktop\/speaker/);
  assert.match(client, /new Audio\(`data:/);
  assert.match(client, /audioPlaybackBlocked/);
  assert.match(client, /audioEnable\.hidden = false/);
  assert.match(relay, /media-src data:/);
});

test('owner media control exposes a session-only microphone picker and level meter', async () => {
  const [html, ownerScript, mediaScript, css] = await Promise.all([
    readFile(path.join(root, 'public', 'agent-interface.html'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-interface.js'), 'utf8'),
    readFile(path.join(root, 'public', 'desktop-media.js'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-interface.css'), 'utf8')
  ]);
  assert.match(html, /id="desktopBridgeMicrophoneDevice"/);
  assert.match(html, /id="desktopBridgeMicrophoneLevel"/);
  assert.match(ownerScript, /enumerateMicrophones/);
  assert.match(ownerScript, /microphoneDeviceId/);
  assert.match(html, /id="desktopBridgeSpeaker"/);
  assert.match(ownerScript, /speakerGranted/);
  assert.match(mediaScript, /pollSpeaker/);
  assert.match(mediaScript, /enableSpeaker/);
  assert.match(mediaScript, /getUserMedia\(\{ video: false, audio \}/);
  assert.match(mediaScript, /createMediaStreamSource/);
  assert.match(mediaScript, /getByteTimeDomainData/);
  assert.match(mediaScript, /switchMicrophone/);
  assert.match(mediaScript, /devicechange/);
  assert.match(mediaScript, /setCameraEnabled/);
  assert.match(mediaScript, /frameRate: \{ ideal: 2, max: 2 \}/);
  assert.match(mediaScript, /cameraBusy/);
  assert.match(css, /microphone-meter/);
});

test('owner voice-call controls are explicit and mute stops browser audio upload', async () => {
  const [html, ownerScript, mediaScript, routes, companion] = await Promise.all([
    readFile(path.join(root, 'public', 'agent-interface.html'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-interface.js'), 'utf8'),
    readFile(path.join(root, 'public', 'desktop-media.js'), 'utf8'),
    readFile(path.join(root, 'lib', 'agent-link-routes.mjs'), 'utf8'),
    readFile(path.join(root, 'integrations', 'hexigrid-link', 'scripts', 'companion_client.mjs'), 'utf8')
  ]);
  assert.match(html, /id="desktopVoiceCallStart"/);
  assert.match(html, /id="desktopVoiceCallMute"/);
  assert.match(html, /id="desktopVoiceCallEnd"/);
  assert.match(ownerScript, /voice-call\/start/);
  assert.match(ownerScript, /voice-call\/mute/);
  assert.match(ownerScript, /voice-call\/end/);
  assert.match(mediaScript, /runtime\.microphoneMuted/);
  assert.match(mediaScript, /setMicrophoneMuted/);
  assert.match(routes, /voice-call\/probe/);
  assert.match(companion, /voice-call-answer/);
  assert.match(companion, /clientRoundTripMs/);
  assert.doesNotMatch(mediaScript, /localStorage|sessionStorage|indexedDB/i);
});

test('incoming owner calls use browser permission activation, an always-on-top floating window, and truthful playback state', async () => {
  const [dialog, media, transcriptBuffer, styles] = await Promise.all([
    readFile(path.join(root, 'public', 'incoming-voice-call.js'), 'utf8'),
    readFile(path.join(root, 'public', 'desktop-media.js'), 'utf8'),
    readFile(path.join(root, 'lib', 'voice-call-transcripts.mjs'), 'utf8'),
    readFile(path.join(root, 'public', 'incoming-voice-call.css'), 'utf8')
  ]);
  assert.match(dialog, /window\.documentPictureInPicture/);
  assert.match(dialog, /pictureInPicture\.requestWindow/);
  assert.match(dialog, /openFloatingCallWindow\(\)/);
  assert.match(dialog, /End call/);
  assert.match(dialog, /callTranscripts/);
  assert.match(dialog, /renderActiveCallDock/);
  assert.match(media, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(media, /prepareCallAudioFromGesture/);
  assert.match(media, /activateCallAudio/);
  assert.match(media, /source\.start\(\)/);
  assert.match(media, /AudioContextState/);
  assert.match(transcriptBuffer, /current\.linkId/);
  assert.match(transcriptBuffer, /MAX_LINES/);
  assert.match(styles, /incoming-call-dock/);
});

test('wake-word activation stays local until the bridge command begins', async () => {
  const [wake, ui, media, html, server] = await Promise.all([
    readFile(path.join(root, 'public', 'wake-word.js'), 'utf8'),
    readFile(path.join(root, 'public', 'wake-word-ui.js'), 'utf8'),
    readFile(path.join(root, 'public', 'desktop-media.js'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-interface.html'), 'utf8'),
    readFile(path.join(root, 'server.mjs'), 'utf8')
  ]);
  assert.match(wake, /getUserMedia/);
  assert.doesNotMatch(wake, /fetch\(|WebSocket|XMLHttpRequest/);
  assert.match(wake, /preRollMs/);
  assert.match(wake, /local-template-v3/);
  assert.match(wake, /DETECTION_THRESHOLD = 0\.80/);
  assert.match(wake, /DETECTION_MARGIN = 0\.08/);
  assert.match(ui, /command-live/);
  assert.match(ui, /aria-live', 'assertive/);
  assert.doesNotMatch(wake, /sendBeacon|XMLHttpRequest|WebSocket|fetch\(/);
  assert.match(ui, /HexiGridDesktopMedia\.start/);
  assert.match(ui, /preRollBlob/);
  assert.match(ui, /endWhenSilent: reason !== 'push-to-talk'/);
  assert.match(media, /runtime\.command\.silentSince >= runtime\.command\.silenceMs/);
  assert.match(media, /runtime\.command\.expiresAt/);
  assert.match(media, /stopKind\('microphone', true\)/);
  assert.match(ui, /Raw audio was discarded/);
  assert.match(html, /id="wakeWordAlways"/);
  assert.match(html, /id="wakeWordPush"/);
  assert.match(server, /wake-word\/training/);
});

test('agent browser retries transient bridge failures and sends signed heartbeats', async () => {
  const [client, relay, routes] = await Promise.all([
    readFile(path.join(root, 'public', 'agent-link-connect.js'), 'utf8'),
    readFile(path.join(root, 'public', 'agent-link-relay-client.js'), 'utf8'),
    readFile(path.join(root, 'lib', 'agent-link-routes.mjs'), 'utf8')
  ]);
  assert.match(client, /agent-link\/v1\/heartbeat/);
  assert.match(client, /retryDelay/);
  assert.match(client, /replay\?\.audio/);
  assert.match(relay, /relay-session-reopened/);
  assert.match(relay, /MAX|backoff|Math\.min\(15000/);
  assert.match(routes, /recordAgentLinkHeartbeat/);
});
