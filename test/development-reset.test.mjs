import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DEVELOPMENT_RESET_MARKER, developmentResetEnabled, resetDevelopmentData } from '../lib/development-reset.mjs';

test('development fresh-start removes only known private runtime data and preserves its local marker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-fresh-start-'));
  try {
    await writeFile(path.join(directory, DEVELOPMENT_RESET_MARKER), 'enabled-for-local-testing\n');
    await writeFile(path.join(directory, '.gitkeep'), '');
    await writeFile(path.join(directory, 'control-room.json'), 'private state');
    await writeFile(path.join(directory, 'control-room.json.4.pending'), 'private pending state');
    for (const name of ['vault', 'workspace', 'media', 'plugins', 'runner-profiles']) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, 'private.txt'), 'private');
    }

    assert.equal(await developmentResetEnabled(directory), true);
    assert.equal(await resetDevelopmentData(directory), true);
    assert.equal((await readFile(path.join(directory, DEVELOPMENT_RESET_MARKER), 'utf8')).trim(), 'enabled-for-local-testing');
    assert.equal(await readFile(path.join(directory, '.gitkeep'), 'utf8'), '');
    await assert.rejects(readFile(path.join(directory, 'control-room.json')), /ENOENT/);
    await assert.rejects(readFile(path.join(directory, 'vault', 'private.txt')), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('development fresh-start is inert without the exact opt-in marker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-normal-start-'));
  try {
    const state = path.join(directory, 'control-room.json');
    await writeFile(state, 'keep me');
    assert.equal(await developmentResetEnabled(directory), false);
    assert.equal(await resetDevelopmentData(directory), false);
    assert.equal(await readFile(state, 'utf8'), 'keep me');
    await writeFile(path.join(directory, DEVELOPMENT_RESET_MARKER), 'wrong-value');
    assert.equal(await resetDevelopmentData(directory), false);
    assert.equal(await readFile(state, 'utf8'), 'keep me');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
