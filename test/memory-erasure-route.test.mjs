import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { memoryWriteBudgetLimits } from '../lib/memory-write-budget.mjs';

const memoryId = 'memory-12345678-1234-1234-1234-123456789abc';
const pathname = `/agent-link/v1/memory/${memoryId}`;

async function request({ denied = null, mutate = null, missing = false, scoped = false, stopped = false, memoryWrite = true, afterCommit = null, indexFailure = false, budgetBlocked = false } = {}) {
  const state = { agentLinks: [], settings: {}, receipts: [] };
  const invitation = createAgentLinkInvite(state, { baseUrl: 'http://localhost', requestedCapabilities: ['memory-write'] });
  const secret = decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id, secret, capabilities: ['memory-write'] });
  const connection = state.agentLinks.find(item => item.id === paired.connection.id);
  Object.assign(connection, { trustLevel: scoped ? 'scoped' : 'owner', agentId: 'qa', capabilities: ['owner-process', ...(memoryWrite ? ['memory-write'] : [])] });
  state.settings.desktopBridge = { enabled: true, ownerApproved: true, agentControlActive: !stopped, linkId: connection.id };
  const agent = { id: 'qa', continuityLineage: { id: `lineage-${crypto.randomUUID()}`, activityState: 'active', activeAgentId: 'qa' } };
  const originalLineage = agent.continuityLineage.id;
  if (budgetBlocked) {
    const key = crypto.createHash('sha256').update(`${originalLineage}\0${agent.id}`).digest('hex');
    const at = Date.parse('2026-10-04T12:00:00.000Z');
    state.memoryWriteBudget = [{ key, events: Array.from({ length: memoryWriteBudgetLimits.minuteCount }, () => [at, 1]) }];
  }
  let indexedLineage;
  const policies = [];
  let committed = 0;
  let indexed = 0;
  let result;
  const ctx = { state, pathname, method: 'DELETE', findAgent: id => id === agent.id ? agent : null,
    assertAgentActivity() {}, connectorPolicy(...args) { policies.push(args); return denied; },
    datedMemoryStore: { async getById() { return missing ? null : { id: memoryId }; }, async hardDelete({ assertAuthorized }) {
      assertAuthorized();
      if (mutate) mutate({ connection: state.agentLinks.find(item => item.id === connection.id), agent, state });
      assertAuthorized();
      if (missing) return false;
      committed++; afterCommit?.(agent); return true;
    } },
    localMemoryRag: { async hardDelete({ lineageId }) { if (indexFailure) throw Error('private index error'); indexed++; indexedLineage = lineageId; } },
    addReceipt(receipt) { state.receipts.push(receipt); }, saveState: async () => {}, now: () => '2026-10-04T12:00:00.000Z',
    json(_res, status, body) { result = { status, body }; }
  };
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  await handleAgentLinkRequest({ headers: { authorization: `Bearer ${paired.token}`,
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'DELETE', pathname, timestamp, nonce }) } }, {}, ctx);
  return { result, committed, indexed, indexedLineage, originalLineage, policies, receipts: state.receipts };
}

test('signed owner erasure commits, clears derived index, and records content-free receipt', async () => {
  const result = await request();
  assert.equal(result.result.status, 200);
  assert.deepEqual(result.result.body, { erased: true, id: memoryId });
  assert.equal(result.committed, 1);
  assert.equal(result.indexed, 1);
  assert.equal(result.receipts[0].status, 'completed');
  assert.ok(result.policies.every(args => args[0] === 'write_workspace' && args[1] === 'high' && args[3].external));
});

test('signed erasure respects the shared write limit before deleting canonical memory', async () => {
  const result = await request({ budgetBlocked: true });
  assert.equal(result.result.status, 429);
  assert.equal(result.result.body.code, 'MEMORY_WRITE_RATE_LIMIT');
  assert.equal(result.committed, 0);
  assert.equal(result.indexed, 0);
  assert.deepEqual(result.receipts, []);
});

for (const [label, options, status] of [
  ['Plan/deny', { denied: { denied: true } }, 403],
  ['approval-required', { denied: { denied: false } }, 409],
  ['scoped agent', { scoped: true }, 403],
  ['stopped computer session', { stopped: true }, 403],
  ['missing memory-write grant', { memoryWrite: false }, 403],
  ['revoked during storage preparation', { mutate: ({ connection }) => { connection.status = 'revoked'; } }, 403],
  ['lineage changed during storage preparation', { mutate: ({ agent }) => { agent.continuityLineage.id = `lineage-${crypto.randomUUID()}`; } }, 403],
  ['unknown record', { missing: true }, 404]
]) {
  test(`signed erasure refuses ${label} without canonical commit or completion receipt`, async () => {
    const result = await request(options);
    assert.equal(result.result.status, status);
    assert.equal(result.committed, 0);
    assert.equal(result.indexed, options.missing ? 1 : 0);
    assert.deepEqual(result.receipts, []);
  });
}


test('cleanup uses the committed lineage even when live agent lineage changes afterward', async () => {
  const result = await request({ afterCommit(agent) { agent.continuityLineage.id = `lineage-${crypto.randomUUID()}`; } });
  assert.equal(result.result.status, 200); assert.equal(result.indexedLineage, result.originalLineage);
});
test('failed derived cleanup returns retry guidance and no false completion receipt', async () => {
  const result = await request({ indexFailure: true });
  assert.equal(result.result.status, 503); assert.equal(result.result.body.code, 'memory_erasure_cleanup_pending');
  assert.equal(result.committed, 1); assert.equal(result.indexed, 0); assert.deepEqual(result.receipts, []);
  assert.doesNotMatch(JSON.stringify(result.result.body), /private index error/);
});
