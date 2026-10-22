import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;

function blockedAddress(address) {
  const value = String(address || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254
      || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  if (net.isIP(value) === 6) {
    if (value.startsWith('::ffff:')) {
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
      if (mapped) {
        const first = Number.parseInt(mapped[1], 16);
        const second = Number.parseInt(mapped[2], 16);
        return blockedAddress(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
      }
      return blockedAddress(value.slice('::ffff:'.length));
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }
  return false;
}

export function validateSafeLinkTarget(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Preview target is not a valid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && !/^443$/.test(url.port)) throw new Error('Only ordinary HTTPS preview targets are allowed.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || blockedAddress(hostname)) throw new Error('Private or local preview targets are blocked.');
  url.hostname = hostname;
  url.hash = '';
  return url;
}

async function assertPublicTarget(url, lookup) {
  if (blockedAddress(url.hostname)) throw new Error('Private or local preview targets are blocked.');
  const rows = await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => blockedAddress(row.address))) throw new Error('Preview target resolved to a private or local address.');
}

function cleanText(value, max = 300) {
  return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstMeta(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i');
  return cleanText(html.match(pattern)?.[1] || html.match(reverse)?.[1] || '');
}

async function boundedText(response) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_BYTES) throw new Error('Preview response is too large.');
  if (!response.body?.getReader) return String(await response.text()).slice(0, MAX_BYTES);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (size <= MAX_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error('Preview response is too large.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/** Fetch metadata only; never proxies media bytes or executes returned markup. */
export async function fetchSafeLinkPreview(input, { fetcher = fetch, lookup = dns.lookup } = {}) {
  let target = validateSafeLinkTarget(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicTarget(target, lookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try { response = await fetcher(target, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'text/html,application/xhtml+xml;q=0.9' } }); }
    finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) throw new Error('Preview redirect limit reached.');
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('Preview redirect did not include a destination.');
      target = validateSafeLinkTarget(new URL(location, target).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);
    const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) throw new Error('Preview target did not return HTML metadata.');
    const html = await boundedText(response);
    const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || firstMeta(html, 'og:title') || firstMeta(html, 'twitter:title'), 180);
    const description = firstMeta(html, 'og:description') || firstMeta(html, 'description') || firstMeta(html, 'twitter:description');
    const imageValue = firstMeta(html, 'og:image') || firstMeta(html, 'twitter:image');
    let image = '';
    if (imageValue) { try { const candidate = validateSafeLinkTarget(new URL(imageValue, target).toString()); await assertPublicTarget(candidate, lookup); image = candidate.toString(); } catch { image = ''; } }
    return { url: target.toString(), title, description, image, fetchedAt: new Date().toISOString() };
  }
  throw new Error('Preview request could not be completed.');
}

export const SAFE_LINK_PREVIEW_LIMITS = Object.freeze({ maxRedirects: MAX_REDIRECTS, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS });
