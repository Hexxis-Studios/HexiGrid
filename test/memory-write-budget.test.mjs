import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProposalService } from '../lib/memory-proposal-service.mjs';
import { normalizeMemoryProposalState } from '../lib/memory-proposal-state.mjs';
import { memoryWriteBudgetLimits, consumeMemoryWriteBudget, normalizeMemoryWriteBudget } from '../lib/memory-write-budget.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = { kind: 'agent-link', callerId: 'budget-link', linkId: 'budget-link', agentId: 'budget-agent', lineageId };

test('a write burst quarantines distinct creates across services and survives encrypted-state normalization', async () => {
  let time = Date.parse('2026-10-18T12:00:00.000Z');
  let appends = 0;
  let state = { memoryProposals: [] };
  const makeService = () => createMemoryProposalService({ state, saveState: async () => {},
    appendMemory: async () => { appends++; return {}; }, authorize: () => ({ allowed: true, autoCommit: true }),
    now: () => new Date(time).toISOString() });
  const submit = (service, index, caller = source) => service.submitCreate({ source: caller,
    idempotencyKey: `budget-request-${index}`, payload: { text: `Synthetic ordinary fact ${index}.` } });
  let service = makeService();
  const results = await Promise.all(Array.from({ length: memoryWriteBudgetLimits.minuteCount }, (_, index) => submit(service, index)));
  assert.ok(results.every(result => result.committed));
  const retry = await submit(service, 0);
  assert.equal(retry.memoryId, results[0].memoryId);
  assert.equal(appends, 30, 'exact retry does not consume or append again');
  state = JSON.parse(JSON.stringify(state));
  state.memoryProposals = normalizeMemoryProposalState(state.memoryProposals);
  state.memoryWriteBudget = normalizeMemoryWriteBudget(state.memoryWriteBudget, time);
  service = makeService();
  const over = await submit(service, 31, { ...source, callerId: 'another-link', linkId: 'another-link' });
  assert.equal(over.quarantined, true);
  assert.deepEqual(over.reasonCodes, ['write_spike']);
  assert.equal(appends, 30);
  const proposal = normalizeMemoryProposalState(state.memoryProposals).find(row => row.id === over.proposalId);
  assert.equal(proposal.commitState, 'quarantined');
  assert.equal(proposal.payload.memoryId, undefined);
  time += 60001;
  const terminal = await submit(service, 31, { ...source, callerId: 'another-link', linkId: 'another-link' });
  assert.equal(terminal.quarantined, true, 'cooldown cannot auto-promote quarantined history');
  assert.equal((await submit(service, 32)).committed, true);
  assert.equal(appends, 31);
});

test('byte and hour budgets isolate agents, survive backwards clocks and reject malformed counters', () => {
  const state = {};
  const at = Date.parse('2026-10-18T12:00:00.000Z');
  assert.equal(consumeMemoryWriteBudget(state, { source, bytes: 100000, at }), true);
  assert.equal(consumeMemoryWriteBudget(state, { source, bytes: 40000, at }), false);
  assert.equal(consumeMemoryWriteBudget(state, { source: { ...source, agentId: 'other-agent' }, bytes: 40000, at }), true);
  assert.equal(consumeMemoryWriteBudget(state, { source, bytes: 40000, at: at - 1000 }), false);
  assert.equal(consumeMemoryWriteBudget(state, { source, bytes: 40000, at: at + 3600001 }), true);
  assert.equal(consumeMemoryWriteBudget(state, { source: { ...source, kind: 'owner-local' }, bytes: 100000, at }), true);
  const hourly = structuredClone(state);
  const ownKey = state.memoryWriteBudget.find(row => row.events.some(([, bytes]) => bytes === 100000))?.key || state.memoryWriteBudget[0].key;
  hourly.memoryWriteBudget = [{ key: ownKey, events: Array.from({ length: 500 }, () => [at - 61000, 1]) }];
  assert.equal(consumeMemoryWriteBudget(hourly, { source, bytes: 1, at }), false, 'hourly count remains enforced after minute cooldown');
  hourly.memoryWriteBudget = [{ key: ownKey, events: Array.from({ length: 20 }, () => [at - 61000, 100000]) }];
  assert.equal(consumeMemoryWriteBudget(hourly, { source, bytes: 100000, at }), false, 'hourly byte cap is independent of minute cap');
  assert.throws(() => normalizeMemoryWriteBudget([{ key: 'private-file-path', events: [] }], at), /invalid/);
  assert.throws(() => normalizeMemoryWriteBudget([{ key: 'a'.repeat(64), events: [[at, -1]] }], at), /invalid/);
});

test('denied create and secret-like input never consume counters or preserve candidate payload', async () => {
  const state = { memoryProposals: [] };
  const service = createMemoryProposalService({ state, saveState() {}, appendMemory() {},
    authorize: () => ({ allowed: false, reason: 'Denied' }) });
  await assert.rejects(service.submitCreate({ source, payload: { text: 'Synthetic fact.' } }), /Denied/);
  await assert.rejects(service.submitCreate({ source, payload: { text: 'api_key=synthetic-private-value-12345' } }));
  assert.equal(state.memoryWriteBudget, undefined);
  assert.equal(state.memoryProposals.length, 0);
});
