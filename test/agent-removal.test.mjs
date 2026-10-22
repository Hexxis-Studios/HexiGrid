import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { signatureFor } from '../lib/agent-link.mjs';

const freePort = async () => {
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
};

test('confirmed profile removal revokes only its exact Links, with no changes on blocked requests', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-agent-removal-'));
  const port = await freePort(), relayPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: path.join(dataDir, 'workspace'), OPENCODE_CLI: 'missing-disposable-model' } });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    const relative = path.relative(os.tmpdir(), dataDir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, 'disposable server stays running');
    try { if ((await fetch(origin + '/')).ok) break; } catch {}
    assert.ok(i < 149, 'disposable server starts');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const cookies = new Map();
  let csrf = '';
  async function call(route, method = 'GET', body, token) {
    const headers = token ? {} : { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'x-hexigrid-csrf': csrf };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) {
      const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
      Object.assign(headers, { authorization: `Bearer ${token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
        'x-hexigrid-signature': signatureFor({ token, method, pathname: route.split('?')[0], timestamp, nonce, body: body ?? null }) });
    }
    const response = await fetch(origin + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!token) for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
      if (pair.startsWith('hexigrid_csrf=')) csrf = decodeURIComponent(pair.slice(index + 1));
    }
    return { status: response.status, body: await response.json() };
  }
  async function pair(name, externalId = name) {
    const invited = await call('/api/agent-links/invites', 'POST', { capabilities: ['messages'] });
    assert.equal(invited.status, 201);
    const secret = new URLSearchParams(new URL(invited.body.invitationUrl).hash.slice(1)).get('secret');
    const paired = await call('/agent-link/v1/pair', 'POST', { inviteId: invited.body.invite.id, secret,
      identity: { name, framework: 'custom', externalId }, capabilities: ['messages'] });
    assert.equal(paired.status, 201);
    return paired.body;
  }
  await call('/api/auth/status');
  assert.equal((await call('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' })).status, 200);
  const settings = values => call('/api/settings', 'PATCH', values);
  assert.equal((await settings({ workMode: 'setup', approvalPolicy: 'full', setupAcknowledged: true })).status, 200);
  const target = await pair('Removal QA'), other = await pair('Keep QA');
  const route = `/api/agents/${target.agent.id}`;
  const confirmed = { revokeLinkIds: [target.connection.id], approved: true };
  const assertIntact = async () => {
    assert.equal((await call('/agent-link/v1/events?after=0', 'GET', undefined, target.token)).status, 200);
    assert.equal((await call('/api/agents')).body.agents.some(agent => agent.id === target.agent.id), true);
  };
  const missingConfirmation = await call(route, 'DELETE', {});
  assert.equal(missingConfirmation.status, 409, 'no revocation without exact confirmation');
  assert.equal(missingConfirmation.body.code, 'AGENT_CONNECTIONS_CHANGED');
  assert.equal((await call(route, 'DELETE', { revokeLinkIds: [other.connection.id], approved: true })).status, 409, 'cannot revoke another agent');
  assert.equal((await call(route, 'DELETE', { revokeLinkIds: [target.connection.id, target.connection.id] })).status, 400, 'invalid confirmation is rejected');
  await assertIntact();
  const note = await call(`/api/agents/${target.agent.id}/memories`, 'POST', { content: 'Disposable protected memory.' });
  assert.equal(note.status, 201);
  assert.equal((await call(route, 'DELETE', confirmed)).status, 409, 'memories block before revocation');
  await assertIntact();
  assert.equal((await call(`/api/memories/${note.body.memory.id}`, 'DELETE', { approved: true, expectedRevision: note.body.memory.revisions.length })).status, 200);
  await settings({ approvalPolicy: 'ask' });
  const unapproved = await call(route, 'DELETE', { revokeLinkIds: [target.connection.id] });
  assert.equal(unapproved.status, 409); assert.equal(unapproved.body.approvalRequired, true);
  await settings({ workMode: 'plan' });
  assert.equal((await call(route, 'DELETE', confirmed)).status, 403, 'confirmation cannot override read-only mode');
  await settings({ workMode: 'setup', approvalPolicy: 'full' });
  await assertIntact();
  const room = await call('/api/rooms', 'POST', { name: 'Disposable removal room' });
  assert.equal(room.status, 201);
  await call(`/api/rooms/${room.body.room.id}`, 'PATCH', { agentIds: [target.agent.id, other.agent.id] });
  const removed = await call(route, 'DELETE', confirmed);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.connections.length, 1);
  assert.equal(removed.body.connections[0].authorizationStatus, 'revoked');
  assert.equal((await call('/agent-link/v1/events?after=0', 'GET', undefined, target.token)).status, 410);
  assert.equal((await call('/agent-link/v1/events?after=0', 'GET', undefined, other.token)).status, 200);
  const snapshot = (await call('/api/bootstrap')).body;
  assert.equal(snapshot.agents.some(agent => agent.id === target.agent.id), false);
  assert.deepEqual(snapshot.rooms.find(item => item.id === room.body.room.id).agentIds, [other.agent.id]);
  assert.ok(snapshot.receipts.some(receipt => receipt.action === 'agent:remove' && receipt.agentId === target.agent.id));
  assert.equal((await call(route, 'DELETE', confirmed)).status, 404, 'retry does not affect anyone else');
  const reconnected = await pair('Removal QA');
  assert.notEqual(reconnected.connection.id, target.connection.id, 'new pairing gets a fresh Link');
  assert.equal((await call('/agent-link/v1/events?after=0', 'GET', undefined, reconnected.token)).status, 200);
  const oldRevokeFlow = await pair('Standalone revoke QA');
  const revoked = await call(`/api/agent-links/${oldRevokeFlow.connection.id}`, 'DELETE', { purge: true, approved: true });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.purged, true, 'existing connection-only removal still works');
  assert.equal((await call('/agent-link/v1/events?after=0', 'GET', undefined, oldRevokeFlow.token)).status, 401);
  if (process.argv.includes('--ui')) {
    console.log(JSON.stringify({ origin, synthetic: true, view: '/#agents', state: 'paired-removal-ready' }));
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 10 * 60_000);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { if (chunk.trim() === 'stop') { clearTimeout(timeout); resolve(); } });
      process.stdin.resume();
    });
    process.stdin.pause();
  }
});
