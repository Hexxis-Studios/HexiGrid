import crypto from 'node:crypto';

const timestamp = () => new Date().toISOString();
const cleanId = (value) => String(value || '').trim().slice(0, 160);

const blank = (reason = 'not-started') => ({
  id: '',
  linkId: '',
  status: 'idle',
  phase: 'idle',
  direction: 'owner-to-agent',
  callerName: '',
  expiresAt: null,
  ownerMuted: false,
  offeredAt: null,
  answeredAt: null,
  endedAt: null,
  updatedAt: null,
  stopReason: reason,
  acceptedVia: null,
  interruptedAt: null,
  interruptionCount: 0,
  replySequence: 0,
  latestReply: null,
  mediaEpoch: 0
});

let call = blank();
const heldCalls = new Map();
const microphoneStarts = new Map();
let microphoneSequenceStart = 1;
let activeTurn = null;
let onAudioStopped = () => {};
const lastInitiated = new Map();

export function setVoiceCallAudioStopped(callback) {
  onAudioStopped = typeof callback === 'function' ? callback : () => {};
}

function cancelActiveTurn() {
  activeTurn?.controller.abort();
  activeTurn = null;
}

export function beginVoiceTurn(linkId) {
  const current = requireVoiceCall(linkId, ['active']);
  if (current.ownerMuted) throw Object.assign(new Error('The owner muted this voice call.'), { status: 409 });
  if (activeTurn) throw Object.assign(new Error('A voice reply is already in progress.'), { status: 409 });
  const turn = { callId: current.id, controller: new AbortController() };
  activeTurn = turn;
  call.phase = 'thinking';
  call.updatedAt = timestamp();
  return turn;
}

export function voiceTurnStillActive(turn) {
  return activeTurn === turn && !turn.controller.signal.aborted && call.id === turn.callId && call.status === 'active' && !call.ownerMuted;
}

export function finishVoiceTurn(turn) {
  if (activeTurn === turn) {
    activeTurn = null;
    if (call.id === turn.callId && call.status === 'active' && call.phase === 'thinking') {
      call.phase = call.ownerMuted ? 'idle' : 'listening';
      call.updatedAt = timestamp();
    }
  }
}

export function markVoiceSpeaking(linkId) {
  requireVoiceCall(linkId, ['active']);
  call.phase = 'speaking';
  call.updatedAt = timestamp();
  return publicVoiceCall();
}

/** Publish a short text reply for the owner device to speak with this agent's configured voice. */
export function recordVoiceCallReply(linkId, text, outputMode = 'browser-voice') {
  requireVoiceCall(linkId, ['active']);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 240) throw Object.assign(new Error('Voice replies must contain 1–240 characters.'), { status: 400 });
  call.replySequence = Number(call.replySequence || 0) + 1;
  call.latestReply = { sequence: call.replySequence, text: clean, outputMode: outputMode === 'audio' ? 'audio' : 'browser-voice', createdAt: timestamp() };
  call.phase = outputMode === 'audio' ? 'speaking' : 'listening';
  call.updatedAt = timestamp();
  return publicVoiceCall();
}

export function interruptVoiceCall(linkId, { energy = 0, threshold = 0.12 } = {}) {
  requireVoiceCall(linkId, ['active']);
  const level = Number(energy);
  if (!Number.isFinite(level) || level < threshold || !['thinking', 'speaking'].includes(call.phase) || call.ownerMuted) {
    return { interrupted: false, voiceCall: publicVoiceCall() };
  }
  cancelActiveTurn();
  const at = timestamp();
  call.phase = 'listening';
  call.interruptedAt = at;
  call.interruptionCount += 1;
  call.updatedAt = at;
  return { interrupted: true, voiceCall: publicVoiceCall() };
}

export function publicVoiceCall(linkId = '') {
  if (call.status === 'ringing' && Date.now() >= Date.parse(call.expiresAt)) endVoiceCall(call.linkId, 'missed');
  if (linkId) return { ...(call.linkId === cleanId(linkId) ? call : heldCalls.get(cleanId(linkId)) || blank()), onHold: call.linkId !== cleanId(linkId) && heldCalls.has(cleanId(linkId)) };
  return { ...call, onHold: false, participants: [call, ...heldCalls.values()].filter(item => ['offered', 'ringing', 'active'].includes(item.status)).map(item => ({ id: item.id, linkId: item.linkId, status: item.status, callerName: item.callerName, onHold: item !== call })) };
}

export function selectVoiceCall(linkId) {
  if (call.status !== 'active') throw Object.assign(new Error('The selected call is no longer active.'), { status: 409 });
  const next = heldCalls.get(cleanId(linkId));
  if (!next || next.status !== 'active') throw Object.assign(new Error('This agent must answer before you can talk to it.'), { status: 409 });
  cancelActiveTurn(); onAudioStopped(call.linkId);
  call.ownerMuted = true; call.phase = 'held'; call.updatedAt = timestamp();
  call.mediaEpoch += 1;
  heldCalls.set(call.linkId, call); heldCalls.delete(next.linkId);
  call = next; call.ownerMuted = false; call.phase = 'listening'; call.updatedAt = timestamp();
  call.mediaEpoch += 1;
  microphoneSequenceStart = microphoneStarts.get(call.linkId) || 1;
  return publicVoiceCall();
}

export function startVoiceCall(options = {}) {
  const { linkId, microphoneGranted = false, speakerGranted = false, microphoneSequenceStart: initialMicrophoneSequence = 1, allowAdd = false } = options;
  const id = cleanId(linkId);
  if (!id) throw Object.assign(new Error('Choose a connected Hexonaut before starting a voice call.'), { status: 400 });
  publicVoiceCall();
  const adding = ['offered', 'ringing', 'active'].includes(call.status);
  if (adding && (!allowAdd || call.status !== 'active')) throw Object.assign(new Error('End the current voice call before starting another.'), { status: 409 });
  if (adding && (call.linkId === id || heldCalls.has(id))) throw Object.assign(new Error('This agent is already in the call.'), { status: 409 });
  if (microphoneGranted !== true || speakerGranted !== true) {
    throw Object.assign(new Error('Voice calls require this session to grant both microphone listening and agent speaker output.'), { status: 403 });
  }
  const at = timestamp();
  if (!adding) { cancelActiveTurn(); heldCalls.clear(); microphoneStarts.clear(); }
  const created = {
    ...blank(''),
    id: `voice-call-${crypto.randomUUID()}`,
    linkId: id,
    status: 'offered',
    offeredAt: at,
    updatedAt: at,
    ownerMuted: adding,
    phase: adding ? 'held' : 'listening'
  };
  if (adding) heldCalls.set(id, created); else call = created;
  const initialSequence = Number.isSafeInteger(Number(initialMicrophoneSequence)) && Number(initialMicrophoneSequence) > 0 ? Number(initialMicrophoneSequence) : 1;
  if (!adding) microphoneSequenceStart = initialSequence;
  microphoneStarts.set(id, initialSequence);
  return adding ? publicVoiceCall(id) : publicVoiceCall();
}

export function initiateVoiceCall({ linkId, callerName = '', microphoneGranted = false, speakerGranted = false } = {}) {
  const id = cleanId(linkId);
  publicVoiceCall();
  if (['offered', 'ringing', 'active'].includes(call.status)) throw Object.assign(new Error('A voice call is already ringing or connected.'), { status: 409 });
  if (Date.now() - (lastInitiated.get(id) || 0) < 30_000) throw Object.assign(new Error('Wait 30 seconds before calling this owner again.'), { status: 429 });
  const result = startVoiceCall({ linkId: id, microphoneGranted, speakerGranted });
  call.direction = 'agent-to-owner';
  call.callerName = String(callerName).slice(0, 160);
  call.status = 'ringing';
  call.notificationChannel = 'pending';
  call.phase = 'idle';
  call.ownerMuted = true;
  call.expiresAt = new Date(Date.now() + 45_000).toISOString();
  for (const [key, at] of lastInitiated) if (Date.now() - at > 30_000) lastInitiated.delete(key);
  lastInitiated.set(id, Date.now());
  return publicVoiceCall();
}

export function setVoiceCallMicrophoneSequenceStart(linkId, sequence) {
  requireVoiceCall(linkId);
  const value = Number(sequence);
  if (!Number.isSafeInteger(value) || value < 1) throw Object.assign(new Error('The microphone stream cursor is invalid.'), { status: 400 });
  microphoneSequenceStart = value;
  microphoneStarts.set(cleanId(linkId), value);
  call.updatedAt = timestamp();
  return publicVoiceCall();
}

export function voiceCallMicrophoneSequenceStart(linkId) {
  requireVoiceCall(linkId);
  return microphoneSequenceStart;
}

export function requireVoiceCall(linkId, allowedStatuses = ['offered', 'ringing', 'active']) {
  publicVoiceCall();
  const held = heldCalls.get(cleanId(linkId));
  if (held && allowedStatuses.includes(held.status)) {
    if (held.status === 'active') throw Object.assign(new Error('This agent is on hold. Owner audio and video are paused until selected.'), { status: 409 });
    return held;
  }
  if (!call.id || call.linkId !== cleanId(linkId) || !allowedStatuses.includes(call.status)) {
    throw Object.assign(new Error('No live voice call is available for this Hexonaut.'), { status: 409 });
  }
  return call;
}

export function setVoiceCallNotificationChannel(callId, channel) {
  if (call.id !== callId || call.status !== 'ringing' || call.direction !== 'agent-to-owner') return publicVoiceCall();
  call.notificationChannel = channel === 'windows' ? 'windows' : 'browser';
  return publicVoiceCall();
}

export function answerVoiceCall(linkId, { by = 'agent', callId, acceptedVia = null } = {}) {
  const current = requireVoiceCall(linkId, ['offered', 'ringing', 'active']);
  if (current !== call) {
    if (by !== 'agent' || (callId && callId !== current.id)) throw Object.assign(new Error('This call invitation is stale or belongs to the other side.'), { status: 409 });
    current.status = 'active'; current.phase = 'held'; current.ownerMuted = true; current.answeredAt = timestamp(); current.updatedAt = timestamp();
    return publicVoiceCall(linkId);
  }
  if (callId && callId !== call.id) throw Object.assign(new Error('This call invitation is stale.'), { status: 409 });
  if ((call.direction === 'agent-to-owner') !== (by === 'owner')) throw Object.assign(new Error('Only the receiving side can accept this call.'), { status: 403 });
  if (['offered', 'ringing'].includes(call.status)) {
    const at = timestamp();
    call.status = 'active';
    call.phase = 'listening';
    call.answeredAt = at;
    call.updatedAt = at;
    call.ownerMuted = false;
    call.expiresAt = null;
    call.acceptedVia = by === 'owner' && ['browser', 'windows-toast'].includes(acceptedVia) ? acceptedVia : by;
  }
  return publicVoiceCall();
}

export function muteVoiceCall(linkId, muted = true) {
  requireVoiceCall(linkId);
  call.ownerMuted = muted === true;
  if (call.ownerMuted) { cancelActiveTurn(); call.phase = 'idle'; onAudioStopped(call.linkId); }
  else call.phase = 'listening';
  call.updatedAt = timestamp();
  return publicVoiceCall();
}

export function endVoiceCall(linkId, reason = 'ended') {
  const held = heldCalls.get(cleanId(linkId));
  if (held) {
    heldCalls.delete(cleanId(linkId)); microphoneStarts.delete(cleanId(linkId));
    return { ...held, status: 'ended', phase: 'idle', ownerMuted: true, onHold: false, endedAt: timestamp(), stopReason: reason };
  }
  // A completed call remains available as the last-call status snapshot. It
  // must not block another Link from ending its own session-only permissions.
  // Keep the cross-Link guard for live calls so one agent cannot end another's.
  if (!call.id || !['offered', 'ringing', 'active'].includes(call.status)) return publicVoiceCall();
  if (linkId && call.linkId !== cleanId(linkId)) throw Object.assign(new Error('This voice call belongs to another Hexonaut link.'), { status: 403 });
  cancelActiveTurn();
  onAudioStopped(call.linkId);
  const at = timestamp();
  call.status = 'ended';
  call.phase = 'idle';
  call.ownerMuted = true;
  call.endedAt = at;
  call.updatedAt = at;
  call.stopReason = String(reason || 'ended').slice(0, 80);
  heldCalls.clear(); microphoneStarts.clear();
  return publicVoiceCall();
}

export function resetVoiceCallForTests() {
  cancelActiveTurn();
  call = blank();
  microphoneSequenceStart = 1;
  lastInitiated.clear();
  heldCalls.clear(); microphoneStarts.clear();
}
