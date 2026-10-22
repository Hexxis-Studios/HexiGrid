import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStaleness } from '../lib/memory-staleness.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

const createdAt = '2026-09-01T00:00:00.000Z';
const now = Date.parse('2026-09-15T00:00:00.000Z');
test('category TTL and exponential decay distinguish temporary and durable facts without mutation', () => {
  const temporary = { createdAt, status: 'active', metadata: { category: 'temporary' } };
  const preference = { ...temporary, metadata: { category: 'preference' } };
  const a = memoryStaleness(temporary, now);
  const b = memoryStaleness(preference, now);
  assert.equal(a.stale, true);
  assert.equal(b.stale, false);
  assert.equal(a.recency, 0.25);
  assert.ok(b.recency > a.recency);
  assert.equal(temporary.status, 'active');
  assert.equal(memoryStaleness({ createdAt, metadata: { category: '__proto__' } }, now).category, null);
});
test('explicit reconfirmation deadline can shorten category TTL and date deadlines include the day', () => {
  const record = { createdAt, metadata: { category: 'preference' }, verify_by: '2026-09-15' };
  assert.equal(memoryStaleness(record, now).stale, false);
  assert.equal(memoryStaleness(record, Date.parse('2026-09-16T00:00:00.000Z')).stale, true);
  assert.equal(memoryStaleness({ createdAt, verify_by: 'invalid' }, now).stale, true);
  assert.equal(memoryStaleness({ createdAt: '2027-01-01T00:00:00.000Z' }, now).recency, 1);
});
test('actual context ranking penalizes stale temporary facts and labels them when recalled', async () => {
  const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const records = ['temporary', 'preference'].map((category, index) => ({
    id: `memory-${index}`, lineageId, agentId: 'a', contextScope: null,
    status: 'active', verification: 'unverified', text: `${category} bridge fact`,
    evidence_excerpt: 'bridge evidence', importance: 0.5, createdAt, metadata: { category }
  }));
  const store = { async listContext() { return records; }, async getByIds() { return new Map(records.map(r => [r.id, r])); } };
  const rag = { async scoreCandidates() { return new Map(records.map(r => [r.id, 0.9])); } };
  const result = await buildMemoryTurnContext({ store, rag, lineageId, agentId: 'a', scope: null,
    latestMessage: 'bridge', maxFacts: 1, now: () => now });
  assert.match(result.text, /preference bridge fact/);
  assert.doesNotMatch(result.text, /temporary bridge fact/);
  const both = await buildMemoryTurnContext({ store, rag, lineageId, agentId: 'a', scope: null,
    latestMessage: 'bridge', now: () => now });
  assert.match(both.text, /STALE/);
});
