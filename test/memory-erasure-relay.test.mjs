import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { acceptAgentLinkInvite } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { PublicAgentRelay } from '../lib/public-agent-relay.mjs';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';

class FakeTunnel {
  status() { return { running: this.running === true, url: this.url || '', error: '', startedAt: null }; }
  async start() { this.running = true; this.url = 'https://relay.example.test'; return this.status(); }
  stop() { this.running = false; this.url = ''; return this.status(); }
}
test('exact encrypted DELETE erases only own canonical fact and derived index; invalid methods and owner routes stay closed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-erasure-relay-'));
  const lineageId = 'lineage-12345678-1234-1234-1234-123456789abc';
  const erasedId = 'memory-12345678-1234-1234-1234-123456789abc', keptId = 'memory-22345678-1234-1234-1234-123456789abc';
  const supersedingId = 'memory-33333333-1234-1234-1234-123456789abc';
  const successId = 'memory-abcdefab-1234-1234-1234-123456789abc';
  const datedMemoryStore = new DatedMemoryStore({ root: path.join(root, 'logs') });
  const localMemoryRag = new LocalMemoryRag({ root: path.join(root, 'index'), store: datedMemoryStore, runtimeFactory: async () => ({ embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])), dispose: async () => {} }) });
  for (const [id, date, text] of [[erasedId, '2026-10-03', 'disposable erasure content'], [keptId, '2026-10-04', 'unrelated retained fact'], [successId, '2026-10-04', 'disposable success erasure'], [supersedingId,'2026-10-04','disposable superseding content']]) await datedMemoryStore.append({ lineageId, id, date, createdAt: `${date}T12:00:00.000Z`, agentId: 'qa', text, originKind: 'owner-entry', contextScope: { projectId: 'erasure-qa' } });
  await datedMemoryStore.appendConflictLink({ lineageId, fromId: successId, toId: keptId,
    relation: 'contradicts', expectedFromRevision: 0, expectedToRevision: 0,
    by: 'owner:qa', why: 'disposable contradiction', evidence: { kind: 'owner-feedback', text: 'disposable contradiction evidence' },
    createdAt: '2026-10-04T13:00:00.000Z' });
  await datedMemoryStore.appendConflictLink({lineageId,fromId:supersedingId,toId:keptId,relation:'supersedes',valid_from:'2026-10-04T12:00:00.000Z',expectedFromRevision:0,expectedToRevision:0,by:'owner:qa',why:'disposable superseding reason',evidence:{kind:'owner-feedback',text:'disposable superseding evidence'},createdAt:'2026-10-04T14:00:00.000Z'});
  assert.equal((await localMemoryRag.indexRange({ lineageId, from: '2026-10-03', to: '2026-10-04' })).total, 3);
  const agent = { id: 'qa', continuityLineage: { id: lineageId, activityState: 'active', activeAgentId: 'qa' } };
  const state = { agentLinkInvites: [], agentLinks: [], settings: {}, receipts: [] };
  const secret = 'disposable-erasure-relay-invite-only';
  const invite = { id: 'link-invite-erasure-qa', requestedCapabilities: ['messages', 'memory-write'], secretHash: crypto.createHash('sha256').update(secret).digest('base64url'), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), usedAt: null };
  state.agentLinkInvites.push(invite);
  let indexFailures = 0;
  const owner = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : null;
    const json = (_res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url === '/agent-link/v1/pair') {
      const result = acceptAgentLinkInvite(state, body), link = state.agentLinks[0];
      Object.assign(link, { agentId: agent.id, trustLevel: 'owner', capabilities: [...link.capabilities, 'owner-process', 'owner-filesystem-read'] });
      state.settings.desktopBridge = { enabled: true, ownerApproved: true, agentControlActive: true, linkId: link.id };
      json(res, 200, result); return;
    }
    await handleAgentLinkRequest(req, res, { state, pathname: req.url, method: req.method, readBody: async () => body, json,
      findAgent: id => id === agent.id ? agent : null, connectorPolicy: () => null, assertAgentActivity() {}, datedMemoryStore,
      localMemoryRag: { async hardDelete(input) { if (indexFailures++ === 0) throw Error('synthetic unavailable index'); await localMemoryRag.hardDelete(input); } },
      addReceipt(input) { const receipt = { id: crypto.randomUUID(), ...input }; state.receipts.push(receipt); return receipt; }, saveState: async () => {}, now: () => new Date().toISOString() });
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  const relay = new PublicAgentRelay({ publicDir: path.resolve('public'), targetOrigin: `http://127.0.0.1:${owner.address().port}`, state, tunnel: new FakeTunnel() });
  let companion;
  t.after(async () => { companion?.close(); await relay.stop(); await new Promise(resolve => owner.close(resolve)); await localMemoryRag.close(); await rm(root, { recursive: true, force: true }); });
  await relay.start();
  const inviteUrl = new URL(relay.registerInvite(invite, { transport: 'companion' })); inviteUrl.protocol = 'http:'; inviteUrl.host = `127.0.0.1:${relay.localPort}`; inviteUrl.hash = `secret=${encodeURIComponent(secret)}`;
  companion = new OutboundCompanionConnection({ inviteUrl: inviteUrl.toString(), capabilities: ['messages', 'memory-write'] });
  await companion.connect(); await companion.pair({ name: 'Disposable erasure agent', framework: 'qa' });
  const target = `/agent-link/v1/memory/${erasedId}`;
  for (const [pathname, method] of [[target, 'GET'], [target, 'POST'], [target + '/export', 'DELETE'], ['/agent-link/v1/memory/invalid', 'DELETE'], ['/api/codex-deliveries', 'GET']]) {
    const response = await companion.linkRequest(pathname, { method }); assert.equal(response.status, 400);
  }
  const first = await companion.linkRequest(target, { method: 'DELETE' });
  assert.equal(first.status, 503); assert.equal(first.body.code, 'memory_erasure_cleanup_pending');
  assert.equal(await datedMemoryStore.getById({ lineageId, id: erasedId }), null);
  assert.equal(state.receipts.length, 0);
  const retry = await companion.linkRequest(target, { method: 'DELETE' }); assert.equal(retry.status, 404);
  assert.equal((await localMemoryRag.indexRange({ lineageId, from: '2026-10-03', to: '2026-10-04' })).total, 2);
  const success = await companion.linkRequest(`/agent-link/v1/memory/${successId.slice(0,7)}${successId.slice(7).toUpperCase()}`, { method: 'DELETE' });
  assert.equal(success.status, 200); assert.deepEqual(success.body, { erased: true, id: successId });
  assert.equal(state.receipts.length, 1); assert.equal(state.receipts[0].status, 'completed');
  assert.equal(await datedMemoryStore.getById({ lineageId, id: successId }), null);
  assert.equal((await localMemoryRag.indexRange({ lineageId, from: '2026-10-03', to: '2026-10-04' })).total, 1);
  assert.equal((await datedMemoryStore.getById({ lineageId, id: keptId })).text, 'unrelated retained fact');
  assert.equal((await datedMemoryStore.getById({ lineageId, id: keptId })).conflictCount, 1);
  const reopened = new DatedMemoryStore({ root: path.join(root, 'logs') });
  assert.equal((await reopened.getById({ lineageId, id: keptId })).revision, 1);
  const eraseSupersession = await companion.linkRequest(`/agent-link/v1/memory/${supersedingId}`,{method:'DELETE'});
  assert.equal(eraseSupersession.status,200);
  assert.equal(await reopened.getById({lineageId,id:supersedingId}),null);
  const retained = await reopened.getById({lineageId,id:keptId,depth:2});
  assert.equal(retained.revision,1); assert.equal(retained.status,'superseded');
  assert.equal(retained.valid_until,'2026-10-04T12:00:00.000Z');
  assert.equal(retained.conflictCount ?? 0,0);
  assert.equal((await localMemoryRag.indexRange({lineageId,from:'2026-10-03',to:'2026-10-04'})).total,0);
  assert.doesNotMatch(await readFile(path.join(root,'logs',lineageId,'2026-10-04.json'),'utf8'),/disposable superseding|memory-33333333/);
  assert.doesNotMatch(await readFile(path.join(root, 'logs', lineageId, '2026-10-04.json'), 'utf8'), /disposable contradiction|disposable success erasure/);
  assert.doesNotMatch(await readFile(path.join(root, 'logs', lineageId, '2026-10-03.json'), 'utf8'), /disposable erasure content/);
  // Same real encrypted transport: budget read -> reversible exact compare/write.
  const usage = await companion.linkRequest('/agent-link/v1/usage', { method: 'GET' });
  assert.equal(usage.status, 200); assert.equal(usage.body.budget.limit, null);
  const budget = await companion.linkRequest('/agent-link/v1/usage/budget', { method: 'PUT', body: { tokens: 100, expectedTokens: null } });
  assert.equal(budget.status, 200); assert.equal(state.settings.tokenBudget7d, 100);
  const stale = await companion.linkRequest('/agent-link/v1/usage/budget', { method: 'PUT', body: { tokens: 50, expectedTokens: null } });
  assert.equal(stale.status, 409); assert.equal(state.settings.tokenBudget7d, 100);
  const reset = await companion.linkRequest('/agent-link/v1/usage/budget', { method: 'PUT', body: { tokens: null, expectedTokens: 100 } });
  assert.equal(reset.status, 200); assert.equal(state.settings.tokenBudget7d, null);
  const forbidden = await companion.linkRequest('/agent-link/v1/usage/budget', { method: 'POST', body: { tokens: 100, expectedTokens: null } });
  assert.equal(forbidden.status, 400);
});
