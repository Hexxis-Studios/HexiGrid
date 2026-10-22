import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherLineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = Date.parse('2026-10-01T12:00:00.000Z');

function ranker() {
  return { async scoreCandidates({ records }) {
    return new Map(records.map(record => [record.id, record.text.includes('bridge') ? 0.9 : 0.1]));
  } };
}

test('explicit null recalls only bounded unscoped memories from the selected lineage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-unscoped-context-'));
  const store = new DatedMemoryStore({ root });
  const append = (text, overrides = {}) => store.append({ lineageId, agentId: 'agent-one',
    createdAt: '2026-09-30T12:00:00.000Z', text, evidence_excerpt: `Evidence for ${text}.`,
    importance: 0.5, ...overrides });
  try {
    await append('Unscoped bridge fact one.', { importance: 1 });
    await append('Unscoped bridge fact two.', { status: 'conditional', valid_while: 'the local agent is active', importance: 0.1 });
    await append('PRIVATE_PROJECT bridge detail.', { contextScope: { projectId: 'project-private' } });
    await store.append({ lineageId: otherLineageId, agentId: 'agent-one', createdAt: '2026-09-30T12:00:00.000Z',
      text: 'PRIVATE_LINEAGE bridge detail.', evidence_excerpt: 'Other lineage evidence.' });
    const rejected = await append('PRIVATE_REJECTED bridge detail.');
    await store.appendRevision({ lineageId, id: rejected.entry.id, expectedRevision: 0,
      createdAt: '2026-09-30T13:00:00.000Z', by: 'owner:qa', why: 'Reject test fixture', changes: { status: 'rejected' } });

    const result = await buildMemoryTurnContext({ store, rag: ranker(), lineageId, agentId: 'agent-one',
      scope: null, latestMessage: 'bridge', now: () => now, maxFacts: 1 });

    assert.equal(result.status, 'ready');
    assert.equal(result.identityCount, 0, 'unscoped records remain ordinary facts, never project identity anchors');
    assert.equal(result.factCount, 1, 'the caller fact cap is enforced on unscoped retrieval');
    assert.match(result.text, /Unscoped bridge fact one/);
    for (const privateText of ['PRIVATE_PROJECT', 'PRIVATE_LINEAGE', 'PRIVATE_REJECTED', 'Unscoped bridge fact two']) {
      assert.equal(result.text.includes(privateText), false, `${privateText} must not enter the null-scope aperture`);
    }

    const exactStoreResults = await store.listContext({ lineageId, unscopedOnly: true });
    assert.ok(exactStoreResults.every(record => record.contextScope === null));
    await assert.rejects(store.listContext({ lineageId, unscopedOnly: true, projectId: 'project-private' }),
      /cannot include a project or topic scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only an explicit null selects unscoped memories; omitted and malformed scopes stay rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-unscoped-explicit-'));
  const store = new DatedMemoryStore({ root });
  try {
    await store.append({ lineageId, agentId: 'agent-one', createdAt: '2026-09-30T12:00:00.000Z',
      text: 'Unscoped bridge fact.', evidence_excerpt: 'Stored without a project.' });
    const common = { store, rag: ranker(), lineageId, agentId: 'agent-one', latestMessage: 'bridge', now: () => now };
    const explicitNull = await buildMemoryTurnContext({ ...common, scope: null });
    const omitted = await buildMemoryTurnContext(common);
    const malformed = await buildMemoryTurnContext({ ...common, scope: { projectId: null } });

    assert.equal(explicitNull.status, 'ready');
    assert.match(explicitNull.text, /Unscoped bridge fact/);
    assert.equal(omitted.status, 'empty');
    assert.equal(omitted.reason, 'scope-required');
    assert.equal(omitted.text, '');
    assert.equal(malformed.status, 'empty');
    assert.equal(malformed.reason, 'scope-required');
    assert.equal(malformed.text, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
