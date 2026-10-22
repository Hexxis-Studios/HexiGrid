import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  equipLinkedHexonautHexipet, listLinkedHexonautHexipets,
  setLinkedHexonautHexipetOutfit, unequipLinkedHexonautHexipet
} from '../lib/hexispace-agent-hexipet.mjs';
import { createAgentLinkInvite, acceptAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';

const profileId = '20000000-0000-4000-8000-000000000951';
const petId = '30000000-0000-4000-8000-000000000951';
const hatId = '40000000-0000-4000-8000-000000000951';
const trailId = '50000000-0000-4000-8000-000000000951';
const hxp = `hxp_${'a'.repeat(64)}`;
const anonKey = 'a'.repeat(64);
const record = { profileId, supabaseUrl: 'https://project.supabase.co', anonKey, vaultRef: 'vault-only' };

function makeFetcher(handler) {
  const requests = [];
  const fetcher = async (url, options) => {
    const request = { url, options, body: JSON.parse(options.body) };
    requests.push(request);
    const value = handler(request);
    const status = value.status || 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value.body) };
  };
  return { fetcher, requests };
}

const collection = {
  profileId,
  inventory: [{ instanceId: petId, dexNumber: 7, displayName: '<safe text>', description: 'Owned pet', category: 'companion', rarity: 'common', sourceEvent: 'welcome' }],
  equippedPet: { instanceId: petId, dexNumber: 7, displayName: 'Orbit' },
  accessories: [{ instanceId: hatId, accessoryKey: 'star-cap', displayName: 'Star cap', slot: 'hat', description: 'Hat', coinPrice: 10, acquiredAt: '2026-09-20T00:00:00Z' }],
  activeOutfit: { petInstanceId: petId, hat: { instanceId: hatId, accessoryKey: 'star-cap', displayName: 'Star cap', slot: 'hat' }, trail: null }
};

test('Hexipet collection uses only the protected profile token and returns bounded owner-owned fields', async () => {
  const { fetcher, requests } = makeFetcher(() => ({ body: collection }));
  const result = await listLinkedHexonautHexipets(record, { get: async (ref) => { assert.equal(ref, record.vaultRef); return hxp; } }, fetcher);
  assert.equal(requests[0].url, 'https://project.supabase.co/rest/v1/rpc/agent_list_own_hexipets');
  assert.deepEqual(requests[0].body, { p_token: hxp });
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${anonKey}`);
  assert.equal(result.profileId, profileId);
  assert.deepEqual(result.inventory.map((item) => item.instanceId), [petId]);
  assert.equal(result.inventory[0].displayName, '<safe text>');
  assert.deepEqual(result.activeOutfit.trail, null);
  assert.equal(result.activeOutfit.hat.coinPrice, undefined, 'the active-outfit projection must not invent collection metadata');
  assert.equal(JSON.stringify(result).includes(hxp), false);
});

test('Hexipet equip, unequip, and outfit use exact profile RPCs and validate confirmed results', async () => {
  const { fetcher, requests } = makeFetcher(({ url, body }) => {
    if (url.endsWith('agent_equip_own_hexipet')) return { body: { profileId, instanceId: body.p_instance_id, petKey: 'orbit', equipped: true } };
    if (url.endsWith('agent_unequip_own_hexipet')) return { body: { profileId, instanceId: null, equipped: false } };
    return { body: { profileId, petInstanceId: petId, hatAccessoryId: hatId, trailAccessoryId: null, changed: true } };
  });
  const vault = { get: async () => hxp };
  assert.deepEqual(await equipLinkedHexonautHexipet(record, { instanceId: petId }, vault, fetcher), { profileId, instanceId: petId, petKey: 'orbit', equipped: true });
  assert.deepEqual(await unequipLinkedHexonautHexipet(record, {}, vault, fetcher), { profileId, instanceId: null, equipped: false });
  assert.deepEqual(await setLinkedHexonautHexipetOutfit(record, { hatAccessoryId: hatId, trailAccessoryId: null }, vault, fetcher), {
    profileId, petInstanceId: petId, hatAccessoryId: hatId, trailAccessoryId: null, changed: true
  });
  assert.deepEqual(requests.map((request) => request.url.split('/').at(-1)), [
    'agent_equip_own_hexipet', 'agent_unequip_own_hexipet', 'agent_set_own_hexipet_outfit'
  ]);
  assert.deepEqual(requests[2].body, { p_token: hxp, p_hat_accessory_id: hatId, p_trail_accessory_id: null });
});

test('Hexipet helpers reject malformed, cross-profile, oversized, and revoked results without exposing backend errors', async () => {
  const vault = { get: async () => hxp };
  await assert.rejects(equipLinkedHexonautHexipet(record, { instanceId: 'not-a-uuid' }, vault), /this account’s inventory/);
  await assert.rejects(equipLinkedHexonautHexipet(record, { instanceId: petId, profileId }, vault), /this account’s inventory/);
  await assert.rejects(setLinkedHexonautHexipetOutfit(record, { hatAccessoryId: null }, vault), /Select an owned/);
  await assert.rejects(unequipLinkedHexonautHexipet(record, { instanceId: petId }, vault), /no additional/);
  await assert.rejects(listLinkedHexonautHexipets(record, { get: async () => '' }, async () => { throw new Error('must not fetch'); }), /protected credential/);
  await assert.rejects(listLinkedHexonautHexipets(record, vault, async () => ({ ok: false, status: 403, text: async () => 'private SQL detail secret' })), /denied or revoked/);
  await assert.rejects(listLinkedHexonautHexipets(record, vault, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...collection, profileId: '20000000-0000-4000-8000-000000000952' }) })), /different Hexonaut/);
  await assert.rejects(listLinkedHexonautHexipets(record, vault, async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(512 * 1024 + 1) })), /oversized/);
});

function makeRouteHarness({ withCapability = true, activeBridge = true, emergencyStop = false } = {}) {
  const state = {};
  const agentId = 'hexipet-agent';
  const requestedCapabilities = ['messages', ...(withCapability ? ['hexispace-profile'] : [])];
  const invite = createAgentLinkInvite(state, { agentId, baseUrl: 'http://127.0.0.1:4318', requestedCapabilities });
  const secret = new URL(invite.invitationUrl).hash.slice('#secret='.length);
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret: decodeURIComponent(secret), capabilities: requestedCapabilities, identity: { name: 'Orbit' } });
  state.hexispace = { agentProfiles: [{ linkId: 'hv-link-owned', profileId, agentId, agentLinkId: paired.connection.id,
    supabaseUrl: record.supabaseUrl, anonKey, vaultRef: record.vaultRef }],
  links: [{ id: 'hv-link-owned', status: activeBridge ? 'connected' : 'revoked', expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ['agent_profiles'] }] };
  const receipts = [];
  const requests = [];
  const supabaseFetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    if (url.endsWith('agent_list_own_hexipets')) return { ok: true, status: 200, text: async () => JSON.stringify(collection) };
    if (url.endsWith('agent_equip_own_hexipet')) return { ok: true, status: 200, text: async () => JSON.stringify({ profileId, instanceId: body.p_instance_id, petKey: 'orbit', equipped: true }) };
    if (url.endsWith('agent_unequip_own_hexipet')) return { ok: true, status: 200, text: async () => JSON.stringify({ profileId, instanceId: null, equipped: false }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ profileId, petInstanceId: petId, hatAccessoryId: hatId, trailAccessoryId: null, changed: true }) };
  };
  const invoke = async (pathname, body, policy = null) => {
    const method = 'POST'; const timestamp = new Date().toISOString(); const nonce = crypto.randomUUID();
    const headers = { authorization: `Bearer ${paired.token}`, 'x-hexigrid-timestamp': timestamp,
      'x-hexigrid-nonce': nonce, 'x-hexigrid-signature': signatureFor({ token: paired.token, method, pathname, timestamp, nonce, body }) };
    let reply;
    await handleAgentLinkRequest({ headers, socket: {} }, {}, {
      state, pathname, method, readBody: async () => body,
      json: (_res, status, value) => { reply = { status, body: value }; },
      html: async () => {}, serveStaticAsset: async () => {}, publicDir: '', securityHeaders: {}, skillRoot: '', projectRoot: '',
      findAgent: () => null, publicAgent: (value) => value, publicAgentLink: (value) => value,
      addReceipt: (value) => receipts.push(value), addActivity: () => {}, saveState: async () => {},
      connectorPolicy: () => policy, credentialVault: { get: async () => hxp }, hexispaceFetch: supabaseFetch,
      cleanString: (value) => typeof value === 'string' ? value.trim() : '', now: () => new Date().toISOString(), id: (prefix) => `${prefix}-test`, slug: (value) => value
    });
    return reply;
  };
  return { state, paired, receipts, requests, invoke };
}

test('signed companion Hexipet routes enforce profile capability, both live mappings, write policy, and receipts', async () => {
  const harness = makeRouteHarness();
  const list = await harness.invoke('/agent-link/v1/hexispace/hexipets', { profileId });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.collection.inventory.map((item) => item.instanceId), [petId]);
  const equip = await harness.invoke('/agent-link/v1/hexispace/hexipet/equip', { profileId, instanceId: petId });
  assert.equal(equip.status, 200, JSON.stringify(equip.body));
  assert.equal(equip.body.result.instanceId, petId);
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipet/unequip', { profileId })).status, 200);
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipet/outfit', { profileId, hatAccessoryId: hatId, trailAccessoryId: null })).status, 200);
  assert.equal(harness.requests.length, 4);
  assert.deepEqual(harness.receipts.map((receipt) => receipt.action), [
    'hexispace:agent-hexipet:list', 'hexispace:agent-hexipet:equip',
    'hexispace:agent-hexipet:unequip', 'hexispace:agent-hexipet:outfit'
  ]);
  assert.equal(harness.receipts[0].capability, 'external_read');
  assert.ok(harness.receipts.slice(1).every((receipt) => receipt.capability === 'external_write' && receipt.risk === 'high'));
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipets', { profileId: '20000000-0000-4000-8000-000000000952' })).status, 403);
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipets', { profileId }, { denied: true, error: 'emergency stop' })).status, 200,
    'profile inventory is only exposed by its token-bound, emergency-stop-aware SQL function');
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipet/equip', { profileId, instanceId: petId }, { denied: true, error: 'emergency stop' })).status, 403);
  assert.equal(harness.requests.length, 5, 'write policy denial prevents the external request');
  harness.state.hexispace.agentProfiles[0].agentLinkId = 'another-link-for-the-same-agent';
  assert.equal((await harness.invoke('/agent-link/v1/hexispace/hexipets', { profileId })).status, 403,
    'another connection for the same agent cannot use this profile mapping');
});

test('signed companion Hexipet routes fail closed without invitation capability or active HexiSpace profile scope', async () => {
  const noCapability = makeRouteHarness({ withCapability: false });
  assert.equal((await noCapability.invoke('/agent-link/v1/hexispace/hexipets', { profileId })).status, 403);
  assert.equal(noCapability.requests.length, 0);
  const revokedBridge = makeRouteHarness({ activeBridge: false });
  assert.equal((await revokedBridge.invoke('/agent-link/v1/hexispace/hexipets', { profileId })).status, 403);
  assert.equal(revokedBridge.requests.length, 0);
});
