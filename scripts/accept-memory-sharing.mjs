// Disposable visual QA only. Tokens stay in process memory; no real owner state.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { signatureFor } from '../lib/agent-link.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-visual-sharing-'));
const origin = 'http://127.0.0.1:44718';
let cookie = '';
const startApp = () => spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true,
  env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44718', HEXIGRID_AGENT_RELAY_PORT: '44719', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44719', HEXIGRID_DATA_DIR: dataDir, HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: dataDir, OPENCODE_CLI: 'missing-visual-qa-model' },
  stdio: ['ignore', 'ignore', 'ignore'] });
let app = startApp(), verification;
let stopped = false;
async function stopApp() {
  if (app.exitCode === null) { const exit = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exit; }
}
async function readyApp() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (app.exitCode !== null) throw Error('Synthetic server exited before readiness.');
    try { if ((await fetch(origin)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Synthetic server did not become ready.');
}
async function restartApp() {
  await stopApp(); app = startApp(); await readyApp();
  const login = await expect('/api/auth/login', 'POST', { password: 'public-disposable-QA-fixture-only' });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
}
async function stop() {
  if (stopped) return; stopped = true;
  await stopApp();
  if (verification?.listening) await new Promise(resolve => verification.close(resolve));
  if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('hexigrid-visual-sharing-')) throw Error('Disposable cleanup path escaped its temporary directory.');
  await rm(dataDir, { recursive: true, force: true });
}
process.on('SIGINT', () => stop().then(() => process.exit()));
process.on('SIGTERM', () => stop().then(() => process.exit()));
async function request(route, method = 'GET', body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    Object.assign(headers, { authorization: `Bearer ${token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token, method, pathname: route, timestamp, nonce, body: body ?? null }) });
  } else if (cookie) headers.cookie = cookie;
  const response = await fetch(origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), response };
}
async function expect(route, method, body) {
  const result = await request(route, method, body);
  if (result.status >= 400) throw Error(`Synthetic setup failed at ${route}: ${result.status}`);
  return result;
}
try {
  await readyApp();
  const login = await expect('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  await expect('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  async function pair(name) {
    const capabilities = ['memory-read'];
    const invite = (await expect('/api/agent-links/invites', 'POST', { capabilities })).body;
    const secret = new URLSearchParams(new URL(invite.invitationUrl).hash.slice(1)).get('secret');
    return (await expect('/agent-link/v1/pair', 'POST', { inviteId: invite.invite.id, secret, identity: { name, framework: 'synthetic-qa', externalId: crypto.randomUUID() }, capabilities })).body;
  }
  const source = await pair('Memory source QA82'), recipient = await pair('Memory reader QA82'), unrelated = await pair('Unrelated QA82');
  const scope = { projectId: 'visual-sharing-qa82', topicId: 'harmless-fixture' };
  const created = await expect(`/api/agents/${source.agent.id}/memory-commit`, 'POST', { operation: 'create', text: 'The synthetic cube is turquoise.', contextScope: scope,
    status: 'conditional', valid_while: 'this disposable fixture is active', evidence_excerpt: 'Synthetic source evidence stays private.' });
  await expect(`/api/agents/${source.agent.id}/memory-commit`, 'POST', { operation: 'create', text: 'UNRELATED_SCOPE_MUST_NOT_APPEAR', contextScope: { projectId: 'other-fixture' } });
  verification = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/evidence') { res.writeHead(404); res.end(); return; }
    try {
      const list = await request('/agent-link/v1/shared-memory', 'POST', { operation: 'list' }, recipient.token);
      const other = await request('/agent-link/v1/shared-memory', 'POST', { operation: 'list' }, unrelated.token);
      const ownerShares = await request('/api/memory-shares');
      const share = list.body.shares?.[0] || ownerShares.body.shares?.find(item => item.sourceAgentId === source.agent.id && item.targetLinkId === recipient.connection.id);
      const recalled = share ? await request('/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId: share.id }, recipient.token) : null;
      const denied = share ? await request('/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId: share.id }, unrelated.token) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ recipientShares: list.body.shares?.length, unrelatedShares: other.body.shares?.length,
        recipientRecallStatus: recalled?.status, unrelatedRecallStatus: denied?.status,
        currentFacts: recalled?.body.context?.memories?.map(({ text, valid_while }) => ({ text, valid_while })),
        evidenceLeaked: JSON.stringify(recalled?.body || {}).includes('Synthetic source evidence'),
        unrelatedScopeLeaked: JSON.stringify(recalled?.body || {}).includes('UNRELATED_SCOPE') }));
    } catch { res.writeHead(500); res.end('Synthetic verification unavailable'); }
  });
  if (process.argv.includes('--verify-recovery')) {
    const granted = await expect('/api/memory-shares', 'POST', { sourceAgentId: source.agent.id, targetLinkId: recipient.connection.id, scope, approved: true });
    const shareId = granted.body.share.id;
    await restartApp();
    const recalled = await request('/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId }, recipient.token);
    assert.equal(recalled.status, 200);
    assert.equal(recalled.body.context.memories[0].id, created.body.id);
    assert.equal(recalled.body.context.memories[0].text, 'The synthetic cube is turquoise.');
    assert.equal(recalled.body.context.memories[0].valid_while, 'this disposable fixture is active');
    assert.equal(JSON.stringify(recalled.body).includes('Synthetic source evidence'), false);
    assert.equal(JSON.stringify(recalled.body).includes('UNRELATED_SCOPE'), false);
    assert.equal((await request('/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId }, unrelated.token)).status, 404);
    await expect(`/api/memory-shares/${shareId}/revoke`, 'POST', { approved: true });
    await restartApp();
    const listed = await request('/agent-link/v1/shared-memory', 'POST', { operation: 'list' }, recipient.token);
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.shares, []);
    assert.equal((await request('/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId }, recipient.token)).status, 404);
    const standing = (await expect('/api/memory-shares')).body.shares.find(item => item.id === shareId);
    assert.equal(standing.status, 'revoked');
    const receipts = (await expect('/api/bootstrap')).body.receipts;
    assert.ok(receipts.some(item => item.action === 'memory:share-grant'));
    assert.ok(receipts.some(item => item.action === 'memory:share-revoke'));
    await stop();
    console.log('PASS: current-source sharing survives restart with exact memory ID/condition/privacy; revoked old ID remains denied after second restart; owner standing and receipts agree.');
  } else {
    verification.listen(44720, '127.0.0.1', () => console.log('Disposable sharing QA ready: owner44718; signed evidence44720/evidence. No real Link or model used.'));
  }
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }
