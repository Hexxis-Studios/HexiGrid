import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncryptedStateStore, createStateSaveQueue } from '../lib/local-state.mjs';
import { createOwnerMemory, confirmOwnerMemory, normalizeOwnerMemory, reviseOwnerMemory } from '../lib/owner-memory.mjs';
import { assertOwnerMemoryRetirementIdle, commitOwnerMemoryRetirement, prepareOwnerMemoryRetirement,
  validateOwnerNoteRetirementRequest, prepareOwnerMemoryRestoration } from '../lib/owner-memory-retirement-service.mjs';

const at = '2026-10-04T12:00:00.000Z';
const agentId = 'agent-retirement-test';
const by = 'agent-link:link-retirement-test';
const why = 'PRIVATE-RETIRE-REASON: the note no longer applies.';
function fixture() {
  const note = createOwnerMemory({ content: 'PRIVATE-RETIRE-NOTE: temporary route.', valid_while: 'Until the project ends.',
    evidence_excerpt: 'PRIVATE-RETIRE-EVIDENCE', category: 'Process' }, { agentId, at });
  const other = createOwnerMemory({ content: 'Unrelated note.' }, { agentId: 'another-agent', at });
  const state = { memories: [note, other], receipts: [{ id: 'receipt-before' }] };
  return { state, note, other, request: { state, id: note.id, agentId, expectedRevision: 0, by, why, at,
    currentOnly: true, authorize: () => true } };
}
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('restoration keeps the retained condition and cannot resurrect disputed/rejected/superseded notes', () => {
  const { note } = fixture();
  const historical = prepareOwnerMemoryRetirement(note, { expectedRevision: 0, by, why, at }).memory;
  const args = { expectedRevision: 1, by, why: 'Condition applies again.', at, status: 'conditional' };
  const restored = prepareOwnerMemoryRestoration(historical, args).memory;
  assert.equal(restored.status, 'conditional'); assert.equal(restored.valid_while, note.valid_while);
  assert.equal(restored.verification, 'unverified'); assert.deepEqual(restored.revisions[0], historical.revisions[0]);
  assert.equal(prepareOwnerMemoryRestoration(restored, args).duplicate, true);
  for (const status of ['active', 'conditional', 'disputed', 'rejected', 'superseded']) {
    const other = createOwnerMemory({ content: 'Other standing.', status, valid_while: 'Until QA ends.' }, { agentId, at });
    assert.throws(() => prepareOwnerMemoryRestoration(other, { ...args, expectedRevision: 0 }), /Only a historical/);
  }
});

test('retirement reuses audited standing revisions and exact retries preserve history', () => {
  const { note } = fixture();
  const confirmed = confirmOwnerMemory(note, { expectedRevision: 0, by: 'owner:test', why: 'Checked source.', at });
  const result = prepareOwnerMemoryRetirement(confirmed, { expectedRevision: 1, by, why, at, currentOnly: true });
  assert.equal(result.memory.status, 'historical');
  assert.equal(result.memory.verification, 'unverified');
  assert.equal(result.memory.content, confirmed.content);
  assert.equal(result.memory.evidence_excerpt, confirmed.evidence_excerpt);
  assert.equal(result.memory.valid_while, confirmed.valid_while);
  assert.deepEqual(result.memory.revisions[0], confirmed.revisions[0]);
  assert.equal(result.memory.revisions.length, 2);
  assert.equal(result.memory.revisions[1].by, by);
  assert.doesNotThrow(() => normalizeOwnerMemory(result.memory));
  assert.equal(prepareOwnerMemoryRetirement(result.memory, { expectedRevision: 1, by, why, at, currentOnly: true }).duplicate, true);
  assert.throws(() => prepareOwnerMemoryRetirement(result.memory, { expectedRevision: 1, by: 'agent-link:another', why, at, currentOnly: true }), /revision conflict/);
  assert.throws(() => prepareOwnerMemoryRetirement(result.memory, { expectedRevision: 1, by, why: 'Different reason', at, currentOnly: true }), /revision conflict/);
  assert.equal(prepareOwnerMemoryRetirement(result.memory, { expectedRevision: 2, by: 'owner', why, at }).duplicate, true,
    'existing owner DELETE remains idempotent with the current revision');
});

test('signed retirement rejects unsupported fields, forged standing, invalid revisions and unbounded reasons', () => {
  const { note } = fixture();
  const input = { id: note.id, expectedRevision: 0, why };
  for (const invalid of [null, [], { ...input, approved: true }, { ...input, status: 'active' },
    { ...input, agentId }, { ...input, verification: 'owner-confirmed' }, { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: 0.5 }, { ...input, why: ' ' }, { ...input, why: 'x'.repeat(501) },
    { ...input, why: 'api_key=synthetic-private-credential123' }]) {
    assert.throws(() => validateOwnerNoteRetirementRequest(invalid), { status: 400 });
  }
});

test('failed private retirement publication preserves concurrent notes and a full receipt list, then retry commits once', async () => {
  const { state, note, other, request } = fixture();
  state.receipts = Array.from({ length: 10000 }, (_, i) => ({ id: `old-receipt-${i}` }));
  const beforeReceipts = [...state.receipts];
  let disk = structuredClone(state);
  let failWrite = true;
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(snapshot, { assertAuthorized }) {
    assertAuthorized();
    if (failWrite) {
      state.memories.push(createOwnerMemory({ content: 'Concurrent added note.' }, { agentId, at }));
      state.receipts.push({ id: 'concurrent-receipt' });
      throw Error('Synthetic write failure');
    }
    disk = structuredClone(snapshot);
  } } });
  await assert.rejects(commitOwnerMemoryRetirement({ ...request, saveState }), { status: 503 });
  assert.equal(state.memories[0], note); assert.equal(state.memories[1], other);
  assert.equal(state.memories.length, 3);
  assert.deepEqual(state.receipts, [...beforeReceipts, { id: 'concurrent-receipt' }]);
  assert.equal(disk.memories[0].status, 'active');
  failWrite = false;
  const result = await commitOwnerMemoryRetirement({ ...request, saveState });
  assert.equal(result.memory.revisions.length, 1);
  assert.equal(disk.memories[0].status, 'historical');
  assert.equal(state.memories[1], other);
  const duplicate = await commitOwnerMemoryRetirement({ ...request, saveState });
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.memories[0].revisions.length, 1);
});

test('rate-limited retirement has no effect, while an exact idempotent retry skips the write gate', async () => {
  const { state, note, request } = fixture();
  let gateChecks = 0;
  await assert.rejects(commitOwnerMemoryRetirement({ ...request, beforeCommit() {
    gateChecks += 1;
    return { allowed: false, status: 429, code: 'MEMORY_WRITE_RATE_LIMIT' };
  }, saveState() { throw Error('A denied retirement must not publish state.'); } }), error =>
    error.status === 429 && error.code === 'MEMORY_WRITE_RATE_LIMIT');
  assert.equal(gateChecks, 1);
  assert.equal(state.memories[0], note);
  assert.deepEqual(state.receipts, [{ id: 'receipt-before' }]);

  let disk;
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(snapshot) { disk = structuredClone(snapshot); } } });
  const committed = await commitOwnerMemoryRetirement({ ...request, saveState });
  assert.equal(committed.duplicate, false);
  const duplicate = await commitOwnerMemoryRetirement({ ...request, beforeCommit() {
    throw Error('An exact duplicate must not consume another write slot.');
  }, saveState });
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.memories[0].revisions.length, 1);
  assert.equal(disk.memories[0].status, 'historical');
});

test('authority is checked after a competing queued write; no tentative retirement enters that write', async () => {
  const { state, note, request } = fixture();
  const entered = gate(), release = gate(); let first = true, authorized = true, disk;
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(snapshot, { assertAuthorized }) {
    if (first) { first = false; entered.resolve(); await release.promise; }
    assertAuthorized(); disk = snapshot;
  } } });
  const initial = saveState(); await entered.promise;
  const retire = commitOwnerMemoryRetirement({ ...request, authorize() { if (!authorized) throw Object.assign(Error('Revoked'), { status: 403 }); }, saveState });
  const rejected = assert.rejects(retire, { status: 403 });
  state.receipts.push({ id: 'unrelated-queued-receipt' });
  const unrelated = saveState(); authorized = false;
  assert.equal(state.memories[0], note);
  release.resolve(); await initial; await rejected; await unrelated;
  assert.equal(disk.memories[0].status, 'active');
  assert.equal(disk.memories[0].revisions.length, 0);
  assert.deepEqual(disk.receipts.map(item => item.id), ['receipt-before', 'unrelated-queued-receipt']);
});

test('guarded encrypted vault wait cannot leak denied retirement into an unrelated queued save', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-retirement-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { state, note, request } = fixture();
  const entered = gate(), release = gate(); const key = crypto.randomBytes(32).toString('base64url');
  const store = new EncryptedStateStore(path.join(root, 'synthetic.state'), {
    isAvailable: () => true,
    async get() { entered.resolve(); await release.promise; return key; }, async set() { throw Error('Unexpected key creation'); }
  });
  let authorized = true;
  const saveState = createStateSaveQueue({ getState: () => state, store });
  const retire = commitOwnerMemoryRetirement({ ...request, authorize() { if (!authorized) throw Object.assign(Error('Vault-time revocation'), { status: 403 }); }, saveState });
  const rejected = assert.rejects(retire, { status: 403 });
  await entered.promise;
  assert.equal(state.memories[0], note);
  state.memories[1] = reviseOwnerMemory(state.memories[1], { content: 'Concurrent unrelated revision.' }, { why: 'Unrelated update.', at });
  state.receipts.push({ id: 'vault-concurrent-receipt' });
  const otherSave = saveState(); authorized = false; release.resolve();
  await rejected; await otherSave;
  const disk = await store.read();
  assert.equal(disk.memories[0].status, 'active'); assert.equal(disk.memories[0].revisions.length, 0);
  assert.equal(disk.memories[1].content, 'Concurrent unrelated revision.');
  assert.deepEqual(disk.receipts.map(item => item.id), ['receipt-before', 'vault-concurrent-receipt']);
  assert.doesNotMatch(await readFile(store.file, 'utf8'), /PRIVATE-RETIRE/);
  assert.equal((await readdir(root)).some(name => name.endsWith('.pending')), false);
});

test('successful private publication precedes later queued saves and blocks competing same-note writers', async () => {
  const { state, note, request } = fixture(); const entered = gate(), release = gate(); let first = true, disk;
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(snapshot, { assertAuthorized }) {
    if (first) { first = false; entered.resolve(); await release.promise; }
    assertAuthorized(); disk = structuredClone(snapshot);
  } } });
  const retire = commitOwnerMemoryRetirement({ ...request, saveState }); await entered.promise;
  assert.equal(state.memories[0], note);
  assert.throws(() => assertOwnerMemoryRetirementIdle(state, note.id), { status: 409 });
  assert.doesNotThrow(() => assertOwnerMemoryRetirementIdle(state, state.memories[1].id));
  await assert.rejects(commitOwnerMemoryRetirement({ ...request, saveState }), { status: 409 });
  state.receipts.push({ id: 'success-concurrent-receipt' });
  const otherSave = saveState(); release.resolve(); await retire; await otherSave;
  assert.equal(disk.memories[0].status, 'historical'); assert.equal(disk.memories[0].revisions.length, 1);
  assert.deepEqual(disk.receipts.map(item => item.action || item.id), ['memory:retire-owner-note', 'receipt-before', 'success-concurrent-receipt']);
  assert.doesNotThrow(() => assertOwnerMemoryRetirementIdle(state, note.id));
});

test('unexpected same-note replacement at publication is preserved and reported for refresh', async () => {
  const { state, note, request } = fixture(); let newer;
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(_snapshot, { assertAuthorized }) {
    assertAuthorized();
    // Simulate a writer that bypasses the supported per-note guard after the
    // final publication dispatch. The retirement must never overwrite it.
    newer = reviseOwnerMemory(note, { content: 'Newer concurrent wording.' }, { by: 'owner', why: 'Updated while publishing.', at });
    state.memories[0] = newer;
  } } });
  await assert.rejects(commitOwnerMemoryRetirement({ ...request, saveState }), error => error.status === 409 && /saved.*changed during publication/.test(error.message));
  assert.equal(state.memories[0], newer);
  assert.equal(state.receipts[0].action, 'memory:retire-owner-note');
});

test('asynchronous authorization cannot approve encrypted state publication', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-retirement-async-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedStateStore(path.join(root, 'state'), {});
  await assert.rejects(store.write({}, { assertAuthorized: async () => true }), /must be synchronous/);
  assert.deepEqual(await readdir(root), []);
});

test('retirement authorization fails closed on explicit denial or an asynchronous callback', async () => {
  for (const authorize of [() => false, () => ({ allowed: false }), async () => true]) {
    const { state, note, request } = fixture();
    await assert.rejects(commitOwnerMemoryRetirement({ ...request, authorize,
      saveState() { throw Error('Unauthorized persistence must not be called'); } }), /no longer authorized|must be synchronous/);
    assert.equal(state.memories[0], note); assert.deepEqual(state.receipts, [{ id: 'receipt-before' }]);
    assert.doesNotThrow(() => assertOwnerMemoryRetirementIdle(state, note.id));
  }
});

test('the final encrypted publication guard preserves the previous file and removes denied staging', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-retirement-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32).toString('base64url');
  const store = new EncryptedStateStore(path.join(root, 'state'), { async get() { return key; } });
  await store.write({ standing: 'original' });
  const previous = await readFile(store.file, 'utf8'); let checks = 0;
  await assert.rejects(store.write({ standing: 'unauthorized' }, { assertAuthorized() {
    if (++checks === 3) throw Object.assign(Error('Revoked before rename'), { status: 403 });
  } }), { status: 403 });
  assert.equal(checks, 3);
  assert.equal(await readFile(store.file, 'utf8'), previous);
  assert.deepEqual(await store.read(), { standing: 'original' });
  assert.equal((await readdir(root)).some(name => name.endsWith('.pending')), false);
});
