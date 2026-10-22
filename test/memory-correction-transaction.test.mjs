import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { commitMemoryCorrection } from '../lib/memory-correction-service.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'agent-correction-qa';
const scope = { projectId: 'correction-qa' };
const authority = { agentId, lineageId, author: { kind: 'owner', id: 'owner-qa' } };
const at = '2026-10-02T12:00:00.000Z';
const later = '2026-10-03T12:01:00.000Z';

async function fixture(t, beforeCleanup = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-correction-atomic-'));
  t.after(async () => { await beforeCleanup(); await rm(root, { recursive: true, force: true }); });
  const store = new DatedMemoryStore({ root });
  const saved = await store.append({ lineageId, agentId, createdAt: at,
    text: 'Old greenhouse entrance: ' + '東門 '.repeat(900), contextScope: scope });
  const request = { lineageId, id: saved.entry.id, expectedRevision: 0, createdAt: later,
    changes: { text: 'Correct greenhouse entrance: ' + '西門 '.repeat(900) },
    source: { kind: 'owner-feedback', text: 'The retained owner inspection states the entrance changed.' },
    by: 'owner:owner-qa', why: 'The owner corrected the entrance.',
    expectedNextBehavior: 'Check the current entrance before answering.' };
  return { root, store, request };
}

test('canonical correction and bounded mistake commit together and preserve the full original', async t => {
  const { root, store, request } = await fixture(t);
  const receipt = await commitMemoryCorrection({ store, request, authority, assertAuthorized() {} });
  assert.match(receipt.mistakeId, /^mistake-/);
  assert.equal(receipt.committedDate, '2026-10-03', 'indexing uses the actual correction log date');
  const restored = new DatedMemoryStore({ root });
  const current = await restored.getById({ lineageId, id: request.id, depth: 2 });
  const mistakes = await restored.listMemoryMistakes({ lineageId, agentId, contextScope: scope });
  assert.equal(current.revision, 1);
  assert.equal(current.text, request.changes.text);
  assert.ok(current.revisions[0].previous.text.length > 2048);
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].status, 'historical');
  assert.equal(mistakes[0].importance, 1);
  const record = mistakes[0].metadata.memoryMistake.record;
  assert.ok(Buffer.byteLength(record.whatWentWrong, 'utf8') <= 2048);
  assert.ok(Buffer.byteLength(record.correction, 'utf8') <= 2048);
  assert.match(record.whatWentWrong, /excerpt limited/);
  assert.doesNotMatch(record.whatWentWrong, /\uFFFD/);
  const retried = await commitMemoryCorrection({ store: restored, request: { ...request, createdAt: '2026-10-04T12:00:00.000Z' },
    authority: { ...authority, author: { kind: 'owner', id: 'owner-new-session' } }, assertAuthorized() {} });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.revisionId, receipt.revisionId);
  assert.equal(retried.mistakeId, receipt.mistakeId);
  assert.equal((await restored.listMemoryMistakes({ lineageId, agentId, contextScope: scope })).length, 1);
  for (const depth of [0, 1]) {
    const shallow = await restored.getById({ lineageId, id: mistakes[0].id, depth });
    assert.equal(shallow.metadata.memoryMistake.record.evidence.excerpt, undefined,
      'nested canonical metadata cannot bypass the requested source-evidence depth');
  }
});

test('authority revoked after preparation withholds both correction and mistake at the atomic write', async t => {
  const { store, request } = await fixture(t);
  let allowed = true;
  const append = store.appendCorrection.bind(store);
  store.appendCorrection = async options => {
    allowed = false;
    return append(options);
  };
  await assert.rejects(commitMemoryCorrection({ store, request, authority,
    assertAuthorized() { if (!allowed) throw new Error('Authority revoked before durable rename.'); } }), /Authority revoked/);
  const current = await store.getById({ lineageId, id: request.id, depth: 2 });
  assert.equal(current.revision, 0);
  assert.equal(current.revisions.length, 0);
  assert.equal((await store.listMemoryMistakes({ lineageId, agentId, contextScope: scope })).length, 0);
});

test('queued source mutations invalidate a read dependency before the atomic correction write', async t => {
  const { store, request } = await fixture(t);
  const sourceLineage = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const source = await store.append({ lineageId: sourceLineage, agentId: 'source-agent', createdAt: at,
    text: 'Synthetic prior source.', contextScope: scope });
  const pinned = store.getMutationState({ lineageId: sourceLineage });
  assert.deepEqual(pinned, { version: 1, pending: 0 });
  const append = store.appendCorrection.bind(store);
  let sourceMutation;
  store.appendCorrection = async options => {
    sourceMutation = store.appendRevision({ lineageId: sourceLineage, id: source.entry.id,
      expectedRevision: 0, createdAt: later, by: 'owner:owner-qa', why: 'Source was rejected during target preparation.',
      changes: { status: 'rejected' } });
    assert.equal(store.getMutationState({ lineageId: sourceLineage }).pending, 1,
      'dependency changes are visible immediately when queued, before async execution');
    return append(options);
  };
  await assert.rejects(commitMemoryCorrection({ store, request, authority, assertAuthorized() {
    const state = store.getMutationState({ lineageId: sourceLineage });
    if (state.version !== pinned.version || state.pending) throw new Error('Source dependency changed.');
  } }), /Source dependency changed/);
  await sourceMutation;
  assert.deepEqual(store.getMutationState({ lineageId: sourceLineage }), { version: 2, pending: 0 });
  assert.equal((await store.getById({ lineageId, id: request.id, depth: 2 })).revision, 0);
  assert.equal((await store.listMemoryMistakes({ lineageId, agentId, contextScope: scope })).length, 0);
});

test('replay cannot omit an optional validity change from the original correction', async t => {
  const { store, request } = await fixture(t);
  const original = { ...request, changes: { ...request.changes, valid_while: 'The entrance remains open.' } };
  const receipt = await commitMemoryCorrection({ store, request: original, authority, assertAuthorized() {} });
  await assert.rejects(commitMemoryCorrection({ store, request, authority, assertAuthorized() {} }), /revision conflict/);
  const retry = await commitMemoryCorrection({ store, request: original, authority, assertAuthorized() {} });
  assert.equal(retry.revisionId, receipt.revisionId);
  assert.equal(retry.duplicate, true);
});

test('concurrent same-revision corrections cannot duplicate either canonical record', async t => {
  const { store, request } = await fixture(t);
  const results = await Promise.allSettled([0, 1].map(() => commitMemoryCorrection({
    store, request, authority, assertAuthorized() {} })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal((await store.getById({ lineageId, id: request.id, depth: 2 })).revision, 1);
  assert.equal((await store.listMemoryMistakes({ lineageId, agentId, contextScope: scope })).length, 1);
});

test('a legacy correction without a canonical mistake receipt cannot acquire one by retry', async t => {
  const { store, request } = await fixture(t);
  await store.appendCorrection(request);
  await assert.rejects(commitMemoryCorrection({ store, request, authority, assertAuthorized() {} }), /no matching canonical mistake receipt/);
  assert.equal((await store.getById({ lineageId, id: request.id, depth: 2 })).revision, 1);
  assert.equal((await store.listMemoryMistakes({ lineageId, agentId, contextScope: scope })).length, 0);
});

test('future warnings share one relevance query, include project-wide context and omit unrelated or rejected records', async t => {
  let rag;
  const { root, store, request } = await fixture(t, () => rag?.close());
  await commitMemoryCorrection({ store, request, authority, assertAuthorized() {} });
  rag = new LocalMemoryRag({ root: path.join(root, 'index'), store });
  let queries = 0;
  const score = rag.scoreCandidates.bind(rag);
  rag.scoreCandidates = async options => { queries++; return score(options); };
  const options = { store, rag, lineageId, scope: { projectId: scope.projectId, topicId: 'entrances' },
    latestMessage: 'Which greenhouse entrance is current?' };
  const context = await buildMemoryTurnContext(options);
  assert.equal(queries, 1, 'facts and warnings do not independently embed the same query');
  assert.equal(context.mistakeCount, 1);
  assert.match(context.text, /Old greenhouse entrance/);
  assert.match(context.text, /contentExcerpt/);
  assert.doesNotMatch(context.text, /retained owner inspection/);
  const warningSection = context.text.slice(context.text.indexOf('[RELEVANT PAST MISTAKES'), context.text.indexOf('[[END HEXIGRID MEMORY DATA]]'));
  assert.ok(Buffer.byteLength(warningSection.trim(), 'utf8') <= 4096);
  const unrelated = await buildMemoryTurnContext({ ...options, latestMessage: 'Unrelated quartz spacecraft' });
  assert.doesNotMatch(unrelated.text, /Old greenhouse entrance/);
  const mistake = (await store.listMemoryMistakes({ lineageId, agentId, contextScope: scope }))[0];
  await store.appendRevision({ lineageId, id: mistake.id, expectedRevision: 0, createdAt: '2026-10-04T12:00:00.000Z',
    by: 'owner:owner-qa', why: 'Owner rejected the retained warning.', changes: { status: 'rejected' } });
  const rejected = await buildMemoryTurnContext(options);
  assert.doesNotMatch(rejected.text, /Old greenhouse entrance/);
});
