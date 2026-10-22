import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { signatureFor } from '../lib/agent-link.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function cookieJar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    absorb(response) {
      const rows = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
      for (const row of rows) {
        const pair = row.split(';', 1)[0];
        const split = pair.indexOf('=');
        if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
    },
    csrf() { return decodeURIComponent(cookies.get('hexigrid_csrf') || ''); }
  };
}

function signedLinkHeaders(token, method, pathname, body) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-hexigrid-timestamp': timestamp,
    'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token, method, pathname, timestamp, nonce, body })
  };
}

test('owner agent model receives only bounded current scoped memory before dispatch and remains usable when memory is unavailable', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-turn-context-'));
  const port = await freePort();
  const relayPort = await freePort();
  const captured = [];
  const fakeProvider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    captured.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'fake-provider-reply' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: path.join(dataDir, 'agent-link-workspaces'),
      HEXIGRID_PODMAN: path.join(dataDir, 'missing-podman'), OPENCODE_CLI: 'missing-opencode-for-memory-context-test' }
  });
  const cookies = cookieJar();
  const origin = `http://127.0.0.1:${port}`;
  const request = async (pathname, method = 'GET', body) => {
    const headers = { ...(cookies.header() ? { cookie: cookies.header() } : {}) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      if (cookies.csrf()) headers['x-hexigrid-csrf'] = cookies.csrf();
    }
    const response = await fetch(`${origin}${pathname}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    cookies.absorb(response);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const waitUntilReady = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Isolated test server exited with code ${child.exitCode}.`);
      try { if ((await fetch(`${origin}/api/bootstrap`)).ok) return; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Isolated memory-context server did not start.');
  };
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => fakeProvider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitUntilReady();
  assert.equal((await request('/api/auth/status')).status, 200);
  assert.equal((await request('/api/auth/setup', 'POST', { password: 'memory-context-test-passphrase' })).status, 200);
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);

  const provider = await request('/api/providers', 'POST', {
    name: 'Disposable prompt capture', baseUrl: `http://127.0.0.1:${fakeProvider.address().port}/v1`,
    models: 'prompt-capture-model', apiStyle: 'openai-chat'
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  const createdAgent = await request('/api/agents', 'POST', {
    name: 'Memory context test agent', transport: 'local-opencode',
    model: `provider:${provider.body.provider.id}:prompt-capture-model`
  });
  assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent.body));
  const agent = createdAgent.body.agent;
  assert.equal(agent.useMemories, true);

  const scopedText = 'SCOPED-GREENHOUSE-FACT: the greenhouse plan uses basil and tomatoes.';
  const excludedText = 'EXCLUDED-OTHER-PROJECT: the greenhouse plan uses saffron and orchids.';
  for (const [text, projectId] of [[scopedText, 'greenhouse'], [excludedText, 'another-project']]) {
    const saved = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-commit`, 'POST', {
      operation: 'create', text, contextScope: { projectId }, importance: 0.95
    });
    assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
  }
  const ownerNoteText = 'OWNER-NOTE-ONLY: keep the travel mug on the desk.';
  const ownerNote = await request(`/api/agents/${encodeURIComponent(agent.id)}/memories`, 'POST', {
    category: 'Preference', content: ownerNoteText, importance: 4
  });
  assert.equal(ownerNote.status, 201, JSON.stringify(ownerNote.body));

  const grants = ['messages', 'status', 'memory-read', 'tasks'];
  const invitation = await request('/api/agent-links/invites', 'POST', {
    agentId: agent.id, capabilities: grants, approved: true
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const inviteUrl = new URL(invitation.body.invitationUrl);
  const paired = await fetch(`${origin}/agent-link/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inviteId: invitation.body.invite.id,
      secret: decodeURIComponent(inviteUrl.hash.slice('#secret='.length)),
      identity: { name: 'Scoped memory context test peer', framework: 'test', externalId: 'memory-context-peer' },
      capabilities: grants, clientDeviceId: `memory-context-${crypto.randomUUID()}`
    })
  });
  const pairedBody = await paired.json();
  assert.equal(paired.status, 201, JSON.stringify(pairedBody));
  const selectedScope = { scope: { projectId: 'greenhouse' } };
  const scopeResponse = await fetch(`${origin}/agent-link/v1/memory-scope`, {
    method: 'POST', headers: signedLinkHeaders(pairedBody.token, 'POST', '/agent-link/v1/memory-scope', selectedScope),
    body: JSON.stringify(selectedScope)
  });
  assert.equal(scopeResponse.status, 200, await scopeResponse.text());

  const contextResponse = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'What plants are in the greenhouse plan?'
  });
  assert.equal(contextResponse.status, 200, JSON.stringify(contextResponse.body));
  assert.equal(contextResponse.body.memoryContext.status, 'ready');
  assert.match(contextResponse.body.memoryContext.text, /SCOPED-GREENHOUSE-FACT/);
  assert.doesNotMatch(contextResponse.body.memoryContext.text, /EXCLUDED-OTHER-PROJECT/);

  const memoryCommitPath = `/api/agents/${encodeURIComponent(agent.id)}/memory-commit`;
  const turnContextPath = `/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`;
  const factualStart = '2024-01-01T00:00:00.000Z';
  const factualBoundary = '2025-01-01T00:00:00.000Z';
  const temporalFacts = [];
  for (const [text, valid_from] of [['TEMPORAL_IRRIGATION: cedar irrigation uses rainwater.', factualStart],
    ['TEMPORAL_IRRIGATION: cedar irrigation uses wellwater.', undefined]]) {
    const saved = await request(memoryCommitPath, 'POST', { operation: 'create', text,
      contextScope: { projectId: 'greenhouse' }, valid_from, evidence_excerpt: 'Owner recorded the cedar irrigation change.' });
    assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
    assert.equal(saved.body.committed, true, JSON.stringify(saved.body));
    if (saved.status === 200) assert.equal(saved.body.indexed, false, JSON.stringify(saved.body));
    temporalFacts.push(saved.body.id);
  }
  const temporalDetail = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts/${temporalFacts[0]}`);
  assert.equal(temporalDetail.body.memory.valid_from, factualStart, 'owner creation preserves asserted factual time');
  const beforeSupersession = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const superseded = await request(memoryCommitPath, 'POST', { operation: 'conflict',
    fromId: temporalFacts[1], toId: temporalFacts[0], relation: 'supersedes',
    expectedFromRevision: 0, expectedToRevision: 0, valid_from: factualBoundary,
    why: 'Owner observed the irrigation source change.', approved: true,
    source: { kind: 'owner-feedback', text: 'Cedar irrigation changed to wellwater on January 1, 2025.' } });
  assert.equal(superseded.status, 201, JSON.stringify(superseded.body));
  const oldDetail = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts/${temporalFacts[0]}`);
  assert.equal(oldDetail.body.memory.valid_until, factualBoundary);
  assert.equal(oldDetail.body.memory.status, 'superseded');
  const past = await request(turnContextPath, 'POST', { latestMessage: 'cedar irrigation', validAt: factualStart });
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.match(past.body.memoryContext.text, /cedar irrigation uses rainwater/);
  assert.doesNotMatch(past.body.memoryContext.text, /cedar irrigation uses wellwater|SCOPED-GREENHOUSE-FACT/);
  const atBoundary = await request(turnContextPath, 'POST', { latestMessage: 'cedar irrigation', validAt: factualBoundary });
  assert.equal(atBoundary.status, 200);
  assert.doesNotMatch(atBoundary.body.memoryContext.text, /cedar irrigation uses rainwater/);
  const recordedPast = await request(turnContextPath, 'POST', { latestMessage: 'cedar irrigation',
    asOf: beforeSupersession, validAt: factualBoundary });
  assert.equal(recordedPast.status, 200);
  assert.match(recordedPast.body.memoryContext.text, /cedar irrigation uses rainwater/,
    'a recorded snapshot before the change retains the then-asserted open factual window');
  const ended = await request(memoryCommitPath, 'POST', { operation: 'create', text: 'ENDED_ONLY_FACT: cedar harvest finished.',
    contextScope: { projectId: 'temporal-only' }, valid_from: factualStart, valid_until: factualBoundary });
  assert.ok([200, 201].includes(ended.status), JSON.stringify(ended.body));
  assert.equal(ended.body.committed, true, JSON.stringify(ended.body));
  if (ended.status === 200) assert.equal(ended.body.indexed, false, JSON.stringify(ended.body));
  const endedDetails = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts/${ended.body.id}`);
  assert.equal(endedDetails.body.memory.valid_until, factualBoundary);
  const invalidWindow = await request(memoryCommitPath, 'POST', { operation: 'create', text: 'Invalid cedar window.',
    valid_from: factualBoundary, valid_until: factualStart });
  assert.equal(invalidWindow.status, 400, 'invalid owner factual windows must fail before append');
  const historicalAgent = await request('/api/agents', 'POST', { name: 'Historical scope test agent',
    transport: 'local-opencode', learnFromConversations: false });
  assert.equal(historicalAgent.status, 201);
  const historicalAgentPath = `/api/agents/${historicalAgent.body.agent.id}`;
  const historicalFact = await request(`${historicalAgentPath}/memory-commit`, 'POST', { operation: 'create',
    text: 'HISTORICAL_SCOPE_FACT: amber irrigation was seasonal.', contextScope: { projectId: 'past-only' },
    valid_from: factualStart, valid_until: factualBoundary });
  assert.ok([200, 201].includes(historicalFact.status), JSON.stringify(historicalFact.body));
  assert.equal(historicalFact.body.committed, true, JSON.stringify(historicalFact.body));
  if (historicalFact.status === 200) assert.equal(historicalFact.body.indexed, false, JSON.stringify(historicalFact.body));
  const historicalScope = await request(`${historicalAgentPath}/memory-turn-context`, 'POST', {
    latestMessage: 'amber irrigation', validAt: factualStart });
  assert.equal(historicalScope.status, 200);
  assert.match(historicalScope.body.memoryContext.text, /HISTORICAL_SCOPE_FACT/,
    'scope inference uses the requested factual inventory even when no current facts exist');
  const historicalCurrent = await request(`${historicalAgentPath}/memory-turn-context`, 'POST', { latestMessage: 'amber irrigation' });
  assert.equal(historicalCurrent.body.memoryContext.status, 'empty');
  const versionedFactText = 'VERSIONED_GREENHOUSE_RECIPE: plum recipe uses basil.';
  const versionedEvidence = 'VERSIONED_RECIPE_EVIDENCE: the greenhouse note says basil.';
  const versioned = await request(memoryCommitPath, 'POST', { operation: 'create', text: versionedFactText,
    evidence_excerpt: versionedEvidence, contextScope: { projectId: 'greenhouse' }, importance: 0.95 });
  assert.ok([200, 201].includes(versioned.status), JSON.stringify(versioned.body));
  assert.equal(versioned.body.committed, true, JSON.stringify(versioned.body));
  if (versioned.status === 200) assert.equal(versioned.body.indexed, false, JSON.stringify(versioned.body));
  const versionedDetails = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts/${versioned.body.id}`);
  assert.equal(versionedDetails.status, 200, JSON.stringify(versionedDetails.body));
  const beforeRevisionAsOf = new Date(Date.parse(versionedDetails.body.memory.createdAt) + 1).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const versionedRevision = await request(memoryCommitPath, 'POST', { operation: 'revise', id: versioned.body.id,
    expectedRevision: 0, why: 'Replace the recipe with the verified current value.',
    changes: { text: 'VERSIONED_GREENHOUSE_RECIPE: plum recipe now uses dill.',
      evidence_excerpt: 'VERSIONED_RECIPE_EVIDENCE: the greenhouse note now says dill.' } });
  assert.equal(versionedRevision.status, 200, JSON.stringify(versionedRevision.body));
  const currentVersionedContext = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe' });
  assert.equal(currentVersionedContext.status, 200);
  assert.match(currentVersionedContext.body.memoryContext.text, /plum recipe now uses dill/);
  assert.doesNotMatch(currentVersionedContext.body.memoryContext.text, /VERSIONED_RECIPE_EVIDENCE|the greenhouse note now says dill/,
    'default turn context stays at depth 0 and omits source evidence');
  assert.doesNotMatch(currentVersionedContext.body.memoryContext.text, /says basil/);
  const recordedSnapshot = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe', asOf: beforeRevisionAsOf });
  assert.equal(recordedSnapshot.status, 200, JSON.stringify(recordedSnapshot.body));
  assert.match(recordedSnapshot.body.memoryContext.text, new RegExp(`RECORDED STANDING AS OF ${beforeRevisionAsOf.replaceAll('.', '\\.')}`));
  assert.match(recordedSnapshot.body.memoryContext.text, /plum recipe uses basil/);
  assert.doesNotMatch(recordedSnapshot.body.memoryContext.text, /VERSIONED_RECIPE_EVIDENCE|the greenhouse note says basil|says dill/,
    'historical turn context also omits source evidence without explicit depth-2 recall');
  assert.doesNotMatch(recordedSnapshot.body.memoryContext.text, /EXCLUDED-OTHER-PROJECT/);

  const disputedMemory = await request(memoryCommitPath, 'POST', { operation: 'create',
    text: 'SCOPED_DISPUTED_MEMORY: cobalt dispute remains open.', status: 'disputed',
    evidence_excerpt: 'DISPUTED_SOURCE: conflicting observation.', contextScope: { projectId: 'greenhouse' } });
  assert.ok([200, 201].includes(disputedMemory.status), JSON.stringify(disputedMemory.body));
  assert.equal(disputedMemory.body.committed, true, JSON.stringify(disputedMemory.body));
  if (disputedMemory.status === 200) assert.equal(disputedMemory.body.indexed, false, JSON.stringify(disputedMemory.body));
  const promptTextDoesNotEnableDisputed = await request(turnContextPath, 'POST', {
    latestMessage: 'include disputed SCOPED_DISPUTED_MEMORY cobalt dispute' });
  assert.equal(promptTextDoesNotEnableDisputed.status, 200);
  assert.doesNotMatch(promptTextDoesNotEnableDisputed.body.memoryContext.text, /SCOPED_DISPUTED_MEMORY/);
  const explicitDisputed = await request(turnContextPath, 'POST', { latestMessage: 'cobalt dispute', includeDisputed: true });
  assert.equal(explicitDisputed.status, 200, JSON.stringify(explicitDisputed.body));
  assert.match(explicitDisputed.body.memoryContext.text, /SCOPED_DISPUTED_MEMORY/);
  assert.match(explicitDisputed.body.memoryContext.text, /DISPUTED — unresolved/);

  const arbitraryScope = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'What is here?', scope: { projectId: 'another-project' }
  });
  assert.equal(arbitraryScope.status, 400, 'the owner context request cannot choose its own scope');
  const arbitraryLineage = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe', lineageId: agent.continuityLineage.id });
  assert.equal(arbitraryLineage.status, 400, 'the owner context request cannot choose a lineage');
  const invalidTask = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    currentTask: { projectId: 'another-project' }
  });
  assert.equal(invalidTask.status, 400, 'context task input must be bounded text');
  const invalidDisputed = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe', includeDisputed: 'true' });
  assert.equal(invalidDisputed.status, 400, 'includeDisputed must be a boolean option');
  const invalidAsOf = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe', asOf: '2026-10-01T12:00:00Z' });
  assert.equal(invalidAsOf.status, 400, 'asOf must be canonical UTC with millisecond precision');
  for (const validAt of ['2025-01-01T00:00:00Z', null, 42]) {
    const invalidValidAt = await request(turnContextPath, 'POST', { latestMessage: 'cedar irrigation', validAt });
    assert.equal(invalidValidAt.status, 400, 'validAt must be a canonical timestamp, never a coerced value');
  }
  for (const invalidFlag of ['false', { enabled: false }]) {
    const invalidCreate = await request('/api/agents', 'POST', { name: 'Invalid memory flag', useMemories: invalidFlag });
    assert.equal(invalidCreate.status, 400, 'agent creation must reject non-boolean memory controls');
    const invalidPatch = await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { useMemories: invalidFlag });
    assert.equal(invalidPatch.status, 400, 'agent updates must reject non-boolean memory controls');
  }
  const agentsAfterInvalidPatch = await request('/api/agents');
  assert.equal(agentsAfterInvalidPatch.body.agents.find((item) => item.id === agent.id).useMemories, true);

  const room = await request('/api/rooms', 'POST', { name: 'Memory context prompt test' });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const send = async (content) => request(`/api/rooms/${encodeURIComponent(room.body.room.id)}/messages`, 'POST', {
    content, agentIds: [agent.id], approved: true
  });
  let response = await send('What plants are in the greenhouse plan?');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.replies[0].content, 'fake-provider-reply');
  const dispatchedPrompt = captured.at(-1).messages.map((message) => message.content).join('\n');
  assert.match(dispatchedPrompt, /SCOPED-GREENHOUSE-FACT/);
  assert.doesNotMatch(dispatchedPrompt, /EXCLUDED-OTHER-PROJECT/);
  assert.doesNotMatch(dispatchedPrompt, /OWNER-NOTE-ONLY/,
    'an unrelated desk note must not be injected into a greenhouse question');

  const linkTask = async (body) => {
    const pathname = '/agent-link/v1/tasks';
    return fetch(`${origin}${pathname}`, {
      method: 'POST', headers: signedLinkHeaders(pairedBody.token, 'POST', pathname, body), body: JSON.stringify(body)
    });
  };
  const createdTaskResponse = await linkTask({ operation: 'create', name: 'Signed peer task', prompt: 'Summarize the local model path.' });
  const createdTask = await createdTaskResponse.json();
  assert.equal(createdTaskResponse.status, 201, JSON.stringify(createdTask));
  const taskRunResponse = await linkTask({ operation: 'run', taskId: createdTask.task.id });
  const taskRun = await taskRunResponse.json();
  assert.equal(taskRunResponse.status, 200, JSON.stringify(taskRun));
  assert.equal(taskRun.ok, true);
  const signedTaskPrompt = captured.at(-1).messages.map((message) => message.content).join('\n');
  assert.match(signedTaskPrompt, /SCOPED-GREENHOUSE-FACT|OWNER-NOTE-ONLY/,
    'the exact Link can use its own granted memory-read scope for local tasks');
  assert.doesNotMatch(signedTaskPrompt, /EXCLUDED-OTHER-PROJECT/,
    'the Link-selected project scope still excludes unrelated project facts');

  const disabled = await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { useMemories: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.agent.useMemories, false);
  const disabledContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'What plants are in the greenhouse plan?', includeDisputed: true, asOf: beforeRevisionAsOf
  });
  assert.equal(disabledContext.body.memoryContext.status, 'disabled');
  assert.equal(disabledContext.body.memoryContext.text, '');
  response = await send('What plants are in the greenhouse plan?');
  assert.equal(response.body.replies[0].content, 'fake-provider-reply');
  const disabledPrompt = captured.at(-1).messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(disabledPrompt, /SCOPED-GREENHOUSE-FACT|OWNER-NOTE-ONLY/);

  await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { useMemories: true });
  await request('/api/settings', 'PATCH', { workMode: 'converse', approvalPolicy: 'full' });
  response = await send('What plants are in the greenhouse plan?');
  assert.equal(response.body.replies[0].content, 'fake-provider-reply');
  const deniedPrompt = captured.at(-1).messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(deniedPrompt, /SCOPED-GREENHOUSE-FACT|OWNER-NOTE-ONLY/,
    'read_local denial must suppress both dated and owner-note memory injection');
  const deniedContext = await request(turnContextPath, 'POST', { latestMessage: 'plum recipe', asOf: beforeRevisionAsOf });
  assert.ok([403, 409].includes(deniedContext.status),
    'the owner context endpoint rechecks read_local policy before returning an as-of snapshot');

  await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  const archivedText = 'ARCHIVED_GREENHOUSE_ONLY: copper observatory stays archived.';
  const archivedCreate = await request(memoryCommitPath, 'POST', { operation: 'create', text: archivedText,
    evidence_excerpt: 'ARCHIVED_GREENHOUSE_EVIDENCE: retained for past lookup.', contextScope: { projectId: 'archive-only' } });
  assert.ok([200, 201].includes(archivedCreate.status), JSON.stringify(archivedCreate.body));
  assert.equal(archivedCreate.body.committed, true, JSON.stringify(archivedCreate.body));
  if (archivedCreate.status === 200) assert.equal(archivedCreate.body.indexed, false, JSON.stringify(archivedCreate.body));
  const archiveScope = { scope: { projectId: 'archive-only' } };
  const archiveSelection = await fetch(`${origin}/agent-link/v1/memory-scope`, {
    method: 'POST', headers: signedLinkHeaders(pairedBody.token, 'POST', '/agent-link/v1/memory-scope', archiveScope),
    body: JSON.stringify(archiveScope)
  });
  assert.equal(archiveSelection.status, 200, await archiveSelection.text());
  const archivedRevision = await request(memoryCommitPath, 'POST', { operation: 'revise', id: archivedCreate.body.id,
    expectedRevision: 0, why: 'Retire the test-only archive fact.', changes: { status: 'historical' } });
  assert.equal(archivedRevision.status, 200, JSON.stringify(archivedRevision.body));
  const retiredCurrentContext = await request(turnContextPath, 'POST', { latestMessage: 'copper observatory' });
  assert.equal(retiredCurrentContext.status, 200);
  assert.doesNotMatch(retiredCurrentContext.body.memoryContext.text, /ARCHIVED_GREENHOUSE_ONLY/);
  const archivedDetails = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts/${archivedCreate.body.id}`);
  assert.equal(archivedDetails.status, 200);
  const historicalScopeContext = await request(turnContextPath, 'POST', {
    latestMessage: 'copper observatory', asOf: archivedDetails.body.memory.updatedAt
  });
  assert.equal(historicalScopeContext.status, 200, JSON.stringify(historicalScopeContext.body));
  assert.match(historicalScopeContext.body.memoryContext.text, /ARCHIVED_GREENHOUSE_ONLY/);
  assert.match(historicalScopeContext.body.memoryContext.text, /HISTORICAL — retained for a requested snapshot/);
  assert.doesNotMatch(historicalScopeContext.body.memoryContext.text, /ARCHIVED_GREENHOUSE_EVIDENCE/,
    'historical model context remains depth 0 and does not inject source evidence');

  const restoreScope = { scope: { projectId: 'greenhouse' } };
  const restoredSelection = await fetch(`${origin}/agent-link/v1/memory-scope`, {
    method: 'POST', headers: signedLinkHeaders(pairedBody.token, 'POST', '/agent-link/v1/memory-scope', restoreScope),
    body: JSON.stringify(restoreScope)
  });
  assert.equal(restoredSelection.status, 200, await restoredSelection.text());

  const lineageId = agent.continuityLineage.id;
  const lineageDirectory = path.join(dataDir, 'dated-memory', lineageId);
  await rename(lineageDirectory, `${lineageDirectory}.unavailable`);
  await writeFile(lineageDirectory, 'simulate unavailable memory storage');
  const unavailable = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'What plants are in the greenhouse plan?'
  });
  assert.equal(unavailable.body.memoryContext.status, 'unavailable');
  response = await send('What plants are in the greenhouse plan?');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.replies[0].content, 'fake-provider-reply');

  const bootstrap = await request('/api/bootstrap');
  assert.doesNotMatch(JSON.stringify(bootstrap.body.receipts), /SCOPED-GREENHOUSE-FACT|OWNER-NOTE-ONLY/);
});

test('browser inference requests owner context before generation and degrades cleanly if that read fails', async () => {
  const source = await readFile(path.join(root, 'public', 'on-device-chat.js'), 'utf8');
  const events = [];
  let contextStatus = 200;
  let generatedMessages = [];
  const window = { HexiGridOnDevice: { complete: async ({ messages }) => {
    events.push('complete'); generatedMessages = messages; return { content: 'browser-reply' };
  } } };
  const document = { cookie: 'hexigrid_csrf=csrf-test-token' };
  const fetch = async (url, options) => {
    events.push('context');
    assert.match(url, /\/api\/agents\/browser-agent\/memory-turn-context$/);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['x-hexigrid-csrf'], 'csrf-test-token');
    return { ok: contextStatus >= 200 && contextStatus < 300, status: contextStatus,
      json: async () => ({ memoryContext: { status: 'ready', text: 'BROWSER-SCOPED-CONTEXT' } }) };
  };
  vm.runInNewContext(source, { window, document, fetch, Date, JSON, String, Set, Math });
  const agent = { id: 'browser-agent', name: 'Browser agent', useMemories: true };
  const room = { messages: [{ role: 'user', content: 'use current context' }] };
  const generated = await window.HexiGridBrowserChat.completeTurn({
    agent, room, settings: {}, memories: [], modelId: 'disposable-browser-model'
  });
  assert.equal(generated.content, 'browser-reply');
  assert.deepEqual(events, ['context', 'complete']);
  assert.match(generatedMessages[0].content, /BROWSER-SCOPED-CONTEXT/);

  events.length = 0;
  contextStatus = 503;
  await window.HexiGridBrowserChat.completeTurn({ agent, room, settings: {}, memories: [], modelId: 'disposable-browser-model' });
  assert.deepEqual(events, ['context', 'complete']);
  assert.doesNotMatch(generatedMessages[0].content, /BROWSER-SCOPED-CONTEXT/);

  events.length = 0;
  contextStatus = 403;
  await window.HexiGridBrowserChat.completeTurn({ agent, room, settings: {},
    memories: [{ agentId: agent.id, content: 'BROWSER-OWNER-NOTE' }], modelId: 'disposable-browser-model' });
  assert.deepEqual(events, ['context', 'complete']);
  assert.doesNotMatch(generatedMessages[0].content, /BROWSER-OWNER-NOTE|BROWSER-SCOPED-CONTEXT/,
    'an explicit read_local denial suppresses cached owner notes as well as dated context');
});
