import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATED_MEMORY_FORMAT, DATED_MEMORY_VERSION, DatedMemoryStore, validateDatedMemoryBytes, validateMemoryProposal } from '../lib/dated-memory.mjs';

const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';

test('dated memory audit links detect altered and missing mutations across dates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-audit-'));
  const store = new DatedMemoryStore({ root });
  const firstId = 'memory-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondId = 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const file = (date) => path.join(root, lineageId, `${date}.json`);
  try {
    await store.append({ id: firstId, lineageId, agentId: 'agent-exampleagent',
      createdAt: '2026-09-21T10:00:00.000Z', text: 'First exact fact.' });
    await store.append({ id: secondId, lineageId, agentId: 'agent-exampleagent',
      createdAt: '2026-09-20T10:00:00.000Z', text: 'Late approval of an earlier fact.' });
    await store.appendRevision({ lineageId, id: firstId, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Corrected',
      changes: { text: 'Corrected exact fact.' } });
    const first = JSON.parse(await readFile(file('2026-09-21'), 'utf8'));
    const earlier = JSON.parse(await readFile(file('2026-09-20'), 'utf8'));
    const revision = JSON.parse(await readFile(file('2026-09-22'), 'utf8'));
    assert.deepEqual([first.entries[0].audit.sequence, earlier.entries[0].audit.sequence,
      revision.entries[0].audit.sequence], [1, 2, 3]);
    assert.equal(earlier.entries[0].audit.previousHash, first.entries.at(-1).audit.hash);
    assert.equal(revision.entries[0].audit.previousHash, earlier.entries.at(-1).audit.hash);
    const recovered = await new DatedMemoryStore({ root }).getById({ lineageId, id: firstId, depth: 1 });
    assert.equal(recovered.text, 'Corrected exact fact.');
    assert.equal(recovered.revisions[0].audit.sequence, 3);
    first.entries[0].text = 'Altered without the audit key.';
    await writeFile(file('2026-09-21'), JSON.stringify(first));
    assert.throws(() => validateDatedMemoryBytes(JSON.stringify(first), { lineageId, date: '2026-09-21' }), /audit chain is broken/);
    await assert.rejects(store.getById({ lineageId, id: firstId }), /audit chain is broken/);
    first.entries[0].text = 'First exact fact.';
    first.entries[0].unexpected = 'unvalidated extra field';
    assert.throws(() => validateDatedMemoryBytes(JSON.stringify(first), { lineageId, date: '2026-09-21' }), /audit chain is broken/);
    delete first.entries[0].unexpected;
    await writeFile(file('2026-09-21'), JSON.stringify({ ...first,
      entries: [first.entries[0]] }));
    earlier.entries = [];
    await writeFile(file('2026-09-20'), JSON.stringify(earlier));
    await assert.rejects(store.getById({ lineageId, id: firstId }), /audit chain is broken/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dated memory append is canonical, idempotent, and preserves exact source text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-'));
  const store = new DatedMemoryStore({ root });
  const input = {
    id: 'memory-22222222-2222-4222-8222-222222222222', lineageId, agentId: 'agent-exampleagent',
    createdAt: '2026-09-21T10:00:00.000Z', text: 'Exact memory text\nwith a second line.', metadata: { importance: 5, tags: ['bridge', 'continuity'] }
  };
  try {
    assert.equal((await store.append(input)).appended, true);
    assert.equal((await store.append(input)).appended, false);
    const entries = await store.readRange({ lineageId, from: '2026-09-21', to: '2026-09-21' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, input.text);
    assert.equal(entries[0].sourceFile, `${lineageId}/2026-09-21.json`);
    assert.equal(entries[0].chunkId, input.id);
    const parsed = JSON.parse(await readFile(path.join(root, lineageId, '2026-09-21.json'), 'utf8'));
    assert.equal(parsed.format, DATED_MEMORY_FORMAT);
    assert.equal(parsed.version, DATED_MEMORY_VERSION);
    assert.equal(parsed.entries.filter((entry) => entry.kind !== 'entity').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dated memory rejects secrets, unsafe identities, mismatched dates, and conflicting IDs without echoing values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-'));
  const store = new DatedMemoryStore({ root });
  const base = { id: 'memory-33333333-3333-4333-8333-333333333333', lineageId, agentId: 'agent-exampleagent', createdAt: '2026-09-21T10:00:00.000Z', text: 'Safe memory.' };
  try {
    await assert.rejects(store.append({ ...base, text: ['api_key', 'sk', 'private-value-not-for-output'].join('=') }), (error) => {
      assert.equal(error.code, 'CONTINUITY_SECRET');
      assert.doesNotMatch(error.message, /private-value-not-for-output/);
      return true;
    });
    await assert.rejects(store.append({ ...base, lineageId: '../outside' }), /valid continuity lineage/);
    await assert.rejects(store.append({ ...base, createdAt: '2026-09-20T10:00:00.000Z', date: '2026-09-21' }), /must match/);
    await store.append(base);
    await assert.rejects(store.append({ ...base, text: 'Different content.' }), /reused with different content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dated memory refuses symlinked lineage storage', async (t) => {
  if (process.platform === 'win32') {
    const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-outside-'));
    try {
      await mkdir(root, { recursive: true });
      try { await symlink(outside, path.join(root, lineageId), 'junction'); }
      catch (error) { t.skip(`Junction creation unavailable: ${error.code || error.message}`); return; }
      const store = new DatedMemoryStore({ root });
      await assert.rejects(store.append({ lineageId, agentId: 'agent-exampleagent', createdAt: '2026-09-21T10:00:00.000Z', text: 'Safe memory.' }), /symbolic links/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
    return;
  }
  t.skip('Windows junction boundary is covered on the release host.');
});

test('legacy dated records migrate on read without rewriting archival bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-legacy-'));
  const file = path.join(root, lineageId, '2026-09-21.json');
  const legacy = JSON.stringify({ format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION, lineageId, date: '2026-09-21', entries: [{ id: 'memory-44444444-4444-4444-8444-444444444444', lineageId, agentId: 'agent-one', date: '2026-09-21', createdAt: '2026-09-21T12:00:00.000Z', text: 'An existing fact.', metadata: {} }] });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, legacy);
    const store = new DatedMemoryStore({ root });
    const [record] = await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21', depth: 0 });
    assert.equal(record.status, 'active');
    assert.equal(record.valid_while, '');
    assert.equal(record.contextScope, null);
    assert.equal(record.originKind, 'legacy-unknown');
    assert.equal(record.verification, 'unverified');
    assert.equal(record.warning, '[UNVERIFIED SOURCE — verify before acting]');
    assert.equal(record.id, 'memory-44444444-4444-4444-8444-444444444444');
    assert.deepEqual(await store.listContext({ lineageId, projectId: 'project-a' }), []);
    assert.equal((await store.append({ id: record.id, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T12:00:00.000Z', text: 'An existing fact.', metadata: {} })).appended, false);
    assert.equal(await readFile(file, 'utf8'), legacy);
    await store.appendVerification({ lineageId, id: record.id, expectedRevision: 0,
      createdAt: '2026-09-22T12:00:00.000Z', by: 'owner:qa', why: 'Confirmed the archived fact.' });
    assert.equal((await store.getById({ lineageId, id: record.id })).verification, 'owner-confirmed');
    assert.equal((await store.getById({ lineageId, id: record.id })).importance, 0.5);
    assert.equal((await store.getById({ lineageId, id: record.id })).identityAnchor, false);
    assert.equal(await readFile(file, 'utf8'), legacy);
    await writeFile(file, legacy.replace('An existing fact.', 'A changed old fact.'));
    await assert.rejects(store.getById({ lineageId, id: record.id }), /audit chain is broken/,
      'the first new audit link anchors the exact legacy prefix that existed at migration');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner priority and identity anchors order bounded context without changing trust or scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-priority-'));
  const store = new DatedMemoryStore({ root });
  const id = (digit) => `memory-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const add = (digit, minute, extra = {}) => store.append({ id: id(digit), lineageId, agentId: 'agent-one',
    createdAt: `2026-09-21T10:${String(minute).padStart(2, '0')}:00.000Z`, text: `Fact ${digit}`,
    contextScope: { projectId: 'project-a' }, ...extra });
  try {
    await add('1', 10, { importance: 0.1, identityAnchor: true, originKind: 'agent-proposal' });
    await add('2', 20, { importance: 0.95 });
    await add('3', 30, { originKind: 'agent-proposal' });
    await add('4', 40, { importance: 0.99, contextScope: { projectId: 'project-b' }, identityAnchor: true });
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a' })).map((record) => record.id),
      [id('1'), id('2'), id('3')], 'pin and score outrank write order without crossing scope');
    assert.equal((await store.getById({ lineageId, id: id('1') })).verification, 'unverified', 'pin does not promote trust');
    assert.equal((await store.getById({ lineageId, id: id('3') })).importance, 0.4);
    await assert.rejects(store.appendRevision({ lineageId, id: id('1'), expectedRevision: 0, by: 'owner:qa', why: 'Invalid unscoping',
      createdAt: '2026-09-22T09:00:00.000Z', changes: { contextScope: null } }), /project scope/);
    await assert.rejects(store.appendRevision({ lineageId, id: id('1'), expectedRevision: 0, by: 'owner:qa', why: 'Invalid move',
      createdAt: '2026-09-22T09:00:00.000Z', changes: { contextScope: { projectId: 'project-b' } } }), /Unpin/);
    await store.appendRevision({ lineageId, id: id('1'), expectedRevision: 0, by: 'owner:qa', why: 'Unpinned after review',
      createdAt: '2026-09-22T10:00:00.000Z', changes: { identityAnchor: false } });
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a' })).map((record) => record.id),
      [id('2'), id('3'), id('1')]);
    await store.appendCorrection({ lineageId, id: id('3'), expectedRevision: 0, by: 'owner:qa', why: 'Owner correction',
      createdAt: '2026-09-22T11:00:00.000Z', changes: { text: 'Corrected fact 3' },
      source: { kind: 'owner-feedback', text: 'The previous fact was wrong.' }, expectedNextBehavior: 'Use corrected fact.' });
    assert.equal((await store.getById({ lineageId, id: id('3') })).importance, 0.9);
    await store.appendRevision({ lineageId, id: id('2'), expectedRevision: 0, by: 'owner:qa', why: 'Retired',
      createdAt: '2026-09-22T12:00:00.000Z', changes: { status: 'historical' } });
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a' })).map((record) => record.id),
      [id('3'), id('1')]);
    assert.deepEqual((await new DatedMemoryStore({ root }).listContext({ lineageId, projectId: 'project-a' })).map((record) => record.id),
      [id('3'), id('1')], 'priority and pin revisions survive reopen');
    await assert.rejects(add('5', 50, { importance: 1.1 }), /importance/);
    await assert.rejects(add('5', 50, { importance: Number.NaN }), /importance/);
    await assert.rejects(add('5', 50, { identityAnchor: 'true' }), /identity anchor/);
    await assert.rejects(add('5', 50, { contextScope: null, identityAnchor: true }), /project scope/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic-learning origin keeps agent-proposal priority and cannot be revised', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-auto-origin-'));
  const store = new DatedMemoryStore({ root });
  const id = 'memory-66666666-6666-4666-8666-666666666666';
  try {
    const created = await store.append({ id, lineageId, agentId: 'agent-one',
      createdAt: '2026-09-21T10:00:00.000Z', text: 'Automatically learned fact.',
      originKind: 'automatic-learning' });
    assert.equal(created.entry.originKind, 'automatic-learning');
    assert.equal(created.entry.importance, 0.4);

    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Attempt to relabel origin',
      originKind: 'agent-proposal', changes: { text: 'Edited automatic fact.' } }),
    /cannot change origin or verification/);
    await store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T11:00:00.000Z', by: 'owner:qa', why: 'Clarified wording',
      changes: { text: 'Clarified automatically learned fact.' } });
    const reopened = await new DatedMemoryStore({ root }).getById({ lineageId, id });
    assert.equal(reopened.originKind, 'automatic-learning');
    assert.equal(reopened.importance, 0.4);
    assert.equal(reopened.text, 'Clarified automatically learned fact.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner verification is an append-only revision and changed facts return to unverified', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-verification-'));
  const store = new DatedMemoryStore({ root });
  const id = 'memory-77777777-7777-4777-8777-777777777777';
  const originalFile = path.join(root, lineageId, '2026-09-21.json');
  try {
    const created = await store.append({ id, lineageId, agentId: 'agent-one',
      createdAt: '2026-09-21T10:00:00.000Z', text: 'The first exact fact.',
      evidence_excerpt: 'Initial source.', originKind: 'agent-proposal' });
    assert.equal(created.entry.originKind, 'agent-proposal');
    assert.equal(created.entry.verification, 'unverified');
    const originalBytes = await readFile(originalFile);
    for (const depth of [0, 1, 2]) {
      const current = await store.getById({ lineageId, id, depth });
      assert.equal(current.originKind, 'agent-proposal');
      assert.equal(current.verification, 'unverified');
      assert.equal(current.warning, '[UNVERIFIED SOURCE — verify before acting]');
      assert.equal(current.text, 'The first exact fact.');
    }
    await assert.rejects(store.append({ id: 'memory-88888888-8888-4888-8888-888888888888', lineageId,
      agentId: 'agent-one', createdAt: '2026-09-21T11:00:00.000Z', text: 'Bad confirmed base.',
      verification: 'owner-confirmed' }), /base memory cannot be owner-confirmed/);
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Forge origin',
      changes: { originKind: 'owner-entry' } }), /changes are invalid/);
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Forge confirmation',
      changes: { verification: 'owner-confirmed' } }), /changes are invalid/);
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Forge confirmation',
      verificationOnly: true, changes: { status: 'active' } }), /cannot change origin or verification/);
    const confirmed = await store.appendVerification({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Checked the source.' });
    assert.equal(confirmed.revision, 1);
    assert.equal(confirmed.verification, 'owner-confirmed');
    assert.deepEqual(await readFile(originalFile), originalBytes);
    for (const depth of [0, 1, 2]) {
      const current = await store.getById({ lineageId, id, depth });
      assert.equal(current.verification, 'owner-confirmed');
      assert.equal(current.originKind, 'agent-proposal');
      assert.equal(Object.hasOwn(current, 'warning'), false);
    }
    const history = await store.getById({ lineageId, id, depth: 1 });
    assert.equal(history.revisions[0].previous.verification, 'unverified');
    assert.equal(history.revisions[0].changes.verification, 'owner-confirmed');
    await assert.rejects(store.appendVerification({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:qa', why: 'Stale.' }), /revision conflict/);
    await assert.rejects(store.appendVerification({ lineageId, id, expectedRevision: 1,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:qa', why: 'Duplicate.' }), /already owner-confirmed/);
    await store.appendRevision({ lineageId, id, expectedRevision: 1,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:qa', why: 'Scope only',
      changes: { contextScope: { projectId: 'alpha' } } });
    assert.equal((await store.getById({ lineageId, id })).verification, 'owner-confirmed');
    await store.appendRevision({ lineageId, id, expectedRevision: 2,
      createdAt: '2026-09-24T10:00:00.000Z', by: 'owner:qa', why: 'New evidence',
      changes: { evidence_excerpt: 'Updated source.' } });
    const invalidated = await store.getById({ lineageId, id, depth: 2 });
    assert.equal(invalidated.verification, 'unverified');
    assert.equal(invalidated.warning, '[UNVERIFIED SOURCE — verify before acting]');
    assert.equal(invalidated.text, 'The first exact fact.');
    assert.equal(invalidated.revisions[2].previous.verification, 'owner-confirmed');
    assert.equal(invalidated.revisions[2].changes.verification, 'unverified');
    await store.appendVerification({ lineageId, id, expectedRevision: 3,
      createdAt: '2026-09-25T10:00:00.000Z', by: 'owner:qa', why: 'Checked new evidence.' });
    await store.appendRevision({ lineageId, id, expectedRevision: 4,
      createdAt: '2026-09-26T10:00:00.000Z', by: 'owner:qa', why: 'Corrected text',
      changes: { text: 'The revised exact fact.' } });
    const reopened = await new DatedMemoryStore({ root }).getById({ lineageId, id });
    assert.equal(reopened.verification, 'unverified');
    assert.equal(reopened.originKind, 'agent-proposal');
    assert.equal(reopened.text, 'The revised exact fact.');
    assert.equal(reopened.warning, '[UNVERIFIED SOURCE — verify before acting]');
    await store.appendVerification({ lineageId, id, expectedRevision: 5,
      createdAt: '2026-09-27T10:00:00.000Z', by: 'owner:qa', why: 'Checked corrected text.' });
    await store.appendRevision({ lineageId, id, expectedRevision: 6,
      createdAt: '2026-09-27T10:01:00.000Z', by: 'owner:qa', why: 'Changed validity condition',
      changes: { valid_while: 'the source stays current' } });
    assert.equal((await store.getById({ lineageId, id })).verification, 'unverified');
    await store.appendVerification({ lineageId, id, expectedRevision: 7,
      createdAt: '2026-09-27T10:02:00.000Z', by: 'owner:qa', why: 'Checked new condition.' });
    await store.appendRevision({ lineageId, id, expectedRevision: 8,
      createdAt: '2026-09-27T10:03:00.000Z', by: 'owner:qa', why: 'Changed standing',
      changes: { status: 'conditional' } });
    assert.equal((await store.getById({ lineageId, id })).verification, 'unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit project and topic scope excludes unrelated memories and follows append-only revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-context-'));
  const store = new DatedMemoryStore({ root });
  const at = (minute) => `2026-09-21T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const id = (digit) => `memory-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const append = async (digit, minute, contextScope, extra = {}) => store.append({ id: id(digit), lineageId, agentId: 'agent-one', createdAt: at(minute), text: `Fact ${digit}`, contextScope, ...extra });
  try {
    await append('1', 10, { projectId: 'project-a', topicId: 'topic-x' }, { status: 'conditional', valid_while: 'the owner has not ended this work' });
    await append('2', 11, { projectId: 'project-a' });
    await append('3', 12, { projectId: 'project-a', topicId: 'topic-y' });
    await append('4', 13, { projectId: 'project-b', topicId: 'topic-x' });
    await append('5', 14, undefined);
    await append('6', 15, { projectId: 'project-a', topicId: 'topic-x' }, { status: 'historical' });
    await append('7', 10, { projectId: 'project-a', topicId: 'topic-x' });
    assert.deepEqual(await store.listContextScopes({ lineageId }), [
      { projectId: 'project-b', topicId: 'topic-x', count: 1, updatedAt: at(13) },
      { projectId: 'project-a', topicId: 'topic-y', count: 1, updatedAt: at(12) },
      { projectId: 'project-a', count: 1, updatedAt: at(11) },
      { projectId: 'project-a', topicId: 'topic-x', count: 2, updatedAt: at(10) }
    ], 'discovery excludes unscoped and retired records and counts current facts only');
    assert.deepEqual(await store.listContextScopes({ lineageId: 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), []);
    const scoped = await store.listContext({ lineageId, projectId: 'project-a', topicId: 'topic-x' });
    assert.deepEqual(scoped.map((record) => record.id), [id('1'), id('7'), id('2')], 'topic facts precede newer project-wide facts; ties use ID');
    assert.equal(scoped[0].valid_while, 'the owner has not ended this work');
    assert.equal(scoped[0].status, 'conditional');
    assert.equal(scoped[0].sourceFile, `${lineageId}/2026-09-21.json`);
    assert.equal(scoped[0].revision, 0);
    assert.equal(scoped[0].updatedAt, at(10));
    assert.equal(Object.hasOwn(scoped[0], 'revisions'), false);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a' })).map((record) => record.id), [id('2')]);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-b', topicId: 'topic-x' })).map((record) => record.id), [id('4')]);
    const originalBytes = await readFile(path.join(root, lineageId, '2026-09-21.json'));
    await store.appendRevision({ lineageId, id: id('4'), expectedRevision: 0, createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Moved work to project A', changes: { contextScope: { projectId: 'project-a', topicId: 'topic-x' } } });
    assert.deepEqual(await readFile(path.join(root, lineageId, '2026-09-21.json')), originalBytes);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a', topicId: 'topic-x' })).map((record) => record.id), [id('4'), id('1'), id('7'), id('2')]);
    assert.deepEqual(await store.listContext({ lineageId, projectId: 'project-b', topicId: 'topic-x' }), []);
    assert.equal((await store.listContextScopes({ lineageId })).some((scope) => scope.projectId === 'project-b'), false);
    assert.equal((await store.listContextScopes({ lineageId })).find((scope) => scope.topicId === 'topic-x').count, 3);
    const history = await store.getById({ lineageId, id: id('4'), depth: 1 });
    assert.deepEqual(history.revisions[0].previous.contextScope, { projectId: 'project-b', topicId: 'topic-x' });
    assert.deepEqual(history.revisions[0].changes.contextScope, { projectId: 'project-a', topicId: 'topic-x' });
    await store.appendRevision({ lineageId, id: id('4'), expectedRevision: 1, createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:qa', why: 'Retired project placement', changes: { contextScope: null } });
    assert.equal((await store.getById({ lineageId, id: id('4') })).contextScope, null);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'project-a', topicId: 'topic-x' })).map((record) => record.id), [id('1'), id('7'), id('2')]);
    assert.equal((await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21' })).find((record) => record.id === id('4')).contextScope, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('context scope IDs are bounded, opaque, and require a project before a topic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-context-validation-'));
  const store = new DatedMemoryStore({ root });
  const base = { lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z', text: 'Scoped fact.' };
  try {
    for (const contextScope of [{ topicId: 'topic-x' }, { projectId: '../outside' }, { projectId: 'a'.repeat(129) }, { projectId: 'ok', topicId: '' }, { projectId: 'ok', other: 'extra' }, 'project-a']) {
      await assert.rejects(store.append({ ...base, contextScope }), /context/i);
      assert.throws(() => validateMemoryProposal({ text: base.text, contextScope }), /context/i);
    }
    assert.deepEqual(validateMemoryProposal({ text: base.text, contextScope: { projectId: 'project-a', topicId: 'topic-x' } }).contextScope, { projectId: 'project-a', topicId: 'topic-x' });
    const created = await store.append({ ...base, contextScope: { projectId: 'project-a' } });
    assert.equal((await store.append({ ...base, id: created.entry.id, contextScope: { projectId: 'project-a' } })).appended, false);
    await assert.rejects(store.append({ ...base, id: created.entry.id, contextScope: { projectId: 'project-b' } }), /reused with different content/);
    await assert.rejects(store.appendRevision({ lineageId, id: created.entry.id, expectedRevision: 0, createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:qa', why: 'Invalid topic', changes: { contextScope: { topicId: 'topic-x' } } }), /context/i);
    await assert.rejects(store.listContext({ lineageId, topicId: 'topic-x' }), /context/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner correction preserves exact feedback and replacement guidance across reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-correction-'));
  const store = new DatedMemoryStore({ root });
  try {
    const created = await store.append({ lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z',
      text: 'Always assume a stale answer is current.', contextScope: { projectId: 'project-a', topicId: 'research' } });
    const id = created.entry.id;
    const feedback = '  That answer was stale.\nCheck the dated source first.  ';
    const corrected = await store.appendCorrection({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:test', why: 'Owner caught a stale answer',
      changes: { text: 'Before answering, check the current dated source and state uncertainty if unavailable.' },
      source: { kind: 'owner-feedback', text: feedback }, expectedNextBehavior: 'Check the current dated source before the next answer.' });
    assert.equal(corrected.revision, 1);
    const observed = { kind: 'agent-link-message', id: 'link-message-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', linkId: 'link-qa',
      text: 'I checked the current dated source before answering.', createdAt: '2026-09-23T09:00:00.000Z' };
    const evaluation = await store.appendEvaluation({ lineageId, id, correctionRevisionId: corrected.revisionId,
      outcome: 'pass', observed, why: 'Owner checked the next answer', by: 'owner:test', createdAt: '2026-09-23T10:00:00.000Z' });
    assert.match(evaluation.evaluationId, /^evaluation-/);
    await assert.rejects(store.appendEvaluation({ lineageId, id, correctionRevisionId: corrected.revisionId,
      outcome: 'fail', observed, why: 'Duplicate observation', by: 'owner:test', createdAt: '2026-09-23T11:00:00.000Z' }), /already records/);
    const reopened = new DatedMemoryStore({ root });
    const current = await reopened.getById({ lineageId, id });
    assert.equal(current.text, 'Before answering, check the current dated source and state uncertainty if unavailable.');
    assert.equal(current.revision, 1);
    assert.equal(Object.hasOwn(current, 'evaluations'), false);
    assert.equal((await reopened.listContext({ lineageId, projectId: 'project-a', topicId: 'research' }))[0].text, current.text);
    const history = await reopened.getById({ lineageId, id, depth: 1 });
    assert.equal(history.revisions[0].previous.text, 'Always assume a stale answer is current.');
    assert.match(history.revisions[0].learning.source.id, /^feedback-/);
    assert.equal(Object.hasOwn(history.revisions[0].learning.source, 'text'), false);
    assert.equal(history.evaluations[0].outcome, 'pass');
    assert.equal(Object.hasOwn(history.evaluations[0].observed, 'text'), false);
    const evidence = await reopened.getById({ lineageId, id, depth: 2 });
    assert.equal(evidence.revisions[0].learning.source.text, feedback);
    assert.equal(evidence.revisions[0].learning.expectedNextBehavior, 'Check the current dated source before the next answer.');
    assert.equal(evidence.evaluations[0].observed.text, observed.text);
    assert.equal(evidence.evaluations[0].correctionRevisionId, corrected.revisionId);
    await assert.rejects(reopened.appendCorrection({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:test', why: 'Stale correction', changes: { text: 'Wrong' },
      source: { kind: 'owner-feedback', text: 'Correction' }, expectedNextBehavior: 'Use correct fact' }), /revision conflict/);
    await assert.rejects(reopened.appendCorrection({ lineageId, id, expectedRevision: 1,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:test', why: 'Forged evidence', changes: { text: 'Wrong' },
      source: { kind: 'agent-link-message', id: 'forged-id', linkId: 'link-fake', text: 'Fake', createdAt: '2026-09-21T10:00:00.000Z' }, expectedNextBehavior: 'Do better' }), /source ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revisions keep the stable ID, record authorizer and reason, and project bounded recall depth', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-revisions-'));
  const store = new DatedMemoryStore({ root });
  const id = 'memory-55555555-5555-4555-8555-555555555555';
  const original = path.join(root, lineageId, '2026-09-21.json');
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z', text: 'Stripe is in test mode.', status: 'conditional', valid_while: 'NM tax registration is not live', evidence_excerpt: 'Owner approval note.' });
    const originalBytes = await readFile(original);
    const revision = await store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:test-session', why: 'Registration completed', changes: { text: 'Stripe is in live mode.', status: 'active', valid_while: 'Stripe remains configured for live transactions', evidence_excerpt: 'Owner confirmed activation.' } });
    assert.equal(revision.id, id);
    assert.match(revision.revisionId, /^revision-/);
    assert.deepEqual(await readFile(original), originalBytes);
    const [depth0] = await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21', depth: 0 });
    assert.equal(depth0.id, id);
    assert.equal(depth0.text, 'Stripe is in live mode.');
    assert.equal(depth0.valid_while, 'Stripe remains configured for live transactions');
    assert.equal(depth0.status, 'active');
    assert.equal(depth0.revision, 1);
    assert.equal(Object.hasOwn(depth0, 'revisions'), false);
    assert.equal(Object.hasOwn(depth0, 'evidence_excerpt'), false);
    const [depth1] = await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21', depth: 1 });
    assert.equal(depth1.revisions[0].why, 'Registration completed');
    assert.equal(depth1.revisions[0].by, 'owner:test-session');
    assert.equal(depth1.revisions[0].previous.text, 'Stripe is in test mode.');
    assert.equal(depth1.revisions[0].changes.text, 'Stripe is in live mode.');
    assert.equal(Object.hasOwn(depth1.revisions[0].changes, 'evidence_excerpt'), false);
    assert.equal(Object.hasOwn(depth1.revisions[0].previous, 'evidence_excerpt'), false);
    const [depth2] = await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21', depth: 2 });
    assert.equal(depth2.evidence_excerpt, 'Owner confirmed activation.');
    assert.equal(depth2.revisions[0].changes.evidence_excerpt, 'Owner confirmed activation.');
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:test-session', why: 'Outdated', changes: { text: 'Wrong' } }), /revision conflict/);
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 1, createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:test-session', why: 'Invalid condition', changes: { status: 'conditional', valid_while: '' } }), /requires valid_while/);
    await assert.rejects(store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21', depth: 3 }), /recall depth/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent revisions serialize; rejected facts leave current recall', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-concurrent-'));
  const store = new DatedMemoryStore({ root });
  const id = 'memory-66666666-6666-4666-8666-666666666666';
  try {
    await store.append({ id, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z', text: 'A proposed fact.' });
    const results = await Promise.allSettled(['disputed', 'rejected'].map((status) => store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: '2026-09-22T10:00:00.000Z', by: 'owner:test-session', why: 'Review outcome', changes: { status } })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const current = await store.getById({ lineageId, id, depth: 1 });
    assert.equal(current.revision, 1);
    assert.equal(current.revisions.length, 1);
    assert.equal((await store.recall({ lineageId, from: '2026-09-21', to: '2026-09-21' })).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verify_by is strict ISO and expired facts stay current with a dynamic stale warning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-freshness-'));
  const store = new DatedMemoryStore({ root });
  const oldId = 'memory-f1111111-1111-4111-8111-111111111111';
  const futureId = 'memory-f2222222-2222-4222-8222-222222222222';
  const scope = { projectId: 'weather' };
  try {
    await assert.rejects(store.append({ lineageId, agentId: 'agent-one',
      createdAt: '2026-09-21T10:00:00.000Z', text: 'Malformed date.', verify_by: 'next week' }), /verify_by/);
    assert.throws(() => validateMemoryProposal({ text: 'Malformed proposal.', verify_by: '2026-02-30' }), /verify_by|valid ISO calendar/);
    assert.throws(() => validateMemoryProposal({ text: 'Malformed proposal.', verify_by: '2026-02-30T10:00:00Z' }), /verify_by/);
    assert.throws(() => validateMemoryProposal({ text: 'Malformed proposal.', verify_by: '2026-02-28T25:00:00Z' }), /verify_by/);
    await store.append({ id: oldId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z',
      text: 'The weather service version was current.', contextScope: scope, verify_by: '2020-01-01' });
    await store.append({ id: futureId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:01:00.000Z',
      text: 'The local schedule remains current.', contextScope: scope, verify_by: '2999-01-01T12:00:00Z' });
    const stale = await store.getById({ lineageId, id: oldId });
    assert.equal(stale.verify_by, '2020-01-01');
    assert.equal(stale.stale, true);
    assert.match(stale.warning, /STALE — re-verify before acting/);
    assert.match(stale.warning, /UNVERIFIED SOURCE/);
    assert.equal(stale.status, 'active');
    const fresh = await store.getById({ lineageId, id: futureId });
    assert.equal(fresh.verify_by, '2999-01-01T12:00:00.000Z');
    assert.equal(fresh.stale, undefined);
    assert.doesNotMatch(fresh.warning, /STALE/);
    assert.ok((await store.listContext({ lineageId, projectId: 'weather' })).some((record) => record.id === oldId && record.stale));
    await store.appendRevision({ lineageId, id: oldId, expectedRevision: 0, createdAt: '2026-09-22T10:00:00.000Z',
      by: 'owner:test', why: 'Owner refreshed the deadline.', changes: { verify_by: '2999-01-01' } });
    const revised = await new DatedMemoryStore({ root }).getById({ lineageId, id: oldId, depth: 1 });
    assert.equal(revised.stale, undefined);
    assert.equal(revised.verify_by, '2999-01-01');
    assert.equal(revised.revisions[0].previous.verify_by, '2020-01-01');
    assert.equal(revised.revisions[0].changes.verify_by, '2999-01-01');
    await store.appendRevision({ lineageId, id: oldId, expectedRevision: 1, createdAt: '2026-09-23T10:00:00.000Z',
      by: 'owner:test', why: 'No external deadline now applies.', changes: { verify_by: null } });
    assert.equal((await store.getById({ lineageId, id: oldId })).verify_by, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence-backed contradiction links preserve both facts and surface bounded depth-zero warnings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-conflicts-'));
  const store = new DatedMemoryStore({ root });
  const firstId = 'memory-c1111111-1111-4111-8111-111111111111';
  const secondId = 'memory-c2222222-2222-4222-8222-222222222222';
  const scope = { projectId: 'project-a', topicId: 'launch' };
  try {
    await store.append({ id: firstId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z',
      text: 'The launch is Tuesday.', contextScope: scope });
    await store.append({ id: secondId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:01:00.000Z',
      text: 'The launch is Wednesday.', contextScope: scope });
    const linked = await store.appendConflictLink({ lineageId, fromId: firstId, toId: secondId,
      relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0,
      by: 'owner:test', why: 'The statements disagree on the launch day.',
      evidence: { kind: 'owner-feedback', text: 'Owner found both dates in separate messages.' },
      createdAt: '2026-09-22T10:00:00.000Z' });
    assert.match(linked.id, /^conflict-/);
    const reopened = new DatedMemoryStore({ root });
    const first = await reopened.getById({ lineageId, id: firstId });
    const second = await reopened.getById({ lineageId, id: secondId });
    assert.equal(first.text, 'The launch is Tuesday.');
    assert.equal(second.text, 'The launch is Wednesday.');
    assert.equal(first.conflicts[0].otherId, secondId);
    assert.equal(second.conflicts[0].otherId, firstId);
    assert.equal(first.conflicts[0].relation, 'contradicts');
    assert.match(first.warning, /CONFLICT — review linked memories before acting/);
    assert.match(second.warning, /CONFLICT — review linked memories before acting/);
    assert.equal(JSON.stringify(first).includes('Owner found both dates'), false);
    const context = await reopened.listContext({ lineageId, ...scope });
    assert.deepEqual(context.map((record) => record.id).sort(), [firstId, secondId].sort());
    assert.ok(context.every((record) => record.conflictCount === 1 && /CONFLICT/.test(record.warning)));
    const shallow = await reopened.getById({ lineageId, id: firstId, depth: 1 });
    assert.equal(shallow.conflicts[0].why, 'The statements disagree on the launch day.');
    assert.equal(shallow.conflicts[0].evidence.text, undefined);
    const deep = await reopened.getById({ lineageId, id: firstId, depth: 2 });
    assert.equal(deep.conflicts[0].evidence.text, 'Owner found both dates in separate messages.');
    assert.equal(deep.conflicts[0].audit.hash.length, 64);
    await assert.rejects(store.appendConflictLink({ lineageId, fromId: secondId, toId: firstId,
      relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0,
      by: 'owner:test', why: 'Duplicate disagreement.',
      evidence: { kind: 'owner-feedback', text: 'The same evidence.' }, createdAt: '2026-09-23T10:00:00.000Z' }), /already exists/);
    await assert.rejects(store.appendRevision({ lineageId, id: firstId, expectedRevision: 0,
      createdAt: '2026-09-23T11:00:00.000Z', by: 'owner:test', why: 'Attempted move.',
      changes: { contextScope: { projectId: 'project-b' } } }), /cannot move/);
    const file = path.join(root, lineageId, '2026-09-22.json');
    const bytes = JSON.parse(await readFile(file, 'utf8'));
    bytes.entries[0].why = 'Changed after approval.';
    await writeFile(file, JSON.stringify(bytes));
    await assert.rejects(reopened.getById({ lineageId, id: firstId }), /audit chain is broken/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conflict links reject other lineages, projects, topics, stale revisions, and weak evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-conflict-boundary-'));
  const store = new DatedMemoryStore({ root });
  const firstId = 'memory-d1111111-1111-4111-8111-111111111111';
  const secondId = 'memory-d2222222-2222-4222-8222-222222222222';
  const thirdId = 'memory-d3333333-3333-4333-8333-333333333333';
  const otherLineage = 'lineage-ffffffff-ffff-4fff-8fff-ffffffffffff';
  const args = { lineageId, fromId: secondId, toId: firstId, relation: 'supersedes',
    expectedFromRevision: 1, expectedToRevision: 0, by: 'owner:test', why: 'Newer evidence replaces an old assertion.',
    evidence: { kind: 'owner-feedback', text: 'Owner checked the current schedule.' },
    createdAt: '2026-09-22T10:00:00.000Z' };
  try {
    await store.append({ id: firstId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:00:00.000Z',
      text: 'Old assertion.', valid_from: '2026-09-20T00:00:00.000Z', contextScope: { projectId: 'alpha', topicId: 'one' } });
    await store.append({ id: secondId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:01:00.000Z',
      text: 'Different project.', valid_from: '2026-09-22T10:00:00.000Z', contextScope: { projectId: 'beta', topicId: 'one' } });
    await store.append({ id: thirdId, lineageId, agentId: 'agent-one', createdAt: '2026-09-21T10:02:00.000Z',
      text: 'Different topic.', contextScope: { projectId: 'alpha', topicId: 'two' } });
    await store.append({ id: secondId, lineageId: otherLineage, agentId: 'agent-two', createdAt: '2026-09-21T10:03:00.000Z',
      text: 'Other lineage.', contextScope: { projectId: 'alpha', topicId: 'one' } });
    await assert.rejects(store.appendConflictLink({ ...args, expectedFromRevision: 0 }), /same exact scope/);
    await assert.rejects(store.appendConflictLink({ ...args, fromId: thirdId }), /same exact scope/);
    await assert.rejects(store.appendConflictLink({ ...args, fromId: 'memory-e1111111-1111-4111-8111-111111111111' }), /same exact scope/);
    await assert.rejects(store.appendConflictLink({ ...args, lineageId: otherLineage }), /same exact scope/);
    await store.appendRevision({ lineageId, id: secondId, expectedRevision: 0, createdAt: '2026-09-21T12:00:00.000Z',
      by: 'owner:test', why: 'Moved to the exact scope.', changes: { contextScope: { projectId: 'alpha', topicId: 'one' } } });
    await assert.rejects(store.appendConflictLink({ ...args, expectedFromRevision: 0 }), /same exact scope/);
    await assert.rejects(store.appendConflictLink({ ...args, by: 'agent:spoof' }), /authenticated owner/);
    await assert.rejects(store.appendConflictLink({ ...args,
      evidence: { kind: 'owner-feedback', text: '' } }), /empty or too large/);
    const linked = await store.appendConflictLink(args);
    assert.equal(linked.relation, 'supersedes');
    const source = await store.getById({ lineageId, id: secondId });
    const target = await store.getById({ lineageId, id: firstId });
    assert.equal(source.status, 'active');
    assert.equal(target.status, 'superseded');
    assert.equal(target.valid_until, '2026-09-22T10:00:00.000Z');
    assert.equal(target.revision, 1);
    assert.deepEqual([source.conflicts[0].relation, source.conflicts[0].role, source.conflicts[0].otherId],
      ['supersedes', 'source', firstId]);
    assert.deepEqual([target.conflicts[0].relation, target.conflicts[0].role, target.conflicts[0].otherId],
      ['supersedes', 'target', secondId]);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'alpha', topicId: 'one' })).map((item) => item.id), [secondId]);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'alpha', topicId: 'one', validAt: '2026-09-21T23:59:59.999Z' })).map((item) => item.id), [firstId]);
    assert.deepEqual((await store.listContext({ lineageId, projectId: 'alpha', topicId: 'one', validAt: '2026-09-22T10:00:00.000Z' })).map((item) => item.id), [secondId]);
    await store.appendRevision({ lineageId, id: firstId, expectedRevision: 1,
      createdAt: '2026-09-23T10:00:00.000Z', by: 'owner:test', why: 'This old assertion is retired.',
      changes: { status: 'historical' } });
    await assert.rejects(store.appendConflictLink({ ...args, relation: 'contradicts', expectedToRevision: 2,
      createdAt: '2026-09-24T10:00:00.000Z' }), /two current revisions/);
    assert.equal((await new DatedMemoryStore({ root }).getById({ lineageId, id: secondId })).conflicts.length, 1,
      'existing links remain inspectable after later retirement');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('memory rollback appends compensating revisions, preserves rejection, and retires post-checkpoint facts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rollback-'));
  const store = new DatedMemoryStore({ root });
  const restoredId = 'memory-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const rejectedId = 'memory-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const laterId = 'memory-cccccccc-3333-4333-8333-cccccccccccc';
  const authorize = () => true;
  try {
    await store.append({ id: restoredId, lineageId, agentId: 'agent-one',
      createdAt: '2026-10-01T10:00:00.000Z', text: 'Use the staging workspace.',
      status: 'conditional', valid_while: 'the owner has not approved production',
      verify_by: '2027-01-01', metadata: { source: 'owner' } });
    await store.append({ id: rejectedId, lineageId, agentId: 'agent-one',
      createdAt: '2026-10-01T10:01:00.000Z', text: 'A proposed outdated instruction.' });
    const checkpoint = await store.getRollbackCheckpoint({ lineageId });

    await store.appendRevision({ lineageId, id: restoredId, expectedRevision: 0,
      createdAt: '2026-10-02T10:00:00.000Z', by: 'owner:qa', why: 'Owner changed the condition.',
      changes: { text: 'Use the production workspace.', status: 'active', valid_while: '', verify_by: null,
        metadata: { source: 'new owner instruction' } } });
    await store.appendRevision({ lineageId, id: rejectedId, expectedRevision: 0,
      createdAt: '2026-10-02T10:01:00.000Z', by: 'owner:qa', why: 'Owner rejected the proposal.',
      changes: { status: 'rejected' } });
    await store.append({ id: laterId, lineageId, agentId: 'agent-one',
      createdAt: '2026-10-02T10:02:00.000Z', text: 'A fact learned after the checkpoint.' });
    const expectedCurrent = await store.getRollbackCheckpoint({ lineageId });

    const result = await store.restoreRollbackCheckpoint({ lineageId, checkpoint, expectedCurrent,
      by: 'owner:qa', why: 'Return the memory store to the reviewed point.',
      createdAt: '2026-10-03T10:00:00.000Z', assertAuthorized: authorize });

    assert.equal(result.restored, true);
    assert.equal(result.changedRecords, 2);
    assert.ok(result.current.sequence > expectedCurrent.sequence);
    const restored = await store.getById({ lineageId, id: restoredId, depth: 1 });
    assert.equal(restored.text, 'Use the staging workspace.');
    assert.equal(restored.status, 'conditional');
    assert.equal(restored.valid_while, 'the owner has not approved production');
    assert.equal(restored.verify_by, '2027-01-01');
    assert.equal(restored.revision, 2);
    assert.deepEqual(restored.revisions.map((revision) => revision.why), [
      'Owner changed the condition.', 'Return the memory store to the reviewed point.'
    ]);
    assert.equal((await store.getById({ lineageId, id: rejectedId })).status, 'rejected');
    assert.equal((await store.getById({ lineageId, id: laterId })).status, 'historical');

    const files = await store.listFiles({ lineageId });
    const allEvents = files.flatMap((file) => JSON.parse(file.content.toString('utf8')).entries);
    assert.deepEqual(allEvents.map((event) => event.audit.sequence),
      Array.from({ length: result.current.sequence }, (_, index) => index + 1));
    assert.equal(allEvents.filter((event) => event.id === restoredId && event.kind !== 'revision').length, 1,
      'rollback keeps the original memory ID and base event');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('memory rollback requires an owner, exact current head, and one atomic authorization commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-rollback-guard-'));
  const store = new DatedMemoryStore({ root });
  const id = 'memory-dddddddd-4444-4444-8444-dddddddddddd';
  try {
    await store.append({ id, lineageId, agentId: 'agent-one',
      createdAt: '2026-10-01T10:00:00.000Z', text: 'The approved value.' });
    const checkpoint = await store.getRollbackCheckpoint({ lineageId });
    await store.appendRevision({ lineageId, id, expectedRevision: 0,
      createdAt: '2026-10-02T10:00:00.000Z', by: 'owner:qa', why: 'Changed value.',
      changes: { text: 'The changed value.' } });
    const head = await store.getRollbackCheckpoint({ lineageId });

    const args = { lineageId, checkpoint, expectedCurrent: head, by: 'owner:qa',
      why: 'Restore the reviewed value.', createdAt: '2026-10-03T10:00:00.000Z' };
    await assert.rejects(store.restoreRollbackCheckpoint({ ...args, by: 'agent-one', assertAuthorized: () => true }), /authenticated owner/);
    await assert.rejects(store.restoreRollbackCheckpoint(args), /explicit owner authorization/);
    await assert.rejects(store.restoreRollbackCheckpoint({ ...args,
      checkpoint: { ...checkpoint, hash: 'f'.repeat(64) }, assertAuthorized: () => true }),
    (error) => error.status === 409 && error.code === 'MEMORY_CHECKPOINT_UNAVAILABLE');

    const staleWrite = await store.getRollbackCheckpoint({ lineageId });
    await store.append({ lineageId, agentId: 'agent-one', createdAt: '2026-10-02T10:01:00.000Z',
      text: 'A concurrent memory update.' });
    await assert.rejects(store.restoreRollbackCheckpoint({ ...args, expectedCurrent: staleWrite, assertAuthorized: () => true }),
      (error) => error.status === 409 && error.code === 'MEMORY_ROLLBACK_STALE');

    const current = await store.getRollbackCheckpoint({ lineageId });
    let authorizationChecks = 0;
    await assert.rejects(store.restoreRollbackCheckpoint({ ...args, expectedCurrent: current,
      assertAuthorized() { authorizationChecks += 1; if (authorizationChecks === 2) throw new Error('authorization revoked'); } }),
    /authorization revoked/);
    assert.equal(authorizationChecks, 2);
    assert.equal((await store.getRollbackCheckpoint({ lineageId })).hash, current.hash,
      'failed authorization leaves all canonical logs untouched');
    assert.equal((await store.getById({ lineageId, id })).text, 'The changed value.');
  } finally { await rm(root, { recursive: true, force: true }); }
});
