import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { encryptBackup } from '../lib/backup.mjs';
import { CONTINUITY_CATEGORIES, REQUIRED_CONTINUITY_CATEGORIES, createContinuityPackage } from '../lib/continuity-transfer.mjs';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { collectPortableFiles } from '../lib/portable-files.mjs';
import { drillEncryptedBackup } from '../lib/restore-drill.mjs';
import { createWholeAppManifest, wholeAppBackupAreas } from '../lib/whole-app-backup.mjs';

const passphrase = 'restore drill passphrase';
const textSha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

test('whole-app restore drill materializes only a disposable copy and catches damage', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-drill-source-'));
  try {
    const roots = Object.fromEntries(wholeAppBackupAreas.map((area) => [area, path.join(source, area)]));
    for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
    const liveFile = path.join(roots.workspace, 'leave-live-data-alone.txt');
    await writeFile(liveFile, 'owner private original');
    const payload = { agents: [], rooms: [], privateFiles: await collectPortableFiles(roots), backup: { format: 'hexigrid-local-data', version: 3 } };
    payload.backup.manifest = createWholeAppManifest(payload);
    const envelope = encryptBackup(payload, passphrase);
    const result = await drillEncryptedBackup({ envelope, passphrase });
    assert.deepEqual(result, { format: 'whole-app-snapshot', verified: true, stateReadBack: true,
      restoredFiles: 1, restoredBytes: 22, areas: 5 });
    assert.equal(await readFile(liveFile, 'utf8'), 'owner private original');
    assert.doesNotMatch(JSON.stringify(result), /owner private original|leave-live-data-alone/);
    await assert.rejects(drillEncryptedBackup({ envelope: { ...envelope, tag: 'tampered' }, passphrase }), /incorrect|damaged/);
    const broken = structuredClone(payload);
    broken.privateFiles.files[0].data = Buffer.from('bad').toString('base64');
    await assert.rejects(drillEncryptedBackup({ envelope: encryptBackup(broken, passphrase), passphrase }), /integrity|verification/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('continuity drill verifies the encrypted package without activating its lineage', async () => {
  const snapshot = { source: { framework: 'ilands', externalId: 'source-test', name: 'Example' },
    categories: Object.fromEntries(CONTINUITY_CATEGORIES.map((name) => [name, { status: REQUIRED_CONTINUITY_CATEGORIES.includes(name) ? 'complete' : 'unavailable', data: { name } }])) };
  const envelope = createContinuityPackage(snapshot, passphrase);
  const result = await drillEncryptedBackup({ envelope, passphrase });
  assert.equal(result.format, 'continuity-package');
  assert.equal(result.verified, true);
  assert.equal(result.checkOnly, true);
  assert.equal(result.complete, true);
  assert.equal(result.contentFiles, 0);
  assert.doesNotMatch(JSON.stringify(result), /Example|source-test/);
  await assert.rejects(drillEncryptedBackup({ envelope, passphrase: 'another long passphrase' }), /incorrect|damaged/);
});

test('explicit restore checks verify identity anchors and reject missing anchors', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-drill-checks-'));
  const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
  const anchorId = 'memory-11111111-1111-4111-8111-111111111111';
  const factId = 'memory-22222222-2222-4222-8222-222222222222';
  try {
    const roots = Object.fromEntries(wholeAppBackupAreas.map((area) => [area, path.join(source, area)]));
    const store = new DatedMemoryStore({ root: roots['dated-memory'] });
    await store.append({ lineageId, agentId: 'agent-exampleagent', date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z',
      id: anchorId, text: 'Private identity fact', contextScope: { projectId: 'owner' }, identityAnchor: true });
    await store.append({ lineageId, agentId: 'agent-exampleagent', date: '2026-01-01', createdAt: '2026-01-01T00:00:01.000Z',
      id: factId, text: 'Private key fact' });
    for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
    const payload = { agents: [{ id: 'agent-exampleagent', name: 'ExampleAgent', continuityLineage: { id: lineageId } }], rooms: [],
      privateFiles: await collectPortableFiles(roots), backup: { format: 'hexigrid-local-data', version: 3 } };
    payload.backup.manifest = createWholeAppManifest(payload);
    const envelope = encryptBackup(payload, passphrase);
    const checks = { agentId: 'agent-exampleagent', name: 'ExampleAgent',
      anchors: [{ id: anchorId, textSha256: textSha256('Private identity fact') }],
      keyFacts: [{ id: factId, textSha256: textSha256('Private key fact') }] };
    const result = await drillEncryptedBackup({ envelope, passphrase, checks });
    assert.deepEqual(result.checks, { passed: 4, total: 4 });
    await assert.rejects(drillEncryptedBackup({ envelope, passphrase, checks: { ...checks, anchors: [] } }), /require an agent, anchors, and key facts/);
    await assert.rejects(drillEncryptedBackup({ envelope, passphrase, checks: { ...checks,
      anchors: [{ id: 'memory-33333333-3333-4333-8333-333333333333', textSha256: checks.anchors[0].textSha256 }] } }), /identity anchor/);
    await assert.rejects(drillEncryptedBackup({ envelope, passphrase, checks: { ...checks,
      keyFacts: [{ id: factId, textSha256: textSha256('Changed key fact') }] } }), /key fact/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('on-demand command takes passphrase from stdin and prints counts only', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-drill-cli-'));
  try {
    const roots = Object.fromEntries(wholeAppBackupAreas.map((area) => [area, path.join(source, area)]));
    for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
    const payload = { agents: [], rooms: [], privateFiles: await collectPortableFiles(roots), backup: { format: 'hexigrid-local-data', version: 3 } };
    payload.backup.manifest = createWholeAppManifest(payload);
    const file = path.join(source, 'snapshot.json');
    await writeFile(file, JSON.stringify(encryptBackup(payload, passphrase)));
    const child = spawn(process.execPath, ['scripts/restore-drill.mjs', file], { cwd: path.resolve(''), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.stdin.end(JSON.stringify({ passphrase }));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, error);
    assert.equal(JSON.parse(output).verified, true);
    assert.doesNotMatch(output + error, /restore drill passphrase/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'hexigrid-backup');
  } finally { await rm(source, { recursive: true, force: true }); }
});
