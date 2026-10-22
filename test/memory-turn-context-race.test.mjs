import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

test('a concurrent revision cannot inherit the previous fact relevance or stale standing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-context-revision-'));
  const store = new DatedMemoryStore({ root });
  const lineageId = 'lineage-12121212-1212-4212-8212-121212121212';
  const id = 'memory-12121212-1212-4212-8212-121212121212';
  const scope = { projectId: 'studio' };
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', text: 'The bridge uses port 9000.',
      contextScope: scope, createdAt: '2026-09-01T10:00:00.000Z', verify_by: '2026-09-02' });
    let revised = false;
    const rag = { async scoreCandidates({ records }) {
      const scores = new Map(records.map(record => [record.id, record.text.includes('bridge') ? 1 : 0]));
      if (!revised) {
        revised = true;
        await store.appendRevision({ lineageId, id, expectedRevision: 0,
          createdAt: '2026-10-02T10:00:00.000Z', by: 'owner:qa', why: 'Corrected mistaken attribution',
          changes: { text: 'The garden contains basil.', verify_by: '2027-01-01' } });
      }
      return scores;
    } };
    const options = { store, rag, lineageId, agentId: 'agent-one', scope,
      latestMessage: 'bridge', now: () => Date.parse('2026-10-02T12:00:00.000Z') };
    const raced = await buildMemoryTurnContext(options);
    assert.equal(raced.status, 'empty');
    assert.equal(raced.reason, 'memory-changed-during-retrieval');
    assert.equal(raced.omittedCount, 1);
    assert.equal(raced.text, '');
    const next = await buildMemoryTurnContext(options);
    assert.equal(next.reason, 'no-relevant-memories');
    const garden = await buildMemoryTurnContext({ ...options, latestMessage: 'garden',
      rag: { async scoreCandidates({ records }) { return new Map(records.map(record => [record.id, 1])); } } });
    assert.match(garden.text, /garden contains basil/);
    assert.doesNotMatch(garden.text, /REVERIFY|STALE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
