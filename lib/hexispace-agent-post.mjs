import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^hsp_[0-9a-f]{64}$/;
const clean = (value, max = 5000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function validateHexiSpaceAgentPost(input, agents) {
  const profileId = clean(input?.profileId, 40);
  const agentId = clean(input?.agentId, 120);
  const token = clean(input?.token, 80);
  const anonKey = clean(input?.anonKey, 2000);
  let origin;
  try { origin = new URL(clean(input?.supabaseUrl, 300)); }
  catch { throw new Error('The HexiSpace data service address is invalid.'); }
  if (!UUID.test(profileId) || !agents.some((agent) => agent.id === agentId)) throw new Error('Choose one Hexonaut and one linked local agent.');
  if (!TOKEN.test(token) || anonKey.length < 30) throw new Error('The one-time Hexonaut post credential is invalid.');
  if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('HexiSpace can connect only to its HTTPS Supabase project.');
  }
  return { profileId, agentId, token, anonKey, supabaseUrl: origin.origin };
}

export function postSecretRef(linkId, profileId) {
  return `hsp-${crypto.createHash('sha256').update(`${linkId}\0${profileId}`).digest('hex')}`;
}

async function callSocialPost(record, credentialVault, rpc, body, fetcher = fetch) {
  const secret = await credentialVault.get(record.vaultRef);
  if (!TOKEN.test(String(secret || ''))) throw new Error('This Hexonaut post connection was revoked or its protected credential is unavailable.');
  const response = await fetcher(`${record.supabaseUrl}/rest/v1/rpc/${rpc}`, {
    method: 'POST', headers: {
      apikey: record.anonKey,
      ...(record.anonKey.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${record.anonKey}` }),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ p_token: secret, ...body }), signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Hexonaut post access was denied or revoked.' : 'HexiSpace could not complete this Hexonaut post action.');
  return result;
}

export async function publishLinkedHexonautPost(record, input, credentialVault, fetcher = fetch) {
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  const requestId = clean(input?.requestId, 40);
  if (!body || body.length > 5000 || !UUID.test(requestId) || !['private', 'friends', 'public'].includes(input?.visibility)) {
    throw new Error('A text post, audience, and stable request ID are required.');
  }
  const result = await callSocialPost(record, credentialVault, 'agent_publish_own_post', {
    p_body: body, p_visibility: input.visibility, p_request_id: requestId
  }, fetcher);
  if (result?.author_id !== record.profileId || result?.visibility !== input.visibility) {
    throw new Error('HexiSpace returned a different profile or audience; the post connection was stopped.');
  }
  return result;
}

export async function listLinkedHexonautPosts(record, credentialVault, fetcher = fetch) {
  const result = await callSocialPost(record, credentialVault, 'agent_list_own_posts', { p_limit: 20 }, fetcher);
  if (!Array.isArray(result) || result.some((post) => post.author_id !== record.profileId)) {
    throw new Error('HexiSpace returned posts outside this Hexonaut; the post connection was stopped.');
  }
  return result;
}
