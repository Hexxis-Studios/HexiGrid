import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeSourceDigest } from '../lib/runtime-source.mjs';

test('runtime fingerprint detects executable and UI changes without hashing private state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-source-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['lib', 'public', 'data']) await mkdir(path.join(root, directory));
  for (const name of ['server.mjs', 'package.json', 'package-lock.json', 'lib/test.mjs', 'public/test.js']) {
    await writeFile(path.join(root, name), 'fixture');
  }
  const loaded = await runtimeSourceDigest(root);
  assert.match(loaded, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, 'data', 'private-state.json'), 'excluded private fixture');
  assert.equal(await runtimeSourceDigest(root), loaded);
  await writeFile(path.join(root, 'lib', 'test.mjs'), 'new code');
  const changed = await runtimeSourceDigest(root);
  assert.notEqual(changed, loaded);
  await writeFile(path.join(root, 'public', 'test.js'), 'new UI');
  assert.notEqual(await runtimeSourceDigest(root), changed);
  assert.equal(loaded.length, 64, 'captured value is immutable');
});
