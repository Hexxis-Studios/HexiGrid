import crypto from 'node:crypto';

const DEFAULT_PROJECT_ID = 'hexigrid';
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function decodePart(value) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
function cacheLifetime(header) {
  const match = String(header || '').match(/(?:^|,)\s*max-age=(\d+)/i);
  return match ? Math.min(Number(match[1]), 3600) * 1000 : 5 * 60 * 1000;
}

export function createFirebaseTokenVerifier({ projectId = DEFAULT_PROJECT_ID, fetchImpl = fetch, clock = () => Date.now(), jwksUrl = DEFAULT_JWKS_URL } = {}) {
  const issuer = `https://securetoken.google.com/${projectId}`;
  let cachedKeys = null;
  let keysExpireAt = 0;
  async function signingKeys() {
    if (cachedKeys && clock() < keysExpireAt) return cachedKeys;
    const response = await fetchImpl(jwksUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Google sign-in verification is temporarily unavailable.');
    const body = await response.json();
    if (!body?.keys?.length) throw new Error('Google sign-in verification returned no signing keys.');
    cachedKeys = new Map(body.keys.map((key) => [key.kid, key]));
    keysExpireAt = clock() + cacheLifetime(response.headers.get('cache-control'));
    return cachedKeys;
  }
  return async function verifyFirebaseIdToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('Google sign-in did not return a valid identity token.');
    let header; let payload;
    try { header = decodePart(parts[0]); payload = decodePart(parts[1]); }
    catch { throw new Error('Google sign-in did not return a valid identity token.'); }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Google sign-in used an unsupported token signature.');
    const key = (await signingKeys()).get(header.kid);
    if (!key) { keysExpireAt = 0; throw new Error('Google rotated its sign-in key. Try again.'); }
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    const now = Math.floor(clock() / 1000);
    if (!valid || payload.aud !== projectId || payload.iss !== issuer || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 || !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 60) throw new Error('Google sign-in identity verification failed.');
    if (payload.email && payload.email_verified !== true) throw new Error('Google did not verify this account email.');
    return { subject: payload.sub, email: String(payload.email || '').slice(0, 320), name: String(payload.name || '').slice(0, 120) };
  };
}

export const verifyFirebaseIdToken = createFirebaseTokenVerifier();
