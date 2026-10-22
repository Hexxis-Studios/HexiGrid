import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function harness({ deleteCache, importEngine } = {}) {
  const events = [];
  const workers = [];
  const loads = [];
  const deleted = [];
  let rejectLoad;
  let resolveLoad;
  const webllm = {
    prebuiltAppConfig: { model_list: [{ model_id: 'test-model', vram_required_MB: 1 }] },
    CreateWebWorkerMLCEngine(worker, modelId, options) {
      return new Promise((resolve, reject) => { workers.push(worker); rejectLoad = reject; resolveLoad = resolve; loads.push({ resolve, reject, options }); });
    },
    async deleteModelAllInfoInCache(modelId) { deleted.push(modelId); await deleteCache?.(); }
  };
  class WorkerStub { constructor() { this.terminated = false; } terminate() { this.terminated = true; } }
  const window = { isSecureContext: true, dispatchEvent: (event) => events.push(event) };
  const context = vm.createContext({ window, navigator: { gpu: { requestAdapter: async () => ({}) }, userAgent: 'test' }, location: { hostname: 'localhost' }, Worker: WorkerStub, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, __importEngine: url => importEngine ? importEngine(url, webllm) : Promise.resolve(webllm) });
  let source = await readFile(new URL('../public/on-device-inference.js', import.meta.url), 'utf8');
  source = source.replace("import('/vendor/web-llm.js' + (state.moduleAttempt ? `?retry=${state.moduleAttempt}` : ''))", "__importEngine('/vendor/web-llm.js' + (state.moduleAttempt ? `?retry=${state.moduleAttempt}` : ''))");
  vm.runInContext(source, context);
  const api = window.HexiGridOnDevice;
  const request = { modelId: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
  return { api, events, workers, loads, deleted, request, fail: (error) => rejectLoad(error), resolve: (engine) => resolveLoad(engine) };
}

test('interrupted cold download reports failure state with retry and no cloud fallback', async () => {
  const h = await harness();
  const pending = h.api.complete(h.request);
  await new Promise((resolve) => setImmediate(resolve));
  h.fail(new Error('Failed to fetch model download'));
  await assert.rejects(pending, /connection and available storage/i);
  const failed = h.events.findLast((event) => event.type === 'hexigrid:on-device-load-state' && event.detail.state === 'failed').detail;
  assert.equal(failed.retry, true);
  assert.equal(failed.cancel, false);
  assert.match(failed.message, /will not send your prompt to a cloud model automatically/i);
});

test('removing a preparing model cancels its worker before deleting its recoverable cache', { timeout: 1500 }, async () => {
  const h = await harness();
  const first = h.api.retryLoad('test-model');
  const cancelled = assert.rejects(first, /cancelled/i);
  await new Promise(resolve => setImmediate(resolve));
  await h.api.clearCache('test-model');
  assert.equal(h.workers[0].terminated, true);
  await cancelled;
  assert.deepEqual(h.deleted, ['test-model']);
  assert.equal(h.api.activeModel(), '');
  let unloaded = 0;
  h.loads[0].resolve({ unload: async () => { unloaded++; } });
  h.loads[0].options.initProgressCallback({ text: 'obsolete progress', progress: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unloaded, 1);
  assert.equal(h.api.activeModel(), '');
  assert.equal(h.events.some(e => e.detail.state === 'ready' || e.detail.text === 'obsolete progress'), false);
});

test('unload cancels pending preparation without installing a late engine', { timeout: 1500 }, async () => {
  const h = await harness();
  const first = h.api.retryLoad('test-model');
  const cancelled = assert.rejects(first, /cancelled/i);
  await new Promise(resolve => setImmediate(resolve));
  await h.api.unload();
  assert.equal(h.workers[0].terminated, true);
  await cancelled;
  h.loads[0].resolve({ unload: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.activeModel(), '');
});

test('simultaneous preparation shares one worker and immediate cancel/retry keeps the new load cancellable', async () => {
  const h = await harness();
  const first = h.api.retryLoad('test-model');
  const same = h.api.retryLoad('test-model');
  const firstCancelled = assert.rejects(first, /cancelled/i);
  const sameCancelled = assert.rejects(same, /cancelled/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 1);
  assert.equal(h.api.cancelLoad(), true);
  const retry = h.api.retryLoad('test-model');
  const retryCancelled = assert.rejects(retry, /cancelled/i);
  await firstCancelled;
  await sameCancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].terminated, false);
  assert.equal(h.api.cancelLoad(), true);
  await retryCancelled;
});

test('cancel terminates an active worker and retry starts a fresh load', async () => {
  const h = await harness();
  const first = h.api.complete(h.request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.api.cancelLoad(), true);
  assert.equal(h.workers[0].terminated, true);
  await assert.rejects(first, /cancelled/i);
  const second = h.api.retry(h.request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[1].terminated, false);
  h.fail(new Error('Failed to fetch model download'));
  await assert.rejects(second, /connection and available storage/i);
});

test('retry waits until cache deletion finishes, including an actionable deletion failure', async () => {
  let finish;
  const h = await harness({ deleteCache: () => new Promise(resolve => { finish = resolve; }) });
  const clear = h.api.clearCache('test-model');
  const retry = h.api.retryLoad('test-model');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 0);
  finish();
  await clear;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 1);
  h.fail(new Error('Failed to fetch'));
  await assert.rejects(retry, /connection and available storage/i);

  const denied = await harness({ deleteCache: async () => { throw Error('Synthetic cache unavailable'); } });
  await assert.rejects(denied.api.clearCache('test-model'), /cache unavailable/);
  const later = denied.api.retryLoad('test-model');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.workers.length, 1);
  denied.fail(new Error('Failed to fetch'));
  await assert.rejects(later, /connection and available storage/i);
});

test('a late cancelled worker failure cannot terminate or clear the fresh retry', async () => {
  const h = await harness();
  const first = h.api.retryLoad('test-model');
  const cancelled = assert.rejects(first, /cancelled/i);
  await new Promise(resolve => setImmediate(resolve));
  h.api.cancelLoad();
  const retry = h.api.retryLoad('test-model');
  const retried = assert.rejects(retry, /cancelled/i);
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  h.loads[0].reject(Error('old worker failed'));
  h.loads[0].options.initProgressCallback({ text: 'old worker progress', progress: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers[1].terminated, false);
  assert.equal(h.events.some(e => e.detail.text === 'old worker progress'), false);
  assert.equal(h.api.cancelLoad(), true);
  await retried;
});

test('cancellation during catalog preparation prevents worker creation', async () => {
  const h = await harness();
  const first = h.api.retryLoad('test-model');
  const cancelled = assert.rejects(first, /cancelled/i);
  assert.equal(h.api.cancelLoad(), true);
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 0);
});

test('catalog retries a failed module import using a fresh local URL and shares the recovered module', async () => {
  const urls = [];
  const h = await harness({ importEngine: async (url, module) => {
    urls.push(url);
    if (url === '/vendor/web-llm.js') throw Error('Synthetic unavailable engine');
    return module;
  } });
  await assert.rejects(h.api.supportedModels(), /refresh supported models/i);
  const results = await Promise.all([h.api.supportedModels(), h.api.supportedModels()]);
  assert.deepEqual(urls, ['/vendor/web-llm.js', '/vendor/web-llm.js?retry=1']);
  assert.equal(results[0].models.length, 1);
  assert.equal(results[1].models.length, 1);
  assert.equal(h.workers.length, 0);
});
