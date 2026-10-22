import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalTranscriber } from '../lib/local-transcription.mjs';
import { ensureSpeechVadModel } from '../lib/speech-vad-model.mjs';
import { synthesizeLocalSpeech } from '../lib/local-tts.mjs';

test('no-speech and invalid detector output cannot run recognition or emit a final transcript', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-speech-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const detectorOutput of ['Detected 0 speech segments:\n', 'invalid']) {
    let whisperCalls = 0;
    const transcriber = new LocalTranscriber({ root, runner: async (command, args) => {
      if (command.endsWith('whoami.exe')) return { stdout: '"Test","S-1-5-21-1234"' };
      if (command === 'vad') return { stdout: detectorOutput };
      if (command === 'whisper') { whisperCalls++; await fs.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, 'hallucinated text'); }
      return { stdout: '' };
    }});
    transcriber.resolveRuntime = async () => ({ whisper: 'whisper', ffmpeg: 'ffmpeg', vad: 'vad', modelPath: 'model', vadModelPath: 'vad-model' });
    const entry = { controller: new AbortController(), chain: Promise.resolve() };
    const connection = { id: 'synthetic', transcription: { enabled: true } }, events = [];
    transcriber.schedule(entry, connection, [{ mimeType: 'audio/wav', data: 'eA==' }], true, e => events.push(e));
    await entry.chain;
    assert.equal(whisperCalls, 0);
    assert.equal(events.some(e => e.type === 'speech.transcript.final'), false);
    assert.equal(connection.transcription.lastTranscriptAt, undefined);
    assert.deepEqual(await fs.readdir(path.join(root, 'call-temp')), []);
  }
});

test('speech detector rejects corrupt local and downloaded weights without replacing local data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-vad-model-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(ensureSpeechVadModel(root, { fetchModel: async () => new Response('bad') }), /integrity/);
  await fs.mkdir(path.join(root, 'models'));
  const file = path.join(root, 'models', 'ggml-silero-v5.1.2.bin');
  await fs.writeFile(file, 'existing');
  await assert.rejects(ensureSpeechVadModel(root, { fetchModel: async () => { throw new Error('must not download'); } }), /integrity/);
  assert.equal(await fs.readFile(file, 'utf8'), 'existing');
});

function wav(sample) {
  const rate = 16000, count = rate * 2, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(sample(i) * 32767), 44 + i * 2);
  return bytes;
}

const modelRoot = path.resolve('data/transcription');
const installed = process.platform === 'win32' && await fs.access(path.join(modelRoot, 'engine', 'whisper-vad-speech-segments.exe')).then(() => true, () => false);
test('installed speech detector drops silence, hiss and hum, but retains spoken words', { skip: !installed, timeout: 60_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-vad-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transcriber = new LocalTranscriber({ root, modelRoot });
  let seed = 17;
  const noise = wav(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 2 ** 32 - 0.5) * 0.08; });
  for (const [name, bytes] of [['silence', wav(() => 0)], ['hiss', noise], ['hum', wav(i => Math.sin(i * 2 * Math.PI * 60 / 16000) * 0.1)]]) {
    assert.equal(await transcriber.transcribe([{ mimeType: 'audio/wav', data: bytes.toString('base64') }], { model: 'tiny', language: 'en' }), '', name);
  }
  const speech = await synthesizeLocalSpeech('Hello ExampleAgent. Can you hear me?');
  const text = await transcriber.transcribe([{ mimeType: 'audio/wav', data: speech.bytes.toString('base64') }], { model: 'tiny', language: 'en' });
  assert.match(text.toLowerCase(), /hello|exampleagent|hear/);
  assert.deepEqual(await fs.readdir(path.join(root, 'call-temp')), []);
  t.diagnostic('Synthetic audio only: no live capture, speaker playback, provider call or agent wake.');
});

const baseInstalled = installed && await fs.access(path.join(modelRoot, 'models', 'ggml-base.bin')).then(() => true, () => false);
test('Base recognizes negations from complete spoken utterances', { skip: !baseInstalled, timeout: 60_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-negation-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transcriber = new LocalTranscriber({ root, modelRoot });
  for (const [sentence, expected] of [
    ['No. I did not approve that change. Never delete those files.', [/\bno\b/i, /\bnot\b/i, /\bnever\b/i]],
    ["I don't want that. This isn't approved.", [/\b(?:don't|do not)\b/i, /\b(?:isn't|is not)\b/i]]
  ]) {
    const speech = await synthesizeLocalSpeech(sentence);
    const result = await transcriber.transcribe([{ mimeType: 'audio/wav', data: speech.bytes.toString('base64') }], { model: 'base', language: 'en' });
    for (const pattern of expected) assert.match(result, pattern);
  }
  t.diagnostic('Synthetic negation phrases only; not a guarantee of perfect real microphone transcription.');
});
