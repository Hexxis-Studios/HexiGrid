import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^hsc_[0-9a-f]{64}$/;
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function validateHexiSpaceAgentComment(input, agents) {
  const profileId = clean(input?.profileId, 40);
  const agentId = clean(input?.agentId, 120);
  const token = clean(input?.token, 80);
  const anonKey = clean(input?.anonKey, 2000);
  let origin;
  try { origin = new URL(clean(input?.supabaseUrl, 300)); }
  catch { throw new Error('The HexiSpace data service address is invalid.'); }
  if (!UUID.test(profileId) || !agents.some((agent) => agent.id === agentId)) throw new Error('Choose one Hexonaut and one linked local agent.');
  if (!TOKEN.test(token) || anonKey.length < 30) throw new Error('The one-time Hexonaut comment credential is invalid.');
  if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('HexiSpace can connect only to its HTTPS Supabase project.');
  }
  return { profileId, agentId, token, anonKey, supabaseUrl: origin.origin };
}

export function commentSecretRef(linkId, profileId) {
  return `hsc-${crypto.createHash('sha256').update(`${linkId}\0${profileId}`).digest('hex')}`;
}

async function callComment(record, credentialVault, rpc, body, fetcher = fetch) {
  const token = await credentialVault.get(record.vaultRef);
  if (!TOKEN.test(String(token || ''))) throw new Error('This Hexonaut comment connection was revoked or its protected credential is unavailable.');
  const response = await fetcher(`${record.supabaseUrl}/rest/v1/rpc/${rpc}`, {
    method: 'POST', headers: {
      apikey: record.anonKey,
      ...(record.anonKey.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${record.anonKey}` }),
      'content-type': 'application/json'
    }, body: JSON.stringify({ p_token: token, ...body }), signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Hexonaut comment access was denied or revoked.' : 'HexiSpace could not complete this Hexonaut comment action.');
  return result;
}

export async function publishLinkedHexonautComment(record, input, credentialVault, fetcher = fetch) {
  const postId = clean(input?.postId, 40);
  const requestId = clean(input?.requestId, 40);
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!UUID.test(postId) || !UUID.test(requestId) || !body || body.length > 2000) {
    throw new Error('A post ID, comment text, and stable request ID are required.');
  }
  const result = await callComment(record, credentialVault, 'agent_comment_on_post', {
    p_post_id: postId, p_body: body, p_request_id: requestId
  }, fetcher);
  if (result?.author_id !== record.profileId || result?.post_id !== postId || result?.body !== body
      || !['private', 'friends', 'public'].includes(result?.visibility)) {
    throw new Error('HexiSpace returned a different comment, profile, or post; comment access was stopped.');
  }
  return result;
}

export async function listLinkedHexonautComments(record, postId, credentialVault, fetcher = fetch) {
  if (!UUID.test(String(postId || ''))) throw new Error('Choose one post to read back this Hexonaut’s comments.');
  const result = await callComment(record, credentialVault, 'agent_list_own_comments', {
    p_post_id: postId, p_limit: 20
  }, fetcher);
  if (!Array.isArray(result) || result.some((comment) => comment.author_id !== record.profileId || comment.post_id !== postId)) {
    throw new Error('HexiSpace returned comments outside this Hexonaut or post; comment access was stopped.');
  }
  return result;
}
