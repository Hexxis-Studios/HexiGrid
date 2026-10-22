const MAX_TRANSCRIPT_ENTRIES = 600;
const MAX_TRANSCRIPT_TEXT = 12000;

const clean = (value, max, fallback = '') => String(value ?? '').trim().slice(0, max) || fallback;

export function sanitizeVoiceProfile(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const voiceName = clean(value.voiceName, 200);
  const rate = Number(value.rate);
  const pitch = Number(value.pitch);
  const volume = Number(value.volume);
  return {
    engine: ['provider', 'agent'].includes(value.engine) ? value.engine : 'browser',
    voiceName,
    providerId: clean(value.providerId, 120),
    model: clean(value.model, 240),
    voiceId: clean(value.voiceId, 200),
    rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1,
    pitch: Number.isFinite(pitch) ? Math.min(2, Math.max(0, pitch)) : 1,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
  };
}

export function sanitizeLiveTranscript(value = {}) {
  const entries = Array.isArray(value.entries) ? value.entries.slice(-MAX_TRANSCRIPT_ENTRIES).map((entry) => ({
    role: ['user', 'agent', 'system'].includes(entry?.role) ? entry.role : 'system',
    agentId: clean(entry?.agentId, 120) || null,
    speaker: clean(entry?.speaker, 120, entry?.role === 'user' ? 'You' : 'HexiGrid'),
    text: clean(entry?.text, MAX_TRANSCRIPT_TEXT),
    createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt.slice(0, 40) : new Date().toISOString()
  })).filter((entry) => entry.text) : [];
  return {
    title: clean(value.title, 160, 'Live session'),
    agentId: clean(value.agentId, 120) || null,
    roomId: clean(value.roomId, 120) || null,
    entries,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function publicLiveTranscript(value) {
  const cleanValue = sanitizeLiveTranscript(value);
  return {
    id: clean(value?.id, 120),
    title: cleanValue.title,
    agentId: cleanValue.agentId,
    roomId: cleanValue.roomId,
    entries: cleanValue.entries,
    createdAt: cleanValue.createdAt,
    updatedAt: cleanValue.updatedAt
  };
}

export const liveCommunicationLimits = Object.freeze({
  maxTranscriptEntries: MAX_TRANSCRIPT_ENTRIES,
  maxTranscriptText: MAX_TRANSCRIPT_TEXT
});
