import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSharedMemoryMistakeWarnings, createMemoryMistakeLedger } from '../lib/memory-mistake-ledger.mjs';
import { grantMemoryShare, revokeMemoryShare } from '../lib/memory-sharing.mjs';

const at = '2026-10-01T12:00:00.000Z';
const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherLineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sourceAgentId = 'agent-source';
const targetAgentId = 'agent-target';
const targetLineageId = 'lineage-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const targetLinkId = 'link-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const authority = Object.freeze({ agentId: sourceAgentId, lineageId,
  contextScope: { projectId: 'project-qa', topicId: 'task-flow' },
  author: { kind: 'agent', id: sourceAgentId } });
const proposal = Object.freeze({ whatWentWrong: 'A previous answer used a stale task path.',
  correction: 'The current source shows the path changed.',
  resultingFix: 'Check the current task record before constructing the path.',
  evidence: { kind: 'task', id: 'task-completed-0001' }, recurrenceOf: [],
  idempotencyKey: 'mistake-submit-0001' });

function ledgerFixture({ allowed = true, verifyEvidence, resolveRecurrence, loadById } = {}) {
  const records = new Map();
  const commits = [];
  const authPhases = [];
  const ledger = createMemoryMistakeLedger({
    authorize: ({ phase }) => { authPhases.push(phase); return { allowed }; },
    verifyEvidence: verifyEvidence || (async ({ reference }) => ({ verified: true, ...reference,
      excerpt: 'Task output records the stale path; current source records its replacement.', observedAt: at })),
    resolveRecurrence,
    loadById: loadById || (async ({ id }) => records.get(id) || null),
    commit: async (record, { assertAuthorized }) => {
      assertAuthorized();
      const existing = records.get(record.id);
      if (existing) return { created: false, record: existing };
      records.set(record.id, record);
      commits.push(record);
      return { created: true, record };
    },
    now: () => at
  });
  return { ledger, records, commits, authPhases };
}

test('mistake record requires trusted authority, verified evidence and injected commit', async () => {
  const f = ledgerFixture();
  const result = await f.ledger.record(proposal, authority);
  assert.equal(result.recorded, true);
  assert.equal(result.duplicate, false);
  assert.match(result.id, /^mistake-[0-9a-f-]{36}$/);
  assert.equal(f.commits.length, 1);
  const record = f.commits[0];
  assert.equal(record.lineageId, lineageId);
  assert.equal(record.agentId, sourceAgentId);
  assert.deepEqual(record.contextScope, authority.contextScope);
  assert.deepEqual(record.author, authority.author);
  assert.equal(record.importance, 1);
  assert.equal(record.evidence.excerpt, 'Task output records the stale path; current source records its replacement.');
  assert.deepEqual([record.whatWentWrong, record.correction, record.resultingFix],
    [proposal.whatWentWrong, proposal.correction, proposal.resultingFix]);
  assert.deepEqual(Object.keys(f.ledger), ['record']);
  assert.ok(f.authPhases.includes('commit-immediate'));
});

test('denied or unverified evidence never enters the authorized commit path', async () => {
  const denied = ledgerFixture({ allowed: false });
  await assert.rejects(denied.ledger.record(proposal, authority), error => error.code === 'mistake_not_authorized');
  assert.equal(denied.commits.length, 0);

  const unverified = ledgerFixture({ verifyEvidence: async ({ reference }) => ({ verified: false, ...reference,
    excerpt: 'Unverified model-provided text.', observedAt: at }) });
  await assert.rejects(unverified.ledger.record(proposal, authority), error => error.code === 'mistake_evidence_unverified');
  assert.equal(unverified.commits.length, 0);
});

test('stable idempotency preserves identity and rejects changed content under the same key', async () => {
  const f = ledgerFixture();
  const first = await f.ledger.record(proposal, authority);
  const retry = await f.ledger.record(proposal, authority);
  assert.equal(retry.id, first.id);
  assert.equal(retry.duplicate, true);
  assert.equal(f.commits.length, 1);
  await assert.rejects(f.ledger.record({ ...proposal, resultingFix: 'A different fix.' }, authority),
    error => error.code === 'mistake_idempotency_conflict');
  assert.equal(f.commits.length, 1);
});

test('lookup cannot alias a stable ID to another stored mistake identity', async () => {
  const original = ledgerFixture();
  const first = await original.ledger.record(proposal, authority);
  const stored = original.records.get(first.id);
  const mismatched = ledgerFixture({ loadById: async () => ({ ...stored,
    id: 'mistake-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) });
  await assert.rejects(mismatched.ledger.record(proposal, authority),
    error => error.code === 'mistake_idempotency_conflict');
  assert.equal(mismatched.commits.length, 0);
});

test('recurrence references require authorized source resolution and remain stable references', async () => {
  const original = ledgerFixture();
  const first = await original.ledger.record(proposal, authority);
  const prior = original.records.get(first.id);
  let resolverCalls = 0;
  const repeated = ledgerFixture({ resolveRecurrence: async ({ reference }) => {
    resolverCalls += 1;
    assert.deepEqual(reference, { id: prior.id, lineageId: prior.lineageId, agentId: prior.agentId });
    return prior;
  } });
  const second = await repeated.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0002',
    whatWentWrong: 'The stale task path recurred.',
    recurrenceOf: [{ id: prior.id, lineageId: prior.lineageId, agentId: prior.agentId }] }, authority);
  assert.equal(resolverCalls, 1);
  assert.equal(repeated.commits[0].recurrenceOf[0].id, first.id);

  const missingResolver = ledgerFixture();
  await assert.rejects(missingResolver.ledger.record({ ...proposal, recurrenceOf: [
    { id: prior.id, lineageId: prior.lineageId, agentId: prior.agentId }] }, authority),
  error => error.code === 'mistake_recurrence_unavailable');
  assert.equal(missingResolver.commits.length, 0);
});

test('shared warning projection requires both active lineages and one exact scoped share', async () => {
  const source = ledgerFixture();
  const first = await source.ledger.record(proposal, authority);
  const second = await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0002',
    whatWentWrong: 'A second past mistake in the same topic.',
    evidence: { kind: 'task', id: 'task-completed-0002' } }, authority);
  const projectWide = await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0003',
    whatWentWrong: 'A project-wide mistake.',
    evidence: { kind: 'task', id: 'task-completed-0003' } }, { ...authority, contextScope: { projectId: 'project-qa' } });
  await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0004',
    whatWentWrong: 'An unscoped mistake must stay private.', evidence: { kind: 'task', id: 'task-completed-0004' } },
  { ...authority, contextScope: null });
  await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0005',
    whatWentWrong: 'A different topic must stay private.', evidence: { kind: 'task', id: 'task-completed-0005' } },
  { ...authority, contextScope: { projectId: 'project-qa', topicId: 'other-topic' } });
  await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0006',
    whatWentWrong: 'A different project must stay private.', evidence: { kind: 'task', id: 'task-completed-0006' } },
  { ...authority, contextScope: { projectId: 'project-private', topicId: 'task-flow' } });
  await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0007',
    whatWentWrong: 'A different source agent must stay private.', evidence: { kind: 'task', id: 'task-completed-0007' } },
  { ...authority, agentId: 'agent-other-source', author: { kind: 'agent', id: 'agent-other-source' } });
  const rejected = await source.ledger.record({ ...proposal, idempotencyKey: 'mistake-submit-0008',
    whatWentWrong: 'A rejected mistake must stay out of shared warnings.',
    evidence: { kind: 'task', id: 'task-completed-0008' } }, authority);
  const sourceRecords = [...source.records.values()];
  const rejectedIndex = sourceRecords.findIndex(record => record.id === rejected.id);
  sourceRecords[rejectedIndex] = { ...sourceRecords[rejectedIndex], status: 'rejected' };
  const privateLineage = ledgerFixture();
  await privateLineage.ledger.record(proposal, { ...authority, lineageId: otherLineageId });

  const shares = [];
  const grant = grantMemoryShare(shares, { sourceAgentId, sourceLineageId: lineageId, targetAgentId,
    targetLineageId, targetLinkId, scope: { projectId: 'project-qa', topicId: 'task-flow' }, by: 'owner:qa', at });
  const records = [...sourceRecords, ...privateLineage.records.values()];
  const args = { records, shares, shareId: grant.share.id, sourceAgentId, sourceLineageId: lineageId,
    sourceLineageActive: true, targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId };
  const warnings = buildSharedMemoryMistakeWarnings(args);
  assert.equal(warnings.status, 'ready');
  assert.equal(warnings.dataOnly, true);
  assert.equal(warnings.warnings.length, 3, 'project-wide plus exact-topic records are visible through the selected scope');
  assert.deepEqual(new Set(warnings.warnings.map(item => item.id)), new Set([first.id, second.id, projectWide.id]));
  assert.ok(warnings.warnings.every(item => item.importance === 1 && item.dataOnly === true));
  assert.ok(warnings.warnings.every(item => item.lineageId === lineageId && item.contextScope));
  assert.equal(JSON.stringify(warnings).includes('An unscoped mistake'), false);
  assert.equal(JSON.stringify(warnings).includes('A different topic'), false);
  assert.equal(JSON.stringify(warnings).includes('A different source agent'), false);
  assert.equal(JSON.stringify(warnings).includes('A rejected mistake'), false);
  assert.equal(JSON.stringify(warnings).includes('project-private'), false);
  assert.equal(JSON.stringify(warnings).includes('Task output records the stale path; current source records its replacement.'), false,
    'shared warnings omit the private verified evidence excerpt');

  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, targetLinkId: 'link-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }).warnings.length, 0);
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, targetAgentId: 'agent-other-target' }).warnings.length, 0);
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, targetLineageId: otherLineageId }).warnings.length, 0);
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, sourceAgentId: 'agent-other-source' }).warnings.length, 0);
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, sourceLineageId: otherLineageId }).warnings.length, 0);
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, targetLineageActive: false }).status, 'empty',
    'an inactive target lineage alone withholds warnings');
  assert.equal(buildSharedMemoryMistakeWarnings({ ...args, sourceLineageActive: false }).status, 'empty',
    'an inactive source lineage withholds warnings');
  revokeMemoryShare(shares, grant.share.id, at);
  assert.equal(buildSharedMemoryMistakeWarnings(args).warnings.length, 0);
});

test('warning projection obeys count and byte bounds and keeps records as data', async () => {
  const f = ledgerFixture();
  for (let index = 0; index < 5; index += 1) {
    await f.ledger.record({ ...proposal, idempotencyKey: `mistake-batch-${String(index).padStart(4, '0')}`,
      whatWentWrong: `Past mistake ${index}: ${'detail '.repeat(60)}`,
      evidence: { kind: 'task', id: `task-evidence-${String(index).padStart(4, '0')}` } }, authority);
  }
  const shares = [];
  const grant = grantMemoryShare(shares, { sourceAgentId, sourceLineageId: lineageId, targetAgentId,
    targetLineageId, targetLinkId, scope: authority.contextScope, by: 'owner:qa', at });
  const bounded = buildSharedMemoryMistakeWarnings({ records: [...f.records.values()], shares,
    shareId: grant.share.id, sourceAgentId, sourceLineageId: lineageId, sourceLineageActive: true,
    targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId, maxRecords: 2, maxBytes: 4096 });
  assert.equal(bounded.warnings.length, 2);
  assert.equal(bounded.omittedCount, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 4096);
  assert.ok(bounded.warnings.every(item => item.kind === 'past-mistake' && item.dataOnly === true));
  assert.equal(Object.hasOwn(bounded.warnings[0], 'instruction'), false);

  const complete = buildSharedMemoryMistakeWarnings({ records: [...f.records.values()], shares,
    shareId: grant.share.id, sourceAgentId, sourceLineageId: lineageId, sourceLineageActive: true,
    targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId, maxRecords: 5, maxBytes: 8192 });
  const budgetWithoutOmissionField = Buffer.byteLength(JSON.stringify({ status: 'ready',
    format: 'hexigrid-memory-mistake-warnings', dataOnly: true, warnings: complete.warnings.slice(0, 2) }), 'utf8');
  const exactBudget = buildSharedMemoryMistakeWarnings({ records: [...f.records.values()], shares,
    shareId: grant.share.id, sourceAgentId, sourceLineageId: lineageId, sourceLineageActive: true,
    targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId, maxRecords: 5, maxBytes: budgetWithoutOmissionField });
  assert.ok(Buffer.byteLength(JSON.stringify(exactBudget), 'utf8') <= budgetWithoutOmissionField,
    'the byte cap includes the entire response envelope and omittedCount');
});

test('shared warning projection redacts recurrence identities and bounds oversized Unicode text', async () => {
  const priorAuthority = { ...authority, agentId: 'agent-private-source', lineageId: otherLineageId,
    author: { kind: 'agent', id: 'agent-private-source' }, contextScope: { projectId: 'private-project' } };
  const prior = ledgerFixture();
  const priorResult = await prior.ledger.record({ ...proposal, idempotencyKey: 'private-prior-record' }, priorAuthority);
  const shared = ledgerFixture({ resolveRecurrence: async () => prior.records.get(priorResult.id) });
  const current = await shared.ledger.record({ ...proposal, idempotencyKey: 'shared-long-record',
    whatWentWrong: '🔒'.repeat(400), correction: 'verified correction '.repeat(80),
    resultingFix: 'apply the current fix '.repeat(80),
    recurrenceOf: [{ id: priorResult.id, lineageId: otherLineageId, agentId: 'agent-private-source' }] }, authority);
  const shares = [];
  const grant = grantMemoryShare(shares, { sourceAgentId, sourceLineageId: lineageId, targetAgentId,
    targetLineageId, targetLinkId, scope: authority.contextScope, by: 'owner:qa', at });

  const packet = buildSharedMemoryMistakeWarnings({ records: [shared.records.get(current.id)], shares,
    shareId: grant.share.id, sourceAgentId, sourceLineageId: lineageId, sourceLineageActive: true,
    targetAgentId, targetLineageId, targetLineageActive: true, targetLinkId });

  assert.equal(packet.status, 'ready');
  assert.equal(packet.warnings.length, 1, 'a large canonical record still fits after the text bound is applied');
  const warning = packet.warnings[0];
  assert.equal(warning.recurrenceReferencesRedacted, 1);
  assert.equal(Object.hasOwn(warning, 'recurrenceOf'), false);
  assert.equal(warning.contentExcerpt, true);
  for (const field of ['whatWentWrong', 'correction', 'resultingFix']) {
    assert.ok(Buffer.byteLength(warning[field], 'utf8') <= 512, `${field} is byte bounded without splitting Unicode characters`);
  }
  assert.doesNotMatch(JSON.stringify(packet), new RegExp(`${otherLineageId}|${priorResult.id}|agent-private-source|private-project`));
  assert.ok(Buffer.byteLength(JSON.stringify(packet), 'utf8') <= 4096);
});
