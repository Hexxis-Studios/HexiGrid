import test from 'node:test';
import assert from 'node:assert/strict';
import { profileSecretRef, updateLinkedHexonautProfile, validateHexiSpaceAgentProfile } from '../lib/hexispace-agent-profile.mjs';
import { createHexiSpacePairing, approveHexiSpacePairing } from '../lib/hexispace-connector.mjs';
import { handleHexiSpaceRequest } from '../lib/hexispace-routes.mjs';

const profileId = '20000000-0000-4000-8000-000000000191';
const token = `hxp_${'a'.repeat(64)}`;
const anonKey = 'a'.repeat(64);
const agents = [{ id: 'agent-exampleagent' }];
const input = { profileId, agentId: 'agent-exampleagent', token, anonKey, supabaseUrl: 'https://project.supabase.co' };

test('profile link accepts one known agent and one HTTPS Supabase origin', () => {
  assert.deepEqual(validateHexiSpaceAgentProfile(input, agents), input);
  assert.throws(() => validateHexiSpaceAgentProfile({ ...input, agentId: 'other' }, agents), /Choose one/);
  assert.throws(() => validateHexiSpaceAgentProfile({ ...input, supabaseUrl: 'http://127.0.0.1:4318' }, agents), /HTTPS Supabase/);
  assert.throws(() => validateHexiSpaceAgentProfile({ ...input, supabaseUrl: 'https://project.supabase.co.evil.test' }, agents), /HTTPS Supabase/);
  assert.throws(() => validateHexiSpaceAgentProfile({ ...input, token: 'short' }, agents), /credential/);
  const ref = profileSecretRef('hv-link-123', profileId);
  assert.match(ref, /^hxp-[a-f0-9]{64}$/);
  assert.ok(ref.length <= 90);
  assert.equal(ref, profileSecretRef('hv-link-123', profileId));
  assert.notEqual(ref, profileSecretRef('hv-link-124', profileId));
  assert.notEqual(ref, profileSecretRef('hv-link-123', '20000000-0000-4000-8000-000000000192'));
  assert.ok(profileSecretRef(`hv-link-${'a'.repeat(160)}`, profileId).length <= 90);
});

test('profile edits use the protected token, omit unchanged fields, and return only matching profile', async () => {
  const record = { profileId, supabaseUrl: 'https://project.supabase.co', anonKey, vaultRef: 'private-ref' };
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ id: profileId, bio: 'I choose my own words' }) };
  };
  const result = await updateLinkedHexonautProfile(record, { bio: 'I choose my own words' }, { get: async () => token }, fetcher);
  assert.equal(result.id, profileId);
  assert.equal(request.url, 'https://project.supabase.co/rest/v1/rpc/agent_update_own_profile');
  assert.equal(JSON.parse(request.options.body).p_token, token);
  assert.equal(JSON.parse(request.options.body).p_display_name, undefined);
  assert.equal(JSON.parse(request.options.body).p_avatar_url, null);
  assert.equal(request.options.headers.Authorization, `Bearer ${anonKey}`);
  await updateLinkedHexonautProfile(record, {
    orientation: 'A self-described orientation',
    orientationVisibility: 'friends',
    relationshipStatusVisibility: 'private'
  }, { get: async () => token }, fetcher);
  const personalFields = JSON.parse(request.options.body);
  assert.equal(personalFields.p_orientation, 'A self-described orientation');
  assert.equal(personalFields.p_orientation_visibility, 'friends');
  assert.equal(personalFields.p_relationship_status_visibility, 'private');
  await updateLinkedHexonautProfile({ ...record, anonKey: `sb_publishable_${'b'.repeat(40)}` }, { bio: 'New' }, { get: async () => token }, fetcher);
  assert.equal(request.options.headers.Authorization, undefined);
  await updateLinkedHexonautProfile(record, { displayName: 'ExampleAgent' }, { get: async () => token }, fetcher);
  assert.equal(JSON.parse(request.options.body).p_bio, undefined);
  await assert.rejects(updateLinkedHexonautProfile(record, { ownerId: 'other' }, { get: async () => token }, fetcher), /Only this Hexonaut/);
  await assert.rejects(updateLinkedHexonautProfile(record, { bio: 'x' }, { get: async () => '' }, fetcher), /protected credential/);
  await assert.rejects(updateLinkedHexonautProfile(record, { bio: 'x' }, { get: async () => token },
    async () => ({ ok: true, json: async () => ({ id: 'another-profile' }) })), /different profile/);
});

test('a browser can revoke only its own profile access even when work mode denies session actions', async () => {
  const state = { hexispace: { pairings: [], links: [], agentProfiles: [] } };
  const pair = (origin) => {
    const pending = createHexiSpacePairing(state, { origin, scopes: ['agent_profiles'] });
    return approveHexiSpacePairing(state, { code: pending.code, scopes: ['agent_profiles'] });
  };
  const owner = pair('https://hexispace.example');
  const other = pair('https://other.example');
  const vaultRef = profileSecretRef(owner.id, profileId);
  state.hexispace.agentProfiles.push({ linkId: owner.id, profileId, agentId: agents[0].id,
    supabaseUrl: input.supabaseUrl, anonKey, vaultRef, connectedAt: new Date().toISOString() });
  const removed = [];
  const call = async (token) => {
    let reply;
    await handleHexiSpaceRequest({ headers: { origin: 'https://hexispace.example', authorization: `Bearer ${token}`, host: 'localhost:4318' } }, {}, {
      state, url: new URL('http://localhost:4318/api/hexispace/v1/agent-profiles/detach'),
      pathname: '/api/hexispace/v1/agent-profiles/detach', method: 'POST',
      isTunnelRequest: () => false, networkGate: () => false, isHostRequest: () => true,
      readBody: async () => ({ profileId }), json: (_res, status, body) => { reply = { status, body }; },
      authStatus: () => ({ authenticated: false }), saveState: async () => {}, addReceipt: () => {},
      credentialVault: { remove: async (ref) => { removed.push(ref); } }, mediaDir: '.',
      connectorPolicy: () => { throw new Error('Revocation must not depend on work mode.'); },
      cleanString: (value) => String(value || '').trim(), now: () => new Date().toISOString()
    });
    return reply;
  };
  assert.equal((await call(other.token)).status, 404);
  assert.deepEqual(removed, []);
  assert.equal((await call(owner.token)).status, 200);
  assert.deepEqual(removed, [vaultRef]);
  assert.deepEqual(state.hexispace.agentProfiles, []);
});
