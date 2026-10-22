import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

const lineageId = 'lineage-88888888-8888-4888-8888-888888888888';

function fakeRuntime() {
  const vector = (text, query = false) => {
    const normalized = String(text).toLowerCase();
    const values = new Float32Array([
      normalized.includes('bridge') ? 1 : 0,
      normalized.includes('garden') ? 1 : 0,
      normalized.includes('privacy') ? 1 : 0,
      query ? 0.001 : 0
    ]);
    const norm = Math.hypot(...values) || 1;
    return Float32Array.from(values, (value) => value / norm);
  };
  return Promise.resolve({
    embedDocuments: async (texts) => texts.map((text) => vector(text)),
    embedQueries: async (texts) => (Array.isArray(texts) ? texts : [texts]).map((text) => vector(text, true)),
    dispose: async () => {}
  });
}

test('dated memory indexes and retrieves original chunks byte-for-byte with source references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rag-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store, runtimeFactory: fakeRuntime });
  const bridgeText = 'The bridge resumes from the last acknowledged sequence.\nThis text must remain exact.';
  try {
    await store.append({ lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:00:00.000Z', text: bridgeText });
    await store.append({ lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z', text: 'The garden has basil and tomatoes.' });
    assert.deepEqual(await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-21' }), { indexed: 2, total: 2 });
    const [result] = await rag.semanticSearch({ lineageId, query: 'bridge reconnect', limit: 1 });
    assert.equal(result.text, bridgeText);
    assert.equal(result.date, '2026-09-20');
    assert.match(result.sourceFile, /2026-09-20\.json$/);
    assert.match(result.chunkId, /^memory-/);
    assert.equal(result.chunkIndex, 0);
    assert.deepEqual(await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-21' }), { indexed: 2, total: 2 });
  } finally {
    await rag.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('semantic recall hydrates current standing and never returns stale rejected index text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rag-revision-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store, runtimeFactory: fakeRuntime });
  const id = 'memory-77777777-7777-4777-8777-777777777777';
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:00:00.000Z', text: 'The bridge is open.', valid_while: 'the owner session is active' });
    await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    await store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-21T10:00:00.000Z', by: 'owner:qa', why: 'Bridge closed', changes: { status: 'rejected' } });
    assert.deepEqual(await rag.semanticSearch({ lineageId, query: 'bridge', limit: 1 }), []);
    await store.appendRevision({ lineageId, id, expectedRevision: 1, createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Bridge reopened', changes: { status: 'conditional', text: 'The bridge reopened.', valid_while: 'the owner session is active' } });
    const lexical = await rag.semanticSearch({ lineageId, query: 'bridge', limit: 1 });
    assert.equal(lexical[0].text, 'The bridge reopened.');
    assert.equal(lexical[0].matchMethod, 'lexical-fallback', 'a stale embedding cannot rank revised text before it is reindexed');
    await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    const [result] = await rag.semanticSearch({ lineageId, query: 'bridge', limit: 1, depth: 1 });
    assert.equal(result.text, 'The bridge reopened.');
    assert.equal(result.valid_while, 'the owner session is active');
    assert.equal(result.status, 'conditional');
    assert.equal(result.revisions.length, 2);
  } finally { await rag.close(); await rm(root, { recursive: true, force: true }); }
});

test('scoped ranking never scores revised text with an obsolete vector', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rag-scoped-revision-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store, runtimeFactory: fakeRuntime });
  const id = 'memory-66666666-6666-4666-8666-666666666666';
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:00:00.000Z',
      text: 'The garden is open.', contextScope: { projectId: 'alpha' } });
    await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    await store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-21T10:00:00.000Z',
      by: 'owner:qa', why: 'Corrected subject', changes: { text: 'The bridge is open.' } });
    const records = await store.listContext({ lineageId, projectId: 'alpha' });
    const stale = await rag.scoreCandidates({ lineageId, query: 'bridge', records });
    assert.equal(stale.get(id).score, 1);
    assert.equal(stale.get(id).method, 'lexical-fallback');
    await rag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    const fresh = await rag.scoreCandidates({ lineageId, query: 'bridge', records });
    assert.equal(fresh.get(id).method, 'hybrid');
  } finally { await rag.close(); await rm(root, { recursive: true, force: true }); }
});

test('signed search falls back to local text when the embedding runtime fails and still filters stale facts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-search-fallback-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const indexRoot = path.join(root, 'index');
  const indexing = new LocalMemoryRag({ root: indexRoot, store, runtimeFactory: fakeRuntime });
  const currentId = 'memory-11111111-1111-4111-8111-111111111111';
  const staleId = 'memory-22222222-2222-4222-8222-222222222222';
  let searching;
  try {
    await store.append({ id: currentId, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:00:00.000Z', text: 'The bridge reconnects after login.' });
    await store.append({ id: staleId, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T11:00:00.000Z', text: 'The bridge was always open.' });
    await indexing.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    await indexing.close();
    await store.appendRevision({ lineageId, id: staleId, expectedRevision: 0, createdAt: '2026-09-21T10:00:00.000Z', by: 'owner:qa', why: 'Disproved', changes: { status: 'rejected' } });
    searching = new LocalMemoryRag({ root: indexRoot, store, runtimeFactory: async () => { throw new Error('Model unavailable'); } });
    const matches = await searching.semanticSearch({ lineageId, query: 'bridge', limit: 5 });
    assert.deepEqual(matches.map((item) => item.id), [currentId]);
    assert.equal(matches[0].matchMethod, 'lexical-fallback');
  } finally {
    await searching?.close();
    await indexing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact current fact remains searchable when its derived index was never built', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-missing-index-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store,
    runtimeFactory: async () => { throw new Error('Model unavailable'); } });
  const currentId = 'memory-33333333-3333-4333-8333-333333333333';
  const rejectedId = 'memory-44444444-4444-4444-8444-444444444444';
  try {
    await store.append({ id: currentId, lineageId, agentId: 'agent-one',
      createdAt: '2026-09-28T21:45:58.488Z', text: 'TEST PROPOSAL is a current fact.' });
    await store.append({ id: rejectedId, lineageId, agentId: 'agent-one',
      createdAt: '2026-09-28T21:46:00.000Z', text: 'TEST PROPOSAL was rejected.' });
    await store.appendRevision({ lineageId, id: rejectedId, expectedRevision: 0,
      createdAt: '2026-09-28T21:47:00.000Z', by: 'owner:qa', why: 'Disproved', changes: { status: 'rejected' } });
    const matches = await rag.semanticSearch({ lineageId, query: 'test proposal', limit: 5 });
    assert.deepEqual(matches.map((item) => item.id), [currentId]);
    assert.equal(matches[0].matchMethod, 'lexical-fallback');
  } finally { await rag.close(); await rm(root, { recursive: true, force: true }); }
});

test('lexical fallback ranks fresh partial hits and excludes stale and foreign-lineage records', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rag-fresh-lexical-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const indexRoot = path.join(root, 'index');
  const indexing = new LocalMemoryRag({ root: indexRoot, store, runtimeFactory: fakeRuntime });
  const partialId = 'memory-55555555-5555-4555-8555-555555555555';
  const supersededId = 'memory-12121212-1212-4212-8212-121212121212';
  const foreignLineageId = 'lineage-99999999-9999-4999-8999-999999999999';
  const foreignId = 'memory-34343434-3434-4434-8434-343434343434';
  const expectedId = 'memory-99999999-9999-4999-8999-999999999999';
  const expectedVoiceId = 'memory-78787878-7878-4787-8787-787878787878';
  let searching;
  try {
    await store.append({ id: partialId, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:00:00.000Z',
      text: 'The chat provider panel refreshes when the user reconnects.' });
    await store.append({ id: supersededId, lineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:30:00.000Z',
      text: 'Cross chat sync used the previous session context.' });
    await store.append({ id: foreignId, lineageId: foreignLineageId, agentId: 'agent-one', createdAt: '2026-09-20T10:45:00.000Z',
      text: 'Cross chat sync context belongs to another lineage.' });
    await indexing.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-20' });
    await indexing.close();
    await store.appendRevision({ lineageId, id: supersededId, expectedRevision: 0, createdAt: '2026-09-21T09:00:00.000Z',
      by: 'owner:qa', why: 'Replaced by current synchronization guidance', changes: { status: 'superseded' } });

    await store.append({ id: expectedId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z',
      text: 'Cross-chat synchronization keeps the newest shared context.' });
    await store.append({ id: expectedVoiceId, lineageId, agentId: 'agent-one', createdAt: '2026-09-22T10:00:00.000Z',
      text: 'Voice provider settings recover after a short delay.' });
    searching = new LocalMemoryRag({ root: indexRoot, store, runtimeFactory: async () => { throw new Error('Model unavailable'); } });
    const matches = await searching.semanticSearch({ lineageId, query: 'cross-chat sync', limit: 10 });

    assert.equal(matches[0]?.id, expectedId);
    assert.equal(matches[0]?.score, 2 / 3);
    assert.equal(matches[0]?.matchMethod, 'lexical-fallback');
    assert.equal(matches[1]?.id, partialId);
    assert.equal(matches[1]?.score, 1 / 3);
    assert.equal(matches.some((item) => item.id === supersededId || item.id === foreignId), false);

    const voiceMatches = await searching.semanticSearch({ lineageId, query: 'voice provider timeout', limit: 10 });
    assert.equal(voiceMatches[0]?.id, expectedVoiceId);
    assert.equal(voiceMatches[0]?.score, 2 / 3);
    assert.equal(voiceMatches[1]?.id, partialId);
    assert.equal(voiceMatches[1]?.score, 1 / 3);
  } finally {
    await searching?.close();
    await indexing.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt derived index falls back to newest canonical facts without resurrecting inactive claims', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-rag-corrupt-index-'));
  const indexRoot = path.join(root, 'index');
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  let runtimeCalls = 0;
  const rag = new LocalMemoryRag({ root: indexRoot, store, runtimeFactory: async () => { runtimeCalls++; throw new Error('Unavailable'); } });
  const id = 'memory-45454545-4545-4545-8545-454545454545';
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', text: 'Bridge recovery uses the old endpoint.' });
    await store.appendRevision({ lineageId, id, expectedRevision: 0, by: 'owner:qa', why: 'Correct endpoint', changes: { text: 'Bridge recovery uses the current endpoint.' } });
    for (const status of ['rejected', 'superseded', 'historical', 'disputed']) {
      await store.append({ lineageId, agentId: 'agent-one', text: `Bridge recovery inactive ${status}.`, status });
    }
    await store.append({ lineageId, agentId: 'agent-one', text: 'Bridge recovery future endpoint.', valid_from: '2099-01-01T00:00:00.000Z' });
    await store.append({ lineageId: 'lineage-99999999-9999-4999-8999-999999999999', agentId: 'agent-one', text: 'Bridge recovery other owner.' });
    await mkdir(indexRoot);
    await writeFile(path.join(indexRoot, `${lineageId}.sqlite`), 'Synthetic invalid derived index');
    const matches = await rag.semanticSearch({ lineageId, query: 'bridge recovery', limit: 25, depth: 1 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, id);
    assert.equal(matches[0].revision, 1);
    assert.equal(matches[0].text, 'Bridge recovery uses the current endpoint.');
    assert.equal(matches[0].status, 'active');
    assert.equal(matches[0].matchMethod, 'lexical-fallback');
    assert.equal(runtimeCalls, 0);
  } finally {
    await rag.close();
    await rm(root, { recursive: true, force: true });
  }
});
