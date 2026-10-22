import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATED_MEMORY_FORMAT, DATED_MEMORY_VERSION, DatedMemoryStore, normalizeMemoryValidAt, validateMemoryProposal } from '../lib/dated-memory.mjs';
import { stableContinuityJson } from '../lib/continuity-transfer.mjs';

const lineageId = 'lineage-7a111111-1111-4111-8111-111111111111';
const scope = { projectId: 'project-time', topicId: 'schedule' };

test('validAt is distinct from recorded asOf and survives an append-only store restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-valid-time-'));
  const oldId = 'memory-7a111111-1111-4111-8111-111111111111';
  const nextId = 'memory-7a222222-2222-4222-8222-222222222222';
  try {
    const store = new DatedMemoryStore({ root });
    await store.append({ id: oldId, lineageId, agentId: 'agent-time',
      createdAt: '2026-09-21T08:00:00.000Z', text: 'The launch is Tuesday.',
      valid_from: '2026-09-20T00:00:00.000Z', contextScope: scope });
    await store.append({ id: nextId, lineageId, agentId: 'agent-time',
      createdAt: '2026-09-22T10:15:00.000Z', text: 'The launch is Wednesday.',
      valid_from: '2026-09-22T10:00:00.000Z', contextScope: scope });

    // At this recorded time the replacement has not yet been recorded, even
    // though it will later be asserted to have become valid at 10:00.
    assert.deepEqual((await store.listContext({ lineageId, ...scope,
      asOf: '2026-09-22T10:10:00.000Z', validAt: '2026-09-22T10:00:00.000Z' })).map((item) => item.id), [oldId]);

    await store.appendConflictLink({ lineageId, fromId: nextId, toId: oldId, relation: 'supersedes',
      expectedFromRevision: 0, expectedToRevision: 0, by: 'owner:time-test',
      why: 'The successor states when the replacement became true.',
      evidence: { kind: 'owner-feedback', text: 'Owner confirmed the schedule change.' },
      createdAt: '2026-09-22T10:30:00.000Z' });

    const reopened = new DatedMemoryStore({ root });
    const old = await reopened.getById({ lineageId, id: oldId });
    assert.equal(old.status, 'superseded');
    assert.equal(old.valid_until, '2026-09-22T10:00:00.000Z');
    assert.equal(old.revision, 1);

    const beforeBoundary = await reopened.listContext({ lineageId, ...scope,
      validAt: '2026-09-22T09:59:59.999Z' });
    assert.deepEqual(beforeBoundary.map((item) => item.id), [oldId]);
    const atBoundary = await reopened.listContext({ lineageId, ...scope,
      validAt: '2026-09-22T10:00:00.000Z' });
    assert.deepEqual(atBoundary.map((item) => item.id), [nextId]);

    const recordedBeforeLink = await reopened.listContext({ lineageId, ...scope,
      asOf: '2026-09-22T10:29:59.999Z', validAt: '2026-09-22T10:00:00.000Z' });
    assert.deepEqual(recordedBeforeLink.map((item) => item.id).sort(), [oldId, nextId].sort(),
      'the recorded snapshot preserves the pre-link overlap instead of backdating knowledge');
    const recordedAfterLink = await reopened.listContext({ lineageId, ...scope,
      asOf: '2026-09-22T10:30:00.000Z', validAt: '2026-09-22T10:00:00.000Z' });
    assert.deepEqual(recordedAfterLink.map((item) => item.id), [nextId]);

    assert.equal((await reopened.getById({ lineageId, id: oldId,
      validAt: '2026-09-21T00:00:00.000Z' })).id, oldId);
    assert.equal((await reopened.getByIds({ lineageId, ids: [oldId, nextId],
      validAt: '2026-09-22T10:00:00.000Z' })).get(oldId), null);
    assert.equal((await reopened.getByIds({ lineageId, ids: [oldId, nextId],
      asOf: '2026-09-22T10:30:00.000Z', validAt: '2026-09-22T10:00:00.000Z' })).get(nextId).status, 'active');
    assert.deepEqual((await reopened.listContextScopes({ lineageId,
      asOf: '2026-09-22T10:30:00.000Z', validAt: '2026-09-21T00:00:00.000Z' })).map((item) => item.projectId), ['project-time']);

    await reopened.appendRevision({ lineageId, id: oldId, expectedRevision: 1,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:time-test',
      why: 'Keep the closed record in the historical standing.', changes: { status: 'historical' } });
    const historical = new DatedMemoryStore({ root });
    assert.equal((await historical.getById({ lineageId, id: oldId,
      validAt: '2026-09-21T00:00:00.000Z' })).status, 'historical');
    assert.deepEqual((await historical.listContext({ lineageId, ...scope,
      validAt: '2026-09-22T10:00:00.000Z' })).map((item) => item.id), [nextId]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('valid-time windows are canonical, half-open, and revision races use exact expected revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-valid-window-'));
  const id = 'memory-7a333333-3333-4333-8333-333333333333';
  try {
    assert.equal(normalizeMemoryValidAt('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
    for (const invalid of ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00.000+01:00', '2026-02-30T00:00:00.000Z']) {
      assert.throws(() => normalizeMemoryValidAt(invalid), /canonical UTC/);
    }
    assert.throws(() => validateMemoryProposal({ text: 'Bad time.', valid_from: '2026-01-01T00:00:00Z' }), /valid_from/);

    const store = new DatedMemoryStore({ root });
    await assert.rejects(store.append({ id, lineageId, agentId: 'agent-time',
      createdAt: '2026-09-21T08:00:00.000Z', text: 'Invalid reverse window.',
      valid_from: '2026-02-01T00:00:00.000Z', valid_until: '2026-01-01T00:00:00.000Z' }), /end after it starts/);
    await store.append({ id, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:00:00.000Z',
      text: 'A fact with an explicit start.', valid_from: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T08:00:00.000Z', by: 'owner:time-test', why: 'Empty interval.',
      changes: { valid_until: '2026-01-01T00:00:00.000Z' } }), /end after it starts/);

    const writes = await Promise.allSettled([
      store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-22T09:00:00.000Z',
        by: 'owner:time-test', why: 'First concurrent end.', changes: { valid_until: '2026-02-01T00:00:00.000Z' } }),
      store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-22T09:01:00.000Z',
        by: 'owner:time-test', why: 'Stale concurrent end.', changes: { valid_until: '2026-03-01T00:00:00.000Z' } })
    ]);
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(writes.filter((result) => result.status === 'rejected').length, 1);
    assert.match(String(writes.find((result) => result.status === 'rejected').reason), /revision conflict/);

    const reopened = new DatedMemoryStore({ root });
    const record = await reopened.getById({ lineageId, id, depth: 1 });
    assert.equal(record.revision, 1);
    assert.ok(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'].includes(record.valid_until));
    assert.equal(record.revisions[0].previous.valid_until, undefined);
    assert.equal(record.revisions[0].changes.valid_until, record.valid_until);
    assert.equal(await reopened.getById({ lineageId, id,
      validAt: record.valid_until }), null, 'valid_until is exclusive');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown legacy windows stay unknown, rejected facts never match, and contradicts does not auto-close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-valid-unknown-'));
  const legacyId = 'memory-7a444444-4444-4444-8444-444444444444';
  const rejectedId = 'memory-7a555555-5555-4555-8555-555555555555';
  const leftId = 'memory-7a666666-6666-4666-8666-666666666666';
  const rightId = 'memory-7a777777-7777-4777-8777-777777777777';
  const futureId = 'memory-7a888888-8888-4888-8888-888888888888';
  const expiredId = 'memory-7a999999-9999-4999-8999-999999999999';
  try {
    const legacyDate = '2026-09-19';
    const legacyFile = path.join(root, lineageId, `${legacyDate}.json`);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, JSON.stringify({ format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION,
      lineageId, date: legacyDate, entries: [{ id: legacyId, lineageId, agentId: 'agent-time', date: legacyDate,
        createdAt: `${legacyDate}T08:00:00.000Z`, text: 'Legacy facts have no asserted valid start.', metadata: {}, contextScope: scope }] }));
    const store = new DatedMemoryStore({ root });
    await store.append({ id: rejectedId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:01:00.000Z',
      text: 'Later rejected.', valid_from: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await store.appendRevision({ lineageId, id: rejectedId, expectedRevision: 0,
      createdAt: '2026-09-22T08:00:00.000Z', by: 'owner:time-test', why: 'Reject the inaccurate record.',
      changes: { status: 'rejected' } });
    await store.append({ id: leftId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:02:00.000Z',
      text: 'One possible time.', valid_from: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await store.append({ id: rightId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:03:00.000Z',
      text: 'Another possible time.', valid_from: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await store.append({ id: futureId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:04:00.000Z',
      text: 'This fact does not apply yet.', valid_from: '2026-03-01T00:00:00.000Z', contextScope: scope });
    await store.append({ id: expiredId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:05:00.000Z',
      text: 'This fact already ended.', valid_from: '2025-01-01T00:00:00.000Z', valid_until: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await store.appendConflictLink({ lineageId, fromId: leftId, toId: rightId, relation: 'contradicts',
      expectedFromRevision: 0, expectedToRevision: 0, by: 'owner:time-test',
      why: 'The owner has not adjudicated which statement applies.',
      evidence: { kind: 'owner-feedback', text: 'The statements conflict.' },
      createdAt: '2026-09-22T09:00:00.000Z' });

    const reopened = new DatedMemoryStore({ root });
    assert.equal((await reopened.getById({ lineageId, id: legacyId })).valid_from, undefined);
    assert.equal((await reopened.getById({ lineageId, id: legacyId,
      validAt: '2026-09-21T08:00:00.000Z' })), null,
    'recorded time is not a substitute for an explicit valid_from');
    assert.equal(await reopened.getById({ lineageId, id: rejectedId,
      validAt: '2026-02-01T00:00:00.000Z' }), null);
    const nowMs = Date.parse('2026-02-01T00:00:00.000Z');
    const atNow = await reopened.listContext({ lineageId, ...scope, nowMs });
    assert.deepEqual(atNow.map((item) => item.id).sort(), [legacyId, leftId, rightId].sort(),
      'ordinary current retrieval keeps unknown legacy records, but excludes known future and expired windows');
    assert.deepEqual((await reopened.listContext({ lineageId, ...scope,
      validAt: '2026-02-01T00:00:00.000Z' })).map((item) => item.id).sort(), [leftId, rightId].sort(),
    'an explicit validAt query excludes unknown validity as well as future, expired, and rejected content');
    assert.deepEqual((await reopened.recall({ lineageId, from: legacyDate, to: '2026-09-22',
      nowMs })).map((item) => item.id).sort(), [legacyId, leftId, rightId].sort());
    const left = await reopened.getById({ lineageId, id: leftId });
    const right = await reopened.getById({ lineageId, id: rightId });
    assert.equal(left.status, 'active');
    assert.equal(right.status, 'active');
    assert.equal(left.valid_until, undefined);
    assert.equal(right.valid_until, undefined);
    assert.match(left.warning, /CONFLICT/);
    assert.throws(() => normalizeMemoryValidAt(null), /canonical UTC/);
    await assert.rejects(reopened.listContext({ lineageId, ...scope, validAt: '2026-02-01T00:00:00Z' }), /canonical UTC/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy boundary-less supersedes links stay readable without deriving validity from recorded time', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-valid-legacy-link-'));
  const successorId = 'memory-7b111111-1111-4111-8111-111111111111';
  const oldId = 'memory-7b222222-2222-4222-8222-222222222222';
  try {
    const store = new DatedMemoryStore({ root });
    await store.append({ id: oldId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:00:00.000Z',
      text: 'Older assertion.', contextScope: scope });
    await store.append({ id: successorId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:01:00.000Z',
      text: 'Successor without a known valid start.', contextScope: scope });
    await store.appendConflictLink({ lineageId, fromId: successorId, toId: oldId, relation: 'contradicts',
      expectedFromRevision: 0, expectedToRevision: 0, by: 'owner:time-test', why: 'Legacy event fixture.',
      evidence: { kind: 'owner-feedback', text: 'Retained legacy conflict evidence.' },
      createdAt: '2026-09-22T08:00:00.000Z' });

    const file = path.join(root, lineageId, '2026-09-22.json');
    const log = JSON.parse(await readFile(file, 'utf8'));
    const event = log.entries[0];
    event.relation = 'supersedes';
    const { audit, ...payload } = event;
    event.audit = { ...audit, hash: crypto.createHash('sha256')
      .update(`${audit.previousHash}\n${stableContinuityJson(payload)}`).digest('hex') };
    await writeFile(file, JSON.stringify(log));

    const reopened = new DatedMemoryStore({ root });
    const old = await reopened.getById({ lineageId, id: oldId });
    assert.equal(old.status, 'active');
    assert.equal(old.valid_until, undefined);
    assert.equal(old.conflicts[0].relation, 'supersedes');
    assert.deepEqual(await reopened.listContext({ lineageId, ...scope,
      validAt: '2026-09-22T08:00:00.000Z' }), [],
    'both starts are unknown, so the legacy link cannot assert either fact at this valid time');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicit supersedes-link boundary closes the predecessor without fabricating the successor start', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-valid-explicit-link-'));
  const oldId = 'memory-7c111111-1111-4111-8111-111111111111';
  const nextId = 'memory-7c222222-2222-4222-8222-222222222222';
  try {
    const store = new DatedMemoryStore({ root });
    await store.append({ id: oldId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:00:00.000Z',
      text: 'Old assertion.', valid_from: '2026-01-01T00:00:00.000Z', contextScope: scope });
    await store.append({ id: nextId, lineageId, agentId: 'agent-time', createdAt: '2026-09-21T08:01:00.000Z',
      text: 'Successor start remains unknown.', contextScope: scope });
    const linked = await store.appendConflictLink({ lineageId, fromId: nextId, toId: oldId, relation: 'supersedes',
      expectedFromRevision: 0, expectedToRevision: 0, valid_from: '2026-02-01T00:00:00.000Z',
      by: 'owner:time-test', why: 'The owner supplied an explicit transition boundary.',
      evidence: { kind: 'owner-feedback', text: 'Owner confirmed this transition time.' },
      createdAt: '2026-09-22T08:00:00.000Z' });

    assert.equal(linked.valid_from, '2026-02-01T00:00:00.000Z');
    const reopened = new DatedMemoryStore({ root });
    assert.equal((await reopened.getById({ lineageId, id: oldId })).valid_until, linked.valid_from);
    assert.equal(await reopened.getById({ lineageId, id: nextId, validAt: linked.valid_from }), null,
      'a link boundary alone does not fabricate a missing successor record start');
  } finally { await rm(root, { recursive: true, force: true }); }
});
