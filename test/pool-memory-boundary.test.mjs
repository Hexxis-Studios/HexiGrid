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
import { grantMemoryShare } from '../lib/memory-sharing.mjs';

const pathnameForShare = '/agent-link/v1/shared-memory';
const pathnameForMemory = '/agent-link/v1/memory-mcp';
const grantedScope = { projectId: 'pool-boundary-shared', topicId: 'routing' };
const privateScope = { projectId: 'pool-boundary-private', topicId: 'routing' };
const createdAt = '2026-10-04T12:00:00.000Z';
const correctedAt = '2026-10-04T13:00:00.000Z';

async function appendFact(store, { lineageId, agentId, text, contextScope }) {
  return store.append({ lineageId, agentId, id: `memory-${crypto.randomUUID()}`,
    date: createdAt.slice(0, 10), createdAt, text, contextScope, originKind: 'owner-entry' });
}

test('evidence-backed cross-agent correction shares only its exact project and cannot overwrite source memories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-pool-memory-boundary-'));
  t.after(async () => { if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('hexigrid-pool-memory-boundary-'))throw Error('Unexpected fixture path'); await rm(root, { recursive: true, force: true }); });

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

  const sharedOriginal = await appendFact(store, { lineageId: sourceLineageId, agentId: source.id,
    text: 'STALE_SHARED_FACT: the service entrance is on the east side.', contextScope: grantedScope });
  const privateProject = await appendFact(store, { lineageId: sourceLineageId, agentId: source.id,
    text: 'PRIVATE_OTHER_PROJECT_FACT: the client entrance is on the north side.', contextScope: privateScope });
  const targetOwned = await appendFact(store, { lineageId: targetLineageId, agentId: target.id,
    text: 'TARGET_OWNED_FACT: retain this recipient-local note.', contextScope: grantedScope });

  const correctedText = 'SHARED_CURRENT_FACT: the verified service entrance is on the west side.';
  const evidenceText = 'PRIVATE_CORRECTION_EVIDENCE: the retained owner record names the west entrance.';
  const correction = await commitMemoryCorrection({ store,
    authority: { agentId: source.id, lineageId: sourceLineageId, author: { kind: 'owner', id: 'owner-pool-boundary' } },
    assertAuthorized() {},
    request: { lineageId: sourceLineageId, id: sharedOriginal.entry.id, expectedRevision: 0,
      createdAt: correctedAt, changes: { text: correctedText },
      why: 'The owner checked the retained site record.',
      source: { kind: 'owner-feedback', text: evidenceText },
      by: 'owner:owner-pool-boundary', expectedNextBehavior: 'Verify the current entrance before directing a visitor.' }
  });
  assert.equal(correction.revision, 1);

  const requestedCapabilities = ['memory-read', 'memory-write'];
  const invitation = createAgentLinkInvite(state, { agentId: target.id, baseUrl: 'http://127.0.0.1', requestedCapabilities });
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id,
    secret: decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length)),
    identity: { name: 'Synthetic pool-boundary peer', framework: 'test', externalId: crypto.randomUUID() },
    capabilities: requestedCapabilities, clientDeviceId: crypto.randomUUID() });
  const connection = state.agentLinks.find(item => item.id === paired.connection.id);
  const share = grantMemoryShare(state.memoryShares, { sourceAgentId: source.id, sourceLineageId,
    targetAgentId: target.id, targetLineageId, targetLinkId: connection.id, scope: grantedScope,
    by: 'owner:owner-pool-boundary', at: createdAt }).share;

  const mistakeQueries = [];
  const listMemoryMistakes = store.listMemoryMistakes.bind(store);
  store.listMemoryMistakes = async options => {
    mistakeQueries.push(structuredClone(options));
    return listMemoryMistakes(options);
  };
  const rag = { semanticSearch: async () => [], scoreCandidates: async () => new Map() };

  async function signedLinkRequest(pathname, body) {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    let response;
    const req = { socket: {}, headers: { authorization: `Bearer ${paired.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname, timestamp, nonce, body }) } };
    const ctx = { state, pathname, method: 'POST', readBody: async () => body,
      findAgent: id => state.agents.find(agent => agent.id === id),
      assertAgentActivity(agent) {
        if (agent.continuityLineage?.activityState !== 'active' || agent.continuityLineage.activeAgentId !== agent.id) {
          throw Object.assign(new Error('This continuity lineage is not active.'), { status: 403 });
        }
      },
      connectorPolicy: () => null,
      datedMemoryStore: store,
      localMemoryRag: rag,
      createMemoryMcpHandler: options => createMemoryMcpHandler(options),
      addReceipt(receipt) { const saved = { id: `receipt-${state.receipts.length + 1}`, ...receipt }; state.receipts.push(saved); return saved; },
      async saveState() {},
      cleanString(value, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; },
      now: () => createdAt,
      json(_res, status, responseBody) { response = { status, body: responseBody }; }
    };
    await handleAgentLinkRequest(req, {}, ctx);
    return response;
  }

  const recalled = await signedLinkRequest(pathnameForShare, { operation: 'recall', shareId: share.id, maxBytes: 8192 });
  assert.equal(recalled.status, 200, JSON.stringify(recalled));
  assert.deepEqual(recalled.body.context.memories.map(memory => memory.text), [correctedText]);
  assert.deepEqual(mistakeQueries, [{ lineageId: sourceLineageId, agentId: source.id,
    contextScope: grantedScope, limit: 50, depth: 2 }]);
  assert.ok(recalled.body.context.mistakeWarnings.warnings.some(warning => warning.whatWentWrong.includes('STALE_SHARED_FACT')),
    'the correction warning remains available inside the exact owner-granted scope');
  assert.doesNotMatch(JSON.stringify(recalled.body), /PRIVATE_OTHER_PROJECT_FACT|PRIVATE_CORRECTION_EVIDENCE|TARGET_OWNED_FACT/);

  const targetRead = await signedLinkRequest(pathnameForMemory, { jsonrpc: '2.0', id: crypto.randomUUID(),
    method: 'tools/call', params: { name: 'get-memory', arguments: { id: targetOwned.entry.id, depth: 0 } } });
  assert.equal(targetRead.status, 200, JSON.stringify(targetRead));
  assert.equal(targetRead.body.result.structuredContent.memory.text, 'TARGET_OWNED_FACT: retain this recipient-local note.');

  for (const { factId, expectedRevision } of [
    { factId: sharedOriginal.entry.id, expectedRevision: 1 },
    { factId: privateProject.entry.id, expectedRevision: 0 }
  ]) {
    const attempted = await signedLinkRequest(pathnameForMemory, { jsonrpc: '2.0', id: crypto.randomUUID(),
      method: 'tools/call', params: { name: 'propose-correction', arguments: {
        id: factId, expectedRevision, text: 'FOREIGN_OVERWRITE_ATTEMPT: replace the source memory.',
        why: 'Synthetic recipient attempted to edit a source record.',
        expectedNextBehavior: 'Keep the correction local to the recipient.',
        sourceMessageId: 'link-message-synthetic-recipient-evidence'
      } } });
    assert.equal(attempted.status, 200, JSON.stringify(attempted));
    assert.ok(attempted.body.error, 'the recipient-bound memory handler rejects a source-lineage memory ID');
  }

  const finalShared = await store.getById({ lineageId: sourceLineageId, id: sharedOriginal.entry.id, depth: 2 });
  const finalPrivate = await store.getById({ lineageId: sourceLineageId, id: privateProject.entry.id, depth: 1 });
  const finalTarget = await store.getById({ lineageId: targetLineageId, id: targetOwned.entry.id, depth: 1 });
  assert.equal(finalShared.text, correctedText);
  assert.equal(finalShared.revision, 1);
  assert.equal(finalShared.revisions[0].learning.source.text, evidenceText,
    'the corrected source fact retains the evidence that supported its new revision');
  assert.equal(finalPrivate.text, 'PRIVATE_OTHER_PROJECT_FACT: the client entrance is on the north side.');
  assert.equal(finalPrivate.revision, 0);
  assert.equal(finalTarget.text, 'TARGET_OWNED_FACT: retain this recipient-local note.');
  assert.equal(finalTarget.revision, 0);
});
