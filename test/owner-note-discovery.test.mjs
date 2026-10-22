import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { createOwnerMemory, reviseOwnerMemory } from '../lib/owner-memory.mjs';

function fixture() {
  const agentId = 'discovery-agent', at = '2026-10-04T12:00:00.000Z';
  const make = (content, status = 'active', owner = agentId) => {
    const note = createOwnerMemory({ content, valid_while: 'Until synthetic QA ends.', evidence_excerpt: 'PRIVATE-EVIDENCE' }, { agentId: owner, at });
    return status === 'active' ? note : reviseOwnerMemory(note, { status }, { by: 'owner', why: 'PRIVATE-REVISION-REASON', at });
  };
  const f = { notes: [make('Shared marker current'), make('Shared marker retired', 'historical'),
    make('Shared marker wrong', 'rejected'), make('Foreign marker', 'historical', 'foreign')], reads: 0, authorized: true, afterRead() {} };
  const handler = createMemoryMcpHandler({ store: { recall() {}, getById() {}, listContext() {}, listContextScopes() {} }, rag: { semanticSearch() {} }, agentId, lineageId: 'discovery-lineage', linkId: 'discovery-link',
    ownerNotes: async () => { f.reads++; f.afterRead(); return f.notes; },
    assertActive: async () => { if (!f.authorized) throw Error('not active'); } });
  f.call = (args = {}, id = 270) => handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list-owner-notes', arguments: args } });
  return f;
}
test('default current reader stays current-only; explicit standing index rediscovers own inactive IDs without text', async () => {
  const f = fixture();
  const current = (await f.call()).result.structuredContent;
  assert.deepEqual(current.notes.map(n => n.id), [f.notes[0].id]);
  assert.equal(current.notes[0].text, f.notes[0].content);
  const index = (await f.call({ standing: 'inactive', query: 'MARKER' })).result.structuredContent;
  assert.deepEqual(new Set(index.notes.map(n => n.id)), new Set([f.notes[1].id, f.notes[2].id]));
  assert.equal(index.projection, 'standing-index');
  for (const note of index.notes) {
    assert.equal(note.text, undefined); assert.equal(note.revision, 1);
    assert.equal(note.valid_while, 'Until synthetic QA ends.'); assert.match(note.warning, /HISTORICAL CONTEXT/);
  }
  assert.doesNotMatch(JSON.stringify(index), /PRIVATE-EVIDENCE|PRIVATE-REVISION|Foreign marker|Shared marker/);
  const all = (await f.call({ standing: 'all' })).result.structuredContent;
  assert.equal(all.notes.length, 3); assert.ok(all.notes.every(n => n.text === undefined));
  assert.equal((await f.call({ standing: 'inactive', query: 'missing' })).result.structuredContent.total, 0);
});
test('bounded standing-index pages progress and pin query, standing and record snapshot', async () => {
  const f = fixture();
  const first = await f.call({ standing: 'all', query: 'marker', limit: 1, maxBytes: 2048 });
  assert.equal(first.error, undefined); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const cursor = first.result.structuredContent.nextCursor; assert.ok(cursor);
  for (const change of [{ standing: 'inactive' }, { query: 'current' }]) {
    assert.match((await f.call({ standing: 'all', query: 'marker', cursor, ...change })).error.message, /another scope/);
  }
  const ids = first.result.structuredContent.notes.map(n => n.id);
  let nextCursor = cursor;
  while (nextCursor) {
    const page = await f.call({ standing: 'all', query: 'marker', limit: 1, maxBytes: 2048, cursor: nextCursor });
    assert.equal(page.error, undefined); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    ids.push(...page.result.structuredContent.notes.map(n => n.id)); nextCursor = page.result.structuredContent.nextCursor;
  }
  assert.equal(new Set(ids).size, 3);
  f.notes[0] = reviseOwnerMemory(f.notes[0], { status: 'historical' }, { by: 'owner', why: 'Changed standing' });
  assert.match((await f.call({ standing: 'all', query: 'marker', cursor })).error.message, /stale/);
});
test('invalid discovery selection is rejected before reading private notes', async () => {
  const f = fixture();
  for (const args of [{ standing: 'rejected' }, { query: 4 }, { query: 'x'.repeat(257) }, { limit: 0 },
    { maxBytes: 511 }, { cursor: 'x'.repeat(1025) }, { agentId: 'foreign' }]) {
    const result = await f.call(args); assert.ok(result.error); assert.equal(f.reads, 0);
  }
});
test('discovery and current reads recheck authority after the asynchronous private source', async () => {
  const f = fixture(); f.afterRead = () => { f.authorized = false; };
  const denied = await f.call({ standing: 'all' }); assert.ok(denied.error);
  assert.doesNotMatch(JSON.stringify(denied), /Until synthetic|PRIVATE|marker|memory-/);
  const current = await f.call(); assert.ok(current.error);
  assert.doesNotMatch(JSON.stringify(current), /marker|PRIVATE/);
});
test('Unicode request IDs count against the whole success envelope; tiny index budgets fail safely', async () => {
  const f = fixture();
  const result = await f.call({ standing: 'all', maxBytes: 2048, limit: 1 }, '🦊'.repeat(32));
  assert.equal(result.error, undefined); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  const small = await f.call({ standing: 'all', maxBytes: 512 });
  assert.ok(small.error); assert.doesNotMatch(JSON.stringify(small), /marker|PRIVATE/);
});
