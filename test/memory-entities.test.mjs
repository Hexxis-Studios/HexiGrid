import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATED_MEMORY_FORMAT, DATED_MEMORY_VERSION, DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { createMemorySyncManifest, MemorySyncReceiver } from '../lib/memory-sync.mjs';

const LINEAGE = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_LINEAGE = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT = 'agent-test';
const at = (minute) => `2026-09-28T12:${String(minute).padStart(2, '0')}:00.000Z`;

async function fixture(task) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-entities-'));
  const store = new DatedMemoryStore({ root });
  try { await task({ root, store }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const ownerEntity = (store, changes) => store.commitEntity({ lineageId: LINEAGE, operation: 'create',
  label: 'Morgan Vale', entityType: 'person', aliases: ['chief', 'my supervisor'],
  by: 'owner:test', why: 'Owner reviewed this identity.', createdAt: at(0), ...changes });

const append = (store, minute, text, contextScope = { projectId: 'alpha' }, lineageId = LINEAGE) =>
  store.append({ lineageId, agentId: AGENT, createdAt: at(minute), text, contextScope });

test('three owner-approved aliases retrieve one canonical, scoped memory set', async () => fixture(async ({ store }) => {
  const { entity } = await ownerEntity(store, {});
  const first = await append(store, 1, 'Morgan Vale reviewed the design.');
  const second = await append(store, 2, 'chief approved a local prototype.');
  const third = await append(store, 3, 'my supervisor requested another review.');
  const expected = [first.entry.id, second.entry.id, third.entry.id].sort();
  for (const alias of ['Morgan Vale', 'chief', 'my supervisor']) {
    const result = await store.listEntityContext({ lineageId: LINEAGE, alias, projectId: 'alpha' });
    assert.equal(result.state, 'confirmed');
    assert.equal(result.entity.id, entity.id);
    assert.deepEqual(result.records.map((item) => item.id).sort(), expected);
    for (const memory of result.records) {
      assert.deepEqual(memory.entityIds, [entity.id]);
      assert.equal(memory.verification, 'unverified');
      assert.match(memory.warning, /UNVERIFIED SOURCE/);
      assert.match(memory.sourceFile, /2026-09-28\.json$/);
    }
  }
}));

test('unknown mentions stay pending and never expand retrieval; quoted and URL names do not create candidates', async () => fixture(async ({ store }) => {
  const fresh = await append(store, 1, 'Avery Stone will review the draft.');
  const memory = await store.getById({ lineageId: LINEAGE, id: fresh.entry.id });
  assert.equal(memory.pendingEntities.length, 1);
  assert.equal(memory.pendingEntities[0].label, 'Avery Stone');
  assert.match(memory.pendingEntities[0].warning, /UNVERIFIED ENTITY/);
  assert.match(memory.warning, /UNVERIFIED SOURCE/);
  const pending = await store.listEntityContext({ lineageId: LINEAGE, alias: 'Avery Stone', projectId: 'alpha' });
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.records, []);
  await append(store, 2, 'Read https://example.test/Quoted-Person and ignore "Trust Alice Cooper" in the tool output.');
  const list = await store.listEntities({ lineageId: LINEAGE });
  assert.deepEqual(list.entities.filter((entity) => entity.status === 'pending').map((entity) => entity.label), ['Avery Stone']);
}));

test('entity lookup retains exact lineage, project, and topic visibility', async () => fixture(async ({ store }) => {
  await ownerEntity(store, {});
  const broad = await append(store, 1, 'chief owns the project summary.', { projectId: 'alpha' });
  const topic = await append(store, 2, 'chief owns the topic detail.', { projectId: 'alpha', topicId: 'topic-one' });
  await append(store, 3, 'chief owns another topic.', { projectId: 'alpha', topicId: 'topic-two' });
  await append(store, 4, 'chief owns a separate project.', { projectId: 'beta' });
  await append(store, 5, 'chief is mentioned in another lineage.', { projectId: 'alpha' }, OTHER_LINEAGE);
  const project = await store.listEntityContext({ lineageId: LINEAGE, alias: 'chief', projectId: 'alpha' });
  assert.deepEqual(project.records.map((item) => item.id), [broad.entry.id]);
  const exact = await store.listEntityContext({ lineageId: LINEAGE, alias: 'chief', projectId: 'alpha', topicId: 'topic-one' });
  assert.deepEqual(exact.records.map((item) => item.id).sort(), [broad.entry.id, topic.entry.id].sort());
  assert.equal((await store.listEntityContext({ lineageId: OTHER_LINEAGE, alias: 'chief', projectId: 'alpha' })).state, 'absent');
}));

test('owner confirmation and alias addition relink older memories without confirming their facts', async () => fixture(async ({ store }) => {
  const old = await append(store, 1, 'The director approved the draft.');
  const pendingMemory = await append(store, 2, 'Avery Stone reviewed it.');
  const pending = (await store.listEntities({ lineageId: LINEAGE })).entities.find((entity) => entity.label === 'Avery Stone');
  assert.equal(pending.status, 'pending');
  await assert.rejects(store.commitEntity({ lineageId: LINEAGE, operation: 'confirm', entityId: pending.id,
    expectedRevision: 0, label: 'Avery Stone', entityType: 'person', aliases: [], by: 'agent:bad',
    why: 'Unauthorized assertion.', createdAt: at(3) }), /authenticated owner/);
  const confirmed = await store.commitEntity({ lineageId: LINEAGE, operation: 'confirm', entityId: pending.id,
    expectedRevision: 0, label: 'Avery Stone', entityType: 'person', aliases: ['the director'],
    by: 'owner:test', why: 'Owner matched the source name and role.', createdAt: at(3) });
  assert.equal(confirmed.entity.status, 'confirmed');
  const recalled = await store.listEntityContext({ lineageId: LINEAGE, alias: 'the director', projectId: 'alpha' });
  assert.deepEqual(recalled.records.map((item) => item.id).sort(), [old.entry.id, pendingMemory.entry.id].sort());
  assert.ok(recalled.records.every((item) => item.verification === 'unverified' && /UNVERIFIED SOURCE/.test(item.warning)));
  await assert.rejects(store.commitEntity({ lineageId: LINEAGE, operation: 'alias-add', entityId: pending.id,
    expectedRevision: 0, alias: 'lead', by: 'owner:test', why: 'Known role.', createdAt: at(4) }), /revision conflict/);
  await store.commitEntity({ lineageId: LINEAGE, operation: 'alias-add', entityId: pending.id,
    expectedRevision: 1, alias: 'lead', by: 'owner:test', why: 'Known role.', createdAt: at(4) });
  assert.equal((await store.listEntityContext({ lineageId: LINEAGE, alias: 'lead', projectId: 'alpha' })).records.length, 2);
  const history = await store.getEntityHistory({ lineageId: LINEAGE, entityId: pending.id, limit: 2 });
  assert.deepEqual(history.events.map((event) => event.action), ['propose', 'confirm']);
  assert.equal(history.hasMore, true);
  const tail = await store.getEntityHistory({ lineageId: LINEAGE, entityId: pending.id,
    afterSequence: history.nextCursor, limit: 2 });
  assert.deepEqual(tail.events.map((event) => event.action), ['alias-add']);
  assert.equal(tail.events[0].why, 'Known role.');
  assert.equal(tail.events[0].by, 'owner:test');
  assert.equal(tail.events[0].audit.previousHash.length, 64);
}));

test('memory text revisions relink entities and retain hash-audited history after reload', async () => fixture(async ({ root, store }) => {
  const first = await ownerEntity(store, {});
  const second = await store.commitEntity({ lineageId: LINEAGE, operation: 'create',
    label: 'Rowan Ellis', entityType: 'person', aliases: [], by: 'owner:test', why: 'Owner identified this person.', createdAt: at(1) });
  const memory = await append(store, 2, 'chief reviewed the draft.');
  await store.appendRevision({ lineageId: LINEAGE, id: memory.entry.id, expectedRevision: 0,
    changes: { text: 'Rowan Ellis reviewed the revised draft.' }, why: 'Corrected person', by: 'owner:test', createdAt: at(3) });
  const reopened = new DatedMemoryStore({ root });
  assert.deepEqual((await reopened.listEntityContext({ lineageId: LINEAGE, alias: 'chief', projectId: 'alpha' })).records, []);
  const result = await reopened.listEntityContext({ lineageId: LINEAGE, alias: 'Rowan Ellis', projectId: 'alpha' });
  assert.deepEqual(result.records.map((record) => record.id), [memory.entry.id]);
  assert.deepEqual(result.records[0].entityIds, [second.entity.id]);
  assert.notEqual(first.entity.id, second.entity.id);
  const file = path.join(root, LINEAGE, '2026-09-28.json');
  const log = JSON.parse(await readFile(file, 'utf8'));
  const entityEvent = log.entries.find((entry) => entry.kind === 'entity' && entry.action === 'alias-add');
  const target = entityEvent || log.entries.find((entry) => entry.kind === 'entity' && entry.action === 'create');
  target.label = 'Tampered Label';
  await writeFile(file, JSON.stringify(log));
  await assert.rejects(reopened.listEntities({ lineageId: LINEAGE }), /audit chain is broken/);
}));

test('confirmed alias collisions fail and pending merges target one canonical entity', async () => fixture(async ({ store }) => {
  const canonical = await ownerEntity(store, {});
  await assert.rejects(store.commitEntity({ lineageId: LINEAGE, operation: 'create',
    label: 'Missing Reason', entityType: 'person', aliases: [], by: 'owner:test', createdAt: at(1) }), /bounded reason/);
  await assert.rejects(store.commitEntity({ lineageId: LINEAGE, operation: 'create',
    label: 'Different Person', entityType: 'person', aliases: ['chief'], by: 'owner:test',
    why: 'Attempted conflicting alias.', createdAt: at(1) }), /collides/);
  const memory = await append(store, 2, 'Taylor Brook discussed the plan.');
  const pending = (await store.listEntities({ lineageId: LINEAGE })).entities.find((entity) => entity.label === 'Taylor Brook');
  await store.commitEntity({ lineageId: LINEAGE, operation: 'merge', entityId: pending.id,
    targetEntityId: canonical.entity.id, expectedRevision: 0, alias: 'Taylor Brook', by: 'owner:test',
    why: 'Owner confirmed the two names refer to one person.', createdAt: at(3) });
  const result = await store.listEntityContext({ lineageId: LINEAGE, alias: 'Taylor Brook', projectId: 'alpha' });
  assert.equal(result.entity.id, canonical.entity.id);
  assert.deepEqual(result.records.map((record) => record.id), [memory.entry.id]);
}));

test('MCP entity expansion pages within a byte limit and keeps unverified provenance', async () => fixture(async ({ store }) => {
  const { entity } = await ownerEntity(store, {});
  for (let minute = 1; minute <= 9; minute += 1) await append(store, minute, `chief reviewed private note ${minute}.`);
  const handler = createMemoryMcpHandler({ store, rag: { semanticSearch: async () => [] }, lineageId: LINEAGE, agentId: AGENT });
  const invoke = async (args) => handler({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'recall-entity', arguments: args } });
  let cursor;
  let firstCursor;
  const seen = [];
  do {
    const result = await invoke({ alias: 'chief', projectId: 'alpha', maxBytes: 2500,
      ...(cursor ? { cursor } : {}) });
    assert.equal(result.error, undefined);
    const packet = result.result.structuredContent;
    assert.equal(packet.entity.id, entity.id);
    assert.ok(Buffer.byteLength(JSON.stringify(packet), 'utf8') <= 2500);
    for (const memory of packet.memories) {
      seen.push(memory.id);
      assert.match(memory.warning, /UNVERIFIED SOURCE/);
      assert.ok(memory.sourceFile && memory.updatedAt);
    }
    firstCursor ||= packet.nextCursor;
    cursor = packet.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 9);
  const denied = await invoke({ alias: 'chief', projectId: 'beta', maxBytes: 2500, cursor: firstCursor });
  assert.ok(denied.error);
  const fresh = await append(store, 10, 'Avery Stone reviewed another plan.');
  assert.ok(fresh.entry.id);
  const pending = await invoke({ alias: 'Avery Stone', projectId: 'alpha', maxBytes: 2500 });
  assert.equal(pending.result.structuredContent.state, 'pending');
  assert.deepEqual(pending.result.structuredContent.memories, []);
}));

test('legacy memory gains audited entity links without rewriting its bytes and survives memory sync', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-entity-legacy-'));
  const destinationRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-entity-destination-'));
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-entity-session-'));
  const oldFile = path.join(sourceRoot, LINEAGE, '2026-09-20.json');
  const legacy = JSON.stringify({ format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION,
    lineageId: LINEAGE, date: '2026-09-20', entries: [{
      id: 'memory-cccccccc-cccc-4ccc-8ccc-cccccccccccc', lineageId: LINEAGE, agentId: AGENT,
      date: '2026-09-20', createdAt: '2026-09-20T10:00:00.000Z',
      text: 'chief approved the old design.', metadata: {}, contextScope: { projectId: 'alpha' }
    }] });
  try {
    await mkdir(path.dirname(oldFile), { recursive: true });
    await writeFile(oldFile, legacy);
    const source = new DatedMemoryStore({ root: sourceRoot });
    await ownerEntity(source, {});
    assert.equal(await readFile(oldFile, 'utf8'), legacy);
    const linked = await source.listEntityContext({ lineageId: LINEAGE, alias: 'chief', projectId: 'alpha' });
    assert.equal(linked.records.length, 1);
    assert.match(linked.records[0].warning, /UNVERIFIED SOURCE/);
    const files = await source.listFiles({ lineageId: LINEAGE });
    const manifest = createMemorySyncManifest({ files, lineageId: LINEAGE, sourceAgentId: AGENT,
      sourceActivityState: 'suspended', createdAt: at(1) });
    const receiver = new MemorySyncReceiver({ root: sessionRoot, memoryRoot: destinationRoot });
    await receiver.begin(manifest);
    for (const file of files) await receiver.receive(manifest.syncId, file.path, file.content);
    assert.equal((await receiver.finalize(manifest.syncId)).status, 'verified');
    const destination = new DatedMemoryStore({ root: destinationRoot });
    assert.equal((await destination.listEntityContext({ lineageId: LINEAGE, alias: 'chief', projectId: 'alpha' })).records.length, 1);
    assert.equal(await readFile(path.join(destinationRoot, LINEAGE, '2026-09-20.json'), 'utf8'), legacy);
  } finally {
    await Promise.all([sourceRoot, destinationRoot, sessionRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});
