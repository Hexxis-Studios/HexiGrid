import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalPageManifest } from '../lib/memory-page-manifest.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';

const records = [
  { id: 'memory-one', importance: 0.2, text: 'private first' },
  { id: 'memory-two', importance: 0.9, text: 'private second' },
  { id: 'memory-three', importance: 0.5, text: 'private third' },
  { id: 'memory-four', importance: 0.7, text: 'private fourth' }
];

test('retrieval page manifest identifies remaining and oversized facts without text', () => {
  const result = retrievalPageManifest({ projectId: 'project', topicId: 'topic', entityId: 'person', records,
    nextOffset: 2, oversizeIds: ['memory-one'], nextCursor: 'cursor' });
  assert.deepEqual(result.pageOutManifest, {
    kind: 'retrieval-page', scope: { projectId: 'project', topicId: 'topic', entityId: 'person' },
    omittedCount: 3,
    importanceRange: { min: 0.2, max: 0.7 },
    topics: [], entities: [], truncatedTopicCount: 0, truncatedEntityCount: 0,
    recovery: 'nextCursor+oversizeIds'
  });
  assert.match(result.blindSpotWarning, /Incomplete memory page/i);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.doesNotMatch(JSON.stringify(result), /evict/i);
});

test('a complete retrieval has no page-out or blind-spot claim', () => {
  assert.deepEqual(retrievalPageManifest({ projectId: 'project', records, nextOffset: records.length,
    oversizeIds: [], nextCursor: null }), {});
});

test('manifest accounts for all omitted records and points to top-level recovery fields', () => {
  const result = retrievalPageManifest({ projectId: 'project', records, nextOffset: 0,
    oversizeIds: [], nextCursor: 'cursor' }).pageOutManifest;
  assert.equal(result.omittedCount, 4);
  assert.equal(result.recovery, 'nextCursor');
  assert.equal(result.importanceRange.min, 0.2);
  assert.equal(result.importanceRange.max, 0.9);
});

test('manifest degrades within a tight packet budget without making the packet larger', () => {
  const basePacket = { projectId: 'project', memories: [{ id: 'memory-loaded', text: 'Exact fact' }],
    oversizeIds: [], nextCursor: 'cursor', omittedCount: 4, complete: false };
  const full = retrievalPageManifest({ projectId: 'project', records, nextOffset: 0, oversizeIds: [],
    nextCursor: 'cursor', basePacket, maxBytes: 2048 });
  assert.ok(full.pageOutManifest.importanceRange);
  const tight = retrievalPageManifest({ projectId: 'project', records, nextOffset: 0, oversizeIds: [],
    nextCursor: 'cursor', basePacket, maxBytes: Buffer.byteLength(JSON.stringify(basePacket), 'utf8') + 40 });
  assert.ok(Buffer.byteLength(JSON.stringify({ ...basePacket, ...tight }), 'utf8') <=
    Buffer.byteLength(JSON.stringify(basePacket), 'utf8') + 40);
  assert.equal(Object.hasOwn(tight, 'pageOutManifest'), false);
});

test('full manifest bounds omitted topic and entity identifiers with truncation counts', () => {
  const omitted = Array.from({ length: 11 }, (_, index) => ({
    id: `memory-${index}`, importance: index / 10,
    contextScope: { projectId: 'project', topicId: `topic-${index}` },
    entityIds: [`entity-${index}`, 'shared-entity'], text: `private ${index}`
  }));
  const result = retrievalPageManifest({ projectId: 'project', records: omitted, nextOffset: 0,
    oversizeIds: [], nextCursor: 'cursor' });
  assert.deepEqual(result.pageOutManifest.topics, Array.from({ length: 8 }, (_, index) => `topic-${index}`));
  assert.deepEqual(result.pageOutManifest.entities, ['entity-0', 'shared-entity', 'entity-1', 'entity-2',
    'entity-3', 'entity-4', 'entity-5', 'entity-6']);
  assert.equal(result.pageOutManifest.truncatedTopicCount, 3);
  assert.equal(result.pageOutManifest.truncatedEntityCount, 4);
  assert.equal(result.pageOutManifest.importanceRange.max, 1);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('MCP bounded recall preserves priority and exposes a recoverable retrieval blind spot', async () => {
  const projectId = 'project';
  const topicId = 'topic';
  const scoped = Array.from({ length: 7 }, (_, index) => ({
    id: `memory-${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000001`,
    text: index === 0 ? 'Exact owner anchor' : `Exact private fact ${index}`,
    status: 'active', valid_while: '', importance: index === 0 ? 0.1 : 0.5,
    identityAnchor: index === 0, revision: 0, updatedAt: '2026-09-28T12:00:00.000Z',
    sourceFile: 'lineage/2026-09-28.json', chunkIndex: index,
    contextScope: { projectId, topicId }, entityIds: [`entity-${index}`]
  }));
  const store = { recall: async () => [], getById: async () => null, listContext: async () => scoped,
    listContextScopes: async () => [] };
  const rag = { semanticSearch: async () => [], scoreCandidates: async () => new Map() };
  const handler = createMemoryMcpHandler({ store, rag, lineageId: 'lineage', agentId: 'agent' });
  const call = async (input) => {
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'recall-context', arguments: { projectId, topicId, query: 'task', maxBytes: 8192, ...input } } });
    assert.equal(response.error, undefined);
    return response.result.structuredContent;
  };
  const first = await call();
  assert.equal(first.memories.length, 5);
  assert.equal(first.memories[0].text, 'Exact owner anchor');
  assert.equal(first.pageOutManifest.kind, 'retrieval-page');
  assert.deepEqual(first.pageOutManifest.scope, { projectId, topicId });
  assert.equal(first.pageOutManifest.omittedCount, 2);
  assert.deepEqual(first.pageOutManifest.topics, [topicId]);
  assert.deepEqual(first.pageOutManifest.entities, ['entity-5', 'entity-6']);
  assert.equal(first.pageOutManifest.recovery, 'nextCursor');
  assert.match(first.blindSpotWarning, /Incomplete memory page/);
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 8192);
  assert.doesNotMatch(JSON.stringify(first.pageOutManifest), /private fact/);
  const second = await call({ cursor: first.nextCursor });
  assert.equal(second.memories.length, 2);
  assert.equal(second.complete, true);
  assert.equal(Object.hasOwn(second, 'blindSpotWarning'), false);
});
