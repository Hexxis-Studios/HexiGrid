import test from 'node:test';
import assert from 'node:assert/strict';
import { pageMemoryFacts } from '../lib/memory-fact-browser.mjs';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const id = (number) => `memory-${String(number).padStart(8, '0')}-0000-4000-8000-000000000000`;
const records = [
  { id: id(1), text: 'Current preference', status: 'active' },
  { id: id(2), text: 'Conditional preference', status: 'conditional', valid_while: 'While QA is active' },
  { id: id(3), text: 'Retired preference', status: 'historical' }
];
const store = { async readRange({ lineageId, depth }) { assert.equal(lineageId, 'exact-lineage'); assert.ok([0,1,2].includes(depth)); return records; } };

function pastMistake(number, status = 'historical') {
  const memoryId = id(number);
  const mistakeId = `mistake-${memoryId.slice('memory-'.length)}`;
  const record = {
    format: 'hexigrid-memory-mistake', version: 1, id: mistakeId,
    lineageId: 'exact-lineage', agentId: 'qa-agent', contextScope: null,
    author: { kind: 'agent', id: 'qa-agent' }, createdAt: '2026-10-01T10:00:00.000Z',
    whatWentWrong: `What went wrong ${number}`, correction: `Correction ${number}`, resultingFix: `Fix ${number}`,
    evidence: { kind: 'agent-link-message', id: `link-message-source-${number}`, observedAt: '2026-10-01T09:00:00.000Z', excerpt: 'Synthetic evidence.' },
    recurrenceOf: []
  };
  return { id: memoryId, text: `Past mistake: ${record.whatWentWrong}`, lineageId: 'exact-lineage', agentId: 'qa-agent',
    status, contextScope: null, metadata: { memoryMistake: { format: 'hexigrid-memory-mistake', version: 1, record } } };
}

test('fact browser reads persisted revisions across dates without crossing lineages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-fact-browser-'));
  const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
  const dated = new DatedMemoryStore({ root });
  try {
    await dated.append({ id: id(1), lineageId, agentId: 'qa-agent', createdAt: '2026-09-29T10:00:00.000Z', text: 'Disposable original fact.', originKind: 'automatic-learning' });
    await dated.appendRevision({ lineageId, id: id(1), expectedRevision: 0, createdAt: '2026-09-30T10:00:00.000Z', by: 'owner:qa', why: 'Disposable correction', changes: { text: 'Disposable corrected fact.', status: 'conditional', valid_while: 'While QA is active' } });
    await dated.append({ id: id(2), lineageId: 'lineage-22222222-2222-4222-8222-222222222222', agentId: 'other-agent', createdAt: '2026-09-30T10:00:00.000Z', text: 'Other lineage.' });
    const page = await pageMemoryFacts(dated, { lineageId, query: 'corrected', depth: 1 });
    assert.equal(page.total, 1);
    assert.equal(page.facts[0].valid_while, 'While QA is active');
    assert.equal(page.facts[0].originKind, 'automatic-learning');
    assert.equal(page.facts[0].revisions.length, 1);
    assert.equal(page.facts[0].revisions[0].why, 'Disposable correction');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fact browser defaults to current standing, uses exact lineage and pages without duplicates', async () => {
  const first = await pageMemoryFacts(store, { lineageId: 'exact-lineage', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.hasMore, true);
  const second = await pageMemoryFacts(store, { lineageId: 'exact-lineage', limit: 1, after: first.nextCursor });
  assert.equal(second.facts[0].id, id(2));
  assert.equal(second.nextCursor, null);
});

test('explicit standing and local text search preserve conditions and current/history distinction', async () => {
  const historic = await pageMemoryFacts(store, { lineageId: 'exact-lineage', standing: 'historical' });
  assert.equal(historic.facts.length, 1);
  const match = await pageMemoryFacts(store, { lineageId: 'exact-lineage', query: 'WHILE QA', depth: 2 });
  assert.equal(match.facts[0].id, id(2));
  assert.equal(match.matchMethod, 'local-text');
  const all = await pageMemoryFacts(store, { lineageId: 'exact-lineage', standing: 'all' });
  assert.equal(all.total, 3);
});

test('past-mistake kind selects canonical records before standing filters and cursor paging', async () => {
  const entries = [
    ...records,
    pastMistake(11, 'historical'),
    pastMistake(12, 'rejected'),
    { id: id(13), text: 'Ordinary historical fact', status: 'historical', lineageId: 'exact-lineage', agentId: 'qa-agent',
      metadata: { memoryMistake: { format: 'hexigrid-memory-mistake', version: 1, record: { format: 'not-a-mistake', version: 1 } } } }
  ];
  const selectedStore = { async readRange({ lineageId }) { assert.equal(lineageId, 'exact-lineage'); return entries; } };
  const first = await pageMemoryFacts(selectedStore, { lineageId: 'exact-lineage', kind: 'mistakes', standing: 'all', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.facts[0].id, id(11));
  assert.equal(first.hasMore, true);
  const second = await pageMemoryFacts(selectedStore, { lineageId: 'exact-lineage', kind: 'mistakes', standing: 'all', limit: 1, after: first.nextCursor });
  assert.equal(second.facts[0].id, id(12));
  assert.equal(second.facts[0].status, 'rejected');
  assert.equal(second.total, 2);
  assert.equal((await pageMemoryFacts(selectedStore, { lineageId: 'exact-lineage', kind: 'all', standing: 'all' })).total, 6);
});

test('invalid bounds and cursors fail clearly rather than silently restarting or widening a read', async () => {
  for (const patch of [{ limit: 101 }, { depth: 3 }, { query: 'x'.repeat(501) }, { kind: 'trusted' }, { standing: 'trusted' }, { after: 'bad' }]) {
    await assert.rejects(pageMemoryFacts(store, { lineageId: 'exact-lineage', ...patch }));
  }
  await assert.rejects(pageMemoryFacts(store, { lineageId: 'exact-lineage', after: id(9) }), error => error.status === 409);
});

test('category and exact-scope filters apply to the full lineage before paging, with complete facets and disputed count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-fact-filter-'));
  const lineageId = 'lineage-33333333-3333-4333-8333-333333333333';
  const dated = new DatedMemoryStore({ root });
  try {
    for (let number = 1; number <= 36; number += 1) {
      const status = number >= 35 ? 'disputed' : 'active';
      const category = number >= 31 && number <= 34 ? 'rare' : number === 35 ? 'disputed-only' : 'General';
      const contextScope = number === 1 ? null
        : number === 2 ? { projectId: 'project-a' }
          : number === 3 ? { projectId: 'project-a', topicId: 'topic-x' }
            : number === 4 ? { projectId: 'project-a', topicId: 'topic-y' }
              : { projectId: 'project-b' };
      await dated.append({ id: id(number), lineageId, agentId: 'qa-agent',
        createdAt: `2026-10-${String(1 + Math.floor((number - 1) / 24)).padStart(2, '0')}T${String((number - 1) % 24).padStart(2, '0')}:00:00.000Z`,
        text: `Fact ${number}`, status, metadata: { category }, contextScope });
    }

    const firstRare = await pageMemoryFacts(dated, { lineageId, category: 'rare', limit: 1 });
    assert.equal(firstRare.total, 4);
    assert.equal(firstRare.facts[0].id, id(31));
    assert.equal(firstRare.nextCursor, id(31));
    assert.equal(firstRare.hasMore, true);
    assert.deepEqual(firstRare.facets.categories, ['General', 'rare']);
    assert.ok(firstRare.facets.scopes.some(scope => scope.value === JSON.stringify({ projectId: 'project-a', topicId: '' })));
    assert.equal(firstRare.facets.truncated.categories, false);
    assert.equal(firstRare.disputedCount, 2);
    const secondRare = await pageMemoryFacts(dated, { lineageId, category: 'rare', limit: 1, after: firstRare.nextCursor });
    assert.equal(secondRare.facts[0].id, id(32));
    assert.equal(secondRare.total, 4);

    const projectOnly = await pageMemoryFacts(dated, { lineageId,
      scope: JSON.stringify({ projectId: 'project-a', topicId: '' }), standing: 'all', limit: 100 });
    assert.deepEqual(projectOnly.facts.map(fact => fact.id), [id(2)]);
    const exactTopic = await pageMemoryFacts(dated, { lineageId,
      scope: JSON.stringify({ projectId: 'project-a', topicId: 'topic-x' }), standing: 'all' });
    assert.deepEqual(exactTopic.facts.map(fact => fact.id), [id(3)]);
    const unscoped = await pageMemoryFacts(dated, { lineageId, scope: '__unscoped__', standing: 'all' });
    assert.deepEqual(unscoped.facts.map(fact => fact.id), [id(1)]);

    const disputed = await pageMemoryFacts(dated, { lineageId, standing: 'disputed', limit: 100 });
    assert.equal(disputed.total, 2);
    assert.ok(disputed.facts.every(fact => fact.status === 'disputed'));
    assert.deepEqual([...disputed.facets.categories].sort(), ['General', 'disputed-only'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cursor from an unfiltered page conflicts when it is absent from the selected category result', async () => {
  const first = await pageMemoryFacts(store, { lineageId: 'exact-lineage', limit: 1 });
  await assert.rejects(pageMemoryFacts(store, { lineageId: 'exact-lineage', category: 'rare', after: first.nextCursor }),
    error => error.status === 409);
});

test('filter facets are capped, signal truncation, and retain selected values beyond the cap', async () => {
  const many = Array.from({ length: 140 }, (_, index) => ({
    id: id(1000 + index), text: `Fact ${index}`, status: 'active',
    metadata: { category: `category-${String(index).padStart(3, '0')}` },
    contextScope: { projectId: `project-${String(index).padStart(3, '0')}` }
  }));
  const selectedScope = JSON.stringify({ projectId: 'project-139', topicId: '' });
  const page = await pageMemoryFacts({ async readRange() { return many; } }, {
    lineageId: 'exact-lineage', category: 'category-139', scope: selectedScope
  });
  assert.ok(page.facets.categories.length <= 128);
  assert.ok(page.facets.scopes.length <= 128);
  assert.ok(page.facets.categories.includes('category-139'));
  assert.ok(page.facets.scopes.some(scope => scope.value === selectedScope));
  assert.deepEqual(page.facets.truncated, { categories: true, scopes: true });
});

test('category and scope filters reject malformed types, oversized UTF-8 and noncanonical scope transport', async () => {
  const invalid = [
    { category: 4 }, { category: '🙂'.repeat(41) }, { scope: null }, { scope: '{bad json' },
    { scope: JSON.stringify({ projectId: 'project-a' }) },
    { scope: JSON.stringify({ projectId: 'project-a', topicId: 7 }) },
    { scope: '{"topicId":"","projectId":"project-a"}' },
    { scope: '{ "projectId":"project-a","topicId":""}' },
    { scope: JSON.stringify({ projectId: ' project-a ', topicId: '' }) }
  ];
  for (const patch of invalid) await assert.rejects(pageMemoryFacts(store, { lineageId: 'exact-lineage', ...patch }));
});

test('invalid persisted category metadata is represented consistently as General in facets and filtering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-fact-category-shape-'));
  const lineageId = 'lineage-44444444-4444-4444-8444-444444444444';
  const dated = new DatedMemoryStore({ root });
  const categoryValues = [undefined, null, 7, { label: 'object category' }, ['array', 'category'], 'x'.repeat(161), '   ', 'Project notes'];
  try {
    for (let index = 0; index < categoryValues.length; index += 1) {
      const category = categoryValues[index];
      const metadata = category === undefined ? {} : { category };
      await dated.append({ id: id(200 + index), lineageId, agentId: 'qa-agent',
        createdAt: `2026-10-03T00:${String(index).padStart(2, '0')}:00.000Z`, text: `Category shape ${index}`,
        metadata });
    }

    const general = await pageMemoryFacts(dated, { lineageId, category: 'General', limit: 100 });
    assert.equal(general.total, 7);
    assert.deepEqual(general.facets.categories, ['General', 'Project notes']);
    assert.deepEqual(general.facts.map(fact => fact.id), Array.from({ length: 7 }, (_, index) => id(200 + index)));
    await assert.rejects(pageMemoryFacts(dated, { lineageId, category: 'x'.repeat(161), limit: 100 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
