import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProposalService, memoryOriginKindFromTrustedProposalProvenance,
  memoryProposalServiceLimits } from '../lib/memory-proposal-service.mjs';
import { createOwnerMemory } from '../lib/owner-memory.mjs';
import { prepareOwnerMemoryCorrection } from '../lib/owner-memory-correction-service.mjs';
import { hasPendingOwnerMemoryCapture } from '../lib/memory-proposal-state.mjs';

const when = '2026-10-01T12:00:00.000Z';
const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const basePayload = Object.freeze({ text: 'Check the current source before answering.', status: 'active',
  valid_while: '', verify_by: null, evidence_excerpt: '', metadata: {}, contextScope: null });
const linkSource = Object.freeze({ kind: 'agent-link', callerId: 'link-qa', linkId: 'link-qa',
  agentId: 'agent-qa', lineageId });
const workerSource = Object.freeze({ kind: 'dreaming-worker', callerId: 'dreaming-worker:local',
  agentId: 'agent-qa', lineageId });

function fixture({ autoCommit = false, appendMemory, onSave, authorize, assertActive } = {}) {
  const state = { memoryProposals: [] };
  const saved = [];
  const appended = [];
  let saveCount = 0;
  const service = createMemoryProposalService({ state, now: () => when,
    saveState: async () => { saveCount += 1; await onSave?.(saveCount, state); saved.push(structuredClone(state.memoryProposals)); },
    appendMemory: async entry => { appended.push(structuredClone(entry)); return appendMemory ? appendMemory(entry, appended.length) : { entry: { date: '2026-10-01' }, date: '2026-10-01' }; },
    assertActive: assertActive || (async () => {}),
    authorize: authorize || (() => ({ allowed: true, autoCommit })) });
  return { service, state, saved, appended, get saveCount() { return saveCount; } };
}

function pendingOwnerMemoryCaptureProposal() {
  const current = createOwnerMemory({ content: 'Use the old ledger date without checking.', category: 'Process' },
    { agentId: 'agent-qa', source: 'owner', at: '2026-10-01T10:00:00.000Z' });
  const source = Object.freeze({ kind: 'agent-link-message', id: 'link-message-owner-capacity',
    linkId: 'link-owner-capacity', text: 'I used an old ledger date in the signed answer.',
    createdAt: '2026-10-02T10:30:00.000Z' });
  const prepared = prepareOwnerMemoryCorrection({ current,
    request: { expectedRevision: 0, text: 'Check the current ledger date before answering.',
      why: 'The signed answer used an older ledger.',
      expectedNextBehavior: 'Compare the current ledger date before answering.', source,
      createdAt: when },
    authority: { agentId: 'agent-qa', lineageId,
      author: { kind: 'agent', id: source.linkId } },
    assertAuthorized: () => ({ allowed: true }) });
  const intent = prepared.captureIntent;
  const proposal = { id: 'memory-proposal-owner-capture-retention', kind: 'owner-memory-correction',
    agentId: intent.agentId, lineageId: intent.lineageId, linkId: intent.source.linkId,
    status: 'approved', payload: { memoryId: intent.memoryId, expectedRevision: intent.expectedRevision,
      text: intent.correctedContent, why: intent.why,
      expectedNextBehavior: intent.expectedNextBehavior, source: intent.source },
    ownerNoteCaptureState: 'pending', ownerNoteCaptureIntent: intent };
  assert.equal(hasPendingOwnerMemoryCapture(proposal), true, 'the fixture retains an exact prepared capture intent');
  return proposal;
}

test('scoped signed Link saves one pending item and same-content retry returns its stable ID', async () => {
  const f = fixture({ autoCommit: false });
  const first = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  const second = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  assert.equal(first.committed, false);
  assert.equal(first.pendingOwnerReview, true);
  assert.equal(second.proposalId, first.proposalId);
  assert.equal(f.state.memoryProposals.length, 1);
  assert.equal(f.state.memoryProposals[0].provenance.linkId, linkSource.linkId);
  assert.equal(f.state.memoryProposals[0].commitState, 'awaiting-review');
  assert.equal(f.appended.length, 0);
  assert.ok(f.saved.length > 0, 'the pending review request is persisted before returning');
});

test('trusted owner commit is structurally withheld when the server marks reviewRequired', async () => {
  const f = fixture({ autoCommit: true });
  const result = await f.service.submitCreate({ payload: basePayload, source: linkSource, reviewRequired: true });
  assert.equal(result.committed, false);
  assert.equal(result.pendingOwnerReview, true);
  assert.equal(f.state.memoryProposals[0].reviewRequired, true);
  assert.equal(f.state.memoryProposals[0].commitState, 'owner-review-required');
  assert.equal(f.appended.length, 0);
});

test('automatic worker submissions require evidence and a stable idempotency key', async () => {
  const f = fixture({ autoCommit: true });
  await assert.rejects(f.service.submitCreate({ payload: basePayload, source: workerSource }), /idempotency key/i);
  await assert.rejects(f.service.submitCreate({ payload: { ...basePayload, evidence_excerpt: 'Exact source excerpt.' },
    source: workerSource }), /idempotency key/i);
  await assert.rejects(f.service.submitCreate({ payload: basePayload,
    source: workerSource, idempotencyKey: 'dreaming-batch-0001' }), /evidence excerpt/i);
  assert.equal(f.state.memoryProposals.length, 0);
  assert.equal(f.appended.length, 0);
});

test('durable origin follows host-retained proposal provenance, not the proposal payload', async () => {
  assert.equal(memoryOriginKindFromTrustedProposalProvenance({ kind: 'dreaming-worker' }), 'automatic-learning');
  assert.equal(memoryOriginKindFromTrustedProposalProvenance({ kind: 'agent-link' }), 'agent-proposal');
  assert.equal(memoryOriginKindFromTrustedProposalProvenance(null), 'agent-proposal');

  const worker = fixture({ autoCommit: true });
  const automatic = await worker.service.submitCreate({
    payload: { ...basePayload, evidence_excerpt: 'Exact source excerpt.' }, source: workerSource,
    idempotencyKey: 'dreaming-origin-0001'
  });
  assert.equal(automatic.committed, true);
  assert.equal(worker.state.memoryProposals[0].provenance.kind, 'dreaming-worker');
  assert.equal(worker.appended[0].originKind, 'automatic-learning');

  const deliberate = fixture({ autoCommit: true });
  await deliberate.service.submitCreate({ payload: basePayload, source: linkSource });
  assert.equal(deliberate.appended[0].originKind, 'agent-proposal');
  await assert.rejects(deliberate.service.submitCreate({
    payload: { ...basePayload, originKind: 'automatic-learning' }, source: linkSource
  }), /validated create schema/);
});

test('signed proposal commits forward canonical factual validity windows', async () => {
  const f = fixture({ autoCommit: true });
  const payload = { ...basePayload, valid_from: '2026-01-15T09:30:00.000Z',
    valid_until: '2026-07-15T09:30:00.000Z' };
  const result = await f.service.submitCreate({ payload, source: linkSource });

  assert.equal(result.committed, true);
  assert.equal(f.state.memoryProposals[0].payload.valid_from, payload.valid_from);
  assert.equal(f.state.memoryProposals[0].payload.valid_until, payload.valid_until);
  assert.equal(f.appended.length, 1);
  assert.equal(f.appended[0].valid_from, payload.valid_from);
  assert.equal(f.appended[0].valid_until, payload.valid_until);
});

test('proposal service rejects malformed or reversed factual validity windows before persistence', async () => {
  const f = fixture({ autoCommit: true });
  await assert.rejects(f.service.submitCreate({
    payload: { ...basePayload, valid_from: '2026-01-15T09:30:00Z' }, source: linkSource
  }), /valid_from must be a canonical UTC ISO timestamp/);
  await assert.rejects(f.service.submitCreate({
    payload: { ...basePayload, valid_from: '2026-07-15T09:30:00.000Z', valid_until: '2026-01-15T09:30:00.000Z' },
    source: linkSource
  }), /valid-time window must end after it starts/);
  assert.equal(f.state.memoryProposals.length, 0);
  assert.equal(f.appended.length, 0);
});

test('malformed or asynchronous authorizers cannot authorize even a pending queue write', async () => {
  for (const authorize of [() => ({}), () => Promise.resolve({ allowed: true, autoCommit: true })]) {
    const f = fixture({ authorize });
    await assert.rejects(f.service.submitCreate({ payload: basePayload, source: linkSource }),
      error => error.code === 'invalid_memory_authorization');
    assert.equal(f.state.memoryProposals.length, 0);
    assert.equal(f.saveCount, 0);
    assert.equal(f.appended.length, 0);
  }
});

test('rejected asynchronous authorizer is consumed without queue mutation or unhandled rejection', async () => {
  const marker = new Error('async authorization must not run');
  const unhandled = [];
  const listener = reason => { if (reason === marker) unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  const f = fixture({ authorize: () => Promise.reject(marker) });
  try {
    await assert.rejects(f.service.submitCreate({ payload: basePayload, source: linkSource }),
      error => error.code === 'invalid_memory_authorization');
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(f.state.memoryProposals.length, 0);
  assert.equal(f.saveCount, 0);
  assert.equal(f.appended.length, 0);
});

test('automatic retry reuses one proposal and memory ID after append failure', async () => {
  let attempts = 0;
  const f = fixture({ autoCommit: true, appendMemory: async entry => {
    attempts += 1;
    if (attempts === 1) throw new Error('Synthetic filesystem failure');
    return { entry: { date: '2026-10-01' }, date: '2026-10-01' };
  } });
  const request = { payload: { ...basePayload, evidence_excerpt: 'Exact source excerpt.' }, source: workerSource,
    idempotencyKey: 'dreaming-batch-0001' };
  const first = await f.service.submitCreate(request);
  const proposal = f.state.memoryProposals[0];
  assert.equal(first.retryable, true);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.commitState, 'retryable');
  assert.equal(proposal.commitAttempts, 1);
  assert.match(proposal.nextRetryAt, /^2026-10-01T12:00:05/);
  const stableProposalId = proposal.id;
  const stableMemoryId = proposal.payload.memoryId;
  const second = await f.service.submitCreate(request);
  assert.equal(second.committed, true);
  assert.equal(second.proposalId, stableProposalId);
  assert.equal(f.state.memoryProposals[0].payload.memoryId, stableMemoryId);
  assert.deepEqual(f.appended.map(entry => entry.id), [stableMemoryId, stableMemoryId]);
  assert.equal(f.state.memoryProposals[0].commitState, 'committed');
});

test('authorization is checked again after saving commit intent and before append', async () => {
  let allowed = true;
  const f = fixture({ autoCommit: true,
    authorize: () => ({ allowed: true, autoCommit: allowed }),
    onSave: async count => { if (count === 2) allowed = false; } });
  const result = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  assert.equal(result.committed, false);
  assert.equal(result.pendingOwnerReview, true);
  assert.equal(f.appended.length, 0, 'revocation during the durable intent write blocks canonical append');
  assert.equal(f.state.memoryProposals[0].status, 'pending');
  assert.equal(f.state.memoryProposals[0].lastCommitErrorCode, 'AUTHORIZATION_CHANGED');
});

test('idempotency key cannot be reused for another payload and pending queue remains bounded', async () => {
  const f = fixture({ autoCommit: false });
  const request = { payload: { ...basePayload, evidence_excerpt: 'Evidence.' }, source: workerSource,
    idempotencyKey: 'dreaming-batch-0002' };
  const first = await f.service.submitCreate(request);
  await assert.rejects(f.service.submitCreate({ ...request, payload: { ...request.payload, text: 'Different claim.' } }),
    error => error.status === 409 && error.code === 'idempotency_key_conflict');
  assert.equal(f.state.memoryProposals.length, 1);
  assert.ok(first.proposalId);
  f.state.memoryProposals = Array.from({ length: 100 }, (_, index) => ({ id: `pending-${index}`, status: 'pending' }));
  await assert.rejects(f.service.submitCreate({ payload: basePayload, source: linkSource }),
    error => error.status === 429 && error.code === 'memory_proposal_queue_full');
});

test('pending owner-note capture survives resolved-history pruning and consumes pending capacity', async () => {
  const capture = pendingOwnerMemoryCaptureProposal();
  const history = Array.from({ length: memoryProposalServiceLimits.maxResolved }, (_, index) => ({
    id: `resolved-${index}`, kind: 'create', agentId: 'agent-qa', lineageId, status: 'approved'
  }));
  const pruning = fixture();
  pruning.state.memoryProposals = [capture, ...history];
  await pruning.service.submitCreate({ payload: basePayload, source: linkSource });
  assert.ok(pruning.state.memoryProposals.includes(capture), 'a valid pending capture is retained ahead of disposable resolved history');
  assert.equal(pruning.state.memoryProposals.filter(item => item.status !== 'pending').length,
    memoryProposalServiceLimits.maxResolved);

  const capacity = fixture();
  capacity.state.memoryProposals = [capture, ...Array.from({ length: memoryProposalServiceLimits.maxPending - 1 }, (_, index) => ({
    id: `pending-${index}`, status: 'pending'
  }))];
  await assert.rejects(capacity.service.submitCreate({ payload: basePayload, source: linkSource }),
    error => error.status === 429 && error.code === 'memory_proposal_queue_full');
  assert.equal(capacity.state.memoryProposals.length, memoryProposalServiceLimits.maxPending,
    'an approved proposal with a genuine pending capture intent occupies one bounded queue slot');
});

test('retry of a rejected proposal stays rejected and never appends', async () => {
  const f = fixture({ autoCommit: false });
  const initial = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  const proposal = f.state.memoryProposals.find(item => item.id === initial.proposalId);
  proposal.status = 'rejected';
  proposal.resolvedAt = when;
  const retried = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  assert.equal(retried.accepted, false);
  assert.equal(retried.status, 'rejected');
  assert.equal(retried.pendingOwnerReview, false);
  assert.equal(f.appended.length, 0);
  assert.equal(f.state.memoryProposals.length, 1);
});

test('legacy fingerprint is reused only for the same agent and lineage', async () => {
  const f = fixture({ autoCommit: false });
  const first = await f.service.submitCreate({ payload: basePayload, source: linkSource });
  const nextLineage = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const otherLineage = await f.service.submitCreate({ payload: basePayload,
    source: { ...linkSource, lineageId: nextLineage } });
  const otherAgent = await f.service.submitCreate({ payload: basePayload,
    source: { ...linkSource, agentId: 'agent-other' } });
  assert.notEqual(otherLineage.proposalId, first.proposalId);
  assert.notEqual(otherAgent.proposalId, first.proposalId);
  assert.equal(f.state.memoryProposals.length, 3);
  assert.equal(f.state.memoryProposals.find(item => item.id === otherLineage.proposalId).lineageId, nextLineage);
  assert.equal(f.state.memoryProposals.find(item => item.id === otherAgent.proposalId).agentId, 'agent-other');
});
