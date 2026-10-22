import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { harnessCanConnect } from '../lib/harnesses.mjs';

test('keyless OpenCode can connect without inventing authentication or accepting an absent CLI', () => {
  const local = { id: 'opencode', installed: true, authenticated: false };
  assert.equal(harnessCanConnect(local), true);
  assert.equal(local.authenticated, false);
  assert.equal(harnessCanConnect({ ...local, installed: false }), false);
  assert.equal(harnessCanConnect(null), false);
  for (const id of ['codex', 'claude-code', 'unknown']) {
    assert.equal(harnessCanConnect({ ...local, id }), false);
    assert.equal(harnessCanConnect({ ...local, id, authenticated: true }), true);
  }
});

test('owner UI exposes keyless connection truthfully and keeps remote-device controls disabled', async () => {
  const context = vm.createContext({ document: { addEventListener() {} }, isHostBrowser: () => true });
  vm.runInContext(await readFile(new URL('../public/harnesses.js', import.meta.url), 'utf8'), context);
  const local = { id: 'opencode', installed: true, authenticated: false };
  assert.equal(context.harnessConnectionDisabled(local), false);
  assert.match(context.harnessStateMessage(local), /local models need no sign-in/);
  assert.match(context.harnessStateMessage({ ...local, connected: true }), /^Connected/);
  assert.equal(context.harnessConnectionDisabled({ ...local, installed: false }), true);
  assert.equal(context.harnessConnectionDisabled({ ...local, id: 'codex' }), true);
  context.isHostBrowser = () => false;
  assert.equal(context.harnessConnectionDisabled(local), true);
});
