import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

test('local transcription converts private microphone chunks and emits sequenced partial/final events', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-transcriber-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'models'), { recursive: true });
  await fs.writeFile(path.join(root, 'models', 'ggml-tiny.bin'), 'model');
  await fs.writeFile(path.join(root, 'whisper.exe'), 'engine');
  await fs.writeFile(path.join(root, 'ffmpeg.exe'), 'engine');
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('whoami.exe')) return { stdout: '"Test User","S-1-5-21-1234"', stderr: '' };
    if (command.endsWith('vad.exe')) return { stdout: 'Detected 1 speech segments:\n', stderr: '' };
    if (command.endsWith('whisper.exe')) await fs.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, '  ExampleAgent   Rose  ');
    return { stdout: '', stderr: '' };
  };
  const transcriber = new LocalTranscriber({ root, runner, whisperPath: path.join(root, 'whisper.exe'), ffmpegPath: path.join(root, 'ffmpeg.exe'), vadPath: path.join(root, 'vad.exe'), vadModelProvider: async () => path.join(root, 'vad-model.bin'), finalDelayMs: 20 });
  const connection = { id: 'link-one', transcription: { enabled: true, model: 'tiny', language: 'en' } };
  const events = [];
  transcriber.enqueue(connection, { sequence: 1, mimeType: 'audio/webm', data: Buffer.from('one').toString('base64') }, (event) => events.push(event));
  transcriber.enqueue(connection, { sequence: 2, mimeType: 'audio/webm', data: Buffer.from('two').toString('base64') }, (event) => events.push(event));
  const deadline = Date.now() + 2_000;
  while (!events.some((event) => event.type === 'speech.transcript.final') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events.some((event) => event.type === 'speech.transcript.partial'), true);
  assert.equal(events.some((event) => event.type === 'speech.transcript.final'), true);
  assert.equal(events.at(-1).text, 'ExampleAgent Rose');
  assert.equal(calls.some((call) => call.command.endsWith('ffmpeg.exe')), true);
  assert.equal(calls.some((call) => call.command.endsWith('whisper.exe')), true);
  assert.equal(calls.some(call => call.command.endsWith('whisper.exe') && call.args.includes('--vad')), false, 'speech admission must not trim words out of the decoded utterance');
  assert.equal(JSON.stringify(events).includes('data:'), false);
});

test('local transcription is disabled by default and settings are connection-scoped', () => {
  const transcriber = new LocalTranscriber();
  const first = { id: 'link-one' }; const second = { id: 'link-two' };
  assert.equal(transcriber.enqueue(first, { sequence: 1 }, () => {}).queued, false);
  transcriber.configure(first, { enabled: true, model: 'base', language: 'fr' });
  assert.deepEqual(first.transcription, { enabled: true, memoryOnly: false, model: 'base', language: 'fr', lastTranscriptAt: null, lastError: '' });
  assert.equal(second.transcription, undefined);
});

test('an accepted call uses available local transcription without persisting a settings change', async () => {
  const transcriber = new LocalTranscriber({ finalDelayMs: 15 });
  transcriber.transcribe = async () => 'Can you hear me, ExampleAgent?';
  const connection = { id: 'call-link', transcription: { enabled: false, memoryOnly: false, model: 'tiny', language: 'en' } };
  const events = [];
  transcriber.enqueue(connection, { sequence: 1, mimeType: 'audio/webm', data: 'eA==', speechActive: true }, event => events.push(event), { activeCall: true });
  transcriber.enqueue(connection, { sequence: 2, mimeType: 'audio/webm', data: 'eA==', speechActive: false }, event => events.push(event), { activeCall: true });
  const deadline = Date.now() + 1_000;
  while (!events.some(event => event.type === 'speech.transcript.final') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.find(event => event.type === 'speech.transcript.final')?.text, 'Can you hear me, ExampleAgent?');
  assert.equal(events.at(-1).metadata.source, 'owner-microphone');
  assert.equal(connection.transcription.enabled, false);
  assert.equal(connection.transcription.memoryOnly, false);
  transcriber.clear(connection.id);
});

test('memory-only privacy mode never queues audio for the CLI transcription path', () => {
  const transcriber = new LocalTranscriber();
  const connection = { id: 'link-private', transcription: { enabled: true, memoryOnly: true, model: 'tiny', language: 'en' } };
  const result = transcriber.enqueue(connection, { sequence: 1, mimeType: 'audio/webm', data: 'cHJpdmF0ZQ==' }, () => {});
  assert.deepEqual(result, { queued: false, reason: 'memory-only-engine-unavailable' });
  assert.equal(transcriber.buffers.size, 0);
});

test('accepting a voice call does not override memory-only transcription privacy', () => {
  const transcriber = new LocalTranscriber({ finalDelayMs: 15 });
  const connection = { id: 'private-call-link', transcription: { enabled: false, memoryOnly: true, model: 'tiny', language: 'en' } };
  const events = [];
  const result = transcriber.enqueue(connection, { sequence: 1, mimeType: 'audio/webm', data: 'eA==', speechActive: true }, event => events.push(event), { activeCall: true });
  assert.deepEqual(result, { queued: false, reason: 'memory-only-engine-unavailable' });
  assert.equal(events.length, 0);
  assert.equal(connection.transcription.enabled, false);
  assert.equal(connection.transcription.memoryOnly, true);
});

test('ending or muting a call cancels pending transcription before it emits private text', async () => {
  const transcriber = new LocalTranscriber({ finalDelayMs: 10 });
  let finish;
  transcriber.transcribe = () => new Promise((resolve) => { finish = resolve; });
  const connection = { id: 'link-cancel', transcription: { enabled: true, model: 'tiny', language: 'en' } };
  const events = [];
  transcriber.enqueue(connection, { sequence: 1, mimeType: 'audio/webm', data: 'eA==' }, (event) => events.push(event));
  transcriber.enqueue(connection, { sequence: 2, mimeType: 'audio/webm', data: 'eA==' }, (event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  transcriber.clear(connection.id);
  finish('Private speech after the call ended.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  assert.equal(transcriber.buffers.size, 0);
});

test('changing privacy or recognition settings aborts old audio and cannot emit under the new standing', async () => {
  for (const change of [{ memoryOnly: true }, { language: 'fr' }, { model: 'base' }]) {
    const transcriber = new LocalTranscriber({ finalDelayMs: 10 });
    let finish, oldSignal;
    transcriber.transcribe = (_chunks, _settings, { signal }) => {
      oldSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    };
    const connection = { id: 'link-config-change', transcription: { enabled: true, model: 'tiny', language: 'en' } };
    const events = [];
    for (const sequence of [1, 2]) transcriber.enqueue(connection, { sequence, mimeType: 'audio/webm', data: 'eA==' }, event => events.push(event));
    await new Promise(resolve => setImmediate(resolve));
    transcriber.configure(connection, change);
    assert.equal(oldSignal.aborted, true); assert.equal(transcriber.buffers.size, 0);
    finish('Old private audio.'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []); assert.equal(connection.transcription.lastTranscriptAt, null);
    if (change.memoryOnly) assert.equal(transcriber.enqueue(connection, { sequence: 3 }, () => {}).reason, 'memory-only-engine-unavailable');
  }
});

test('continuous silent chunks complete one spoken turn while capture remains open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transcriber = new LocalTranscriber({ finalDelayMs: 100 });
  const jobs = [], events = [];
  transcriber.transcribe = async chunks => { jobs.push(chunks.map(chunk => chunk.sequence)); return 'One synthetic spoken turn.'; };
  const connection = { id: 'continuous-mic', transcription: { enabled: true } };
  const send = (sequence, speechActive) => transcriber.enqueue(connection, { sequence, data: 'eA==', mimeType: 'audio/webm', speechActive }, event => events.push(event));
  assert.equal(send(1, false).reason, 'silence'); assert.equal(transcriber.buffers.size, 0);
  send(2, true);
  for (const sequence of [3, 4, 5, 6]) { t.mock.timers.tick(25); send(sequence, false); }
  await transcriber.buffers.get(connection.id).chain;
  assert.equal(events.length, 1); assert.equal(events[0].type, 'speech.transcript.final');
  assert.equal(events[0].metadata.source, 'owner-microphone'); assert.equal(jobs.length, 1);
  for (const sequence of [7, 8, 9]) { t.mock.timers.tick(25); assert.equal(send(sequence, false).reason, 'silence'); }
  send(10, true); t.mock.timers.tick(100); await transcriber.buffers.get(connection.id).chain;
  assert.equal(events.length, 2); assert.equal(jobs[1][0], 10); transcriber.clear(connection.id);
});

test('resumed speech extends the same turn; absent level metadata retains gap completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transcriber = new LocalTranscriber({ finalDelayMs: 100 });
  const events = []; transcriber.transcribe = async () => 'Synthetic.';
  const connection = { id: 'resume', transcription: { enabled: true } };
  const send = speechActive => transcriber.enqueue(connection, { data: 'eA==', speechActive }, event => events.push(event));
  send(true); t.mock.timers.tick(75); send(false); send(true); t.mock.timers.tick(25);
  await transcriber.buffers.get(connection.id).chain; assert.equal(events.filter(e=>e.metadata.final).length, 0);
  t.mock.timers.tick(75); await transcriber.buffers.get(connection.id).chain;
  assert.equal(events.filter(e=>e.metadata.final).length, 1);
  send(undefined); t.mock.timers.tick(75); send(undefined); t.mock.timers.tick(25);
  await transcriber.buffers.get(connection.id).chain; assert.equal(events.filter(e=>e.metadata.final).length, 1);
  t.mock.timers.tick(75); await transcriber.buffers.get(connection.id).chain;
  assert.equal(events.filter(e=>e.metadata.final).length, 2); transcriber.clear(connection.id);
});
