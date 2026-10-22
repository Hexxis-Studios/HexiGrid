import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop-media.js', import.meta.url), 'utf8');
const cut = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a,b); };
const functions = cut('  async function startMicrophoneMeter(', '  async function enumerateMicrophones(')
  + cut('  async function uploadAudioBlob(', '  async function upload(')
  + cut('  function scheduleMicrophone(', '  async function stopKind(');

async function record({ level = 128, suspended = false, muted = false, frames = 4, phase = '', hidden = false, worklet = false, trace = {}, beforeEncode } = {}) {
  const runtime = { microphoneStream: {}, microphoneMuted: muted, voiceCallPhase: phase, bargeInFrames: 0, bargeInCooldownUntil: 0 }, uploads = [];
  let tick;
  const analyser = { fftSize: 256, getByteTimeDomainData: samples => samples.fill(level) };
  class Context {
    constructor() { this.state = suspended ? 'suspended' : 'running'; if (worklet) this.audioWorklet = { addModule: async () => {} }; }
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {}
  }
  class Recorder {
    constructor() { this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; trace.starts = (trace.starts || 0) + 1; }
    stop() { this.state = 'inactive'; trace.stops = (trace.stops || 0) + 1; }
  }
  const api = {};
  const callIdentity = { callId: '', mediaEpoch: 0 };
  let meter;
  let sharedContext;
  class WorkletNode { constructor() { this.port = {}; meter = this; } connect() {} }
  vm.runInNewContext(`${functions}; api.meter=startMicrophoneMeter;api.record=scheduleMicrophone;`, {
    runtime, api, window: { AudioContext: Context, ...(worklet ? { AudioWorkletNode: WorkletNode } : {}), setTimeout: () => { trace.timers = (trace.timers || 0) + 1; return 1; } }, document: { hidden }, console: { info() {}, warn() {} }, MediaRecorder: Recorder, Blob, Uint8Array, Date, Math, queueMicrotask,
    callIdentity, announce() {}, clearTimeout() {}, requestAnimationFrame: fn => { tick = fn; return 1; }, chooseAudioMime: () => 'audio/webm',
    stopSpeakerPlayback() { runtime.voiceCallPhase = ''; runtime.speakerPlaying = false; },
    getSpeakerAudioContext: () => { sharedContext ||= new Context(); runtime.speakerAudioContext = sharedContext; return sharedContext; },
    blobBase64: async () => { await beforeEncode?.({ runtime, trace }); return 'c3ludGhldGlj'; }, upload: async (path, body) => uploads.push({path, body})
  });
  await api.meter(runtime.microphoneStream); api.record();
  api.record(); assert.equal(trace.starts, 1, 'repeated call activation must reuse the sole recorder');
  assert.equal(runtime.microphoneAudioContext, runtime.speakerAudioContext);
  for (let i = 0; i < frames; i++) {
    if (worklet) meter.port.onmessage({ data: { level: Math.abs(level - 128) / 128 * 3.5, durationMs: 50 } });
    else tick();
  }
  runtime.recorder.ondataavailable({ data: new Blob(['synthetic']) });
  await runtime.recorder.onstop(); return uploads;
}

test('owner microphone records qualified voice versus silence using its existing local meter', async () => {
  const voice = await record({ level: 146 }), silence = await record(), brief = await record({level:146,frames:2});
  assert.equal(voice[0].path, '/api/desktop-bridge/media/microphone'); assert.equal(voice[0].body.speechActive, true);
  assert.equal(silence[0].body.speechActive, false); assert.equal(brief[0].body.speechActive, false);
  assert.equal(voice[0].body.energy, undefined); assert.equal(voice[0].body.samples, undefined);
});

test('audio-thread meter detects speech and silence while animation frames never run in a hidden tab', async () => {
  assert.equal((await record({ hidden: true, worklet: true, level: 146 }))[0].body.speechActive, true);
  assert.equal((await record({ hidden: true, worklet: true }))[0].body.speechActive, false);
  assert.equal('speechActive' in (await record({ hidden: true }))[0].body, false);
});

test('audio-thread clock rolls microphone chunks without background page timers', async () => {
  const trace = {};
  const uploads = await record({ hidden: true, worklet: true, level: 146, frames: 20, trace });
  assert.equal(uploads[0].body.speechActive, true);
  assert.equal(trace.stops, 1);
  assert.equal(trace.starts, 2);
  assert.equal(trace.timers || 0, 0);
});

test('capture restarts before encoding or upload; mute/end during encoding prevents delivery', async () => {
  for (const worklet of [false, true]) {
    const uploads = await record({ worklet, hidden: worklet, level: 146, beforeEncode: async ({ runtime, trace }) => {
      assert.equal(trace.starts, 2);
      assert.equal(runtime.recorder.state, 'recording');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(runtime.recorder.state, 'recording');
    } });
    assert.equal(uploads.length, 1);
  }
  for (const cancel of [runtime => { runtime.microphoneMuted = true; }, runtime => { runtime.microphoneStream = null; }]) {
    assert.deepEqual(await record({ worklet: true, beforeEncode: ({ runtime }) => cancel(runtime) }), []);
  }
});

test('worklet posts activity metadata only and its output never echoes the microphone', async () => {
  const processorSource = await readFile(new URL('../public/microphone-activity-worklet.js', import.meta.url), 'utf8');
  let Processor; const messages = [];
  vm.runInNewContext(processorSource, { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: x => messages.push(x) }; } }, sampleRate: 16000,
    registerProcessor: (_name, type) => { Processor = type; }, Math });
  const processor = new Processor();
  const input = new Float32Array(800).fill(0.1), output = new Float32Array(800).fill(1);
  processor.process([[input]], [[output]]);
  assert.equal(output.some(value => value !== 0), false);
  assert.deepEqual(Object.keys(messages[0]), ['level', 'durationMs']);
  assert.ok(messages[0].level > 0.06);
});

test('unavailable running meter never labels unknown input as silence; muted capture sends nothing', async () => {
  const unknown = await record({suspended:true}); assert.equal('speechActive' in unknown[0].body, false);
  assert.deepEqual(await record({level:146,muted:true}), []);
});

test('hanging up disconnects microphone nodes without closing the shared, user-unlocked call context', () => {
  let closed = 0, sourceDisconnected = 0, meterDisconnected = 0;
  const context = { state: 'running', close: async () => { closed++; } };
  const runtime = { microphoneAudioContext: context, speakerAudioContext: context,
    microphoneSource: { disconnect: () => { sourceDisconnected++; } },
    microphoneMeterNode: { port: { onmessage() {} }, disconnect: () => { meterDisconnected++; } } };
  const api = {};
  vm.runInNewContext(`${cut('  function stopMicrophoneMeter()', '  function stopCommandTimer()')} api.stop=stopMicrophoneMeter;`, { runtime, api });
  api.stop();
  assert.equal(closed, 0); assert.equal(sourceDisconnected, 1); assert.equal(meterDisconnected, 1);
  assert.equal(runtime.microphoneAudioContext, null); assert.equal(runtime.microphoneSource, null);
  assert.equal(runtime.speakerAudioContext, context);
});

test('qualified owner speech interrupts thinking before any speaker playback, while muted noise cannot', async () => {
  const thinking = await record({ level: 146, frames: 8, phase: 'thinking' });
  const interruptions = thinking.filter(call => call.path.endsWith('/voice-call/interrupt'));
  assert.equal(interruptions.length, 1); assert.ok(interruptions[0].body.energy >= 0.12);
  assert.deepEqual(await record({ level:146,frames:8,phase:'thinking',muted:true }),[]);
});
