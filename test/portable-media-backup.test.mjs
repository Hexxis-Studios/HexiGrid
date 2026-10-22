import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectPortableFiles, restorePortableFiles, portableFileLimits } from '../lib/portable-files.mjs';
import { avatarModelLimits } from '../lib/avatar-model.mjs';

test('portable backup restores media above the ordinary file limit without relaxing workspace limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-media-backup-'));
  try {
    const media = path.join(root, 'media');
    const workspace = path.join(root, 'workspace');
    await mkdir(media); await mkdir(workspace);
    const bytes = Buffer.alloc(portableFileLimits.maxFileBytes + 1, 0x35);
    await writeFile(path.join(media, 'avatar.glb'), bytes);
    const bundle = await collectPortableFiles({ media });
    assert.equal(bundle.totals.bytes, bytes.length);
    const target = path.join(root, 'restored');
    await restorePortableFiles(bundle, { media: target });
    assert.deepEqual(await readFile(path.join(target, 'avatar.glb')), bytes);
    await writeFile(path.join(workspace, 'large.dat'), bytes);
    await assert.rejects(collectPortableFiles({ workspace }), /16 MB.*workspace/);
    // A forged media record cannot use its larger allowance in another area.
    const relabeled = { areas: ['workspace'], files: bundle.files.map(record => ({ ...record, area: 'workspace' })) };
    await assert.rejects(restorePortableFiles(relabeled, { workspace: path.join(root, 'blocked') }), /too large|invalid size/);
    assert.equal(portableFileLimits.maxMediaBytes, avatarModelLimits.maxBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('portable media export rejects a file beyond the accepted avatar size before reading it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-media-limit-'));
  try {
    const file = await open(path.join(root, 'too-large.glb'), 'w');
    try { await file.truncate(avatarModelLimits.maxBytes + 1); } finally { await file.close(); }
    await assert.rejects(collectPortableFiles({ media: root }), /64 MB.*media/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
