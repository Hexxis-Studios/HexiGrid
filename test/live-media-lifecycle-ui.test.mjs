import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/live-call.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(mediaDevices) {
  const nodes = new Map(), listeners = new Map();
  const node = selector => {
    if (selector === '.main-content') return null;
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', hidden: true, disabled: false, value: '', classList: { toggle() {} }, removeAttribute(name) { delete this[name]; } });
    return nodes.get(selector);
  };
  const window = { addEventListener() {} };
  vm.runInNewContext(source, { window, document: { querySelector: node, addEventListener: (name, fn) => listeners.set(name, fn), createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,c3ludGhldGlj' }) },
    navigator: { mediaDevices }, location: { search: '' }, URLSearchParams, setTimeout() {}, state: { data: {} } });
  const click = action => listeners.get('click')({ target: { closest: selector => selector === '[data-live-action]' ? { dataset: { liveAction: action } } : null } });
  const change = id => listeners.get('change')({ target: { matches: selectors => selectors.split(',').map(s => s.trim()).includes(`#${id}`) } });
  return { node, click, change, window };
}
function stream() {
  const tracks = ['audio', 'video'].map(kind => ({ kind, enabled: true, readyState: 'live', stopped: 0, stop() { this.stopped++; this.readyState = 'ended'; }, addEventListener() {} }));
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), getVideoTracks: () => tracks.filter(t => t.kind === 'video') };
}

test('pending camera start is single-flight, stoppable and discards late granted tracks', async () => {
  let grant, calls = 0;
  const ui = fixture({ getUserMedia() { calls++; return new Promise(resolve => { grant = resolve; }); } });
  ui.click('start-media'); ui.click('start-media');
  assert.equal(calls, 1);
  assert.match(ui.node('#liveStatus').textContent, /Requesting camera/);
  assert.equal(ui.node('#liveStartMedia').disabled, true);
  assert.equal(ui.node('#liveStopMedia').disabled, false);
  ui.click('stop-media');
  const late = stream(); grant(late); await tick();
  assert.ok(late.tracks.every(t => t.stopped === 1));
  assert.equal(ui.node('#liveLocalVideo').srcObject, null);
  assert.equal(ui.node('#liveStatus').textContent, 'Ready');
  assert.equal(ui.node('#liveStopMedia').disabled, true);
});

test('old camera rejection cannot overwrite a newer active preview', async () => {
  let rejectOld; const current = stream(); let calls = 0;
  const ui = fixture({ getUserMedia() { return ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve(current); } });
  ui.click('start-media'); ui.click('stop-media'); ui.click('start-media'); await tick();
  rejectOld(Object.assign(new Error('Old request denied'), { name: 'NotAllowedError' })); await tick();
  assert.equal(ui.node('#liveLocalVideo').srcObject, current);
  assert.equal(ui.node('#liveStatus').textContent, 'Camera and mic ready');
  ui.click('mute'); assert.equal(current.tracks[0].enabled, false);
  ui.click('camera'); assert.equal(current.tracks[1].enabled, false);
  ui.click('stop-media'); assert.ok(current.tracks.every(t => t.stopped === 1));
});

test('pending screen selection is cancellable and late screen tracks are discarded', async () => {
  let grant, calls = 0;
  const ui = fixture({ getDisplayMedia() { calls++; return new Promise(resolve => { grant = resolve; }); } });
  ui.click('screen'); ui.click('screen');
  assert.equal(calls, 1);
  assert.equal(ui.node('#liveStopMedia').disabled, false);
  ui.click('stop-media');
  const late = stream(); grant(late); await tick();
  assert.ok(late.tracks.every(t => t.stopped === 1));
  assert.equal(ui.node('#liveScreenVideo').srcObject, null);
  assert.equal(ui.node('#liveStatus').textContent, 'Ready');
});

test('privacy standing exposes staged frames, automatic sharing and disabled camera boundaries', async () => {
  const current = stream(), next = stream(); let captures = 0;
  const ui = fixture({ getUserMedia: async () => ++captures === 1 ? current : next });
  ui.click('start-media'); await tick();
  Object.assign(ui.node('#liveLocalVideo'), { readyState: 2, videoWidth: 320, videoHeight: 240 });
  assert.equal(ui.node('#livePrivacyBadge').textContent, 'PRIVATE PREVIEW');
  ui.click('capture-frame'); assert.equal(ui.node('#livePrivacyBadge').textContent, 'FRAME ATTACHED');
  ui.click('stop-media'); assert.match(ui.node('#liveSupportHint').textContent, /even if the preview is off/);
  ui.click('clear-frame'); assert.equal(ui.node('#livePrivacyBadge').textContent, 'PRIVATE PREVIEW');
  ui.node('#liveAutoFrame').checked = true; ui.change('liveAutoFrame');
  assert.equal(ui.node('#livePrivacyBadge').textContent, 'FRAMES ON SEND');
  ui.change('liveAgentSelect'); assert.equal(ui.node('#liveAutoFrame').checked, false);
  ui.click('start-media'); await tick(); ui.click('camera');
  assert.equal(next.getVideoTracks()[0].readyState, 'live'); assert.equal(next.getVideoTracks()[0].enabled, false);
  assert.equal(ui.window.HexiGridLiveCall.frameFromPreview(), '');
  ui.click('capture-frame'); assert.equal(ui.node('#liveFramePreview').src, undefined);
});
