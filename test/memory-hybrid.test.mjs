import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

const lineageId = 'lineage-77777777-7777-4777-8777-777777777777';
const id = digit => `memory-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

test('hybrid recall combines keywords and meaning, finds fresh long-query facts and respects current scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-hybrid-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  let queryCalls = 0;
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store, runtimeFactory: async () => ({
    embedDocuments: async texts => texts.map(text => text.includes('semantic') ? Float32Array.of(1, 0) : Float32Array.of(0, 1)),
    embedQueries: async () => { queryCalls++; return [Float32Array.of(1, 0)]; }, dispose() {}
  }) });
  const append = (digit, text, projectId = 'alpha') => store.append({ id: id(digit), lineageId,
    agentId: 'hybrid-agent', text, contextScope: { projectId } });
  try {
    await append('1', 'semantic equivalent of opening the crossing');
    await append('2', 'bridge recovery uses the keyword route');
    await append('3', 'unrelated indexed information');
    await append('4', 'bridge recovery semantic reference belongs elsewhere', 'private');
    const today = new Date().toISOString().slice(0, 10);
    await rag.indexRange({ lineageId, from: today, to: today });
    const records = await store.listContext({ lineageId, projectId: 'alpha' });
    const scores = await rag.scoreCandidates({ lineageId, query: 'bridge recovery', records });
    assert.equal(queryCalls, 1, 'one local query embedding, no re-embedding the corpus');
    assert.equal(scores.size, 3);
    assert.equal(scores.has(id('4')), false);
    assert.ok(scores.get(id('1')).score > scores.get(id('3')).score, 'meaning-only match survives');
    assert.ok(scores.get(id('2')).score > scores.get(id('3')).score, 'keyword-only match survives');
    assert.equal(scores.get(id('1')).method, 'hybrid');
    await append('5', 'bridge recovery after reconnect requires checking the current tunnel route');
    const matches = await rag.semanticSearch({ lineageId,
      query: 'bridge recovery after reconnect requires checking the current tunnel route', limit: 1 });
    assert.equal(matches[0].id, id('5'), 'fresh unindexed fact survives a query longer than four tokens');
    assert.equal(matches[0].matchMethod, 'lexical-fallback');
    await store.appendRevision({ lineageId, id: id('5'), expectedRevision: 0, by: 'owner:test',
      why: 'Retired disposable test fact', changes: { status: 'rejected' } });
    const after = await rag.semanticSearch({ lineageId, query: 'bridge recovery after reconnect', limit: 25 });
    assert.equal(after.some(record => record.id === id('5')), false);
    assert.ok(after.every(record => Number.isFinite(record.score) && record.score >= 0 && record.score <= 1));
  } finally { await rag.close(); await rm(root, { recursive: true, force: true }); }
});
