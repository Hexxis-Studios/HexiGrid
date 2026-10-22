import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { DatedMemoryStore, normalizeContextScope } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

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

function signedHeaders(token, method, pathname, body) {
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

function extractLocalProfileReply(source) {
  const start = source.indexOf('function currentActiveMemoryLineage(agent) {');
  const end = source.indexOf('// Reuse encrypted local state for bounded dispatch results.', start);
  assert.ok(start >= 0 && end > start, 'the current signed-memory authorization and dispatch implementation is present');
  return `${source.slice(start, end)}\nglobalThis.__localProfileReply = localProfileReply;`;
}

test('signed Link cognition injects only its current authorized scope before model dispatch', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-signed-memory-context-'));
  const port = await freePort();
  const relayPort = await freePort();
  const providerRequests = [];
  let releaseHarnessOutput;
  let harnessResponseHeld = false;
  let harnessGrantResponseHeld = false;
  let releaseSignedTaskOutput;
  let signedTaskResponseHeld = false;
  let releaseHarnessGrant;
  const harnessGrantGate = new Promise(resolve => { releaseHarnessGrant = resolve; });
  const harnessOutputGate = new Promise(resolve => { releaseHarnessOutput = resolve; });
  const signedTaskOutputGate = new Promise(resolve => { releaseSignedTaskOutput = resolve; });
  const fakeProvider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const received = JSON.parse(raw);
    providerRequests.push(received);
    if (received.messages.some(message => String(message.content).includes('HOLD-HARNESS-OUTPUT'))) {
      harnessResponseHeld = true;
      await harnessOutputGate;
    }
    if (received.messages.some(message => String(message.content).includes('HOLD-HARNESS-GRANT'))) {
      harnessGrantResponseHeld = true;
      await harnessGrantGate;
    }
    if (received.messages.some(message => String(message.content).includes('HOLD-SIGNED-TASK-OUTPUT'))) {
      signedTaskResponseHeld = true;
      await signedTaskOutputGate;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic-local-reply' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: path.join(dataDir, 'agent-link-workspaces'),
      HEXIGRID_PODMAN: path.join(dataDir, 'missing-podman'), OPENCODE_CLI: 'missing-opencode-for-signed-memory-test' }
  });
  const origin = `http://127.0.0.1:${port}`;
  const cookies = cookieJar();
  const ownerCall = async (pathname, method = 'GET', body) => {
    const headers = { ...(cookies.header() ? { cookie: cookies.header() } : {}) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      if (cookies.csrf()) headers['x-hexigrid-csrf'] = cookies.csrf();
    }
    const response = await fetch(`${origin}${pathname}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookies.absorb(response);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const waitUntilReady = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Isolated server exited with code ${child.exitCode}.`);
      try { if ((await fetch(`${origin}/api/bootstrap`)).ok) return; } catch { /* server starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Isolated signed-memory server did not start.');
  };
  t.after(async () => {
    releaseHarnessOutput();
    releaseHarnessGrant();
    releaseSignedTaskOutput();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => fakeProvider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitUntilReady();
  assert.equal((await ownerCall('/api/auth/setup', 'POST', { password: 'signed-memory-test-passphrase' })).status, 200);
  assert.equal((await ownerCall('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const provider = await ownerCall('/api/providers', 'POST', {
    name: 'Synthetic delayed credential provider', baseUrl: `http://127.0.0.1:${fakeProvider.address().port}/v1`,
    models: 'signed-prompt-capture', apiStyle: 'openai-chat', apiKey: 'synthetic-test-key-only'
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  assert.equal(provider.body.provider.hasKey, true, 'signed cognition crosses an asynchronous protected-key lookup before dispatch');

  const createAgent = async (name) => {
    const response = await ownerCall('/api/agents', 'POST', { name, transport: 'local-opencode',
      model: `provider:${provider.body.provider.id}:signed-prompt-capture` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.agent;
  };
  const target = await createAgent('Signed memory target');
  const foreign = await createAgent('Foreign lineage profile');
  const targetFacts = [
    ['TARGET-ALPHA-FACT: alpha greenhouse route uses basil and tomatoes.', 'alpha-project'],
    ['TARGET-BETA-FACT: beta greenhouse route uses mint and lettuce.', 'beta-project']
  ];
  for (const [text, projectId] of targetFacts) {
    const saved = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', {
      operation: 'create', text, contextScope: { projectId }, importance: 0.95
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  }
  const foreignFact = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'FOREIGN-LINEAGE-FACT: alpha greenhouse route uses basil but belongs elsewhere.',
    contextScope: { projectId: 'alpha-project' }, importance: 0.95
  });
  assert.equal(foreignFact.status, 201, JSON.stringify(foreignFact.body));

  const pair = async (agent, name, capabilities) => {
    const invite = await ownerCall('/api/agent-links/invites', 'POST', {
      agentId: agent.id, capabilities, approved: true
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const inviteUrl = new URL(invite.body.invitationUrl);
    const paired = await fetch(`${origin}/agent-link/v1/pair`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        inviteId: invite.body.invite.id,
        secret: decodeURIComponent(inviteUrl.hash.slice('#secret='.length)),
        identity: { name, framework: 'test', externalId: `synthetic-${crypto.randomUUID()}` },
        capabilities, clientDeviceId: `signed-memory-${crypto.randomUUID()}`
      }) });
    const result = await paired.json();
    assert.equal(paired.status, 201, JSON.stringify(result));
    return result;
  };
  const authorizedLink = await pair(target, 'Authorized synthetic peer', ['cognition', 'memory-read', 'memory-write', 'messages', 'harness-jobs', 'tasks']);
  const noReadLink = await pair(target, 'No-read synthetic peer', ['cognition', 'harness-jobs', 'tasks']);
  const linkCall = (link, pathname, body) => fetch(`${origin}${pathname}`, { method: 'POST',
    headers: signedHeaders(link.token, 'POST', pathname, body), body: JSON.stringify(body) });
  const selectScope = async (link, projectId) => {
    const pathname = '/agent-link/v1/memory-scope';
    const body = { scope: { projectId } };
    const response = await linkCall(link, pathname, body);
    assert.equal(response.status, 200, await response.text());
  };
  const cognition = async (link, content) => {
    const pathname = '/agent-link/v1/cognition';
    const body = { clientMessageId: `synthetic-cognition-${crypto.randomUUID()}`, content };
    const response = await linkCall(link, pathname, body);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const createLinkedTask = async (link, name, prompt) => {
    const response = await linkCall(link, '/agent-link/v1/tasks', { operation: 'create', name, prompt,
      intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
    const body = await response.json().catch(() => ({}));
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.task;
  };
  const runLinkedTask = async (link, task) => {
    const response = await linkCall(link, '/agent-link/v1/tasks', { operation: 'run', taskId: task.id });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const capturedPrompt = () => providerRequests.at(-1)?.messages.map((message) => message.content).join('\n') || '';

  const correctionFact = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'PAST-BETA-MISTAKE: beta greenhouse access uses the obsolete east entrance.',
    contextScope: { projectId: 'beta-project' }
  });
  assert.equal(correctionFact.status, 201);
  const ownerCorrection = {
    operation: 'correct', id: correctionFact.body.id, expectedRevision: 0,
    changes: { text: 'Beta greenhouse access uses the verified west entrance.' },
    why: 'The retained owner observation corrected the access route.',
    source: { kind: 'owner-feedback', text: 'Synthetic inspection confirms the west entrance; east is obsolete.' },
    expectedNextBehavior: 'Check the current greenhouse entrance before giving access directions.'
  };
  const corrected = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', ownerCorrection);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const ownerRetry = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', ownerCorrection);
  assert.equal(ownerRetry.status, 200, JSON.stringify(ownerRetry.body));
  assert.equal(ownerRetry.body.revisionId, corrected.body.revisionId);
  const correctedRead = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-facts/${correctionFact.body.id}?depth=2`);
  assert.equal(correctedRead.status, 200);
  assert.equal(correctedRead.body.memory.revision, 1);
  assert.equal(correctedRead.body.memory.revisions.length, 1);
  assert.match(correctedRead.body.memory.revisions[0].previous.text, /PAST-BETA-MISTAKE/,
    'the correction preserves the original append-only evidence');
  const persisted = new DatedMemoryStore({ root: path.join(dataDir, 'dated-memory') });
  const canonicalMistakes = await persisted.listMemoryMistakes({ lineageId: correctedRead.body.memory.lineageId,
    agentId: target.id, contextScope: { projectId: 'beta-project' } });
  assert.equal(canonicalMistakes.length, 1, 'a new store instance sees the atomic canonical mistake record');
  assert.equal(canonicalMistakes[0].status, 'historical');
  assert.equal(canonicalMistakes[0].importance, 1);
  assert.match(canonicalMistakes[0].evidence_excerpt, /Synthetic inspection/);

  const ownerRepeatFact = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'Synthetic owner-side repeated mistake.', contextScope: { projectId: 'alpha-project' }
  });
  assert.equal(ownerRepeatFact.status, 201, JSON.stringify(ownerRepeatFact.body));
  const ownerRepeatCorrection = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'correct', id: ownerRepeatFact.body.id, expectedRevision: 0,
    changes: { text: 'Synthetic owner-side corrected fact.' }, why: 'Owner checked the repeated mistake.',
    source: { kind: 'owner-feedback', text: 'Synthetic owner-local verification.' },
    expectedNextBehavior: 'Check the exact beta route before answering.',
    recurrenceOf: [{ id: canonicalMistakes[0].metadata.memoryMistake.record.id,
      lineageId: correctedRead.body.memory.lineageId, agentId: target.id }]
  });
  assert.equal(ownerRepeatCorrection.status, 200, JSON.stringify(ownerRepeatCorrection.body));
  const ownerRepeatRead = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-facts/${ownerRepeatFact.body.id}?depth=2`);
  assert.equal(ownerRepeatRead.status, 200);
  const ownerRepeatMistakes = await persisted.listMemoryMistakes({ lineageId: ownerRepeatRead.body.memory.lineageId,
    agentId: foreign.id, contextScope: { projectId: 'alpha-project' } });
  assert.equal(ownerRepeatMistakes.length, 1);
  assert.deepEqual(ownerRepeatMistakes[0].metadata.memoryMistake.record.recurrenceOf, [{
    id: canonicalMistakes[0].metadata.memoryMistake.record.id,
    lineageId: correctedRead.body.memory.lineageId,
    agentId: target.id
  }], 'owner-local correction can resolve an exact prior mistake across agent lineages');

  await selectScope(authorizedLink, 'alpha-project');
  let result = await cognition(authorizedLink, 'What is the alpha greenhouse route?');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.reply, 'synthetic-local-reply');
  assert.match(capturedPrompt(), /TARGET-ALPHA-FACT/,
    'the exact Link current scope is in the provider prompt before the model reply');
  assert.doesNotMatch(capturedPrompt(), /TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE/);

  await selectScope(authorizedLink, 'beta-project');
  result = await cognition(authorizedLink, 'What is the beta greenhouse route?');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(capturedPrompt(), /TARGET-BETA-FACT/);
  assert.match(capturedPrompt(), /PAST-BETA-MISTAKE/,
    'an evidence-backed committed correction becomes a bounded warning in a future authorized turn');
  assert.match(capturedPrompt(), /Check the current greenhouse entrance/);
  assert.doesNotMatch(capturedPrompt(), /Synthetic inspection confirms/,
    'private evidence excerpts are not automatically copied into future warning context');
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|FOREIGN-LINEAGE-FACT/,
    'changing the exact Link selection excludes the previous and foreign lineages');

  const reviewedFact = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'Reviewed greenhouse gate needs correction.', contextScope: { projectId: 'beta-project' }
  });
  const reviewedObservation = await linkCall(authorizedLink, '/agent-link/v1/messages', {
    clientMessageId: `reviewed-correction-${crypto.randomUUID()}`, text: 'Synthetic reviewed observation confirms the west gate.'
  });
  const reviewedSource = (await reviewedObservation.json()).message;
  const reviewedArgs = { id: reviewedFact.body.id, expectedRevision: 0, text: 'Reviewed greenhouse gate uses west.',
    why: 'Synthetic retained gate observation.', expectedNextBehavior: 'Verify the current west gate.', sourceMessageId: reviewedSource.id,
    recurrenceOf: [{ id: canonicalMistakes[0].metadata.memoryMistake.record.id,
      lineageId: correctedRead.body.memory.lineageId, agentId: target.id }] };
  const pendingCorrections = [];
  for (const arguments_ of [{ ...reviewedArgs, valid_while: 'While the west gate remains open.' }, reviewedArgs]) {
    const response = await linkCall(authorizedLink, '/agent-link/v1/memory-mcp', {
      jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'propose-correction', arguments: arguments_ }
    });
    const body = await response.json();
    assert.ok(body.result?.structuredContent?.proposalId, JSON.stringify(body));
    pendingCorrections.push(body.result.structuredContent.proposalId);
  }
  assert.equal((await ownerCall(`/api/memory-proposals/${pendingCorrections[0]}/decision`, 'POST', { decision: 'approve' })).status, 200);
  const conflictingApproval = await ownerCall(`/api/memory-proposals/${pendingCorrections[1]}/decision`, 'POST', { decision: 'approve' });
  assert.equal(conflictingApproval.status, 400, 'an omitted condition cannot borrow a previously committed correction receipt');
  assert.match(conflictingApproval.body.error, /revision conflict/);

  const signedFact = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'PAST-SIGNED-MISTAKE: beta greenhouse directions incorrectly use the north gate.',
    contextScope: { projectId: 'beta-project' }
  });
  assert.equal(signedFact.status, 201);
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/trust`, 'PATCH', {
    trustLevel: 'owner', approved: true
  })).status, 200);
  const observed = await linkCall(authorizedLink, '/agent-link/v1/messages', {
    clientMessageId: `synthetic-correction-${crypto.randomUUID()}`,
    text: 'PRIVATE-SIGNED-EVIDENCE: the north gate is closed; the current greenhouse uses the west entrance.'
  });
  assert.equal(observed.status, 201);
  const observedMessage = (await observed.json()).message;
  const foreignRepeatFact = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'Synthetic foreign prior gate error.', contextScope: { projectId: 'beta-project' }
  });
  assert.equal(foreignRepeatFact.status, 201);
  const foreignRepeatCorrection = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'correct', id: foreignRepeatFact.body.id, expectedRevision: 0,
    changes: { text: 'Synthetic foreign corrected gate.' }, why: 'Synthetic source inspection.',
    source: { kind: 'owner-feedback', text: 'Synthetic owner checked the source gate.' },
    expectedNextBehavior: 'Inspect the gate before answering.'
  });
  assert.equal(foreignRepeatCorrection.status, 200, JSON.stringify(foreignRepeatCorrection.body));
  const foreignRepeatRead = await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-facts/${foreignRepeatFact.body.id}?depth=2`);
  const foreignMistakeEntries = await persisted.listMemoryMistakes({ lineageId: foreignRepeatRead.body.memory.lineageId,
    agentId: foreign.id, contextScope: { projectId: 'beta-project' } });
  assert.equal(foreignMistakeEntries.length, 1);
  const recurrenceRef = { id: foreignMistakeEntries[0].metadata.memoryMistake.record.id,
    lineageId: foreignRepeatRead.body.memory.lineageId, agentId: foreign.id };
  const correctionArgs = { id: signedFact.body.id, expectedRevision: 0,
    text: 'Beta greenhouse directions use the current west entrance.',
    why: 'The exact retained signed observation corrected a stale gate.',
    expectedNextBehavior: 'Recheck the current gate before giving greenhouse directions.',
    sourceMessageId: observedMessage.id, recurrenceOf: [recurrenceRef] };
  const attemptRepeat = async (link, args = correctionArgs) => {
    const response = await linkCall(link, '/agent-link/v1/memory-mcp', {
      jsonrpc: '2.0', id: 190, method: 'tools/call', params: { name: 'propose-correction', arguments: args }
    });
    return { status: response.status, body: await response.json() };
  };
  const assertNoRepeatWrite = async result => {
    assert.notEqual(result.body.result?.structuredContent?.committed, true, JSON.stringify(result.body));
    const unchanged = await persisted.getById({ lineageId: correctedRead.body.memory.lineageId, id: signedFact.body.id, depth: 2 });
    assert.equal(unchanged.revision, 0);
    assert.equal((await persisted.listMemoryMistakes({ lineageId: correctedRead.body.memory.lineageId,
      agentId: target.id, contextScope: { projectId: 'beta-project' } })).length, 2);
  };
  await assertNoRepeatWrite(await attemptRepeat(authorizedLink));
  const wrongScopeShare = await ownerCall('/api/memory-shares', 'POST', {
    sourceAgentId: foreign.id, targetLinkId: authorizedLink.connection.id,
    scope: { projectId: 'alpha-project' }, approved: true
  });
  assert.equal(wrongScopeShare.status, 201, JSON.stringify(wrongScopeShare.body));
  await assertNoRepeatWrite(await attemptRepeat(authorizedLink));
  assert.equal((await ownerCall(`/api/memory-shares/${wrongScopeShare.body.share.id}/revoke`, 'POST', { approved: true })).status, 200);
  const exactRepeatShare = await ownerCall('/api/memory-shares', 'POST', {
    sourceAgentId: foreign.id, targetLinkId: authorizedLink.connection.id,
    scope: { projectId: 'beta-project' }, approved: true
  });
  assert.equal(exactRepeatShare.status, 201, JSON.stringify(exactRepeatShare.body));
  const alternateRepeatLink = await pair(target, 'Different synthetic recurrence peer', ['memory-read', 'memory-write', 'messages']);
  assert.equal((await ownerCall(`/api/agent-links/${alternateRepeatLink.connection.id}/trust`, 'PATCH', {
    trustLevel: 'owner', approved: true
  })).status, 200);
  await selectScope(alternateRepeatLink, 'beta-project');
  const alternateEvidence = await linkCall(alternateRepeatLink, '/agent-link/v1/messages', {
    clientMessageId: `synthetic-other-recurrence-${crypto.randomUUID()}`, text: 'Synthetic different Link gate observation.'
  });
  assert.equal(alternateEvidence.status, 201);
  await assertNoRepeatWrite(await attemptRepeat(alternateRepeatLink, {
    ...correctionArgs, sourceMessageId: (await alternateEvidence.json()).message.id
  }));
  const proposed = await linkCall(authorizedLink, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose-correction', arguments: correctionArgs }
  });
  assert.equal(proposed.status, 200);
  const proposalResult = await proposed.json();
  assert.equal(proposalResult.result?.structuredContent?.committed, true, JSON.stringify(proposalResult) +
    'an owner-trusted signed correction commits through the same canonical transaction');
  const retry = await linkCall(authorizedLink, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose-correction', arguments: correctionArgs }
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).result.structuredContent.committed, true);
  const savedMistakes = await persisted.listMemoryMistakes({ lineageId: correctedRead.body.memory.lineageId,
    agentId: target.id, contextScope: { projectId: 'beta-project' } });
  assert.equal(savedMistakes.length, 3, 'a signed exact retry does not duplicate canonical mistake capture');
  const recurrenceMistake = savedMistakes.find(entry => entry.metadata.memoryMistake.record.recurrenceOf.some(ref => ref.agentId === foreign.id));
  assert.deepEqual(recurrenceMistake.metadata.memoryMistake.record.recurrenceOf, [recurrenceRef],
    'the existing canonical store reopens with the exact cross-agent recurrence');
  const changedRepeat = await attemptRepeat(authorizedLink, { ...correctionArgs, recurrenceOf: [] });
  assert.notEqual(changedRepeat.body.result?.structuredContent?.committed, true,
    'a retry cannot omit its previously committed recurrence');
  assert.equal((await ownerCall(`/api/memory-shares/${exactRepeatShare.body.share.id}/revoke`, 'POST', { approved: true })).status, 200);
  const revokedRepeat = await attemptRepeat(authorizedLink);
  assert.notEqual(revokedRepeat.body.result?.structuredContent?.committed, true,
    'even an exact retry requires the current share');
  assert.equal((await persisted.listMemoryMistakes({ lineageId: correctedRead.body.memory.lineageId,
    agentId: target.id, contextScope: { projectId: 'beta-project' } })).length, 3);
  assert.equal((await ownerCall('/api/memory-shares', 'POST', {
    sourceAgentId: foreign.id, targetLinkId: authorizedLink.connection.id,
    scope: { projectId: 'beta-project' }, approved: true
  })).status, 201);
  const foreignMistakeMemoryId = `memory-${recurrenceRef.id.slice('mistake-'.length)}`;
  assert.equal((await ownerCall(`/api/agents/${encodeURIComponent(foreign.id)}/memory-commit`, 'POST', {
    operation: 'revise', id: foreignMistakeMemoryId, expectedRevision: 0,
    changes: { status: 'rejected' }, why: 'Synthetic prior mistake no longer applies.'
  })).status, 200);
  const inactiveRepeat = await attemptRepeat(authorizedLink);
  assert.notEqual(inactiveRepeat.body.result?.structuredContent?.committed, true,
    'a rejected source mistake cannot authorize even a previously exact retry');
  const mistakeTool = async (link, name, arguments_) => {
    const response = await linkCall(link, '/agent-link/v1/memory-mcp', {
      jsonrpc: '2.0', id: 172, method: 'tools/call', params: { name, arguments: arguments_ }
    });
    return { status: response.status, body: await response.json() };
  };
  const discoveryResponse = await linkCall(authorizedLink, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 172, method: 'tools/list'
  });
  assert.equal(discoveryResponse.status, 200);
  const discoveredTools = (await discoveryResponse.json()).result.tools;
  const discovered = discoveredTools.map(tool => tool.name);
  assert.equal(discoveredTools.find(tool => tool.name === 'propose-correction').inputSchema.properties.recurrenceOf.maxItems, 8,
    'signed discovery provides the exact bounded recurrence contract');
  assert.ok(discovered.includes('list-memory-mistakes') && discovered.includes('get-memory-mistake'));
  const listMistakes = await mistakeTool(authorizedLink, 'list-memory-mistakes', { projectId: 'beta-project', maxBytes: 8192 });
  assert.equal(listMistakes.status, 200);
  assert.equal(listMistakes.body.result.structuredContent.mistakes.length, 3, JSON.stringify(listMistakes.body));
  assert.match(JSON.stringify(listMistakes.body), /"recurrenceReferencesRedacted":1/);
  assert.ok(!JSON.stringify(listMistakes.body).includes(recurrenceRef.id), 'foreign recurrence IDs stay redacted');
  assert.ok(!JSON.stringify(listMistakes.body).includes(recurrenceRef.lineageId), 'foreign lineage stays redacted');
  assert.doesNotMatch(JSON.stringify(listMistakes.body), /PRIVATE-SIGNED-EVIDENCE|Synthetic inspection confirms/);
  const mistakeId = savedMistakes.find(entry => /PAST-SIGNED-MISTAKE/.test(entry.metadata.memoryMistake.record.whatWentWrong)).metadata.memoryMistake.record.id;
  const shallowMistake = await mistakeTool(authorizedLink, 'get-memory-mistake', { projectId: 'beta-project', id: mistakeId, depth: 1 });
  assert.equal(shallowMistake.status, 200);
  assert.match(JSON.stringify(shallowMistake.body), /PAST-SIGNED-MISTAKE/);
  assert.doesNotMatch(JSON.stringify(shallowMistake.body), /PRIVATE-SIGNED-EVIDENCE/);
  const deepMistake = await mistakeTool(authorizedLink, 'get-memory-mistake', { projectId: 'beta-project', id: mistakeId, depth: 2 });
  assert.equal(deepMistake.status, 200);
  assert.match(JSON.stringify(deepMistake.body), /PRIVATE-SIGNED-EVIDENCE/);
  const wrongScope = await mistakeTool(authorizedLink, 'get-memory-mistake', { projectId: 'alpha-project', id: mistakeId, depth: 2 });
  assert.equal(wrongScope.body.result.structuredContent.state, 'absent');
  assert.doesNotMatch(JSON.stringify(wrongScope.body), /PAST-SIGNED-MISTAKE|PRIVATE-SIGNED-EVIDENCE/);
  const deniedMistake = await mistakeTool(noReadLink, 'get-memory-mistake', { projectId: 'beta-project', id: mistakeId, depth: 2 });
  assert.equal(deniedMistake.status, 403);
  assert.doesNotMatch(JSON.stringify(deniedMistake.body), /PRIVATE-SIGNED-EVIDENCE/);
  result = await cognition(authorizedLink, 'Which gate should beta greenhouse directions use?');
  assert.equal(result.status, 200);
  assert.match(capturedPrompt(), /PAST-SIGNED-MISTAKE/);
  assert.doesNotMatch(capturedPrompt(), /PRIVATE-SIGNED-EVIDENCE/);

  await ownerCall('/api/settings', 'PATCH', { approvalPolicy: 'ask' });
  result = await cognition(authorizedLink, 'What is the beta greenhouse route while reads need approval?');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE/,
    'an external read_local approval requirement suppresses canonical prompt context');
  await ownerCall('/api/settings', 'PATCH', { approvalPolicy: 'full' });

  result = await cognition(noReadLink, 'What is the beta greenhouse route without memory-read?');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE/,
    'a different Link cannot borrow the selected scope from the memory-read Link');

  const ownerOnlyNote = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memories`, 'POST', {
    content: 'OWNER-ONLY-TASK-NOTE: this private unscoped note must not enter a signed task prompt.'
  });
  assert.equal(ownerOnlyNote.status, 201, JSON.stringify(ownerOnlyNote.body));
  const unscopedFact = await ownerCall(`/api/agents/${encodeURIComponent(target.id)}/memory-commit`, 'POST', {
    operation: 'create', text: 'UNSCOPED-TASK-FACT: this unselected fact must not enter a signed task prompt.'
  });
  assert.equal(unscopedFact.status, 201, JSON.stringify(unscopedFact.body));

  const scopedTask = await createLinkedTask(authorizedLink, 'Signed scoped task fixture',
    'What is the beta greenhouse route for this signed task?');
  const scopedTaskRun = await runLinkedTask(authorizedLink, scopedTask);
  assert.equal(scopedTaskRun.status, 200, JSON.stringify(scopedTaskRun.body));
  assert.equal(scopedTaskRun.body.run?.status, 'completed', JSON.stringify(scopedTaskRun.body));
  assert.equal(scopedTaskRun.body.run.output, 'synthetic-local-reply');
  assert.match(capturedPrompt(), /TARGET-BETA-FACT/,
    'a signed task receives the exact Link-selected canonical memory before local model dispatch');
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|FOREIGN-LINEAGE-FACT|OWNER-ONLY-TASK-NOTE|UNSCOPED-TASK-FACT/,
    'signed task context excludes other scopes, lineages, owner notes and unscoped facts');
  const completedTaskState = await ownerCall('/api/bootstrap');
  assert.equal(completedTaskState.status, 200);
  assert.ok(completedTaskState.body.usage.some(item => item.source === 'agent-link-task' && item.agentId === target.id),
    'the locally generated signed-task result retains its usage record');
  assert.ok(completedTaskState.body.receipts.some(item => item.action === scopedTask.name && item.source === 'task' && item.status === 'completed'),
    'the signed task retains its completed action receipt');

  const noReadTask = await createLinkedTask(noReadLink, 'Signed no-read task fixture',
    'Answer without selected memory because this Link has no memory-read grant or scope.');
  const noReadTaskRun = await runLinkedTask(noReadLink, noReadTask);
  assert.equal(noReadTaskRun.status, 200, JSON.stringify(noReadTaskRun.body));
  assert.equal(noReadTaskRun.body.run?.status, 'completed', JSON.stringify(noReadTaskRun.body));
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE|OWNER-ONLY-TASK-NOTE|UNSCOPED-TASK-FACT/,
    'a tasks-only Link can run without borrowing owner or unscoped memory');

  const heldTask = await createLinkedTask(authorizedLink, 'Held signed task fixture',
    'HOLD-SIGNED-TASK-OUTPUT: answer using the beta greenhouse route.');
  const beforeHeldTaskUsage = (await ownerCall('/api/bootstrap')).body.usage
    .filter(item => item.source === 'agent-link-task' && item.agentId === target.id).length;
  const heldTaskResponse = linkCall(authorizedLink, '/agent-link/v1/tasks', { operation: 'run', taskId: heldTask.id })
    .then(async response => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  for (let attempt = 0; attempt < 100 && !signedTaskResponseHeld; attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(signedTaskResponseHeld, true, 'the signed task provider reply is held after scoped context dispatch');
  assert.match(capturedPrompt(), /TARGET-BETA-FACT/);
  const taskCapabilities = [...authorizedLink.connection.capabilities];
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: taskCapabilities.filter(capability => capability !== 'memory-read'), approved: true
  })).status, 200);
  releaseSignedTaskOutput();
  const deniedHeldTask = await heldTaskResponse;
  assert.equal(deniedHeldTask.status, 502, JSON.stringify(deniedHeldTask.body));
  assert.equal(deniedHeldTask.body.run?.status, 'failed', JSON.stringify(deniedHeldTask.body));
  assert.equal(deniedHeldTask.body.run?.output, '', 'a response prepared with revoked memory authority is withheld');
  assert.doesNotMatch(JSON.stringify(deniedHeldTask.body), /synthetic-local-reply/);
  const withheldTaskState = await ownerCall('/api/bootstrap');
  assert.equal(withheldTaskState.body.tasks.find(item => item.id === heldTask.id)?.lastOutput, '');
  assert.ok(withheldTaskState.body.receipts.some(item => item.action === heldTask.name && item.source === 'task' && item.status === 'failed'),
    'the withheld run still leaves its failure receipt');
  assert.equal(withheldTaskState.body.usage.filter(item => item.source === 'agent-link-task' && item.agentId === target.id).length,
    beforeHeldTaskUsage + 1, 'consumed provider usage remains recorded when post-response authority fails');
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: taskCapabilities, approved: true
  })).status, 200);

  const signedHarness = async (link, prompt) => {
    const pathname = '/agent-link/v1/harness-jobs';
    const started = await linkCall(link, pathname, { clientJobId: `memory-harness-${crypto.randomUUID()}`, prompt });
    const result = await started.json();
    assert.equal(started.status, 202, 'an authorized harmless signed harness job starts');
    const jobPath = `${pathname}/${result.job.id}`;
    let current;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(origin + jobPath, { headers: signedHeaders(link.token, 'GET', jobPath, null) });
      assert.equal(response.status, 200);
      current = (await response.json()).job;
      if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(current?.status, 'completed', current?.error || 'harness completion missing');
    assert.equal(current.output, 'synthetic-local-reply');
    return jobPath;
  };
  const harnessPath = await signedHarness(authorizedLink, 'What is the beta greenhouse route in this harness job?');
  assert.match(capturedPrompt(), /TARGET-BETA-FACT/, 'signed harness dispatch includes its exact selected memory scope');
  assert.match(capturedPrompt(), /PAST-BETA-MISTAKE/, 'authorized harness jobs receive the same bounded correction warning');
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|FOREIGN-LINEAGE-FACT/);
  const foreignHarnessRead = await fetch(origin + harnessPath, { headers: signedHeaders(noReadLink.token, 'GET', harnessPath, null) });
  assert.equal(foreignHarnessRead.status, 404, 'another Link on the same profile cannot read the private harness output');
  await signedHarness(noReadLink, 'What is the beta greenhouse route without memory-read?');
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE/,
    'a harness Link cannot borrow another Link memory scope');
  await ownerCall(`/api/agents/${target.id}`, 'PATCH', { useMemories: false });
  await signedHarness(authorizedLink, 'What is the beta greenhouse route with memories disabled?');
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT|PAST-BETA-MISTAKE|PAST-SIGNED-MISTAKE/);
  await ownerCall(`/api/agents/${target.id}`, 'PATCH', { useMemories: true });

  const heldHarnessStart = await linkCall(authorizedLink, '/agent-link/v1/harness-jobs', {
    clientJobId: `held-harness-${crypto.randomUUID()}`, prompt: 'HOLD-HARNESS-OUTPUT: What is the beta greenhouse route?'
  });
  assert.equal(heldHarnessStart.status, 202);
  const heldHarnessJob = (await heldHarnessStart.json()).job;
  for (let attempt = 0; attempt < 100 && !harnessResponseHeld; attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(harnessResponseHeld, true, 'the response is held after memory-bearing dispatch');
  assert.match(capturedPrompt(), /TARGET-BETA-FACT/);
  const withoutMemoryRead = authorizedLink.connection.capabilities.filter(capability => capability !== 'memory-read');
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: withoutMemoryRead, approved: true
  })).status, 200);
  releaseHarnessOutput();
  let heldHarnessResult;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await ownerCall(`/api/harness-jobs/${heldHarnessJob.id}`);
    heldHarnessResult = result.body.job;
    if (['failed', 'cancelled', 'completed'].includes(heldHarnessResult?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(heldHarnessResult?.status, 'failed', 'revoked memory authority cannot publish a completed memory-bearing result');
  assert.equal(Object.hasOwn(heldHarnessResult, 'output'), false);
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: authorizedLink.connection.capabilities, approved: true
  })).status, 200);

  const heldGrantStart = await linkCall(authorizedLink, '/agent-link/v1/harness-jobs', {
    clientJobId: `held-grant-${crypto.randomUUID()}`, prompt: 'HOLD-HARNESS-GRANT: What is the beta greenhouse route?'
  });
  assert.equal(heldGrantStart.status, 202);
  const heldGrantJob = (await heldGrantStart.json()).job;
  for (let attempt = 0; attempt < 100 && !harnessGrantResponseHeld; attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(harnessGrantResponseHeld, true);
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: authorizedLink.connection.capabilities.filter(capability => capability !== 'harness-jobs'), approved: true
  })).status, 200);
  releaseHarnessGrant();
  let heldGrantResult;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    heldGrantResult = (await ownerCall(`/api/harness-jobs/${heldGrantJob.id}`)).body.job;
    if (['failed', 'cancelled', 'completed'].includes(heldGrantResult?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(heldGrantResult?.status, 'cancelled', 'revoking harness-jobs cancels only the active exact-Link job');
  assert.equal(Object.hasOwn(heldGrantResult, 'output'), false);
  assert.equal((await ownerCall(`/api/agent-links/${authorizedLink.connection.id}/capabilities`, 'PATCH', {
    capabilities: authorizedLink.connection.capabilities, approved: true
  })).status, 200);

  const beforeRaceCount = providerRequests.length;
  const pendingCognition = cognition(authorizedLink, 'What is the beta greenhouse route during a grant change?');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const revoked = await ownerCall(`/api/agent-links/${encodeURIComponent(authorizedLink.connection.id)}/capabilities`, 'PATCH', {
    capabilities: authorizedLink.connection.capabilities.filter((capability) => capability !== 'memory-read'), approved: true
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  result = await pendingCognition;
  assert.ok([200, 409].includes(result.status), JSON.stringify(result.body));
  const racedPrompts = providerRequests.slice(beforeRaceCount).flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert.doesNotMatch(racedPrompts, /TARGET-BETA-FACT/,
    'revoking memory-read during the protected-key async boundary prevents stale context from reaching dispatch');

  result = await cognition(authorizedLink, 'Answer normally after memory-read was revoked.');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.doesNotMatch(capturedPrompt(), /TARGET-ALPHA-FACT|TARGET-BETA-FACT|FOREIGN-LINEAGE-FACT/);
});

test('signed memory grant revocation during real local RAG and protected-key awaits blocks model dispatch', { timeout: 10000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-signed-memory-race-'));
  const store = new DatedMemoryStore({ root: path.join(dataDir, 'dated-memory') });
  const lineageId = `lineage-${crypto.randomUUID()}`;
  const agent = { id: 'dispatch-race-agent', name: 'Dispatch race agent', useMemories: true,
    useGlobalCommunication: false, transport: 'ilands-link', model: 'provider:dispatch-test:model',
    continuityLineage: { id: lineageId, activityState: 'active', activeAgentId: 'dispatch-race-agent' } };
  const connection = { id: 'link-dispatch-race', agentId: agent.id, status: 'connected', tokenHash: 'c'.repeat(64), capabilities: ['cognition', 'memory-read'],
    memoryScope: { lineageId, projectId: 'dispatch-race-project' } };
  await store.append({ lineageId, agentId: agent.id, date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(), id: `memory-${crypto.randomUUID()}`,
    text: 'DELAYED-BOUNDARY-FACT: the authorized route uses basil.',
    contextScope: { projectId: 'dispatch-race-project' }, originKind: 'owner-entry', importance: 0.95 });

  let releaseRuntime;
  let announceRuntime;
  let announceCredentialRead;
  const runtimeStarted = new Promise((resolve) => { announceRuntime = resolve; });
  const credentialReadStarted = new Promise((resolve) => { announceCredentialRead = resolve; });
  const runtimeGate = new Promise((resolve) => { releaseRuntime = resolve; });
  let releaseCredential;
  const credentialGate = new Promise((resolve) => { releaseCredential = resolve; });
  const rag = new LocalMemoryRag({ root: path.join(dataDir, 'rag-index'), store,
    runtimeFactory: async () => {
      return {
        embedQueries: async () => [Float32Array.from([1, 0])],
        embedDocuments: async (texts) => texts.map(() => Float32Array.from([1, 0])),
        dispose: async () => {}
      };
    } });
  const scoreCandidates = rag.scoreCandidates.bind(rag);
  rag.scoreCandidates = async options => {
    announceRuntime();
    await runtimeGate;
    return scoreCandidates(options);
  };
  t.after(async () => { releaseRuntime(); releaseCredential('synthetic-only-key'); await rag.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });

  const state = { agents: [agent], agentLinks: [connection], providers: [{ id: 'provider-dispatch-test', hasKey: true }],
    settings: { workMode: 'build', approvalPolicy: 'full', communicationGuide: {}, activeGoal: null, subagents: { enabled: false } } };
  const builtContexts = [];
  const dispatched = [];
  const sandbox = {
    memoryLearningWorker: null, activeLocalAgentInference: 0,
    state,
    datedMemoryStore: store,
    localMemoryRag: rag,
    buildMemoryTurnContext: async (options) => {
      const result = await buildMemoryTurnContext(options);
      builtContexts.push(result);
      return result;
    },
    normalizeContextScope,
    findAgent: (id) => state.agents.find((item) => item.id === id),
    assertAgentActivity: () => {},
    connectorPolicy: () => null,
    credentialVault: { get: () => { announceCredentialRead(); return credentialGate; } },
    allowedModel: () => ({ providerId: 'provider-dispatch-test', remoteModel: 'model', browser: false }),
    completeWithProvider: async (...args) => { dispatched.push(args); return { content: 'synthetic reply' }; },
    recordUsage: () => {},
    compileCommunicationPrompt: () => '',
    WORK_MODES: { build: { label: 'Build' } },
    id: (prefix) => `${prefix}-${crypto.randomUUID()}`,
    now: () => new Date().toISOString()
  };
  vm.runInNewContext(extractLocalProfileReply(await (await import('node:fs/promises')).readFile(path.join(root, 'server.mjs'), 'utf8')),
    sandbox, { timeout: 1000 });

  const reply = sandbox.__localProfileReply(agent, 'Linked agent message: what is the authorized route?', {
    approved: false, source: 'agent-link', linkConnection: connection, memoryQuery: 'authorized route basil'
  });
  await runtimeStarted;
  releaseRuntime();
  await credentialReadStarted;
  assert.match(builtContexts.at(-1)?.text || '', /DELAYED-BOUNDARY-FACT/,
    'the actual bounded builder completed over the real LocalMemoryRag before the protected-key await');
  connection.capabilities = connection.capabilities.filter((capability) => capability !== 'memory-read');
  releaseCredential('synthetic-only-key');
  await assert.rejects(reply, (error) => error.status === 409 && error.code === 'LINK_MEMORY_AUTHORIZATION_CHANGED');
  assert.equal(dispatched.length, 0, 'the fake provider was never called with the now-unauthorized prompt');
});

test('signed memory identity survives normalization but not credential replacement', async () => {
  const agent = { id: 'identity-agent', useMemories: true,
    continuityLineage: { id: `lineage-${crypto.randomUUID()}`, activityState: 'active', activeAgentId: 'identity-agent' } };
  const connection = { id: 'identity-link', agentId: agent.id, status: 'connected', tokenHash: 'a'.repeat(64),
    capabilities: ['memory-read'], memoryScope: { lineageId: agent.continuityLineage.id, projectId: 'identity-project' } };
  const state = { agents: [agent], agentLinks: [connection] };
  const context = { state, findAgent: id => state.agents.find(item => item.id === id), normalizeContextScope,
    connectorPolicy: () => null };
  vm.runInNewContext(extractLocalProfileReply(await readFile(path.join(root, 'server.mjs'), 'utf8')), context);
  const initial = context.signedLinkMemoryScope(agent, connection);
  assert.ok(initial);
  state.agentLinks = [{ ...connection, capabilities: [...connection.capabilities], memoryScope: { ...connection.memoryScope } }];
  assert.ok(context.signedLinkMemoryScope(agent, connection, initial), 'normalizing an unchanged signed Link preserves authority');
  state.agentLinks[0].tokenHash = 'b'.repeat(64);
  assert.equal(context.signedLinkMemoryScope(agent, connection, initial), null, 'the pinned credential identity cannot be replaced during async work');
});

test('signed cognition rechecks the exact Link after async recall and withholds a prepared packet without deleting its receipts', { timeout: 10_000 }, async () => {
  const makeRoute = ({ delayRecall = false, delayPreparedReceipt = false } = {}) => {
    const lineageId = `lineage-${crypto.randomUUID()}`;
    const agent = { id: `packet-race-${crypto.randomUUID()}`, name: 'Packet race agent', model: 'local-test:model',
      continuityLineage: { id: lineageId, activityState: 'active' } };
    agent.continuityLineage.activeAgentId = agent.id;
    const state = { settings: { workMode: 'build', approvalPolicy: 'full' }, agents: [agent], agentLinks: [], receipts: [] };
    const invite = createAgentLinkInvite(state, { agentId: agent.id, baseUrl: 'http://127.0.0.1', requestedCapabilities: ['cognition', 'memory-read'] });
    const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
    const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret,
      identity: { name: 'Synthetic packet peer', framework: 'test', externalId: crypto.randomUUID() },
      capabilities: ['cognition', 'memory-read'], clientDeviceId: crypto.randomUUID() });
    const initialConnection = state.agentLinks.find((item) => item.id === paired.connection.id);
    initialConnection.memoryScope = { lineageId, projectId: 'packet-project' };
    let announceRecall;
    const recallStarted = new Promise((resolve) => { announceRecall = resolve; });
    let releaseRecall;
    const recallGate = new Promise((resolve) => { releaseRecall = resolve; });
    let announcePreparedSave;
    const preparedSaveStarted = new Promise((resolve) => { announcePreparedSave = resolve; });
    let releasePreparedSave;
    const preparedSaveGate = new Promise((resolve) => { releasePreparedSave = resolve; });
    let saveCalls = 0;
    const receipts = state.receipts;
    const pathname = '/agent-link/v1/cognition';
    const method = 'POST';
    const body = { clientMessageId: `synthetic-cognition-${crypto.randomUUID()}`, content: 'What is the packet project fact?' };
    const ctx = {
      state, pathname, method, findAgent: (id) => state.agents.find((item) => item.id === id),
      readBody: async () => body,
      localProfileReply: async () => 'synthetic linked reply',
      connectorPolicy: () => null,
      datedMemoryStore: { listContextScopes: async () => [{ projectId: 'packet-project' }] },
      createMemoryMcpHandler: () => async () => {
        if (delayRecall) { announceRecall(); await recallGate; }
        return { result: { structuredContent: { text: 'PRIVATE-PACKET-SECRET', factCount: 1 } } };
      },
      addReceipt(value) { const receipt = { id: `receipt-${receipts.length + 1}`, ...value }; receipts.push(receipt); return receipt; },
      async saveState() {
        saveCalls += 1;
        if (delayPreparedReceipt && saveCalls === 2) { announcePreparedSave(); await preparedSaveGate; }
      },
      cleanString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      now: () => new Date().toISOString(),
      json(_res, status, body) { result = { status, body }; }
    };
    let result;
    const pending = handleAgentLinkRequest({ headers: signedHeaders(paired.token, method, pathname, body), socket: {} }, {}, ctx);
    return { state, get connection() { return state.agentLinks.find((item) => item.id === paired.connection.id); }, receipts,
      get result() { return result; }, pending, recallStarted, releaseRecall, preparedSaveStarted, releasePreparedSave };
  };

  const duringRecall = await makeRoute({ delayRecall: true });
  const recallBoundary = await Promise.race([
    duringRecall.recallStarted.then(() => 'entered-recall'),
    duringRecall.pending.then(() => 'route-finished'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_000))
  ]);
  assert.equal(recallBoundary, 'entered-recall', `route did not reach the recall boundary: ${JSON.stringify(duringRecall.result)}`);
  duringRecall.connection.capabilities = duringRecall.connection.capabilities.filter((capability) => capability !== 'memory-read');
  duringRecall.releaseRecall();
  await duringRecall.pending;
  assert.equal(duringRecall.result.status, 200);
  assert.equal(duringRecall.result.body.memoryContext.state, 'not-granted');
  assert.doesNotMatch(JSON.stringify(duringRecall.result.body), /PRIVATE-PACKET-SECRET/);
  assert.equal(duringRecall.receipts.some((receipt) => receipt.action === 'memory:automatic-context'), false,
    'revocation during the async recall prevents packet preparation and its completion receipt');

  const beforeDelivery = await makeRoute({ delayPreparedReceipt: true });
  await beforeDelivery.preparedSaveStarted;
  assert.ok(beforeDelivery.receipts.some((receipt) => receipt.action === 'memory:automatic-context' && receipt.status === 'completed'));
  beforeDelivery.connection.memoryScope = { ...beforeDelivery.connection.memoryScope, projectId: 'changed-project' };
  beforeDelivery.releasePreparedSave();
  await beforeDelivery.pending;
  assert.equal(beforeDelivery.result.status, 200);
  assert.equal(beforeDelivery.result.body.memoryContext.state, 'not-selected');
  assert.doesNotMatch(JSON.stringify(beforeDelivery.result.body), /PRIVATE-PACKET-SECRET/);
  assert.equal(beforeDelivery.receipts.some((receipt) => receipt.action === 'memory:automatic-context' && receipt.status === 'completed'), true,
    'the successful scoped read remains in receipt history as prepared');
  assert.equal(beforeDelivery.receipts.some((receipt) => receipt.action === 'memory:automatic-context-delivery' && receipt.status === 'blocked'), true,
    'the final exact-scope recheck records that packet delivery was withheld');
  const preparedReceipt = beforeDelivery.receipts.find((receipt) => receipt.action === 'memory:automatic-context');
  assert.match(preparedReceipt.detail, /prepared/);
  assert.doesNotMatch(preparedReceipt.detail, /received/);
});
