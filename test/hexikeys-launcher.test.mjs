import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBundledHexiKeys } from '../lib/hexikeys-launcher.mjs';

test('launcher opens only the fixed bundled executable without arguments or inherited IO', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexikeys-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const spawnProcess = (file, args, options) => {
    calls++;
    assert.equal(file, path.join(root, 'integrations', 'hexikeys', 'dist', 'HexiKeys.exe'));
    assert.deepEqual(args, []);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.detached, true);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  await assert.rejects(launchBundledHexiKeys(root, { spawnProcess }), /unavailable/);
  assert.equal(calls, 0);
  const folder = path.join(root, 'integrations', 'hexikeys', 'dist');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'HexiKeys.exe'), 'synthetic launcher fixture');
  assert.deepEqual(await launchBundledHexiKeys(root, { spawnProcess }), { opened: true });
  assert.equal(calls, 1);
  await assert.rejects(launchBundledHexiKeys(root, { spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('private diagnostic')));
    return child;
  } }), error => error.message === 'HexiKeys could not open its protected window.');
});
