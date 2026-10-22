export const PROVIDER_LIMIT_FIELDS = Object.freeze({
  maxInputTokens: Object.freeze({ min: 1, max: 1_000_000 }),
  maxOutputTokens: Object.freeze({ min: 1, max: 32_768 })
});

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function normalizeProviderLimitPatch(body) {
  const prototype = body && typeof body === 'object' && !Array.isArray(body) ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      (prototype !== null && Object.getPrototypeOf(prototype) !== null)) {
    throw invalid('Provide a JSON object containing token limits.');
  }
  const keys = Reflect.ownKeys(body);
  if (!keys.length) throw invalid('Set at least one token limit.');
  const patch = {};
  for (const key of keys) {
    if (!Object.hasOwn(PROVIDER_LIMIT_FIELDS, key)) throw invalid(`Unknown provider limit field: ${String(key)}.`);
    const value = body[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    const { min, max } = PROVIDER_LIMIT_FIELDS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      const kind = key === 'maxInputTokens' ? 'Input-context' : 'Output';
      throw invalid(`${kind} token limit must be an integer from ${min} to ${max}, or null to clear it.`);
    }
    patch[key] = value;
  }
  return patch;
}

export function applyProviderLimitPatch(provider, body) {
  const patch = normalizeProviderLimitPatch(body);
  const updated = { ...provider };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete updated[key];
    else updated[key] = value;
  }
  return updated;
}

export function createProviderLimitRequest(providerId, values) {
  if (typeof providerId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(providerId)) throw invalid('A valid provider ID is required.');
  const patch = normalizeProviderLimitPatch(values);
  return {
    path: `/api/providers/${encodeURIComponent(providerId)}/limits`,
    method: 'PATCH',
    body: JSON.stringify(patch)
  };
}

const pendingLimitWrites = new WeakSet();
export async function commitProviderLimitPatch(state, provider, body, { addReceipt, saveState }) {
  const updated = applyProviderLimitPatch(provider, body);
  if (pendingLimitWrites.has(provider)) throw Object.assign(new Error('Provider limits are being saved; retry after the current update.'), { status: 409 });
  pendingLimitWrites.add(provider);
  const previous = Object.fromEntries(Object.keys(PROVIDER_LIMIT_FIELDS).map((key) => [key, {
    present: Object.hasOwn(provider, key), value: provider[key]
  }]));
  const previousReceipts = [...(state.receipts || [])];
  let receipt;
  try {
    for (const key of Object.keys(PROVIDER_LIMIT_FIELDS)) {
      if (Object.hasOwn(updated, key)) provider[key] = updated[key];
      else delete provider[key];
    }
    receipt = addReceipt({
      action: `provider:${provider.id}:limits`, capability: 'write_workspace', risk: 'low',
      status: 'completed', detail: `${provider.name} token limits were updated.`, source: 'provider'
    });
    await saveState();
    return { provider, receipt };
  } catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      if (value.present) provider[key] = value.value;
      else delete provider[key];
    }
    if (receipt) {
      state.receipts = state.receipts.filter(item => item !== receipt);
      for (const prior of previousReceipts) if (!state.receipts.includes(prior)) state.receipts.push(prior);
    }
    throw error;
  } finally { pendingLimitWrites.delete(provider); }
}

const browserApi = Object.freeze({
  PROVIDER_LIMIT_FIELDS, normalizeProviderLimitPatch, applyProviderLimitPatch,
  createProviderLimitRequest, commitProviderLimitPatch
});
if (typeof window !== 'undefined') window.HexiGridProviderLimits = browserApi;
