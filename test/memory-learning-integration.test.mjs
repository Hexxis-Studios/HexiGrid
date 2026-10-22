import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signatureFor } from '../lib/agent-link.mjs';
import { decryptBackup } from '../lib/backup.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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
    csrf: () => decodeURIComponent(cookies.get('hexigrid_csrf') || '')
  };
}

test('completed local and signed room/task sources learn under retained identity and scope', { timeout: 240_000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-learning-'));
  const port = await freePort();
  const relayPort = await freePort();
  const releaseFirstExtraction = deferred();
  const releaseRestoreExtraction = deferred();
  const releaseTaskExtraction = deferred();
  const releaseChangedExtractor = deferred();
  const signedHolds = new Map(['SIGNED-WRITE-REVOKE', 'SIGNED-SCOPE-CHANGE', 'SIGNED-RESTART', 'SIGNED-REPLACEMENT'].map(marker => [marker, deferred()]));
  const signedHeld = new Set();
  const signedTaskHolds = new Map(['SIGNED-TASK-RESTART', 'SIGNED-TASK-OLD-LINK'].map(marker => [marker, deferred()]));
  const signedTaskHeld = new Set();
  const signedTaskFacts = new Map([
    ['SIGNED-TASK-RESTART', 'The archive catalogs meteorites in blue drawers.'],
    ['SIGNED-TASK-OLD-LINK', 'The seed vault records packet checks every evening.']
  ]);
  const signedFacts = new Map([
    ['SIGNED-SCOPED-LEARNING', 'The archive sorts maps by latitude.'],
    ['SIGNED-OWNER-LEARNING', 'The observatory tracks meteors nightly.'],
    ['SIGNED-WRITE-REVOKE', 'The bicycle rack has twelve slots.'],
    ['SIGNED-SCOPE-CHANGE', 'The ceramic kiln reaches eight hundred degrees.'],
    ['SIGNED-RESTART', 'The museum stores clay tablets in oak cabinets.'],
    ['SIGNED-REPLACEMENT', 'The greenhouse stores seed packets in numbered drawers.']
  ]);
  const capturedChats = [];
  const extractionPrompts = [];
  let localExtractionCalls = 0;
  let heldFirstExtraction = false;
  let firstExtractionWasClosed = false;
  let heldRestoreExtraction = false;
  let restoreExtractionWasClosed = false;
  let heldTaskExtraction = false;
  let heldChangedExtractor = false;

  const fakeLocalProvider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = (body.messages || []).map(message => String(message.content || '')).join('\n');
    if (prompt.includes('memory-learning-extraction:')) {
      localExtractionCalls += 1;
      extractionPrompts.push(prompt);
      const signedTaskMarker = [...signedTaskFacts.keys()].find(marker => prompt.includes(marker));
      if (signedTaskMarker) {
        if (!signedTaskHeld.has(signedTaskMarker)) {
          signedTaskHeld.add(signedTaskMarker);
          await signedTaskHolds.get(signedTaskMarker).promise;
          if (res.destroyed) return;
        }
        const text = signedTaskFacts.get(signedTaskMarker);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ kind: 'fact', text, evidence_excerpt: text }]) } }] }));
        return;
      }
      const signedMarker = [...signedFacts.keys()].find(marker => prompt.includes(marker));
      if (signedMarker && signedHolds.has(signedMarker) && !signedHeld.has(signedMarker)) {
        signedHeld.add(signedMarker);
        await signedHolds.get(signedMarker).promise;
        if (res.destroyed) return;
      }
      if (signedMarker) {
        const text = signedFacts.get(signedMarker);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ kind: 'fact', text, evidence_excerpt: text }]) } }] }));
        return;
      }
      if (prompt.includes('EXTRACTOR-SWITCH-OWNER') && !heldChangedExtractor) {
        heldChangedExtractor = true;
        await releaseChangedExtractor.promise;
        if (res.destroyed) return;
      }
      if (prompt.includes('TASK-LEARNING') && !heldTaskExtraction) {
        heldTaskExtraction = true;
        await releaseTaskExtraction.promise;
        if (res.destroyed) return;
      }
      if (prompt.includes('FIRST-ROOM-OWNER') && !heldFirstExtraction) {
        heldFirstExtraction = true;
        res.once('close', () => { firstExtractionWasClosed = true; });
        await releaseFirstExtraction.promise;
        if (res.destroyed) return;
      }
      if (prompt.includes('RESTORE-STOP-OWNER') && !heldRestoreExtraction) {
        heldRestoreExtraction = true;
        res.once('close', () => { restoreExtractionWasClosed = true; });
        await releaseRestoreExtraction.promise;
        if (res.destroyed) return;
      }
      const candidate = {
        kind: 'preference',
        text: 'The studio prefers cedar workbenches.',
        evidence_excerpt: 'We prefer cedar workbenches in the studio.'
      };
      const taskCandidate = {
        kind: 'fact',
        text: 'The greenhouse uses blue labels.',
        evidence_excerpt: 'The greenhouse uses blue labels.'
      };
      const restoreCandidate = {
        kind: 'fact',
        text: 'The north shed has copper hinges.',
        evidence_excerpt: 'The north shed has copper hinges.'
      };
      const content = prompt.includes('FIRST-ROOM-OWNER') ? JSON.stringify([candidate, candidate])
        : prompt.includes('EXTRACTOR-SWITCH-OWNER') ? JSON.stringify([{ kind: 'fact',
          text: body.model === 'memory-learning-alternate' ? 'The trail kiosk runs on solar power.' : 'The old snapshot says mains power.',
          evidence_excerpt: body.model === 'memory-learning-alternate' ? 'The trail kiosk runs on solar power.' : 'The old snapshot says mains power.' }])
        : prompt.includes('MIXED-ROOM-OWNER') ? JSON.stringify([{ kind: 'fact', text: 'The orchard packs apricots in violet crates.', evidence_excerpt: 'The orchard packs apricots in violet crates.' }])
        : prompt.includes('ORIGIN-REVIEW-OWNER') ? JSON.stringify([{ kind: 'policy', text: 'The workshop requires a safety checklist.', evidence_excerpt: 'The workshop requires a safety checklist.' }])
        : prompt.includes('RESTORE-STOP-OWNER') ? JSON.stringify([restoreCandidate])
        : prompt.includes('TASK-LEARNING') ? JSON.stringify([taskCandidate]) : '[]';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }

    capturedChats.push(prompt);
    const signedTaskMarker = [...signedTaskFacts.keys()].find(marker => prompt.includes(marker));
    if (signedTaskMarker) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: signedTaskFacts.get(signedTaskMarker) } }] }));
      return;
    }
    if (prompt.includes('FIRST-ROOM-OWNER')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'We prefer cedar workbenches in the studio.' } }] }));
      return;
    }
    if (prompt.includes('TASK-LEARNING')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'The greenhouse uses blue labels.' } }] }));
      return;
    }
    const content = prompt.includes('SECOND-ROOM-OWNER')
      ? 'We also prefer fir workbenches in the studio.'
      : prompt.includes('RESTORE-STOP-OWNER')
        ? 'The north shed has copper hinges.'
      : prompt.includes('RECALL-QUERY')
        ? 'The studio prefers cedar workbenches, and the greenhouse uses blue labels.'
        : 'Local test reply.';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(resolve => fakeLocalProvider.listen(0, '127.0.0.1', resolve));

  const startServer = () => spawn(process.execPath, ['server.mjs'], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_DATA_DIR: dataDir, LOCALAPPDATA: path.join(dataDir, 'local-app-data'),
      HEXIGRID_DISABLE_OS_VAULT: '1', OPENCODE_CLI: 'missing-opencode-for-memory-learning-test' }
  });
  let child = startServer();
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
  const waitUntil = async (description, predicate, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated server exited while waiting for ${description}.`);
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  const waitForCommittedProposal = async text => {
    const passphrase = 'synthetic-automatic-learning-audit';
    return waitUntil('the authorized automatic write to finish durably', async () => {
      const result = await request('/api/backup/export', 'POST', { passphrase });
      assert.equal(result.status, 200);
      const proposal = decryptBackup(result.body.envelope, passphrase).memoryProposals
        ?.find(item => item.agentId === agent.id && item.payload?.text === text);
      return proposal?.status === 'approved' && proposal.autoCommitted === true && proposal.commitState === 'committed'
        ? proposal : null;
    }, 10_000);
  };
  const waitForRoomRequest = async (roomId, requestId) => waitUntil(`${requestId} to complete`, async () => {
    const result = await request('/api/rooms');
    const room = result.body.rooms?.find(item => item.id === roomId);
    return room?.replyChain?.requestId === requestId && room.replyChain.status === 'completed' ? room : null;
  }, 15_000);
  const sendTurn = async (roomId, requestId, content, agentId) => {
    const endpoint = `/api/rooms/${encodeURIComponent(roomId)}/turns`;
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const result = await request(endpoint, 'POST', { requestId, content, agentIds: Array.isArray(agentId) ? agentId : [agentId] });
      if (result.status === 202) return result;
      if (result.status !== 409) throw new Error(`Room turn ${requestId} failed (${result.status}): ${JSON.stringify(result.body)}`);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`Room turn ${requestId} could not start.`);
  };

  t.after(async () => {
    releaseFirstExtraction.resolve();
    releaseRestoreExtraction.resolve();
    releaseTaskExtraction.resolve();
    releaseChangedExtractor.resolve();
    for (const hold of signedHolds.values()) hold.resolve();
    for (const hold of signedTaskHolds.values()) hold.resolve();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fakeLocalProvider.closeAllConnections();
    await new Promise(resolve => fakeLocalProvider.close(resolve));
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir());
    const relative = path.relative(tempRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test cleanup must stay inside the OS temp directory');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  await waitUntil('the isolated server to start', async () => (await fetch(`${origin}/api/bootstrap`).catch(() => null))?.ok);
  assert.equal((await request('/api/auth/setup', 'POST', { password: 'memory-learning-test-passphrase' })).status, 200);
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);

  const localProvider = await request('/api/providers', 'POST', {
    name: 'Memory learning local fixture', baseUrl: `http://127.0.0.1:${fakeLocalProvider.address().port}/v1`,
    models: 'memory-learning-fixture\nmemory-learning-alternate', apiStyle: 'openai-chat'
  });
  assert.equal(localProvider.status, 201, JSON.stringify(localProvider.body));
  assert.equal(localProvider.body.provider.local, true);
  assert.equal(localProvider.body.provider.hasKey, false);

  const localModel = `provider:${localProvider.body.provider.id}:memory-learning-fixture`;
  const remoteProvider = await request('/api/providers', 'POST', {
    name: 'Unused remote cognition fixture', baseUrl: 'https://example.invalid/v1',
    models: 'never-invoked-remote-model', apiStyle: 'openai-chat'
  });
  assert.equal(remoteProvider.status, 201, JSON.stringify(remoteProvider.body));
  const remoteModel = `provider:${remoteProvider.body.provider.id}:never-invoked-remote-model`;
  const invalidLearningCreate = await request('/api/agents', 'POST', {
    name: 'Invalid learning route', transport: 'local-opencode', memoryLearningModel: remoteModel
  });
  assert.equal(invalidLearningCreate.status, 400, 'learning configuration never selects a remote extractor');
  const createdAgent = await request('/api/agents', 'POST', {
    name: 'Automatic memory test agent', transport: 'local-opencode', model: localModel
  });
  assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent.body));
  const agent = createdAgent.body.agent;
  assert.equal(agent.memoryLearningModel, '');
  const invalidLearningUpdate = await request(`/api/agents/${agent.id}`, 'PATCH', {
    name: 'MUST-NOT-PARTIALLY-SAVE', memoryLearningModel: remoteModel
  });
  assert.equal(invalidLearningUpdate.status, 400);
  assert.equal((await request('/api/agents')).body.agents.find(item => item.id === agent.id)?.name, agent.name,
    'invalid learning route rejects the complete profile change');
  assert.equal((await request(`/api/agents/${agent.id}`, 'PATCH', { memoryLearningModel: 17 })).status, 400);
  assert.equal((await request(`/api/agents/${agent.id}`, 'PATCH', { memoryLearningModel: localModel })).status, 200);
  assert.equal(agent.learnFromConversations, true, 'local profiles default to learning enabled');
  const externalProfile = await request('/api/agents', 'POST', {
    name: 'External preference retention fixture', transport: 'ilands-runner', learnFromConversations: true
  });
  assert.equal(externalProfile.status, 201, JSON.stringify(externalProfile.body));
  assert.equal(externalProfile.body.agent.learnFromConversations, true,
    'an explicit external-profile preference is retained without making that profile locally eligible');

  const createdRoom = await request('/api/rooms', 'POST', { name: 'Durable learning source room' });
  assert.equal(createdRoom.status, 201, JSON.stringify(createdRoom.body));
  const roomId = createdRoom.body.room.id;
  await sendTurn(roomId, 'first-room-turn', 'FIRST-ROOM-OWNER: We prefer cedar workbenches in the studio.', agent.id);
  await waitForRoomRequest(roomId, 'first-room-turn');
  try { await waitUntil('the first extraction request to start', () => heldFirstExtraction, 10_000); }
  catch (error) {
    const snapshot = await request('/api/rooms');
    throw new Error(`${error.message} calls=${localExtractionCalls} rooms=${JSON.stringify(snapshot.body.rooms?.map(item => ({ chain: item.replyChain, sources: item.memoryLearningSources })))}`);
  }
  await sendTurn(roomId, 'second-room-turn', 'SECOND-ROOM-OWNER: We also prefer fir workbenches in the studio.', agent.id);
  await waitForRoomRequest(roomId, 'second-room-turn');
  await waitUntil('the interactive turn to abort the idle extraction', () => firstExtractionWasClosed, 5_000);
  releaseFirstExtraction.resolve();

  const facts = await waitUntil('the first completed turn to become canonical memory', async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts?query=cedar%20workbenches&limit=100`);
    if (response.status !== 200) return null;
    return response.body.facts?.some(item => item.text === 'The studio prefers cedar workbenches.') ? response : null;
  }, 30_000);
  assert.equal(facts.body.facts.filter(item => item.text === 'The studio prefers cedar workbenches.').length, 1,
    'duplicate candidates from one extraction batch produce one canonical fact');
  assert.equal(facts.body.facts[0].originKind, 'automatic-learning');
  const firstTurnExtraction = extractionPrompts.find(prompt => prompt.includes('FIRST-ROOM-OWNER'));
  assert.ok(firstTurnExtraction, 'the retained first turn was extracted after the next replyChain replaced it');
  assert.doesNotMatch(firstTurnExtraction, /SECOND-ROOM-OWNER/, 'each source digest covers only its completed turn');

  // Build the prior room batches before checking work-mode policy: the first
  // extraction was interrupted, the second has no candidate, and the first is retried.
  await waitUntil('prior room extraction batches to finish', () => localExtractionCalls >= 3, 15_000);
  await waitForCommittedProposal('The studio prefers cedar workbenches.');

  const createdTask = await request('/api/tasks', 'POST', {
    agentId: agent.id, name: 'Task memory learning fixture',
    prompt: 'TASK-LEARNING: Verify the greenhouse label fact.', intervalSeconds: 0, maxRuns: 1, maxRetries: 0
  });
  assert.equal(createdTask.status, 201, JSON.stringify(createdTask.body));
  const taskRun = await request(`/api/tasks/${encodeURIComponent(createdTask.body.task.id)}/run`, 'POST', {});
  assert.equal(taskRun.status, 200, JSON.stringify(taskRun.body));
  assert.equal(taskRun.body.run.status, 'completed');
  await waitUntil('the task extraction to hold before canonical commit', () => heldTaskExtraction, 15_000);
  const editedTask = await request(`/api/tasks/${createdTask.body.task.id}`, 'PATCH', {
    name: 'Edited task definition', prompt: 'EDITED-TASK: The greenhouse now uses orange labels.'
  });
  assert.equal(editedTask.status, 200, JSON.stringify(editedTask.body));
  const separateCognition = await request(`/api/agents/${agent.id}`, 'PATCH', { model: remoteModel });
  assert.equal(separateCognition.status, 200);
  assert.equal(separateCognition.body.agent.memoryLearningModel, localModel, 'omitting the independent learning model preserves it');
  const exiting = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exiting;
  releaseTaskExtraction.resolve();
  child = startServer();
  await waitUntil('the isolated server to restart with the queued task source', async () => {
    const response = await fetch(`${origin}/api/bootstrap`).catch(() => null);
    return response && [200, 401].includes(response.status);
  });
  const restartedLogin = await request('/api/auth/login', 'POST', { password: 'memory-learning-test-passphrase' });
  assert.equal(restartedLogin.status, 200, JSON.stringify(restartedLogin.body));
  const retainedTasks = await request('/api/tasks');
  assert.equal(retainedTasks.body.tasks.find(item => item.id === createdTask.body.task.id)?.prompt,
    'EDITED-TASK: The greenhouse now uses orange labels.', 'the edited current task persists independently of its completed run');
  const learnedTaskFact = await waitUntil('the completed local task to become canonical memory', async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts?query=greenhouse%20uses%20blue%20labels&limit=100`);
    if (response.status !== 200) return null;
    return response.body.facts?.find(item => item.text === 'The greenhouse uses blue labels.') || null;
  }, 30_000);
  assert.equal(learnedTaskFact.metadata?.extraction?.sourceKind, 'task-run');
  assert.equal(learnedTaskFact.originKind, 'automatic-learning');
  assert.equal(learnedTaskFact.metadata?.extraction?.sourceId, taskRun.body.run.id,
    'the canonical fact provenance points to this successful local task run');
  await waitForCommittedProposal(learnedTaskFact.text);
  assert.ok(extractionPrompts.some(prompt => prompt.includes('TASK-LEARNING')),
    'the completed local task output was resolved and extracted');
  const retriedTaskExtraction = extractionPrompts.filter(prompt => prompt.includes('TASK-LEARNING'));
  assert.ok(retriedTaskExtraction.length >= 2, 'the queued source was resolved again after restart');
  assert.ok(retriedTaskExtraction.every(prompt => prompt.includes('Task memory learning fixture') && !prompt.includes('EDITED-TASK')),
    'both extraction attempts retain only the exact task definition executed by this run');
  const restoredCognition = await request(`/api/agents/${agent.id}`, 'PATCH', { model: localModel, memoryLearningModel: '' });
  assert.equal(restoredCognition.status, 200);
  assert.equal(restoredCognition.body.agent.memoryLearningModel, '', 'empty selection explicitly clears the override');

  await sendTurn(roomId, 'origin-review-turn', 'ORIGIN-REVIEW-OWNER: The workshop requires a safety checklist.', agent.id);
  await waitForRoomRequest(roomId, 'origin-review-turn');
  const pendingOrigin = await waitUntil('the extracted policy to wait for owner review', async () => {
    const result = await request(`/api/memory-proposals?agentId=${encodeURIComponent(agent.id)}`);
    return result.body.proposals?.find(proposal => proposal.payload?.text === 'The workshop requires a safety checklist.') || null;
  }, 15_000);
  assert.equal(pendingOrigin.provenance.kind, 'dreaming-worker');
  const approvedOrigin = await request(`/api/memory-proposals/${pendingOrigin.id}/decision`, 'POST', { decision: 'approve' });
  assert.equal(approvedOrigin.status, 200, JSON.stringify(approvedOrigin.body));
  const reviewedFacts = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts?query=safety%20checklist&limit=100`);
  assert.equal(reviewedFacts.body.facts?.[0]?.originKind, 'automatic-learning', 'Owner approval retains automatic creation origin.');
  const invitation = await request('/api/agent-links/invites', 'POST', { capabilities: ['messages'] });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const inviteUrl = new URL(invitation.body.invitationUrl);
  const paired = await request('/agent-link/v1/pair', 'POST', { inviteId: invitation.body.invite.id,
    secret: new URLSearchParams(inviteUrl.hash.slice(1)).get('secret'), capabilities: ['messages'],
    identity: { name: 'Mixed source signed peer', framework: 'test', externalId: 'mixed-learning-peer' } });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const externalAgentId = paired.body.agent.id;
  assert.equal((await request(`/api/agents/${externalAgentId}`, 'PATCH', {
    model: localModel, learnFromConversations: true, memoryLearningModel: localModel
  })).status, 200);
  const mixedRoom = await request('/api/rooms', 'POST', { name: 'Mixed source learning room' });
  assert.equal(mixedRoom.status, 201, JSON.stringify(mixedRoom.body));
  await sendTurn(mixedRoom.body.room.id, 'mixed-source-turn', 'MIXED-ROOM-OWNER: The orchard packs apricots in violet crates.',
    [agent.id, externalAgentId]);
  const queued = await waitUntil('the signed peer room request', async () => {
    const result = await request('/api/rooms');
    return result.body.rooms?.find(room => room.id === mixedRoom.body.room.id)?.messages
      .find(message => message.linkedTurn?.linkId === paired.body.connection.id && message.linkedTurn.status === 'queued') || null;
  });
  const replyPath = '/agent-link/v1/rooms/reply';
  const reply = { roomId: mixedRoom.body.room.id, eventId: queued.linkedTurn.eventId,
    text: 'EXTERNAL-ONLY-SOURCE: I store papaya in silver barrels.' };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
  const replyResponse = await fetch(`${origin}${replyPath}`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${paired.body.token}`,
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token: paired.body.token, method: 'POST', pathname: replyPath, timestamp, nonce, body: reply })
  }, body: JSON.stringify(reply) });
  assert.equal(replyResponse.status, 201);
  await waitForRoomRequest(mixedRoom.body.room.id, 'mixed-source-turn');
  let mixedFact;
  try { mixedFact = await waitUntil('the local participant of a mixed room to learn its retained source', async () => {
    const result = await request(`/api/agents/${agent.id}/memory-facts?query=violet%20crates&limit=100`);
    return result.body.facts?.find(fact => fact.text === 'The orchard packs apricots in violet crates.') || null;
  }, 15_000); } catch (error) {
    const snapshot = await request('/api/rooms');
    const room = snapshot.body.rooms?.find(item => item.id === mixedRoom.body.room.id);
    const proposals = await request(`/api/memory-proposals?agentId=${agent.id}`);
    throw new Error(`${error.message}; synthetic sources=${JSON.stringify(room?.memoryLearningSources)}; mixedExtractions=${extractionPrompts.filter(prompt => prompt.includes('MIXED-ROOM-OWNER')).length}; proposals=${JSON.stringify(proposals.body.proposals?.map(item => ({ kind: item.kind, status: item.status, text: item.payload?.text })))}`);
  }
  assert.equal(mixedFact.originKind, 'automatic-learning');
  assert.equal(mixedFact.agentId, agent.id);
  await waitForCommittedProposal(mixedFact.text);
  const mixedExtraction = extractionPrompts.find(prompt => prompt.includes('MIXED-ROOM-OWNER'));
  assert.ok(mixedExtraction);
  assert.doesNotMatch(mixedExtraction, /EXTERNAL-ONLY-SOURCE|silver barrels/,
    'the local participant source cannot borrow the external participant reply');
  const externalFacts = await request(`/api/agents/${externalAgentId}/memory-facts?limit=100`);
  assert.equal(externalFacts.body.facts.length, 0, 'mixed room participation does not expand external learning eligibility');
  const signedRequest = async (pathname, body) => {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${paired.body.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: paired.body.token, method: 'POST', pathname, timestamp, nonce, body })
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const grantedCapabilities = ['messages', 'memory-read', 'memory-write', 'tasks'];
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', { capabilities: grantedCapabilities, approved: true })).status, 200);
  const scopedSelection = { projectId: 'learning-signed-qa', topicId: 'archive' };
  const otherSelection = { projectId: 'learning-signed-qa', topicId: 'ceramics' };
  for (const [index, contextScope] of [scopedSelection, otherSelection].entries()) {
    const seed = await signedRequest('/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: index + 1, method: 'tools/call',
      params: { name: 'propose-memory', arguments: { text: `Calibration entry for region ${index + 1}. Meteorite catalog baseline is reference ${index + 1}.`, contextScope } } });
    assert.equal(seed.status, 200, seed.body.error?.message);
    const proposalId = seed.body.result?.structuredContent?.proposalId;
    assert.ok(proposalId);
    assert.equal((await request(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' })).status, 200);
  }
  assert.equal((await signedRequest('/agent-link/v1/memory-scope', { scope: scopedSelection })).status, 200);
  const signedRoom = (await request('/api/rooms', 'POST', { name: 'Signed scoped learning QA' })).body.room;
  const completeSignedTurn = async marker => {
    await sendTurn(signedRoom.id, marker, `${marker}: ${signedFacts.get(marker) || 'This turn must not be learned.'}`, externalAgentId);
    const pending = await waitUntil('the exact signed request to queue', async () => {
      const rooms = await request('/api/rooms');
      return rooms.body.rooms?.find(room => room.id === signedRoom.id)?.messages.find(message =>
        message.linkedTurn?.requestId === marker && message.linkedTurn.linkId === paired.body.connection.id && message.linkedTurn.status === 'queued');
    });
    const reply = await signedRequest('/agent-link/v1/rooms/reply', { roomId: signedRoom.id, eventId: pending.linkedTurn.eventId,
      text: `${signedFacts.get(marker) || 'This turn must not be learned.'} SIGNED-ONLY-EVIDENCE` });
    assert.equal(reply.status, 201, reply.body.error);
    return waitForRoomRequest(signedRoom.id, marker);
  };
  const scopedCompleted = await completeSignedTurn('SIGNED-SCOPED-LEARNING');
  const reference = scopedCompleted.memoryLearningSources?.find(source => source.requestId === 'SIGNED-SCOPED-LEARNING');
  assert.ok(reference, 'the completed signed source is retained');
  assert.equal(reference.linkId, paired.body.connection.id);
  assert.deepEqual(reference.scope, scopedSelection);
  const exactReply = scopedCompleted.messages.find(message => message.id === reference.replyMessageId);
  assert.equal(exactReply.inReplyTo, reference.pendingMessageId);
  const scopedProposal = await waitUntil('the scoped automatic proposal to require review', async () => {
    const result = await request(`/api/memory-proposals?agentId=${externalAgentId}`);
    return result.body.proposals?.find(item => item.payload?.text === signedFacts.get('SIGNED-SCOPED-LEARNING'));
  }, 15_000);
  assert.equal(scopedProposal.reviewRequired, true);
  assert.equal(scopedProposal.provenance.kind, 'dreaming-worker');
  assert.deepEqual(scopedProposal.payload.contextScope, scopedSelection);
  let signedStored = await request(`/api/agents/${externalAgentId}/memory-facts?query=latitude&limit=100`);
  assert.equal(signedStored.body.facts.length, 0, 'scoped learning cannot bypass owner review');
  assert.equal((await request(`/api/memory-proposals/${scopedProposal.id}/decision`, 'POST', { decision: 'approve' })).status, 200);
  signedStored = await request(`/api/agents/${externalAgentId}/memory-facts?query=latitude&limit=100`);
  assert.equal(signedStored.body.facts[0]?.originKind, 'automatic-learning');
  assert.deepEqual(signedStored.body.facts[0]?.contextScope, scopedSelection);
  const signedPrompt = extractionPrompts.find(prompt => prompt.includes('SIGNED-SCOPED-LEARNING'));
  assert.match(signedPrompt, /SIGNED-ONLY-EVIDENCE/);
  assert.doesNotMatch(signedPrompt, /EXTERNAL-ONLY-SOURCE|Local test reply|cedar workbenches/);
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/trust`, 'PATCH', { trustLevel: 'owner', approved: true })).status, 200);
  await completeSignedTurn('SIGNED-OWNER-LEARNING');
  await waitUntil('the owner-trusted scoped automatic fact to commit', async () => {
    const result = await request(`/api/agents/${externalAgentId}/memory-facts?query=meteors&limit=100`);
    return result.body.facts?.find(fact => fact.text === signedFacts.get('SIGNED-OWNER-LEARNING') && fact.originKind === 'automatic-learning');
  }, 15_000);

  await completeSignedTurn('SIGNED-RESTART');
  await waitUntil('the signed source extraction to hold before restart', () => signedHeld.has('SIGNED-RESTART'), 15_000);
  const beforeRestartRooms = await request('/api/rooms');
  const beforeRestartRoom = beforeRestartRooms.body.rooms?.find(item => item.id === signedRoom.id);
  const restartReference = beforeRestartRoom?.memoryLearningSources?.find(source => source.requestId === 'SIGNED-RESTART');
  assert.ok(restartReference, 'the held signed source is durably referenced before restart');
  assert.equal(restartReference.linkId, paired.body.connection.id);
  assert.deepEqual(restartReference.scope, scopedSelection);
  const signedTaskDefinition = {
    name: 'Signed task definition captured before restart',
    prompt: 'SIGNED-TASK-RESTART: Verify the archive meteorite catalog.'
  };
  const signedTaskCreated = await signedRequest('/agent-link/v1/tasks', { operation: 'create', ...signedTaskDefinition,
    intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
  assert.equal(signedTaskCreated.status, 201, JSON.stringify(signedTaskCreated.body));
  const signedTaskId = signedTaskCreated.body.task.id;
  const signedTaskRun = await signedRequest('/agent-link/v1/tasks', { operation: 'run', taskId: signedTaskId });
  assert.equal(signedTaskRun.status, 200, JSON.stringify(signedTaskRun.body));
  assert.equal(signedTaskRun.body.run.status, 'completed');
  assert.equal(signedTaskRun.body.run.memoryLearningSourceVersion, undefined,
    'the signed Link receives no encrypted learning authority snapshot');
  assert.equal(JSON.stringify(signedTaskRun.body.run).includes('linkTokenHash'), false,
    'the signed Link never receives the captured credential hash');
  const signedTaskRunId = signedTaskRun.body.run.id;
  const taskSnapshotPassphrase = 'signed-task-learning-source-snapshot-passphrase';
  const preRestartLearning = await waitUntil('the exact signed task source to be durably queued and held before restart', async () => {
    const [result, snapshot] = await Promise.all([
      request('/api/bootstrap'),
      request('/api/backup/export', 'POST', { passphrase: taskSnapshotPassphrase })
    ]);
    if (result.body.memoryLearning?.queuedSources < 2 || snapshot.status !== 200 ||
        !signedTaskHeld.has('SIGNED-TASK-RESTART')) return null;
    const payload = decryptBackup(snapshot.body.envelope, taskSnapshotPassphrase);
    const taskJob = payload.memoryLearningQueue?.jobs?.find(job =>
      job.kind === 'task-run' && job.id === signedTaskRunId);
    return taskJob ? { learning: result.body.memoryLearning, taskJob } : null;
  }, 20_000);
  assert.ok(preRestartLearning.taskJob,
    'the identity-specific pre-backup observation contains the signed task source job');
  assert.ok(signedTaskHeld.has('SIGNED-TASK-RESTART'),
    'the signed task extraction reached its fixture hold before the backup snapshot');
  assert.ok(preRestartLearning.learning.queuedSources >= 2,
    'the held signed room and completed signed task both have queued learning sources before restart');
  const taskSnapshot = await request('/api/backup/export', 'POST', { passphrase: taskSnapshotPassphrase });
  assert.equal(taskSnapshot.status, 200, JSON.stringify(taskSnapshot.body));
  const taskSnapshotPayload = decryptBackup(taskSnapshot.body.envelope, taskSnapshotPassphrase);
  const capturedTaskRun = taskSnapshotPayload.taskRuns.find(item => item.id === signedTaskRunId);
  assert.ok(capturedTaskRun, 'the pre-restart encrypted snapshot retains the signed task run');
  const capturedTaskVersion = capturedTaskRun.memoryLearningSourceVersion;
  assert.equal(capturedTaskVersion.version, 2);
  assert.equal(capturedTaskVersion.taskId, signedTaskId);
  assert.equal(capturedTaskVersion.agentId, externalAgentId);
  assert.ok(capturedTaskVersion.lineageId);
  assert.equal(capturedTaskVersion.name, signedTaskDefinition.name);
  assert.equal(capturedTaskVersion.prompt, signedTaskDefinition.prompt);
  assert.equal(capturedTaskVersion.sourceLinkId, paired.body.connection.id);
  assert.deepEqual(capturedTaskVersion.scope, scopedSelection);
  assert.equal(capturedTaskVersion.learnFromConversations, true);
  assert.equal(Object.hasOwn(capturedTaskVersion, 'linkTokenHash'), false,
    'portable backup retains the signed definition and scope but omits the private Link verifier');
  const capturedTaskJob = taskSnapshotPayload.memoryLearningQueue.jobs.find(job =>
    job.kind === 'task-run' && job.id === signedTaskRunId);
  assert.ok(capturedTaskJob, 'the pre-restart queue snapshot retains the signed task source job');
  assert.equal(capturedTaskJob.batchId, signedTaskRunId);
  assert.equal(capturedTaskJob.agentId, externalAgentId);
  assert.equal(capturedTaskJob.lineageId, capturedTaskVersion.lineageId);
  assert.deepEqual(capturedTaskJob.scope, scopedSelection);
  assert.equal(Object.hasOwn(capturedTaskJob, 'linkTokenHash'), false,
    'the public queue reference contains no credential verifier');
  const editedSignedTask = await request(`/api/tasks/${encodeURIComponent(signedTaskId)}`, 'PATCH', {
    name: 'Edited signed task definition', prompt: 'SIGNED-TASK-EDITED: This later version must not replace the completed run.'
  });
  assert.equal(editedSignedTask.status, 200, JSON.stringify(editedSignedTask.body));
  assert.equal(editedSignedTask.body.task.prompt,
    'SIGNED-TASK-EDITED: This later version must not replace the completed run.');
  const publicSignedTaskRun = (await request('/api/bootstrap')).body.taskRuns.find(item => item.id === signedTaskRunId);
  assert.ok(publicSignedTaskRun, 'the completed signed task run is retained in encrypted state');
  assert.equal(publicSignedTaskRun.memoryLearningSourceVersion, undefined,
    'the private signed-task authority snapshot is not exposed in owner-facing task-run projections');
  assert.doesNotMatch(JSON.stringify(publicSignedTaskRun), /memoryLearningSourceVersion|linkTokenHash/);
  assert.equal(JSON.stringify(publicSignedTaskRun).includes(paired.body.token), false,
    'task-run projections never expose the Link credential');
  const signedRestartExiting = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await signedRestartExiting;
  signedHolds.get('SIGNED-RESTART').resolve();
  child = startServer();
  await waitUntil('the isolated server to restart with the held signed source', async () => {
    const response = await fetch(`${origin}/api/bootstrap`).catch(() => null);
    return response && [200, 401].includes(response.status);
  });
  assert.equal((await request('/api/auth/login', 'POST', { password: 'memory-learning-test-passphrase' })).status, 200);
  const restoredLinks = await request('/api/agent-links');
  assert.equal(restoredLinks.body.connections?.find(item => item.id === paired.body.connection.id)?.authorizationStatus, 'connected',
    'the exact captured Link remains connected after encrypted-state restart');
  const afterRestartRooms = await request('/api/rooms');
  const afterRestartRoom = afterRestartRooms.body.rooms?.find(item => item.id === signedRoom.id);
  const restoredReference = afterRestartRoom?.memoryLearningSources?.find(source => source.requestId === 'SIGNED-RESTART');
  assert.equal(restoredReference?.linkId, restartReference.linkId);
  assert.equal(restoredReference?.pendingMessageId, restartReference.pendingMessageId);
  assert.equal(restoredReference?.replyMessageId, restartReference.replyMessageId);
  assert.deepEqual(restoredReference?.scope, scopedSelection, 'the exact captured source scope survives encrypted-state restart');
  assert.equal((await signedRequest('/agent-link/v1/memory-scope', { scope: scopedSelection })).status, 200,
    'the same signed Link token remains authorized after restart');
  await waitUntil('the signed task source to reach extraction after restart', () => signedTaskHeld.has('SIGNED-TASK-RESTART'), 30_000);
  const restartedTaskRun = (await request('/api/bootstrap')).body.taskRuns.find(item => item.id === signedTaskRunId);
  assert.ok(restartedTaskRun, 'the signed task run survives encrypted-state restart');
  assert.equal(restartedTaskRun.memoryLearningSourceVersion, undefined,
    'the private authority snapshot remains redacted after restart');
  assert.doesNotMatch(JSON.stringify(restartedTaskRun), /memoryLearningSourceVersion|linkTokenHash/);
  const signedTaskExtractions = extractionPrompts.filter(prompt => prompt.includes('SIGNED-TASK-RESTART'));
  assert.ok(signedTaskExtractions.length >= 1, 'the retained signed task source is extracted after restart');
  assert.ok(signedTaskExtractions.every(prompt => prompt.includes(signedTaskDefinition.name) &&
    prompt.includes(signedTaskDefinition.prompt) && !prompt.includes('Edited signed task definition') && !prompt.includes('SIGNED-TASK-EDITED')),
  'each extraction uses the immutable task definition captured by the completed run');
  const signedTaskChat = capturedChats.find(prompt => prompt.includes('SIGNED-TASK-RESTART'));
  assert.match(signedTaskChat || '', /Calibration entry for region 1\./,
    'the signed task receives memory from the Link’s selected scope');
  assert.doesNotMatch(signedTaskChat || '', /Calibration entry for region 2\.|The greenhouse uses blue labels\./,
    'the signed task prompt excludes facts outside its selected scope and profile');
  signedTaskHolds.get('SIGNED-TASK-RESTART').resolve();
  const learnedSignedTaskFact = await waitUntil('the signed task fact to become canonical scoped memory', async () => {
    const result = await request(`/api/agents/${externalAgentId}/memory-facts?query=meteorites%20in%20blue%20drawers&limit=100`);
    return result.body.facts?.find(fact => fact.text === signedTaskFacts.get('SIGNED-TASK-RESTART'));
  }, 15_000).catch(async error => {
    const proposals = await request(`/api/memory-proposals?agentId=${externalAgentId}`);
    const bootstrap = await request('/api/bootstrap');
    throw new Error(`${error.message} standing=${JSON.stringify(proposals.body.proposals?.map(item => ({ reviewRequired: item.reviewRequired, commitState: item.commitState, code: item.lastCommitErrorCode })))} queuedSources=${bootstrap.body.memoryLearning?.queuedSources}`);
  });
  assert.equal(learnedSignedTaskFact.originKind, 'automatic-learning');
  assert.deepEqual(learnedSignedTaskFact.contextScope, scopedSelection,
    'the learned task fact is committed under the exact Link-selected scope retained at run time');
  assert.equal(learnedSignedTaskFact.metadata?.extraction?.sourceKind, 'task-run');
  assert.equal(learnedSignedTaskFact.metadata?.extraction?.sourceId, signedTaskRunId);

  const restoredSignedSource = await waitUntil('the held signed source to become canonical memory after restart', async () => {
    const result = await request(`/api/agents/${externalAgentId}/memory-facts?query=museum%20stores%20clay%20tablets&limit=100`);
    return result.body.facts?.find(fact => fact.text === signedFacts.get('SIGNED-RESTART') && fact.originKind === 'automatic-learning');
  }, 30_000);
  assert.equal(restoredSignedSource.agentId, externalAgentId);
  assert.deepEqual(restoredSignedSource.contextScope, scopedSelection);
  const restartExtractions = extractionPrompts.filter(prompt => prompt.includes('SIGNED-RESTART'));
  assert.ok(restartExtractions.length >= 2, 'the queued source is resolved and extracted again after restart');
  assert.ok(restartExtractions.every(prompt => prompt.includes('SIGNED-ONLY-EVIDENCE')),
    'both attempts use the exact retained owner message and signed reply');
  assert.doesNotMatch(restartExtractions.join('\n'), /EXTERNAL-ONLY-SOURCE|Local test reply|cedar workbenches/);

  const noReadCapabilities = grantedCapabilities.filter(capability => capability !== 'memory-read');
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', {
    capabilities: noReadCapabilities, approved: true
  })).status, 200);
  const noReadTask = await signedRequest('/agent-link/v1/tasks', { operation: 'create',
    name: 'Signed task without memory-read', prompt: 'SIGNED-TASK-NO-READ: Continue without selected memory.',
    intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
  assert.equal(noReadTask.status, 201, JSON.stringify(noReadTask.body));
  const noReadCalls = localExtractionCalls;
  const noReadRun = await signedRequest('/agent-link/v1/tasks', { operation: 'run', taskId: noReadTask.body.task.id });
  assert.equal(noReadRun.status, 200, JSON.stringify(noReadRun.body));
  assert.equal(noReadRun.body.run.status, 'completed');
  const noReadTaskChat = capturedChats.find(prompt => prompt.includes('SIGNED-TASK-NO-READ'));
  assert.doesNotMatch(noReadTaskChat || '', /Calibration entry for region 1\.|Calibration entry for region 2\./,
    'the signed task runs without memory-read and receives no scoped facts');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(localExtractionCalls, noReadCalls,
    'a signed task without memory-read completes but does not enqueue automatic learning');
  const noTaskGrantCapabilities = noReadCapabilities.filter(capability => capability !== 'tasks');
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', {
    capabilities: noTaskGrantCapabilities, approved: true
  })).status, 200);
  const deniedTaskGrant = await signedRequest('/agent-link/v1/tasks', { operation: 'create',
    name: 'Denied signed task fixture', prompt: 'This operation requires the tasks grant.' });
  assert.equal(deniedTaskGrant.status, 403, 'the signed task route requires the exact Link tasks grant');
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', {
    capabilities: grantedCapabilities, approved: true
  })).status, 200);

  for (const marker of signedHolds.keys()) {
    if (marker === 'SIGNED-RESTART' || marker === 'SIGNED-REPLACEMENT') continue;
    await completeSignedTurn(marker);
    await waitUntil('the signed extractor response to hold', () => signedHeld.has(marker), 15_000);
    if (marker === 'SIGNED-WRITE-REVOKE') {
      assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', { capabilities: ['messages', 'memory-read'], approved: true })).status, 200);
    } else assert.equal((await signedRequest('/agent-link/v1/memory-scope', { scope: otherSelection })).status, 200);
    signedHolds.get(marker).resolve();
    await waitUntil('the denied signed source to leave the queue', async () => (await request('/api/bootstrap')).body.memoryLearning.queuedSources === 0, 20_000);
    const proposals = await request(`/api/memory-proposals?agentId=${externalAgentId}`);
    assert.equal(proposals.body.proposals.some(item => item.payload?.text === signedFacts.get(marker)), false);
    const facts = await request(`/api/agents/${externalAgentId}/memory-facts?query=${encodeURIComponent(signedFacts.get(marker))}&limit=100`);
    assert.equal(facts.body.facts.length, 0, 'a changed grant or scope cannot commit the held response');
    if (marker === 'SIGNED-WRITE-REVOKE') {
      assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/capabilities`, 'PATCH', { capabilities: grantedCapabilities, approved: true })).status, 200);
    }
  }
  assert.equal((await request(`/api/agents/${externalAgentId}`, 'PATCH', { learnFromConversations: false })).status, 200);
  const signedOptedOut = await completeSignedTurn('SIGNED-OPT-OUT');
  assert.equal(signedOptedOut.memoryLearningSources?.some(source => source.requestId === 'SIGNED-OPT-OUT'), false);

  assert.equal((await request(`/api/agents/${externalAgentId}`, 'PATCH', { learnFromConversations: true })).status, 200);
  assert.equal((await signedRequest('/agent-link/v1/memory-scope', { scope: scopedSelection })).status, 200);
  await completeSignedTurn('SIGNED-REPLACEMENT');
  await waitUntil('the old Link source extraction to hold before replacement', () => signedHeld.has('SIGNED-REPLACEMENT'), 15_000);
  const beforeReplacementRooms = await request('/api/rooms');
  const beforeReplacementRoom = beforeReplacementRooms.body.rooms?.find(item => item.id === signedRoom.id);
  const replacementReference = beforeReplacementRoom?.memoryLearningSources?.find(source => source.requestId === 'SIGNED-REPLACEMENT');
  assert.ok(replacementReference);
  assert.equal(replacementReference.linkId, paired.body.connection.id);
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}`, 'DELETE', { approved: true })).status, 200,
    'the owner revokes the exact Link captured by the held source');
  const replacementInvite = await request('/api/agent-links/invites', 'POST', {
    agentId: externalAgentId, capabilities: grantedCapabilities
  });
  assert.equal(replacementInvite.status, 201, JSON.stringify(replacementInvite.body));
  const replacementInviteUrl = new URL(replacementInvite.body.invitationUrl);
  const replacementPaired = await request('/agent-link/v1/pair', 'POST', {
    inviteId: replacementInvite.body.invite.id,
    secret: new URLSearchParams(replacementInviteUrl.hash.slice(1)).get('secret'),
    capabilities: grantedCapabilities,
    identity: { name: 'Replacement signed peer', framework: 'test', externalId: 'mixed-learning-peer' }
  });
  assert.equal(replacementPaired.status, 201, JSON.stringify(replacementPaired.body));
  assert.equal(replacementPaired.body.agent.id, externalAgentId, 'the replacement connection points to the same profile');
  assert.notEqual(replacementPaired.body.connection.id, paired.body.connection.id, 'replacement pairing has a distinct Link identity');
  const replacementSignedRequest = async (pathname, body) => {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${replacementPaired.body.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: replacementPaired.body.token, method: 'POST', pathname, timestamp, nonce, body })
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await replacementSignedRequest('/agent-link/v1/memory-scope', { scope: scopedSelection })).status, 200,
    'the replacement Link independently receives the same scoped access');
  signedHolds.get('SIGNED-REPLACEMENT').resolve();
  await waitUntil('the revoked-Link source to leave the queue', async () => (await request('/api/bootstrap')).body.memoryLearning.queuedSources === 0, 20_000);
  const replacementProposals = await request(`/api/memory-proposals?agentId=${externalAgentId}`);
  assert.equal(replacementProposals.body.proposals.some(item => item.payload?.text === signedFacts.get('SIGNED-REPLACEMENT')), false);
  const replacementFacts = await request(`/api/agents/${externalAgentId}/memory-facts?query=${encodeURIComponent(signedFacts.get('SIGNED-REPLACEMENT'))}&limit=100`);
  assert.equal(replacementFacts.body.facts.length, 0,
    'a new Link to the same agent with the same grants and scope cannot authorize a source captured under the revoked Link');
  const activeReplacement = await request('/api/agent-links');
  assert.equal(activeReplacement.body.connections?.find(item => item.id === replacementPaired.body.connection.id)?.authorizationStatus, 'connected');
  const oldLinkTask = await replacementSignedRequest('/agent-link/v1/tasks', { operation: 'create',
    name: 'Signed task retained under the soon-revoked Link',
    prompt: 'SIGNED-TASK-OLD-LINK: Verify the seed vault packet-check log.',
    intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
  assert.equal(oldLinkTask.status, 201, JSON.stringify(oldLinkTask.body));
  const oldLinkTaskRun = await replacementSignedRequest('/agent-link/v1/tasks', { operation: 'run', taskId: oldLinkTask.body.task.id });
  assert.equal(oldLinkTaskRun.status, 200, JSON.stringify(oldLinkTaskRun.body));
  assert.equal(oldLinkTaskRun.body.run.status, 'completed');
  await waitUntil('the old-Link signed task extraction to hold before replacement', () => signedTaskHeld.has('SIGNED-TASK-OLD-LINK'), 15_000);
  const heldOldLinkRun = (await request('/api/bootstrap')).body.taskRuns.find(item => item.id === oldLinkTaskRun.body.run.id);
  assert.ok(heldOldLinkRun);
  assert.equal(heldOldLinkRun.memoryLearningSourceVersion, undefined,
    'public task state does not reveal the captured Link hash or signed learning source');
  assert.doesNotMatch(JSON.stringify(heldOldLinkRun), /memoryLearningSourceVersion|linkTokenHash/);
  assert.equal((await request(`/api/agent-links/${replacementPaired.body.connection.id}`, 'DELETE', { approved: true })).status, 200,
    'the owner revokes the exact Link captured by the held task source');
  const finalTaskInvite = await request('/api/agent-links/invites', 'POST', {
    agentId: externalAgentId, capabilities: grantedCapabilities
  });
  assert.equal(finalTaskInvite.status, 201, JSON.stringify(finalTaskInvite.body));
  const finalTaskInviteUrl = new URL(finalTaskInvite.body.invitationUrl);
  const finalTaskPair = await request('/agent-link/v1/pair', 'POST', {
    inviteId: finalTaskInvite.body.invite.id,
    secret: new URLSearchParams(finalTaskInviteUrl.hash.slice(1)).get('secret'),
    capabilities: grantedCapabilities,
    identity: { name: 'Final signed task replacement', framework: 'test', externalId: 'signed-task-final-peer' }
  });
  assert.equal(finalTaskPair.status, 201, JSON.stringify(finalTaskPair.body));
  assert.equal(finalTaskPair.body.agent.id, externalAgentId);
  assert.notEqual(finalTaskPair.body.connection.id, replacementPaired.body.connection.id);
  const finalTaskSignedRequest = async (pathname, body) => {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${finalTaskPair.body.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: finalTaskPair.body.token, method: 'POST', pathname, timestamp, nonce, body })
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await finalTaskSignedRequest('/agent-link/v1/memory-scope', { scope: scopedSelection })).status, 200,
    'the new Link independently receives the same read scope and task grants');
  signedTaskHolds.get('SIGNED-TASK-OLD-LINK').resolve();
  await waitUntil('the revoked-Link task source to leave the queue', async () => (await request('/api/bootstrap')).body.memoryLearning.queuedSources === 0, 20_000);
  const oldLinkTaskProposals = await request(`/api/memory-proposals?agentId=${externalAgentId}`);
  assert.equal(oldLinkTaskProposals.body.proposals.some(item => item.payload?.text === signedTaskFacts.get('SIGNED-TASK-OLD-LINK')), false);
  const oldLinkTaskFacts = await request(`/api/agents/${externalAgentId}/memory-facts?query=${encodeURIComponent(signedTaskFacts.get('SIGNED-TASK-OLD-LINK'))}&limit=100`);
  assert.equal(oldLinkTaskFacts.body.facts.length, 0,
    'a replacement Link with the same agent, grants and scope cannot authorize the held task source captured under its predecessor');
  const finalTaskLinkState = await request('/api/agent-links');
  assert.equal(finalTaskLinkState.body.connections?.find(item => item.id === finalTaskPair.body.connection.id)?.authorizationStatus, 'connected');
  await sendTurn(roomId, 'extractor-switch-turn', 'EXTRACTOR-SWITCH-OWNER: The trail kiosk runs on solar power. The old snapshot says mains power.', agent.id);
  await waitForRoomRequest(roomId, 'extractor-switch-turn');
  await waitUntil('the original extractor response to hold', () => heldChangedExtractor, 15_000);
  const alternateExtractor = `provider:${localProvider.body.provider.id}:memory-learning-alternate`;
  assert.equal((await request(`/api/agents/${agent.id}`, 'PATCH', { memoryLearningModel: alternateExtractor })).status, 200);
  releaseChangedExtractor.resolve();
  const currentExtractorFact = await waitUntil('learning to retry through the currently selected extractor', async () => {
    const facts = await request(`/api/agents/${agent.id}/memory-facts?query=solar%20power&limit=100`);
    return facts.body.facts?.find(item => item.text === 'The trail kiosk runs on solar power.');
  }, 30_000);
  assert.equal(currentExtractorFact.originKind, 'automatic-learning');
  const staleExtractorFacts = await request(`/api/agents/${agent.id}/memory-facts?query=mains%20power&limit=100`);
  assert.equal(staleExtractorFacts.body.facts.length, 0, 'an in-flight result from the previous extractor cannot commit');
  await waitForCommittedProposal(currentExtractorFact.text);
  assert.equal((await request(`/api/agents/${agent.id}`, 'PATCH', { memoryLearningModel: '' })).status, 200);
  await sendTurn(roomId, 'recall-room-turn', 'RECALL-QUERY: What labels does the greenhouse use, and what workbench does the studio prefer?', agent.id);
  await waitForRoomRequest(roomId, 'recall-room-turn');
  const recalledPrompt = capturedChats.find(prompt => prompt.includes('RECALL-QUERY'));
  assert.match(recalledPrompt || '', /The studio prefers cedar workbenches\./,
    'the next local conversation recalls the room-derived canonical fact');
  assert.match(recalledPrompt || '', /The greenhouse uses blue labels\./,
    'the next local conversation recalls the task-derived canonical fact');
  await waitUntil('the recall turn extraction batch to finish', () => localExtractionCalls >= 5, 15_000);
  const callsBeforePolicyDenial = localExtractionCalls;
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' })).status, 200);
  await sendTurn(roomId, 'plan-policy-turn', 'PLAN-POLICY-OWNER: Check that plan mode blocks automatic commits.', agent.id);
  await waitForRoomRequest(roomId, 'plan-policy-turn');
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(localExtractionCalls, callsBeforePolicyDenial, 'planning mode blocks automatic memory extraction before model dispatch');

  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const optedOut = await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { learnFromConversations: false });
  assert.equal(optedOut.status, 200);
  assert.equal(optedOut.body.agent.learnFromConversations, false);
  const callsBeforeOptOut = localExtractionCalls;
  await sendTurn(roomId, 'opt-out-turn', 'OPT-OUT-OWNER: Do not learn from this conversation.', agent.id);
  await waitForRoomRequest(roomId, 'opt-out-turn');
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(localExtractionCalls, callsBeforeOptOut, 'the persisted opt-out prevents new extraction');

  assert.equal((await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { learnFromConversations: true })).status, 200);
  const passphrase = 'memory-learning-restore-backup-passphrase';
  const backup = await request('/api/backup/export', 'POST', { passphrase });
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  const exportedPayload = decryptBackup(backup.body.envelope, passphrase);
  const exportedSignedTaskRun = exportedPayload.taskRuns.find(item => item.id === signedTaskRunId);
  assert.ok(exportedSignedTaskRun, 'the encrypted backup retains the completed signed task run');
  assert.equal(exportedSignedTaskRun.memoryLearningSourceVersion.version, 2);
  assert.equal(exportedSignedTaskRun.memoryLearningSourceVersion.prompt, signedTaskDefinition.prompt,
    'the backup retains the historical task definition for provenance');
  assert.deepEqual(exportedSignedTaskRun.memoryLearningSourceVersion.scope, scopedSelection,
    'the backup retains the historical signed memory scope');
  assert.equal(Object.hasOwn(exportedSignedTaskRun.memoryLearningSourceVersion, 'linkTokenHash'), false,
    'the backup omits the credential verifier, so a restored signed run cannot reuse its original binding');
  await sendTurn(roomId, 'restore-stop-turn', 'RESTORE-STOP-OWNER: Remember that the north shed has copper hinges.', agent.id);
  await waitForRoomRequest(roomId, 'restore-stop-turn');
  await waitUntil('the restore fixture extraction request to start', () => heldRestoreExtraction, 15_000);
  const callsAtRestore = localExtractionCalls;

  const restored = await request('/api/backup/import', 'POST', {
    envelope: backup.body.envelope, passphrase, confirmReplace: true, approved: true
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.state.memoryLearning.paused, true, 'restoring state always leaves automatic learning paused for owner review');
  assert.equal(restored.body.state.memoryLearning.workerStarted, false, 'the worker is rebuilt against restored state but is not automatically restarted');
  assert.equal(restored.body.state.settings.memoryLearningPaused, true, 'the pause latch is visible through the public settings surface');
  await waitUntil('the held extraction request to abort during restore', () => restoreExtractionWasClosed, 5_000);
  releaseRestoreExtraction.resolve();
  const restoredRooms = await request('/api/rooms');
  const restoredRoom = restoredRooms.body.rooms?.find(item => item.id === roomId);
  assert.ok(restoredRoom, 'the pre-turn room from the encrypted snapshot was restored');
  assert.doesNotMatch(JSON.stringify(restoredRoom), /RESTORE-STOP-OWNER|restore-stop-turn/,
    'the completed turn created after the snapshot is absent after restore');
  assert.equal((restoredRoom.memoryLearningSources || []).some(item => item.requestId === 'restore-stop-turn'), false,
    'no reference to the stopped source survives the state swap');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(localExtractionCalls, callsAtRestore,
    'the paused restored worker does not dispatch another extraction automatically');
  const stoppedFact = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-facts?query=north%20shed%20copper%20hinges&limit=100`);
  assert.equal(stoppedFact.body.facts?.some(item => item.text === 'The north shed has copper hinges.'), false,
    'an extraction aborted before restore cannot commit a late canonical fact');
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' })).status, 200);
  const planResume = await request('/api/memory-learning/resume', 'POST', { approved: true });
  assert.equal(planResume.status, 403, 'resume honors the active read/write policy intersection');
  assert.equal((await request('/api/bootstrap')).body.memoryLearning.paused, true,
    'a policy-denied resume leaves the durable pause latch engaged');
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const resumed = await request('/api/memory-learning/resume', 'POST', { approved: true });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.memoryLearning.paused, false);
  assert.equal(resumed.body.settings.memoryLearningPaused, false,
    'an explicit authenticated owner resume exposes the active state to public settings consumers');
  const emergencyStopped = await request('/api/emergency/stop', 'POST', {});
  assert.equal(emergencyStopped.status, 200, JSON.stringify(emergencyStopped.body));
  assert.equal(emergencyStopped.body.memoryLearning.paused, true,
    'Emergency Stop persists the learning pause latch again');
});
