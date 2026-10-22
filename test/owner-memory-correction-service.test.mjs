import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createOwnerMemory, normalizeOwnerMemory, reviseOwnerMemory } from '../lib/owner-memory.mjs';
import { captureOwnerMemoryCorrection, normalizeOwnerMemoryCaptureIntent,
  prepareOwnerMemoryCorrection } from '../lib/owner-memory-correction-service.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'agent-owner-note-qa';
const source = Object.freeze({ kind: 'agent-link-message', id: 'link-message-00000001',
  linkId: 'link-0000000000000001',
  text: 'I relied on the old ledger and gave the wrong date to the owner.',
  createdAt: '2026-10-02T10:30:00.000Z' });
const authority = Object.freeze({ agentId, lineageId, author: Object.freeze({ kind: 'agent', id: 'link-0000000000000001' }) });
const request = Object.freeze({ expectedRevision: 0,
  text: 'Check the current ledger date before answering.',
  why: 'The signed answer used an older ledger.',
  expectedNextBehavior: 'Compare the ledger date on the next answer.',
  source, createdAt: '2026-10-02T11:00:00.000Z' });

function makeNote() {
  return createOwnerMemory({ content: 'Use the earlier ledger without checking its date.', category: 'Process' },
    { agentId, source: 'owner', at: '2026-10-01T10:00:00.000Z' });
}

function allow() { return { allowed: true }; }

function prepare(current = makeNote(), correction = request, selectedAuthority = authority) {
  return prepareOwnerMemoryCorrection({ current, request: correction, authority: selectedAuthority, assertAuthorized: allow });
}

test('owner-note preparation preserves signed evidence in append-only history and capture is idempotent in the canonical dated store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-owner-note-correction-'));
  try {
    const store = new DatedMemoryStore({ root });
    const original = makeNote();
    const prepared = prepare(original);

    assert.equal(original.revisions.length, 0, 'preparation does not mutate the saved owner note');
    assert.equal(prepared.revisedNote.content, request.text);
    assert.equal(prepared.revisedNote.revisions.length, 1);
    assert.equal(prepared.revisedNote.revisions[0].changes.content.from, original.content);
    assert.equal(prepared.revisedNote.revisions[0].changes.content.to, request.text);
    assert.deepEqual(prepared.revisedNote.revisions[0].source, source);
    assert.equal(prepared.revisedNote.revisions[0].expectedNextBehavior, request.expectedNextBehavior);
    assert.doesNotThrow(() => normalizeOwnerMemory(prepared.revisedNote), 'the append-only owner-note hash chain validates');
    assert.match(prepared.revisedNote.revisions[0].audit.hash, /^[a-f0-9]{64}$/);
    assert.equal(prepared.captureIntent.previous.author, 'owner');
    assert.equal(prepared.captureIntent.previous.at, original.createdAt);
    assert.equal(prepared.captureIntent.source.text, source.text);
    assert.equal(prepared.captureIntent.source.createdAt, source.createdAt);
    assert.equal(prepared.captureIntent.revisionAt, request.createdAt);
    assert.deepEqual(normalizeOwnerMemoryCaptureIntent(prepared.captureIntent), prepared.captureIntent);
    const tampered = { ...prepared.revisedNote, revisions: [{ ...prepared.revisedNote.revisions[0],
      audit: { ...prepared.revisedNote.revisions[0].audit, hash: '0'.repeat(64) } }] };
    assert.throws(() => normalizeOwnerMemory(tampered), /audit chain is broken/i);

    const exactRetry = prepareOwnerMemoryCorrection({ current: prepared.revisedNote,
      request: { ...request, captureIntent: prepared.captureIntent }, authority, assertAuthorized: allow });
    assert.equal(exactRetry.duplicate, true);
    assert.equal(exactRetry.revisedNote.revisions.length, 1, 'an exact retry does not append another owner-note revision');

    const first = await captureOwnerMemoryCorrection({ store, currentNote: prepared.revisedNote,
      intent: prepared.captureIntent, assertAuthorized: allow });
    const restartedStore = new DatedMemoryStore({ root });
    const retry = await captureOwnerMemoryCorrection({ store: restartedStore, currentNote: prepared.revisedNote,
      intent: prepared.captureIntent, assertAuthorized: allow });
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.id, first.id);
    assert.equal(first.record.id, first.id);
    assert.equal(first.record.author.kind, 'agent');
    assert.equal(first.record.author.id, authority.author.id);
    assert.deepEqual(first.record.contextScope, { projectId: 'owner-notes', topicId: agentId });
    assert.equal(first.entry.status, 'historical');
    assert.equal(first.entry.importance, 1);
    assert.equal(first.entry.evidence_excerpt, source.text);
    assert.equal(first.record.evidence.excerpt, source.text);
    assert.equal(first.record.evidence.observedAt, source.createdAt);
    assert.equal(first.record.whatWentWrong, original.content);
    assert.equal(first.record.correction, request.text);
    assert.equal(first.record.resultingFix, request.expectedNextBehavior);

    const entries = await restartedStore.listMemoryMistakes({ lineageId, agentId,
      contextScope: { projectId: 'owner-notes', topicId: agentId }, limit: 10, depth: 2 });
    assert.equal(entries.length, 1, 'both capture attempts converge on one canonical mistake record');
    assert.equal(entries[0].id, first.entry.id);
    assert.equal(entries[0].metadata.memoryMistake.record.id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owner-note capture refuses a changed correction/source, stale later note revision, and legacy history without an explicit intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-owner-note-correction-conflict-'));
  try {
    const store = new DatedMemoryStore({ root });
    const prepared = prepare();
    const intentRequest = { ...request, captureIntent: prepared.captureIntent };

    assert.throws(() => prepareOwnerMemoryCorrection({ current: prepared.revisedNote,
      request: { ...intentRequest, why: 'Different reason.' }, authority, assertAuthorized: allow }),
    error => error.code === 'owner_memory_correction_intent_mismatch');
    assert.throws(() => prepareOwnerMemoryCorrection({ current: prepared.revisedNote,
      request: { ...intentRequest, source: { ...source, text: 'A different signed message.' } }, authority, assertAuthorized: allow }),
    error => error.code === 'owner_memory_correction_intent_mismatch');

    const later = reviseOwnerMemory(prepared.revisedNote, { content: 'A later owner-note revision.' },
      { by: 'owner:owner-qa', why: 'Owner made a later edit.', at: '2026-10-02T12:00:00.000Z' });
    await assert.rejects(captureOwnerMemoryCorrection({ store, currentNote: later,
      intent: prepared.captureIntent, assertAuthorized: allow }),
    error => error.code === 'owner_memory_correction_stale');

    const legacy = reviseOwnerMemory(makeNote(), { content: request.text }, {
      by: 'agent-link:link-0000000000000001', why: request.why,
      at: request.createdAt, source, expectedNextBehavior: request.expectedNextBehavior
    });
    assert.throws(() => prepareOwnerMemoryCorrection({ current: legacy, request, authority, assertAuthorized: allow }),
      error => error.code === 'owner_memory_correction_stale',
    'a matching old revision is not backfilled unless its exact intent was saved with it');
    assert.deepEqual(await store.listMemoryMistakes({ lineageId, agentId,
      contextScope: { projectId: 'owner-notes', topicId: agentId }, limit: 10 }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revocation at the dated store durable-write guard leaves no canonical receipt or source excerpt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-owner-note-correction-revoked-'));
  try {
    const store = new DatedMemoryStore({ root });
    const prepared = prepare();
    let durableChecks = 0;
    const revokeAtFinalWrite = context => {
      if (context.phase === 'commit-immediate' && ++durableChecks === 3) {
        throw Object.assign(new Error('Link authorization was revoked before rename.'), { status: 403 });
      }
      return { allowed: true };
    };

    await assert.rejects(captureOwnerMemoryCorrection({ store, currentNote: prepared.revisedNote,
      intent: prepared.captureIntent, assertAuthorized: revokeAtFinalWrite }), /revoked before rename/);
    assert.equal(durableChecks, 3, 'the final durable-write guard ran after append preparation');
    const entries = await store.listMemoryMistakes({ lineageId, agentId,
      contextScope: { projectId: 'owner-notes', topicId: agentId }, limit: 10, depth: 2 });
    assert.deepEqual(entries, [], 'the failed final guard preserves neither the receipt nor its signed evidence excerpt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
