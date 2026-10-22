import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let port;
let processUnderTest;
let tempData;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start.');
}

async function request(url, method, body) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  port = await freePort();
  tempData = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-goal-test-'));
  processUnderTest = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: tempData, HEXIGRID_PAIR_CODE: 'ABCDEF12', OPENCODE_CLI: 'missing-opencode-for-test' },
    stdio: 'ignore'
  });
  await waitForServer();
});

after(async () => {
  if (processUnderTest && processUnderTest.exitCode === null && processUnderTest.signalCode === null) {
    const exited = once(processUnderTest, 'exit');
    processUnderTest.kill();
    await exited;
  }
  if (tempData) {
    const resolved = path.resolve(tempData);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Test cleanup must stay inside the OS temp directory.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('settings PATCH persists an active goal and clearing it', async () => {
  const title = 'Ship goal settings coverage';
  const saved = await request('/api/settings', 'PATCH', { activeGoal: { title, status: 'active' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.activeGoal.title, title);
  assert.equal(saved.body.settings.activeGoal.status, 'active');

  const fresh = await request('/api/bootstrap', 'GET');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.settings.activeGoal.title, title);
  assert.equal(fresh.body.settings.activeGoal.status, 'active');

  const cleared = await request('/api/settings', 'PATCH', { activeGoal: { title: '' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.settings.activeGoal.title, '');
  assert.equal(cleared.body.settings.activeGoal.status, 'idle');

  const freshAfterClear = await request('/api/bootstrap', 'GET');
  assert.equal(freshAfterClear.status, 200);
  assert.equal(freshAfterClear.body.settings.activeGoal.title, '');
  assert.equal(freshAfterClear.body.settings.activeGoal.status, 'idle');
});

test('goal fields are normalized rather than rejected by settings PATCH', async () => {
  const response = await request('/api/settings', 'PATCH', { activeGoal: { title: { unexpected: true }, status: 'invalid' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.settings.activeGoal.title, '');
  assert.equal(response.body.settings.activeGoal.status, 'idle');
});
