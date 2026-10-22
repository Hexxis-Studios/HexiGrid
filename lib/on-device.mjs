const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,180}$/;
const PROVIDER_ID = /^[A-Za-z0-9-]{2,120}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,120}$/;

export const ON_DEVICE_PROVIDER_KIND = 'browser-webllm';
export const ON_DEVICE_PROVIDER_URL = 'browser://webllm';

function cleanText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanModel(model) {
  if (typeof model === 'string') {
    const id = model.trim();
    return MODEL_ID.test(id) ? { id, label: id } : null;
  }
  if (!model || typeof model !== 'object') return null;
  const id = cleanText(model.id || model.model_id);
  if (!MODEL_ID.test(id)) return null;
  const vram = Number(model.vramRequiredMB ?? model.vram_required_MB);
  return {
    id,
    label: cleanText(model.label, id).slice(0, 240),
    vramRequiredMB: Number.isFinite(vram) && vram > 0 && vram < 100000 ? Math.round(vram * 100) / 100 : null,
    lowResource: model.lowResource === true || model.low_resource_required === true
  };
}

export function normalizeOnDeviceModels(models) {
  if (!Array.isArray(models) || !models.length) throw new Error('Choose at least one on-device model.');
  const unique = new Map();
  for (const item of models.slice(0, 100)) {
    const model = cleanModel(item);
    if (model) unique.set(model.id, model);
  }
  if (!unique.size) throw new Error('The selected on-device model list is not valid. Refresh the supported models and try again.');
  return [...unique.values()];
}

export function isOnDeviceProvider(provider) {
  return provider?.kind === ON_DEVICE_PROVIDER_KIND;
}

export function createOnDeviceProvider(input, { id, createdAt }) {
  const providerId = cleanText(id);
  if (!PROVIDER_ID.test(providerId)) throw new Error('The on-device connection ID is invalid.');
  const models = normalizeOnDeviceModels(input?.models);
  const deviceId = cleanText(input?.deviceId);
  return {
    id: providerId,
    name: cleanText(input?.name, 'On-device models').slice(0, 80),
    kind: ON_DEVICE_PROVIDER_KIND,
    baseUrl: ON_DEVICE_PROVIDER_URL,
    modelIds: models.map((model) => model.id),
    modelMeta: models,
    apiStyle: ON_DEVICE_PROVIDER_KIND,
    local: true,
    browser: true,
    enabled: true,
    capabilities: ['chat'],
    hasKey: false,
    deviceId: DEVICE_ID.test(deviceId) ? deviceId : '',
    createdAt: cleanText(createdAt).slice(0, 40),
    lastCheckedAt: cleanText(createdAt).slice(0, 40),
    lastError: ''
  };
}

export function sanitizeOnDeviceProvider(provider) {
  const models = normalizeOnDeviceModels(provider?.modelMeta || provider?.modelIds || []);
  const id = cleanText(provider?.id);
  if (!PROVIDER_ID.test(id)) throw new Error('The on-device connection ID is invalid.');
  const createdAt = cleanText(provider?.createdAt).slice(0, 40);
  return {
    id,
    name: cleanText(provider?.name, 'On-device models').slice(0, 80),
    kind: ON_DEVICE_PROVIDER_KIND,
    baseUrl: ON_DEVICE_PROVIDER_URL,
    modelIds: models.map((model) => model.id),
    modelMeta: models,
    apiStyle: ON_DEVICE_PROVIDER_KIND,
    local: true,
    browser: true,
    enabled: provider?.enabled !== false,
    capabilities: ['chat'],
    hasKey: false,
    deviceId: DEVICE_ID.test(String(provider?.deviceId || '')) ? provider.deviceId : '',
    createdAt,
    lastCheckedAt: cleanText(provider?.lastCheckedAt).slice(0, 40),
    lastError: cleanText(provider?.lastError).slice(0, 800)
  };
}

export function isOnDeviceModel(modelId, provider) {
  return isOnDeviceProvider(provider) && typeof modelId === 'string' && provider.modelIds.includes(modelId);
}
