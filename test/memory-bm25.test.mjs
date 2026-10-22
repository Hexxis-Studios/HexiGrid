import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

const lineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherLineageId = 'lineage-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const id = (hex) => `memory-${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`;

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-bm25-'));
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  let runtimeCalls = 0;
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store, runtimeFactory: async () => {
    runtimeCalls += 1;
    throw new Error('A lexical-only request must not invoke a model runtime.');
  } });
  return { root, store, rag, runtimeCalls: () => runtimeCalls };
}

async function append(store, { recordId, lineage = lineageId, text, minute, status = 'active', scope = 'bm25' }) {
  await store.append({ id: recordId, lineageId: lineage, agentId: 'agent-one',
    createdAt: `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`, text,
    contextScope: { projectId: scope }, status });
}

function scoreMap(records, scores) {
  return new Map(records.map(record => [record.text, scores.get(record.id)?.score]));
}

test('BM25 uses term frequency and document length while returning deterministic bounded scores', async () => {
  const env = await setup();
  const repeated = id('1');
  const longSingle = id('2');
  const shortSingle = id('3');
  const filler = id('4');
  try {
    await append(env.store, { recordId: repeated, minute: 0, text: 'quartz quartz quartz filler filler filler filler filler filler filler' });
    await append(env.store, { recordId: longSingle, minute: 1, text: 'quartz filler filler filler filler filler filler filler filler filler' });
    await append(env.store, { recordId: shortSingle, minute: 2, text: 'quartz' });
    await append(env.store, { recordId: filler, minute: 3, text: 'filler filler filler filler filler filler filler filler filler filler' });
    const candidates = await env.store.listContext({ lineageId, projectId: 'bm25' });
    const first = await env.rag.scoreCandidates({ lineageId, query: 'quartz', records: candidates });
    const second = await env.rag.scoreCandidates({ lineageId, query: 'quartz', records: candidates });
    const scores = scoreMap(candidates, first);

    assert.ok(scores.get(candidates.find(record => record.id === repeated).text) > scores.get(candidates.find(record => record.id === longSingle).text),
      'repeated query terms in a document increase BM25 term-frequency weight');
    assert.ok(scores.get('quartz') > scores.get(candidates.find(record => record.id === longSingle).text),
      'a short matching document outranks a longer document with one occurrence');
    assert.ok([...first.values()].every(match => match.method === 'lexical-fallback' && match.score >= 0 && match.score <= 1));
    assert.deepEqual([...first], [...second], 'ranking and normalized scores are deterministic');
    assert.equal(first.get(filler).score, 0);
    const fallback = await env.rag.semanticSearch({ lineageId, query: 'quartz', limit: 5 });
    assert.deepEqual(fallback.map(record => record.id), [shortSingle, repeated, longSingle],
      'canonical fallback uses the same BM25 ordering as scoped candidate scoring');
    assert.equal(fallback[0].bm25Score, 1);
    assert.ok(fallback[1].bm25Score < 1 && fallback[1].bm25Score > fallback[2].bm25Score);
    assert.equal(env.runtimeCalls(), 0, 'an empty vector index takes the pure local lexical path');
  } finally { await env.rag.close(); await rm(env.root, { recursive: true, force: true }); }
});

test('BM25 document frequency gives a rare matched term more weight than a common matched term', async () => {
  const env = await setup();
  const rareHit = id('5');
  const commonHit = id('6');
  const commonTwo = id('7');
  const commonThree = id('8');
  const unrelatedVocabulary = Array.from({ length: 256 }, (_, index) => `noise${index}`).join(' ');
  try {
    await append(env.store, { recordId: rareHit, minute: 0, text: `xylophonic filler ${unrelatedVocabulary}` });
    await append(env.store, { recordId: commonHit, minute: 1, text: `familiar filler ${unrelatedVocabulary}` });
    await append(env.store, { recordId: commonTwo, minute: 2, text: `familiar filler ${unrelatedVocabulary}` });
    await append(env.store, { recordId: commonThree, minute: 3, text: `familiar filler ${unrelatedVocabulary}` });
    const candidates = await env.store.listContext({ lineageId, projectId: 'bm25' });
    const scores = await env.rag.scoreCandidates({ lineageId, query: 'xylophonic familiar', records: candidates });

    assert.ok(scores.get(rareHit).score > scores.get(commonHit).score,
      'with equal document lengths and one query-term match, lower document frequency ranks higher');
    assert.equal(scores.get(rareHit).score, 1);
    assert.ok(scores.get(commonHit).score > 0 && scores.get(commonHit).score < 1);

    // Document-frequency statistics must be computed only from records the caller
    // already authorized for this project scope. Same-lineage records elsewhere
    // cannot change the scoped candidates' scores.
    const beforeOutOfScope = new Map([rareHit, commonHit, commonTwo, commonThree].map(recordId => [
      recordId, scores.get(recordId).score
    ]));
    const unrelatedScopes = ['d', 'e', 'f', '0', '1', '2', '3', '4', '9', 'a', 'b', 'c'];
    for (let index = 0; index < unrelatedScopes.length; index += 1) {
      await append(env.store, { recordId: id(unrelatedScopes[index]), minute: index + 10,
        text: `xylophonic outside scope ${index}`, scope: 'another-project' });
    }
    const stillScoped = await env.store.listContext({ lineageId, projectId: 'bm25' });
    const afterOutOfScope = await env.rag.scoreCandidates({ lineageId, query: 'xylophonic familiar', records: stillScoped });
    assert.deepEqual(new Map([rareHit, commonHit, commonTwo, commonThree].map(recordId => [
      recordId, afterOutOfScope.get(recordId).score
    ])), beforeOutOfScope, 'cross-scope documents do not leak into document-frequency statistics');
    assert.equal(env.runtimeCalls(), 0);
  } finally { await env.rag.close(); await rm(env.root, { recursive: true, force: true }); }
});

test('stale candidate vectors fall back to BM25 over the current scoped records', async () => {
  const env = await setup();
  const ids = [id('c'), id('d'), id('e'), id('f')];
  const indexRuntime = async () => ({
    embedDocuments: async texts => texts.map(() => Float32Array.of(1, 0)),
    embedQueries: async () => [Float32Array.of(1, 0)],
    dispose: async () => {}
  });
  const indexer = new LocalMemoryRag({ root: path.join(env.root, 'index'), store: env.store, runtimeFactory: indexRuntime });
  let lexicalRuntimeCalls = 0;
  const searching = new LocalMemoryRag({ root: path.join(env.root, 'index'), store: env.store, runtimeFactory: async () => {
    lexicalRuntimeCalls += 1;
    throw new Error('No semantic runtime is available; BM25 should cover stale vectors.');
  } });
  try {
    const initial = ['Old note one.', 'Old note two.', 'Old note three.', 'Old note four.'];
    for (let index = 0; index < ids.length; index += 1) await append(env.store, { recordId: ids[index], minute: index, text: initial[index], scope: 'stale-bm25' });
    await indexer.indexRange({ lineageId, from: '2026-10-01', to: '2026-10-01' });
    await indexer.close();
    const updated = ['xylophonic filler', 'familiar filler', 'familiar filler', 'familiar filler'];
    for (let index = 0; index < ids.length; index += 1) await env.store.appendRevision({ lineageId, id: ids[index], expectedRevision: 0,
      createdAt: `2026-10-01T11:${String(index).padStart(2, '0')}:00.000Z`, by: 'owner:test', why: 'Corrected current text', changes: { text: updated[index] } });
    const candidates = await env.store.listContext({ lineageId, projectId: 'stale-bm25' });
    const scores = await searching.scoreCandidates({ lineageId, query: 'xylophonic familiar', records: candidates });

    assert.equal(scores.get(ids[0]).method, 'lexical-fallback');
    assert.equal(scores.get(ids[0]).score, 1);
    assert.ok(scores.get(ids[1]).score > 0 && scores.get(ids[1]).score < scores.get(ids[0]).score);
    assert.equal(scores.get(ids[2]).score, scores.get(ids[1]).score);
    assert.equal(lexicalRuntimeCalls, 1, 'the unavailable local semantic path fails before pure BM25 fallback is returned');
  } finally {
    await searching.close();
    await indexer.close();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('Unicode normalization, zero-token queries, lineage, and rejected-standing filters survive canonical fallback', async () => {
  const env = await setup();
  const current = id('9');
  const rejected = id('a');
  const foreign = id('b');
  try {
    await append(env.store, { recordId: current, minute: 0, text: 'Cafe\u0301 owners prefer local copies.' });
    await append(env.store, { recordId: rejected, minute: 1, text: 'Café owners prefer remote copies.' });
    await env.store.appendRevision({ lineageId, id: rejected, expectedRevision: 0,
      createdAt: '2026-10-01T11:00:00.000Z', by: 'owner:test', why: 'Rejected for this agent', changes: { status: 'rejected' } });
    await append(env.store, { recordId: foreign, lineage: otherLineageId, minute: 2, text: 'Café belongs to another lineage.' });

    const matches = await env.rag.semanticSearch({ lineageId, query: 'ＣＡＦÉ', limit: 5 });
    assert.deepEqual(matches.map(match => match.id), [current]);
    assert.equal(matches[0].matchMethod, 'lexical-fallback');
    assert.equal(matches[0].bm25Score, 1);
    assert.deepEqual(await env.rag.semanticSearch({ lineageId, query: '!!!', limit: 5 }), []);
    const punctuation = await env.rag.scoreCandidates({ lineageId, query: '!!!', records: await env.store.listContext({ lineageId, projectId: 'bm25' }) });
    assert.ok([...punctuation.values()].every(match => match.score === 0 && match.method === 'lexical-fallback'));
    assert.equal(env.runtimeCalls(), 0, 'Unicode and zero-token lexical fallbacks do not load a model runtime');
  } finally { await env.rag.close(); await rm(env.root, { recursive: true, force: true }); }
});

test('a rejected indexed duplicate cannot reappear beside its current canonical match', async () => {
  const env = await setup();
  const active = id('d');
  const rejected = id('e');
  const indexingRuntime = async () => ({
    embedDocuments: async texts => texts.map(() => Float32Array.of(1, 0)),
    embedQueries: async () => [Float32Array.of(1, 0)],
    dispose: async () => {}
  });
  const indexer = new LocalMemoryRag({ root: path.join(env.root, 'index'), store: env.store, runtimeFactory: indexingRuntime });
  try {
    const text = 'Owner prefers the same xylophonic reference.';
    await append(env.store, { recordId: active, minute: 0, text });
    await append(env.store, { recordId: rejected, minute: 1, text });
    await indexer.indexRange({ lineageId, from: '2026-10-01', to: '2026-10-01' });
    await env.store.appendRevision({ lineageId, id: rejected, expectedRevision: 0,
      createdAt: '2026-10-01T11:00:00.000Z', by: 'owner:test', why: 'Rejected duplicate', changes: { status: 'rejected' } });
    await indexer.close();

    const matches = await env.rag.semanticSearch({ lineageId, query: 'xylophonic', limit: 5 });
    assert.deepEqual(matches.map(record => record.id), [active],
      'current hydration excludes the rejected indexed duplicate and returns one canonical fact');
    assert.equal(matches[0].text, text);
    assert.equal(env.runtimeCalls(), 1, 'the stale index was opened, then the unavailable local model used canonical fallback');
  } finally {
    await env.rag.close();
    await indexer.close();
    await rm(env.root, { recursive: true, force: true });
  }
});
