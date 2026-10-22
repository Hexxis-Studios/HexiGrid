import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';

const lineageId = 'lineage-12345678-1234-4234-8234-123456789abc';
const otherLineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'temporal-mcp-test';
const oldId = 'memory-11111111-1111-4111-8111-111111111111';
const nextId = 'memory-22222222-2222-4222-8222-222222222222';
const disputedId = 'memory-33333333-3333-4333-8333-333333333333';
const rejectedId = 'memory-44444444-4444-4444-8444-444444444444';
const futureId = 'memory-55555555-5555-4555-8555-555555555555';
const boundary = '2026-09-25T10:00:00.000Z';
const beforeBoundary = '2026-09-25T09:59:59.999Z';
const afterLink = '2026-09-22T11:00:00.000Z';
const beforeLink = '2026-09-22T09:59:59.999Z';
const beforeSuccessor = '2026-09-21T09:59:59.999Z';

function handlerFor(store, lineage = lineageId) {
  return createMemoryMcpHandler({ store, rag: { semanticSearch: async () => [] }, lineageId: lineage, agentId });
}

async function rawCall(handler, name, args = {}) {
  return handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

async function call(handler, name, args = {}) {
  const response = await rawCall(handler, name, args);
  if (response.error) throw new Error(response.error.message);
  return response.result.structuredContent;
}

async function seedReplacement(store) {
  await store.append({ id: oldId, lineageId, agentId, createdAt: '2026-09-20T10:00:00.000Z',
    text: 'The old meeting room is Cedar.', valid_from: '2026-09-20T00:00:00.000Z',
    contextScope: { projectId: 'alpha', topicId: 'schedule' } });
  await store.append({ id: nextId, lineageId, agentId, createdAt: '2026-09-21T10:00:00.000Z',
    text: 'The current meeting room is Birch.', valid_from: boundary,
    contextScope: { projectId: 'alpha', topicId: 'schedule' } });
  await store.appendConflictLink({ lineageId, fromId: nextId, toId: oldId, relation: 'supersedes',
    expectedFromRevision: 0, expectedToRevision: 0, by: 'owner:temporal-test',
    why: 'The schedule changed at a confirmed boundary.',
    evidence: { kind: 'owner-feedback', text: 'Owner confirmed the room change and effective time.' },
    createdAt: '2026-09-22T10:00:00.000Z' });
}

test('signed MCP reads keep recorded time distinct from half-open factual validity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-mcp-valid-time-'));
  const store = new DatedMemoryStore({ root });
  const handler = handlerFor(store);
  try {
    await seedReplacement(store);

    const before = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule', validAt: beforeBoundary });
    assert.deepEqual(before.memories.map(({ id }) => id), [oldId]);
    assert.equal(before.memories[0].status, 'superseded');
    assert.equal(before.memories[0].valid_until, boundary);
    assert.match(before.memories[0].warning, /SUPERSEDED STANDING/);
    assert.deepEqual(before.readSelection, { validAt: beforeBoundary });
    assert.match(before.readWarning, /not a current-time assertion/);

    const atBoundary = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule', validAt: boundary });
    assert.deepEqual(atBoundary.memories.map(({ id }) => id), [nextId], 'valid_from is included and valid_until is excluded');
    assert.equal(atBoundary.memories[0].valid_from, boundary);

    const beforeSuccessorSnapshot = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule',
      asOf: beforeSuccessor, validAt: boundary });
    assert.deepEqual(beforeSuccessorSnapshot.memories.map(({ id }) => id), [oldId],
      'a recorded snapshot before the successor was learned cannot include the successor');
    assert.equal(beforeSuccessorSnapshot.memories[0].status, 'active');

    const beforeLinkSnapshot = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule',
      asOf: beforeLink, validAt: boundary });
    assert.deepEqual(beforeLinkSnapshot.memories.map(({ id }) => id), [nextId, oldId],
      'before the supersedes event was recorded, both then-known claims still matched the requested valid instant');

    const recordedAfterLink = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule',
      asOf: afterLink, validAt: boundary });
    assert.deepEqual(recordedAfterLink.memories.map(({ id }) => id), [nextId]);

    const oldDetail = await call(handler, 'get-memory', { id: oldId, validAt: beforeBoundary });
    assert.equal(oldDetail.state, 'superseded');
    assert.equal(oldDetail.memory.text, 'The old meeting room is Cedar.');
    assert.match(oldDetail.memory.warning, /SUPERSEDED STANDING/);
    assert.deepEqual(oldDetail.readSelection, { validAt: beforeBoundary });
    assert.equal((await call(handler, 'get-memory', { id: oldId, validAt: boundary })).state, 'absent');
    const recordedDetail = await call(handler, 'get-memory', { id: oldId, asOf: afterLink });
    assert.equal(recordedDetail.state, 'superseded');
    assert.match(recordedDetail.readWarning, /not a current-time assertion/);

    const defaultCurrent = await call(handler, 'recall-context', { projectId: 'alpha', topicId: 'schedule' });
    assert.deepEqual(defaultCurrent.memories.map(({ id }) => id), [nextId], 'default recall remains current');
    assert.equal(defaultCurrent.readSelection, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('temporal MCP recall and scope discovery require exact disputed opt-in and never return rejected facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-mcp-standing-'));
  const store = new DatedMemoryStore({ root });
  const handler = handlerFor(store);
  const futureValidAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  try {
    await store.append({ id: disputedId, lineageId, agentId, createdAt: '2026-09-20T12:00:00.000Z',
      text: 'There is a disputed launch date.', status: 'disputed', valid_from: '2026-09-20T00:00:00.000Z',
      contextScope: { projectId: 'disputed-project' } });
    await store.append({ id: rejectedId, lineageId, agentId, createdAt: '2026-09-20T13:00:00.000Z',
      text: 'Rejected private text must stay out of temporal recall.', valid_from: '2026-09-20T00:00:00.000Z',
      contextScope: { projectId: 'rejected-project' } });
    await store.appendRevision({ lineageId, id: rejectedId, expectedRevision: 0, createdAt: '2026-09-21T12:00:00.000Z',
      by: 'owner:temporal-test', why: 'Owner rejected this proposal.', changes: { status: 'rejected' } });
    await store.append({ id: futureId, lineageId, agentId, createdAt: '2026-09-20T14:00:00.000Z',
      text: 'A fact valid starting in the future.', valid_from: futureValidAt,
      contextScope: { projectId: 'future-project' } });

    const withoutDisputed = await call(handler, 'recall-context', { projectId: 'disputed-project', validAt: boundary });
    assert.deepEqual(withoutDisputed.memories, []);
    const withDisputed = await call(handler, 'recall-context', { projectId: 'disputed-project', validAt: boundary, includeDisputed: true });
    assert.deepEqual(withDisputed.memories.map(({ id }) => id), [disputedId]);
    assert.equal(withDisputed.memories[0].status, 'disputed');
    assert.match(withDisputed.memories[0].warning, /DISPUTED STANDING/);
    assert.match(withDisputed.readWarning, /includeDisputed was explicitly enabled/);
    assert.equal((await call(handler, 'get-memory', { id: disputedId })).state, 'inactive');
    const disputedDetail = await call(handler, 'get-memory', { id: disputedId, includeDisputed: true });
    assert.equal(disputedDetail.state, 'disputed');
    assert.match(disputedDetail.memory.warning, /DISPUTED STANDING/);

    for (const name of ['recall-context', 'list-context-scopes']) {
      const args = name === 'recall-context' ? { projectId: 'rejected-project', validAt: boundary } : { validAt: boundary };
      const result = await call(handler, name, args);
      assert.ok(!JSON.stringify(result).includes('Rejected private text'));
      if (name === 'recall-context') assert.deepEqual(result.memories, []);
      else assert.ok(!result.scopes.some(({ projectId }) => projectId === 'rejected-project'));
    }
    const rejectedDetail = await call(handler, 'get-memory', { id: rejectedId, validAt: boundary, depth: 1 });
    assert.equal(rejectedDetail.state, 'absent');
    assert.equal(rejectedDetail.memory, null);

    const onlyCurrentScopes = await call(handler, 'list-context-scopes');
    assert.ok(!onlyCurrentScopes.scopes.some(({ projectId }) => projectId === 'disputed-project' || projectId === 'rejected-project'));
    assert.ok(!onlyCurrentScopes.scopes.some(({ projectId }) => projectId === 'future-project'));
    const disputedScopes = await call(handler, 'list-context-scopes', { includeDisputed: true });
    assert.ok(disputedScopes.scopes.some(({ projectId }) => projectId === 'disputed-project'));
    assert.ok(!disputedScopes.scopes.some(({ projectId }) => projectId === 'rejected-project'));
    const futureScopes = await call(handler, 'list-context-scopes', { validAt: futureValidAt });
    assert.ok(futureScopes.scopes.some(({ projectId }) => projectId === 'future-project'));
    assert.deepEqual((await call(handler, 'recall-context', { projectId: 'future-project', validAt: futureValidAt })).memories.map(({ id }) => id), [futureId]);
    assert.equal((await call(handler, 'get-memory', { id: futureId, validAt: futureValidAt })).state, 'current');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('temporal cursors bind recorded/factual selection, lifecycle flags, and lineage while respecting byte limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-mcp-cursors-'));
  const store = new DatedMemoryStore({ root });
  const handler = handlerFor(store);
  const idFor = (number) => `memory-${number.toString(16).padStart(8, '0')}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
  try {
    for (let index = 0; index < 16; index += 1) {
      await store.append({ id: idFor(index + 1), lineageId, agentId, createdAt: '2026-09-20T10:00:00.000Z',
        text: `Current dated context ${index}. ${'x'.repeat(350)}`, valid_from: '2026-09-20T00:00:00.000Z',
        contextScope: { projectId: 'cursor-project' } });
      await store.append({ lineageId, agentId, createdAt: `2026-09-20T11:${String(index).padStart(2, '0')}:00.000Z`,
        text: `Scope inventory content ${index}.`, contextScope: { projectId: `scope-${String(index).padStart(2, '0')}` } });
    }
    const firstContext = await call(handler, 'recall-context', { projectId: 'cursor-project', validAt: boundary, maxBytes: 2048 });
    assert.ok(firstContext.nextCursor);
    assert.ok(Buffer.byteLength(JSON.stringify(firstContext), 'utf8') <= 2048);
    await assert.rejects(call(handler, 'recall-context', { projectId: 'cursor-project', validAt: '2026-09-26T10:00:00.000Z',
      maxBytes: 2048, cursor: firstContext.nextCursor }), /another scope/);
    await assert.rejects(call(handler, 'recall-context', { projectId: 'cursor-project', validAt: boundary, includeDisputed: true,
      maxBytes: 2048, cursor: firstContext.nextCursor }), /another scope/);
    const contextPages = [firstContext];
    while (contextPages.at(-1).nextCursor) contextPages.push(await call(handler, 'recall-context', {
      projectId: 'cursor-project', validAt: boundary, maxBytes: 2048, cursor: contextPages.at(-1).nextCursor }));
    assert.equal(contextPages.flatMap((page) => page.memories).length, 16);
    assert.ok(contextPages.every((page) => Buffer.byteLength(JSON.stringify(page), 'utf8') <= 2048));

    const firstScopes = await call(handler, 'list-context-scopes', { asOf: afterLink, maxBytes: 1024 });
    assert.ok(firstScopes.nextCursor);
    assert.ok(Buffer.byteLength(JSON.stringify(firstScopes), 'utf8') <= 1024);
    await assert.rejects(call(handler, 'list-context-scopes', { asOf: afterLink, validAt: boundary, maxBytes: 1024,
      cursor: firstScopes.nextCursor }), /another scope/);
    const otherLineage = handlerFor(store, otherLineageId);
    await assert.rejects(call(otherLineage, 'list-context-scopes', { asOf: afterLink, maxBytes: 1024,
      cursor: firstScopes.nextCursor }), /another scope/);
    const scopePages = [firstScopes];
    while (scopePages.at(-1).nextCursor) scopePages.push(await call(handler, 'list-context-scopes', {
      asOf: afterLink, maxBytes: 1024, cursor: scopePages.at(-1).nextCursor }));
    assert.equal(scopePages.flatMap((page) => page.scopes).length, 17);
    assert.ok(scopePages.every((page) => Buffer.byteLength(JSON.stringify(page), 'utf8') <= 1024));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('temporal MCP options reject noncanonical timestamps instead of falling back to current reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-mcp-invalid-time-'));
  const store = new DatedMemoryStore({ root });
  const handler = handlerFor(store);
  try {
    await store.append({ id: oldId, lineageId, agentId, createdAt: '2026-09-20T10:00:00.000Z',
      text: 'A current fact.', contextScope: { projectId: 'alpha' } });
    const requests = [
      ['get-memory', { id: oldId, asOf: '2026-09-20' }],
      ['recall-context', { projectId: 'alpha', validAt: '2026-09-20T10:00:00Z' }],
      ['list-context-scopes', { asOf: '2026-02-30T10:00:00.000Z' }]
    ];
    for (const [name, args] of requests) {
      const result = await rawCall(handler, name, args);
      assert.match(result.error?.message || '', /canonical UTC ISO timestamp/);
      assert.equal(result.result, undefined);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
