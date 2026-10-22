import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { CONTINUITY_CATEGORIES, REQUIRED_CONTINUITY_CATEGORIES } from '../lib/continuity-transfer.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('two engines restore exact memory history without an installed search model', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-continuity-http-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }));
    await rm(root, { recursive: true, force: true });
  });

  async function engine(name) {
    const data = path.join(root, name);
    const port = await freePort();
    let relayPort = await freePort();
    while (relayPort === port) relayPort = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'TEMP', 'TMP']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_DATA_DIR: data, LOCALAPPDATA: path.join(data, 'local-app-data'),
      HEXIGRID_DISABLE_OS_VAULT: '1', OPENCODE_CLI: 'missing-continuity-acceptance-model' });
    const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env, windowsHide: true, stdio: 'ignore' });
    children.push(child);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Disposable continuity engine exited.');
      try { if ((await fetch(`${origin}/api/system/identity`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'disposable engine must start');
    let cookie = '';
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const password = 'synthetic-continuity-acceptance-passphrase';
    let login = await request('/api/auth/setup', 'POST', { password });
    if (login.status === 409) login = await request('/api/auth/login', 'POST', { password });
    assert.equal(login.status, 200);
    cookie = login.cookie;
    assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
    return { data, request, stop: async () => {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    } };
  }

  const source = await engine('source');
  let destination = await engine('destination');
  const created = await source.request('/api/agents', 'POST', { name: 'Synthetic continuity agent', transport: 'local-opencode' });
  assert.equal(created.status, 201);
  const agent = created.body.agent;
  const snapshot = { source: { framework: 'local', externalId: agent.id, name: agent.name },
    categories: Object.fromEntries(CONTINUITY_CATEGORIES.map(name => [name, {
      status: REQUIRED_CONTINUITY_CATEGORIES.includes(name) ? 'complete' : 'unavailable', summary: name, data: { note: 'Synthetic portable fixture.' }
    }])) };
  assert.equal((await source.request(`/api/agents/${agent.id}/continuity-draft`, 'POST', { snapshot, approved: true })).status, 201);
  const lineageId = (await source.request('/api/agents')).body.agents.find(item => item.id === agent.id).continuityLineage.id;
  const store = new DatedMemoryStore({ root: path.join(source.data, 'dated-memory') });
  const fact = await store.append({ lineageId, agentId: agent.id, createdAt: '2026-09-20T12:00:00.000Z', text: 'The synthetic meeting is Monday.' });
  await store.appendRevision({ lineageId, id: fact.entry.id, expectedRevision: 0, by: 'owner:acceptance', why: 'Corrected from synthetic evidence.',
    createdAt: '2026-09-21T12:00:00.000Z', changes: { text: 'The synthetic meeting is Tuesday.' } });
  const exported = await source.request(`/api/agents/${agent.id}/continuity-package`, 'POST', {
    approved: true, moveActivity: true, passphrase: 'synthetic-portable-transfer-passphrase'
  });
  assert.equal(exported.status, 201, JSON.stringify(exported.body));
  assert.equal((await source.request('/api/agents')).body.agents.find(item => item.id === agent.id).continuityLineage.activityState, 'suspended');
  const restored = await destination.request('/api/continuity/import', 'POST', {
    approved: true, moveActivity: true, passphrase: 'synthetic-portable-transfer-passphrase', envelope: exported.body.envelope
  });
  assert.equal(restored.status, 201, JSON.stringify(restored.body));
  assert.equal(restored.body.agent.continuityLineage.activityState, 'suspended');
  const syncId = restored.body.transfer.memorySyncId;
  const route = `/api/memory-sync/${syncId}`;
  assert.equal((await destination.request(`${route}/finalize`, 'POST', { approved: true })).status, 409, 'missing files never activate the destination');
  const pending = await destination.request(route);
  assert.equal(pending.body.missing.length, 2);
  assert.equal((await destination.request(`${route}/file`, 'POST', { approved: true, path: pending.body.missing[0].path,
    data: Buffer.from('Tampered synthetic transfer.').toString('base64') })).status, 400);
  for (const [position, file] of pending.body.missing.entries()) {
    const download = await source.request(`${route}/source-file?path=${encodeURIComponent(file.path)}`);
    assert.equal(download.status, 200);
    const upload = await destination.request(`${route}/file`, 'POST', { approved: true, path: file.path, data: download.body.data });
    assert.equal(upload.status, 202);
    if (position === 0) {
      assert.equal((await destination.request(`${route}/finalize`, 'POST', { approved: true })).status, 409);
      await destination.stop();
      destination = await engine('destination');
      assert.equal((await destination.request(route)).body.missing.length, 1, 'accepted files survive restart');
      assert.equal((await destination.request('/api/agents')).body.agents.find(item => item.id === restored.body.agent.id).continuityLineage.activityState, 'suspended');
    }
  }
  const finalized = await destination.request(`${route}/finalize`, 'POST', { approved: true });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.agent.continuityLineage.activityState, 'active');
  assert.equal(finalized.body.indexed, false, 'search-model absence is explicit, not a failed restore');
  const recovered = await new DatedMemoryStore({ root: path.join(destination.data, 'dated-memory') }).getById({ lineageId, id: fact.entry.id, depth: 1 });
  assert.equal(recovered.text, 'The synthetic meeting is Tuesday.');
  assert.equal(recovered.revisions.length, 1);
  const searched = await destination.request(`/api/agents/${restored.body.agent.id}/memory-mcp`, 'POST', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic-search', arguments: { query: 'synthetic meeting', depth: 1 } }
  });
  assert.equal(searched.status, 200);
  assert.equal(searched.body.error, undefined);
  assert.equal(searched.body.result.structuredContent.matches[0].text, 'The synthetic meeting is Tuesday.');
  assert.equal(searched.body.result.structuredContent.matches[0].matchMethod, 'lexical-fallback');
  for (const file of await store.listFiles({ lineageId })) {
    assert.deepEqual(await readFile(path.join(destination.data, 'dated-memory', ...file.path.split('/'))), file.content);
  }
});
