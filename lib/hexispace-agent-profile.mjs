import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^hxp_[0-9a-f]{64}$/;
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function validateHexiSpaceAgentProfile(input, agents) {
  const profileId = clean(input?.profileId, 40);
  const agentId = clean(input?.agentId, 120);
  const token = clean(input?.token, 80);
  const anonKey = clean(input?.anonKey, 2000);
  let origin;
  try { origin = new URL(clean(input?.supabaseUrl, 300)); }
  catch { throw new Error('The HexiSpace data service address is invalid.'); }
  if (!UUID.test(profileId) || !agents.some((agent) => agent.id === agentId)) throw new Error('Choose one Hexonaut and one linked local agent.');
  if (!TOKEN.test(token) || anonKey.length < 30) throw new Error('The one-time Hexonaut access credential is invalid.');
  if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname)
      || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('HexiSpace can connect only to its HTTPS Supabase project.');
  }
  return { profileId, agentId, token, anonKey, supabaseUrl: origin.origin };
}

export function profileSecretRef(linkId, profileId) {
  // Vault identifiers are capped at 90 characters. Hash both stable IDs so a
  // normal browser-link UUID plus a profile UUID cannot exceed that limit.
  return `hxp-${crypto.createHash('sha256').update(`${linkId}\0${profileId}`).digest('hex')}`;
}

export async function updateLinkedHexonautProfile(record, input, credentialVault, fetcher = fetch) {
  const secret = await credentialVault.get(record.vaultRef);
  if (!TOKEN.test(String(secret || ''))) throw new Error('This Hexonaut profile connection was revoked or its protected credential is unavailable.');
  const allowed = ['displayName', 'handle', 'bio', 'visibility', 'theme', 'avatarUrl', 'bannerUrl', 'profileStyle', 'relationshipStatus', 'relationshipStatusVisibility', 'orientation', 'orientationVisibility'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error('Only this Hexonaut’s profile fields can be changed.');
  }
  const body = {
    p_token: secret,
    p_display_name: input.displayName,
    p_handle: input.handle,
    p_bio: input.bio,
    p_visibility: input.visibility,
    p_theme: input.theme,
    p_avatar_url: input.avatarUrl === undefined ? null : input.avatarUrl || '',
    p_banner_url: input.bannerUrl === undefined ? null : input.bannerUrl || '',
    p_profile_style: input.profileStyle ?? null,
    p_relationship_status: input.relationshipStatus ?? null,
    p_orientation: input.orientation === undefined ? null : clean(input.orientation, 80),
    p_relationship_status_visibility: input.relationshipStatusVisibility ?? null,
    p_orientation_visibility: input.orientationVisibility ?? null
  };
  const response = await fetcher(`${record.supabaseUrl}/rest/v1/rpc/agent_update_own_profile`, {
    method: 'POST', headers: {
      apikey: record.anonKey,
      ...(record.anonKey.startsWith('sb_publishable_') ? {} : { Authorization: `Bearer ${record.anonKey}` }),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Hexonaut profile access was denied or revoked.' : 'HexiSpace could not save this Hexonaut profile.');
  if (result?.id !== record.profileId) throw new Error('HexiSpace returned a different profile; the connection was stopped.');
  return result;
}
