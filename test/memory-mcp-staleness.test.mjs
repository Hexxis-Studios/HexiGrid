import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'agent-staleness';
const day = 86_400_000;
const id = (digit) => `memory-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

test('explicit MCP recall ranks category-stale facts lower and projects category and verify_by warnings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mcp-staleness-'));
  const store = new DatedMemoryStore({ root });
  const now = Date.now();
  const recordedAt = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  const handler = createMemoryMcpHandler({ store,
    rag: { async semanticSearch() { return []; },
      async scoreCandidates({ records }) { return new Map(records.map((record) => [record.id, { score: 0.9, method: 'fixture' }])); } },
    lineageId, agentId });
  const call = async () => {
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'recall-context', arguments: { projectId: 'staleness-fixture', query: 'bridge route' }
    } });
    if (response.error) throw new Error(response.error.message);
    return response.result.structuredContent;
  };

  try {
    await store.append({ id: id('1'), lineageId, agentId, createdAt: recordedAt(14),
      text: 'Temporary bridge route', metadata: { category: 'temporary' }, importance: 0.5,
      contextScope: { projectId: 'staleness-fixture' } });
    await store.append({ id: id('2'), lineageId, agentId, createdAt: recordedAt(2),
      text: 'Project bridge route awaiting verification', metadata: { category: 'project' },
      verify_by: new Date(now - day).toISOString().slice(0, 10), importance: 0.5,
      contextScope: { projectId: 'staleness-fixture' } });
    await store.append({ id: id('3'), lineageId, agentId, createdAt: recordedAt(2),
      text: 'Current project bridge route', metadata: { category: 'project' }, importance: 0.5,
      contextScope: { projectId: 'staleness-fixture' } });

    const result = await call();
    assert.deepEqual(result.memories.map((memory) => memory.id), [id('3'), id('2'), id('1')]);
    const temporary = result.memories.find((memory) => memory.id === id('1'));
    assert.equal(temporary.stale, true, 'category TTL must project staleness without verify_by');
    assert.match(temporary.warning, /STALE/);
    const deadline = result.memories.find((memory) => memory.id === id('2'));
    assert.equal(deadline.stale, true, 'explicit verify_by must remain effective');
    assert.match(deadline.warning, /STALE/);
    assert.equal(result.memories.find((memory) => memory.id === id('3')).stale, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
