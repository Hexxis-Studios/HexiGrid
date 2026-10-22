import crypto from 'node:crypto';

const CONTEXT = 'hexigrid-agent-relay-v1';

function keyFor(secretHash) {
  return crypto.createHash('sha256').update(`${CONTEXT}\n${String(secretHash)}`).digest();
}

export function encryptRelayEnvelope(secretHash, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secretHash), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    data: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
}

export function decryptRelayEnvelope(secretHash, envelope) {
  if (envelope?.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string' || typeof envelope.tag !== 'string') {
    throw new Error('The encrypted relay envelope is invalid.');
  }
  const iv = Buffer.from(envelope.iv, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  const ciphertext = Buffer.from(envelope.data, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 12 * 1024 * 1024) throw new Error('The encrypted relay envelope is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secretHash), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}
