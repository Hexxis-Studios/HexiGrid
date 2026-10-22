import test from 'node:test';
import assert from 'node:assert/strict';
import { commitUsageBudget } from '../lib/usage-report.mjs';

function fixture() {
  const state = { settings: {}, receipts: [] };
  let saves = 0;
  const options = { requireExpected: true, authorize() {}, async saveState() { saves++; },
    addReceipt(input) { const receipt = { id: `receipt-${state.receipts.length}`, ...input }; state.receipts.push(receipt); return receipt; } };
  return { state, options, saves: () => saves };
}
test('budget commit sets and reversibly clears only the local budget, retaining receipts', async () => {
  const { state, options, saves } = fixture();
  state.settings.provider = 'unchanged';
  await commitUsageBudget(state, { tokens: 100, expectedTokens: null }, options);
  assert.equal(state.settings.tokenBudget7d, 100);
  await commitUsageBudget(state, { tokens: null, expectedTokens: 100 }, options);
  assert.equal(state.settings.tokenBudget7d, null);
  assert.equal(state.settings.provider, 'unchanged');
  assert.equal(saves(), 2); assert.equal(state.receipts.length, 2);
});
test('stale, invalid, missing expectation and denied budget changes do not mutate or persist', async () => {
  const { state, options, saves } = fixture();
  for (const input of [{ tokens: 0, expectedTokens: null }, { tokens: 10 }, { tokens: 10, expectedTokens: 50 },
    { tokens: 10, expectedTokens: null, providerKey: 'forbidden' }]) await assert.rejects(commitUsageBudget(state, input, options));
  await assert.rejects(commitUsageBudget(state, { tokens: 10, expectedTokens: null }, { ...options,
    authorize() { throw Object.assign(new Error('Plan denies writes'), { status: 403 }); } }));
  assert.deepEqual(state.settings, {}); assert.deepEqual(state.receipts, []); assert.equal(saves(), 0);
});
test('persistence failure restores budget and removes only the failed receipt', async () => {
  const { state, options } = fixture(); state.receipts.push({ id: 'retained' });
  await assert.rejects(commitUsageBudget(state, { tokens: 10, expectedTokens: null }, { ...options,
    async saveState() { state.receipts.push({ id: 'concurrent-unrelated' }); throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.deepEqual(state.settings, {});
  assert.deepEqual(state.receipts.map(item => item.id), ['retained', 'concurrent-unrelated']);
});
test('shared owner and signed budget writes refuse overlap until persistence completes', async () => {
  const { state, options } = fixture(); let release;
  const first = commitUsageBudget(state, { tokens: 10, expectedTokens: null }, { ...options, saveState: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(commitUsageBudget(state, { tokens: null, expectedTokens: 10 }, options), error => error.status === 409);
  release(); await first;
  await commitUsageBudget(state, { tokens: null, expectedTokens: 10 }, options);
  assert.equal(state.settings.tokenBudget7d, null);
});

test('failed commit restores audit rows displaced by a bounded receipt writer', async () => {
  const { state, options } = fixture();
  state.settings.tokenBudget7d = 50;
  state.receipts = [{ id: 'newer' }, { id: 'older' }];
  await assert.rejects(commitUsageBudget(state, { tokens: 100, expectedTokens: 50 }, { ...options,
    addReceipt(input) { const receipt = { id: 'failed', ...input }; state.receipts.unshift(receipt); state.receipts = state.receipts.slice(0, 2); return receipt; },
    async saveState() { throw new Error('disk failure'); }
  }));
  assert.equal(state.settings.tokenBudget7d, 50);
  assert.deepEqual(state.receipts.map(item => item.id), ['newer', 'older']);
});
