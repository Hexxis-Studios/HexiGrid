import { fetchSafeLinkPreview } from './safe-link-preview.mjs';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;
const previewCache = new Map();

function cacheGet(url, now = Date.now()) {
  const entry = previewCache.get(url);
  if (!entry || entry.expiresAt <= now) {
    if (entry) previewCache.delete(url);
    return null;
  }
  return entry.preview;
}

function cachePut(url, preview, now = Date.now()) {
  previewCache.set(url, { preview, expiresAt: now + CACHE_TTL_MS });
  while (previewCache.size > MAX_CACHE_ENTRIES) previewCache.delete(previewCache.keys().next().value);
}

/** Owner-only, metadata-only link previews. Returned HTML is never persisted or rendered here. */
export async function handleLinkPreviewRequest(req, res, ctx) {
  const { pathname, method, readBody, json, connectorPolicy, addReceipt, fetchPreview = fetchSafeLinkPreview } = ctx;
  if (method !== 'POST' || pathname !== '/api/link-preview') return false;
  const body = await readBody(req, 32 * 1024);
  const denied = connectorPolicy('network_read', 'medium', body.approved === true);
  if (denied) {
    json(res, denied.denied ? 403 : 409, denied);
    return true;
  }
  try {
    const requested = String(body.url || '').trim();
    if (!requested) return json(res, 400, { error: 'Provide an HTTPS page URL to preview.' }), true;
    const cached = cacheGet(requested);
    const preview = cached || await fetchPreview(requested);
    if (!cached) cachePut(requested, preview);
    let host = '';
    try { host = new URL(preview.url).hostname; } catch { /* the safe fetcher already validates its final URL */ }
    addReceipt({ action: 'link-preview', capability: 'network_read', risk: 'medium', status: 'completed', detail: `Fetched bounded metadata for ${host || 'one HTTPS destination'}${cached ? ' from the short-lived cache' : ''}.`, source: 'link-preview' });
    json(res, 200, { preview, cached: Boolean(cached) });
  } catch (error) {
    json(res, error.status || 502, { error: error.message || 'The link preview could not be fetched.' });
  }
  return true;
}
