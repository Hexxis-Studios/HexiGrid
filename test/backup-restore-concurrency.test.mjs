import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beginBackupOperation } from '../lib/whole-app-backup.mjs';

test('whole-app backup reads and restores share one exclusive operation lock', async () => {
  let announceAcquired;
  let allowRelease;
  const acquired = new Promise((resolve) => { announceAcquired = resolve; });
  const held = new Promise((resolve) => { allowRelease = resolve; });
  const activeOperation = (async () => {
    const release = beginBackupOperation();
    assert.equal(typeof release, 'function');
    announceAcquired();
    try { await held; } finally { release(); }
  })();
  await acquired;
  assert.equal(beginBackupOperation(), null, 'overlapping backup operations must be refused');
  allowRelease();
  await activeOperation;
  const afterRelease = beginBackupOperation();
  assert.equal(typeof afterRelease, 'function', 'a completed restore must release the lock');
  afterRelease();

  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const exportRoute = server.slice(server.indexOf("pathname === '/api/backup/export'"), server.indexOf("pathname === '/api/backup/import'"));
  const importRoute = server.slice(server.indexOf("pathname === '/api/backup/import'"), server.indexOf("pathname === '/api/backup/rollback'"));
  const rollbackRoute = server.slice(server.indexOf("pathname === '/api/backup/rollback'"), server.indexOf("pathname === '/api/plugins/install'"));
  for (const route of [exportRoute, importRoute, rollbackRoute]) {
    assert.match(route, /beginBackupOperation\(\)/);
    assert.match(route, /return json\(res, 409, \{ error: 'Another backup operation is already in progress\./);
    assert.match(route, /finally \{ releaseBackupOperation\?\.\(\); \}/);
  }
  const scheduled = server.slice(server.indexOf('let scheduledBackupRunning = false;'), server.indexOf('function startBackupWorker'));
  assert.match(scheduled, /beginBackupOperation\(\)/);
  assert.match(scheduled, /finally \{ releaseBackupOperation\(\); scheduledBackupRunning = false; \}/);
});
