import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFirebaseTokenVerifier } from '../lib/firebase-auth.mjs';

const fixedNow = Date.parse('2026-09-14T12:00:00Z');
function tokenFor(privateKey, claims, header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(claims)}`;
  return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

test('Firebase identity verification pins signature, issuer, audience, time, and verified email', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const verify = createFirebaseTokenVerifier({
    projectId: 'hexigrid', clock: () => fixedNow,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }), { headers: { 'cache-control': 'max-age=300', 'content-type': 'application/json' } }),
  });
  const base = { aud: 'hexigrid', iss: 'https://securetoken.google.com/hexigrid', sub: 'owner-123', email: 'owner@example.test', email_verified: true, iat: fixedNow / 1000 - 10, exp: fixedNow / 1000 + 300 };
  assert.deepEqual(await verify(tokenFor(privateKey, base)), { subject: 'owner-123', email: 'owner@example.test', name: '' });
  await assert.rejects(verify(tokenFor(privateKey, { ...base, aud: 'another-project' })), /verification failed/);
  await assert.rejects(verify(tokenFor(privateKey, { ...base, email_verified: false })), /did not verify/);
  await assert.rejects(verify(tokenFor(privateKey, { ...base, exp: fixedNow / 1000 - 1 })), /verification failed/);
  await assert.rejects(verify(tokenFor(privateKey, base, { alg: 'none', kid: 'test-key' })), /unsupported token signature/);
});
