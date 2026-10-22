import crypto from 'node:crypto';
import { normalizeHexiSpaceConversations } from './hexispace-conversations.mjs';
import { normalizeHexiSpaceArtifacts } from './hexispace-artifacts.mjs';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCOPES = Object.freeze(['messages', 'scheduled_work', 'mailboxes', 'emergency_stop', 'artifacts', 'agent_profiles', 'agent_posts', 'agent_comments', 'agent_friends', 'agent_relationships', 'agent_reactions']);
const SUPPORT_MATRIX = Object.freeze({
  link: { signedHttp: 'supported', mcpClient: 'not-advertised', browserFallback: 'pairing-only' },
  messages: { localHexiGridAgents: 'supported', externalHarnesses: 'not-advertised', providerModels: 'configured-agent-only' },
  scheduled_work: { localHexiGridAgents: 'supported-paused-until-owner-starts', externalHarnesses: 'not-advertised', providerModels: 'configured-agent-only' },
  mailboxes: { gmail: 'supported-with-owner-consent', outlook: 'supported-with-owner-consent', externalHarnesses: 'not-advertised' },
  emergency_stop: { localTasks: 'supported', runnerJobs: 'supported', externalHarnesses: 'not-advertised' },
  artifacts: { providerUrls: 'owner-consented-external-link', sandboxFiles: 'local-scoped-download', inlinePreviews: 'safe-text-metadata-only', fallback: 'expiring-attachment-link' }
});
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const safeEqual = (left, right) => { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const deliveryTokens = new Map();
const LEGACY_CONNECTOR_STATE_KEY = 'hexiverse';

function safeConnectorOrigin(value) {
  const raw = clean(value, 500);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return '';
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '[::ffff:7f00:1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return '';
    return parsed.origin;
  } catch { return ''; }
}

export const HEXISPACE_CONNECTOR_VERSION = 1;
export const HEXISPACE_SCOPES = SCOPES;

export function normalizeHexiSpaceConnector(state) {
  const legacy = state[LEGACY_CONNECTOR_STATE_KEY];
  state.hexispace = state.hexispace && typeof state.hexispace === 'object'
    ? state.hexispace
    : legacy && typeof legacy === 'object' ? legacy : {};
  if (Object.prototype.hasOwnProperty.call(state, LEGACY_CONNECTOR_STATE_KEY)) delete state[LEGACY_CONNECTOR_STATE_KEY];
  state.hexispace.pairings = Array.isArray(state.hexispace.pairings) ? state.hexispace.pairings.filter((item) => item && typeof item.id === 'string') : [];
  state.hexispace.links = Array.isArray(state.hexispace.links) ? state.hexispace.links.filter((item) => item && typeof item.id === 'string').map((item) => ({ ...item, scopes: safeScopes(item.scopes), status: item.status === 'revoked' ? 'revoked' : 'connected' })) : [];
  state.hexispace.mailboxes = Array.isArray(state.hexispace.mailboxes)
    ? state.hexispace.mailboxes.filter((item) => item && typeof item.id === 'string' && typeof item.linkId === 'string' && ['gmail', 'outlook'].includes(item.provider)).map((item) => ({
      id: item.id,
      linkId: item.linkId,
      profileId: clean(item.profileId, 120),
      provider: item.provider,
      email: clean(item.email, 320),
      scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope) => typeof scope === 'string').slice(0, 16) : [],
      vaultRef: clean(item.vaultRef, 120),
      connectedAt: clean(item.connectedAt, 40),
      updatedAt: clean(item.updatedAt, 40)
    }))
    : [];
  state.hexispace.agentProfiles = Array.isArray(state.hexispace.agentProfiles)
    ? state.hexispace.agentProfiles.filter((item) => item && typeof item.profileId === 'string' && typeof item.agentId === 'string' && typeof item.vaultRef === 'string').map((item) => ({
      linkId: clean(item.linkId, 120), profileId: clean(item.profileId, 40), agentId: clean(item.agentId, 120),
      agentLinkId: clean(item.agentLinkId, 120),
      supabaseUrl: clean(item.supabaseUrl, 300), anonKey: clean(item.anonKey, 2000), vaultRef: clean(item.vaultRef, 160),
      connectedAt: clean(item.connectedAt, 40)
    })) : [];
  state.hexispace.agentPosts = Array.isArray(state.hexispace.agentPosts)
    ? state.hexispace.agentPosts.filter((item) => item && typeof item.profileId === 'string' && typeof item.agentId === 'string' && typeof item.vaultRef === 'string').map((item) => ({
      linkId: clean(item.linkId, 120), profileId: clean(item.profileId, 40), agentId: clean(item.agentId, 120),
      agentLinkId: clean(item.agentLinkId, 120),
      supabaseUrl: clean(item.supabaseUrl, 300), anonKey: clean(item.anonKey, 2000), vaultRef: clean(item.vaultRef, 160),
      maxVisibility: ['private', 'friends', 'public'].includes(item.maxVisibility) ? item.maxVisibility : 'private',
      connectedAt: clean(item.connectedAt, 40)
    })) : [];
  state.hexispace.agentComments = Array.isArray(state.hexispace.agentComments)
    ? state.hexispace.agentComments.filter((item) => item && typeof item.profileId === 'string' && typeof item.agentId === 'string' && typeof item.vaultRef === 'string').map((item) => ({
      linkId: clean(item.linkId, 120), profileId: clean(item.profileId, 40), agentId: clean(item.agentId, 120),
      agentLinkId: clean(item.agentLinkId, 120),
      supabaseUrl: clean(item.supabaseUrl, 300), anonKey: clean(item.anonKey, 2000), vaultRef: clean(item.vaultRef, 160),
      maxVisibility: ['private', 'friends', 'public'].includes(item.maxVisibility) ? item.maxVisibility : 'private',
      connectedAt: clean(item.connectedAt, 40)
    })) : [];
  state.hexispace.agentSocials = Array.isArray(state.hexispace.agentSocials)
    ? state.hexispace.agentSocials.filter((item) => item && typeof item.profileId === 'string'
      && typeof item.agentId === 'string' && typeof item.agentLinkId === 'string' && typeof item.vaultRef === 'string')
      .map((item) => ({
        linkId: clean(item.linkId, 120), profileId: clean(item.profileId, 40), agentId: clean(item.agentId, 120),
        agentLinkId: clean(item.agentLinkId, 160), supabaseUrl: clean(item.supabaseUrl, 300),
        anonKey: clean(item.anonKey, 2000), vaultRef: clean(item.vaultRef, 160),
        capabilities: [...new Set((Array.isArray(item.capabilities) ? item.capabilities : [])
          .filter((capability) => ['manage_friends', 'manage_relationships', 'react'].includes(capability)))],
        connectedAt: clean(item.connectedAt, 40)
      })).filter((item) => item.capabilities.length > 0)
    : [];
  normalizeHexiSpaceConversations(state);
  normalizeHexiSpaceArtifacts(state);
  return state.hexispace;
}

function safeScopes(value) { return [...new Set((Array.isArray(value) ? value : []).filter((item) => SCOPES.includes(item)))]; }

export function publicManifest({ version = '0.0.0', origin = '' } = {}) {
  return { protocol: 'hexispace-control', protocolVersion: HEXISPACE_CONNECTOR_VERSION, hexigridVersion: String(version), origin: clean(origin, 500), capabilities: [...SCOPES], supportMatrix: SUPPORT_MATRIX, artifacts: SUPPORT_MATRIX.artifacts, security: { pairing: 'single-use-code', tokens: 'short-lived-scoped-bearer', credentials: 'never-shared-by-default', mailboxCredentials: 'owner-approved-to-local-os-vault-only' } };
}

export function createHexiSpacePairing(state, { origin = '', scopes = SCOPES } = {}) {
  const connector = normalizeHexiSpaceConnector(state);
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const id = `hv-pair-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const pairing = { id, code, origin: safeConnectorOrigin(origin), scopes: safeScopes(scopes), createdAt, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(), approvedAt: null, usedAt: null, tokenHash: null };
  connector.pairings = connector.pairings.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now()).slice(-49);
  connector.pairings.push(pairing);
  return { id, code, scopes: pairing.scopes, createdAt, expiresAt: pairing.expiresAt, approved: false };
}

export function approveHexiSpacePairing(state, { code, scopes = [] } = {}) {
  const connector = normalizeHexiSpaceConnector(state);
  const pairing = connector.pairings.find((item) => safeEqual(item.code, clean(code, 20).toUpperCase()) && !item.usedAt && Date.parse(item.expiresAt) > Date.now());
  if (!pairing) { const error = new Error('That HexiSpace pairing code is invalid or expired.'); error.status = 404; throw error; }
  pairing.approvedAt = new Date().toISOString();
  const approvedScopes = safeScopes(scopes);
  pairing.scopes = pairing.scopes.filter((scope) => approvedScopes.includes(scope));
  const token = crypto.randomBytes(32).toString('base64url');
  pairing.tokenHash = digest(token);
  const link = { id: `hv-link-${crypto.randomUUID()}`, origin: pairing.origin, scopes: pairing.scopes, tokenHash: pairing.tokenHash, status: 'connected', createdAt: pairing.approvedAt, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), revokedAt: null, lastSeenAt: pairing.approvedAt };
  connector.links.push(link);
  deliveryTokens.set(link.id, token);
  return { id: link.id, scopes: link.scopes, expiresAt: link.expiresAt, token };
}

export function pairingStatus(state, id) {
  const connector = normalizeHexiSpaceConnector(state);
  const pairing = connector.pairings.find((item) => item.id === clean(id, 200));
  if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) return { status: 'expired' };
  if (!pairing.approvedAt) return { status: 'pending', expiresAt: pairing.expiresAt };
  if (pairing.usedAt) return { status: 'used' };
  const link = connector.links.find((item) => safeEqual(item.tokenHash, pairing.tokenHash));
  if (!link) return { status: 'pending', expiresAt: pairing.expiresAt };
  return { status: 'approved', linkId: link.id, expiresAt: link.expiresAt };
}

export function consumeHexiSpacePairingToken(state, pairingId) {
  const connector = normalizeHexiSpaceConnector(state);
  const pairing = connector.pairings.find((item) => item.id === clean(pairingId, 200));
  if (!pairing || pairing.usedAt) return null;
  const link = connector.links.find((item) => safeEqual(item.tokenHash, pairing.tokenHash));
  const token = link ? deliveryTokens.get(link.id) : null;
  if (!link || !token) return null;
  deliveryTokens.delete(link.id);
  pairing.usedAt = new Date().toISOString();
  return { linkId: link.id, token, expiresAt: link.expiresAt };
}

export function authenticateHexiSpace(state, authorization, scope = '') {
  const connector = normalizeHexiSpaceConnector(state);
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  const link = connector.links.find((item) => item.status === 'connected' && Date.parse(item.expiresAt) > Date.now() && safeEqual(item.tokenHash, digest(token)));
  if (!link) { const error = new Error('This HexiSpace connection is not authorized.'); error.status = 401; throw error; }
  if (scope && !link.scopes.includes(scope)) { const error = new Error(`This HexiSpace connection does not have the ${scope} permission.`); error.status = 403; throw error; }
  link.lastSeenAt = new Date().toISOString();
  return link;
}

/** Minimal agent fields needed to render and address an agent from HexiSpace. */
export function linkedAgentSummary(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const id = clean(agent.id, 120);
  const name = clean(agent.name, 120);
  if (!id || !name) return null;
  const allowedStatuses = new Set(['active', 'connected', 'idle', 'running', 'paused', 'sleeping', 'offline', 'error', 'archived']);
  const status = clean(agent.status, 24).toLowerCase();
  return {
    id,
    name,
    status: allowedStatuses.has(status) ? status : 'unknown',
    model: clean(agent.model, 160)
  };
}

/** Owner-only connection list; never return bearer secrets or mailbox vault references. */
export function hexispaceLinkSummaries(state) {
  const connector = normalizeHexiSpaceConnector(state);
  return connector.links.map((link) => {
    let origin = '';
    try {
      const url = new URL(String(link.origin || ''));
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) origin = url.origin;
    } catch { /* Invalid origins are shown as unknown, never reflected raw. */ }
    const expired = !Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now();
    const status = link.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'connected';
    return {
      id: clean(link.id, 200),
      origin,
      scopes: safeScopes(link.scopes),
      status,
      createdAt: clean(link.createdAt, 40),
      expiresAt: clean(link.expiresAt, 40),
      lastSeenAt: clean(link.lastSeenAt, 40),
      mailboxCleanupPending: status === 'connected' ? 0 : connector.mailboxes.filter((mailbox) => mailbox.linkId === link.id).length
    };
  }).filter((link) => link.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** A bridge token may revoke only the link represented by that same token. */
export function revokeHexiSpaceLinkByToken(state, authorization) {
  const link = authenticateHexiSpace(state, authorization);
  const linkId = link.id;
  return revokeHexiSpaceLink(state, linkId) ? linkId : null;
}

export function revokeHexiSpaceLink(state, linkId) {
  const connector = normalizeHexiSpaceConnector(state);
  const link = connector.links.find((item) => item.id === clean(linkId, 200));
  if (!link) return false;
  link.status = 'revoked'; link.revokedAt = new Date().toISOString(); link.tokenHash = digest(crypto.randomBytes(32));
  return true;
}
