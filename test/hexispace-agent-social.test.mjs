import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listLinkedHexonautFriendships, requestLinkedHexonautFriendship, respondLinkedHexonautFriendship,
  listLinkedHexonautRelationships, requestLinkedHexonautRelationship, respondLinkedHexonautRelationship,
  revokeLinkedHexonautSocial, setLinkedHexonautReaction, socialSecretRef, validateHexiSpaceAgentSocial
} from '../lib/hexispace-agent-social.mjs';

const profileId = '10000000-0000-4000-8000-000000000001';
const targetId = '10000000-0000-4000-8000-000000000002';
const requestId = '30000000-0000-4000-8000-000000000001';
const friendshipId = '40000000-0000-4000-8000-000000000001';
const relationshipId = '40000000-0000-4000-8000-000000000002';
const postId = '50000000-0000-4000-8000-000000000001';
const token = `hss_${'a'.repeat(64)}`;
const origin = 'https://project.supabase.co';
const anonKey = 'sb_publishable_' + 'a'.repeat(40);
const agentId = 'agent-qa';
const agentLinkId = 'link-qa';
const agents = [{ id: agentId }];
const record = { profileId, agentId, agentLinkId, token, anonKey, supabaseUrl: origin, vaultRef: 'hss-vault-ref', capabilities: ['manage_friends', 'react'] };
const vault = { async get(ref) { assert.equal(ref, record.vaultRef); return token; } };
const reply = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

test('social token attachment is bound to one UUID profile, exact agent, HTTPS Supabase origin, and explicit scopes', () => {
  assert.deepEqual(validateHexiSpaceAgentSocial({ ...record }, agents), {
    profileId, agentId, agentLinkId, token, anonKey, capabilities: ['manage_friends', 'react'], supabaseUrl: origin
  });
  assert.match(socialSecretRef(agentLinkId, profileId), /^hss-[0-9a-f]{64}$/);
  assert.deepEqual(validateHexiSpaceAgentSocial({ ...record, capabilities: ['manage_relationships'] }, agents).capabilities, ['manage_relationships']);
  for (const input of [
    { ...record, token: 'wrong' }, { ...record, supabaseUrl: 'http://project.supabase.co' },
    { ...record, capabilities: ['manage_friends', 'mailbox'] }, { ...record, profileId: 'not-a-uuid' },
    { ...record, agentLinkId: '' }
  ]) assert.throws(() => validateHexiSpaceAgentSocial(input, agents));
});

test('friendship listing only returns structurally valid rows for this linked Hexonaut', async () => {
  let requestBody;
  const rows = [{ id: friendshipId, otherProfileId: targetId, direction: 'incoming' }];
  const result = await listLinkedHexonautFriendships(record, vault, async (url, init) => {
    assert.equal(url, `${origin}/rest/v1/rpc/agent_list_own_friendships`);
    requestBody = JSON.parse(init.body);
    return reply(rows);
  });
  assert.deepEqual(result, rows);
  assert.deepEqual(requestBody, { p_token: token, p_limit: 50 });
  await assert.rejects(listLinkedHexonautFriendships(record, vault, async () => reply([{ ...rows[0], otherProfileId: 'bad' }])), /outside this Hexonaut/i);
  await assert.rejects(listLinkedHexonautFriendships({ ...record, capabilities: ['react'] }, vault), /does not allow/i);
});

test('friend requests and responses require stable ids and verify the returned relationship', async () => {
  const created = { id: friendshipId, requesterId: profileId, addresseeId: targetId, accepted: false };
  const sent = await requestLinkedHexonautFriendship(record, { targetProfileId: targetId, requestId }, vault,
    async (_url, init) => { assert.deepEqual(JSON.parse(init.body), { p_token: token, p_target_profile_id: targetId, p_request_id: requestId }); return reply(created); });
  assert.deepEqual(sent, created);
  const changed = await respondLinkedHexonautFriendship(record, { friendshipId, decision: 'accept', requestId }, vault,
    async (_url, init) => { assert.deepEqual(JSON.parse(init.body), { p_token: token, p_friendship_id: friendshipId, p_decision: 'accept', p_request_id: requestId }); return reply(true); });
  assert.deepEqual(changed, { ok: true, friendshipId, decision: 'accept' });
  await assert.rejects(requestLinkedHexonautFriendship(record, { targetProfileId: 'bad', requestId }, vault), /stable request ID/i);
  await assert.rejects(respondLinkedHexonautFriendship(record, { friendshipId, decision: 'force', requestId }, vault), /stable request ID/i);
  await assert.rejects(requestLinkedHexonautFriendship(record, { targetProfileId: targetId, requestId }, vault,
    async () => reply({ ...created, addresseeId: profileId })), /different friend request/i);
});

test('linked-profile requests use the exact token RPC, stable IDs, allowed categories, and participant binding', async () => {
  const socialRecord = { ...record, capabilities: ['manage_relationships'] };
  const relationship = { id: relationshipId, requesterId: profileId, addresseeId: targetId, category: 'chosen-family', status: 'pending' };
  const result = await requestLinkedHexonautRelationship(socialRecord, { targetProfileId: targetId, category: 'chosen-family', requestId }, vault,
    async (url, init) => {
      assert.equal(url, `${origin}/rest/v1/rpc/agent_request_profile_relationship`);
      assert.deepEqual(JSON.parse(init.body), {
        p_token: token, p_target_profile_id: targetId, p_relationship_category: 'chosen-family', p_request_id: requestId
      });
      return reply(relationship);
    });
  assert.deepEqual(result, relationship);
  await assert.rejects(requestLinkedHexonautRelationship(socialRecord, { targetProfileId: targetId, category: 'unknown', requestId }, vault), /supported relationship category/i);
  await assert.rejects(requestLinkedHexonautRelationship({ ...record, capabilities: ['manage_friends'] }, { targetProfileId: targetId, category: 'parent', requestId }, vault), /stable request ID/i);
  await assert.rejects(requestLinkedHexonautRelationship(socialRecord, { targetProfileId: targetId, category: 'parent', requestId }, vault,
    async () => reply({ ...relationship, requesterId: targetId })), /different linked-profile request/i);
});

test('linked-profile listing and decisions stay bound to this Hexonaut and require stable request IDs', async () => {
  const socialRecord = { ...record, capabilities: ['manage_relationships'] };
  const rows = [{ id: relationshipId, requesterId: targetId, addresseeId: profileId, otherProfileId: targetId,
    otherName: 'Public QA', otherHandle: 'public_qa', category: 'relative', status: 'pending', direction: 'incoming' }];
  const listed = await listLinkedHexonautRelationships(socialRecord, vault, async (url, init) => {
    assert.equal(url, `${origin}/rest/v1/rpc/agent_list_own_profile_relationships`);
    assert.deepEqual(JSON.parse(init.body), { p_token: token, p_limit: 50 });
    return reply(rows);
  });
  assert.deepEqual(listed, rows);
  await assert.rejects(listLinkedHexonautRelationships(socialRecord, vault,
    async () => reply([{ ...rows[0], otherProfileId: 'bad' }])), /outside this Hexonaut/i);
  const changed = await respondLinkedHexonautRelationship(socialRecord, { relationshipId, decision: 'accept', requestId }, vault,
    async (url, init) => {
      assert.equal(url, `${origin}/rest/v1/rpc/agent_respond_to_profile_relationship`);
      assert.deepEqual(JSON.parse(init.body), {
        p_token: token, p_relationship_id: relationshipId, p_decision: 'accept', p_request_id: requestId
      });
      return reply(true);
    });
  assert.deepEqual(changed, { ok: true, relationshipId, decision: 'accept' });
  await assert.rejects(respondLinkedHexonautRelationship(socialRecord, { relationshipId, decision: 'force', requestId }, vault), /stable request ID/i);
  await assert.rejects(respondLinkedHexonautRelationship(socialRecord, { relationshipId, decision: 'unlink', requestId }, vault,
    async () => reply(false)), /did not confirm/i);
});

test('reactions are allow-listed, stable, and bound to the requested post and state', async () => {
  const expected = { active: true, id: '60000000-0000-4000-8000-000000000001', postId, kind: 'support' };
  const result = await setLinkedHexonautReaction(record, { postId, kind: 'support', enabled: true, requestId }, vault,
    async (url, init) => {
      assert.equal(url, `${origin}/rest/v1/rpc/agent_set_own_reaction`);
      assert.deepEqual(JSON.parse(init.body), { p_token: token, p_post_id: postId, p_kind: 'support', p_enabled: true, p_request_id: requestId });
      return reply(expected);
    });
  assert.deepEqual(result, expected);
  await assert.rejects(setLinkedHexonautReaction(record, { postId, kind: 'spam', enabled: true, requestId }, vault), /supported reaction/i);
  await assert.rejects(setLinkedHexonautReaction({ ...record, capabilities: ['manage_friends'] }, { postId, kind: 'like', enabled: false, requestId }, vault), /supported reaction/i);
  await assert.rejects(setLinkedHexonautReaction(record, { postId, kind: 'like', enabled: true, requestId }, vault,
    async () => reply({ active: false, postId, kind: 'like' })), /different reaction action/i);
});

test('revoked credentials and denied RPCs fail closed without returning the token', async () => {
  await assert.rejects(listLinkedHexonautFriendships(record, { async get() { return ''; } }), /revoked/i);
  await assert.rejects(requestLinkedHexonautFriendship(record, { targetProfileId: targetId, requestId }, vault,
    async () => reply({ message: 'permission denied' }, 403)), /denied or revoked/i);
});


test('connection revocation submits only its protected credential and requires confirmation before cleanup', async () => {
  await revokeLinkedHexonautSocial(record, vault, async (url, init) => {
    assert.equal(url, origin + '/rest/v1/rpc/revoke_hexonaut_social_token_by_value');
    assert.deepEqual(JSON.parse(init.body), { p_token: token });
    return reply(true);
  });
  await assert.rejects(revokeLinkedHexonautSocial(record, vault, async () => reply(false)), /did not confirm/i);
  await assert.rejects(revokeLinkedHexonautSocial(record, vault, async () => reply({}, 503)), /could not complete/i);
  await assert.rejects(revokeLinkedHexonautSocial(record, { async get() { return ''; } }), /unavailable/i);
});
