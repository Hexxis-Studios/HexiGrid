import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createMemorySyncManifest, MemorySyncReceiver } from '../lib/memory-sync.mjs';

const lineageId = 'lineage-44444444-4444-4444-8444-444444444444';

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-source-'));
  const destinationRoot = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-destination-'));
  const sessionRoot = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-session-'));
  const store = new DatedMemoryStore({ root: sourceRoot });
  await store.append({ lineageId, agentId: 'source-agent', createdAt: '2026-09-20T12:00:00.000Z', text: 'The bridge reconnect rule uses bounded backoff.' });
  await store.append({ lineageId, agentId: 'source-agent', createdAt: '2026-09-21T13:00:00.000Z', text: 'The destination remains asleep until every digest verifies.' });
  const files = await store.listFiles({ lineageId });
  const manifest = createMemorySyncManifest({ files, lineageId, sourceAgentId: 'source-agent', sourceActivityState: 'suspended', createdAt: '2026-09-21T14:00:00.000Z', syncId: 'memory-sync-55555555-5555-4555-8555-555555555555' });
  const receiver = new MemorySyncReceiver({ root: sessionRoot, memoryRoot: destinationRoot });
  return { sourceRoot, destinationRoot, sessionRoot, files, manifest, receiver, cleanup: () => Promise.all([sourceRoot, destinationRoot, sessionRoot].map((root) => rm(root, { recursive: true, force: true }))) };
}

test('memory sync stays awaiting until every file verifies, then commits byte-identical logs', async () => {
  const work = await fixture();
  try {
    const started = await work.receiver.begin(work.manifest);
    assert.equal(started.status, 'awaiting-sync');
    await work.receiver.receive(work.manifest.syncId, work.files[0].path, work.files[0].content);
    await assert.rejects(work.receiver.finalize(work.manifest.syncId), /incomplete/);
    assert.equal((await work.receiver.status(work.manifest.syncId)).status, 'awaiting-sync');
    await work.receiver.receive(work.manifest.syncId, work.files[1].path, work.files[1].content);
    const completed = await work.receiver.finalize(work.manifest.syncId);
    assert.equal(completed.status, 'verified');
    for (const file of work.files) {
      assert.deepEqual(await readFile(path.join(work.destinationRoot, ...file.path.split('/'))), file.content);
    }
  } finally { await work.cleanup(); }
});

test('memory sync is incremental and idempotent', async () => {
  const work = await fixture();
  try {
    await work.receiver.begin(work.manifest);
    for (const file of work.files) await work.receiver.receive(work.manifest.syncId, file.path, file.content);
    await work.receiver.finalize(work.manifest.syncId);
    assert.equal((await work.receiver.missing(work.manifest.syncId)).length, 0);
    assert.equal((await work.receiver.begin(work.manifest)).status, 'verified');
    assert.equal((await work.receiver.finalize(work.manifest.syncId)).status, 'verified');
  } finally { await work.cleanup(); }
});

test('retrying a verified sync rechecks files before profile activation', async () => {
  const work = await fixture();
  try {
    await work.receiver.begin(work.manifest);
    for (const file of work.files) await work.receiver.receive(work.manifest.syncId, file.path, file.content);
    const verified = await work.receiver.finalize(work.manifest.syncId);
    const resumed = new MemorySyncReceiver({ root: work.sessionRoot, memoryRoot: work.destinationRoot });
    assert.equal((await resumed.finalize(work.manifest.syncId)).verifiedAt, verified.verifiedAt);
    await writeFile(path.join(work.destinationRoot, ...work.files[0].path.split('/')), 'Altered after verification.');
    await assert.rejects(resumed.finalize(work.manifest.syncId), /incomplete/);
  } finally { await work.cleanup(); }
});

test('memory sync rejects a staged link that conflicts with existing local history before commit', async () => {
  const work = await fixture();
  const alternateRoot = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-alternate-'));
  try {
    const existing = work.files[0];
    const existingTarget = path.join(work.destinationRoot, ...existing.path.split('/'));
    await mkdir(path.dirname(existingTarget), { recursive: true });
    await writeFile(existingTarget, existing.content);

    const alternate = new DatedMemoryStore({ root: alternateRoot });
    await alternate.append({ lineageId, agentId: 'source-agent', createdAt: '2026-09-20T12:00:00.000Z', text: 'A different first fact.' });
    await alternate.append({ lineageId, agentId: 'source-agent', createdAt: '2026-09-21T13:00:00.000Z', text: 'This second fact points to the different first fact.' });
    const incoming = (await alternate.listFiles({ lineageId })).find((file) => file.path.endsWith('/2026-09-21.json'));
    const manifest = createMemorySyncManifest({ files: [incoming], lineageId, sourceAgentId: 'source-agent',
      syncId: 'memory-sync-66666666-6666-4666-8666-666666666666' });
    await work.receiver.begin(manifest);
    await work.receiver.receive(manifest.syncId, incoming.path, incoming.content);
    await assert.rejects(work.receiver.finalize(manifest.syncId), /Memory audit chain is broken/);
    assert.equal((await work.receiver.status(manifest.syncId)).status, 'awaiting-sync');
    assert.deepEqual(await readFile(existingTarget), existing.content);
    await assert.rejects(readFile(path.join(work.destinationRoot, ...incoming.path.split('/'))), { code: 'ENOENT' });
  } finally {
    await Promise.all([work.cleanup(), rm(alternateRoot, { recursive: true, force: true })]);
  }
});

test('memory sync rejects tampering, unrelated paths, and simulated interruption never verifies', async () => {
  const work = await fixture();
  try {
    await work.receiver.begin(work.manifest);
    await assert.rejects(work.receiver.receive(work.manifest.syncId, work.files[0].path, Buffer.from('tampered')), /digest verification/);
    await assert.rejects(work.receiver.receive(work.manifest.syncId, '../outside.json', work.files[0].content), /not part/);
    for (const file of work.files) await work.receiver.receive(work.manifest.syncId, file.path, file.content);
    await assert.rejects(work.receiver.finalize(work.manifest.syncId, { failAt: 'before-commit' }), /Injected/);
    assert.equal((await work.receiver.status(work.manifest.syncId)).status, 'awaiting-sync');
    assert.equal((await work.receiver.finalize(work.manifest.syncId)).status, 'verified');
  } finally { await work.cleanup(); }
});
