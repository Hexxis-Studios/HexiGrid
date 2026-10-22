const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const JITTER_MS = 250;

export const COMPANION_STATES = Object.freeze(['idle', 'connecting', 'connected', 'reconnecting', 'closed', 'failed']);

export function defaultCompanionState() {
  return {
    state: 'idle',
    transport: 'outbound-https',
    reconnectAttempt: 0,
    lastSequence: 0,
    lastAudioSequence: 0,
    lastSpeakerSequence: 0,
    lastHeartbeatAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastError: null
  };
}

export function normalizeCompanionState(value = {}) {
  const state = { ...defaultCompanionState(), ...(value && typeof value === 'object' ? value : {}) };
  state.state = COMPANION_STATES.includes(state.state) ? state.state : 'idle';
  state.transport = 'outbound-https';
  state.reconnectAttempt = Math.max(0, Math.min(32, Number(state.reconnectAttempt) || 0));
  state.lastSequence = Math.max(0, Number(state.lastSequence) || 0);
  state.lastAudioSequence = Math.max(0, Number(state.lastAudioSequence) || 0);
  state.lastSpeakerSequence = Math.max(0, Number(state.lastSpeakerSequence) || 0);
  for (const key of ['lastHeartbeatAt', 'lastConnectedAt', 'lastDisconnectedAt', 'lastError']) {
    if (state[key] !== null && typeof state[key] !== 'string') state[key] = null;
  }
  return state;
}

export function companionRetryDelay(attempt, random = Math.random) {
  const count = Math.max(1, Math.min(32, Number(attempt) || 1));
  const jitter = Math.max(0, Math.min(JITTER_MS, Math.round(Number(random()) * JITTER_MS)));
  return Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.min(5, count - 1)) + jitter);
}

export function markCompanionConnecting(value = {}, { reconnect = false } = {}) {
  const state = normalizeCompanionState(value);
  state.state = reconnect ? 'reconnecting' : 'connecting';
  state.reconnectAttempt = reconnect ? state.reconnectAttempt + 1 : 0;
  state.lastError = null;
  return state;
}

export function markCompanionConnected(value = {}, at = new Date().toISOString()) {
  const state = normalizeCompanionState(value);
  state.state = 'connected';
  state.reconnectAttempt = 0;
  state.lastConnectedAt = at;
  state.lastError = null;
  return state;
}

export function markCompanionHeartbeat(value = {}, { at = new Date().toISOString(), lastSequence, lastAudioSequence, lastSpeakerSequence } = {}) {
  const state = normalizeCompanionState(value);
  state.lastHeartbeatAt = at;
  if (lastSequence !== undefined) state.lastSequence = Math.max(state.lastSequence, Number(lastSequence) || 0);
  if (lastAudioSequence !== undefined) state.lastAudioSequence = Math.max(state.lastAudioSequence, Number(lastAudioSequence) || 0);
  if (lastSpeakerSequence !== undefined) state.lastSpeakerSequence = Math.max(state.lastSpeakerSequence, Number(lastSpeakerSequence) || 0);
  return state;
}

export function markCompanionFailure(value = {}, error, at = new Date().toISOString()) {
  const state = normalizeCompanionState(value);
  state.state = 'reconnecting';
  state.lastDisconnectedAt = at;
  state.lastError = String(error?.message || error || 'Companion connection failed').slice(0, 500);
  return state;
}

export function markCompanionClosed(value = {}, error = null, at = new Date().toISOString()) {
  const state = normalizeCompanionState(value);
  state.state = error ? 'failed' : 'closed';
  state.lastDisconnectedAt = at;
  state.lastError = error ? String(error?.message || error).slice(0, 500) : null;
  return state;
}

export function publicCompanionState(value = {}) {
  const state = normalizeCompanionState(value);
  return {
    state: state.state,
    transport: state.transport,
    reconnectAttempt: state.reconnectAttempt,
    lastSequence: state.lastSequence,
    lastAudioSequence: state.lastAudioSequence,
    lastSpeakerSequence: state.lastSpeakerSequence,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastConnectedAt: state.lastConnectedAt,
    lastDisconnectedAt: state.lastDisconnectedAt,
    lastError: state.lastError
  };
}
