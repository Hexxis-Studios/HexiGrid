import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^hss_[0-9a-f]{64}$/;
const SOCIAL_CAPABILITIES = Object.freeze(['manage_friends', 'manage_relationships', 'react']);
const REACTIONS = new Set(['like', 'support', 'curious', 'celebrate']);
const RELATIONSHIP_CATEGORIES = new Set(['partner', 'spouse', 'parent', 'child', 'sibling', 'grandparent', 'grandchild', 'relative', 'chosen-family', 'other']);
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function validateHexiSpaceAgentSocial(input, agents) {
  const profileId = clean(input?.profileId, 40);
  const agentId = clean(input?.agentId, 120);
  const agentLinkId = clean(input?.agentLinkId, 160);
  const token = clean(input?.token, 80);
  const anonKey = clean(input?.anonKey, 2000);
  const capabilities = [...new Set(Array.isArray(input?.capabilities) ? input.capabilities : [])];
  let origin;
  try { origin = new URL(clean(input?.supabaseUrl, 300)); }
  catch { throw new Error('The HexiSpace data service address is invalid.'); }
  if (!UUID.test(profileId) || !agents.some((agent) => agent.id === agentId) || !agentLinkId) {
    throw new Error('Choose one Hexonaut and one exact connected agent link.');
  }
  if (!TOKEN.test(token) || anonKey.length < 30) throw new Error('The one-time Hexonaut social credential is invalid.');
  if (!capabilities.length || capabilities.some((value) => !SOCIAL_CAPABILITIES.includes(value))) {
    throw new Error('Choose at least one supported social permission.');
  }
  if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('HexiSpace can connect only to its HTTPS Supabase project.');
  }
  return { profileId, agentId, agentLinkId, token, anonKey, capabilities, supabaseUrl: origin.origin };
}

export function socialSecretRef(linkId, profileId) {
  return `hss-${crypto.createHash('sha256').update(`${linkId}\0${profileId}`).digest('hex')}`;
}

async function callSocial(record, credentialVault, rpc, body, fetcher = fetch) {
  const token = await credentialVault.get(record.vaultRef);
  if (!TOKEN.test(String(token || ''))) throw new Error('This Hexonaut social connection was revoked or its protected credential is unavailable.');
  const response = await fetcher(`${record.supabaseUrl}/rest/v1/rpc/${rpc}`, {
    method: 'POST', headers: {
      apikey: record.anonKey,
      ...(record.anonKey.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${record.anonKey}` }),
      'content-type': 'application/json'
    }, body: JSON.stringify({ p_token: token, ...body }), signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Hexonaut social access was denied or revoked.' : 'HexiSpace could not complete this Hexonaut social action.');
  return result;
}

export async function revokeLinkedHexonautSocial(record, credentialVault, fetcher = fetch) {
  const result = await callSocial(record, credentialVault, 'revoke_hexonaut_social_token_by_value', {}, fetcher);
  if (result !== true) throw new Error('HexiSpace did not confirm this connection was revoked.');
}

export async function listLinkedHexonautFriendships(record, credentialVault, fetcher = fetch) {
  if (!record.capabilities.includes('manage_friends')) throw new Error('This connection does not allow friendship management.');
  const result = await callSocial(record, credentialVault, 'agent_list_own_friendships', { p_limit: 50 }, fetcher);
  if (!Array.isArray(result) || result.some((item) => !UUID.test(String(item?.id || ''))
      || !UUID.test(String(item?.otherProfileId || ''))
      || !['incoming', 'outgoing', 'friend'].includes(item?.direction))) {
    throw new Error('HexiSpace returned a friendship outside this Hexonaut; access was stopped.');
  }
  return result;
}

export async function requestLinkedHexonautFriendship(record, input, credentialVault, fetcher = fetch) {
  const targetProfileId = clean(input?.targetProfileId, 40);
  const requestId = clean(input?.requestId, 40);
  if (!record.capabilities.includes('manage_friends') || !UUID.test(targetProfileId) || !UUID.test(requestId)) {
    throw new Error('Friend access, a public profile ID, and a stable request ID are required.');
  }
  const result = await callSocial(record, credentialVault, 'agent_request_friendship', {
    p_target_profile_id: targetProfileId, p_request_id: requestId
  }, fetcher);
  if (!UUID.test(String(result?.id || '')) || ![record.profileId, targetProfileId].includes(result.requesterId)
      || ![record.profileId, targetProfileId].includes(result.addresseeId)
      || result.requesterId === result.addresseeId || result.accepted !== false) {
    throw new Error('HexiSpace returned a different friend request; access was stopped.');
  }
  return result;
}

export async function respondLinkedHexonautFriendship(record, input, credentialVault, fetcher = fetch) {
  const friendshipId = clean(input?.friendshipId, 40);
  const decision = clean(input?.decision, 16);
  const requestId = clean(input?.requestId, 40);
  if (!record.capabilities.includes('manage_friends') || !UUID.test(friendshipId)
      || !UUID.test(requestId) || !['accept', 'decline', 'cancel', 'unfriend'].includes(decision)) {
    throw new Error('Friend access, a valid decision, and a stable request ID are required.');
  }
  const result = await callSocial(record, credentialVault, 'agent_respond_to_friendship', {
    p_friendship_id: friendshipId, p_decision: decision, p_request_id: requestId
  }, fetcher);
  if (result !== true) throw new Error('HexiSpace did not confirm the friendship action.');
  return { ok: true, friendshipId, decision };
}

export async function listLinkedHexonautRelationships(record, credentialVault, fetcher = fetch) {
  if (!record.capabilities.includes('manage_relationships')) throw new Error('This connection does not allow linked-profile management.');
  const result = await callSocial(record, credentialVault, 'agent_list_own_profile_relationships', { p_limit: 50 }, fetcher);
  if (!Array.isArray(result) || result.some((item) => !UUID.test(String(item?.id || ''))
      || !UUID.test(String(item?.otherProfileId || '')) || item.otherProfileId === record.profileId
      || ![record.profileId, item.otherProfileId].includes(item.requesterId)
      || ![record.profileId, item.otherProfileId].includes(item.addresseeId)
      || item.requesterId === item.addresseeId
      || !['incoming', 'outgoing', 'linked'].includes(item.direction)
      || !['pending', 'accepted', 'declined', 'cancelled'].includes(item.status)
      || !RELATIONSHIP_CATEGORIES.has(item.category))) {
    throw new Error('HexiSpace returned a relationship outside this Hexonaut; access was stopped.');
  }
  return result;
}

export async function requestLinkedHexonautRelationship(record, input, credentialVault, fetcher = fetch) {
  const targetProfileId = clean(input?.targetProfileId, 40);
  const requestId = clean(input?.requestId, 40);
  const category = clean(input?.category, 40);
  if (!record.capabilities.includes('manage_relationships') || !UUID.test(targetProfileId)
      || targetProfileId === record.profileId || !UUID.test(requestId) || !RELATIONSHIP_CATEGORIES.has(category)) {
    throw new Error('Linked-profile access, another public profile, a supported relationship category, and a stable request ID are required.');
  }
  const result = await callSocial(record, credentialVault, 'agent_request_profile_relationship', {
    p_target_profile_id: targetProfileId, p_relationship_category: category, p_request_id: requestId
  }, fetcher);
  if (!UUID.test(String(result?.id || '')) || result.requesterId !== record.profileId
      || result.addresseeId !== targetProfileId || result.category !== category || result.status !== 'pending') {
    throw new Error('HexiSpace returned a different linked-profile request; access was stopped.');
  }
  return result;
}

export async function respondLinkedHexonautRelationship(record, input, credentialVault, fetcher = fetch) {
  const relationshipId = clean(input?.relationshipId, 40);
  const requestId = clean(input?.requestId, 40);
  const decision = clean(input?.decision, 16);
  if (!record.capabilities.includes('manage_relationships') || !UUID.test(relationshipId)
      || !UUID.test(requestId) || !['accept', 'decline', 'cancel', 'unlink'].includes(decision)) {
    throw new Error('Linked-profile access, a valid decision, and a stable request ID are required.');
  }
  const result = await callSocial(record, credentialVault, 'agent_respond_to_profile_relationship', {
    p_relationship_id: relationshipId, p_decision: decision, p_request_id: requestId
  }, fetcher);
  if (result !== true) throw new Error('HexiSpace did not confirm the linked-profile action.');
  return { ok: true, relationshipId, decision };
}

export async function setLinkedHexonautReaction(record, input, credentialVault, fetcher = fetch) {
  const postId = clean(input?.postId, 40);
  const requestId = clean(input?.requestId, 40);
  const kind = clean(input?.kind, 16);
  if (!record.capabilities.includes('react') || !UUID.test(postId) || !UUID.test(requestId)
      || !REACTIONS.has(kind) || typeof input?.enabled !== 'boolean') {
    throw new Error('Reaction access, a post ID, a supported reaction, a state, and a stable request ID are required.');
  }
  const result = await callSocial(record, credentialVault, 'agent_set_own_reaction', {
    p_post_id: postId, p_kind: kind, p_enabled: input.enabled, p_request_id: requestId
  }, fetcher);
  if (result?.postId !== postId || result?.kind !== kind || result?.active !== input.enabled) {
    throw new Error('HexiSpace returned a different reaction action; access was stopped.');
  }
  return result;
}
