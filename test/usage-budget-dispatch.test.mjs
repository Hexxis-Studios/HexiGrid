import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { assertUsageBudgetAvailable, usageBudgetFeedback } from '../lib/budget-feedback.mjs';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function askModel(');
const end = source.indexOf('\nfunction bridgeStatus()', start);
assert.ok(start >= 0 && end > start);
const now = Date.now();
const record = (inputTokens, outputTokens, createdAt = new Date(now).toISOString()) => ({ inputTokens, outputTokens, createdAt });

function fixture(route, { used = 100, limit = 100, fail = false } = {}) {
  const state = { settings: { model: 'model', tokenBudget7d: limit }, providers: [{ id: 'p', hasKey: false }], usage: [record(used, 0)] };
  let dispatches = 0;
  const receipts = [];
  const execute = async () => {
    dispatches++;
    if (fail) throw Error('synthetic failure');
    return { content: 'answer', inputTokens: 5, outputTokens: 7 };
  };
  const ask = vm.runInNewContext(`${source.slice(start, end)}; askModel`, {
    state, MODEL: 'model', allowedModel: () => route, modelCatalog: [],
    credentialVault: { get: async () => 'unused' }, assertUsageBudgetAvailable,
    completeWithProvider: execute, executeOpenCode: execute, executeTextHarness: execute,
    resolveOpenCode: () => ({ command: 'synthetic', args: [] }), WORKSPACE_DIR: 'synthetic',
    recordUsage(data) { receipts.push(data); state.usage.push(record(data.inputTokens, data.outputTokens)); }
  });
  return { state, ask, receipts, dispatches: () => dispatches };
}

for (const [name, route] of [
  ['provider', { providerId: 'p', remoteModel: 'synthetic' }],
  ['OpenCode', { harnessId: 'opencode', remoteModel: 'synthetic' }],
  ['text harness', { harnessId: 'codex', remoteModel: 'synthetic' }]
]) test(`exhausted budget blocks actual ${name} askModel dispatch before execution`, async () => {
  const f = fixture(route);
  await assert.rejects(() => f.ask('harmless'), { code: 'LOCAL_TOKEN_BUDGET_EXHAUSTED', status: 429 });
  assert.equal(f.dispatches(), 0);
  assert.equal(f.receipts.length, 0);
});

test('crossing response is returned and accounted once; the following preview stops', async () => {
  const f = fixture({ providerId: 'p' }, { used: 95 });
  assert.equal(await f.ask('harmless', 'model', 'communication-preview'), 'answer');
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].source, 'communication-preview');
  assert.equal(f.receipts[0].inputTokens, 5);
  assert.equal(f.receipts[0].outputTokens, 7);
  await assert.rejects(() => f.ask('next'), { code: 'LOCAL_TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(f.dispatches(), 1);
});

test('disabled budget preserves local execution; failed dispatch does not invent usage', async () => {
  const f = fixture({ harnessId: 'opencode' }, { limit: null });
  assert.equal(await f.ask('harmless'), 'answer');
  const failed = fixture({ providerId: 'p' }, { used: 0, fail: true });
  await assert.rejects(() => failed.ask('harmless'), /synthetic failure/);
  assert.equal(failed.receipts.length, 0);
});

test('rolling window and malformed counts cannot subtract recorded usage', () => {
  const state = { settings: { tokenBudget7d: 100 }, usage: [
    record(100, 0), record(-10000, -10000), record('100', Infinity),
    record(99999, 99999, new Date(now - 8 * 86400000).toISOString())
  ] };
  assert.equal(usageBudgetFeedback(100, state.usage, now).used, 100);
  assert.throws(() => assertUsageBudgetAvailable(state, now), { code: 'LOCAL_TOKEN_BUDGET_EXHAUSTED' });
  assert.doesNotThrow(() => assertUsageBudgetAvailable(state, now + 8 * 86400000));
});
