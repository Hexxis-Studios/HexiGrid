import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownerAgentAuthorized, readOwnerAgentFile, runOwnerAgentProcess, setOwnerAgentTrust, writeOwnerAgentFile } from '../lib/owner-agent-access.mjs';

const connection = () => ({ id: 'link-owner-test', status: 'connected', trustLevel: 'scoped', capabilities: ['messages'] });
const bridge = { enabled: true, ownerApproved: true, agentControlActive: true, linkId: 'link-owner-test' };

test('owner tools deny scoped, inactive, different-Link and revoked access', () => {
  const link = connection();
  assert.throws(() => ownerAgentAuthorized(link, bridge, 'owner-process'), /not granted/);
  setOwnerAgentTrust(link, 'owner');
  assert.throws(() => ownerAgentAuthorized(link, { ...bridge, enabled: false }, 'owner-process'), /Start computer access/);
  assert.throws(() => ownerAgentAuthorized(link, { ...bridge, agentControlActive: false }, 'owner-process'), /Start computer access/);
  assert.throws(() => ownerAgentAuthorized(link, { ...bridge, linkId: 'another-link' }, 'owner-process'), /Start computer access/);
  link.status = 'revoked';
  assert.throws(() => ownerAgentAuthorized(link, bridge, 'owner-process'), /not granted/);
});

test('owner trust is explicit and reversible without changing the original scopes', () => {
  const link = connection();
  assert.equal(setOwnerAgentTrust(link, 'owner').trustLevel, 'owner');
  ownerAgentAuthorized(link, bridge, 'owner-process');
  assert.equal(setOwnerAgentTrust(link, 'scoped').trustLevel, 'scoped');
  assert.deepEqual(link.capabilities, ['messages']);
  assert.throws(() => ownerAgentAuthorized(link, bridge, 'owner-process'), /not granted/);
});

test('owner file transfer handles binary bytes and rejects stale replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-owner-agent-'));
  try {
    const target = path.join(directory, 'qa.bin');
    const first = Buffer.from([0, 255, 9, 10]);
    const created = await writeOwnerAgentFile({ path: target, data: first.toString('base64'), createOnly: true });
    assert.equal(created.created, true);
    assert.deepEqual(await readFile(target), first);
    const read = await readOwnerAgentFile(target, { offset: 1, length: 2 });
    assert.deepEqual(Buffer.from(read.data, 'base64'), Buffer.from([255, 9]));
    await assert.rejects(writeOwnerAgentFile({ path: target, data: 'QQ==', expectedSha256: '0'.repeat(64) }), /changed/);
    const replaced = await writeOwnerAgentFile({ path: target, data: 'QQ==', expectedSha256: created.sha256 });
    assert.equal(replaced.created, false);
    assert.deepEqual(await readFile(target), Buffer.from('A'));
    const appended = await writeOwnerAgentFile({ path: target, data: 'Qg==', append: true, expectedSha256: replaced.sha256 });
    assert.equal(appended.size, 2);
    assert.deepEqual(await readFile(target), Buffer.from('AB'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('owner process runs without a shell and returns a bounded receipt', async () => {
  const result = await runOwnerAgentProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("owner-door-ok")'], timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'owner-door-ok');
  assert.equal(result.stderr, '');
});
