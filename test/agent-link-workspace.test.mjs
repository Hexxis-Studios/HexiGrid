import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { listAgentLinkWorkspace, readAgentLinkWorkspaceFile, writeAgentLinkWorkspaceFile } from '../lib/agent-link-workspace.mjs';

let root = '';
async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-link-workspace-'));
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'README.md'), 'local project text\n');
  await writeFile(path.join(root, '.env'), 'OWNER_SECRET=never-forward\n');
  await writeFile(path.join(root, 'data', 'private.json'), '{"token":"never-forward"}\n');
  return root;
}

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

test('owner workspace options preserve scoped defaults, safely create parents and reject stale edits',async()=>{
 const workspace=await fixture();const owner={allowPrivatePaths:true,createDirectories:true};
 const first=await writeAgentLinkWorkspaceFile(workspace,{path:'data/qa/nested.txt',text:'one',createOnly:true},owner);
 await assert.rejects(readAgentLinkWorkspaceFile(workspace,'data/qa/nested.txt'),/agent-accessible/);
 await assert.rejects(writeAgentLinkWorkspaceFile(workspace,{path:'data/qa/nested.txt',text:'untrusted',allowPrivatePaths:true,createDirectories:true}),/agent-accessible/);
 const read=await readAgentLinkWorkspaceFile(workspace,'data/qa/nested.txt',owner);assert.equal(read.sha256,first.sha256);
 await writeAgentLinkWorkspaceFile(workspace,{path:'data/qa/nested.txt',text:'agent edit',expectedSha256:read.sha256},owner);
 await assert.rejects(writeAgentLinkWorkspaceFile(workspace,{path:'data/qa/nested.txt',text:'stale owner draft',expectedSha256:read.sha256},owner),/changed since/);
 assert.equal(await readFile(path.join(workspace,'data/qa/nested.txt'),'utf8'),'agent edit');
 await symlink(path.join(workspace,'docs'),path.join(workspace,'shortcut'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(writeAgentLinkWorkspaceFile(workspace,{path:'shortcut/new/file.txt',text:'blocked',createOnly:true},owner),/Symbolic links/);
 await assert.rejects(readFile(path.join(workspace,'docs/new/file.txt')),error=>error.code==='ENOENT');
});

test('scoped project door lists and reads text while excluding runtime and secret files', async () => {
  const workspace = await fixture();
  const listing = await listAgentLinkWorkspace(workspace, '.');
  assert.deepEqual(listing.entries.map((item) => item.name).sort(), ['README.md', 'docs'].sort());
  const read = await readAgentLinkWorkspaceFile(workspace, 'README.md');
  assert.equal(read.text, 'local project text\n');
  assert.equal(read.sha256, crypto.createHash('sha256').update(read.text).digest('hex'));
  await assert.rejects(readAgentLinkWorkspaceFile(workspace, '.env'), (error) => error.status === 400);
  await assert.rejects(readAgentLinkWorkspaceFile(workspace, 'data/private.json'), (error) => error.status === 400);
  await assert.rejects(readAgentLinkWorkspaceFile(workspace, '../outside.txt'), (error) => error.status === 400);
  await assert.rejects(readAgentLinkWorkspaceFile(workspace, path.join(workspace, 'README.md')), (error) => error.status === 400);
});

test('workspace edits are atomic, size bounded, and require create-only or a current digest', async () => {
  const workspace = await fixture();
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'README.md', text: 'overwritten' }), (error) => error.status === 409);
  const original = await readAgentLinkWorkspaceFile(workspace, 'README.md');
  const updated = await writeAgentLinkWorkspaceFile(workspace, { path: 'README.md', text: 'reviewed project text\n', expectedSha256: original.sha256 });
  assert.equal(updated.created, false);
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), 'reviewed project text\n');
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'README.md', text: 'stale write', expectedSha256: original.sha256 }), (error) => error.status === 409 && error.code === 'workspace_file_changed');
  const created = await writeAgentLinkWorkspaceFile(workspace, { path: 'docs/new-note.md', text: 'new note\n', createOnly: true });
  assert.equal(created.created, true);
  const automatic = await writeAgentLinkWorkspaceFile(workspace, { path: 'docs/automatic.md', text: 'new automatic note\n' });
  assert.equal(automatic.created, true);
  assert.equal(await readFile(path.join(workspace, 'docs/automatic.md'), 'utf8'), 'new automatic note\n');
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/automatic.md', text: 'clobber' }), error => error.code === 'workspace_expected_hash_required');
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/missing.md', text: 'stale replacement', expectedSha256: original.sha256 }), error => error.code === 'workspace_expected_hash_required');
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/invalid.md', text: 'invalid', createOnly: 'false' }), error => error.status === 400);
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/new-note.md', text: 'clobber', createOnly: true }), (error) => error.status === 409);
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/large.md', text: 'x'.repeat(1024 * 1024 + 1), createOnly: true }), (error) => error.status === 413);
  await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'docs/.env.local', text: 'SECRET=x', createOnly: true }), (error) => error.status === 400);
});

test('workspace door blocks symlink reads and writes', async (t) => {
  const workspace = await fixture();
  const outside = path.join(path.dirname(workspace), `hexigrid-link-outside-${crypto.randomUUID()}.txt`);
  await writeFile(outside, 'outside owner data');
  try {
    await symlink(outside, path.join(workspace, 'outside-link.txt'));
  } catch (error) {
    await rm(outside, { force: true });
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('This Windows account cannot create a symlink in the temporary test directory.');
    throw error;
  }
  try {
    await assert.rejects(readAgentLinkWorkspaceFile(workspace, 'outside-link.txt'), (error) => error.status === 403 && error.code === 'workspace_symlink_denied');
    await assert.rejects(writeAgentLinkWorkspaceFile(workspace, { path: 'outside-link.txt', text: 'do not replace', expectedSha256: crypto.createHash('sha256').update('outside owner data').digest('hex') }), (error) => error.status === 403);
    assert.equal(await readFile(outside, 'utf8'), 'outside owner data');
  } finally { await rm(outside, { force: true }); }
});
