import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';

test('hard deletion removes only the selected fact and reports unknown ids', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-erasure-'));
  try {
    const store = new DatedMemoryStore({ root });
    const lineageId = 'lineage-12345678-1234-1234-1234-123456789abc';
    const createdAt = '2026-10-04T12:00:00.000Z';
    const first = 'memory-12345678-1234-1234-1234-123456789abc';
    const second = 'memory-22345678-1234-1234-1234-123456789abc';
    await store.append({ lineageId, agentId: 'agent-a', date: '2026-10-04', createdAt, id: first, text: 'private erased content', originKind: 'owner-entry' });
    await store.append({ lineageId, agentId: 'agent-a', date: '2026-10-04', createdAt, id: second, text: 'unrelated retained fact', originKind: 'owner-entry' });
    assert.equal(await store.hardDelete({ lineageId, id: first }), true);
    assert.equal(await store.getById({ lineageId, id: first }), null);
    assert.match((await store.getById({ lineageId, id: second })).text, /unrelated retained fact/);
    assert.equal(await store.hardDelete({ lineageId, id: first }), false);
    const range = await store.readRange({ lineageId, from: '2026-10-04', to: '2026-10-04' });
    assert.deepEqual(range.map((item) => item.id), [second]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const lineageId = 'lineage-12345678-1234-1234-1234-123456789abc';
const firstId = 'memory-12345678-1234-1234-1234-123456789abc';
const secondId = 'memory-22345678-1234-1234-1234-123456789abc';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-erasure-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new DatedMemoryStore({ root }) };
}
async function append(store, id = firstId, date = '2026-10-04', text = 'disposable erased fact') {
  await store.append({ lineageId, agentId: 'qa', id, date, createdAt: `${date}T12:00:00.000Z`, text, originKind: 'owner-entry', contextScope: { projectId: 'erasure-qa' } });
}

test('erasing the final fact clears its file and remains erased after reopening', async t => {
  const { root, store } = await fixture(t);
  await append(store);
  assert.equal(await store.hardDelete({ lineageId, id: firstId }), true);
  assert.equal(await new DatedMemoryStore({ root }).getById({ lineageId, id: firstId }), null);
  const bytes = await readFile(path.join(root, lineageId, '2026-10-04.json'), 'utf8');
  assert.equal(bytes.includes('disposable erased fact'), false);
  assert.deepEqual(JSON.parse(bytes).entries, []);
});

test('erasure removes revisions on emptied dates and preserves another date after reopening', async t => {
  const { root, store } = await fixture(t);
  await append(store, firstId, '2026-10-02');
  await store.appendRevision({ lineageId, id: firstId, expectedRevision: 0, createdAt: '2026-10-03T12:00:00.000Z',
    by: 'owner:qa', why: 'disposable correction', changes: { text: 'disposable revised fact' } });
  await append(store, secondId, '2026-10-04', 'retained fact');
  await store.hardDelete({ lineageId, id: firstId });
  const reopened = new DatedMemoryStore({ root });
  assert.equal(await reopened.getById({ lineageId, id: firstId, depth: 2 }), null);
  assert.equal((await reopened.getById({ lineageId, id: secondId })).text, 'retained fact');
  for (const date of ['2026-10-02', '2026-10-03']) {
    assert.deepEqual(JSON.parse(await readFile(path.join(root, lineageId, `${date}.json`), 'utf8')).entries, []);
  }
});

test('revocation before a later rename rolls back earlier erasure writes', async t => {
  const { root, store } = await fixture(t);
  await append(store, firstId, '2026-10-03');
  await append(store, secondId, '2026-10-04', 'retained fact');
  let checks = 0;
  await assert.rejects(store.hardDelete({ lineageId, id: firstId, assertAuthorized() {
    if (++checks === 3) throw Object.assign(new Error('revoked'), { status: 403 });
  } }), /revoked/);
  const reopened = new DatedMemoryStore({ root });
  assert.equal((await reopened.getById({ lineageId, id: firstId })).text, 'disposable erased fact');
  assert.equal((await reopened.getById({ lineageId, id: secondId })).text, 'retained fact');
});

for (const eraseSuccessor of [true, false]) {
  test(`erasing a supersession ${eraseSuccessor ? 'successor' : 'predecessor'} retains standing and revision order`, async t => {
    const { root, store } = await fixture(t);
    await append(store);
    await store.append({ lineageId, agentId: 'qa', id: secondId, date: '2026-10-04',
      createdAt: '2026-10-04T12:00:00.000Z', text: 'retained predecessor', originKind: 'owner-entry',
      contextScope: { projectId: 'erasure-qa' } });
    await store.appendVerification({lineageId,id:secondId,expectedRevision:0,by:'owner:qa',why:'retained verification',createdAt:'2026-10-04T12:30:00.000Z'});
    const link = await store.appendConflictLink({ lineageId, fromId: firstId, toId: secondId, relation: 'supersedes',
      valid_from: '2026-10-04T12:00:00.000Z', expectedFromRevision: 0, expectedToRevision: 1,
      by: 'owner:qa', why: 'disposable erased relationship text',
      evidence: { kind: 'owner-feedback', text: 'disposable erased relationship evidence' },
      createdAt: '2026-10-04T13:00:00.000Z' });
    const erasedId = eraseSuccessor ? firstId : secondId;
    const retainedId = eraseSuccessor ? secondId : firstId;
    if (eraseSuccessor) await store.appendRevision({ lineageId, id: secondId, expectedRevision: 2,
      by: 'owner:qa', why: 'retained later edit', changes: { metadata: { note: 'retained' } },
      createdAt: '2026-10-05T12:00:00.000Z' });
    const before = await store.getById({ lineageId, id: retainedId, depth: 2 });
    assert.equal(await store.hardDelete({ lineageId, id: erasedId }), true);
    const reopened = new DatedMemoryStore({ root });
    assert.equal(await reopened.getById({ lineageId, id: erasedId, depth: 2 }), null);
    const after = await reopened.getById({ lineageId, id: retainedId, depth: 2 });
    for (const key of ['text','status','verification','valid_from','valid_until','revision','updatedAt'])
      assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.conflicts ?? [], []);
    if (eraseSuccessor) {
      assert.equal(after.status, 'superseded'); assert.equal(after.verification, 'unverified');
      assert.equal(after.revisions[1].id, before.revisions[1].id);
      assert.deepEqual(after.revisions[1].changes, before.revisions[1].changes);
      assert.deepEqual(after.revisions[1].previous, before.revisions[1].previous);
      assert.equal(after.revisions[1].causedByConflictId, undefined);
    }
    for (const date of ['2026-10-04', ...(eraseSuccessor ? ['2026-10-05'] : [])]) {
      const bytes = await readFile(path.join(root,lineageId,`${date}.json`),'utf8');
      assert.equal(bytes.includes(erasedId), false); assert.equal(bytes.includes(link.id), false);
      assert.equal(bytes.includes('disposable erased relationship'), false);
    }
    await reopened.appendRevision({ lineageId, id: retainedId, expectedRevision: after.revision,
      by: 'owner:qa', why: 'later retained metadata', changes: { metadata: { note: 'next' } },
      createdAt: '2026-10-06T12:00:00.000Z' });
    assert.equal((await reopened.getById({lineageId,id:retainedId})).revision,after.revision+1);
  });
}

for (const eraseSource of [true, false]) {
  test(`erasing a contradiction ${eraseSource ? 'source' : 'target'} preserves surviving revisions and unrelated links`, async t => {
    const { root, store } = await fixture(t);
    const thirdId = 'memory-32345678-1234-1234-1234-123456789abc';
    await append(store, firstId, '2026-10-02');
    await append(store, secondId, '2026-10-02', 'retained fact');
    await append(store, thirdId, '2026-10-02', 'another retained fact');
    const erasedLink = await store.appendConflictLink({ lineageId,
      fromId: eraseSource ? firstId : secondId, toId: eraseSource ? secondId : firstId,
      relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0,
      by: 'owner:qa', why: 'disposable erased relationship',
      evidence: { kind: 'owner-feedback', text: 'disposable erased relationship evidence' },
      createdAt: '2026-10-03T12:00:00.000Z' });
    await store.appendConflictLink({ lineageId, fromId: secondId, toId: thirdId,
      relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0,
      by: 'owner:qa', why: 'retained relationship',
      evidence: { kind: 'owner-feedback', text: 'retained relationship evidence' },
      createdAt: '2026-10-03T13:00:00.000Z' });
    await store.appendRevision({ lineageId, id: secondId, expectedRevision: 0,
      by: 'owner:qa', why: 'retained correction', changes: { text: 'corrected retained fact' },
      createdAt: '2026-10-04T12:00:00.000Z' });
    const before = await store.getById({ lineageId, id: secondId, depth: 2 });
    assert.equal(await store.hardDelete({ lineageId, id: firstId.toUpperCase() }), true);
    const reopened = new DatedMemoryStore({ root });
    assert.equal(await reopened.getById({ lineageId, id: firstId, depth: 2 }), null);
    const after = await reopened.getById({ lineageId, id: secondId, depth: 2 });
    assert.equal(after.text, before.text);
    assert.equal(after.status, before.status);
    assert.equal(after.revision, before.revision);
    assert.equal(after.updatedAt, before.updatedAt);
    const withoutAudit = ({ audit, ...value }) => value;
    assert.deepEqual(after.revisions.map(withoutAudit), before.revisions.map(withoutAudit));
    assert.deepEqual(after.conflicts.map(withoutAudit), before.conflicts.filter(link => link.id !== erasedLink.id).map(withoutAudit));
    assert.equal(after.conflictCount, 1);
    for (const date of ['2026-10-02', '2026-10-03', '2026-10-04']) {
      const bytes = await readFile(path.join(root, lineageId, `${date}.json`), 'utf8');
      assert.equal(bytes.includes(firstId), false);
      assert.equal(bytes.includes('disposable erased'), false);
    }
    await reopened.appendRevision({ lineageId, id: secondId, expectedRevision: after.revision,
      by: 'owner:qa', why: 'ordinary later edit', changes: { valid_while: 'local QA remains active' },
      createdAt: '2026-10-04T13:00:00.000Z' });
    assert.equal((await reopened.getById({ lineageId, id: thirdId })).text, 'another retained fact');
  });
}


test('shared entity erasure still refuses before changing canonical bytes', async t => {
  const {root,store}=await fixture(t);
  await append(store,firstId,'2026-10-04','Morgan Vale requested a review.');
  await append(store,secondId,'2026-10-04','Morgan Vale approved the design.');
  const file=path.join(root,lineageId,'2026-10-04.json'),before=await readFile(file);
  await assert.rejects(store.hardDelete({lineageId,id:firstId}),error=>error.status===409);
  assert.deepEqual(await readFile(file),before);
  assert.ok(await new DatedMemoryStore({root}).getById({lineageId,id:firstId}));
});
