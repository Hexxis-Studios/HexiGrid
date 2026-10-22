import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { acceptAgentLinkInvite, createAgentLinkInvite, normalizeAgentLinks, signatureFor } from '../lib/agent-link.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { createOwnerMemory, normalizeOwnerMemory } from '../lib/owner-memory.mjs';
import { createStateSaveQueue } from '../lib/local-state.mjs';
import { evaluatePolicy } from '../lib/policy.mjs';

const lineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agentId = 'agent-signed-retirement';
const at = '2026-10-04T12:00:00.000Z';

function fixture({ capabilities = ['memory-read', 'memory-write'], trustLevel = 'owner' } = {}) {
  const agent = { id: agentId, name: 'Synthetic retirement agent', continuityLineage: {
    id: lineageId, activeAgentId: agentId, activityState: 'active' } };
  const state = { settings: { workMode: 'build', approvalPolicy: 'full' }, agents: [agent], agentLinks: [], memories: [], receipts: [] };
  const invitation = createAgentLinkInvite(state, { agentId, baseUrl: 'http://127.0.0.1', requestedCapabilities: capabilities });
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id,
    secret: decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length)),
    identity: { name: agent.name, framework: 'test', externalId: crypto.randomUUID() },
    capabilities, clientDeviceId: crypto.randomUUID() });
  const connection = state.agentLinks.find(item => item.id === paired.connection.id);
  connection.trustLevel = trustLevel;
  const note = createOwnerMemory({ content: 'PRIVATE-SIGNED-RETIRE-NOTE', category: 'Process', evidence_excerpt: 'PRIVATE-SIGNED-RETIRE-EVIDENCE' }, { agentId, at });
  const other = createOwnerMemory({ content: 'Unrelated own note.' }, { agentId, at });
  const foreign = createOwnerMemory({ content: 'PRIVATE-SIGNED-RETIRE-FOREIGN' }, { agentId: 'different-agent', at });
  state.memories.push(note, other, foreign);
  const f = { state, agent, connection, note, other, foreign, beforeWrite: () => {}, writeFailure: false, writes: 0 };
  const saveState = createStateSaveQueue({ getState: () => state, store: { async write(snapshot, { assertAuthorized }) {
    f.connection = state.agentLinks.find(item => item.id === paired.connection.id);
    f.beforeWrite(f);
    assertAuthorized();
    if (f.writeFailure) throw Error('Synthetic persistence failure');
    f.disk = structuredClone(snapshot); f.writes += 1;
  } } });
  const ctx = { state, method: 'POST', pathname: '/agent-link/v1/memory-mcp', now: () => at,
    findAgent: id => state.agents.find(item => item.id === id),
    connectorPolicy(capability, risk, approved, { external = false } = {}) {
      const policy = evaluatePolicy({ ...state.settings, capability, risk });
      if (policy.decision === 'deny') return { denied: true, error: policy.reason };
      if (policy.decision === 'ask' && (external || approved !== true)) return { approvalRequired: true, error: policy.reason };
      return null;
    }, assertAgentActivity() {}, saveState,
    datedMemoryStore: { async recall() { return []; }, async getById() { return null; }, async listContext() { return []; },
      async listContextScopes() { return []; }, async listMemoryMistakes() { return []; } },
    localMemoryRag: { async semanticSearch() { return []; } }, createMemoryMcpHandler,
    addReceipt(details) { const receipt = { ...details, id: `receipt-${crypto.randomUUID()}`, createdAt: at }; state.receipts.push(receipt); return receipt; },
    json(_res, status, result) { f.delivered = { status, result }; }
  };
  f.ctx = ctx;
  f.invoke = async (name, args = {}, { notification = false, method = 'tools/call' } = {}) => {
    const body = { jsonrpc: '2.0', ...(notification ? {} : { id: crypto.randomInt(1, 1_000_000) }), method,
      ...(method === 'tools/call' ? { params: { name, arguments: args } } : {}) };
    ctx.readBody = async () => body;
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    await handleAgentLinkRequest({ headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json',
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: paired.token, method: 'POST', pathname: ctx.pathname, timestamp, nonce, body }) }, socket: {} }, {}, ctx);
    return f.delivered;
  };
  f.args = { id: note.id, expectedRevision: 0, why: 'PRIVATE-SIGNED-RETIRE-REASON: temporary guidance expired.' };
  return f;
}

test('signed retirement commits one own historical revision, preserves unrelated notes, and suppresses current text', async () => {
  const f = fixture();
  const result = await f.invoke('retire-owner-note', f.args);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(result.result.result.content, []);
  const value = result.result.result.structuredContent;
  assert.equal(value.retired, true); assert.equal(value.duplicate, false);
  assert.equal(value.id, f.note.id); assert.equal(value.revision, 1); assert.equal(value.status, 'historical');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SIGNED-RETIRE|tokenHash|evidence|why/);
  const saved = f.state.memories[0];
  assert.equal(saved.revisions[0].by, `agent-link:${f.connection.id}`);
  assert.equal(saved.revisions[0].why, f.args.why);
  assert.equal(saved.content, f.note.content); assert.equal(saved.evidence_excerpt, f.note.evidence_excerpt);
  assert.doesNotThrow(() => normalizeOwnerMemory(saved));
  assert.equal(f.state.memories[1], f.other); assert.equal(f.state.memories[2], f.foreign);
  assert.equal(f.disk.memories[0].status, 'historical');
  assert.equal(f.state.receipts.length, 1); assert.equal(f.state.receipts[0].id, value.receiptId);
  assert.doesNotMatch(JSON.stringify(f.state.receipts), /PRIVATE-SIGNED-RETIRE|tokenHash|evidence_excerpt|why/);
  const retry = await f.invoke('retire-owner-note', f.args);
  assert.equal(retry.status, 200); assert.equal(retry.result.result.structuredContent.duplicate, true);
  assert.equal(f.state.memories[0].revisions.length, 1); assert.equal(f.state.receipts.length, 1); assert.equal(f.writes, 1);
  const get = await f.invoke('get-owner-note', { id: f.note.id });
  assert.equal(get.result.result.structuredContent.state, 'inactive'); assert.equal(get.result.result.structuredContent.note, null);
  const list = await f.invoke('list-owner-notes');
  assert.deepEqual(list.result.result.structuredContent.notes.map(item => item.id), [f.other.id]);
});

test('signed retirement is excluded from scoped and incomplete-grant discovery', async () => {
  for (const options of [{}, { trustLevel: 'scoped' }, { capabilities: ['memory-read'] }, { capabilities: ['memory-write'] }]) {
    const f = fixture(options);
    const result = await f.invoke('', {}, { method: 'tools/list' });
    assert.equal(result.status, 200, JSON.stringify(result));
    const tool = result.result.result.tools.find(item => item.name === 'retire-owner-note');
    assert.equal(Boolean(tool), Object.keys(options).length === 0);
    if (tool) assert.deepEqual(tool.inputSchema.required, ['id', 'expectedRevision', 'why']);
  }
});

test('signed retirement rejects scoped, missing grants, Plan/Ask, wrong agent and stale revisions without writes', async t => {
  const cases = {
    scoped: { options: { trustLevel: 'scoped' }, status: 403 },
    missingRead: { options: { capabilities: ['memory-write'] }, status: 403 },
    missingWrite: { options: { capabilities: ['memory-read'] }, status: 403 },
    plan: { mutate: f => { f.state.settings.workMode = 'plan'; }, status: 403 },
    ask: { mutate: f => { f.state.settings.approvalPolicy = 'ask'; }, status: 409 },
    foreign: { mutate: f => { f.args.id = f.foreign.id; }, status: 404 },
    stale: { mutate: f => { f.args.expectedRevision = 1; }, status: 409 },
    lineageInactive: { mutate: f => { f.agent.continuityLineage.activityState = 'historical'; }, status: 403 },
    lineageDuplicate: { mutate: f => { f.state.agents.push({ ...f.agent, id: 'duplicate-active' }); }, status: 403 },
    unsupportedField: { mutate: f => { f.args.approved = true; }, status: 400 },
    tooLong: { mutate: f => { f.args.why = 'x'.repeat(501); }, status: 400 },
    secretReason: { mutate: f => { f.args.why = 'api_key=synthetic-private-credential123'; }, status: 400 }
  };
  for (const [name, entry] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(entry.options); entry.mutate?.(f);
    const memories = structuredClone(f.state.memories);
    const result = await f.invoke('retire-owner-note', f.args);
    assert.equal(result.status, entry.status, JSON.stringify(result));
    assert.deepEqual(f.state.memories, memories); assert.deepEqual(f.state.receipts, []); assert.equal(f.writes, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SIGNED-RETIRE/);
  });
});

test('queued signed retirement rechecks exact credential, trust, grants, policy and lineage before persistence', async t => {
  const mutations = {
    token: f => { f.connection.tokenHash = 'replacement-synthetic-hash'; },
    trust: f => { f.connection.trustLevel = 'scoped'; },
    read: f => { f.connection.capabilities = ['memory-write']; },
    write: f => { f.connection.capabilities = ['memory-read']; },
    policy: f => { f.state.settings.workMode = 'plan'; },
    lineage: f => { f.agent.continuityLineage.activeAgentId = 'replaced-agent'; },
    status: f => { f.connection.status = 'revoked'; },
    replacement: f => { f.state.agentLinks = [{ ...f.connection, id: 'replacement-link' }]; },
    stateReplacement: f => { f.ctx.state = { ...f.state }; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(); f.beforeWrite = mutate;
    const result = await f.invoke('retire-owner-note', f.args);
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.equal(f.state.memories[0], f.note); assert.deepEqual(f.state.receipts, []); assert.equal(f.writes, 0);
  });
});

test('signed persistence failure leaves the note current and retry commits one revision; notifications never retire', async () => {
  const f = fixture(); f.writeFailure = true;
  assert.equal((await f.invoke('retire-owner-note', f.args)).status, 503);
  assert.equal(f.state.memories[0], f.note); assert.deepEqual(f.state.receipts, []);
  f.writeFailure = false;
  assert.equal((await f.invoke('retire-owner-note', f.args, { notification: true })).status, 202);
  assert.equal(f.state.memories[0], f.note); assert.equal(f.writes, 0);
  assert.equal((await f.invoke('retire-owner-note', f.args)).status, 200);
  assert.equal(f.state.memories[0].revisions.length, 1); assert.equal(f.writes, 1);
});

test('ordinary Link normalization during another signed request preserves unchanged retirement authority', async () => {
  const f = fixture(); f.beforeWrite = () => normalizeAgentLinks(f.state);
  const result = await f.invoke('retire-owner-note', f.args);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.state.memories[0].status, 'historical');
});

test('scoped signed history reads only own notes and preserves current-reader exclusions', async () => {
  const f = fixture({ trustLevel: 'scoped', capabilities: ['memory-read'] });
  const listed = await f.invoke('', {}, { method: 'tools/list' });
  assert.ok(listed.result.result.tools.some(tool => tool.name === 'get-owner-note-history'));
  const own = await f.invoke('get-owner-note-history', { id: f.note.id, depth: 2 });
  assert.equal(own.status, 200); assert.equal(own.result.result.structuredContent.note.evidence_excerpt, f.note.evidence_excerpt);
  const foreign = await f.invoke('get-owner-note-history', { id: f.foreign.id, depth: 2 });
  assert.equal(foreign.result.result.structuredContent.state, 'absent');
  assert.doesNotMatch(JSON.stringify(foreign), /PRIVATE-SIGNED-RETIRE/);
});

test('signed history rejects missing grants and rechecks live authority after receipt persistence', async t => {
  const missing = fixture({ capabilities: ['memory-write'] });
  assert.equal((await missing.invoke('get-owner-note-history', { id: missing.note.id })).status, 403);
  for (const [name, mutate] of Object.entries({
    token: f => { f.connection.tokenHash = 'changed'; },
    grant: f => { f.connection.capabilities = []; },
    policy: f => { f.state.settings.workMode = 'converse'; },
    lineage: f => { f.agent.continuityLineage.activityState = 'historical'; },
    state: f => { f.ctx.state = { ...f.state }; }
  })) await t.test(name, async () => {
    for (const [tool, args] of [['get-owner-note-history', { depth: 2 }], ['list-owner-notes', { standing: 'all' }], ['get-owner-note', {}]]) {
      const f = fixture(); f.beforeWrite = mutate;
      const result = await f.invoke(tool, { ...(tool === 'list-owner-notes' ? {} : { id: f.note.id }), ...args });
      assert.equal(result.status, 403, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SIGNED-RETIRE/);
    }
  });
});

test('signed restoration preserves text/condition/history, retry is exact, and cannot confirm a human fact', async () => {
  const f = fixture();
  assert.equal((await f.invoke('retire-owner-note', f.args)).status, 200);
  const historical = structuredClone(f.state.memories[0]);
  const args = { id: f.note.id, expectedRevision: 1, status: 'active', why: 'Synthetic guidance applies again.' };
  const result = await f.invoke('restore-owner-note', args);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.result.result.structuredContent.restored, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SIGNED-RETIRE/);
  const restored = f.state.memories[0];
  assert.equal(restored.content, historical.content); assert.equal(restored.evidence_excerpt, historical.evidence_excerpt);
  assert.equal(restored.valid_while, historical.valid_while); assert.equal(restored.verification, 'unverified');
  assert.deepEqual(restored.revisions[0], historical.revisions[0]); assert.equal(restored.revisions.length, 2);
  assert.equal(restored.revisions[1].by, `agent-link:${f.connection.id}`);
  assert.equal(f.state.receipts[0].action, 'memory:restore-owner-note');
  assert.equal((await f.invoke('restore-owner-note', args)).result.result.structuredContent.duplicate, true);
  assert.equal(f.writes, 2);
  assert.equal((await f.invoke('restore-owner-note', { ...args, why: 'A different retry' })).status, 409);
  assert.equal((await f.invoke('get-owner-note', { id: f.note.id })).result.result.structuredContent.state, 'current');
});

test('restoration requires owner trust/read-write policy, historical standing, conditions and exact revision', async t => {
  for (const [name, mutate, status] of [
    ['scoped', f => { f.connection.trustLevel = 'scoped'; }, 403],
    ['read-only', f => { f.connection.capabilities = ['memory-read']; }, 403],
    ['write-only', f => { f.connection.capabilities = ['memory-write']; }, 403],
    ['plan', f => { f.state.settings.workMode = 'plan'; }, 403],
    ['ask', f => { f.state.settings.approvalPolicy = 'ask'; }, 409],
    ['stale', (_f, a) => { a.expectedRevision = 0; }, 409],
    ['foreign', (f, a) => { a.id = f.foreign.id; }, 404],
    ['conditional-without-condition', (_f, a) => { a.status = 'conditional'; }, 400],
    ['human-confirmation', (_f, a) => { a.verification = 'owner-confirmed'; }, 400],
    ['text-edit', (_f, a) => { a.text = 'Injected wording'; }, 400]
  ]) await t.test(name, async () => {
    const f = fixture(); await f.invoke('retire-owner-note', f.args);
    const before = structuredClone(f.state.memories);
    const args = { id: f.note.id, expectedRevision: 1, status: 'active', why: 'Restore synthetic note.' };
    mutate(f, args); const result = await f.invoke('restore-owner-note', args);
    assert.equal(result.status, status, JSON.stringify(result)); assert.deepEqual(f.state.memories, before);
  });
});

test('failed or revoked restoration stays historical and can be retried without duplicate writes', async () => {
  const f = fixture(); await f.invoke('retire-owner-note', f.args);
  const args = { id: f.note.id, expectedRevision: 1, status: 'active', why: 'Restore synthetic note.' };
  f.writeFailure = true;
  assert.equal((await f.invoke('restore-owner-note', args)).status, 503);
  assert.equal(f.state.memories[0].status, 'historical'); assert.equal(f.state.memories[0].revisions.length, 1);
  f.writeFailure = false; f.beforeWrite = () => { f.connection.capabilities = ['memory-read']; };
  assert.equal((await f.invoke('restore-owner-note', args)).status, 403);
  assert.equal(f.state.memories[0].status, 'historical');
  f.connection.capabilities = ['memory-read', 'memory-write']; f.beforeWrite = () => {};
  assert.equal((await f.invoke('restore-owner-note', args)).status, 200);
  assert.equal(f.state.memories[0].revisions.length, 2);
});
