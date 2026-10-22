import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop-media.js', import.meta.url), 'utf8');
const cut = (start, end) => {
  const from = source.indexOf(start); const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return source.slice(from, to);
};
const code = cut('  function stopSpeakerPlayback(', '  async function startMicrophoneMeter(') +
  cut('  function getSpeakerAudioContext(', '  async function captureCamera(');
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const segment = sequence => ({ sequence, mimeType: 'audio/wav', data: Buffer.from(`synthetic-${sequence}`).toString('base64') });

function fixture({ request, contextState = 'running' } = {}) {
  const runtime = { speakerGeneration: 0, speakerPollInFlight: null, voiceCallPhase: '', speakerAudioContext: null, speakerGranted: true, speakerPlaybackBlocked: false, speakerPlaybackMuted: false, speakerQueue: [], speakerSequence: 0, speakerPlaying: false, speakerPlayer: null, request };
  const sources = []; const decodeCalls = []; const api = {};
  class Source {
    connect() {}
    disconnect() { this.disconnected = true; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  class AudioContext {
    constructor() { this.state = contextState; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData(bytes) { const call = deferred(); decodeCalls.push({ bytes: bytes.byteLength, ...call }); return call.promise; }
    createBufferSource() { const source = new Source(); sources.push(source); return source; }
  }
  const announce = () => {};
  const state = () => ({ speakerPlaying: runtime.speakerPlaying, speakerPlaybackBlocked: runtime.speakerPlaybackBlocked, speakerAudioContextState: runtime.speakerAudioContext?.state || 'not-created' });
  vm.runInNewContext(`${code}; api.stop=stopSpeakerPlayback; api.drain=drainSpeaker; api.poll=pollSpeaker; api.prepare=prepareSpeakerPlayback;`, {
    runtime, api, window: { AudioContext }, atob: value => Buffer.from(value, 'base64').toString('binary'), Number, String, Math, console,
    state, announce, setInterval: () => 1, clearInterval() {}
  });
  return { runtime, sources, decodeCalls, ...api };
}

test('speaker polling is single-flight and ignores a late response after interruption', async () => {
  const old = deferred(); const fresh = deferred(); let calls = 0;
  const f = fixture({ request: () => ++calls === 1 ? old.promise : fresh.promise });
  const pending = f.poll(); await f.poll(); assert.equal(calls, 1);
  f.stop(); const replacement = f.poll(); assert.equal(calls, 2);
  old.resolve({ speaker: [segment(1)], voiceCall: { status: 'active', phase: 'thinking' } }); await pending;
  assert.equal(f.decodeCalls.length, 0); assert.notEqual(f.runtime.speakerPollInFlight, null);
  fresh.resolve({ speaker: [segment(2)], voiceCall: { status: 'active', phase: 'listening' } }); await replacement; await tick();
  assert.equal(f.decodeCalls.length, 1);
  assert.equal(f.decodeCalls[0].bytes, Buffer.byteLength('synthetic-2'));
  f.decodeCalls[0].resolve({ duration: 0.2 }); await tick();
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].started, true); assert.equal(f.runtime.voiceCallPhase, 'listening');
  f.stop(); await tick();
});

test('Web Audio waits for a user gesture and reports context state before decoding', async () => {
  const f = fixture({ contextState: 'suspended' });
  f.runtime.speakerQueue.push(segment(1));
  await f.drain();
  assert.equal(f.runtime.speakerPlaybackBlocked, true);
  assert.equal(f.decodeCalls.length, 0);
  await f.prepare();
  assert.equal(f.runtime.speakerAudioContext.state, 'running');
  assert.equal(f.decodeCalls.length, 1);
  f.decodeCalls[0].resolve({ duration: 0.1 }); await tick();
  assert.equal(f.sources[0].started, true);
  f.stop();
});

test('a decode that completes after stop cannot create or replace an audio source', async () => {
  const f = fixture();
  f.runtime.speakerQueue.push(segment(1));
  const old = f.drain(); await tick();
  f.stop();
  f.runtime.speakerGranted = true;
  f.runtime.speakerQueue.push(segment(2));
  const fresh = f.drain(); await tick();
  assert.equal(f.decodeCalls.length, 2);
  f.decodeCalls[0].resolve({ duration: 0.1 }); await old;
  assert.equal(f.sources.length, 0);
  f.decodeCalls[1].resolve({ duration: 0.1 }); await fresh;
  assert.equal(f.sources.length, 1);
  assert.equal(f.runtime.speakerPlayer, f.sources[0]);
  f.stop();
});
