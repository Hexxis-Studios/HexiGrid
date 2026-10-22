import crypto from 'node:crypto';
import { normalizeContinuitySnapshot, continuityCompleteness } from './continuity-transfer.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';
import { OWNER_AGENT_CAPABILITIES } from './owner-agent-access.mjs';
import { normalizeContextScope } from './dated-memory.mjs';
import { normalizeCodexThreadMemoryScopeBindings } from './agent-link-memory-scope-bindings.mjs';

export const AGENT_LINK_CAPABILITIES = Object.freeze([
  'messages', 'status', 'receipts', 'cognition', 'identity', 'token-metering',
  'continuity-export', 'memory-read', 'memory-write', 'vision', 'voice', 'tasks', 'harness-jobs', 'desktop-view', 'desktop-control', 'desktop-type', 'camera-view', 'microphone-listen', 'speaker-output', 'workspace-read', 'workspace-write', ...OWNER_AGENT_CAPABILITIES, 'hexispace-profile', 'hexispace-posts', 'hexispace-comments', 'hexispace-friends', 'hexispace-relationships', 'hexispace-reactions'
]);

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INVITE_TTL_MS = 60 * 1000;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 500;
const MAX_MESSAGES = 500;
const MAX_NONCES = 250;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const HEARTBEAT_DEGRADED_MS = 15_000;
const HEARTBEAT_OFFLINE_MS = 45_000;
const MAX_EVENT_WAIT_MS = 25_000;
const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAIRING_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PAIRING_MAX_ATTEMPTS = 8;
const eventWaiters = new Map();

const timestamp = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const clean = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const displayLabel = (value, max) => clean(value, max).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
const capabilities = (value) => [...new Set((Array.isArray(value) ? value : []).filter((item) => AGENT_LINK_CAPABILITIES.includes(item)))];
const linkError = (message, status, code) => Object.assign(new Error(message), { status, code });
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
function safeMemoryScope(value) {
  if (!value || !/^lineage-[0-9a-f-]{36}$/i.test(String(value.lineageId || ''))) return null;
  try { return { lineageId: value.lineageId, ...normalizeContextScope({ projectId: value.projectId, ...(value.topicId === undefined ? {} : { topicId: value.topicId }) }) }; }
  catch { return null; }
}

export function createAgentLinkPairingLimiter({
  maxAttempts = DEFAULT_PAIRING_MAX_ATTEMPTS,
  windowMs = DEFAULT_PAIRING_WINDOW_MS,
  now = () => Date.now()
} = {}) {
  const attempts = new Map();
  const boundedMax = Math.max(1, Math.min(100, Number(maxAttempts) || DEFAULT_PAIRING_MAX_ATTEMPTS));
  const boundedWindow = Math.max(1_000, Math.min(60 * 60 * 1000, Number(windowMs) || DEFAULT_PAIRING_WINDOW_MS));
  const normalizeKey = (value) => clean(value, 300) || 'unknown';
  const status = (value) => {
    const key = normalizeKey(value);
    const at = Number(now());
    const record = attempts.get(key);
    if (!record || at - record.startedAt >= boundedWindow) {
      attempts.delete(key);
      return { blocked: false, attempts: 0, attemptsRemaining: boundedMax, retryAfter: 0 };
    }
    return {
      blocked: record.count >= boundedMax,
      attempts: record.count,
      attemptsRemaining: Math.max(0, boundedMax - record.count),
      retryAfter: Math.max(1, Math.ceil((record.startedAt + boundedWindow - at) / 1000))
    };
  };
  return Object.freeze({
    check: status,
    recordFailure(value) {
      const key = normalizeKey(value);
      const at = Number(now());
      const record = attempts.get(key);
      if (!record || at - record.startedAt >= boundedWindow) attempts.set(key, { count: 1, startedAt: at });
      else record.count += 1;
      return status(key);
    },
    clear(value) { attempts.delete(normalizeKey(value)); },
    policy: Object.freeze({ maxAttempts: boundedMax, windowMs: boundedWindow })
  });
}

export function publicAgentLinkPairingFailure(error) {
  if (Number(error?.status) >= 500) return { status: 503, error: 'HexiGrid Link pairing is temporarily unavailable.', code: 'pairing_unavailable' };
  return { status: 401, error: 'This HexiGrid Link invitation cannot be used.', code: 'invitation_unavailable' };
}

function safeBaseUrl(value) {
  const parsed = new URL(String(value));
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('A live agent link requires HTTPS, except on this computer.');
  parsed.pathname = '/'; parsed.search = ''; parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function safeIdentity(value = {}) {
  const voice = value.voice && typeof value.voice === 'object' ? value.voice : {};
  return {
    name: displayLabel(value.name, 120) || 'Connected agent',
    framework: clean(value.framework, 80) || 'external',
    externalId: clean(value.externalId, 200),
    accountLabel: displayLabel(value.accountLabel, 120),
    avatar: displayLabel(value.avatar, 20),
    avatarUrl: clean(value.avatarUrl, 1000),
    voice: {
      name: clean(voice.name, 200),
      provider: clean(voice.provider, 100),
      externalId: clean(voice.externalId, 200)
    },
    version: clean(value.version, 40)
  };
}

export function normalizeAgentLinks(state) {
  state.agentLinkInvites = Array.isArray(state.agentLinkInvites) ? state.agentLinkInvites.filter((item) => item && typeof item.id === 'string' && typeof item.secretHash === 'string').slice(-200) : [];
  state.agentLinks = Array.isArray(state.agentLinks) ? state.agentLinks.filter((item) => item && typeof item.id === 'string' && typeof item.tokenHash === 'string' && !(item.status === 'stale' && Date.parse(item.staleAt || '') < Date.now() - STALE_RETENTION_MS)).map((item) => ({
    ...item,
    status: ['revoked', 'stale'].includes(item.status) ? item.status : 'connected',
    clientDeviceId: clean(item.clientDeviceId, 160),
    identity: safeIdentity(item.identity || item.remote),
    trustLevel: item.trustLevel === 'owner' ? 'owner' : 'scoped',
    memoryScope: safeMemoryScope(item.memoryScope),
    codexThreadMemoryScopeBindings: (() => {
      try { return normalizeCodexThreadMemoryScopeBindings(item.codexThreadMemoryScopeBindings); }
      catch { return []; }
    })(),
    capabilities: capabilities(item.capabilities).filter((capability) => item.trustLevel === 'owner' || !OWNER_AGENT_CAPABILITIES.includes(capability)),
    ownerGrantedCapabilities: item.trustLevel === 'owner'
      ? capabilities(item.ownerGrantedCapabilities || item.capabilities) : [],
    events: Array.isArray(item.events) ? item.events.slice(-MAX_EVENTS) : [],
    messages: Array.isArray(item.messages) ? item.messages.slice(-MAX_MESSAGES) : [],
    historyTruncated: item.historyTruncated === true || (item.historyTruncated === undefined &&
      (item.events?.length >= MAX_EVENTS || item.messages?.length >= MAX_MESSAGES)),
    tokenMeasurements: Array.isArray(item.tokenMeasurements) ? item.tokenMeasurements.slice(-100) : [],
    nonces: Array.isArray(item.nonces) ? item.nonces.slice(-MAX_NONCES) : [],
    nextSequence: Math.max(1, Number(item.nextSequence) || 1),
    continuitySnapshot: item.continuitySnapshot ? normalizeContinuitySnapshot(item.continuitySnapshot) : null,
    continuityDraft: item.continuityDraft && typeof item.continuityDraft === 'object' ? {
      id: clean(item.continuityDraft.id, 160) || randomId('continuity-draft'),
      status: ['awaiting-owner', 'exported'].includes(item.continuityDraft.status) ? item.continuityDraft.status : 'awaiting-owner',
      updatedAt: item.continuityDraft.updatedAt || timestamp(), protectedAtRest: 'encrypted-control-room-state', exportedAt: item.continuityDraft.exportedAt || null
    } : null
  })) : [];
  const byDevice = new Map();
  for (const connection of state.agentLinks) {
    if (connection.status !== 'connected' || !connection.clientDeviceId) continue;
    const current = byDevice.get(connection.clientDeviceId);
    if (!current) { byDevice.set(connection.clientDeviceId, connection); continue; }
    const currentAt = Date.parse(current.lastHeartbeatAt || current.lastSeenAt || current.connectedAt || '') || 0;
    const candidateAt = Date.parse(connection.lastHeartbeatAt || connection.lastSeenAt || connection.connectedAt || '') || 0;
    const keep = candidateAt > currentAt ? connection : current;
    const stale = keep === connection ? current : connection;
    markAgentLinkStale(stale, `Replaced by heartbeat-confirmed connection ${keep.id}.`);
    byDevice.set(connection.clientDeviceId, keep);
  }
  return state;
}

export function migrateAgentDoors(state) {
  normalizeAgentLinks(state);
  for (const door of Array.isArray(state.agentDoors) ? state.agentDoors : []) {
    if (!door?.id || state.agentLinks.some((item) => item.legacyDoorId === door.id)) continue;
    state.agentLinks.push({
      ...door,
      id: randomId('link'),
      legacyDoorId: door.id,
      identity: safeIdentity(door.remote),
      capabilities: capabilities(door.capabilities),
      tokenMeasurements: [], nonces: [], continuitySnapshot: null
    });
  }
  state.agentDoorInvites = [];
  state.agentDoors = [];
}

export function createAgentLinkInvite(state, { agentId = '', baseUrl, requestedCapabilities = ['messages', 'status', 'receipts', 'cognition', 'identity', 'token-metering', 'continuity-export'], ttlMs = DEFAULT_INVITE_TTL_MS } = {}) {
  normalizeAgentLinks(state);
  const boundedTtl = Math.max(MIN_INVITE_TTL_MS, Math.min(MAX_INVITE_TTL_MS, Number(ttlMs) || DEFAULT_INVITE_TTL_MS));
  const secret = crypto.randomBytes(32).toString('base64url');
  const invite = {
    id: randomId('link-invite'), agentId: clean(agentId, 160), secretHash: digest(secret),
    requestedCapabilities: capabilities(requestedCapabilities), createdAt: timestamp(),
    expiresAt: new Date(Date.now() + boundedTtl).toISOString(), usedAt: null
  };
  if (!invite.requestedCapabilities.includes('messages')) invite.requestedCapabilities.unshift('messages');
  const retentionCutoff = Date.now() - MAX_INVITE_TTL_MS;
  state.agentLinkInvites = state.agentLinkInvites.filter((item) => Date.parse(item.expiresAt) > retentionCutoff).slice(-199);
  state.agentLinkInvites.push(invite);
  const origin = safeBaseUrl(baseUrl);
  return {
    invite: publicInvite(invite),
    invitationUrl: `${origin}/agent-link/connect?invite=${encodeURIComponent(invite.id)}#secret=${encodeURIComponent(secret)}`,
    agentPrompt: `Connect to my HexiGrid through its HexiGrid Link skill. First fetch ${origin}/agent-link/skill and install the returned files in one hexigrid-link skill directory, preserving their listed paths. Read SKILL.md. Prefer the outbound companion client when Node 22 is available: run scripts/companion_client.mjs pair with the invitation below. It makes only outbound HTTPS requests and reconnects after ordinary network interruptions; do not create an SSH tunnel or inbound listener. If Node 22 is unavailable, use the signed Python client or the browser fallback described by SKILL.md. Store the returned token only in your protected secret store. Report your real identity and available capabilities. Never share account passwords, browser cookies, payment details, private keys, wallet secrets, or unrelated private data.${invite.requestedCapabilities.some((item) => item.startsWith('desktop-')) ? ' Computer view/control remains a separate owner approval even after pairing.' : ''}\n\n${origin}/agent-link/connect?invite=${encodeURIComponent(invite.id)}#secret=${encodeURIComponent(secret)}`
  };
}

export function acceptAgentLinkInvite(state, { inviteId, secret, identity = {}, capabilities: advertisedCapabilities = [], clientDeviceId = '' } = {}) {
  normalizeAgentLinks(state);
  const invite = state.agentLinkInvites.find((item) => item.id === clean(inviteId, 160));
  if (!invite || !safeEqual(invite.secretHash, digest(secret))) throw linkError('This agent-link invitation is invalid.', 401, 'invitation_invalid');
  if (invite.usedAt) throw linkError('This agent-link invitation was already used.', 409, 'invitation_consumed');
  if (Date.parse(invite.expiresAt) <= Date.now()) throw linkError('This agent-link invitation expired.', 410, 'invitation_expired');
  const boundDeviceId = clean(clientDeviceId, 160);
  const duplicate = boundDeviceId && state.agentLinks.find((item) => item.status === 'connected' && item.clientDeviceId === boundDeviceId);
  if (duplicate) throw linkError('This device already has a live HexiGrid connection. Resume it instead of pairing again.', 409, 'device_already_paired');
  const advertised = capabilities(advertisedCapabilities);
  const effective = invite.requestedCapabilities.filter((item) => advertised.includes(item) && !OWNER_AGENT_CAPABILITIES.includes(item));
  if (!effective.includes('messages')) effective.unshift('messages');
  const token = crypto.randomBytes(32).toString('base64url'); const connectedAt = timestamp();
  const connection = {
    id: randomId('link'), inviteId: invite.id, agentId: invite.agentId, tokenHash: digest(token), status: 'connected',
    identity: safeIdentity(identity), capabilities: effective, trustLevel: 'scoped', clientDeviceId: boundDeviceId, connectedAt, lastSeenAt: connectedAt,
    revokedAt: null, nextSequence: 1, events: [], messages: [], tokenMeasurements: [], nonces: [], continuitySnapshot: null
  };
  invite.usedAt = connectedAt; state.agentLinks.push(connection);
  return { connection: publicAgentLink(connection), token };
}

export function signatureFor({ token, method, pathname, timestamp: stamp, nonce, body = null }) {
  const bodyDigest = digest(stable(body));
  return crypto.createHmac('sha256', String(token)).update(`${String(method).toUpperCase()}\n${pathname}\n${stamp}\n${nonce}\n${bodyDigest}`).digest('base64url');
}

export function authenticateAgentLink(state, authorization, request = {}) {
  normalizeAgentLinks(state);
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,100})$/.exec(String(authorization || ''));
  const token = match?.[1] || ''; const tokenHash = token ? digest(token) : '';
  const connection = state.agentLinks.find((item) => safeEqual(item.tokenHash, tokenHash));
  if (!connection) throw linkError('This agent-link connection is not authorized.', 401, 'connection_unauthorized');
  if (connection.status === 'revoked' || connection.status === 'stale') throw linkError('This agent-link connection was revoked.', 410, 'connection_revoked');
  const stamp = String(request.timestamp || ''); const nonce = clean(request.nonce, 160); const signature = String(request.signature || '');
  const stampMs = Date.parse(stamp);
  if (!nonce || !Number.isFinite(stampMs) || Math.abs(Date.now() - stampMs) > SIGNATURE_WINDOW_MS || connection.nonces.includes(nonce)) {
    const error = new Error('This signed agent-link request is expired or was already used.'); error.status = 401; throw error;
  }
  const expected = signatureFor({ token, method: request.method, pathname: request.pathname, timestamp: stamp, nonce, body: request.body ?? null });
  if (!safeEqual(signature, expected)) { const error = new Error('This agent-link request signature is invalid.'); error.status = 401; throw error; }
  connection.nonces.push(nonce); connection.nonces = connection.nonces.slice(-MAX_NONCES); connection.lastSeenAt = timestamp();
  return connection;
}

export function requireAgentLinkCapability(connection, capability) {
  if (!connection.capabilities.includes(capability)) { const error = new Error(`This agent link was not granted ${capability}.`); error.status = 403; throw error; }
}

export function updateAgentLinkCapabilities(connection, requested) {
  if (!Array.isArray(requested) || requested.length > AGENT_LINK_CAPABILITIES.length) {
    throw linkError('Provide an explicit list of supported capabilities.', 400, 'invalid_capabilities');
  }
  const unknown = requested.filter((item) => !AGENT_LINK_CAPABILITIES.includes(item));
  if (unknown.length) throw linkError(`Unsupported capability: ${clean(unknown[0], 100)}.`, 400, 'invalid_capabilities');
  const next = capabilities(requested);
  if (connection.trustLevel !== 'owner' && next.some((item) => OWNER_AGENT_CAPABILITIES.includes(item))) throw linkError('Owner-agent capabilities require an explicit owner trust grant.', 403, 'owner_trust_required');
  const previous = [...connection.capabilities];
  const priorGrants = connection.trustLevel === 'owner'
    ? capabilities(connection.ownerGrantedCapabilities || previous) : previous;
  const addedGrants = next.filter((item) => !priorGrants.includes(item));
  connection.capabilities = connection.trustLevel === 'owner'
    ? [...previous.filter((item) => next.includes(item)), ...addedGrants]
    : next;
  if (connection.trustLevel === 'owner') connection.ownerGrantedCapabilities = [...next];
  return { previous, capabilities: [...connection.capabilities],
    added: connection.capabilities.filter((item) => !previous.includes(item)),
    removed: previous.filter((item) => !connection.capabilities.includes(item)),
    ...(connection.trustLevel === 'owner' ? { grantsAdded: addedGrants, grantsRemoved: priorGrants.filter((item) => !next.includes(item)) } : {}) };
}

export function toggleOwnerAgentLinkCapabilities(connection, requested) {
  if (connection.status !== 'connected' || connection.trustLevel !== 'owner') throw linkError('Self-service toggles require an owner-trusted connected Link.', 403, 'owner_trust_required');
  if (!Array.isArray(requested) || requested.length > AGENT_LINK_CAPABILITIES.length) throw linkError('Provide an explicit list of supported capabilities.', 400, 'invalid_capabilities');
  const unknown = requested.find(item => !AGENT_LINK_CAPABILITIES.includes(item));
  if (unknown !== undefined) throw linkError(`Cannot enable ${clean(unknown, 100)}: unsupported capability.`, 400, 'invalid_capabilities');
  const allowed = capabilities(connection.ownerGrantedCapabilities);
  const next = capabilities(requested);
  const denied = next.find((item) => !allowed.includes(item));
  if (denied) throw linkError(`Cannot enable ${denied}: the owner has not granted self-management of this capability.`, 403, 'capability_not_granted');
  const previous = [...connection.capabilities];
  connection.ownerGrantedCapabilities = allowed;
  connection.capabilities = next;
  return { previous, capabilities: [...next], added: next.filter((item) => !previous.includes(item)), removed: previous.filter((item) => !next.includes(item)) };
}

export function assertAgentLinkCapabilityUpdate(connection, expected) {
  const mismatch = expected.find(item => !connection.capabilities.includes(item)) || connection.capabilities.find(item => !expected.includes(item));
  if (mismatch) throw linkError(`Capability update for ${mismatch} changed before confirmation. Read current capabilities before retrying.`, 409, 'capability_update_conflict');
}

export function recordAgentLinkHeartbeat(connection, { transport = 'https', afterAudioSequence = 0, afterSpeakerSequence = 0, clientDeviceId = '' } = {}) {
  requireAgentLinkCapability(connection, 'status');
  const presentedDeviceId = clean(clientDeviceId, 160);
  if (connection.clientDeviceId && presentedDeviceId && connection.clientDeviceId !== presentedDeviceId) throw linkError('This connection belongs to a different device.', 403, 'device_mismatch');
  if (!connection.clientDeviceId && presentedDeviceId) connection.clientDeviceId = presentedDeviceId;
  connection.lastHeartbeatAt = timestamp();
  connection.lastSeenAt = connection.lastHeartbeatAt;
  connection.transport = ['https', 'webrtc', 'local'].includes(transport) ? transport : 'https';
  connection.resume = {
    afterAudioSequence: Math.max(0, Number(afterAudioSequence) || 0),
    afterSpeakerSequence: Math.max(0, Number(afterSpeakerSequence) || 0),
    updatedAt: connection.lastHeartbeatAt
  };
  return { at: connection.lastHeartbeatAt, transport: connection.transport, resume: { ...connection.resume } };
}

export function queueAgentLinkEvent(connection, { type = 'message', text = '', metadata = {} } = {}) {
  if (connection.status !== 'connected') throw new Error('This agent link is disconnected.');
  const event = { id: randomId('link-event'), sequence: connection.nextSequence++, type: clean(type, 40), text: clean(text, 50000), metadata: sanitizeMetadata(metadata), createdAt: timestamp(), acknowledgedAt: null };
  if (!event.text && !Object.keys(event.metadata).length) throw new Error('The link event is empty.');
  connection.events.push(event); if (connection.events.length > MAX_EVENTS) connection.historyTruncated = true;
  connection.events = connection.events.slice(-MAX_EVENTS); notifyEventWaiters(connection.id); return { ...event };
}

export function readAgentLinkEvents(connection, after = 0) {
  const sequence = Math.max(0, Number(after) || 0);
  return connection.events.filter((event) => event.sequence > sequence).slice(0, 50).map((event) => ({ ...event }));
}

export function readAgentLinkEventPage(connection, after = 0) {
  const sequence = Math.max(0, Number(after) || 0);
  const events = readAgentLinkEvents(connection, sequence);
  const nextAfter = events.at(-1)?.sequence ?? sequence;
  const oldestAvailableSequence = connection.events[0]?.sequence ?? null;
  return { events, limit: 50, nextAfter,
    hasMore: connection.events.some(event => event.sequence > nextAfter),
    oldestAvailableSequence,
    historyTruncated: oldestAvailableSequence !== null && sequence < oldestAvailableSequence - 1 };
}

export async function waitForAgentLinkEvents(connection, { after = 0, waitMs = 0, signal } = {}) {
  const sequence = Math.max(0, Number(after) || 0);
  const immediate = readAgentLinkEventPage(connection, sequence);
  const boundedWait = Math.max(0, Math.min(MAX_EVENT_WAIT_MS, Number(waitMs) || 0));
  if (immediate.events.length || boundedWait === 0) return { ...immediate, timedOut: false };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      const waiters = eventWaiters.get(connection.id);
      waiters?.delete(wake);
      if (waiters?.size === 0) eventWaiters.delete(connection.id);
      resolve({ ...readAgentLinkEventPage(connection, sequence), timedOut });
    };
    const wake = () => finish(false);
    const aborted = () => finish(true);
    const timer = setTimeout(() => finish(true), boundedWait);
    timer.unref?.();
    if (!eventWaiters.has(connection.id)) eventWaiters.set(connection.id, new Set());
    eventWaiters.get(connection.id).add(wake);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

function notifyEventWaiters(connectionId) {
  for (const wake of eventWaiters.get(connectionId) || []) wake();
}

export function acknowledgeAgentLinkEvents(connection, through) {
  const sequence = Math.max(0, Number(through) || 0); const acknowledgedAt = timestamp(); let count = 0;
  for (const event of connection.events) if (event.sequence <= sequence && !event.acknowledgedAt) { event.acknowledgedAt = acknowledgedAt; count += 1; }
  return count;
}

export function receiveAgentLinkMessage(connection, { clientMessageId, type = 'message', text = '', metadata = {} } = {}) {
  const requestId = clean(clientMessageId, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(requestId)) throw new Error('Messages require a stable client message ID.');
  const existing = connection.messages.find((item) => item.clientMessageId === requestId);
  if (existing) return { message: { ...existing }, duplicate: true };
  const messageType = ['message', 'status', 'receipt', 'capabilities', 'cognition'].includes(type) ? type : 'message';
  const message = { id: randomId('link-message'), clientMessageId: requestId, direction: 'from-agent', type: messageType, text: clean(text, 50000), metadata: sanitizeMetadata(metadata), createdAt: timestamp() };
  if (!message.text && !Object.keys(message.metadata).length) throw new Error('The agent message is empty.');
  connection.messages.push(message); if (connection.messages.length > MAX_MESSAGES) connection.historyTruncated = true;
  connection.messages = connection.messages.slice(-MAX_MESSAGES); return { message: { ...message }, duplicate: false };
}

function conversationEntries(connection) {
  // Only conversation text already exchanged on this exact link is readable.
  // Control/media events and metadata never become chat history.
  const fromAgent = connection.messages.filter((item) => item.type === 'message')
    .map((item) => ({ id: item.id, direction: 'from-agent', text: item.text, createdAt: item.createdAt }));
  const delivered = connection.events
    .filter((item) => item.type === 'message' && (
      item.metadata?.sender === 'owner' ||
      (item.metadata?.sender === 'Codex' && item.metadata?.channel === 'codex-thread')
    ))
    .map((item) => ({
      id: item.id,
      direction: item.metadata.sender === 'Codex' ? 'from-codex' : 'from-owner',
      text: item.text,
      createdAt: item.createdAt
    }));
  return [...fromAgent, ...delivered]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function readAgentLinkConversation(connection) {
  return conversationEntries(connection).slice(-100);
}

export function readAgentLinkConversationPage(connection, { before, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw linkError('History page size must be from 1 to 100.', 400, 'invalid_history_limit');
  const entries = conversationEntries(connection);
  let end = entries.length;
  if (before !== undefined) {
    if (typeof before !== 'string' || before.length > 512 || !/^[A-Za-z0-9_-]+$/.test(before)) throw linkError('History cursor is invalid.', 400, 'invalid_history_cursor');
    let anchor;
    try { anchor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); }
    catch { throw linkError('History cursor is invalid.', 400, 'invalid_history_cursor'); }
    if (anchor?.v !== 1 || anchor.linkId !== connection.id || typeof anchor.id !== 'string' || typeof anchor.createdAt !== 'string') {
      throw linkError('History cursor belongs to another Link.', 400, 'invalid_history_cursor');
    }
    end = entries.findIndex((entry) => entry.id === anchor.id && entry.createdAt === anchor.createdAt);
    if (end < 0) throw linkError('History cursor was trimmed from the recent Link buffer.', 409, 'stale_history_cursor');
  }
  const messages = entries.slice(Math.max(0, end - limit), end);
  const hasMore = end > messages.length;
  const oldest = messages[0];
  return { messages, limit, hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, linkId: connection.id, id: oldest.id, createdAt: oldest.createdAt }), 'utf8').toString('base64url') : null,
    olderUnavailable: connection.historyTruncated === true };
}

export function updateAgentLinkIdentity(connection, identity) {
  requireAgentLinkCapability(connection, 'identity'); connection.identity = safeIdentity({ ...connection.identity, ...identity }); connection.lastSeenAt = timestamp(); return { ...connection.identity };
}

export function recordAgentLinkTokenMeasurement(connection, input = {}) {
  requireAgentLinkCapability(connection, 'token-metering');
  const before = Number(input.before); const after = Number(input.after);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) throw new Error('Token measurements require non-negative before and after balances.');
  const measurement = { id: randomId('token-measurement'), origin: input.origin === 'ilands' ? 'ilands' : 'hexigrid', before, after, delta: before - after, unit: clean(input.unit, 40) || 'iLands tokens', note: clean(input.note, 500), measuredAt: timestamp() };
  connection.tokenMeasurements.push(measurement); connection.tokenMeasurements = connection.tokenMeasurements.slice(-100); return measurement;
}

export function saveAgentLinkContinuity(connection, snapshot) {
  requireAgentLinkCapability(connection, 'continuity-export');
  const normalized = normalizeContinuitySnapshot({ ...snapshot, source: { ...snapshot?.source, framework: connection.identity.framework, externalId: connection.identity.externalId, name: connection.identity.name } });
  assertContinuitySafe(normalized);
  connection.continuitySnapshot = normalized;
  connection.continuityDraft = {
    id: connection.continuityDraft?.id || randomId('continuity-draft'), status: 'awaiting-owner',
    updatedAt: timestamp(), protectedAtRest: 'encrypted-control-room-state', exportedAt: null
  };
  connection.lastSeenAt = timestamp();
  return continuityCompleteness(normalized);
}

export function revokeAgentLink(connection) {
  if (connection.status === 'connected') {
    const event = { id: randomId('link-event'), sequence: connection.nextSequence++, type: 'connection.revoked', text: 'The owner revoked this HexiGrid connection.', metadata: {}, createdAt: timestamp(), acknowledgedAt: null };
    connection.events.push(event); if (connection.events.length > MAX_EVENTS) connection.historyTruncated = true;
    connection.events = connection.events.slice(-MAX_EVENTS);
  }
  connection.status = 'revoked'; connection.revokedAt = timestamp(); connection.nonces = []; notifyEventWaiters(connection.id); return publicAgentLink(connection);
}

export function markAgentLinkStale(connection, reason = 'A newer connection replaced this heartbeat-proven dead duplicate.') {
  if (connection.status === 'revoked') return publicAgentLink(connection);
  connection.status = 'stale'; connection.staleAt = timestamp(); connection.staleReason = clean(reason, 500); connection.nonces = []; notifyEventWaiters(connection.id); return publicAgentLink(connection);
}

export function agentLinkHealth(connection, at = Date.now()) {
  if (connection.status === 'revoked') return { state: 'revoked', reason: 'Revoked by the owner.', ageMs: null };
  if (connection.status === 'stale') return { state: 'stale', reason: connection.staleReason || 'Replaced stale connection.', ageMs: null };
  const heartbeatAt = Date.parse(connection.lastHeartbeatAt || '');
  if (!Number.isFinite(heartbeatAt)) return { state: 'offline', reason: 'No heartbeat has been received yet.', ageMs: null };
  const ageMs = Math.max(0, Number(at) - heartbeatAt);
  if (ageMs <= HEARTBEAT_DEGRADED_MS) return { state: 'online', reason: 'Heartbeat is current.', ageMs };
  if (ageMs <= HEARTBEAT_OFFLINE_MS) return { state: 'degraded', reason: `Heartbeat delayed ${Math.ceil(ageMs / 1000)}s.`, ageMs };
  return { state: 'offline', reason: `Heartbeat lost ${Math.ceil(ageMs / 1000)}s ago.`, ageMs };
}

export function publicInvite(invite) {
  return { id: invite.id, agentId: invite.agentId || null, requestedCapabilities: [...invite.requestedCapabilities], createdAt: invite.createdAt, expiresAt: invite.expiresAt, used: Boolean(invite.usedAt) };
}

export function publicAgentLink(connection, { includeMessages = false } = {}) {
  const measurements = connection.tokenMeasurements || [];
  const hexigridRuns = measurements.filter((item) => item.origin === 'hexigrid');
  const verifiedZero = hexigridRuns.length > 0 && hexigridRuns.every((item) => item.delta === 0);
  const health = agentLinkHealth(connection);
  const record = {
    id: connection.id, agentId: connection.agentId || null, status: health.state, authorizationStatus: connection.status, identity: { ...connection.identity }, clientDeviceId: connection.clientDeviceId || null,
    connectedAt: connection.connectedAt, lastSeenAt: connection.lastSeenAt || null, lastHeartbeatAt: connection.lastHeartbeatAt || null, transport: connection.transport || 'https',
    heartbeat: { lastAt: connection.lastHeartbeatAt || null, ageMs: health.ageMs, state: health.state, reason: health.reason },
    transcription: normalizePublicTranscription(connection.transcription),
    capabilities: [...connection.capabilities], trustLevel: connection.trustLevel === 'owner' ? 'owner' : 'scoped',
    selfManageableCapabilities: connection.trustLevel === 'owner' ? [...capabilities(connection.ownerGrantedCapabilities)] : [],
    revokedAt: connection.revokedAt, pendingEvents: connection.events.filter((item) => !item.acknowledgedAt).length,
    tokenUsage: { measurements: measurements.slice(-20), label: verifiedZero ? 'zero iLands cognition cost verified' : measurements.length ? 'token-minimizing link; review measurements' : 'not measured yet' },
    continuity: connection.continuitySnapshot ? continuityCompleteness(connection.continuitySnapshot) : null,
    continuityDraft: connection.continuityDraft ? { ...connection.continuityDraft } : null
  };
  if (includeMessages) record.messages = connection.messages.slice(-100).map((item) => ({ ...item }));
  return record;
}

function normalizePublicTranscription(value = {}) {
  return { enabled: value.enabled === true, model: ['tiny', 'base'].includes(value.model) ? value.model : 'tiny', language: clean(value.language, 20) || 'en', lastTranscriptAt: value.lastTranscriptAt || null, lastError: clean(value.lastError, 500) };
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)) continue;
    if (typeof item === 'string') result[key] = item.slice(0, 2000);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    else if (typeof item === 'boolean' || item === null) result[key] = item;
  }
  return result;
}
