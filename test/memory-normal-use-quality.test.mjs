import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';
import { commitMemoryCorrection } from '../lib/memory-correction-service.mjs';
import { createMemoryProposalService } from '../lib/memory-proposal-service.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { grantMemoryShare } from '../lib/memory-sharing.mjs';

const sourceLineage = 'lineage-11111111-1111-4111-8111-111111111111';
const targetLineage = 'lineage-22222222-2222-4222-8222-222222222222';
const sourceAgent = 'agent-normal-use-source';
const targetAgent = 'agent-normal-use-target';
const relay = { projectId: 'atlas-ops', topicId: 'relay' };
const date = '2026-10-01T12:00:00.000Z';
const relayId = 'memory-33333333-3333-4333-8333-333333333333';
const oldFact = 'Atlas Ops relay maintenance code is 9307; use the north door.';
const currentFact = 'Atlas Ops relay maintenance code is 3914; use the west door.';
const evidenceText = 'The signed owner inspection confirms code 3914 and the west door.';
const condition = 'Only while the local tunnel is active.';
const unsupported = 'Atlas Ops relay has a hidden emergency tunnel under the north stairs.';

test('normal-use relevance, correction, and explicit shared recall stay within synthetic scopes', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.memory-normal-use-quality-'));
  let runtimeCalls = 0;
  const store = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const rag = new LocalMemoryRag({ root: path.join(root, 'index'), store,
    runtimeFactory: async () => { runtimeCalls += 1; throw new Error('Inference is disabled in this fixture.'); } });

  try {
    await store.append({ id: relayId, lineageId: sourceLineage, agentId: sourceAgent, createdAt: date,
      text: oldFact, status: 'conditional', valid_while: condition, contextScope: relay });
    await store.append({ id: 'memory-44444444-4444-4444-8444-444444444444', lineageId: sourceLineage,
      agentId: sourceAgent, createdAt: date, text: 'Atlas Ops relay startup order is clear queue, start dispatcher, then open port 4173.', contextScope: relay });
    await store.append({ id: 'memory-55555555-5555-4555-8555-555555555555', lineageId: sourceLineage,
      agentId: sourceAgent, createdAt: date, text: 'Atlas Ops harbor tide gauge is BR-29; loading begins at 06:40.',
      contextScope: { projectId: 'atlas-ops', topicId: 'harbor' } });
    await store.append({ id: 'memory-66666666-6666-4666-8666-666666666666', lineageId: sourceLineage,
      agentId: sourceAgent, createdAt: date, text: 'Atlas Ops Archive relay maintenance code is 6612.',
      contextScope: { projectId: 'atlas-ops-archive', topicId: 'relay' } });
    await store.append({ id: 'memory-77777777-7777-4777-8777-777777777777', lineageId: sourceLineage,
      agentId: sourceAgent, createdAt: date, text: 'Atlas Ops private vault recovery phrase remains sealed.',
      contextScope: { projectId: 'atlas-ops', topicId: 'private-vault' } });

    const correction = await commitMemoryCorrection({ store,
      authority: { agentId: sourceAgent, lineageId: sourceLineage, author: { kind: 'owner', id: 'synthetic-owner' } },
      assertAuthorized() {},
      request: { lineageId: sourceLineage, id: relayId, expectedRevision: 0,
        createdAt: '2026-10-02T12:00:00.000Z', changes: { text: currentFact },
        why: 'The prior code and door were wrong.', expectedNextBehavior: 'Check the signed inspection before answering.',
        source: { kind: 'owner-feedback', text: evidenceText }, by: 'owner:synthetic-owner' }
    });

    const depth0 = await store.getById({ lineageId: sourceLineage, id: relayId, depth: 0 });
    const depth1 = await store.getById({ lineageId: sourceLineage, id: relayId, depth: 1 });
    const depth2 = await store.getById({ lineageId: sourceLineage, id: relayId, depth: 2 });
    assert.equal(depth0.id, relayId);
    assert.equal(depth0.text, currentFact);
    assert.equal(depth0.status, 'conditional');
    assert.equal(depth0.valid_while, condition);
    assert.equal(depth0.revisions, undefined);
    assert.equal(depth1.revision, 1);
    assert.equal(depth1.revisions[0].previous.text, oldFact);
    assert.equal(depth1.revisions[0].learning.source.text, undefined);
    assert.equal(depth2.revisions[0].learning.source.text, evidenceText);
    assert.match(correction.mistakeId, /^mistake-/);

    const proposalState = { memoryProposals: [] };
    let canonicalProposalWrites = 0;
    const proposalService = createMemoryProposalService({ state: proposalState, now: () => date,
      saveState: async () => {}, appendMemory: async entry => {
        canonicalProposalWrites += 1;
        return store.append(entry);
      }, authorize: () => ({ allowed: true, autoCommit: true }) });
    const pending = await proposalService.submitCreate({ source: { kind: 'agent-link', callerId: 'synthetic-link',
      linkId: 'synthetic-link', agentId: sourceAgent, lineageId: sourceLineage }, reviewRequired: true,
      payload: { text: unsupported, status: 'active', evidence_excerpt: '', metadata: {}, contextScope: relay } });
    assert.equal(pending.committed, false);
    assert.equal(pending.pendingOwnerReview, true);
    assert.equal(proposalState.memoryProposals[0].commitState, 'owner-review-required');
    assert.equal(canonicalProposalWrites, 0);
    assert.equal(await store.getById({ lineageId: sourceLineage, id: proposalState.memoryProposals[0].payload.memoryId }), null);

    const turn = options => buildMemoryTurnContext({ store, rag, lineageId: sourceLineage, agentId: sourceAgent,
      scope: options.scope, latestMessage: options.query, maxFacts: options.maxFacts ?? 8,
      maxFactBytes: options.maxFactBytes ?? 4096 });
    const bounded = await turn({ scope: relay, query: 'maintenance code west door', maxFacts: 1, maxFactBytes: 512 });
    assert.equal(bounded.status, 'ready');
    assert.equal(bounded.factCount, 1);
    const factRow = JSON.parse(bounded.text.split('\n').find(line => line.includes(`"id":"${relayId}"`)));
    assert.equal(factRow.text, currentFact);
    assert.equal(factRow.status, 'conditional');
    assert.equal(factRow.valid_while, condition);
    assert.doesNotMatch(bounded.text, /6612|private vault recovery|hidden emergency tunnel/);

    const harbor = await turn({ scope: { projectId: 'atlas-ops', topicId: 'harbor' }, query: 'tide gauge loading begins' });
    assert.match(harbor.text, /BR-29/);
    assert.doesNotMatch(harbor.text, /3914|west door/);
    const returned = await turn({ scope: relay, query: 'maintenance code west door' });
    assert.match(returned.text, /3914/);
    assert.doesNotMatch(returned.text, /BR-29|6612|hidden emergency tunnel/);

    const state = { settings: { workMode: 'build' }, agents: [], agentLinks: [], memoryShares: [], receipts: [] };
    const source = { id: sourceAgent, name: 'Synthetic source', continuityLineage: {
      id: sourceLineage, activityState: 'active', activeAgentId: sourceAgent } };
    const target = { id: targetAgent, name: 'Synthetic target', continuityLineage: {
      id: targetLineage, activityState: 'active', activeAgentId: targetAgent } };
    state.agents.push(source, target);
    const invite = createAgentLinkInvite(state, { agentId: targetAgent, baseUrl: 'http://127.0.0.1',
      requestedCapabilities: ['memory-read'] });
    const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id,
      secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)),
      identity: { name: 'Synthetic target', framework: 'test', externalId: 'synthetic-target' },
      capabilities: ['memory-read'], clientDeviceId: 'synthetic-device' });
    const granted = grantMemoryShare(state.memoryShares, { sourceAgentId: sourceAgent, sourceLineageId: sourceLineage,
      targetAgentId: targetAgent, targetLineageId: targetLineage, targetLinkId: paired.connection.id, scope: relay,
      by: 'owner:synthetic-owner', at: date });
    const body = { operation: 'recall', shareId: granted.share.id, maxBytes: 8192 };
    const pathname = '/agent-link/v1/shared-memory';
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const req = { socket: {}, headers: { authorization: `Bearer ${paired.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname, timestamp, nonce, body }) } };
    let response;
    const ctx = { state, method: 'POST', pathname, readBody: async () => body,
      findAgent: id => state.agents.find(agent => agent.id === id),
      assertAgentActivity(agent) {
        if (agent.continuityLineage?.activityState !== 'active' || agent.continuityLineage.activeAgentId !== agent.id) {
          throw Object.assign(new Error('Synthetic lineage is inactive.'), { status: 403 });
        }
      }, connectorPolicy: () => null, datedMemoryStore: store, localMemoryRag: rag,
      createMemoryMcpHandler, addReceipt: value => state.receipts.push(value), saveState: async () => {},
      cleanString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      json(_res, status, value) { response = { status, body: value }; } };
    await handleAgentLinkRequest(req, {}, ctx);
    assert.equal(response.status, 200, JSON.stringify(response));
    const shared = response.body.context;
    assert.ok(shared.memories.some(memory => memory.id === relayId && memory.text === currentFact));
    assert.ok(shared.mistakeWarnings.warnings.some(warning => warning.id === correction.mistakeId));
    assert.doesNotMatch(JSON.stringify(shared), /BR-29|6612|private vault recovery|hidden emergency tunnel/);
    assert.ok(shared.memories.every(memory => memory.text !== oldFact));
    assert.equal(JSON.stringify(shared).includes(evidenceText), false);
    assert.equal(runtimeCalls, 0, 'empty local index keeps ranking on the production lexical fallback; no inference ran');
  } finally {
    await rag.close();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(process.cwd()) + path.sep) && path.basename(resolved).startsWith('.memory-normal-use-quality-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
