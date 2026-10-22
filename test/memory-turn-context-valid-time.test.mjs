import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

const lineageId = 'lineage-12121212-1212-4212-8212-121212121212';
const scope = { projectId: 'valid-time-project' };
const timestamp = day => `2026-10-${day}T12:00:00.000Z`;
const id = n => `memory-${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const rag = { scoreCandidates: async ({ records }) => new Map(records.map(record => [record.id, 1])) };

test('bounded context separates factual windows from recorded history and respects current known bounds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-valid-context-'));
  const store = new DatedMemoryStore({ root });
  const call = options => buildMemoryTurnContext({ store, rag, lineageId, scope,
    latestMessage: 'studio workbench', now: () => Date.parse(timestamp('05')), ...options });
  try {
    const append = (n, text, fields = {}) => store.append({ id: id(n), lineageId, agentId: 'studio-agent',
      text, contextScope: scope, createdAt: timestamp('01'), ...fields });
    await append('1', 'Studio workbench uses cedar.', { valid_from: timestamp('01'), valid_until: timestamp('03') });
    await append('2', 'Studio workbench uses fir.', { valid_from: timestamp('03') });
    await append('3', 'Studio workbench uses maple next week.', { valid_from: timestamp('09') });
    await append('4', 'Studio workbench has an unknown historical interval.');
    await append('5', 'Studio workbench claim rejected.', { valid_from: timestamp('01') });
    await store.appendRevision({ lineageId, id: id('1'), expectedRevision: 0, createdAt: timestamp('04'),
      by: 'owner:qa', why: 'Retained replaced claim', changes: { status: 'superseded' } });
    await store.appendRevision({ lineageId, id: id('5'), expectedRevision: 0, createdAt: timestamp('04'),
      by: 'owner:qa', why: 'Rejected mistaken claim', changes: { status: 'rejected' } });

    const current = await call({});
    assert.match(current.text, /uses fir/);
    assert.match(current.text, /unknown historical interval/);
    assert.doesNotMatch(current.text, /uses cedar|maple next week|claim rejected/);
    const past = await call({ validAt: timestamp('02') });
    assert.equal(past.factCount, 1);
    assert.match(past.text, /uses cedar/);
    assert.match(past.text, /VALID-TIME WINDOW/);
    assert.match(past.text, /"valid_until":"2026-10-03T12:00:00.000Z"/);
    assert.doesNotMatch(past.text, /uses fir|maple|unknown historical|claim rejected/);
    const boundary = await call({ validAt: timestamp('03') });
    assert.equal(boundary.factCount, 1);
    assert.match(boundary.text, /uses fir/);
    assert.doesNotMatch(boundary.text, /uses cedar/);
    const recorded = await call({ asOf: timestamp('02') });
    assert.match(recorded.text, /recorded time is distinct from factual validity/);
    assert.match(recorded.text, /maple next week/);
    assert.doesNotMatch(recorded.text, /claim rejected/);
    const both = await call({ asOf: timestamp('02'), validAt: timestamp('03') });
    assert.match(both.text, /RECORDED STANDING|HISTORICAL SNAPSHOT/);
    assert.match(both.text, /uses fir/);
    assert.doesNotMatch(both.text, /uses cedar|unknown historical|claim rejected/);
    assert.equal((await call({ validAt: '2026-10-02' })).reason, 'invalid-valid-at');
  } finally { await rm(root, { recursive: true, force: true }); }
});
