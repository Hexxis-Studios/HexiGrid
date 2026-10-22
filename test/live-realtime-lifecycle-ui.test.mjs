import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/live-realtime.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const stream = () => { const track = { stopped: 0, stop() { this.stopped++; } }; return { track, getTracks: () => [track], getAudioTracks: () => [track] }; };
function fixture({ media = async () => stream(), api = async () => ({ answerSdp: 'answer' }), confirm = async () => true, offer, frame = '' } = {}) {
  const nodes = new Map(), listeners = new Map(), peers = [], status = [], entries = [], sharing = [];
  const node = selector => {
    if (selector === '.live-conversation') return null;
    if (!nodes.has(selector)) nodes.set(selector, { value: '', disabled: false, checked: false, textContent: '', replaceChildren(n) { this.textContent = n; } });
    return nodes.get(selector);
  };
  node('#realtimeProvider').value = 'provider-a'; node('#realtimeModel').value = 'model-a';
  let agent = { id: 'agent-a', name: 'Agent A' };
  class Peer {
    constructor() { peers.push(this); this.channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; }, addEventListener: (_, fn) => { this.receive = fn; } }; }
    addTrack() {}
    createDataChannel() { return this.channel; }
    async createOffer() { return offer ? offer.promise : { sdp: 'offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.answered = true; }
    close() { this.closed = true; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const window = { RTCPeerConnection: Peer, addEventListener() {}, HexiGridLiveCall: {
    selectedAgent: () => agent, setStatus: (...s) => status.push(s), addEntry: (...s) => entries.push(s), frameFromPreview: () => frame, updatePrivacy: value => sharing.push(value)
  } };
  const state = { data: { providers: ['a', 'b'].map(id => ({ id: `provider-${id}`, name: `Provider ${id.toUpperCase()}`, enabled: true, capabilities: ['realtime'], apiStyle: 'openai-chat', modelIds: [`model-${id}`] })) } };
  vm.runInNewContext(source, { window, state, navigator: { mediaDevices: { getUserMedia: media } }, RTCPeerConnection: Peer, AbortController,
    Audio: class { async play() {} pause() {} }, api, userConfirm: confirm, setTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    document: { querySelector: node, createTextNode: t => t, addEventListener: (name, fn) => listeners.set(name, fn) } });
  const click = action => listeners.get('click')({ target: { closest: () => ({ dataset: { realtimeAction: action } }) } });
  const change = id => listeners.get('change')({ target: { id, matches: selectors => selectors.split(',').map(s => s.trim()).includes(`#${id}`) } });
  return { node, click, change, peers, status, entries, sharing, setAgent: value => { agent = value; }, window };
}

test('pending call is single-flight, End works, and late microphone never connects', async () => {
  const grant = deferred(); let captures = 0, requests = 0;
  const ui = fixture({ media: () => { captures++; return grant.promise; }, api: async () => { requests++; } });
  ui.click('start'); ui.click('start');
  assert.equal(captures, 1); assert.equal(ui.node('#realtimeStart').disabled, true);
  assert.equal(ui.node('#realtimeStop').disabled, false); assert.equal(ui.node('#realtimeCallState').textContent, 'CONNECTING');
  ui.click('stop'); const late = stream(); grant.resolve(late); await tick();
  assert.equal(late.track.stopped, 1); assert.equal(ui.peers.length, 0); assert.equal(requests, 0);
  assert.equal(ui.node('#realtimeCallState').textContent, 'READY'); assert.equal(ui.node('#realtimeStop').disabled, true);
});

test('End during offer creation prevents dispatch and a late callback cannot stop the next call', async () => {
  const offer = deferred(); const first = stream(), second = stream(); let captures = 0, requests = 0;
  const ui = fixture({ offer, media: async () => ++captures === 1 ? first : second, api: async () => { requests++; return { answerSdp: 'answer' }; } });
  ui.click('start'); await tick(); const old = ui.peers[0]; ui.click('stop'); ui.click('start'); await tick();
  old.connectionState = 'failed'; old.onconnectionstatechange();
  assert.equal(ui.peers[1].closed, undefined); assert.equal(second.track.stopped, 0);
  offer.resolve({ sdp: 'offer' }); await tick();
  assert.equal(requests, 1); assert.equal(first.track.stopped, 1); assert.equal(old.answered, undefined);
  assert.equal(ui.node('#realtimeCallState').textContent, 'CONNECTED');
  old.receive({ data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'old' }) });
  assert.equal(ui.entries.length, 0);
  ui.click('stop'); assert.equal(second.track.stopped, 1);
});

test('approval retries the same offer and identity once without reacquiring microphone', async () => {
  const approval = deferred(); const calls = []; let captures = 0;
  const ui = fixture({ media: async () => { captures++; return stream(); }, confirm: () => approval.promise,
    api: async (_url, options) => { calls.push(JSON.parse(options.body)); if (calls.length === 1) throw Object.assign(new Error('Approval'), { body: { approvalRequired: true } }); return { answerSdp: 'answer' }; } });
  ui.click('start'); await tick();
  // DOM selection can change without an input event; an approval must still bind the captured request.
  ui.node('#realtimeProvider').value = 'provider-b'; ui.node('#realtimeModel').value = 'model-b'; ui.setAgent({ id: 'agent-b', name: 'Agent B' });
  approval.resolve(true); await tick();
  assert.equal(captures, 1); assert.equal(ui.peers.length, 1); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { ...calls[0], approved: true });
  ui.peers[0].receive({ data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'current' }) });
  assert.deepEqual(ui.entries[0], ['agent', 'current', 'agent-a', 'Agent A']);
  ui.change('liveAgentSelect'); assert.equal(ui.peers[0].closed, true);
});

test('cancelled approval cannot dispatch and stopped API response cannot revive or end another call', async () => {
  const approval = deferred(); let calls = 0;
  const ui = fixture({ confirm: () => approval.promise, api: async () => { calls++; throw Object.assign(new Error('Approval'), { body: { approvalRequired: true } }); } });
  ui.click('start'); await tick(); ui.click('stop'); approval.resolve(true); await tick(); assert.equal(calls, 1);
  const answer = deferred(); const requests = [];
  const next = fixture({ api: (_url, options) => { requests.push(options); return requests.length === 1 ? answer.promise : Promise.resolve({ answerSdp: 'new' }); } });
  next.click('start'); await tick(); const old = next.peers[0]; next.click('stop');
  assert.equal(requests[0].signal.aborted, true);
  next.click('start'); await tick(); answer.resolve({ answerSdp: 'late' }); await tick();
  assert.equal(old.answered, undefined); assert.equal(next.peers[1].closed, undefined);
  assert.equal(next.node('#realtimeCallState').textContent, 'CONNECTED');
  next.click('stop');
});

test('visual sharing indicates active frame delivery and never carries consent into the next call', async () => {
  const ui = fixture({ frame: 'data:image/jpeg;base64,c3ludGhldGlj' });
  ui.click('start'); await tick();
  assert.equal(ui.sharing.at(-1), false);
  ui.node('#realtimeVision').checked = true; ui.change('realtimeVision');
  assert.equal(ui.sharing.at(-1), true); assert.equal(ui.node('#realtimeVisionCount').textContent, '1 frame sent');
  ui.click('stop'); assert.equal(ui.sharing.at(-1), false); assert.equal(ui.node('#realtimeVision').checked, false);
  assert.equal(ui.node('#realtimeVisionCount').textContent, 'No visual frames sent');
  ui.click('start'); await tick(); assert.equal(ui.sharing.at(-1), false); ui.click('stop');
});
