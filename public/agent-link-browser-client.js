const encoder = new TextEncoder();

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  if (value === null) return 'null';
  return JSON.stringify(value);
}

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256(value, subtle = crypto.subtle) {
  return base64url(await subtle.digest('SHA-256', encoder.encode(value)));
}

export async function linkSignature({ token, method, pathname, timestamp, nonce, body = null, subtle = crypto.subtle }) {
  const digest = await sha256(stableJson(body), subtle);
  const key = await subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = `${String(method).toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${digest}`;
  return base64url(await subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function signedLinkRequest(pathname, { token, method = 'GET', body = null, fetchFn = fetch, now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
  const timestamp = now().toISOString();
  const nonce = randomUUID();
  const signature = await linkSignature({ token, method, pathname, timestamp, nonce, body });
  const response = await fetchFn(pathname, {
    method,
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-hexigrid-timestamp': timestamp,
      'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signature,
      ...(body === null ? {} : { 'content-type': 'application/json' })
    },
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HexiGrid returned HTTP ${response.status}.`), { status: response.status, body: payload });
  return payload;
}
