import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { signatureFor } from '../lib/agent-link.mjs';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createDatedMemoryMistakeLedger } from '../lib/memory-mistake-ledger.mjs';
import { normalizeOwnerMemory } from '../lib/owner-memory.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pastMistakesMarker = '[RELEVANT PAST MISTAKES — RETAINED CLAIMS; VERIFY BEFORE ACTING]';

function warningPacket(prompt) {
  const start = String(prompt || '').indexOf(pastMistakesMarker);
  if (start < 0) return null;
  const end = String(prompt).indexOf('[[END HEXIGRID MEMORY DATA]]', start);
  assert.ok(end >= 0, 'the warning stays inside the bounded memory-data wrapper');
  const text = String(prompt).slice(start, end);
  const rows = text.split('\n').slice(1).filter(Boolean)
    .map(line => JSON.parse(line.replaceAll('\\u005b', '[').replaceAll('\\u005d', ']')));
  return { text, rows };
}

async function freePort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
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
    csrf: () => decodeURIComponent(cookies.get('hexigrid_csrf') || '')
  };
}

test('local owner-note warnings are scoped, bounded, policy-gated, and absent from signed Link scope', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-owner-note-warning-'));
  const port = await freePort();
  const relayPort = await freePort();
  const providerPrompts = [];
  const serverStderr = [];
  const diagnostic = { dataDir, latestTurn: null, providerPromptCount: 0 };
  let passed = false;

  const fakeLocalProvider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* surface invalid requests with a local provider response */ }
    const prompt = (body.messages || []).map(message => String(message.content || '')).join('\n');
    providerPrompts.push(prompt);
    diagnostic.providerPromptCount = providerPrompts.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Fixture local answer.' } }] }));
  });
  await new Promise(resolve => fakeLocalProvider.listen(0, '127.0.0.1', resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
      HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`,
      HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-opencode-for-owner-note-test' }
  });
  child.stderr.on('data', chunk => serverStderr.push(String(chunk)));
  const cookies = cookieJar();
  const origin = `http://127.0.0.1:${port}`;
  const redact = value => String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE|PRIVATE_TEST_EVIDENCE_EXCERPT_MUST_NOT_REACH_A_PROMPT/g, '[private fixture evidence]')
    .replace(/Check the current ledger date before each answer\./g, '[private fixture correction]')
    .slice(0, 500);
  const safeRoomSummary = room => {
    const chain = room?.replyChain || {};
    const lastAssistant = [...(room?.messages || [])].reverse().find(message => message.role === 'assistant');
    return {
      requestId: chain.requestId || null,
      status: chain.status || null,
      error: redact(chain.error || chain.failureReason || chain.lastError || ''),
      assistantReply: lastAssistant ? redact(lastAssistant.content) : null
    };
  };
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
  const signedRequest = async (token, pathname, body) => {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token, method: 'POST', pathname, timestamp, nonce, body })
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const waitForRoomTerminal = async (roomId, requestId, timeoutMs = 5_000) => {
    const end = Date.now() + timeoutMs;
    let lastRoom = null;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error(`isolated server exited; dataDir=${dataDir}`);
      const rooms = await request('/api/rooms');
      lastRoom = rooms.body.rooms?.find(item => item.id === roomId) || null;
      const chain = lastRoom?.replyChain;
      if (chain?.requestId === requestId) {
        diagnostic.latestTurn = safeRoomSummary(lastRoom);
        if (['failed', 'cancelled'].includes(chain.status)) {
          throw new Error(`room turn ended ${chain.status}: ${JSON.stringify(diagnostic.latestTurn)}; dataDir=${dataDir}`);
        }
        if (chain.status === 'completed') return lastRoom;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    diagnostic.latestTurn = safeRoomSummary(lastRoom);
    throw new Error(`room turn did not reach a terminal state within ${timeoutMs}ms: ${JSON.stringify(diagnostic.latestTurn)}; dataDir=${dataDir}`);
  };
  const localPromptFor = async (roomId, requestId, content) => {
    const sent = await request(`/api/rooms/${encodeURIComponent(roomId)}/turns`, 'POST', {
      requestId, content, agentIds: [agent.id]
    });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const room = await waitForRoomTerminal(roomId, requestId);
    const prompt = providerPrompts.find(item => item.includes(requestId));
    diagnostic.latestTurn = { ...safeRoomSummary(room), matchingProviderPrompt: Boolean(prompt), providerPromptCount: providerPrompts.length };
    if (!prompt) throw new Error(`room turn completed without a matching fake-provider prompt: ${JSON.stringify(diagnostic.latestTurn)}; dataDir=${dataDir}`);
    return prompt;
  };
  const browserSource = await readFile(path.join(root, 'public', 'on-device-chat.js'), 'utf8');
  const browserEngineCalls = [];
  const browserContextCalls = [];
  const completeBrowserTurn = async (latestMessage, { useMemories = true } = {}) => {
    const browserAgent = { id: agent.id, name: agent.name, useMemories };
    const window = { HexiGridOnDevice: { complete: async input => {
      browserEngineCalls.push(input);
      return { content: 'Fake browser engine answer.' };
    } } };
    const document = { cookie: `hexigrid_csrf=${encodeURIComponent(cookies.csrf())}` };
    const browserFetch = async (url, options) => {
      const call = { url, options, responseSummary: null, fetchError: '' };
      browserContextCalls.push(call);
      let result;
      try {
        if (options.credentials !== 'same-origin') throw new Error('browser fetch credentials mismatch');
        const expectedCsrf = cookies.csrf();
        const sentCsrf = options.headers['x-hexigrid-csrf'];
        if (expectedCsrf ? sentCsrf !== expectedCsrf : Boolean(sentCsrf)) throw new Error('browser CSRF header mismatch');
        result = await request(url, options.method, JSON.parse(options.body));
      }
      catch (error) { call.fetchError = `${error?.name || 'Error'}: ${error?.message || 'fetch failed'}`; throw error; }
      call.responseSummary = { status: result.status, contextStatus: result.body.memoryContext?.status || '',
        mistakeCount: result.body.memoryContext?.mistakeCount ?? null,
        includesCorrection: String(result.body.memoryContext?.text || '').includes('Check the current ledger date before each answer.'),
        exposesDispatchSelection: Object.hasOwn(result.body.memoryContext || {}, 'dispatchSelection') };
      return { ok: result.status >= 200 && result.status < 300, status: result.status,
        json: async () => result.body };
    };
    vm.runInNewContext(browserSource, { window, document, fetch: browserFetch, Date, JSON, String, Set, Math },
      { filename: 'on-device-chat.js' });
    const result = await window.HexiGridBrowserChat.completeTurn({ agent: browserAgent,
      room: { messages: [{ role: 'user', content: latestMessage }] }, settings: { workMode: 'build' },
      memories: [], modelId: 'fixture-no-download' });
    return { result, engineCall: browserEngineCalls.at(-1), contextCall: browserContextCalls.at(-1) };
  };

  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fakeLocalProvider.closeAllConnections();
    await new Promise(resolve => fakeLocalProvider.close(resolve));
    if (!passed) {
      const diagnosticPath = `${dataDir}.diagnostic.json`;
      const safeDiagnostic = { ...diagnostic,
        serverStderr: redact(serverStderr.join('').slice(-1500)) };
      await writeFile(diagnosticPath, JSON.stringify(safeDiagnostic, null, 2), 'utf8');
      process.stderr.write(`Owner-note warning diagnostics saved to ${diagnosticPath}\n`);
    }
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir());
    const relative = path.relative(tempRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture cleanup stays inside the OS temp directory');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const waitForServer = async () => {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error(`isolated server exited during startup; dataDir=${dataDir}`);
      if ((await fetch(`${origin}/api/bootstrap`).catch(() => null))?.ok) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`isolated server did not start; dataDir=${dataDir}; stderr=${redact(serverStderr.join(''))}`);
  };

  await waitForServer();
  assert.equal((await request('/api/auth/setup', 'POST', { password: 'owner-note-warning-test-passphrase' })).status, 200);
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const provider = await request('/api/providers', 'POST', {
    name: 'Owner-note local fixture', baseUrl: `http://127.0.0.1:${fakeLocalProvider.address().port}/v1`,
    models: 'owner-note-warning-fixture', apiStyle: 'openai-chat'
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  assert.equal(provider.body.provider.local, true);
  assert.equal(provider.body.provider.hasKey, false);
  const model = `provider:${provider.body.provider.id}:owner-note-warning-fixture`;
  const createdAgent = await request('/api/agents', 'POST', {
    name: 'Owner-note warning fixture', transport: 'local-opencode', model, learnFromConversations: false
  });
  assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent.body));
  const agent = createdAgent.body.agent;
  assert.equal(agent.learnFromConversations, false);
  const profileState = await request('/api/agents');
  const localProfile = profileState.body.agents?.find(item => item.id === agent.id);
  assert.ok(localProfile);
  const lineageId = localProfile.continuityLineage?.id;
  assert.match(lineageId || '', /^lineage-[0-9a-f-]{36}$/);
  const foreignProfile = await request('/api/agents', 'POST', {
    name: 'Foreign owner-note control', transport: 'local-opencode', model, learnFromConversations: false
  });
  assert.equal(foreignProfile.status, 201, JSON.stringify(foreignProfile.body));

  const capabilities = ['messages', 'memory-read', 'memory-write', 'tasks'];
  const invite = await request('/api/agent-links/invites', 'POST', { agentId: agent.id, capabilities });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteUrl = new URL(invite.body.invitationUrl);
  const paired = await request('/agent-link/v1/pair', 'POST', {
    inviteId: invite.body.invite.id,
    secret: new URLSearchParams(inviteUrl.hash.slice(1)).get('secret'),
    capabilities,
    identity: { name: 'Owner-note warning fixture Link', framework: 'test', externalId: 'owner-note-warning-fixture' }
  });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  assert.equal(paired.body.agent.id, agent.id);
  assert.equal((await request(`/api/agent-links/${paired.body.connection.id}/trust`, 'PATCH', {
    trustLevel: 'owner', approved: true
  })).status, 200);

  const note = await request(`/api/agents/${encodeURIComponent(agent.id)}/memories`, 'POST', {
    content: 'Use yesterday’s ledger date without checking the current entry.', category: 'Process'
  });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const sourceMarker = 'OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE';
  const source = await signedRequest(paired.body.token, '/agent-link/v1/messages', {
    clientMessageId: `owner-warning-${crypto.randomUUID()}`,
    text: `${sourceMarker}: An earlier process used an outdated ledger date.`
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const captured = await signedRequest(paired.body.token, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 'owner-note-warning-capture', method: 'tools/call',
    params: { name: 'propose-owner-memory-correction', arguments: {
      id: note.body.memory.id, expectedRevision: 0,
      text: 'Check the current ledger date before each answer.',
      why: 'A retained signed response used an outdated process.',
      expectedNextBehavior: 'Compare the date against the active ledger entry before responding.',
      sourceMessageId: source.body.message.id
    } }
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  const captureResult = captured.body.result?.structuredContent;
  assert.equal(captureResult?.captureComplete, true, JSON.stringify(captureResult));
  const ownerMistakeId = captureResult.ownerNoteMistakeId;
  assert.match(ownerMistakeId, /^mistake-[0-9a-f-]{36}$/);

  const readOwnerNote = await signedRequest(paired.body.token, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 'owner-note-warning-read-after-capture', method: 'tools/call',
    params: { name: 'get-owner-note', arguments: { id: note.body.memory.id } }
  });
  assert.equal(readOwnerNote.status, 200, JSON.stringify(readOwnerNote.body));
  assert.equal(readOwnerNote.body.result?.structuredContent?.note?.text,
    'Check the current ledger date before each answer.', 'the signed correction remains a valid owner-memory record');
  const listOwnerNotes = await signedRequest(paired.body.token, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 'owner-note-warning-list-after-capture', method: 'tools/call',
    params: { name: 'list-owner-notes', arguments: { limit: 8, maxBytes: 4096 } }
  });
  assert.equal(listOwnerNotes.status, 200, JSON.stringify(listOwnerNotes.body));
  assert.ok(listOwnerNotes.body.result?.structuredContent?.notes?.some(item => item.id === note.body.memory.id),
    'the owner-note capture can be recalled before adding other memory fixture records');
  const depthZeroRecall = await request(`/api/agents/${encodeURIComponent(agent.id)}/memories`);
  assert.equal(depthZeroRecall.status, 200, JSON.stringify(depthZeroRecall.body));
  const recalledNote = depthZeroRecall.body.memories?.find(item => item.id === note.body.memory.id);
  assert.equal(recalledNote?.content, 'Check the current ledger date before each answer.');
  assert.equal(Object.hasOwn(recalledNote || {}, 'revisions'), false, 'depth-zero recall omits the revision history');
  assert.equal(Object.hasOwn(recalledNote || {}, 'evidence_excerpt'), false, 'depth-zero recall omits private evidence excerpts');
  assert.equal(JSON.stringify(readOwnerNote.body).includes(source.body.message.text), false,
    'Link owner-note reads omit the original signed evidence text');
  const managedNotes = await request(`/api/agents/${encodeURIComponent(agent.id)}/memories?manage=1`);
  assert.equal(managedNotes.status, 200, JSON.stringify(managedNotes.body));
  const revisedNote = managedNotes.body.memories?.find(item => item.id === note.body.memory.id);
  assert.ok(revisedNote);
  assert.equal(revisedNote.revisions?.length, 1);
  assert.equal(revisedNote.revisions[0].source?.text, source.body.message.text,
    'the owner-only audit retains the exact signed evidence');
  assert.doesNotThrow(() => normalizeOwnerMemory(revisedNote), 'the complete corrected note passes its audit chain');
  const tamperedNote = structuredClone(revisedNote);
  tamperedNote.content = 'A silent edit that is not in the owner audit chain.';
  assert.throws(() => normalizeOwnerMemory(tamperedNote), /audit chain is broken/i,
    'tampering with a corrected note still fails audit validation');

  const room = await request('/api/rooms', 'POST', { name: 'Owner-note warning local replies' });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const roomId = room.body.room.id;
  const positivePrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-POSITIVE',
    'OWNER-NOTE-WARNING-POSITIVE: What should I check about the current ledger date?');
  const positivePacket = warningPacket(positivePrompt);
  assert.ok(positivePacket, 'an active local owner-note mistake reaches the local model before inference');
  assert.ok(positivePacket.rows.some(row => row.id === ownerMistakeId &&
    row.correction === 'Check the current ledger date before each answer.'), 'the active owner correction is included');
  assert.equal(positivePacket.rows[0]?.kind, 'past-mistake');
  assert.match(positivePrompt, /Owner-managed memory/,
    'the canonical revised owner note is also rendered into local context');
  assert.doesNotMatch(positivePrompt, /OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE|PRIVATE_TEST_EVIDENCE_EXCERPT_MUST_NOT_REACH_A_PROMPT/);
  assert.ok(Buffer.byteLength(positivePacket.text, 'utf8') <= 4096);

  const ownerNoteScope = { projectId: 'owner-notes', topicId: agent.id };
  const store = new DatedMemoryStore({ root: path.join(dataDir, 'dated-memory') });
  let fixtureTime = Date.now() + 1_000;
  const ledger = createDatedMemoryMistakeLedger({
    store,
    authorize: () => ({ allowed: true }),
    verifyEvidence: async ({ reference }) => ({ verified: true, ...reference,
      excerpt: 'PRIVATE_TEST_EVIDENCE_EXCERPT_MUST_NOT_REACH_A_PROMPT', observedAt: new Date().toISOString() }),
    commit: async ({ entry, assertAuthorized }) => {
      const receipt = await store.append({ ...entry, assertAuthorized });
      return { created: receipt.appended, entry: receipt.entry };
    },
    revise: async ({ lineageId: itemLineageId, memoryId, changes, why, by, expectedRevision, createdAt, assertAuthorized }) =>
      store.appendRevision({ lineageId: itemLineageId, id: memoryId, changes, why, by, expectedRevision, createdAt, assertAuthorized }),
    now: () => new Date(fixtureTime++).toISOString()
  });
  const seedMistake = async ({ tag, agentId = agent.id, sourceLineageId = lineageId,
    contextScope = ownerNoteScope, long = false }) => {
    const text = part => long ? `${tag} ${part} ${part.repeat(520)}`.slice(0, 512) : `${tag} archive record owner correction`;
    const result = await ledger.record({
      whatWentWrong: text('wrong'), correction: text('correct'), resultingFix: text('fix'),
      evidence: { kind: 'owner-feedback', id: `owner-warning-evidence-${tag}` },
      idempotencyKey: `owner-warning-fixture-${tag}`
    }, { agentId, lineageId: sourceLineageId, contextScope, author: { kind: 'owner', id: 'owner-warning-fixture' } });
    return result.id;
  };
  const foreignMistakeId = await seedMistake({ tag: 'XYLOPHONE_GALAXY_FOREIGN_PROFILE', agentId: foreignProfile.body.agent.id });
  const oldLineageMistakeId = await seedMistake({ tag: 'XYLOPHONE_GALAXY_OLD_LINEAGE', sourceLineageId: `lineage-${crypto.randomUUID()}` });
  const rejectedMistakeId = await seedMistake({ tag: 'XYLOPHONE_GALAXY_REJECTED' });
  const rejected = await ledger.reject({ id: rejectedMistakeId, expectedRevision: 0, why: 'Rejected negative-control fixture.' }, {
    agentId: agent.id, lineageId, contextScope: ownerNoteScope, author: { kind: 'owner', id: 'owner-warning-fixture' }
  });
  assert.equal(rejected.rejected, true);
  const wrongScopeMistakeId = await seedMistake({ tag: 'XYLOPHONE_GALAXY_WRONG_SCOPE',
    contextScope: { projectId: 'owner-notes', topicId: `${agent.id}-neighbor` } });
  for (let index = 0; index < 4; index += 1) await seedMistake({ tag: `CATERPILLAR_BOUND_COUNT_${index}` });
  for (let index = 0; index < 3; index += 1) await seedMistake({ tag: `THUNDERSTONE_BOUND_BYTES_${index}`, long: true });

  const negativePrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-NEGATIVE',
    'OWNER-NOTE-WARNING-NEGATIVE: Review the xylophone galaxy archive record.');
  const negativeRows = warningPacket(negativePrompt)?.rows ?? [];
  const forbiddenIds = new Set([foreignMistakeId, oldLineageMistakeId, rejectedMistakeId, wrongScopeMistakeId]);
  assert.ok(negativeRows.every(row => !forbiddenIds.has(row.id)),
    'foreign-profile, older-lineage, rejected, and wrong-topic mistakes never become local warnings');
  assert.doesNotMatch(negativePrompt, /XYLOPHONE_GALAXY_(?:FOREIGN_PROFILE|OLD_LINEAGE|REJECTED|WRONG_SCOPE)/);

  const countPrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-COUNT',
    'OWNER-NOTE-WARNING-COUNT: Which CATERPILLAR correction matters?');
  const countPacket = warningPacket(countPrompt);
  if (countPacket) {
    assert.ok(countPacket.rows.length <= 3, 'local warning injection caps mistakes at three');
    assert.ok(countPacket.rows.every(row => row.kind === 'past-mistake'));
    assert.ok(Buffer.byteLength(countPacket.text, 'utf8') <= 4096);
  }

  const bytePrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-BYTES',
    'OWNER-NOTE-WARNING-BYTES: Which THUNDERSTONE correction matters?');
  const bytePacket = warningPacket(bytePrompt);
  if (bytePacket) {
    assert.ok(bytePacket.rows.length <= 3);
    assert.ok(bytePacket.rows.every(row => row.kind === 'past-mistake'));
    assert.ok(Buffer.byteLength(bytePacket.text, 'utf8') <= 4096, 'the whole warning section stays within 4096 bytes');
  }

  const positiveOwnerContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'OWNER-POST-WARNING-POSITIVE: What should I check about the current ledger date?'
  });
  assert.equal(positiveOwnerContext.status, 200, JSON.stringify(positiveOwnerContext.body));
  const ownerContext = positiveOwnerContext.body.memoryContext;
  const ownerContextPacket = warningPacket(ownerContext?.text);
  assert.ok(ownerContextPacket, 'the authenticated owner turn-context response includes the active correction');
  assert.ok(ownerContextPacket.rows.some(row => row.id === ownerMistakeId &&
    row.correction === 'Check the current ledger date before each answer.'));
  assert.equal(ownerContext.mistakeCount, ownerContextPacket.rows.length);
  assert.ok(ownerContextPacket.rows.length <= 3);
  assert.ok(Buffer.byteLength(ownerContextPacket.text, 'utf8') <= 4096);
  assert.doesNotMatch(ownerContext.text, /OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE|PRIVATE_TEST_EVIDENCE_EXCERPT_MUST_NOT_REACH_A_PROMPT/,
    'owner turn context never returns retained signed or verifier-only evidence');
  assert.equal(Object.hasOwn(ownerContext, 'dispatchSelection'), false,
    'internal dispatch authority is omitted from the owner HTTP projection');
  assert.equal(JSON.stringify(positiveOwnerContext.body).includes('dispatchSelection'), false);

  const foreignContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'XYLOPHONE_GALAXY_FOREIGN_PROFILE XYLOPHONE_GALAXY_OLD_LINEAGE XYLOPHONE_GALAXY_REJECTED XYLOPHONE_GALAXY_WRONG_SCOPE'
  });
  assert.equal(foreignContext.status, 200, JSON.stringify(foreignContext.body));
  const foreignPacket = warningPacket(foreignContext.body.memoryContext?.text);
  const ownerContextForbiddenIds = new Set([foreignMistakeId, oldLineageMistakeId, rejectedMistakeId, wrongScopeMistakeId]);
  assert.ok((foreignPacket?.rows || []).every(row => !ownerContextForbiddenIds.has(row.id)),
    'the owner POST excludes foreign-profile, prior-lineage, rejected, and wrong-topic warnings');
  assert.doesNotMatch(foreignContext.body.memoryContext?.text || '',
    /XYLOPHONE_GALAXY_(?:FOREIGN_PROFILE|OLD_LINEAGE|REJECTED|WRONG_SCOPE)/);

  const countContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'OWNER-POST-WARNING-COUNT: Which CATERPILLAR correction matters?'
  });
  assert.equal(countContext.status, 200, JSON.stringify(countContext.body));
  const countContextPacket = warningPacket(countContext.body.memoryContext?.text);
  assert.ok(countContextPacket, 'the local query retrieves current CATERPILLAR correction warnings');
  assert.ok(countContextPacket.rows.length <= 3);
  assert.ok(countContextPacket.rows.every(row => row.kind === 'past-mistake'));
  assert.ok(Buffer.byteLength(countContextPacket.text, 'utf8') <= 4096);

  const browserTurn = await completeBrowserTurn(
    'OWNER-POST-WARNING-POSITIVE: What should I check about the current ledger date?');
  assert.equal(browserTurn.result.content, 'Fake browser engine answer.');
  assert.equal(browserTurn.contextCall.options.method, 'POST');
  assert.match(browserTurn.contextCall.url, /\/api\/agents\/[^/]+\/memory-turn-context$/);
  assert.equal(browserTurn.contextCall.fetchError, '');
  assert.equal(browserTurn.contextCall.responseSummary.status, 200, JSON.stringify(browserTurn.contextCall.responseSummary));
  assert.equal(browserTurn.contextCall.responseSummary.includesCorrection, true,
    JSON.stringify(browserTurn.contextCall.responseSummary));
  assert.equal(browserTurn.contextCall.responseSummary.exposesDispatchSelection, false);
  assert.match(browserTurn.engineCall.messages[0].content,
    /Check the current ledger date before each answer\./,
    'the actual browser completeTurn includes owner context before calling the fake engine');
  assert.doesNotMatch(browserTurn.engineCall.messages[0].content,
    /OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE|PRIVATE_TEST_EVIDENCE_EXCERPT_MUST_NOT_REACH_A_PROMPT/);
  assert.match(browserTurn.engineCall.modelId, /fixture-no-download/);

  assert.equal((await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { useMemories: false })).status, 200);
  const optedOutOwnerContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'OWNER-POST-WARNING-OPT-OUT: What should I check about the ledger date?'
  });
  assert.equal(optedOutOwnerContext.status, 200, JSON.stringify(optedOutOwnerContext.body));
  assert.equal(optedOutOwnerContext.body.memoryContext?.status, 'disabled');
  assert.equal(optedOutOwnerContext.body.memoryContext?.text, '');
  assert.equal(Object.hasOwn(optedOutOwnerContext.body.memoryContext || {}, 'dispatchSelection'), false);
  const optedOutPrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-OPT-OUT',
    'OWNER-NOTE-WARNING-OPT-OUT: What should I check about the ledger date?');
  assert.equal(warningPacket(optedOutPrompt), null, 'useMemories=false suppresses owner-note warnings');
  assert.doesNotMatch(optedOutPrompt, /Check the current ledger date before each answer\./);
  assert.equal((await request(`/api/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { useMemories: true })).status, 200);

  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'converse', approvalPolicy: 'full' })).status, 200);
  const readDeniedOwnerContext = await request(`/api/agents/${encodeURIComponent(agent.id)}/memory-turn-context`, 'POST', {
    latestMessage: 'OWNER-POST-WARNING-READ-DENIED: What should I check about the ledger date?'
  });
  assert.ok([403, 409].includes(readDeniedOwnerContext.status), JSON.stringify(readDeniedOwnerContext.body));
  const readDeniedPrompt = await localPromptFor(roomId, 'OWNER-NOTE-WARNING-READ-DENIED',
    'OWNER-NOTE-WARNING-READ-DENIED: What should I check about the ledger date?');
  assert.equal(warningPacket(readDeniedPrompt), null, 'read_local denial suppresses owner-note warnings');
  assert.doesNotMatch(readDeniedPrompt, /Check the current ledger date before each answer\./);
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);

  const selectedScope = { projectId: 'owner-warning-signed-scope', topicId: 'archive' };
  const memoryProposal = await signedRequest(paired.body.token, '/agent-link/v1/memory-mcp', {
    jsonrpc: '2.0', id: 'owner-warning-scope-seed', method: 'tools/call',
    params: { name: 'propose-memory', arguments: { text: 'Calibration entry for region 1.', contextScope: selectedScope } }
  });
  assert.equal(memoryProposal.status, 200, JSON.stringify(memoryProposal.body));
  const proposalId = memoryProposal.body.result?.structuredContent?.proposalId;
  assert.ok(proposalId);
  assert.equal((await request(`/api/memory-proposals/${proposalId}/decision`, 'POST', { decision: 'approve' })).status, 200);
  assert.equal((await signedRequest(paired.body.token, '/agent-link/v1/memory-scope', { scope: selectedScope })).status, 200);
  const taskCreated = await signedRequest(paired.body.token, '/agent-link/v1/tasks', {
    operation: 'create', name: 'Selected scope owner-note isolation',
    prompt: 'SIGNED-OWNER-NOTE-SCOPE-ISOLATION: What is the calibration entry for region 1 in the archive?',
    intervalSeconds: 0, maxRuns: 1, maxRetries: 0
  });
  assert.equal(taskCreated.status, 201, JSON.stringify(taskCreated.body));
  const taskRun = await signedRequest(paired.body.token, '/agent-link/v1/tasks', { operation: 'run', taskId: taskCreated.body.task.id });
  assert.equal(taskRun.status, 200, JSON.stringify(taskRun.body));
  assert.equal(taskRun.body.run.status, 'completed');
  const signedPrompt = await new Promise((resolve, reject) => {
    const end = Date.now() + 5_000;
    const poll = () => {
      const prompt = providerPrompts.find(item => item.includes('SIGNED-OWNER-NOTE-SCOPE-ISOLATION'));
      if (prompt) return resolve(prompt);
      if (Date.now() >= end) return reject(new Error(`signed task did not reach the local fake provider; providerPromptCount=${providerPrompts.length}; dataDir=${dataDir}`));
      setTimeout(poll, 50);
    };
    poll();
  });
  assert.match(signedPrompt, /Calibration entry for region 1\./);
  assert.doesNotMatch(signedPrompt, /RELEVANT PAST MISTAKES|Check the current ledger date before each answer\.|OWNER_WARNING_PRIVATE_EVIDENCE_SOURCE/,
    'the signed selected Link scope does not inherit local owner-note warnings');

  passed = true;
});
