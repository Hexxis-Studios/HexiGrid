import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';

const lineageId = 'lineage-12345678-1234-4234-8234-123456789abc';
const agentId = 'recovery-test';
const request = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const store = { recall() {}, getById() {}, listContext: async () => [], listContextScopes: async () => [] };

test('bad scope discovers the real schema then recovers without repeated requests or private reads', async () => {
  let reads = 0;
  const handler = createMemoryMcpHandler({ store: { ...store, listContext: async () => { reads++; return []; } },
    rag: { semanticSearch() {} }, lineageId, agentId });
  const bad = await handler(request('recall-context', { contextScope: { project: 'alpha' } }));
  assert.equal(bad.error.data.reason, 'request-rejected');
  assert.equal(bad.error.data.automaticRetries, 0);
  assert.equal(reads, 0);
  const discovery = await handler({ jsonrpc: '2.0', id: 2, ...bad.error.data.discovery });
  const schema = discovery.result.tools.find(tool => tool.name === 'recall-context').inputSchema;
  assert.ok(schema.properties.projectId);
  const good = await handler(request('recall-context', { projectId: 'alpha', maxBytes: 1024 }));
  assert.equal(good.error, undefined);
  assert.deepEqual(good.result.structuredContent.memories, []);
  assert.equal(reads, 1);
});

test('integrity, backend and authorization failures never suggest rewriting memory or leaking diagnostics', async () => {
  for (const [failure, reason] of [
    [new Error('Memory audit chain is broken.'), 'integrity-failure'],
    [new SyntaxError('private body at C:\\owner\\memory.json'), 'integrity-failure'],
    [new Error('private body at C:\\owner\\memory.json'), 'memory-unavailable'],
    [Object.assign(new Error('private policy state'), { status: 403 }), 'access-unavailable']
  ]) {
    let attempts = 0;
    const handler = createMemoryMcpHandler({ store, lineageId, agentId,
      rag: { semanticSearch: async () => { attempts++; throw failure; } } });
    const reply = await handler(request('semantic-search', { query: 'test' }));
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.data.reason, reason);
    assert.equal(reply.error.data.automaticRetries, 0);
    assert.equal(reply.error.data.memoryAvailable, false);
    assert.doesNotMatch(JSON.stringify(reply), /private body|C:\\|private policy state/);
    assert.equal(attempts, 1);
  }
});

test('a damaged owner-note audit returns a safe health-scan recovery path', async () => {
  const id = 'memory-12345678-1234-4234-8234-123456789abc';
  const ownerNotes = async () => [{ id, agentId, content: 'private note body', status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    revisions: [], audit: { version: 2, genesisHash: '0'.repeat(64) } }];
  const handler = createMemoryMcpHandler({ store: { ...store, readRange: async () => [] }, ownerNotes, linkId: 'link-test',
    lineageId, agentId, rag: { semanticSearch() {} } });
  const failedRead = await handler(request('get-owner-note', { id }));
  assert.equal(failedRead.error.code, -32000);
  assert.equal(failedRead.error.message, 'Owner memory audit chain is broken.');
  assert.equal(failedRead.error.data.reason, 'integrity-failure');
  assert.equal(failedRead.error.data.recoveryTool, 'inspect-memory-health');
  assert.equal(failedRead.error.data.automaticRetries, 0);
  assert.doesNotMatch(JSON.stringify(failedRead), /private note body|genesisHash/);

  const health = await handler(request('inspect-memory-health'));
  assert.equal(health.error, undefined);
  assert.deepEqual(health.result.structuredContent.issues, [{ memoryId: id, store: 'notes', reasons: ['invalid-provenance'] }]);
  assert.doesNotMatch(JSON.stringify(health), /private note body|genesisHash/);
});

test('a denied memory read does not call retrieval or advise an alternate authority', async () => {
  let reads = 0;
  const handler = createMemoryMcpHandler({ store, lineageId, agentId,
    assertActive: async () => { throw Object.assign(new Error('denied'), { status: 403 }); },
    rag: { semanticSearch: async () => { reads++; return []; } } });
  const reply = await handler(request('semantic-search', { query: 'test' }));
  assert.equal(reads, 0);
  assert.equal(reply.error.data.reason, 'access-unavailable');
  assert.doesNotMatch(reply.error.data.nextStep, /get-memory|recall-context/);
});

test('cursor and revision recovery require fresh reads rather than blind mutation retries', async () => {
  const handler = createMemoryMcpHandler({ store: { ...store, getById: async () => ({ status: 'active', revision: 2 }) },
    lineageId, agentId, rag: { semanticSearch() {} } });
  const cursor = await handler(request('recall-context', { projectId: 'alpha', cursor: 'invalid!' }));
  assert.equal(cursor.error.data.reason, 'stale-cursor');
  const correction = await handler(request('propose-correction', {
    id: 'memory-12345678-1234-4234-8234-123456789abc', expectedRevision: 0,
    text: 'Updated synthetic fact.', why: 'New evidence.', expectedNextBehavior: 'Use new evidence.', sourceMessageId: 'link-message-test-source'
  }));
  assert.equal(correction.error.data.reason, 'revision-conflict');
  assert.equal(correction.error.data.automaticRetries, 0);
});
