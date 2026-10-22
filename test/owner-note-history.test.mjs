import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { createOwnerMemory, reviseOwnerMemory } from '../lib/owner-memory.mjs';

const agentId = 'own-history-agent', lineageId = 'own-history-lineage';
const at = '2026-10-04T12:00:00.000Z';
function fixture() {
  let note = createOwnerMemory({ content: 'CURRENT-TEXT', valid_while: 'Until local QA ends.', evidence_excerpt: 'STANDING-EVIDENCE' }, { agentId, at });
  for (let i = 0; i < 4; i++) note = reviseOwnerMemory(note, { content: `Updated ${i}.`, evidence_excerpt: `REVISION-EVIDENCE-${i}` }, {
    by: 'agent-link:synthetic', why: `Correction ${i}`, at, source: { kind: 'agent-link-message', id: `source-${i}`, linkId: 'test-link', text: 'SOURCE-EXCERPT', createdAt: at }
  });
  note = reviseOwnerMemory(note, { status: 'historical' }, { by: 'owner', why: 'Temporary note expired.', at });
  const f = { note, reads: 0, afterRead: () => {}, authorized: true };
  const handler = createMemoryMcpHandler({
    store: { recall() {}, getById() {}, listContext() {}, listContextScopes() {} }, rag: { semanticSearch() {} },
    agentId, lineageId, linkId: 'test-link', ownerNotes: async () => { f.reads++; f.afterRead(); return [f.note]; },
    assertActive: async () => { if (!f.authorized) throw Error('not active'); }
  });
  f.call = (args = {}, name = 'get-owner-note-history', id = 265) => handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { id: f.note.id, ...args } } });
  return f;
}
test('explicit historical read keeps conditions and depth boundaries; current reader remains empty', async () => {
  const f = fixture();
  for (const depth of [0, 1, 2]) {
    const result = await f.call({ depth }); assert.equal(result.error, undefined, JSON.stringify(result));
    const packet = result.result.structuredContent;
    assert.equal(packet.state, 'inactive'); assert.equal(packet.note.status, 'historical');
    assert.equal(packet.note.valid_while, 'Until local QA ends.');
    assert.equal(packet.note.verification, 'unverified'); assert.match(packet.note.warning, /HISTORICAL CONTEXT/);
    assert.equal(packet.note.text, depth ? f.note.content : undefined);
    if (depth === 0) { assert.equal(packet.revisions, undefined); assert.doesNotMatch(JSON.stringify(result), /Updated|EVIDENCE|SOURCE-EXCERPT/); }
    if (depth === 1) { assert.equal(packet.revisions.length, 5); assert.doesNotMatch(JSON.stringify(result), /REVISION-EVIDENCE|SOURCE-EXCERPT/); }
    if (depth === 2) { assert.equal(packet.note.evidence_excerpt, 'REVISION-EVIDENCE-3'); assert.match(JSON.stringify(result), /REVISION-EVIDENCE|SOURCE-EXCERPT/); }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  }
  const current = await f.call({}, 'get-owner-note');
  assert.equal(current.result.structuredContent.note, null);
});
test('history pagination is byte-bounded and invalidates changed-note or changed-depth cursors', async () => {
  const f = fixture(); const first = await f.call({ depth: 1, limit: 1, maxBytes: 2048 });
  assert.equal(first.error, undefined, JSON.stringify(first));
  let cursor = first.result.structuredContent.nextCursor;
  const numbers = first.result.structuredContent.revisions.map(r => r.number);
  assert.ok(cursor); const staleCursor = cursor;
  while (cursor) {
    const page = await f.call({ depth: 1, limit: 1, maxBytes: 2048, cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    numbers.push(...page.result.structuredContent.revisions.map(r => r.number));
    cursor = page.result.structuredContent.nextCursor;
  }
  assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
  assert.match((await f.call({ depth: 2, cursor: staleCursor })).error.message, /another scope/);
  f.note = reviseOwnerMemory(f.note, { status: 'active' }, { by: 'owner', why: 'Restore', at });
  assert.match((await f.call({ depth: 1, cursor: staleCursor })).error.message, /stale/);
});
test('oversized revisions are explicit and skipped with finite forward progress', async () => {
  const f = fixture();
  f.note = createOwnerMemory({ content: 'x'.repeat(4000) }, { agentId, at });
  f.note = reviseOwnerMemory(f.note, { content: 'small' }, { why: 'Replace oversized guidance', at });
  f.note = reviseOwnerMemory(f.note, { status: 'historical' }, { why: 'Retire', at });
  const page = await f.call({ depth: 1, limit: 1, maxBytes: 2048 });
  assert.equal(page.error, undefined, JSON.stringify(page));
  assert.deepEqual(page.result.structuredContent.oversizeRevisionNumbers, [1]);
  assert.ok(page.result.structuredContent.nextCursor);
  const next = await f.call({ depth: 1, limit: 1, maxBytes: 2048, cursor: page.result.structuredContent.nextCursor });
  assert.equal(next.result.structuredContent.revisions[0].number, 2);
  assert.equal(next.result.structuredContent.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
});
test('foreign/absent notes are indistinguishable, invalid input and corrupt history fail safely', async () => {
  const f = fixture(); const otherId = 'memory-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const absent = await f.call({ id: otherId });
  f.note = { ...f.note, agentId: 'foreign' };
  assert.deepEqual((await f.call()).result.structuredContent, { id: f.note.id, state: 'absent', note: null });
  assert.equal(absent.result.structuredContent.state, 'absent');
  for (const args of [{ depth: 3 }, { limit: 0 }, { maxBytes: 511 }, { untrusted: true }, { id: '../private' }]) {
    const before = f.reads; assert.ok((await f.call(args)).error); assert.equal(f.reads, before);
  }
  f.note = { ...f.note, agentId, revisions: f.note.revisions.map((r, i) => i ? r : { ...r, why: 'CORRUPT-PRIVATE-MARKER' }) };
  const broken = await f.call({ depth: 2 }); assert.ok(broken.error);
  assert.doesNotMatch(JSON.stringify(broken), /CORRUPT-PRIVATE-MARKER|EVIDENCE|SOURCE-EXCERPT/);
});
test('read authority is rechecked after asynchronous private source access', async () => {
  const f = fixture(); f.afterRead = () => { f.authorized = false; };
  const denied = await f.call({ depth: 2 }); assert.ok(denied.error);
  assert.doesNotMatch(JSON.stringify(denied), /EVIDENCE|Updated|SOURCE-EXCERPT/);
});

test('minimal Unicode budgets count the actual JSON-RPC envelope and never return unbounded metadata', async () => {
  const f = fixture();
  f.note = reviseOwnerMemory(f.note, { valid_while: '界'.repeat(160) }, { why: 'Bounded multibyte condition', at });
  for (const depth of [0, 1, 2]) {
    const result = await f.call({ depth, maxBytes: 512 }, 'get-owner-note-history', 'r'.repeat(128));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512, JSON.stringify(result));
    if (!result.error) assert.equal(result.result.structuredContent.state, 'oversize');
    assert.doesNotMatch(JSON.stringify(result), /界|EVIDENCE/);
  }
});
