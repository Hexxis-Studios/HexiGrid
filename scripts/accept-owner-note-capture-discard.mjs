// Disposable owner-note capture-discard visual fixture. It uses only a local synthetic Link and note.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { signatureFor } from '../lib/agent-link.mjs';
import { CONTINUITY_CATEGORIES, REQUIRED_CONTINUITY_CATEGORIES } from '../lib/continuity-transfer.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-owner-note-discard-'));
const workspaceRoot = path.join(dataDir, 'link-workspaces');
const passphrase = 'public-disposable-QA-fixture-only';
const fakeMessage = 'Synthetic fixture source: the outdated greenhouse checklist was used.';
const syntheticNames = ['Discard UI owner review', 'Discard UI agent interface'];
const inactiveLineage = process.argv.includes('--inactive-lineage');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

const port = await freePort();
const relayPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['server.mjs'], { cwd: repo, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
    HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
    HEXIGRID_DATA_DIR: dataDir, HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: workspaceRoot,
    OPENCODE_CLI: 'missing-owner-note-discard-qa-model' } });
let ownerCookie = '';
let stopping = false;

async function call(route, method = 'GET', body, token) {
  const pathOnly = route.split('?')[0];
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ownerCookie) headers.cookie = ownerCookie;
  if (token) {
    const timestamp = new Date().toISOString();
    const nonce = `owner-note-discard-visual-${crypto.randomUUID()}`;
    headers.authorization = `Bearer ${token}`;
    headers['x-hexigrid-timestamp'] = timestamp;
    headers['x-hexigrid-nonce'] = nonce;
    headers['x-hexigrid-signature'] = signatureFor({ token, method, pathname: pathOnly, timestamp, nonce, body: body ?? null });
  }
  const response = await fetch(origin + route, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie?.startsWith('hexigrid_session=')) ownerCookie = cookie;
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.exitCode !== null) throw new Error('The disposable server exited before readiness.');
    try { if ((await fetch(origin + '/')).ok) return; } catch { /* Wait for this fixture's own local server. */ }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('The disposable server did not become ready.');
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill();
    await exited;
  }
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(dataDir);
  const relative = path.relative(tempRoot, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
    path.basename(target).startsWith('hexigrid-owner-note-discard-'), 'cleanup target remains this exact disposable fixture directory');
  await rm(target, { recursive: true, force: true });
}

process.on('SIGINT', () => { void stop().then(() => process.exit()); });
process.on('SIGTERM', () => { void stop().then(() => process.exit()); });

async function pairAndSeed(name, externalId, index) {
  const capabilities = ['messages', 'cognition', 'identity', 'memory-read', 'memory-write'];
  const invited = await call('/api/agent-links/invites', 'POST', { capabilities });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const invitation = new URL(invited.body.invitationUrl);
  const secret = new URLSearchParams(invitation.hash.slice(1)).get('secret');
  const paired = await call('/agent-link/v1/pair', 'POST', { inviteId: invited.body.invite.id, secret,
    identity: { name, framework: 'ilands', externalId }, capabilities });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const link = paired.body;
  const trust = await call(`/api/agent-links/${link.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true });
  assert.equal(trust.status, 200, JSON.stringify(trust.body));
  const noteAdded = await call(`/api/agents/${link.agent.id}/memories`, 'POST', {
    content: `Synthetic fixture ${index}: follow the old greenhouse checklist without checking its date.`, category: 'Process'
  });
  assert.equal(noteAdded.status, 201, JSON.stringify(noteAdded.body));
  const note = noteAdded.body.memory;
  const message = await call('/agent-link/v1/messages', 'POST', {
    clientMessageId: `owner-note-discard-${crypto.randomUUID()}`, text: fakeMessage
  }, link.token);
  assert.equal(message.status, 201, JSON.stringify(message.body));

  const date = new Date().toISOString().slice(0, 10);
  const brokenLog = path.join(dataDir, 'dated-memory', link.agent.continuityLineage.id, `${date}.json`);
  await mkdir(path.dirname(brokenLog), { recursive: true });
  await writeFile(brokenLog, 'synthetic broken dated-memory log for disposable discard UI fixture\n', 'utf8');

  const correction = { id: note.id, expectedRevision: 0,
    text: `Synthetic fixture ${index}: check the current greenhouse checklist date before answering.`,
    why: 'The synthetic signed message says the earlier checklist was outdated.',
    expectedNextBehavior: 'Compare the checklist date before relying on it.', sourceMessageId: message.body.message.id };
  const proposed = await call('/agent-link/v1/memory-mcp', 'POST', { jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'propose-owner-memory-correction', arguments: correction } }, link.token);
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.result.structuredContent.capturePending, true, JSON.stringify(proposed.body));
  const proposalId = proposed.body.result.structuredContent.proposalId;
  assert.ok(proposalId, 'the approved pending capture is visible to owner review');

  const changed = await call(`/api/memories/${note.id}`, 'PATCH', {
    content: `Synthetic fixture ${index}: owner updated the current checklist after the pending capture.`,
    reason: 'Synthetic UI fixture makes the saved capture intent stale.', expectedRevision: 1
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const failedFinish = await call(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' });
  assert.equal(failedFinish.status, 409, JSON.stringify(failedFinish.body));
  const signedRetry = await call('/agent-link/v1/memory-mcp', 'POST', { jsonrpc: '2.0', id: 2,
    method: 'tools/call', params: { name: 'propose-owner-memory-correction', arguments: correction } }, link.token);
  assert.equal(signedRetry.status, 409, JSON.stringify(signedRetry.body));
  if (inactiveLineage) {
    const { unlink } = await import('node:fs/promises');
    await unlink(brokenLog);
    const categories = Object.fromEntries(CONTINUITY_CATEGORIES.map(category => [category, {
      status: REQUIRED_CONTINUITY_CATEGORIES.includes(category) ? 'complete' : 'platform-bound',
      summary: category, reason: category === 'platformAssets' ? 'Synthetic fixture provider.' : '',
      data: { value: `synthetic-${category}` }
    }]));
    const draft = await call(`/api/agents/${link.agent.id}/continuity-draft`, 'POST',
      { snapshot: { source: { framework: 'hexigrid' }, categories } });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const requested = await call(`/api/agents/${link.agent.id}/continuity-export-request`, 'POST', {});
    assert.equal(requested.status, 202, JSON.stringify(requested.body));
    const moved = await call(`/api/agents/${link.agent.id}/continuity-package`, 'POST', {
      passphrase: 'public disposable lineage fixture', requestId: requested.body.request.id, moveActivity: true
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    const queue = await call(`/api/memory-proposals?agentId=${link.agent.id}`);
    assert.equal(queue.body.proposals.find(item => item.id === proposalId)?.captureRetryUnavailable, true);
  }
  return { name, agentId: link.agent.id, proposalId, brokenLog };
}

try {
  await waitForServer();
  const login = await call('/api/auth/setup', 'POST', { password: passphrase });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const settings = await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full', setupAcknowledged: true });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  const fixtures = [];
  for (const [index, name] of syntheticNames.entries()) {
    fixtures.push(await pairAndSeed(name, `owner-note-discard-qa-${index + 1}`, index + 1));
  }
  console.log(JSON.stringify({ origin, view: '/#memory', synthetic: true,
    state: inactiveLineage ? 'two-approved-inactive-lineage-captures' : 'two-approved-stale-owner-note-captures', profiles: fixtures.map(({ name }) => name),
    dataDir, cleanup: 'Enter stop in this terminal or press Ctrl+C.' }));
  process.stdin.setEncoding('utf8');
  const input = readline.createInterface({ input: process.stdin });
  for await (const command of input) {
    if (command.trim() === 'stop') {
      input.close();
      break;
    }
  }
  await stop();
  console.log('Disposable owner-note visual fixture stopped and its temporary data was removed.');
} catch (error) {
  await stop();
  console.error(`Disposable owner-note fixture failed: ${error.message}`);
  process.exitCode = 1;
}
