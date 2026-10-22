import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { commitMemoryCorrection } from '../lib/memory-correction-service.mjs';
import { createMemoryMistakeReader } from '../lib/memory-mistake-reader.mjs';
import { handleAgentLinkRequest, signedMemoryMistakeReadGuard } from '../lib/agent-link-routes.mjs';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { createOwnerMemory } from '../lib/owner-memory.mjs';
import { prepareOwnerMemoryCorrection } from '../lib/owner-memory-correction-service.mjs';
import crypto from 'node:crypto';

const lineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agentId = 'agent-read-race';

test('signed typed mistake reads withhold private data when authority changes during real store retrieval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mistake-read-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DatedMemoryStore({ root });
  const fact = await store.append({ lineageId, agentId, createdAt: '2026-10-01T12:00:00.000Z', text: 'Old synthetic route.', contextScope: { projectId: 'qa-route' } });
  const receipt = await commitMemoryCorrection({ store,
    authority: { agentId, lineageId, author: { kind: 'owner', id: 'owner-qa' } }, assertAuthorized() {},
    request: { lineageId, id: fact.entry.id, expectedRevision: 0, createdAt: '2026-10-02T12:00:00.000Z', changes: { text: 'Correct synthetic route.' },
      why: 'Retained inspection.', source: { kind: 'owner-feedback', text: 'PRIVATE-RACE-EVIDENCE: verified synthetic correction.' },
      by: 'owner:owner-qa', expectedNextBehavior: 'Verify the current route.' } });
  const mutations = {
    grant: ({ connection }) => { connection.capabilities = []; },
    token: ({ connection }) => { connection.tokenHash = 'replacement-credential'; },
    link: ({ connection }) => { connection.status = 'revoked'; },
    lineage: ({ agent }) => { agent.continuityLineage.activityState = 'historical'; },
    activeOwner: ({ agent }) => { agent.continuityLineage.activeAgentId = 'another-agent'; },
    policy: fixture => { fixture.policyDenied = true; },
    replacement: ({ state, agent }) => { state.agents = [{ ...agent }]; },
    duplicate: ({ state, agent }) => { state.agents.push({ ...agent, id: 'duplicate-active-agent' }); }
  };
  for (const method of ['list', 'get']) for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(`${method}: ${name}`, async () => {
      const agent = { id: agentId, continuityLineage: { id: lineageId, activeAgentId: agentId, activityState: 'active' } };
      const connection = { id: 'link-race', tokenHash: 'initial-credential', agentId, status: 'connected', capabilities: ['memory-read'] };
      const fixture = { agent, connection, state: { agents: [agent], agentLinks: [connection] }, policyDenied: false };
      const ctx = { state: fixture.state, findAgent: id => fixture.state.agents.find(item => item.id === id),
        connectorPolicy: () => fixture.policyDenied ? { denied: true } : null, assertAgentActivity() {} };
      let entered;
      const enteredGate = new Promise(resolve => { entered = resolve; });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const heldStore = { async listMemoryMistakes(options) { const result = await store.listMemoryMistakes(options); entered(); await gate; return result; },
        async getById(options) { const result = await store.getById(options); entered(); await gate; return result; } };
      const reader = createMemoryMistakeReader({ store: heldStore, agentId, lineageId,
        authorize: signedMemoryMistakeReadGuard(ctx, connection, agent, lineageId) });
      const reading = method === 'list' ? reader.list({ projectId: 'qa-route', limit: 10 })
        : reader.get({ projectId: 'qa-route', id: receipt.mistakeId, depth: 2 });
      await enteredGate;
      mutate(fixture);
      release();
      await assert.rejects(reading, /authority|policy/i, 'no facts, evidence, or warning packet may leave the revoked read');
    });
  }
});

test('typed signed route rechecks access after its awaited receipt save before delivering a prepared packet', async () => {
  const agent = { id: agentId, name: 'Synthetic reader', continuityLineage: { id: lineageId, activeAgentId: agentId, activityState: 'active' } };
  const state = { settings: { workMode: 'build', approvalPolicy: 'full' }, agents: [agent], agentLinks: [], receipts: [] };
  const invitation = createAgentLinkInvite(state, { agentId, baseUrl: 'http://127.0.0.1', requestedCapabilities: ['memory-read'] });
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id,
    secret: decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length)),
    identity: { name: 'Synthetic reader', framework: 'test', externalId: crypto.randomUUID() },
    capabilities: ['memory-read'], clientDeviceId: crypto.randomUUID() });
  const connection = state.agentLinks.find(link => link.id === paired.connection.id);
  const body = { jsonrpc: '2.0', id: 172, method: 'tools/call', params: { name: 'list-memory-mistakes', arguments: { projectId: 'qa-route' } } };
  const pathname = '/agent-link/v1/memory-mcp';
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  let delivered;
  const ctx = { state, method: 'POST', pathname, readBody: async () => body,
    findAgent: id => state.agents.find(item => item.id === id), connectorPolicy: () => null, assertAgentActivity() {},
    datedMemoryStore: { async getById() {}, async listMemoryMistakes() { return []; } },
    createMemoryMcpHandler: () => async () => ({ jsonrpc: '2.0', id: 172, result: { structuredContent: { text: 'PRIVATE-PREPARED-MISTAKE' } } }),
    addReceipt: receipt => state.receipts.push(receipt),
    async saveState() { if (state.receipts.some(receipt => receipt.action === 'memory:list-memory-mistakes')) state.agentLinks.find(link => link.id === connection.id).capabilities = []; },
    json(_res, status, result) { delivered = { status, result }; } };
  await handleAgentLinkRequest({ headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json',
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname, timestamp, nonce, body }) }, socket: {} }, {}, ctx);
  assert.equal(delivered.status, 403, JSON.stringify(delivered));
  assert.doesNotMatch(JSON.stringify(delivered), /PRIVATE-PREPARED-MISTAKE/);
  assert.equal(state.receipts.length, 1, 'the successful read receipt is retained even when delivery is withheld');
});

function captureRetryRouteFixture(mutateAfterReceipt = () => {}) {
  const agent = { id: agentId, name: 'Synthetic owner-note reader', continuityLineage: {
    id: lineageId, activeAgentId: agentId, activityState: 'active' } };
  const state = { settings: { workMode: 'build', approvalPolicy: 'full' }, agents: [agent], agentLinks: [],
    memoryProposals: [], memories: [], receipts: [] };
  const invitation = createAgentLinkInvite(state, { agentId, baseUrl: 'http://127.0.0.1', requestedCapabilities: ['memory-read'] });
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id,
    secret: decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length)),
    identity: { name: agent.name, framework: 'test', externalId: crypto.randomUUID() },
    capabilities: ['memory-read'], clientDeviceId: crypto.randomUUID() });
  const connection = state.agentLinks.find(link => link.id === paired.connection.id);
  connection.trustLevel = 'owner';

  const now = new Date().toISOString();
  const note = createOwnerMemory({ content: 'PRIVATE-RETRY-ORIGINAL-NOTE: check the old route.' }, { agentId, at: now });
  const source = { kind: 'agent-link-message', id: 'link-message-capture-00000001', linkId: connection.id,
    text: 'PRIVATE-RETRY-SOURCE: the old route returned an incorrect result.', createdAt: now };
  const request = { expectedRevision: 0, text: 'PRIVATE-RETRY-CORRECTION: check the current route.',
    why: 'PRIVATE-RETRY-INTENT: the earlier route is stale.', expectedNextBehavior: 'Verify the current route before answering.',
    source, createdAt: now };
  const prepared = prepareOwnerMemoryCorrection({ current: note, request,
    authority: { agentId, lineageId, author: { kind: 'owner', id: 'owner-route-test' } }, assertAuthorized: () => true });
  const proposal = { id: 'memory-proposal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'owner-memory-correction',
    agentId, lineageId, linkId: connection.id, status: 'approved', createdAt: now,
    payload: { memoryId: note.id, expectedRevision: 0, text: request.text, why: request.why,
      expectedNextBehavior: request.expectedNextBehavior, source }, ownerNoteCaptureState: 'pending',
    ownerNoteCaptureIntent: prepared.captureIntent };
  state.memoryProposals.push(proposal);
  state.memories.push(prepared.revisedNote);

  const fixture = { state, agent, connection, proposal, policyDenied: false, delivered: null };
  const ctx = { state, method: 'POST', pathname: '/agent-link/v1/memory-mcp', readBody: async () => ({
    jsonrpc: '2.0', id: 172, method: 'tools/call', params: { name: 'list-owner-note-capture-retries', arguments: {} }
  }), findAgent: id => state.agents.find(item => item.id === id),
  connectorPolicy: () => fixture.policyDenied ? { denied: true, error: 'Synthetic current read policy denial.' } : null,
  assertAgentActivity() {},
  datedMemoryStore: { async listMemoryMistakes() { return []; }, async recall() { return []; }, async getById() { return null; },
    async listContext() { return []; }, async listContextScopes() { return []; } },
  localMemoryRag: { async semanticSearch() { return []; } },
  createMemoryMcpHandler: options => createMemoryMcpHandler(options),
  addReceipt: receipt => state.receipts.push(receipt),
  async saveState() { if (state.receipts.some(receipt => receipt.action === 'memory:list-owner-note-capture-retries')) {
    fixture.connection = state.agentLinks.find(link => link.id === connection.id);
    mutateAfterReceipt(fixture, ctx);
  } },
  json(_res, status, result) { fixture.delivered = { status, result }; } };
  fixture.ctx = ctx;
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  fixture.req = { headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json',
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname: ctx.pathname, timestamp, nonce,
      body: { jsonrpc: '2.0', id: 172, method: 'tools/call', params: { name: 'list-owner-note-capture-retries', arguments: {} } } }) }, socket: {} };
  fixture.token = paired.token;
  return fixture;
}

test('capture retry discovery withholds its prepared page after authority changes during the receipt save', async t => {
  const baseline = captureRetryRouteFixture();
  await handleAgentLinkRequest(baseline.req, {}, baseline.ctx);
  assert.equal(baseline.delivered.status, 200, JSON.stringify(baseline.delivered));
  assert.deepEqual(baseline.delivered.result.result.structuredContent.captures, [{ proposalId: baseline.proposal.id,
    captureState: 'pending', noteId: baseline.proposal.payload.memoryId, noteRevision: 1 }]);
  assert.deepEqual(baseline.delivered.result.result.content, []);
  assert.doesNotMatch(JSON.stringify(baseline.delivered), /PRIVATE-RETRY-(?:ORIGINAL-NOTE|SOURCE|CORRECTION|INTENT)|captureIntent|intentDigest|tokenHash/);

  const mutations = {
    credential: ({ connection }) => { connection.tokenHash = 'replacement-capture-retry-credential'; },
    trust: ({ connection }) => { connection.trustLevel = 'scoped'; },
    readGrant: ({ connection }) => { connection.capabilities = []; },
    policy: fixture => { fixture.policyDenied = true; },
    lineage: ({ agent }) => { agent.continuityLineage.activityState = 'historical'; },
    stateReplacement: (fixture, ctx) => { ctx.state = { ...fixture.state }; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const fixture = captureRetryRouteFixture(mutate);
      await handleAgentLinkRequest(fixture.req, {}, fixture.ctx);
      assert.equal(fixture.delivered.status, 403, JSON.stringify(fixture.delivered));
      assert.doesNotMatch(JSON.stringify(fixture.delivered), /PRIVATE-RETRY-(?:ORIGINAL-NOTE|SOURCE|CORRECTION|INTENT)|captureIntent|intentDigest|tokenHash/);
      assert.equal(fixture.state.receipts.length, 1, 'the content-free receipt remains saved after delivery is withheld');
      assert.equal(fixture.state.receipts[0].action, 'memory:list-owner-note-capture-retries');
      assert.doesNotMatch(JSON.stringify(fixture.state.receipts[0]), /PRIVATE-RETRY|intent|hash|token/i);
    });
  }
});
