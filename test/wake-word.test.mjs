import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { addWakeWordTrainingSample, defaultWakeWordSettings, normalizeWakeWordSettings, publicWakeWordSettings, routeWakePhrase, updateWakeWordAgent } from '../lib/wake-word.mjs';

const sample = Array.from({ length: 12 }, (_, frame) => Array.from({ length: 10 }, (_, value) => (frame + value) / 100));

test('wake-word settings are local-first, disabled by default, and bounded', () => {
  const settings = defaultWakeWordSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.alwaysListening, false);
  assert.equal(settings.pushToTalk, true);
  assert.equal(settings.detector, 'local-template-v3');
  assert.equal(settings.preRollMs, 1000);
  assert.equal(normalizeWakeWordSettings({ preRollMs: 99999, commandTimeoutMs: 1 }).preRollMs, 2000);
});

test('auditable detector confirms stable matches and rejects unrelated feature streams', async () => {
  const source = await readFile(fileURLToPath(new URL('../public/wake-word.js', import.meta.url)), 'utf8');
  const context = { window: {}, Blob, ArrayBuffer, DataView, Float32Array, Math, Date, Object, String, Number, console, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const detector = context.window.HexiGridWakeWord.diagnostics;
  const template = Array.from({ length: 48 }, (_, index) => [Math.sin(index / 5), Math.cos(index / 7), index / 48, (index % 5) / 5]);
  const close = template.map((frame, index) => frame.map((value, column) => value + Math.sin(index + column) * 0.015));
  const unrelated = template.map((frame, index) => frame.map((_value, column) => ((index * 7 + column * 11) % 19) / 3 - 3));
  assert.equal(detector.detector, 'local-template-v3');
  assert.ok(detector.similarity(close, template) >= detector.threshold);
  assert.ok(detector.similarity(unrelated, template) < detector.threshold);
  assert.equal(detector.threshold, 0.8);
  const engine = context.window.HexiGridWakeWord.createWakeWordEngine();
  assert.doesNotThrow(() => engine.setTemplates([{ agentId: 'exampleagent', phrase: 'Hey ExampleAgent', frames: template }]));
  assert.equal(engine.state().sampleCount, 1);
});

test('stateful extraction is identical across microphone-sized chunks', async () => {
  const file = fileURLToPath(new URL('../public/wake-word.js', import.meta.url));
  const source = await readFile(file, 'utf8');
  const context = vm.createContext({ window: {}, Blob, ArrayBuffer, DataView, Float32Array, Float64Array, Map, Math, Number, Object, String, Date, console });
  vm.runInContext(source, context);
  const api = context.window.HexiGridWakeWord;
  const samples = Float32Array.from({ length: 8192 }, (_, index) => Math.sin(2 * Math.PI * 220 * index / 16000) * 0.1);
  const whole = api.frameFeatures(samples, 1024, 16000);
  const extractor = api.createFeatureExtractor(16000, 1024);
  const chunked = [];
  for (let offset = 0; offset < samples.length; offset += 1536) chunked.push(...extractor.push(samples.subarray(offset, offset + 1536)));
  assert.equal(chunked.length, whole.length);
  for (let frame = 0; frame < whole.length; frame += 1) {
    assert.equal(chunked[frame].length, whole[frame].length);
    for (let value = 0; value < whole[frame].length; value += 1) assert.equal(chunked[frame][value], whole[frame][value]);
  }
});

test('incompatible legacy detector features require local retraining', () => {
  const migrated = normalizeWakeWordSettings({ detector: 'local-template-v2', agents: { exampleagent: { phrase: 'Hey ExampleAgent', samples: [sample], trainedAt: '2026-09-20T00:00:00.000Z' } } });
  assert.equal(migrated.detector, 'local-template-v3');
  assert.deepEqual(migrated.agents.exampleagent.samples, []);
  assert.equal(migrated.agents.exampleagent.trainedAt, null);
});

test('wake phrases are configured per agent and route only an explicit match', () => {
  let settings = updateWakeWordAgent(defaultWakeWordSettings(), { agentId: 'exampleagent-link', phrase: 'Hey ExampleAgent' });
  settings = addWakeWordTrainingSample(settings, { agentId: 'exampleagent-link', phrase: 'Hey ExampleAgent', features: sample });
  const publicSettings = publicWakeWordSettings(settings);
  assert.equal(publicSettings.agents['exampleagent-link'].sampleCount, 1);
  assert.equal(publicSettings.agents['exampleagent-link'].samples.length, 1);
  assert.equal(routeWakePhrase(settings, 'please respond Hey ExampleAgent', [{ id: 'exampleagent-link', name: 'ExampleAgent' }]).agentId, 'exampleagent-link');
  assert.equal(routeWakePhrase(settings, 'hello there', [{ id: 'exampleagent-link', name: 'ExampleAgent' }]).matched, false);
});

test('training rejects unbounded or malformed audio features', () => {
  assert.throws(() => addWakeWordTrainingSample(defaultWakeWordSettings(), { agentId: 'agent-1', features: [['not-a-number']] }), /bounded local audio features/);
  assert.throws(() => addWakeWordTrainingSample(defaultWakeWordSettings(), { agentId: 'agent-1', features: Array.from({ length: 241 }, () => sample[0]) }), /bounded local audio features/);
});
