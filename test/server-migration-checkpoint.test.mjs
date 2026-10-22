import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EncryptedStateStore } from '../lib/local-state.mjs';

async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

test('actual legacy startup preserves exact encrypted pre-migration data independently of backup undo', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-migration-start-'));
  const values = new Map();
  const vault = { get: async id => values.get(id), set: async (id, value) => values.set(id, value) };
  const file = path.join(root, 'control-room.json');
  const original = { version: 1, marker: 'synthetic original schema', settings: { workMode: 'plan', approvalProfile: 'ask' }, agents: [{ id: 'agent-1', name: 'Agent 1' }], rooms: [], providers: [] };
  let child, closed;
  try {
    const store = new EncryptedStateStore(file, vault);
    await store.write(original);
    await store.writeRestorePoint({ version: 2, marker: 'separate synthetic backup undo' });
    const backupBefore = await readFile(store.restorePointFile);
    await writeFile(store.fallbackKeyFile, values.get(store.keyId), { mode: 0o600 });
    const port = await freePort(), relayPort = await freePort();
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
      env: { ...process.env, HEXIGRID_DATA_DIR: root, HEXIGRID_DISABLE_OS_VAULT: '1', HEXIGRID_PORT: String(port), HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_RELEASE_MANAGER_ROOT: '' },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    closed = new Promise(resolve => child.once('close', resolve));
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/system/identity`, { signal: AbortSignal.timeout(200) });
        if (r.ok && (await r.json()).pid === child.pid) { ready = true; break; }
      } catch { /* only this disposable startup is awaited */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Isolated migration startup must reach its own identity route.');
    const loaded = await new EncryptedStateStore(file, vault).read();
    assert.equal(loaded.version, 2);
    assert.equal(loaded.marker, original.marker);
    assert.equal(loaded.agents.some(a => a.id === 'agent-1'), false);
    const restarted = new EncryptedStateStore(file, vault);
    assert.deepEqual(await restarted.readMigrationPoint(), original);
    assert.deepEqual(await readFile(store.restorePointFile), backupBefore);
    assert.doesNotMatch(await readFile(restarted.migrationPointFile, 'utf8'), /synthetic original schema/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    await rm(root, { recursive: true, force: true });
  }
});
