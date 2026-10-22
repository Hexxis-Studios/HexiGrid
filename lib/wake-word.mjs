const MAX_PHRASE_LENGTH = 80;
const MAX_AGENT_CONFIGS = 512;
const MAX_TRAINING_SAMPLES = 3;
const MAX_FEATURE_FRAMES = 240;
const MAX_FEATURE_VALUES = 32;
const DETECTOR = 'local-template-v3';

export const WAKE_WORD_PRESETS = Object.freeze([
  'Hey Hexi',
  'Hey Agent',
  'Hey Hexonaut',
  'Computer, listen'
]);

const clean = (value, fallback = '', max = MAX_PHRASE_LENGTH) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) || fallback : fallback;
const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

function normalizeFeatures(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FEATURE_FRAMES) return [];
  const frames = value.slice(0, MAX_FEATURE_FRAMES).map((frame) => {
    if (!Array.isArray(frame) || frame.length === 0 || frame.length > MAX_FEATURE_VALUES) return null;
    const normalized = frame.slice(0, MAX_FEATURE_VALUES).map((item) => Number(item));
    return normalized.every((item) => Number.isFinite(item) && Math.abs(item) <= 10) ? normalized : null;
  });
  return frames.every(Boolean) ? frames : [];
}

function normalizeAgentConfig(value = {}, agentId = '') {
  const source = value && typeof value === 'object' ? value : {};
  return {
    agentId: clean(agentId, '', 160),
    phrase: clean(source.phrase, '', MAX_PHRASE_LENGTH),
    samples: Array.isArray(source.samples) ? source.samples.slice(-MAX_TRAINING_SAMPLES).map(normalizeFeatures).filter((sample) => sample.length) : [],
    trainedAt: typeof source.trainedAt === 'string' ? source.trainedAt.slice(0, 40) : null
  };
}

export function normalizeWakeWordSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const detectorCompatible = !source.detector || source.detector === DETECTOR;
  const entries = source.agents && typeof source.agents === 'object' && !Array.isArray(source.agents) ? Object.entries(source.agents).slice(0, MAX_AGENT_CONFIGS) : [];
  const agents = {};
  for (const [agentId, config] of entries) {
    const normalized = normalizeAgentConfig(config, agentId);
    if (!detectorCompatible) { normalized.samples = []; normalized.trainedAt = null; }
    if (normalized.agentId) agents[normalized.agentId] = normalized;
  }
  const defaultPhrase = clean(source.defaultPhrase, WAKE_WORD_PRESETS[0]);
  return {
    version: 1,
    enabled: source.enabled === true,
    alwaysListening: source.alwaysListening === true,
    pushToTalk: source.pushToTalk !== false,
    detector: DETECTOR,
    defaultPhrase,
    preRollMs: Math.round(clamp(source.preRollMs, 250, 2000, 1000)),
    silenceMs: Math.round(clamp(source.silenceMs, 400, 4000, 1200)),
    commandTimeoutMs: Math.round(clamp(source.commandTimeoutMs, 2000, 30000, 12000)),
    agents
  };
}

export function defaultWakeWordSettings() { return normalizeWakeWordSettings({}); }

export function wakeWordForAgent(settings, agentId, agentName = '') {
  const normalized = normalizeWakeWordSettings(settings);
  const config = normalized.agents[String(agentId || '')];
  return {
    agentId: String(agentId || ''),
    phrase: config?.phrase || (agentName ? `Hey ${clean(agentName, 'Hexi', 50)}` : normalized.defaultPhrase),
    samples: config?.samples || [],
    trained: Boolean(config?.samples?.length >= MAX_TRAINING_SAMPLES),
    alwaysListening: normalized.alwaysListening,
    pushToTalk: normalized.pushToTalk,
    enabled: normalized.enabled,
    preRollMs: normalized.preRollMs,
    silenceMs: normalized.silenceMs,
    commandTimeoutMs: normalized.commandTimeoutMs,
    detector: normalized.detector
  };
}

export function updateWakeWordAgent(settings, { agentId, phrase, samples } = {}) {
  const normalized = normalizeWakeWordSettings(settings);
  const key = clean(agentId, '', 160);
  if (!key) throw Object.assign(new Error('Choose an agent before configuring a wake phrase.'), { status: 400 });
  const prior = normalized.agents[key] || normalizeAgentConfig({}, key);
  const next = normalizeAgentConfig({ ...prior, phrase: phrase ?? prior.phrase, samples: samples ?? prior.samples }, key);
  normalized.agents[key] = next;
  return normalized;
}

export function addWakeWordTrainingSample(settings, { agentId, phrase, features } = {}) {
  const normalized = updateWakeWordAgent(settings, { agentId, phrase });
  const key = clean(agentId, '', 160);
  const sample = normalizeFeatures(features);
  if (!sample.length) throw Object.assign(new Error('Training samples must contain bounded local audio features.'), { status: 400 });
  const config = normalized.agents[key];
  config.samples = [...config.samples, sample].slice(-MAX_TRAINING_SAMPLES);
  config.trainedAt = new Date().toISOString();
  return normalized;
}

export function routeWakePhrase(settings, phrase, agents = []) {
  const normalized = normalizeWakeWordSettings(settings);
  const spoken = clean(phrase).toLocaleLowerCase();
  if (!spoken) return { agentId: '', phrase: normalized.defaultPhrase, matched: false };
  const matches = agents.filter((agent) => {
    const configured = normalized.agents[agent.id]?.phrase;
    const candidate = (configured || `Hey ${agent.name || ''}`).trim().toLocaleLowerCase();
    return candidate && spoken.includes(candidate);
  });
  if (matches.length === 1) return { agentId: matches[0].id, phrase: normalized.agents[matches[0].id]?.phrase || `Hey ${matches[0].name}`, matched: true };
  return { agentId: '', phrase: normalized.defaultPhrase, matched: spoken.includes(normalized.defaultPhrase.toLocaleLowerCase()) };
}

export function publicWakeWordSettings(value) {
  const normalized = normalizeWakeWordSettings(value);
  return {
    ...normalized,
    agents: Object.fromEntries(Object.entries(normalized.agents).map(([agentId, config]) => [agentId, {
      agentId, phrase: config.phrase, samples: config.samples, sampleCount: config.samples.length, trained: config.samples.length >= MAX_TRAINING_SAMPLES, trainedAt: config.trainedAt
    }]))
  };
}

export const WAKE_WORD_LIMITS = Object.freeze({ MAX_TRAINING_SAMPLES, MAX_FEATURE_FRAMES, MAX_FEATURE_VALUES });
