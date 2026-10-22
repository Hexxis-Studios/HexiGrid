import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRetrievalMetrics, openLocalRetrievalMetrics } from '../lib/retrieval-metrics.mjs';

const one = 'memory-11111111-1111-4111-8111-111111111111';
const two = 'memory-22222222-2222-4222-8222-222222222222';

test('retrieval hits require explicit feedback and dead weight never triggers deletion', () => {
  const metrics = createRetrievalMetrics({ deadWeightMinimum: 3 });
  metrics.registerInventory({ records: [{ id: one }, { id: two }] });
  const first = metrics.recordRetrieval({ kind: 'semantic-search', records: [{ id: one, text: 'private fact' }, { id: two }] });
  assert.equal(metrics.summary().hitRate, null);
  assert.equal(metrics.summary().unratedRetrievals, 1);
  assert.throws(() => metrics.recordFeedback({ retrievalId: first, usefulIds: ['memory-33333333-3333-4333-8333-333333333333'] }), /outside/);
  metrics.recordFeedback({ retrievalId: first, usefulIds: [one] });
  assert.throws(() => metrics.recordFeedback({ retrievalId: first, usefulIds: [] }), /already/);
  for (let index = 0; index < 3; index++) {
    const id = metrics.recordRetrieval({ kind: 'recall-context', records: [two] });
    metrics.recordFeedback({ retrievalId: id, usefulIds: [] });
  }
  const summary = metrics.summary();
  assert.equal(summary.hitRate, 0.25);
  assert.equal(summary.deadWeightCandidates, 1);
  assert.equal(summary.automaticDeletion, false);
  assert.doesNotMatch(JSON.stringify(summary), /private fact|memory-1111|memory-2222/);
});

test('metrics are bounded and reject invalid or duplicate feedback', () => {
  const metrics = createRetrievalMetrics({ maxEvents: 1 });
  const old = metrics.recordRetrieval({ kind: 'semantic-search', records: [one] });
  metrics.recordRetrieval({ kind: 'semantic-search', records: [two] });
  assert.throws(() => metrics.recordFeedback({ retrievalId: old, usefulIds: [] }), /unknown/);
  assert.throws(() => metrics.recordRetrieval({ kind: 'other', records: [] }), /kind/);
  assert.throws(() => metrics.recordRetrieval({ kind: 'semantic-search', records: Array(101).fill(one) }), /bounded/);
});

test('bounded page-out manifests survive restart without storing fact text or reusable cursors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-pageout-metrics-'));
  const file = path.join(directory, 'retrieval-metrics.json');
  const manifest = { kind: 'retrieval-page', scope: { projectId: 'project-a', topicId: 'topic-b' }, omittedCount: 4,
    importanceRange: { min: 0.2, max: 0.9 }, topics: ['topic-b'], entities: ['entity-1'],
    truncatedTopicCount: 0, truncatedEntityCount: 0, recovery: 'nextCursor' };
  try {
    const first = await openLocalRetrievalMetrics({ file, scope: { agentId: 'agent-a', lineageId: 'lineage-a' } });
    await first.recordRetrieval({ kind: 'recall-context', records: [one], pageOutManifest: manifest, linkId: 'link-a',
      at: '2026-10-19T12:00:00.000Z' });
    const second = await openLocalRetrievalMetrics({ file, scope: { agentId: 'agent-a', lineageId: 'lineage-a' } });
    const history = await second.listPageOuts();
    assert.deepEqual(history.pageOuts, [{ at: '2026-10-19T12:00:00.000Z', kind: 'recall-context', scope: manifest.scope,
      omittedCount: 4, importanceRange: manifest.importanceRange, topics: ['topic-b'], entities: ['entity-1'],
      truncatedTopicCount: 0, truncatedEntityCount: 0, recovery: 'nextCursor' }]);
    assert.equal(history.hasMore, false);
    assert.match(history.note, /do not report what an external model provider removed/);
    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /private fact|query text|nextCursorValue|link-a|agent-a|lineage-a|memory-1111/);
    await assert.rejects(second.listPageOuts({ limit: 11 }), /1 to 10/);
    const bounded = createRetrievalMetrics();
    for (let index = 0; index < 105; index += 1) {
      await bounded.recordRetrieval({ kind: 'recall-context', records: [],
        pageOutManifest: { ...manifest, at: undefined }, at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
    }
    assert.equal(bounded.snapshot().pageOuts.length, 100);
    const latest = bounded.listPageOuts({ limit: 10 });
    assert.equal(latest.pageOuts.length, 10);
    assert.equal(latest.pageOuts[0].at, new Date(Date.UTC(2026, 0, 1, 0, 104)).toISOString());
    assert.equal(latest.pageOuts.at(-1).at, new Date(Date.UTC(2026, 0, 1, 0, 95)).toISOString());
    assert.equal(latest.hasMore, true);
    assert.throws(() => createRetrievalMetrics({ initialState: { ...JSON.parse(saved), pageOuts: [
      { ...manifest, importanceRange: { min: -1, max: 3 } }
    ] }, scope: { agentId: 'agent-a', lineageId: 'lineage-a' } }), /metrics file is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private local counters survive restart without storing raw memory or query content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-metrics-'));
  const file = path.join(directory, 'retrieval-metrics.json');
  try {
    const first = await openLocalRetrievalMetrics({ file, deadWeightMinimum: 2 });
    await first.registerInventory({ records: [{ id: one, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: two, createdAt: '2026-01-01T00:00:00.000Z' }], now: '2026-01-02T00:00:00.000Z' });
    const request = await first.recordRetrieval({ kind: 'semantic-search', records: [{ id: one, text: 'private content' }] });
    await first.recordFeedback({ retrievalId: request, usefulIds: [] });
    const second = await openLocalRetrievalMetrics({ file, deadWeightMinimum: 2 });
    const next = await second.recordRetrieval({ kind: 'semantic-search', records: [one] });
    await second.recordFeedback({ retrievalId: next, usefulIds: [] });
    assert.equal((await second.summary()).deadWeightCandidates, 1);
    const coverage = await second.summary({ now: '2026-02-02T00:00:00.000Z', days: 30 });
    assert.equal(coverage.inventoryCount, 2);
    assert.equal(coverage.neverRetrievedOverN, 1);
    assert.equal(coverage.storePercentEverRetrieved, 0.5);
    assert.equal((await second.summary({ now: '2026-01-10T00:00:00.000Z', days: 30 })).neverRetrievedOverN, 0);
    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /private content|memory-1111|memory-2222|semantic-search query/);
    assert.equal(JSON.parse(saved).totals.rated, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('scoped metrics reject another Link and return bounded current-fact review records', () => {
  const scope = { agentId: 'private-agent', lineageId: 'lineage-private' };
  const metrics = createRetrievalMetrics({ scope, deadWeightMinimum: 2 });
  metrics.registerInventory({ records: [{ id: one, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: two, createdAt: '2026-01-01T00:00:00.000Z' }], now: '2026-01-02T00:00:00.000Z' });
  const first = metrics.recordRetrieval({ kind: 'recall-context', records: [one], linkId: 'first-link' });
  assert.throws(() => metrics.recordFeedback({ retrievalId: first, usefulIds: [one], linkId: 'second-link' }), /unknown/);
  metrics.recordFeedback({ retrievalId: first, usefulIds: [], linkId: 'first-link' });
  const second = metrics.recordRetrieval({ kind: 'semantic-search', records: [one], linkId: 'first-link' });
  metrics.recordFeedback({ retrievalId: second, usefulIds: [], linkId: 'first-link' });
  const review = metrics.review({ records: [{ id: one, text: 'never persisted' }, { id: two }],
    now: '2026-02-02T00:00:00.000Z', days: 30, limit: 1 });
  assert.equal(review.candidateCount, 2);
  assert.equal(review.memories[0].deadWeightCandidate, true);
  assert.equal(review.memories[0].hitRate, 0);
  assert.equal(review.nextOffset, 1);
  assert.equal(metrics.review({ records: [{ id: one }, { id: two }], now: '2026-02-02T00:00:00.000Z', days: 30, offset: 1 }).memories[0].neverRetrievedOverN, true);
  const saved = JSON.stringify(metrics.snapshot());
  assert.doesNotMatch(saved, /private-agent|lineage-private|first-link|second-link|memory-1111|memory-2222|never persisted|"[a-f0-9-]{36}":/);
  assert.throws(() => createRetrievalMetrics({ scope: { ...scope, lineageId: 'other-lineage' }, initialState: metrics.snapshot() }), /another agent or lineage/);
});
