import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncryptedStateStore } from '../lib/local-state.mjs';

// Real startup must reject before creating workspace files, importing a
// legacy secret into the vault, or starting connectors/tasks/listeners.
test('actual server refuses future encrypted application state without changing data', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-future-state-'));
  const values = new Map();
  const vault = { get: async id => values.get(id), set: async (id, value) => values.set(id, value) };
  const file = path.join(root, 'control-room.json');
  let child;
  try {
    const store = new EncryptedStateStore(file, vault);
    await store.write({ version: 3, marker: 'synthetic future payload', settings: { brand: 'future' }, providers: [{ id: 'fixture', apiKey: 'synthetic-not-a-credential' }] });
    // Isolated test key only; no platform vault or genuine owner state.
    await writeFile(store.fallbackKeyFile, values.get(store.keyId), { mode: 0o600 });
    const before = await readFile(file);
    const keyBefore = await readFile(store.fallbackKeyFile);
    const entriesBefore = (await readdir(root)).sort();
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
      env: { ...process.env, HEXIGRID_DATA_DIR: root, HEXIGRID_DISABLE_OS_VAULT: '1', HEXIGRID_PORT: '44327', HEXIGRID_AGENT_RELAY_PORT: '44328', HEXIGRID_RELEASE_MANAGER_ROOT: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
    assert.notEqual(code, 0);
    // The process failure handler deliberately prints only the safe message.
    assert.match(output, /Local state is invalid or uses an unsupported schema version/);
    assert.doesNotMatch(output, /synthetic future payload|synthetic-not-a-credential/);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readFile(store.fallbackKeyFile), keyBefore);
    // The existing single-instance lock precedes loadState. It is process
    // metadata, not a migration/recovery write; stale locks are reclaimed by
    // the launcher's existing ownership check.
    const afterEntries = await readdir(root);
    assert.deepEqual(afterEntries.filter(name => name !== '.instance.lock').sort(), entriesBefore);
    if (afterEntries.includes('.instance.lock')) {
      assert.equal(JSON.parse(await readFile(path.join(root, '.instance.lock'), 'utf8')).pid, child.pid);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
