import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createDatedMemoryMistakeLedger, buildSharedMemoryMistakeWarnings } from '../lib/memory-mistake-ledger.mjs';
import { grantMemoryShare } from '../lib/memory-sharing.mjs';

const at = '2026-10-01T12:00:00.000Z';
const later = '2026-10-01T13:00:00.000Z';
const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherLineageId = 'lineage-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sourceAgentId = 'agent-source';
const targetAgentId = 'agent-target';
const targetLineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const targetLinkId = 'link-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope = { projectId: 'project-qa', topicId: 'task-flow' };
const agentAuthority = Object.freeze({ agentId: sourceAgentId, lineageId, contextScope: scope,
  author: { kind: 'agent', id: sourceAgentId } });
const ownerAuthority = Object.freeze({ agentId: sourceAgentId, lineageId, contextScope: scope,
  author: { kind: 'owner', id: 'owner-qa' } });
const sourceExcerpt = 'PRIVATE_EVIDENCE_EXCERPT: reviewed task output confirms the mistaken path.';
const proposal = Object.freeze({ whatWentWrong: 'A previous answer used a stale task path.',
  correction: 'The current task record shows the path changed.',
  resultingFix: 'Check the current task record before constructing the path.',
  evidence: { kind: 'task', id: 'task-completed-0001' }, idempotencyKey: 'mistake-submit-0001' });

function makeServices(store, { allowed = true } = {}) {
  const calls = { authorize: [], commit: [], revision: [] };
  return {
    calls,
    authorize(context) {
      calls.authorize.push(context);
      return { allowed };
    },
    async verifyEvidence({ reference }) {
      return { verified: true, ...reference, excerpt: sourceExcerpt, observedAt: at };
    },
    async commit({ entry, assertAuthorized }) {
      calls.commit.push(entry.id);
      assertAuthorized();
      const result = await store.append(entry);
      return { created: result.appended, entry: result.entry };
    },
    async revise(input) {
      calls.revision.push(input);
      input.assertAuthorized();
      return store.appendRevision({ lineageId: input.lineageId, id: input.memoryId,
        expectedRevision: input.expectedRevision, createdAt: input.createdAt,
        by: input.by, why: input.why, changes: input.changes });
    }
  };
}

function makeLedger(store, services, now = () => at) {
  return createDatedMemoryMistakeLedger({ store, authorize: services.authorize,
    verifyEvidence: services.verifyEvidence, commit: services.commit, revise: services.revise, now });
}

function memoryId(mistakeId) {
  return `memory-${mistakeId.slice('mistake-'.length)}`;
}

function deferredReadStore(backing) {
  let nextRead;
  async function pauseAfterRead() {
    const gate = nextRead;
    if (!gate) return;
    nextRead = null;
    gate.markStarted();
    await gate.wait;
  }
  return {
    store: {
      async getById(options) {
        const entry = await backing.getById(options);
        await pauseAfterRead();
        return entry;
      },
      async listMemoryMistakes(options) {
        const entries = await backing.listMemoryMistakes(options);
        await pauseAfterRead();
        return entries;
      }
    },
    deferNextRead() {
      let markStarted;
      let release;
      const gate = { started: new Promise(resolve => { markStarted = resolve; }),
        wait: new Promise(resolve => { release = resolve; }), markStarted: () => markStarted(),
        release: () => release() };
      nextRead = gate;
      return gate;
    }
  };
}

test('canonical dated persistence survives a new store instance and exact retries do not resurrect rejected records', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-mistake-persistence-'));
  try {
    const firstStore = new DatedMemoryStore({ root });
    const firstServices = makeServices(firstStore);
    const firstLedger = makeLedger(firstStore, firstServices);
    const created = await firstLedger.record(proposal, agentAuthority);
    const memory = await firstStore.getById({ lineageId, id: memoryId(created.id), depth: 2 });

    assert.equal(memory.status, 'historical');
    assert.equal(memory.importance, 1);
    assert.equal(memory.metadata.memoryMistake.format, 'hexigrid-memory-mistake');
    assert.equal(memory.metadata.memoryMistake.version, 1);
    assert.equal(memory.metadata.memoryMistake.record.id, created.id);
    assert.equal(memory.metadata.memoryMistake.record.requestDigest.length, 64);
    assert.equal(memory.evidence_excerpt, sourceExcerpt);
    assert.deepEqual(await firstStore.recall({ lineageId, from: '2026-10-01', to: '2026-10-01' }), [],
      'historical mistake entries stay out of ordinary current-fact recall');

    const ownerStore = new DatedMemoryStore({ root });
    const owner = makeLedger(ownerStore, makeServices(ownerStore));
    const rejected = await owner.reject({ id: created.id, expectedRevision: 0,
      why: 'Owner reviewed the retained source and rejected this mistake record.', createdAt: later }, ownerAuthority);
    assert.deepEqual(rejected, { rejected: true, duplicate: false, id: created.id, revision: 1 });

    const restartedStore = new DatedMemoryStore({ root });
    const restartServices = makeServices(restartedStore);
    const restartedLedger = makeLedger(restartedStore, restartServices);
    const retry = await restartedLedger.record(proposal, agentAuthority);
    const restored = await restartedStore.getById({ lineageId, id: memoryId(created.id), depth: 2 });
    assert.equal(retry.duplicate, true);
    assert.equal(restored.status, 'rejected');
    assert.equal(restored.revision, 1);
    assert.equal(restored.revisions[0].changes.status, 'rejected');
    assert.equal(restartServices.calls.commit.length, 0, 'a restart retry reads the stable ID and does not append a new base event');
    assert.equal((await restartedStore.listMemoryMistakes({ lineageId, agentId: sourceAgentId,
      contextScope: scope, limit: 10 })).length, 1);
    await assert.rejects(restartedLedger.reject({ id: created.id, expectedRevision: 0,
      why: 'Stale owner review.', createdAt: later }, ownerAuthority), error => error.code === 'mistake_revision_conflict');
    await assert.rejects(restartedLedger.record({ ...proposal, correction: 'Changed content.' }, agentAuthority),
      error => error.code === 'mistake_idempotency_conflict');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent exact commits converge through dated-store same-ID append idempotency', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-mistake-race-'));
  try {
    const store = new DatedMemoryStore({ root });
    const services = makeServices(store);
    const left = makeLedger(store, services);
    const right = makeLedger(store, services);
    const [first, second] = await Promise.all([
      left.record(proposal, agentAuthority),
      right.record(proposal, agentAuthority)
    ]);

    assert.equal(first.id, second.id);
    assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true]);
    assert.equal(services.calls.commit.length, 2, 'both stale preflight reads can reach the commit callback');
    const entries = await store.listMemoryMistakes({ lineageId, agentId: sourceAgentId,
      contextScope: scope, limit: 10 });
    assert.equal(entries.length, 1, 'the canonical append path makes the racing same-ID commit idempotent');
    assert.equal(entries[0].metadata.memoryMistake.record.requestDigest.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact authorized lists retain retirement audit while shared warnings omit evidence excerpts and rejected rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-mistake-warning-'));
  try {
    const store = new DatedMemoryStore({ root });
    const services = makeServices(store);
    const ledger = makeLedger(store, services);
    const first = await ledger.record(proposal, agentAuthority);
    const second = await ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0002',
      whatWentWrong: 'A different stale path was reused.', evidence: { kind: 'task', id: 'task-completed-0002' } }, agentAuthority);
    await ledger.reject({ id: first.id, expectedRevision: 0,
      why: 'Owner rejected the first record.', createdAt: later }, ownerAuthority);
    await services.revise({ action: 'memory-mistake:retire', authority: ownerAuthority,
      lineageId, agentId: sourceAgentId, id: second.id, memoryId: memoryId(second.id),
      expectedRevision: 0, createdAt: later, by: 'owner:owner-qa',
      why: 'Owner retired the superseded mistake entry.', changes: { status: 'superseded' },
      assertAuthorized: () => assert.deepEqual(services.authorize({ action: 'memory-mistake:retire',
        phase: 'commit-immediate', authority: ownerAuthority }), { allowed: true }) });

    const listed = await ledger.list({ lineageId, agentId: sourceAgentId, contextScope: scope, limit: 10 }, ownerAuthority);
    assert.equal(listed.length, 2);
    assert.ok(listed.some(record => record.status === 'rejected'));
    assert.ok(listed.some(record => record.status === 'superseded' &&
      record.revisions.at(-1).why === 'Owner retired the superseded mistake entry.'));
    await assert.rejects(ledger.list({ lineageId, agentId: sourceAgentId,
      contextScope: { projectId: 'project-other' }, limit: 10 }, ownerAuthority),
    error => error.code === 'mistake_not_authorized');
    await assert.rejects(ledger.list({ lineageId, agentId: sourceAgentId, contextScope: scope, limit: 101 }, ownerAuthority),
      error => error.code === 'invalid_mistake_limit');

    const shares = [];
    const grant = grantMemoryShare(shares, { sourceAgentId, sourceLineageId: lineageId,
      targetAgentId, targetLineageId, targetLinkId, scope, by: 'owner:owner-qa', at });
    const warnings = buildSharedMemoryMistakeWarnings({ records: listed, shares, shareId: grant.share.id,
      sourceAgentId, sourceLineageId: lineageId, sourceLineageActive: true,
      targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId });
    assert.equal(warnings.status, 'ready');
    assert.equal(warnings.warnings.length, 1, 'rejected records remain in local history but never become shared warnings');
    assert.equal(warnings.warnings[0].id, second.id);
    assert.equal(warnings.warnings[0].status, 'superseded');
    assert.equal(warnings.warnings[0].retirementAudit[0].why, 'Owner retired the superseded mistake entry.');
    assert.equal(JSON.stringify(warnings).includes(sourceExcerpt), false,
      'the current share permits mistake facts but not the private raw evidence excerpt');
    assert.equal(Object.hasOwn(warnings.warnings[0].evidence, 'excerpt'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing mutation services and denied authorization cannot fall through to direct store writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-mistake-authority-'));
  try {
    const store = new DatedMemoryStore({ root });
    const services = makeServices(store, { allowed: false });
    assert.throws(() => createDatedMemoryMistakeLedger({ store, authorize: services.authorize,
      verifyEvidence: services.verifyEvidence }), /injected authorized/);
    const ledger = makeLedger(store, services);
    await assert.rejects(ledger.record(proposal, agentAuthority), error => error.code === 'mistake_not_authorized');
    assert.equal(services.calls.commit.length, 0);
    assert.deepEqual(await store.listMemoryMistakes({ lineageId, agentId: sourceAgentId,
      contextScope: scope, limit: 10 }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read authorization is rechecked after deferred exact ID and list reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-mistake-read-revocation-'));
  try {
    const backing = new DatedMemoryStore({ root });
    const setupServices = makeServices(backing);
    const setupLedger = makeLedger(backing, setupServices);
    const created = await setupLedger.record(proposal, agentAuthority);
    const deferred = deferredReadStore(backing);
    let readAllowed = true;
    const services = { ...makeServices(backing), authorize: () => ({ allowed: readAllowed }) };
    const ledger = makeLedger(deferred.store, services);

    const lookupGate = deferred.deferNextRead();
    const lookup = ledger.record(proposal, agentAuthority);
    await lookupGate.started;
    readAllowed = false;
    lookupGate.release();
    await assert.rejects(lookup, error => error.code === 'mistake_not_authorized');
    assert.equal(services.calls.commit.length, 0, 'revoked lookup cannot continue into commit');

    readAllowed = true;
    const listGate = deferred.deferNextRead();
    const listing = ledger.list({ lineageId, agentId: sourceAgentId, contextScope: scope, limit: 10 }, ownerAuthority);
    await listGate.started;
    readAllowed = false;
    listGate.release();
    await assert.rejects(listing, error => error.code === 'mistake_not_authorized');
    assert.equal(created.id, (await backing.getById({ lineageId, id: memoryId(created.id), depth: 2 })).metadata.memoryMistake.record.id);

    const priorResult = await setupLedger.record({ ...proposal, idempotencyKey: 'mistake-source-0001' },
      { ...agentAuthority, lineageId: otherLineageId });
    const priorEntry = await backing.getById({ lineageId: otherLineageId,
      id: memoryId(priorResult.id), depth: 2 });
    const prior = priorEntry.metadata.memoryMistake.record;
    readAllowed = true;
    let markResolverStarted;
    let releaseResolver;
    const resolverStarted = new Promise(resolve => { markResolverStarted = resolve; });
    const resolverWait = new Promise(resolve => { releaseResolver = resolve; });
    const recurrenceServices = makeServices(backing);
    recurrenceServices.authorize = () => ({ allowed: readAllowed });
    const recurrenceLedger = createDatedMemoryMistakeLedger({ store: deferred.store,
      authorize: recurrenceServices.authorize, verifyEvidence: recurrenceServices.verifyEvidence,
      commit: recurrenceServices.commit, revise: recurrenceServices.revise, now: () => at,
      resolveRecurrence: async () => {
        markResolverStarted();
        await resolverWait;
        return prior;
      } });
    const repeated = recurrenceLedger.record({ ...proposal, idempotencyKey: 'mistake-submit-0002',
      recurrenceOf: [{ id: prior.id, lineageId: prior.lineageId, agentId: prior.agentId }] }, agentAuthority);
    await resolverStarted;
    readAllowed = false;
    releaseResolver();
    await assert.rejects(repeated, error => error.code === 'mistake_not_authorized');
    assert.equal(recurrenceServices.calls.commit.length, 0, 'revoked recurrence reads cannot continue into commit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
