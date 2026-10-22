import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  acceptAgentLinkInvite,
  authenticateAgentLink,
  createAgentLinkInvite,
  createAgentLinkPairingLimiter,
  publicAgentLinkPairingFailure,
  recordAgentLinkHeartbeat,
  signatureFor
} from '../lib/agent-link.mjs';

const routesSource = readFileSync(fileURLToPath(new URL('../lib/agent-link-routes.mjs', import.meta.url)), 'utf8');

function invitationSecret(created) {
  return decodeURIComponent(new URL(created.invitationUrl).hash.slice('#secret='.length));
}

function pair(state, deviceId = 'device-a') {
  const created = createAgentLinkInvite(state, { baseUrl: 'https://pair.example', requestedCapabilities: ['messages', 'status'] });
  return acceptAgentLinkInvite(state, {
    inviteId: created.invite.id,
    secret: invitationSecret(created),
    clientDeviceId: deviceId,
    capabilities: ['messages', 'status']
  });
}

test('invitation secrets contain 256 CSPRNG bits and show no sequential output', () => {
  const state = {};
  const secrets = Array.from({ length: 128 }, () => invitationSecret(createAgentLinkInvite(state, { baseUrl: 'https://pair.example' })));
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) assert.equal(Buffer.from(secret, 'base64url').length, 32);
  for (let index = 1; index < secrets.length; index += 1) {
    const before = Buffer.from(secrets[index - 1], 'base64url');
    const after = Buffer.from(secrets[index], 'base64url');
    assert.notEqual(after.compare(before), 0);
    assert.notEqual(after.readBigUInt64BE(0) - before.readBigUInt64BE(0), 1n);
  }
});

test('expired and consumed invitations fail closed', () => {
  const state = {};
  const expired = createAgentLinkInvite(state, { baseUrl: 'https://pair.example' });
  state.agentLinkInvites[0].expiresAt = new Date(Date.now() - 1).toISOString();
  assert.throws(
    () => acceptAgentLinkInvite(state, { inviteId: expired.invite.id, secret: invitationSecret(expired) }),
    (error) => error.code === 'invitation_expired'
  );

  const fresh = createAgentLinkInvite(state, { baseUrl: 'https://pair.example' });
  acceptAgentLinkInvite(state, { inviteId: fresh.invite.id, secret: invitationSecret(fresh) });
  assert.throws(
    () => acceptAgentLinkInvite(state, { inviteId: fresh.invite.id, secret: invitationSecret(fresh) }),
    (error) => error.code === 'invitation_consumed'
  );
});

test('device-bound connections reject a different device after pairing', () => {
  const state = {};
  const paired = pair(state, 'device-a');
  const connection = state.agentLinks.find((item) => item.id === paired.connection.id);
  recordAgentLinkHeartbeat(connection, { clientDeviceId: 'device-a' });
  assert.throws(
    () => recordAgentLinkHeartbeat(connection, { clientDeviceId: 'device-b' }),
    (error) => error.code === 'device_mismatch' && error.status === 403
  );
});

test('signed handshake rejects nonce replay and stale timestamps', () => {
  const state = {};
  const paired = pair(state);
  const pathname = '/agent-link/v1/events';
  const timestamp = new Date().toISOString();
  const nonce = `nonce-${crypto.randomUUID()}`;
  const request = { method: 'GET', pathname, timestamp, nonce, body: null };
  request.signature = signatureFor({ token: paired.token, ...request });
  assert.equal(authenticateAgentLink(state, `Bearer ${paired.token}`, request).id, paired.connection.id);
  assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, request), /expired or was already used/);

  const stale = { method: 'GET', pathname, timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), nonce: `nonce-${crypto.randomUUID()}`, body: null };
  stale.signature = signatureFor({ token: paired.token, ...stale });
  assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, stale), /expired or was already used/);
});

test('public pairing failures do not expose an invitation validity oracle', () => {
  const detailed = [
    Object.assign(new Error('invalid'), { status: 401, code: 'invitation_invalid' }),
    Object.assign(new Error('expired'), { status: 410, code: 'invitation_expired' }),
    Object.assign(new Error('used'), { status: 409, code: 'invitation_consumed' }),
    Object.assign(new Error('device'), { status: 409, code: 'device_already_paired' })
  ];
  const publicFailures = detailed.map(publicAgentLinkPairingFailure);
  for (const failure of publicFailures) assert.deepEqual(failure, {
    status: 401,
    error: 'This HexiGrid Link invitation cannot be used.',
    code: 'invitation_unavailable'
  });
  const pairingRoute = routesSource.slice(
    routesSource.indexOf("if (method === 'POST' && pathname === '/agent-link/v1/pair')"),
    routesSource.indexOf("if (!pathname.startsWith('/agent-link/v1/'))")
  );
  assert.match(pairingRoute, /publicAgentLinkPairingFailure\(error\)/);
  assert.doesNotMatch(pairingRoute, /json\(res, error\.status \|\| 400, \{ error: error\.message/);
});

test('pairing limiter throttles the eighth failed attempt for one source and resets after its window', () => {
  let clock = 1_000_000;
  const limiter = createAgentLinkPairingLimiter({ maxAttempts: 8, windowMs: 300_000, now: () => clock });
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const result = limiter.recordFailure('198.51.100.10');
    assert.equal(result.blocked, false);
    assert.equal(result.attempts, attempt);
  }
  const blocked = limiter.recordFailure('198.51.100.10');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.attempts, 8);
  assert.equal(blocked.retryAfter, 300);
  assert.equal(limiter.check('198.51.100.11').blocked, false);
  clock += 300_000;
  assert.deepEqual(limiter.check('198.51.100.10'), { blocked: false, attempts: 0, attemptsRemaining: 8, retryAfter: 0 });
  assert.match(routesSource, /agentLinkPairingLimiter\?\.check\(pairingKey\)/);
  assert.match(routesSource, /agentLinkPairingLimiter\?\.recordFailure\(pairingKey\)/);
  assert.match(routesSource, /pairing_rate_limited/);
});
