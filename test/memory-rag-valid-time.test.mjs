import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

test('both vector hydration and canonical lexical fallback exclude known invalid current windows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-rag-valid-time-'));
  const lineageId = 'lineage-12121212-1212-4212-8212-121212121212';
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const now = Date.now();
  const iso = delta => new Date(now + delta).toISOString();
  const id = n => `memory-${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  const runtimeFactory = async () => ({ embedDocuments: async texts => texts.map(() => Float32Array.of(1, 0)),
    embedQueries: async () => [Float32Array.of(1, 0)], dispose: async () => {} });
  const rag = new LocalMemoryRag({ root: path.join(root, 'vectors'), store, runtimeFactory });
  const lexical = new LocalMemoryRag({ root: path.join(root, 'empty-vectors'), store,
    runtimeFactory: async () => { throw new Error('Lexical-only runtime'); } });
  try {
    await store.append({ id: id('1'), lineageId, agentId: 'agent-one', createdAt: iso(-30000),
      text: 'The quartz workshop has no stated validity dates.' });
    await store.append({ id: id('2'), lineageId, agentId: 'agent-one', createdAt: iso(-30000),
      text: 'The quartz workshop claim will expire.' });
    const day = iso(-30000).slice(0, 10);
    await rag.indexRange({ lineageId, from: day, to: day });
    await store.appendRevision({ lineageId, id: id('2'), expectedRevision: 0, createdAt: iso(-20000),
      by: 'owner:qa', why: 'Known expired assertion', changes: { valid_until: iso(-10000) } });
    await store.append({ id: id('3'), lineageId, agentId: 'agent-one', createdAt: iso(-10000),
      text: 'The quartz workshop opens in the future.', valid_from: iso(86400000) });
    assert.deepEqual((await rag.semanticSearch({ lineageId, query: 'quartz' })).map(record => record.id), [id('1')]);
    assert.deepEqual((await lexical.semanticSearch({ lineageId, query: 'quartz' })).map(record => record.id), [id('1')]);
  } finally {
    await rag.close(); await lexical.close(); await rm(root, { recursive: true, force: true });
  }
});
