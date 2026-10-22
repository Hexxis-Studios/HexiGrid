import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { signatureFor } from '../lib/agent-link.mjs';
import { CONTINUITY_CATEGORIES, REQUIRED_CONTINUITY_CATEGORIES } from '../lib/continuity-transfer.mjs';
import { normalizeOwnerMemory } from '../lib/owner-memory.mjs';
import { decryptBackup } from '../lib/backup.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let app; let dataDir; let workspaceRoot; let port; let relayPort; let origin; let ownerCookie = ''; let appOutput = '';

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});

async function call(pathname, method = 'GET', body, token, cookie = '') {
  const pathOnly = pathname.split('?')[0];
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) {
    const timestamp = new Date().toISOString();
    const nonce = `owner-note-route-${crypto.randomUUID()}`;
    headers.authorization = `Bearer ${token}`;
    headers['x-hexigrid-timestamp'] = timestamp;
    headers['x-hexigrid-nonce'] = nonce;
    headers['x-hexigrid-signature'] = signatureFor({ token, method, pathname: pathOnly, timestamp, nonce, body: body ?? null });
  }
  const response = await fetch(`${origin}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function startApp() {
  appOutput = '';
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true,
    env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
      HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`, HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: workspaceRoot, OPENCODE_CLI: 'missing-owner-note-route-test-opencode' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [app.stdout, app.stderr]) stream.setEncoding('utf8').on('data', chunk => { appOutput = `${appOutput}${chunk}`.slice(-4000); });
  for (let count = 0; count < 100; count += 1) {
    try { if ((await fetch(`${origin}/`)).ok) return; } catch { /* The isolated server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Owner-note route fixture did not start. ${appOutput}`);
}

async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const stopped = new Promise(resolve => app.once('exit', resolve));
  app.kill();
  await stopped;
}

async function loginOwner() {
  let login = await call('/api/auth/login', 'POST', { password: 'owner-note-route-test-passphrase' });
  if (login.response.status === 409 && /Create the local passcode first/.test(login.body.error)) {
    login = await call('/api/auth/setup', 'POST', { password: 'owner-note-route-test-passphrase' });
  }
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  ownerCookie = login.response.headers.get('set-cookie').split(';', 1)[0];
}

async function pair(name, externalId, agentId = '') {
  const capabilities = ['messages', 'cognition', 'identity', 'memory-read', 'memory-write'];
  const invited = await call('/api/agent-links/invites', 'POST', { capabilities, ...(agentId ? { agentId } : {}) }, undefined, ownerCookie);
  assert.equal(invited.response.status, 201, JSON.stringify(invited.body));
  const invitation = new URL(invited.body.invitationUrl);
  const secret = new URLSearchParams(invitation.hash.slice(1)).get('secret');
  const paired = await call('/agent-link/v1/pair', 'POST', {
    inviteId: invited.body.invite.id, secret,
    identity: { name, framework: 'ilands', externalId }, capabilities
  }, undefined, ownerCookie);
  assert.equal(paired.response.status, 201, JSON.stringify(paired.body));
  return paired.body;
}

async function addOwnerNote(agentId, content) {
  const result = await call(`/api/agents/${agentId}/memories`, 'POST', { content, category: 'Process' }, undefined, ownerCookie);
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.memory;
}

async function sendSource(token, text) {
  const result = await call('/agent-link/v1/messages', 'POST', {
    clientMessageId: `owner-note-observation-${crypto.randomUUID()}`, text
  }, token);
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.message;
}

async function proposeOwnerNote(token, payload) {
  return call('/agent-link/v1/memory-mcp', 'POST', { jsonrpc: '2.0', id: crypto.randomInt(1, 1_000_000),
    method: 'tools/call', params: { name: 'propose-owner-memory-correction', arguments: payload } }, token);
}

async function discardOwnerNoteCapture(token, proposalId) {
  return call('/agent-link/v1/memory-mcp', 'POST', { jsonrpc: '2.0', id: crypto.randomInt(1, 1_000_000),
    method: 'tools/call', params: { name: 'propose-owner-memory-correction',
      arguments: { action: 'discard-capture', proposalId } } }, token);
}

async function listOwnerNoteCaptureRetries(token, args = {}, { notification = false } = {}) {
  return call('/agent-link/v1/memory-mcp', 'POST', { jsonrpc: '2.0',
    ...(notification ? {} : { id: crypto.randomInt(1, 1_000_000) }), method: 'tools/call',
    params: { name: 'list-owner-note-capture-retries', arguments: args } }, token);
}

async function makePendingOwnerNoteCapture(name, externalId, { ownerTrusted = false } = {}) {
  const linked = await pair(name, externalId);
  if (ownerTrusted) {
    const trust = await call(`/api/agent-links/${linked.connection.id}/trust`, 'PATCH',
      { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
    assert.equal(trust.response.status, 200, JSON.stringify(trust.body));
  }
  const note = await addOwnerNote(linked.agent.id, 'Use the earlier checklist without checking its date.');
  const source = await sendSource(linked.token, 'I used an old checklist and gave an incorrect date.');
  const payload = { id: note.id, expectedRevision: 0, text: 'Check the current checklist date before answering.',
    why: 'The signed response relied on an outdated checklist.',
    expectedNextBehavior: 'Compare the current checklist date before relying on it.', sourceMessageId: source.id };
  const date = new Date().toISOString().slice(0, 10);
  const brokenLog = path.join(dataDir, 'dated-memory', linked.agent.continuityLineage.id, `${date}.json`);
  await mkdir(path.dirname(brokenLog), { recursive: true });
  await writeFile(brokenLog, 'synthetic invalid log to keep the capture pending\n', 'utf8');
  const proposed = await proposeOwnerNote(linked.token, payload);
  assert.equal(proposed.response.status, 200, JSON.stringify(proposed.body));
  const result = proposed.body.result.structuredContent;
  const proposalId = result.proposalId;
  assert.ok(proposalId, 'the saved owner-note proposal retains an ID for the discard action');
  if (ownerTrusted) {
    assert.equal(result.status, 'approved');
    assert.equal(result.capturePending, true, JSON.stringify(result));
  } else {
    const approved = await call(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' }, undefined, ownerCookie);
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.capturePending, true, JSON.stringify(approved.body));
  }
  return { ...linked, note, source, payload, proposalId, brokenLog };
}

async function suspendLineageForTest(agentId) {
  const categories = Object.fromEntries(CONTINUITY_CATEGORIES.map(name => [name, {
    status: REQUIRED_CONTINUITY_CATEGORIES.includes(name) ? 'complete' : 'platform-bound', summary: name,
    reason: name === 'platformAssets' ? 'Owned by the synthetic test provider.' : '', data: { value: `synthetic-${name}` }
  }]));
  const draft = await call(`/api/agents/${agentId}/continuity-draft`, 'POST',
    { snapshot: { source: { framework: 'hexigrid' }, categories } }, undefined, ownerCookie);
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  const requested = await call(`/api/agents/${agentId}/continuity-export-request`, 'POST', {}, undefined, ownerCookie);
  assert.equal(requested.response.status, 202, JSON.stringify(requested.body));
  const exported = await call(`/api/agents/${agentId}/continuity-package`, 'POST', {
    passphrase: 'synthetic lineage suspension fixture', requestId: requested.body.request.id, moveActivity: true
  }, undefined, ownerCookie);
  assert.equal(exported.response.status, 201, JSON.stringify(exported.body));
}

async function readMistakeRecords() {
  const found = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const selected = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(selected);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const log = JSON.parse(await readFile(selected, 'utf8'));
          for (const item of log.entries || []) {
            const record = item.metadata?.memoryMistake?.record;
            if (record?.format === 'hexigrid-memory-mistake') found.push(record);
          }
        } catch { /* A corrupt test fixture is deliberately excluded from record inspection. */ }
      }
    }
  }
  await walk(path.join(dataDir, 'dated-memory'));
  return found;
}

async function mistakeSnapshot() {
  return (await readMistakeRecords()).sort((left, right) => left.id.localeCompare(right.id));
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-owner-note-correction-route-'));
  workspaceRoot = path.join(dataDir, 'link-workspaces');
  await mkdir(workspaceRoot, { recursive: true });
  port = await freePort();
  relayPort = await freePort();
  origin = `http://127.0.0.1:${port}`;
  await startApp();
  await loginOwner();
  const settings = await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  assert.equal(settings.response.status, 200, JSON.stringify(settings.body));
});

after(async () => {
  await stopApp();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('owner reconfirms an overdue note with two audited revisions and unchanged rejected requests', async () => {
  const linked = await pair('Reconfirmation QA', 'owner-reconfirmation-qa');
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const create = await call(`/api/agents/${linked.agent.id}/memories`, 'POST', {
    content: 'PRIVATE-RECONFIRM-FACT: synthetic bridge route', category: 'temporary',
    evidence_excerpt: 'PRIVATE-RECONFIRM-EVIDENCE', valid_while: 'Synthetic bridge remains installed',
    verify_by: yesterday, status: 'conditional'
  }, undefined, ownerCookie);
  assert.equal(create.response.status, 201);
  const id = create.body.memory.id, route = `/api/memories/${id}/confirm`;
  const original = { expectedRevision: 0, approved: true, why: 'PRIVATE-RECONFIRM-REASON: owner reviewed the synthetic source' };
  const unconfirmedRenewal = await call(route, 'POST', { ...original, nextVerifyBy: future }, undefined, ownerCookie);
  assert.equal(unconfirmedRenewal.response.status, 409);
  const initial = await call(route, 'POST', original, undefined, ownerCookie);
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body));
  const snapshot = initial.body.memory;
  assert.equal(snapshot.revisions.length, 1, 'existing confirmation remains one revision');
  const request = { ...original, expectedRevision: 1, nextVerifyBy: future };
  const readCurrent = async () => (await call(`/api/agents/${linked.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(note => note.id === id);
  const rejection = async (body, status, token, cookie = ownerCookie) => {
    const response = await call(route, 'POST', body, token, cookie);
    assert.equal(response.response.status, status, JSON.stringify(response.body));
    assert.deepEqual(await readCurrent(), snapshot, 'rejected renewal cannot mutate note or audit');
  };
  await rejection({ ...request, expectedRevision: 0 }, 409);
  for (const date of [null, '', today, yesterday, '2099-02-30', '2099-13-01']) {
    await rejection({ ...request, nextVerifyBy: date }, 400);
  }
  await rejection({ ...request, approved: false }, 400);
  await rejection({ ...request, why: '' }, 400);
  await rejection({ ...original, expectedRevision: 1 }, 400, undefined, ownerCookie);
  await rejection(request, 401, undefined, '');
  await rejection(request, 401, linked.token, '');
  await call('/api/settings', 'PATCH', { workMode: 'plan' }, undefined, ownerCookie);
  await rejection(request, 403);
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  const renewal = await call(route, 'POST', request, undefined, ownerCookie);
  assert.equal(renewal.response.status, 200, JSON.stringify(renewal.body));
  const result = renewal.body.memory;
  for (const key of ['id', 'agentId', 'category', 'content', 'importance', 'evidence_excerpt', 'valid_while', 'status', 'source', 'createdAt']) {
    assert.deepEqual(result[key], snapshot[key], `${key} preserved`);
  }
  assert.equal(result.verify_by, future);
  assert.equal(result.revisions.length, 3);
  assert.deepEqual(result.revisions[1].changes.verification, { from: 'owner-confirmed', to: 'unverified' });
  assert.deepEqual(result.revisions[2].changes.verification, { from: 'unverified', to: 'owner-confirmed' });
  assert.ok(result.revisions.slice(1).every(revision => /^owner:/.test(revision.by) && revision.why === request.why));
  assert.equal(normalizeOwnerMemory(JSON.parse(JSON.stringify(result))).verification, 'owner-confirmed');
  const again = await call(route, 'POST', { ...request, expectedRevision: 3 }, undefined, ownerCookie);
  assert.equal(again.response.status, 409, 'fresh confirmed note cannot be renewed again');
  assert.deepEqual(await readCurrent(), result);
  const receipts = (await call('/api/bootstrap', 'GET', undefined, undefined, ownerCookie)).body.receipts
    .filter(item => item.action === 'memory:confirm-owner-note');
  assert.equal(receipts.length, 2);
  assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE-RECONFIRM/);
  const retired = await call(`/api/agents/${linked.agent.id}/memories`, 'POST', {
    content: 'Synthetic retired note', status: 'historical', verify_by: yesterday
  }, undefined, ownerCookie);
  const retiredRoute = `/api/memories/${retired.body.memory.id}/confirm`;
  const retiredConfirmed = await call(retiredRoute, 'POST', original, undefined, ownerCookie);
  assert.equal(retiredConfirmed.response.status, 200);
  const retiredRenewal = await call(retiredRoute, 'POST', request, undefined, ownerCookie);
  assert.equal(retiredRenewal.response.status, 409, 'renewal cannot renew a historical standing');
  const retiredStored = (await call(`/api/agents/${linked.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(note => note.id === retired.body.memory.id);
  assert.deepEqual(retiredStored, retiredConfirmed.body.memory);
  await stopApp(); await startApp(); await loginOwner();
  assert.deepEqual(await readCurrent(), result, 'encrypted restart preserves both audited revisions');
});

test('signed owner-trusted capture is exact and idempotent; reviewed capture recovers after restart', async () => {
  const trusted = await pair('Owner-note auto capture', 'owner-note-auto-capture');
  const trust = await call(`/api/agent-links/${trusted.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
  assert.equal(trust.response.status, 200, JSON.stringify(trust.body));
  const autoNote = await addOwnerNote(trusted.agent.id, 'Use yesterday’s ledger without checking its date.');
  const autoSource = await sendSource(trusted.token, 'I used an earlier ledger and missed the updated date.');
  const autoArgs = { id: autoNote.id, expectedRevision: 0, text: 'Check the current ledger date before answering.',
    why: 'The signed response used an older ledger.', expectedNextBehavior: 'Compare the ledger date before the next response.',
    sourceMessageId: autoSource.id };
  const autoFirst = await proposeOwnerNote(trusted.token, autoArgs);
  assert.equal(autoFirst.response.status, 200, JSON.stringify(autoFirst.body));
  const autoResult = autoFirst.body.result.structuredContent;
  assert.equal(autoResult.status, 'approved');
  assert.equal(autoResult.captureComplete, true);
  assert.equal(autoResult.capturePending, false);
  assert.match(autoResult.ownerNoteMistakeId, /^mistake-[0-9a-f-]{36}$/);

  const autoAgain = await proposeOwnerNote(trusted.token, autoArgs);
  assert.equal(autoAgain.response.status, 200, JSON.stringify(autoAgain.body));
  assert.equal(autoAgain.body.result.structuredContent.ownerNoteMistakeId, autoResult.ownerNoteMistakeId);
  assert.equal(autoAgain.body.result.structuredContent.captureComplete, true);
  let noteState = await call(`/api/agents/${trusted.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie);
  let retainedNote = noteState.body.memories.find(item => item.id === autoNote.id);
  assert.equal(retainedNote.revisions.length, 1, 'an exact retry does not append a second owner-note revision');
  assert.equal(retainedNote.revisions[0].source.text, autoSource.text);
  assert.equal((await readMistakeRecords()).filter(record => record.id === autoResult.ownerNoteMistakeId).length, 1,
    'an exact retry resolves to the one canonical dated receipt');

  const remaining = trust.body.connection.capabilities.filter(capability => capability !== 'memory-write');
  const revoked = await call(`/api/agent-links/${trusted.connection.id}/capabilities`, 'PATCH',
    { capabilities: remaining, approved: true }, undefined, ownerCookie);
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  assert.equal((await proposeOwnerNote(trusted.token, autoArgs)).response.status, 403,
    'the original signed Link cannot retry after memory-write is revoked');

  const reviewed = await pair('Owner-note reviewed recovery', 'owner-note-reviewed-recovery');
  const reviewedPrior = 'Use the outdated process without checking the current source.';
  const reviewedNote = await addOwnerNote(reviewed.agent.id, reviewedPrior);
  const reviewedSource = await sendSource(reviewed.token, 'I followed the wrong remembered procedure.');
  const reviewedArgs = { id: reviewedNote.id, expectedRevision: 0, text: 'Check the current source before answering.',
    why: 'The earlier procedure was unsafe.', expectedNextBehavior: 'Check the current source before relying on a procedure.',
    sourceMessageId: reviewedSource.id };
  const proposalResult = await proposeOwnerNote(reviewed.token, reviewedArgs);
  assert.equal(proposalResult.response.status, 200, JSON.stringify(proposalResult.body));
  const proposalId = proposalResult.body.result.structuredContent.proposalId;
  const waiting = await call(`/api/memory-proposals?agentId=${reviewed.agent.id}`, 'GET', undefined, undefined, ownerCookie);
  assert.ok(waiting.body.proposals.some(item => item.id === proposalId));

  const lineageId = reviewed.agent.continuityLineage.id;
  const blockedDate = new Date().toISOString().slice(0, 10);
  const corruptLog = path.join(dataDir, 'dated-memory', lineageId, `${blockedDate}.json`);
  await mkdir(path.dirname(corruptLog), { recursive: true });
  await writeFile(corruptLog, 'not a dated-memory log\n', 'utf8');
  const firstApproval = await call(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(firstApproval.response.status, 200, JSON.stringify(firstApproval.body));
  assert.equal(firstApproval.body.status, 'approved');
  assert.equal(firstApproval.body.capturePending, true);
  assert.equal(firstApproval.body.captureComplete, false);
  noteState = await call(`/api/agents/${reviewed.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie);
  retainedNote = noteState.body.memories.find(item => item.id === reviewedNote.id);
  assert.equal(retainedNote.revisions.length, 1, 'capture failure preserves the already-saved append-only note revision');
  assert.equal(retainedNote.content, reviewedArgs.text);

  const rejectsRollback = await call(`/api/memory-proposals/${proposalId}/decision`, 'POST',
    { decision: 'reject', reason: 'Do not reject an already committed correction.' }, undefined, ownerCookie);
  assert.equal(rejectsRollback.response.status, 409, 'an approved capture recovery cannot be represented as a rejection');
  assert.equal((await call(`/api/memory-proposals?agentId=${reviewed.agent.id}`, 'GET', undefined, undefined, ownerCookie))
    .body.proposals.find(item => item.id === proposalId).capturePending, true);

  await stopApp();
  await startApp();
  await loginOwner();
  const recoverable = await call(`/api/memory-proposals?agentId=${reviewed.agent.id}`, 'GET', undefined, undefined, ownerCookie);
  const captureRecord = recoverable.body.proposals.find(item => item.id === proposalId);
  assert.equal(captureRecord.capturePending, true, 'startup normalization retains the approved unfinished capture');
  assert.equal(Object.hasOwn(captureRecord, 'ownerNoteCaptureIntent'), false, 'the private retry intent is not returned by the review API');
  assert.equal(Object.hasOwn(captureRecord, 'ownerNoteCaptureTokenHash'), false, 'the pinned credential hash is not returned by the review API');
  await unlink(corruptLog);

  const recovered = await call(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.status, 'approved');
  assert.equal(recovered.body.captureComplete, true);
  assert.equal(recovered.body.capturePending, false);
  assert.match(recovered.body.ownerNoteMistakeId, /^mistake-[0-9a-f-]{36}$/);
  noteState = await call(`/api/agents/${reviewed.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie);
  retainedNote = noteState.body.memories.find(item => item.id === reviewedNote.id);
  assert.equal(retainedNote.revisions.length, 1, 'recovery resumes only the dated capture, not another note revision');
  const recoveredRecords = (await readMistakeRecords()).filter(record => record.id === recovered.body.ownerNoteMistakeId);
  assert.equal(recoveredRecords.length, 1);
  assert.equal(recoveredRecords[0].whatWentWrong, reviewedPrior);
  assert.equal(recoveredRecords[0].evidence.id, reviewedSource.id);
  assert.equal(recoveredRecords[0].evidence.excerpt, reviewedSource.text);
  assert.deepEqual(recoveredRecords[0].contextScope, { projectId: 'owner-notes', topicId: reviewed.agent.id });
});

test('owner-trusted Link recovers its pending capture after a lost response ID without exposing private capture data', async () => {
  const reviewed = await makePendingOwnerNoteCapture('Capture retry discovery owner review', 'capture-retry-discovery-owner-review');
  const beforeTrust = await listOwnerNoteCaptureRetries(reviewed.token);
  assert.equal(beforeTrust.response.status, 403, 'a scoped Link cannot discover owner-note capture retries');

  const trust = await call(`/api/agent-links/${reviewed.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
  assert.equal(trust.response.status, 200, JSON.stringify(trust.body));

  const secondNote = await addOwnerNote(reviewed.agent.id, 'PRIVATE-SECOND-ORIGINAL-NOTE: check the old source.');
  const secondSource = await sendSource(reviewed.token, 'PRIVATE-SECOND-SOURCE: I used an outdated source.');
  const secondPayload = { id: secondNote.id, expectedRevision: 0,
    text: 'PRIVATE-SECOND-CORRECTION: check the current source.',
    why: 'PRIVATE-SECOND-INTENT: the earlier source was stale.',
    expectedNextBehavior: 'Check the current source before answering.', sourceMessageId: secondSource.id };
  const secondBrokenLog = path.join(dataDir, 'dated-memory', reviewed.agent.continuityLineage.id,
    `${new Date().toISOString().slice(0, 10)}.json`);
  await mkdir(path.dirname(secondBrokenLog), { recursive: true });
  await writeFile(secondBrokenLog, 'synthetic invalid log to hold the second capture pending\n', 'utf8');
  const secondProposal = await proposeOwnerNote(reviewed.token, secondPayload);
  assert.equal(secondProposal.response.status, 200, JSON.stringify(secondProposal.body));
  assert.equal(secondProposal.body.result.structuredContent.capturePending, true);
  const secondProposalId = secondProposal.body.result.structuredContent.proposalId;

  const listed = await listOwnerNoteCaptureRetries(reviewed.token, { limit: 1 });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  const page = listed.body.result.structuredContent;
  assert.equal(page.total, 2, 'discovery is scoped to the authenticated Link after the original response ID is lost');
  assert.equal(page.captures.length, 1, 'the caller-supplied result limit is enforced');
  assert.equal(page.omittedCount, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.complete, false);

  const allListed = await listOwnerNoteCaptureRetries(reviewed.token, { limit: 50 });
  assert.equal(allListed.response.status, 200, JSON.stringify(allListed.body));
  const allCaptures = allListed.body.result.structuredContent.captures;
  assert.deepEqual(new Set(allCaptures.map(item => item.proposalId)), new Set([reviewed.proposalId, secondProposalId]));
  for (const capture of allCaptures) {
    assert.deepEqual(Object.keys(capture).sort(), ['captureState', 'noteId', 'noteRevision', 'proposalId']);
    assert.equal(capture.captureState, 'pending');
    assert.equal(capture.noteRevision, 1);
  }
  assert.deepEqual(allListed.body.result.content, [], 'private capture metadata is carried only in the bounded structured result');
  for (const privateValue of [reviewed.token, reviewed.source.text, reviewed.payload.why,
    'Use the earlier checklist without checking its date.', 'hexigrid-owner-memory-correction-capture',
    'PRIVATE-SECOND-ORIGINAL-NOTE', 'PRIVATE-SECOND-SOURCE', 'PRIVATE-SECOND-INTENT']) {
    assert.doesNotMatch(JSON.stringify(allListed.body), new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(JSON.stringify(allListed.body), /captureIntent|ownerNoteCaptureIntent|tokenHash|intentDigest|sourceMessageId/i);

  const unknownArgument = await listOwnerNoteCaptureRetries(reviewed.token, { linkId: reviewed.connection.id });
  assert.equal(unknownArgument.response.status, 200);
  assert.ok(unknownArgument.body.error, 'caller-supplied Link selectors are rejected by the tool schema');
  const overLimit = await listOwnerNoteCaptureRetries(reviewed.token, { limit: 51 });
  assert.equal(overLimit.response.status, 200);
  assert.ok(overLimit.body.error, 'the item bound is enforced');
  const overBudget = await listOwnerNoteCaptureRetries(reviewed.token, { maxBytes: 32769 });
  assert.equal(overBudget.response.status, 200);
  assert.ok(overBudget.body.error, 'the byte bound is enforced');

  const receipt = (await call('/api/bootstrap', 'GET', undefined, undefined, ownerCookie)).body.receipts
    .find(item => item.action === 'memory:list-owner-note-capture-retries');
  assert.ok(receipt, 'the local read receipt is saved');
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE-SECOND|outdated source|captureIntent|tokenHash|intentDigest/i,
    'the receipt does not disclose source, intent, or token material');

  const notificationCount = (await call('/api/bootstrap', 'GET', undefined, undefined, ownerCookie)).body.receipts
    .filter(item => item.action === 'memory:list-owner-note-capture-retries').length;
  const notification = await listOwnerNoteCaptureRetries(reviewed.token, {}, { notification: true });
  assert.equal(notification.response.status, 202);
  assert.deepEqual(notification.body, {}, 'a JSON-RPC notification has no result body');
  assert.equal((await call('/api/bootstrap', 'GET', undefined, undefined, ownerCookie)).body.receipts
    .filter(item => item.action === 'memory:list-owner-note-capture-retries').length, notificationCount,
  'a notification does not produce a result or read receipt');

  const foreign = await pair('Foreign capture retry Link', 'capture-retry-foreign', reviewed.agent.id);
  const foreignTrust = await call(`/api/agent-links/${foreign.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
  assert.equal(foreignTrust.response.status, 200, JSON.stringify(foreignTrust.body));
  const foreignList = await listOwnerNoteCaptureRetries(foreign.token);
  assert.equal(foreignList.response.status, 200, JSON.stringify(foreignList.body));
  assert.equal(foreignList.body.result.structuredContent.total, 0,
    'another owner-trusted Link for the same agent cannot discover this exact Link’s capture');

  const blockedPolicy = await call('/api/settings', 'PATCH', { workMode: 'converse' }, undefined, ownerCookie);
  assert.equal(blockedPolicy.response.status, 200, JSON.stringify(blockedPolicy.body));
  const policyDenied = await listOwnerNoteCaptureRetries(reviewed.token);
  assert.equal(policyDenied.response.status, 403, 'a conversation-only policy blocks private capture discovery');
  const restoredPolicy = await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  assert.equal(restoredPolicy.response.status, 200, JSON.stringify(restoredPolicy.body));

  const noRead = reviewed.connection.capabilities.filter(capability => capability !== 'memory-read');
  const revokedRead = await call(`/api/agent-links/${reviewed.connection.id}/capabilities`, 'PATCH',
    { capabilities: noRead, approved: true }, undefined, ownerCookie);
  assert.equal(revokedRead.response.status, 200, JSON.stringify(revokedRead.body));
  assert.equal((await listOwnerNoteCaptureRetries(reviewed.token)).response.status, 403,
    'discovery requires the current memory-read grant');
  const restoredRead = await call(`/api/agent-links/${reviewed.connection.id}/capabilities`, 'PATCH',
    { capabilities: reviewed.connection.capabilities, approved: true }, undefined, ownerCookie);
  assert.equal(restoredRead.response.status, 200, JSON.stringify(restoredRead.body));

  const discarded = await discardOwnerNoteCapture(reviewed.token, reviewed.proposalId);
  assert.equal(discarded.response.status, 200, JSON.stringify(discarded.body));
  const afterDiscard = await listOwnerNoteCaptureRetries(reviewed.token);
  assert.equal(afterDiscard.response.status, 200, JSON.stringify(afterDiscard.body));
  assert.equal(afterDiscard.body.result.structuredContent.total, 1,
    'terminal discard removes only that retry from discovery');
  assert.equal(afterDiscard.body.result.structuredContent.captures[0].proposalId, secondProposalId);

  await unlink(secondBrokenLog);
  const completedLink = await makePendingOwnerNoteCapture('Completed capture retry Link', 'capture-retry-completed', { ownerTrusted: true });
  await unlink(completedLink.brokenLog);
  const completed = await proposeOwnerNote(completedLink.token, completedLink.payload);
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.result.structuredContent.captureComplete, true);
  const completedList = await listOwnerNoteCaptureRetries(completedLink.token);
  assert.equal(completedList.response.status, 200, JSON.stringify(completedList.body));
  assert.equal(completedList.body.result.structuredContent.total, 0,
    'completed captures are omitted from discovery');

  const inactive = await makePendingOwnerNoteCapture('Inactive capture retry lineage', 'capture-retry-inactive-lineage');
  const inactiveTrust = await call(`/api/agent-links/${inactive.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
  assert.equal(inactiveTrust.response.status, 200, JSON.stringify(inactiveTrust.body));
  await unlink(inactive.brokenLog);
  await suspendLineageForTest(inactive.agent.id);
  assert.equal((await listOwnerNoteCaptureRetries(inactive.token)).response.status, 403,
    'a suspended or superseded lineage cannot discover pending captures');
});

test('owner and owner-trusted Link discard stale captures without changing notes or evidence', async () => {
  const recordsBefore = await mistakeSnapshot();
  const reviewed = await makePendingOwnerNoteCapture('Owner discard reviewed', 'owner-discard-reviewed');
  const foreign = await pair('Foreign discard Link', 'owner-discard-foreign');
  const foreignTrust = await call(`/api/agent-links/${foreign.connection.id}/trust`, 'PATCH',
    { trustLevel: 'owner', approved: true }, undefined, ownerCookie);
  assert.equal(foreignTrust.response.status, 200, JSON.stringify(foreignTrust.body));

  const nonOwnerAttempt = await discardOwnerNoteCapture(reviewed.token, reviewed.proposalId);
  assert.equal(nonOwnerAttempt.response.status, 403, 'a scoped non-owner-trusted Link cannot discard an owner capture');
  const foreignAttempt = await discardOwnerNoteCapture(foreign.token, reviewed.proposalId);
  assert.equal(foreignAttempt.response.status, 404, 'a foreign Link cannot discover another agent’s proposal');

  const laterEdit = await call(`/api/memories/${reviewed.note.id}`, 'PATCH', {
    content: 'The owner updated the current checklist after the correction was approved.',
    reason: 'A later owner review superseded the capture intent.', expectedRevision: 1
  }, undefined, ownerCookie);
  assert.equal(laterEdit.response.status, 200, JSON.stringify(laterEdit.body));
  const staleFinish = await call(`/api/memory-proposals/${reviewed.proposalId}/decision`, 'POST',
    { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(staleFinish.response.status, 409, 'a stale approved capture is not silently recaptured');

  const noteBeforeDiscard = (await call(`/api/agents/${reviewed.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(item => item.id === reviewed.note.id);
  assert.equal(noteBeforeDiscard.content, laterEdit.body.memory.content);
  assert.equal(noteBeforeDiscard.revisions.length, 2);
  assert.deepEqual(noteBeforeDiscard.revisions[0].source,
    { kind: 'agent-link-message', id: reviewed.source.id, linkId: reviewed.connection.id,
      text: reviewed.source.text, createdAt: reviewed.source.createdAt }, 'the original signed source remains in append-only note history');

  const deniedPolicy = await call('/api/settings', 'PATCH', { workMode: 'plan' }, undefined, ownerCookie);
  assert.equal(deniedPolicy.response.status, 200, JSON.stringify(deniedPolicy.body));
  const policyBlocked = await discardOwnerNoteCapture(reviewed.token, reviewed.proposalId);
  assert.equal(policyBlocked.response.status, 403, 'the signed discard still passes current read/write policy checks');
  const restoredPolicy = await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  assert.equal(restoredPolicy.response.status, 200, JSON.stringify(restoredPolicy.body));

  const discarded = await call(`/api/memory-proposals/${reviewed.proposalId}/decision`, 'POST',
    { decision: 'discard-capture' }, undefined, ownerCookie);
  assert.equal(discarded.response.status, 200, JSON.stringify(discarded.body));
  assert.equal(discarded.body.status, 'approved');
  assert.equal(discarded.body.ownerNoteCaptureState, 'discarded');
  assert.equal(discarded.body.capturePending, false);
  assert.equal(discarded.body.captureComplete, false);
  assert.equal(discarded.body.captureDiscarded, true);
  assert.equal(discarded.body.duplicate, false);
  const noteAfterDiscard = (await call(`/api/agents/${reviewed.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(item => item.id === reviewed.note.id);
  assert.deepEqual(noteAfterDiscard, noteBeforeDiscard, 'discard leaves the latest note and every source revision unchanged');
  assert.deepEqual(await mistakeSnapshot(), recordsBefore, 'discard leaves no dated mistake record or copied evidence');

  const duplicate = await call(`/api/memory-proposals/${reviewed.proposalId}/decision`, 'POST',
    { decision: 'discard-capture' }, undefined, ownerCookie);
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.captureDiscarded, true);
  assert.equal(duplicate.body.duplicate, true);
  const approveReplay = await call(`/api/memory-proposals/${reviewed.proposalId}/decision`, 'POST',
    { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(approveReplay.response.status, 200, JSON.stringify(approveReplay.body));
  assert.equal(approveReplay.body.captureDiscarded, true, 'approve retry reports the terminal decision instead of recapturing');
  assert.deepEqual(await mistakeSnapshot(), recordsBefore);

  const trusted = await makePendingOwnerNoteCapture('Owner-trusted discard race', 'owner-discard-trusted', { ownerTrusted: true });
  const trustedNoteBefore = (await call(`/api/agents/${trusted.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(item => item.id === trusted.note.id);
  const race = await Promise.all([
    call(`/api/memory-proposals/${trusted.proposalId}/decision`, 'POST', { decision: 'approve' }, undefined, ownerCookie),
    discardOwnerNoteCapture(trusted.token, trusted.proposalId)
  ]);
  assert.equal(race[0].response.status, 200, JSON.stringify(race[0].body));
  assert.equal(race[1].response.status, 200, JSON.stringify(race[1].body));
  const signedResult = race[1].body.result.structuredContent;
  assert.equal(signedResult.ownerNoteCaptureState, 'discarded');
  assert.equal(signedResult.capturePending, false);
  assert.equal(signedResult.captureComplete, false);
  assert.equal(signedResult.captureDiscarded, true);
  const signedDuplicate = await discardOwnerNoteCapture(trusted.token, trusted.proposalId);
  assert.equal(signedDuplicate.response.status, 200, JSON.stringify(signedDuplicate.body));
  assert.equal(signedDuplicate.body.result.structuredContent.duplicate, true);
  const trustedNoteAfter = (await call(`/api/agents/${trusted.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie))
    .body.memories.find(item => item.id === trusted.note.id);
  assert.deepEqual(trustedNoteAfter, trustedNoteBefore, 'signed discard races do not rewrite an owner note');
  assert.deepEqual(await mistakeSnapshot(), recordsBefore, 'a capture retry cannot restore pending after discard');

  const revoked = await makePendingOwnerNoteCapture('Owner discard revoked Link', 'owner-discard-revoked', { ownerTrusted: true });
  const remaining = revoked.connection.capabilities.filter(capability => capability !== 'memory-write');
  const revocation = await call(`/api/agent-links/${revoked.connection.id}/capabilities`, 'PATCH',
    { capabilities: remaining, approved: true }, undefined, ownerCookie);
  assert.equal(revocation.response.status, 200, JSON.stringify(revocation.body));
  const revokedAttempt = await discardOwnerNoteCapture(revoked.token, revoked.proposalId);
  assert.equal(revokedAttempt.response.status, 403, 'the signed discard requires the exact current memory-write grant');

  const inactive = await makePendingOwnerNoteCapture('Inactive lineage discard', 'owner-discard-inactive-lineage', { ownerTrusted: true });
  await unlink(inactive.brokenLog);
  await suspendLineageForTest(inactive.agent.id);
  const inactiveBefore = (await call(`/api/agents/${inactive.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie)).body.memories;
  const inactiveQueue = await call(`/api/memory-proposals?agentId=${inactive.agent.id}`, 'GET', undefined, undefined, ownerCookie);
  const inactiveRow = inactiveQueue.body.proposals.find(item => item.id === inactive.proposalId);
  assert.equal(inactiveRow.captureRetryUnavailable, true);
  assert.doesNotMatch(JSON.stringify(inactiveRow), /ownerNoteCaptureIntent|intentDigest|tokenHash/);
  const inactiveFinish = await call(`/api/memory-proposals/${inactive.proposalId}/decision`, 'POST',
    { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(inactiveFinish.response.status, 409, 'finishing still requires active lineage');
  assert.equal((await discardOwnerNoteCapture(inactive.token, inactive.proposalId)).response.status, 409,
    'the inactive signed agent cannot mutate its old capture');
  await call('/api/settings', 'PATCH', { workMode: 'plan' }, undefined, ownerCookie);
  const inactivePolicy = await call(`/api/memory-proposals/${inactive.proposalId}/decision`, 'POST',
    { decision: 'discard-capture' }, undefined, ownerCookie);
  assert.equal(inactivePolicy.response.status, 403, 'owner cleanup still honors write policy');
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  const inactiveAttempt = await call(`/api/memory-proposals/${inactive.proposalId}/decision`, 'POST',
    { decision: 'discard-capture' }, undefined, ownerCookie);
  assert.equal(inactiveAttempt.response.status, 200, JSON.stringify(inactiveAttempt.body));
  assert.equal(inactiveAttempt.body.captureDiscarded, true, 'the owner can terminally stop an inactive capture');
  const inactiveDuplicate = await call(`/api/memory-proposals/${inactive.proposalId}/decision`, 'POST',
    { decision: 'discard-capture' }, undefined, ownerCookie);
  assert.equal(inactiveDuplicate.body.duplicate, true);
  assert.deepEqual((await call(`/api/agents/${inactive.agent.id}/memories?manage=1`, 'GET', undefined, undefined, ownerCookie)).body.memories,
    inactiveBefore, 'cleanup preserves suspended agent notes and history');
  assert.deepEqual(await mistakeSnapshot(), recordsBefore, 'cleanup preserves dated evidence');

  await unlink(reviewed.brokenLog);
  await unlink(trusted.brokenLog);
  await unlink(revoked.brokenLog);
  await stopApp();
  await startApp();
  await loginOwner();

  const afterRestartQueue = await call(`/api/memory-proposals?agentId=${reviewed.agent.id}`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(afterRestartQueue.response.status, 200);
  assert.equal(afterRestartQueue.body.proposals.some(item => item.id === reviewed.proposalId), false,
    'startup normalization does not queue a discarded capture for retry');
  const normalizedOwnerReplay = await call(`/api/memory-proposals/${reviewed.proposalId}/decision`, 'POST',
    { decision: 'approve' }, undefined, ownerCookie);
  assert.equal(normalizedOwnerReplay.response.status, 200, JSON.stringify(normalizedOwnerReplay.body));
  assert.equal(normalizedOwnerReplay.body.captureDiscarded, true);
  const normalizedSignedReplay = await discardOwnerNoteCapture(trusted.token, trusted.proposalId);
  assert.equal(normalizedSignedReplay.response.status, 200, JSON.stringify(normalizedSignedReplay.body));
  assert.equal(normalizedSignedReplay.body.result.structuredContent.captureDiscarded, true);
  assert.equal(normalizedSignedReplay.body.result.structuredContent.duplicate, true);
  assert.deepEqual(await mistakeSnapshot(), recordsBefore, 'restart does not recapture discarded evidence');
});

test('owner memory checkpoints require approval, reject stale restore requests, and survive a local engine restart', async () => {
  const linked = await pair('Memory rollback route QA', 'memory-rollback-route-qa');
  const base = `/api/agents/${linked.agent.id}/memory-rollback-checkpoints`;
  assert.equal((await call(base)).response.status, 401, 'checkpoint reads require the local owner session');

  const created = await call(`/api/agents/${linked.agent.id}/memory-commit`, 'POST', {
    operation: 'create', text: 'Synthetic memory before the saved checkpoint.', status: 'active'
  }, undefined, ownerCookie);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const memoryId = created.body.id;
  const unapproved = await call(base, 'POST', { label: 'Before change' }, undefined, ownerCookie);
  assert.equal(unapproved.response.status, 400, 'checkpoint creation requires explicit approval');
  const checkpoint = await call(base, 'POST', { label: 'Before change', approved: true }, undefined, ownerCookie);
  assert.equal(checkpoint.response.status, 201, JSON.stringify(checkpoint.body));
  const exported = await call('/api/backup/export', 'POST', { passphrase: 'synthetic checkpoint backup test passphrase' }, undefined, ownerCookie);
  assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
  assert.doesNotMatch(JSON.stringify(exported.body.envelope), /Before change|hexigrid-memory-checkpoint-v1/,
    'the small restore token is present only inside the encrypted whole-app backup');
  const backup = decryptBackup(exported.body.envelope, 'synthetic checkpoint backup test passphrase');
  assert.equal(backup.memoryRollbackCheckpoints.some(item => item.id === checkpoint.body.checkpoint.id), true,
    'encrypted whole-app backup retains the checkpoint handle');

  const revise = async (expectedRevision, text, why) => call(`/api/agents/${linked.agent.id}/memory-commit`, 'POST', {
    operation: 'revise', id: memoryId, expectedRevision, changes: { text }, why
  }, undefined, ownerCookie);
  assert.equal((await revise(0, 'Synthetic memory after the first edit.', 'First isolated edit.')).response.status, 200);
  const staleView = await call(base, 'GET', undefined, undefined, ownerCookie);
  assert.equal(staleView.response.status, 200, JSON.stringify(staleView.body));
  assert.equal(staleView.body.checkpoints[0].id, checkpoint.body.checkpoint.id);
  assert.equal((await revise(1, 'Synthetic memory after the second edit.', 'Second isolated edit.')).response.status, 200);

  const staleRestore = await call(`${base}/${checkpoint.body.checkpoint.id}/restore`, 'POST', {
    approved: true, expectedCurrent: staleView.body.current, why: 'Stale-token rejection QA.'
  }, undefined, ownerCookie);
  assert.equal(staleRestore.response.status, 409, JSON.stringify(staleRestore.body));
  let currentFact = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=0`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(currentFact.body.memory.text, 'Synthetic memory after the second edit.');

  const head = (await call(base, 'GET', undefined, undefined, ownerCookie)).body.current;
  await call('/api/settings', 'PATCH', { workMode: 'plan' }, undefined, ownerCookie);
  const denied = await call(`${base}/${checkpoint.body.checkpoint.id}/restore`, 'POST', {
    approved: true, expectedCurrent: head, why: 'Plan-mode denial QA.'
  }, undefined, ownerCookie);
  assert.equal(denied.response.status, 403, JSON.stringify(denied.body));
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' }, undefined, ownerCookie);
  currentFact = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=0`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(currentFact.body.memory.text, 'Synthetic memory after the second edit.', 'policy denial leaves the memory unchanged');

  const allowedHead = (await call(base, 'GET', undefined, undefined, ownerCookie)).body.current;
  const restored = await call(`${base}/${checkpoint.body.checkpoint.id}/restore`, 'POST', {
    approved: true, expectedCurrent: allowedHead, why: 'Restore the reviewed synthetic checkpoint.'
  }, undefined, ownerCookie);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.changedRecords, 1);
  const depthOne = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=1`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(depthOne.body.memory.text, 'Synthetic memory before the saved checkpoint.');
  assert.equal(depthOne.body.memory.revision, 3);
  assert.equal(depthOne.body.memory.revisions.at(-1).why, 'Restore the reviewed synthetic checkpoint.');

  await stopApp();
  await startApp();
  await loginOwner();
  const afterRestart = await call(base, 'GET', undefined, undefined, ownerCookie);
  assert.equal(afterRestart.response.status, 200, JSON.stringify(afterRestart.body));
  assert.equal(afterRestart.body.checkpoints.some(item => item.id === checkpoint.body.checkpoint.id), true,
    'encrypted owner state retains the checkpoint handle across an app restart');
  const restoredAfterRestart = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=1`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(restoredAfterRestart.body.memory.text, 'Synthetic memory before the saved checkpoint.');

  const disposable = await call(base, 'POST', { label: 'Delete exact checkpoint QA', approved: true }, undefined, ownerCookie);
  assert.equal(disposable.response.status, 201);
  const unapprovedDelete = await call(`${base}/${disposable.body.checkpoint.id}`, 'DELETE', {}, undefined, ownerCookie);
  assert.equal(unapprovedDelete.response.status, 400);
  const deleted = await call(`${base}/${disposable.body.checkpoint.id}`, 'DELETE', { approved: true }, undefined, ownerCookie);
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  const unchanged = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=0`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(unchanged.body.memory.text, 'Synthetic memory before the saved checkpoint.', 'deleting a checkpoint never edits memory');

  const stopped = await call('/api/emergency/stop', 'POST', { approved: true }, undefined, ownerCookie);
  assert.equal(stopped.response.status, 200, JSON.stringify(stopped.body));
  const imported = await call('/api/backup/import', 'POST', { envelope: exported.body.envelope,
    passphrase: 'synthetic checkpoint backup test passphrase', confirmReplace: true, approved: true }, undefined, ownerCookie);
  assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
  const afterImport = await call(base, 'GET', undefined, undefined, ownerCookie);
  assert.equal(afterImport.body.checkpoints.length, 1);
  assert.equal(afterImport.body.checkpoints[0].id, checkpoint.body.checkpoint.id,
    'whole-app restore reinstates the encrypted checkpoint handle with its matching memory files');
  const importedFact = await call(`/api/agents/${linked.agent.id}/memory-facts/${memoryId}?depth=1`, 'GET', undefined, undefined, ownerCookie);
  assert.equal(importedFact.body.memory.text, 'Synthetic memory before the saved checkpoint.');
  assert.equal(importedFact.body.memory.revision, 0, 'the imported backup returns to its exact checkpoint head, without inventing revisions');
});
