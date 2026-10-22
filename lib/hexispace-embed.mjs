const LOCAL_HEXISPACE_ORIGINS = new Set([
  'http://127.0.0.1:4340',
  'http://localhost:4340'
]);

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function configuredOrigins() {
  const configured = String(process.env.HEXISPACE_EMBED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  return new Set([...LOCAL_HEXISPACE_ORIGINS, ...configured]);
}

function requestOrigin(headers, requestedOrigin = '') {
  const origin = normalizeOrigin(headers?.origin);
  if (origin) return origin;
  const requested = normalizeOrigin(requestedOrigin);
  if (requested) return requested;
  const referer = typeof headers?.referer === 'string' ? headers.referer : '';
  try { return normalizeOrigin(new URL(referer).origin); } catch { return ''; }
}

/**
 * Returns the exact trusted parent origin for the narrowly-scoped embedded
 * HexiGrid document, or an empty string for every other request.
 */
export function trustedHexiSpaceEmbedOrigin(headers, embedded, requestedOrigin = '') {
  if (!embedded) return '';
  const origin = requestOrigin(headers, requestedOrigin);
  return configuredOrigins().has(origin) ? origin : '';
}

export function embeddedDocumentHeaders(frameOrigin) {
  if (!frameOrigin) return {};
  return {
    frameAncestors: frameOrigin,
    crossOriginResourcePolicy: 'cross-origin'
  };
}

export const localHexiSpaceOrigins = () => [...LOCAL_HEXISPACE_ORIGINS];
