import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONTINUITY_CATEGORIES, REQUIRED_CONTINUITY_CATEGORIES, createContinuityPackage, openContinuityPackage, publicContinuityTransfer } from '../lib/continuity-transfer.mjs';
import { normalizeContinuityPath, scanContinuitySecrets } from '../lib/continuity-security.mjs';
import { lineageActiveAgents, stageContinuityRestore } from '../lib/continuity-lineage.mjs';
import { createMemorySyncManifest } from '../lib/memory-sync.mjs';

function snapshot(status = 'complete') {
  return { source: { framework: 'ilands', externalId: 'source-test', name: 'Continuity Test' }, categories: Object.fromEntries(CONTINUITY_CATEGORIES.map((name) => [name, { status: REQUIRED_CONTINUITY_CATEGORIES.includes(name) ? status : 'unavailable', summary: name, data: { name } }])) };
}

test('continuity package refuses incomplete required categories', () => {
  assert.throws(() => createContinuityPackage(snapshot('partial'), 'a sufficiently long passphrase'), /transfer stopped/);
});

test('v2 continuity package is encrypted, signed, portable, deterministic inside, and model neutral', () => {
  const source = snapshot();
  const envelope = createContinuityPackage(source, 'a sufficiently long passphrase', {
    runtime: { model: 'source-model', provider: 'source-provider', harness: 'source-harness', framework: 'source-framework' },
    contentFiles: [{ path: 'notes/identity.md', mediaType: 'text/markdown', content: '# Identity\nPortable.' }]
  });
  assert.equal(envelope.version, 2);
  assert.equal(JSON.stringify(envelope).includes('Continuity Test'), false);
  const opened = openContinuityPackage(envelope, 'a sufficiently long passphrase');
  assert.equal(opened.snapshot.source.name, 'Continuity Test'); assert.equal(opened.completeness.complete, true);
  assert.deepEqual(opened.manifest.runtime, { model: 'source-model', provider: 'source-provider', harness: 'source-harness', framework: 'source-framework' });
  assert.equal(opened.contentFiles[0].path, 'notes/identity.md');
  for (const category of CONTINUITY_CATEGORIES) {
    assert.equal(opened.snapshot.categories[category].status, source.categories[category].status);
    assert.equal(opened.snapshot.categories[category].summary, source.categories[category].summary);
    assert.deepEqual(opened.snapshot.categories[category].data, source.categories[category].data);
  }
  assert.throws(() => openContinuityPackage(envelope, 'the wrong passphrase indeed'));
  assert.throws(() => openContinuityPackage({ ...envelope, data: `${envelope.data.slice(0, -2)}aa` }, 'a sufficiently long passphrase'));
  assert.throws(() => openContinuityPackage({ ...envelope, backupId: 'continuity-backup-substituted' }, 'a sufficiently long passphrase'), /identity was changed/);
});

test('legacy v1 packages remain readable', () => {
  const envelope = createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { version: 1 });
  assert.equal(envelope.version, 1);
  const opened = openContinuityPackage(envelope, 'a sufficiently long passphrase');
  assert.equal(opened.manifest.schemaVersion, 1);
  assert.equal(opened.snapshot.source.name, 'Continuity Test');
});

test('v2 package signs a suspended incremental memory-sync manifest without embedding private logs', () => {
  const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
  const memorySyncManifest = createMemorySyncManifest({ lineageId, sourceAgentId: 'agent-source', sourceActivityState: 'suspended', files: [{ path: `${lineageId}/2026-09-21.json`, bytes: 12, sha256: 'a'.repeat(64) }] });
  const envelope = createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { lineage: { id: lineageId, sourceAgentId: 'agent-source', sourceActivityState: 'suspended' }, memorySyncManifest });
  assert.doesNotMatch(JSON.stringify(envelope), /2026-09-21\.json/);
  const opened = openContinuityPackage(envelope, 'a sufficiently long passphrase');
  assert.deepEqual(opened.manifest.memorySync, memorySyncManifest);
  assert.throws(() => createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { lineage: { id: lineageId, sourceActivityState: 'suspended' }, memorySyncManifest: { ...memorySyncManifest, rootDigest: 'b'.repeat(64) } }), /digest/);
});

test('recursive safety scan fails closed without echoing secret values', () => {
  const secrets = [
    ['private key', ['-----BEGIN ', 'PRIVATE KEY-----\nnot-a-real-key'].join('')],
    ['token', ['sk-', 'thisIsOnlyATestTokenValue123456789'].join('')],
    ['jwt', 'eyJabcdefghijk.abcdefghijkl.abcdefghijkl'],
    ['authorization', 'Bearer testCredentialValue123456789'],
    ['credential assignment', 'password=not-a-real-password'],
    ['url credential', 'https://person:not-a-real-password@example.invalid/path'],
    ['wallet phrase', 'seed phrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima']
  ];
  for (const [label, secret] of secrets) {
    const findings = scanContinuitySecrets({ nested: [{ note: secret }] });
    assert.ok(findings.length > 0, label);
    let error;
    try {
      const unsafe = snapshot(); unsafe.categories.memories.data = { nested: { note: secret } };
      createContinuityPackage(unsafe, 'a sufficiently long passphrase');
    } catch (caught) { error = caught; }
    assert.equal(error?.code, 'CONTINUITY_SECRET', label);
    assert.equal(JSON.stringify({ message: error.message, code: error.code, findings: error.findings }).includes(secret), false, label);
  }
  assert.ok(scanContinuitySecrets({ api_key: 'not-a-real-key-value' }).length > 0);
});

test('content paths, types, counts, and byte limits fail closed', () => {
  for (const unsafePath of ['../escape.md', '/absolute.md', 'C:/absolute.md', '.env', 'credentials.json', 'script.js']) {
    assert.throws(() => normalizeContinuityPath(unsafePath));
  }
  assert.equal(normalizeContinuityPath('notes/identity.md'), 'notes/identity.md');
  assert.throws(() => createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { contentFiles: [{ path: 'notes/a.md', mediaType: 'text/html', content: 'hello' }] }), /JSON, Markdown, or plain text/);
  assert.throws(() => createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { contentFiles: [{ path: 'notes/link.md', mediaType: 'text/markdown', content: 'hello', type: 'symlink', target: '../outside' }] }), /symbolic links/);
  assert.throws(() => createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { contentFiles: Array.from({ length: 65 }, (_, index) => ({ path: `notes/${index}.md`, mediaType: 'text/markdown', content: 'x' })) }), /at most 64/);
  assert.throws(() => createContinuityPackage(snapshot(), 'a sufficiently long passphrase', { contentFiles: [{ path: 'notes/large.md', mediaType: 'text/markdown', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] }), /larger than 2 MB/);
});

test('lineage restore is single-active, explicit, idempotent, and rollback-safe', () => {
  const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
  const source = { id: 'agent-source', continuityLineage: { id: lineageId, generation: 0, activityState: 'active', activeAgentId: 'agent-source' } };
  const manifest = { backupId: 'continuity-backup-test', lineage: { id: lineageId, generation: 0, sourceAgentId: source.id, sourceActivityState: 'active' } };
  const restored = { id: 'agent-restored', name: 'Restored' };
  assert.throws(() => stageContinuityRestore({ agents: [source], restoredAgent: restored, manifest }), (error) => error.code === 'CONTINUITY_SOURCE_ACTIVE');
  const moved = stageContinuityRestore({ agents: [source], restoredAgent: restored, manifest, moveActivity: true });
  assert.equal(lineageActiveAgents(moved.agents, lineageId).length, 1);
  assert.equal(lineageActiveAgents(moved.agents, lineageId)[0].id, restored.id);
  assert.equal(moved.agents.find((agent) => agent.id === source.id).continuityLineage.activityState, 'suspended');
  const repeated = stageContinuityRestore({ agents: moved.agents, restoredAgent: { id: 'different-id' }, manifest, moveActivity: true });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.agent.id, restored.id);
  const original = structuredClone([source]);
  assert.throws(() => stageContinuityRestore({ agents: original, restoredAgent: restored, manifest, moveActivity: true, failAt: 'after-suspend' }), /Injected/);
  assert.deepEqual(original, [source]);
});

test('continuity cryptography module has no network or filesystem write path', async () => {
  const source = await readFile(new URL('../lib/continuity-transfer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:http|https|net|tls)|\bfetch\s*\(|writeFile|createWriteStream/);
});

test('public transfer omits snapshots, encrypted package bodies, and private memory manifests', () => {
  const record = publicContinuityTransfer({ id: 'transfer-1', agentId: 'agent-1', status: 'exported', snapshot: { secret: true }, envelope: { ciphertext: 'secret' }, memorySyncManifest: { files: [{ path: 'private' }] } });
  assert.equal('snapshot' in record, false); assert.equal('envelope' in record, false); assert.equal('memorySyncManifest' in record, false);
});
