import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { localUsageSnapshot } from '../lib/usage-report.mjs';
import { acceptAgentLinkInvite, createAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

const at = Date.parse('2026-10-04T12:00:00Z');
const record = (age, tokens, extra = {}) => ({ createdAt: new Date(at - age * 86400000).toISOString(), inputTokens: tokens, outputTokens: 1, estimated: false, agentId: 'a', ...extra });
test('signed projection agrees with existing owner accounting at every period boundary and omits private fields', async () => {
  const state = { settings: { tokenBudget7d: 100 }, agents: [{ id: 'a', name: 'Private account label' }], usage: [record(0, 10), record(1, 20), record(7, 30, { estimated: true }), record(30, 40), record(31, 999), record(-1, 999), record(2, 5, { agentId: null, estimated: undefined, prompt: 'SECRET', accessToken: 'SECRET' })] };
  const ctx = { window: {} };
  vm.runInNewContext(await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8'), ctx);
  const result = localUsageSnapshot(state, at);
  for (const report of result.reports) {
    const existing = ctx.window.HexiGridViewRenderers.agentUsageReport(state, { days: report.days, endAt: at });
    for (const key of ['requests', 'inputTokens', 'outputTokens', 'from', 'through']) assert.equal(report[key], existing[key]);
    assert.equal(report.agents.reduce((n, row) => n + row.requests, 0), report.requests);
  }
  assert.equal(result.budget.used, 69);
  assert.equal(result.reports[1].estimatedRequests, 1);
  assert.equal(result.reports[1].unknownMeteringRequests, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Private account|prompt|accessToken/);
});

async function request({ scoped = false, stopped = false, wrongSession = false, grant = true, denied = null, revoked = false, forged = false, query = '' } = {}) {
  const pathname = '/agent-link/v1/usage';
  const state = { agentLinks: [], settings: {}, usage: [record(0, 10)] };
  const invitation = createAgentLinkInvite(state, { baseUrl: 'http://localhost', requestedCapabilities: ['messages'] });
  const secret = decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id, secret, capabilities: ['messages'] });
  const link = state.agentLinks[0];
  Object.assign(link, { trustLevel: scoped ? 'scoped' : 'owner', status: revoked ? 'revoked' : 'connected', capabilities: grant ? ['owner-filesystem-read'] : [] });
  state.settings.desktopBridge = { enabled: true, ownerApproved: true, agentControlActive: !stopped, linkId: wrongSession ? 'another-link' : link.id };
  let result;
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
  await handleAgentLinkRequest({ url: pathname + query, headers: { authorization: `Bearer ${paired.token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce, 'x-hexigrid-signature': forged ? 'invalid' : signatureFor({ token: paired.token, method: 'GET', pathname, timestamp, nonce }) } }, {}, {
    state, pathname, method: 'GET', connectorPolicy(capability, risk, acting, opts) { assert.equal(capability, 'read_local'); assert.equal(risk, 'high'); assert.equal(acting, false); assert.equal(opts.external, true); return denied; },
    json(_res, status, body) { result = { status, body }; }
  });
  return result;
}
test('existing owner grant reads bounded aggregate snapshot without mutation', async () => {
  const result = await request(); assert.equal(result.status, 200);
  assert.deepEqual(result.body.reports.map(row => row.days), [1, 7, 30]);
});
for (const [name, opts, status] of [
  ['scoped Link', { scoped: true }, 403], ['missing grant', { grant: false }, 403], ['stopped session', { stopped: true }, 403],
  ['another Link session', { wrongSession: true }, 403], ['revoked Link', { revoked: true }, 410], ['forged signature', { forged: true }, 401],
  ['policy denial', { denied: { denied: true } }, 403], ['approval required', { denied: { denied: false } }, 409], ['overwide query', { query: '?all=1' }, 400]
]) test(`usage projection refuses ${name}`, async () => { const result = await request(opts); assert.equal(result.status, status); assert.equal(result.body.reports, undefined); });
test('machine catalog advertises exact signed read contract', () => {
  const entry = agentInterfaceManifest().resources.signedLinkUsage;
  assert.equal(entry.method, 'GET'); assert.equal(entry.path, '/agent-link/v1/usage'); assert.equal(entry.requiredCapability, 'owner-filesystem-read');
});

async function budgetRequest({ scoped = false, stopped = false, wrongSession = false, grant = true,
  denied = null, revoked = false, forged = false, query = '', input = { tokens: 100, expectedTokens: null }, failSave = false } = {}) {
  const pathname = '/agent-link/v1/usage/budget';
  const state = { agentLinks: [], settings: {}, receipts: [] };
  const invitation = createAgentLinkInvite(state, { baseUrl: 'http://localhost', requestedCapabilities: ['messages'] });
  const secret = decodeURIComponent(new URL(invitation.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id, secret, capabilities: ['messages'] });
  const link = state.agentLinks[0];
  Object.assign(link, { trustLevel: scoped ? 'scoped' : 'owner', status: revoked ? 'revoked' : 'connected', capabilities: grant ? ['owner-process'] : [] });
  state.settings.desktopBridge = { enabled: true, ownerApproved: true, agentControlActive: !stopped, linkId: wrongSession ? 'another-link' : link.id };
  let result, saves = 0;
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
  await handleAgentLinkRequest({ url: pathname + query, headers: { authorization: `Bearer ${paired.token}`,
    'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
    'x-hexigrid-signature': forged ? 'invalid' : signatureFor({ token: paired.token, method: 'PUT', pathname, timestamp, nonce, body: input }) } }, {}, {
    state, pathname, method: 'PUT', readBody: async () => input,
    connectorPolicy(capability, risk, approved, opts) { assert.equal(capability, 'write_workspace'); assert.equal(risk, 'high'); assert.equal(approved, false); assert.equal(opts.external, true); return denied; },
    addReceipt(data) { const receipt = { id: 'receipt-budget-qa', ...data }; state.receipts.push(receipt); return receipt; },
    async saveState() { saves++; if (failSave) throw Object.assign(new Error('synthetic disk failure'), { status: 503 }); },
    json(_res, status, body) { result = { status, body }; }
  });
  return { ...result, state, saves };
}
test('signed budget setting uses current owner-process session and content-free receipt', async () => {
  const result = await budgetRequest(); assert.equal(result.status, 200);
  assert.equal(result.body.tokenBudget7d, 100); assert.equal(result.state.receipts.length, 1);
  assert.equal(result.state.receipts[0].capability, 'write_workspace'); assert.equal(result.saves, 1);
});
for (const [name, opts, status] of [
  ['scoped Link', { scoped: true }, 403], ['missing grant', { grant: false }, 403], ['stopped session', { stopped: true }, 403],
  ['another session', { wrongSession: true }, 403], ['revoked Link', { revoked: true }, 410], ['forged signature', { forged: true }, 401],
  ['Plan denial', { denied: { denied: true } }, 403], ['approval cannot be self-supplied', { denied: { denied: false }, input: { tokens: 100, expectedTokens: null, approved: true } }, 409],
  ['stale budget', { input: { tokens: 100, expectedTokens: 50 } }, 409], ['extra field', { input: { tokens: 100, expectedTokens: null, key: 'forbidden' } }, 400],
  ['query', { query: '?other=1' }, 400], ['persistence failure', { failSave: true }, 503]
]) test(`budget setting refuses ${name} without keeping a mutation or receipt`, async () => {
  const result = await budgetRequest(opts); assert.equal(result.status, status);
  assert.equal(Object.hasOwn(result.state.settings, 'tokenBudget7d'), false); assert.equal(result.state.receipts.length, 0);
});
