import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signatureFor } from '../lib/agent-link.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
test('owner and signed owner-agent pool controls enforce policy, session, version and revocation', async t => {
  let version = 1; let writes = 0; let strategy = 'capacity_weighted';
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PUT') { const input = JSON.parse(body); assert.equal(input.expectedVersion, version); writes++; strategy = input.routingStrategy; version++; }
    res.end(JSON.stringify(req.url.startsWith('/api/dashboard/overview') ? { accounts: [{ accountId: 'qa', displayName: 'Disposable QA account', status: 'active', planType: 'test', usage: { primaryRemainingPercent: 80, secondaryRemainingPercent: 60 }, accessToken: 'NEVER-RETURN-THIS' }] } : { routingStrategy: strategy, stickyThreadsEnabled: true, version }));
  });
  const poolPort = await listen(upstream); const port = await freePort(); const relayPort = await freePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-pool-qa-'));
  const app = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`, HEXIGRID_DATA_DIR: dataDir, HEXIGRID_MODEL_POOL_URL: `http://127.0.0.1:${poolPort}`, OPENCODE_CLI: 'missing-pool-qa-model' } });
  t.after(async () => { if (app.exitCode === null) { const exit = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exit; } await new Promise(resolve => upstream.close(resolve)); });
  const origin = `http://127.0.0.1:${port}`; let cookie = '';
  async function call(route, method = 'GET', body, token) {
    const headers = { 'content-type': 'application/json', ...(cookie && !token ? { cookie } : {}) };
    if (token) { const timestamp = new Date().toISOString(); const nonce = crypto.randomUUID(); Object.assign(headers, { authorization: `Bearer ${token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce, 'x-hexigrid-signature': signatureFor({ token, method, pathname: route, timestamp, nonce, body: body ?? null }) }); }
    const response = await fetch(origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} assert.equal(app.exitCode, null); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal((await call('/api/model-pool')).status, 403);
  const setup = await call('/api/auth/setup', 'POST', { password: 'Disposable-Pool-QA-Only' }); assert.equal(setup.status, 200); cookie = setup.cookie;
  { const r = await call('/api/model-pool'); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  assert.equal((await call('/api/network/agent-relay', 'POST', { provider: 'stable', approved: true })).status, 200);
  const invite = await call('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'desktop-view', 'desktop-control'] }); assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const secret = new URLSearchParams(new URL(invite.body.invitationUrl).hash.slice(1)).get('secret');
  const pair = await call('/agent-link/v1/pair', 'POST', { inviteId: invite.body.invite.id, secret, identity: { name: 'Disposable pool QA agent', framework: 'test' }, capabilities: ['messages', 'desktop-view', 'desktop-control'] }); assert.equal(pair.status, 201);
  const token = pair.body.token; const linkId = pair.body.connection.id;
  const signed = (route, method = 'GET', body) => call('/agent-link/v1/model-pool' + route, method, body, token);
  assert.equal((await signed('')).status, 403);
  assert.equal((await call(`/api/agent-links/${linkId}/trust`, 'PATCH', { trustLevel: 'owner', approved: true })).status, 200);
  assert.equal((await signed('')).status, 403);
  assert.equal((await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  assert.equal((await call('/api/desktop-bridge/start', 'POST', { linkId, viewGranted: true, controlGranted: true, approved: true })).status, 200);
  const status = await signed(''); assert.equal(status.status, 200); assert.doesNotMatch(JSON.stringify(status.body), /NEVER-RETURN/);
  const input = { routingStrategy: 'round_robin', stickyThreadsEnabled: true, expectedVersion: 1 };
  assert.equal((await signed('/routing', 'POST', input)).status, 200); assert.equal(writes, 1);
  assert.equal((await signed('/routing', 'POST', input)).status, 409); assert.equal(writes, 1);
  await call('/api/settings', 'PATCH', { workMode: 'plan' });
  assert.equal((await signed('/routing', 'POST', { ...input, expectedVersion: 2 })).status, 403); assert.equal(writes, 1);
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'ask' });
  assert.equal((await signed('/routing', 'POST', { ...input, expectedVersion: 2, approved: true })).status, 409); assert.equal(writes, 1);
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  const ownerUpdate = await call('/api/model-pool/routing', 'POST', { ...input, routingStrategy: 'capacity_weighted', expectedVersion: 2, approved: true }); assert.equal(ownerUpdate.status, 200); assert.equal(writes, 2);
  await call('/api/desktop-bridge/stop', 'POST', {});
  assert.equal((await signed('')).status, 403);
});
