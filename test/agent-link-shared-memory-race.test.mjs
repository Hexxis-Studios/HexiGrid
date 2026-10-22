import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { commitMemoryCorrection } from '../lib/memory-correction-service.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { grantMemoryShare, revokeMemoryShare } from '../lib/memory-sharing.mjs';

const createdAt = '2026-10-01T12:00:00.000Z';
const correctedAt = '2026-10-01T13:00:00.000Z';
const rejectedAt = '2026-10-01T14:00:00.000Z';
const scope = { projectId: 'shared-race-project', topicId: 'routing' };
const privateEvidence = 'PRIVATE_SHARED_EVIDENCE: owner retained this source text.';
const pathname = '/agent-link/v1/shared-memory';

function deferredGate() {
  let markStarted;
  let release;
  let entered = false;
  const gate = { started: new Promise(resolve => { markStarted = resolve; }),
    wait: new Promise(resolve => { release = resolve; }),
    enter() { if (!entered) { entered = true; markStarted(); } return gate.wait; },
    release() { release(); } };
  return gate;
}

async function appendFact(store, { lineageId, agentId, text, contextScope = scope } = {}) {
  return store.append({ lineageId, agentId, date: createdAt.slice(0, 10), createdAt,
    id: `memory-${crypto.randomUUID()}`, text, contextScope, originKind: 'owner-entry', importance: 0.95 });
}

async function correctFact(store, { lineageId, agentId, factId, replacement, evidenceText = privateEvidence,
  expectedNextBehavior = 'Check the verified route before answering.' } = {}) {
  return commitMemoryCorrection({ store,
    authority: { agentId, lineageId, author: { kind: 'owner', id: 'owner-shared-race' } },
    assertAuthorized() {},
    request: { lineageId, id: factId, expectedRevision: 0, createdAt: correctedAt,
      changes: { text: replacement }, why: 'The retained source verified the current route.',
      source: { kind: 'owner-feedback', text: evidenceText }, by: 'owner:owner-shared-race', expectedNextBehavior }
  });
}

async function makeFixture({ boundary = null, withPrivacyCases = false } = {}, t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-shared-memory-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DatedMemoryStore({ root });
  const sourceLineageId = `lineage-${crypto.randomUUID()}`;
  const targetLineageId = `lineage-${crypto.randomUUID()}`;
  const source = { id: `source-${crypto.randomUUID()}`, name: 'Synthetic source',
    continuityLineage: { id: sourceLineageId, activityState: 'active' } };
  source.continuityLineage.activeAgentId = source.id;
  const target = { id: `target-${crypto.randomUUID()}`, name: 'Synthetic recipient',
    continuityLineage: { id: targetLineageId, activityState: 'active' } };
  target.continuityLineage.activeAgentId = target.id;
  const state = { settings: { workMode: 'build', approvalPolicy: 'full' }, agents: [source, target],
    agentLinks: [], receipts: [], memoryShares: [] };

  const current = await appendFact(store, { lineageId: sourceLineageId, agentId: source.id,
    text: 'SHARED_CURRENT_FACT: the verified greenhouse route uses the west entrance.' });
  const corrected = await correctFact(store, { lineageId: sourceLineageId, agentId: source.id,
    factId: current.entry.id, replacement: 'SHARED_CURRENT_FACT: use the verified west greenhouse entrance.' });

  if (withPrivacyCases) {
    const rejected = await appendFact(store, { lineageId: sourceLineageId, agentId: source.id,
      text: 'REJECTED_PRIVATE_MISTAKE: this route was rejected by the owner.' });
    const rejectedCorrection = await correctFact(store, { lineageId: sourceLineageId, agentId: source.id,
      factId: rejected.entry.id, replacement: 'REJECTED_CURRENT_FACT: this rejected route is not current.',
      evidenceText: 'PRIVATE_REJECTED_EVIDENCE: this must not be shared.' });
    const rejectedMistakeId = `memory-${rejectedCorrection.mistakeId.slice('mistake-'.length)}`;
    await store.appendRevision({ lineageId: sourceLineageId, id: rejectedMistakeId,
      changes: { status: 'rejected' }, why: 'Owner rejected this mistake record.', by: 'owner:owner-shared-race',
      expectedRevision: 0, createdAt: rejectedAt });
    await store.appendRevision({ lineageId: sourceLineageId, id: rejected.entry.id,
      changes: { status: 'rejected' }, why: 'Owner rejected the associated current fact.', by: 'owner:owner-shared-race',
      expectedRevision: 1, createdAt: rejectedAt });
    assert.ok(rejectedCorrection.mistakeId);

    const unrelated = await appendFact(store, { lineageId: sourceLineageId, agentId: source.id,
      contextScope: { projectId: scope.projectId, topicId: 'private-topic' },
      text: 'UNRELATED_PRIVATE_MISTAKE: a different topic must remain outside the share.' });
    const unrelatedCorrection = await correctFact(store, { lineageId: sourceLineageId, agentId: source.id,
      factId: unrelated.entry.id, replacement: 'UNRELATED_CURRENT_FACT: a different topic stays private.',
      evidenceText: 'PRIVATE_UNRELATED_EVIDENCE: this must not be shared.' });
    assert.ok(unrelatedCorrection.mistakeId);
  }

  const invitation = createAgentLinkInvite(state, { agentId: target.id, baseUrl: 'http://127.0.0.1',
    requestedCapabilities: ['memory-read'] });
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id,
    secret: decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length)),
    identity: { name: 'Synthetic shared-memory peer', framework: 'test', externalId: crypto.randomUUID() },
    capabilities: ['memory-read'], clientDeviceId: crypto.randomUUID() });
  const connection = state.agentLinks.find(item => item.id === paired.connection.id);
  const granted = grantMemoryShare(state.memoryShares, { sourceAgentId: source.id, sourceLineageId,
    targetAgentId: target.id, targetLineageId, targetLinkId: connection.id, scope,
    by: 'owner:owner-shared-race', at: createdAt });

  const gate = deferredGate();
  const listCalls = [];
  const listMemoryMistakes = store.listMemoryMistakes.bind(store);
  store.listMemoryMistakes = async options => {
    listCalls.push(JSON.parse(JSON.stringify(options)));
    const entries = await listMemoryMistakes(options);
    if (boundary === 'retrieval') await gate.enter();
    return entries;
  };
  const rag = { semanticSearch: async () => [], scoreCandidates: async () => new Map() };
  let policyBlocked = false;
  let response;
  const ctx = { state, pathname, method: 'POST', readBody: async () => ({ operation: 'recall',
      shareId: granted.share.id, maxBytes: 8192 }),
    findAgent: id => state.agents.find(agent => agent.id === id),
    assertAgentActivity(agent) {
      if (agent.continuityLineage?.activityState !== 'active' || agent.continuityLineage.activeAgentId !== agent.id) {
        throw Object.assign(new Error('This continuity lineage is not active.'), { status: 403 });
      }
    },
    connectorPolicy: () => policyBlocked ? { denied: false, error: 'Current policy requires a new approval.' } : null,
    datedMemoryStore: store, localMemoryRag: rag,
    createMemoryMcpHandler: options => createMemoryMcpHandler(options),
    addReceipt(receipt) { const saved = { id: `receipt-${state.receipts.length + 1}`, ...receipt }; state.receipts.push(saved); return saved; },
    async saveState() { if (boundary === 'receipt') await gate.enter(); },
    cleanString(value, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; },
    now: () => createdAt,
    json(_res, status, body) { response = { status, body }; }
  };
  const body = { operation: 'recall', shareId: granted.share.id, maxBytes: 8192 };
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const req = { socket: {}, headers: { authorization: `Bearer ${paired.token}`,
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname, timestamp, nonce, body }) } };
  const pending = handleAgentLinkRequest(req, {}, ctx);
  return { state, source, target, connectionId: connection.id, get connection() {
      return state.agentLinks.find(item => item.id === connection.id);
    }, share: granted.share, gate, listCalls, corrected,
    get response() { return response; }, get policyBlocked() { return policyBlocked; },
    set policyBlocked(value) { policyBlocked = value; }, pending };
}

function revokeFixtureAuthority(fixture, kind) {
  if (kind === 'share') revokeMemoryShare(fixture.state.memoryShares, fixture.share.id, correctedAt);
  else if (kind === 'readGrant') fixture.connection.capabilities = fixture.connection.capabilities.filter(capability => capability !== 'memory-read');
  else if (kind === 'token') fixture.connection.tokenHash = 'replacement-token-hash';
  else if (kind === 'policy') fixture.policyBlocked = true;
  else if (kind === 'sourceActivity') fixture.source.continuityLineage.activityState = 'historical';
  else if (kind === 'targetActivity') fixture.target.continuityLineage.activityState = 'historical';
}

const revocations = ['share', 'readGrant', 'token', 'policy', 'sourceActivity', 'targetActivity'];

test('real signed shared-memory recall returns scoped mistake warnings and withholds both packets after revocation races',
  { timeout: 20000 }, async t => {
    await t.test('successful route includes bounded scoped warnings and excludes private evidence', async t => {
      const fixture = await makeFixture({ withPrivacyCases: true }, t);
      await fixture.pending;
      assert.equal(fixture.response.status, 200, JSON.stringify(fixture.response));
      assert.equal(fixture.listCalls.length, 1);
      assert.deepEqual(fixture.listCalls[0], { lineageId: fixture.source.continuityLineage.id,
        agentId: fixture.source.id, contextScope: scope, limit: 50, depth: 2 });
      const context = fixture.response.body.context;
      assert.ok(context.memories.some(memory => memory.text.includes('SHARED_CURRENT_FACT')));
      assert.doesNotMatch(JSON.stringify(context), /REJECTED_PRIVATE_MISTAKE|REJECTED_CURRENT_FACT|UNRELATED_PRIVATE_MISTAKE|UNRELATED_CURRENT_FACT/);
      assert.deepEqual(Object.keys(context.mistakeWarnings).sort(), ['dataOnly', 'format', 'omittedCount', 'status', 'warnings']);
      assert.equal(context.mistakeWarnings.status, 'ready');
      assert.equal(context.mistakeWarnings.format, 'hexigrid-memory-mistake-warnings');
      assert.equal(context.mistakeWarnings.dataOnly, true);
      assert.equal(context.mistakeWarnings.omittedCount, 0);
      assert.deepEqual(context.mistakeWarnings.warnings.map(warning => warning.id), [fixture.corrected.mistakeId]);
      assert.equal(context.mistakeWarnings.warnings[0].dataOnly, true);
      assert.equal(JSON.stringify(fixture.response.body).includes(privateEvidence), false);
      assert.equal(JSON.stringify(fixture.response.body).includes('PRIVATE_REJECTED_EVIDENCE'), false);
      assert.equal(JSON.stringify(fixture.response.body).includes('PRIVATE_UNRELATED_EVIDENCE'), false);
    });

    for (const boundary of ['retrieval', 'receipt']) {
      for (const kind of revocations) {
        await t.test(`${boundary} is withheld after ${kind} changes`, async t => {
          const fixture = await makeFixture({ boundary }, t);
          await fixture.gate.started;
          revokeFixtureAuthority(fixture, kind);
          fixture.gate.release();
          await fixture.pending;
          const expectedStatus = kind === 'policy' ? 409 : 403;
          assert.equal(fixture.response.status, expectedStatus, JSON.stringify(fixture.response));
          assert.doesNotMatch(JSON.stringify(fixture.response.body), /SHARED_CURRENT_FACT|mistakeWarnings|PRIVATE_SHARED_EVIDENCE/);
          if (boundary === 'retrieval') assert.equal(fixture.state.receipts.length, 0,
            'revocation during record retrieval prevents the shared-read receipt');
          else assert.equal(fixture.state.receipts.length, 1,
            'a prepared read keeps its private-text-free receipt when final delivery is withheld');
        });
      }
    }
  });
