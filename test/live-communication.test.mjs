import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveCommunicationLimits, sanitizeLiveTranscript, sanitizeVoiceProfile } from '../lib/live-communication.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 43934;
let child;
let dataDir;

function avatarGlbData(document = { asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }) {
  const raw = Buffer.from(JSON.stringify(document));
  const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 0x20)]);
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4E4F534A, 16); json.copy(bytes, 20);
  return `data:model/gltf-binary;base64,${bytes.toString('base64')}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok) return; } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live communication test server did not start.');
}

async function request(pathname, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json().catch(() => ({})) };
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-live-'));
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-opencode-for-live-test' }, stdio: 'ignore' });
  await waitForServer();
});

after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('live data sanitizers bound voice settings and transcript content', () => {
  const voice = sanitizeVoiceProfile({ voiceName: 'Device voice', rate: 9, pitch: -3, volume: 4 });
  assert.deepEqual(voice, { engine: 'browser', voiceName: 'Device voice', providerId: '', model: '', voiceId: '', rate: 2, pitch: 0, volume: 1 });
  const transcript = sanitizeLiveTranscript({ title: '  Session ', entries: Array.from({ length: liveCommunicationLimits.maxTranscriptEntries + 10 }, (_, index) => ({ role: 'agent', speaker: 'Agent', text: `Line ${index}` })) });
  assert.equal(transcript.title, 'Session');
  assert.equal(transcript.entries.length, liveCommunicationLimits.maxTranscriptEntries);
  assert.equal(transcript.entries[0].text, 'Line 10');
});

test('live transcript save, listing, and deletion are local authenticated flows', async () => {
  const agent = await request('/api/agents', 'POST', { name: 'Live test agent', transport: 'local-opencode', voiceProfile: { rate: 1.2 } });
  assert.equal(agent.response.status, 201);
  assert.deepEqual(agent.body.agent.voiceProfile, { engine: 'browser', voiceName: '', providerId: '', model: '', voiceId: '', rate: 1.2, pitch: 1, volume: 1 });
  const saved = await request('/api/live/transcripts', 'POST', { title: 'Local test call', agentId: agent.body.agent.id, entries: [{ role: 'user', speaker: 'You', text: 'Hello from the live panel.' }, { role: 'agent', agentId: agent.body.agent.id, speaker: 'Live test agent', text: 'Hello back.' }] });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.transcript.entries.length, 2);
  const listed = await request('/api/live/transcripts');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.transcripts[0].title, 'Local test call');
  const deleted = await request(`/api/live/transcripts/${saved.body.transcript.id}`, 'DELETE');
  assert.equal(deleted.response.status, 200);
  assert.deepEqual((await request('/api/live/transcripts')).body.transcripts, []);
});

test('live media assets and same-origin media permissions are wired', async () => {
  const script = await fetch(`http://127.0.0.1:${port}/live-call.js`);
  const recording = await fetch(`http://127.0.0.1:${port}/live-recording.js`);
  const generatedVoice = await fetch(`http://127.0.0.1:${port}/live-generated-voice.js`);
  const realtime = await fetch(`http://127.0.0.1:${port}/live-realtime.js`);
  const avatarViewer = await fetch(`http://127.0.0.1:${port}/avatar-viewer.js`);
  const modelViewer = await fetch(`http://127.0.0.1:${port}/vendor/model-viewer.js`);
  const style = await fetch(`http://127.0.0.1:${port}/live-communication.css`);
  const embedStyle = await fetch(`http://127.0.0.1:${port}/hexispace-embed.css`);
  const embedMode = await fetch(`http://127.0.0.1:${port}/hexispace-embed-mode.js`);
  const embedFocus = await fetch(`http://127.0.0.1:${port}/hexispace-embed.js`);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(script.status, 200);
  assert.equal(recording.status, 200);
  assert.equal(generatedVoice.status, 200);
  assert.equal(realtime.status, 200);
  assert.equal(avatarViewer.status, 200);
  assert.equal(modelViewer.status, 200);
  assert.equal(style.status, 200);
  assert.equal(embedStyle.status, 200);
  assert.equal(embedMode.status, 200);
  assert.equal(embedFocus.status, 200);
  const liveCss = await style.text();
  assert.match(liveCss, /\.live-stage>\.module-header,\.live-conversation>\.module-header,\.live-voice-panel>\.module-header[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(liveCss, /@media \(max-width:650px\)\{[\s\S]*?\.live-video-stage\{min-height:380px\}/);
  const html = await page.text();
  assert.match(html, /live-call\.js/);
  assert.match(html, /live-recording\.js/);
  assert.match(html, /live-generated-voice\.js/);
  assert.match(html, /live-realtime\.js/);
  assert.match(html, /hexispace-embed-mode\.js/);
  assert.match(html, /hexispace-embed\.js/);
  assert.match(html, /avatar-viewer\.js/);
  assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
  assert.match(page.headers.get('permissions-policy'), /display-capture=\(self\)/);
  assert.match(await embedMode.text(), /params\.get\('view'\) === 'live'/);
  assert.match(await embedFocus.text(), /button\.click\(\)/);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/boot-loader.js`)).text(), /hexispace-live-embed/);
  assert.match(html, /data-action="toggle-remote-link"/);
  const appSource = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  const viewRenderers = await (await fetch(`http://127.0.0.1:${port}/view-renderers.js`)).text();
  assert.match(viewRenderers, /Open temporary remote link/);
  assert.match(appSource, /current pairing code/);
});

test('voice and recording modules use real browser capability checks', async () => {
  const voice = await (await fetch(`http://127.0.0.1:${port}/live-voice.js`)).text();
  const recording = await (await fetch(`http://127.0.0.1:${port}/live-recording.js`)).text();
  assert.match(voice, /const engine = speech\(\)/);
  assert.match(voice, /typeof engine\.speak === 'function'/);
  assert.match(recording, /new MediaRecorder/);
  assert.match(recording, /MAX_DURATION_MS = 15 \* 60 \* 1000/);
  assert.match(recording, /URL\.revokeObjectURL/);
  const call = await (await fetch(`http://127.0.0.1:${port}/live-call.js`)).text();
  assert.match(call, /Attach current frame/);
  assert.match(call, /imageDataUrl: pendingFrame/);
  assert.match(call, /frameFromPreview/);
  assert.match(call, /new URLSearchParams\(location\.search\)/);
  assert.match(call, /requestedAgentId/);
  const realtimeSource = await (await fetch(`http://127.0.0.1:${port}/live-realtime.js`)).text();
  assert.match(realtimeSource, /type: 'input_image'/);
  assert.match(realtimeSource, /bufferedAmount > 512 \* 1024/);
  assert.match(realtimeSource, /Math\.min\(1, Math\.max\(\.25/);
  const stopVoice = call.match(/function stopReply\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(stopVoice, /HexiGridLiveVoice\?\.stop/);
  assert.doesNotMatch(stopVoice, /turnController\?\.abort/);
});

test('3D agent avatar uploads, serves, and removes a validated local GLB', async () => {
  const created = await request('/api/agents', 'POST', { name: '3D avatar agent', transport: 'local-opencode' });
  const uploaded = await request(`/api/agents/${created.body.agent.id}/avatar-model`, 'POST', { modelData: avatarGlbData(), approved: true });
  assert.equal(uploaded.response.status, 201);
  assert.match(uploaded.body.agent.avatarModel.url, /^\/api\/media\/avatar-model-/);
  const model = await fetch(`http://127.0.0.1:${port}${uploaded.body.agent.avatarModel.url}`);
  assert.equal(model.status, 200);
  assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(Buffer.from(await model.arrayBuffer()).toString('ascii', 0, 4), 'glTF');
  const removed = await request(`/api/agents/${created.body.agent.id}/avatar-model`, 'DELETE', { approved: true });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.agent.avatarModel, null);
  assert.equal((await fetch(`http://127.0.0.1:${port}${uploaded.body.agent.avatarModel.url}`)).status, 404);
});

test('VRM upload retains version/type metadata and the matching private-file extension', async () => {
  const created = await request('/api/agents', 'POST', { name: 'VRM avatar agent', transport: 'local-opencode' });
  const document = { asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { specVersion: '1.0' } }, scenes: [{ nodes: [] }], scene: 0 };
  const uploaded = await request(`/api/agents/${created.body.agent.id}/avatar-model`, 'POST', { modelData: avatarGlbData(document), approved: true });
  assert.equal(uploaded.response.status, 201);
  assert.deepEqual({ format: uploaded.body.agent.avatarModel.format, vrmVersion: uploaded.body.agent.avatarModel.vrmVersion }, { format: 'vrm', vrmVersion: '1.0' });
  const model = await fetch(`http://127.0.0.1:${port}${uploaded.body.agent.avatarModel.url}`);
  assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
  assert.match(model.headers.get('content-disposition'), /\.vrm"$/);
  const removed = await request(`/api/agents/${created.body.agent.id}/avatar-model`, 'DELETE', { approved: true });
  assert.equal(removed.response.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}${uploaded.body.agent.avatarModel.url}`)).status, 404);
});
