import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadFailureGuidance() {
  const window = {};
  vm.runInNewContext(await readFile(new URL('../public/on-device-inference.js', import.meta.url), 'utf8'), vm.createContext({ window }));
  return window.HexiGridOnDevice.failureGuidance;
}

test('on-device failures give actionable GPU guidance and do not suggest cloud fallback', async () => {
  const failureGuidance = await loadFailureGuidance();
  const message = failureGuidance(new Error('WebGPU device lost while allocating buffer'));
  assert.match(message, /smaller model/i);
  assert.match(message, /GPU-heavy apps/i);
  assert.match(message, /will not send your prompt to a cloud model automatically/i);
});

test('on-device download failures explain connection/storage retry without leaking provider diagnostics', async () => {
  const failureGuidance = await loadFailureGuidance();
  const message = failureGuidance(new Error('Failed to fetch https://huggingface.invalid/private-runtime-detail'));
  assert.match(message, /connection and available storage/i);
  assert.match(message, /retry or choose a smaller model/i);
  assert.doesNotMatch(message, /huggingface|private-runtime-detail/i);
  assert.match(message, /will not send your prompt to a cloud model automatically/i);
});

test('unknown local inference failures still explain how to recover', async () => {
  const failureGuidance = await loadFailureGuidance();
  const message = failureGuidance(new Error('unknown worker error'));
  assert.match(message, /Retry, choose a smaller model, or use another connection/i);
});

test('unavailable WebGPU disables local model loading with actionable guidance and no engine request', async () => {
  const events = [];
  let engineRequests = 0;
  const window = {
    isSecureContext: true,
    dispatchEvent: event => events.push(event),
    hexigridCheckUsageBudget: async () => {}
  };
  const context = vm.createContext({
    window,
    navigator: { userAgent: 'synthetic browser without WebGPU' },
    location: { hostname: 'localhost' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    __importEngine: async () => { engineRequests++; throw new Error('Engine should not load without WebGPU'); }
  });
  const source = (await readFile(new URL('../public/on-device-inference.js', import.meta.url), 'utf8'))
    .replace("import('/vendor/web-llm.js' + (state.moduleAttempt ? `?retry=${state.moduleAttempt}` : ''))", "__importEngine('/vendor/web-llm.js')");
  vm.runInContext(source, context);
  const api = window.HexiGridOnDevice;

  const catalog = await api.supportedModels();
  assert.equal(catalog.supported, false);
  assert.deepEqual(Array.from(catalog.models), []);
  assert.match(catalog.reason, /usable WebGPU adapter/i);
  await assert.rejects(api.complete({ modelId: 'local-model', messages: [{ role: 'user', content: 'hello' }] }), /usable WebGPU adapter/i);
  assert.equal(engineRequests, 0);
  assert.equal(events.at(-1).detail.state, 'failed');
  assert.equal(events.at(-1).detail.retry, true);
  assert.equal(events.at(-1).detail.cancel, false);
});
