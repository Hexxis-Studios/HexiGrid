import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { evaluatePolicy } from '../lib/policy.mjs';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const routeStart = source.indexOf('  const transcriptionMatch =');
const routeEnd = source.indexOf('  const linkDraftMatch =', routeStart);
const policyStart = source.indexOf('function connectorPolicy(');
const policyEnd = source.indexOf('\nfunction authenticatedMemoryOwner', policyStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart && policyStart >= 0 && policyEnd > policyStart);
const route = source.slice(routeStart, routeEnd), policy = source.slice(policyStart, policyEnd);

async function configure({ mode = 'goal', profile = 'full', approved = false, connected = true } = {}) {
  const link = { id: 'synthetic', agentId: 'qa', status: connected ? 'connected' : 'revoked', transcription: { enabled: false, model: 'tiny', language: 'en' } };
  const state = { settings: { workMode: mode, approvalPolicy: profile }, agentLinks: [link] };
  const events = [], receipts = [], responses = []; let saves = 0;
  const run = vm.runInNewContext(`(async () => { ${policy} ${route} })`, {
    pathname: '/api/agent-links/synthetic/transcription', method: 'POST', state, req: {}, res: {}, evaluatePolicy,
    readBody: async () => ({ enabled: false, language: 'fr', approved }), localTranscriber: new LocalTranscriber(),
    queueAgentLinkEvent: (_link, event) => events.push(event), addReceipt: receipt => { receipts.push(receipt); return receipt; },
    saveState: async () => { saves++; }, publicAgentLink: value => ({ id: value.id, transcription: value.transcription }),
    json: (_res, status, body) => responses.push({ status, body })
  });
  await run(); return { link, events, receipts, responses, saves };
}

test('existing writable modes save only the selected Link configuration with a truthful receipt', async () => {
  for (const mode of ['setup', 'goal', 'build']) {
    const f = await configure({ mode });
    assert.equal(f.responses[0].status, 200); assert.equal(f.link.transcription.language, 'fr');
    assert.equal(f.link.transcription.enabled, false); assert.equal(f.saves, 1);
    assert.equal(f.receipts[0].capability, 'write_workspace'); assert.equal(f.receipts[0].status, 'completed');
    assert.match(f.receipts[0].detail, /Capture and device grants were not changed/);
    assert.equal(f.responses[0].body.connection.id, 'synthetic'); assert.equal(f.events.length, 1);
  }
});

test('read-only modes cannot mutate speech settings even with full access and approved true', async () => {
  for (const mode of ['plan', 'converse', 'watch', 'research', 'sketch']) {
    const f = await configure({ mode, approved: true });
    assert.equal(f.responses[0].status, 403); assert.equal(f.link.transcription.language, 'en');
    assert.equal(f.saves, 0); assert.equal(f.events.length, 0); assert.equal(f.receipts.length, 0);
  }
});

test('ask profile requires explicit approval and disconnected Links remain unavailable', async () => {
  const denied = await configure({ profile: 'ask' });
  assert.equal(denied.responses[0].status, 409); assert.equal(denied.link.transcription.language, 'en');
  assert.equal(denied.saves, 0); assert.equal(denied.responses[0].body.approvalRequired, true);
  const approved = await configure({ profile: 'ask', approved: true }); assert.equal(approved.responses[0].status, 200);
  const revoked = await configure({ connected: false, approved: true }); assert.equal(revoked.responses[0].status, 404);
  assert.equal(revoked.link.transcription.language, 'en'); assert.equal(revoked.saves, 0);
});
