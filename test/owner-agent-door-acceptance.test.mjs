import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptAgentLinkInvite, authenticateAgentLink, createAgentLinkInvite, normalizeAgentLinks, revokeAgentLink, signatureFor } from '../lib/agent-link.mjs';
import { ownerAgentAuthorized, setOwnerAgentTrust } from '../lib/owner-agent-access.mjs';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

function pair(state, capabilities = ['messages']) {
  const invite = createAgentLinkInvite(state, { baseUrl: 'http://localhost', requestedCapabilities: capabilities });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  return acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities });
}

function signed(token, method, pathname) {
  const timestamp = new Date().toISOString(); const nonce = `door-${crypto.randomUUID()}`;
  return { method, pathname, timestamp, nonce, signature: signatureFor({ token, method, pathname, timestamp, nonce }) };
}

test('owner trust toggle changes effective access and gates the next owner operation', () => {
  const link = { id: 'door-agent', status: 'connected', trustLevel: 'scoped', capabilities: ['messages'], ownerGrantedCapabilities: [] };
  const bridge = { enabled: true, ownerApproved: true, agentControlActive: true, linkId: link.id };
  assert.throws(() => ownerAgentAuthorized(link, bridge, 'owner-process'), /not granted/);
  assert.equal(setOwnerAgentTrust(link, 'owner').trustLevel, 'owner');
  ownerAgentAuthorized(link, bridge, 'owner-process');
  assert.equal(setOwnerAgentTrust(link, 'scoped').trustLevel, 'scoped');
  assert.throws(() => ownerAgentAuthorized(link, bridge, 'owner-process'), /not granted/);
});

test('revoked connection rejects a fresh authenticated agent request', () => {
  const state = {}; normalizeAgentLinks(state);
  const paired = pair(state);
  const request = signed(paired.token, 'GET', '/agent-link/v1/events');
  assert.equal(authenticateAgentLink(state, `Bearer ${paired.token}`, request).id, paired.connection.id);
  revokeAgentLink(state.agentLinks.find((connection) => connection.id === paired.connection.id));
  assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, signed(paired.token, 'GET', '/agent-link/v1/events')),
    (error) => error.code === 'connection_revoked' && error.status === 410);
});

test('disconnected outbound companion opens a fresh session on reconnect', async () => {
  let opens = 0; let failedPoll = false;
  const fetchFn = async (url) => {
    if (url.endsWith('/companion/open')) {
      opens += 1;
      return Response.json({ peerId: `peer-${opens}`, token: `session-${opens}` });
    }
    if (url.includes('/companion/poll')) {
      if (!failedPoll) { failedPoll = true; return Response.json({ error: 'synthetic disconnect' }, { status: 503 }); }
      return new Promise((resolve) => setTimeout(() => resolve(Response.json({ messages: [] })), 30));
    }
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  const client = new OutboundCompanionConnection({
    inviteUrl: 'http://localhost/relay?invite=door-invite&device=door-device#secret=synthetic-secret',
    fetchFn, automaticControl: false, sleepFn: async () => {}, random: () => 0
  });
  const reconnectedEvent = new Promise((resolve) => client.addEventListener('reconnected', (event) => resolve(event.detail)));
  const first = await client.connect();
  const event = await reconnectedEvent;
  assert.equal(first.peerId, 'peer-1');
  assert.equal(event.peerId, 'peer-2');
  assert.notEqual(client.session.token, first.token);
  assert.equal(opens, 2);
  await client.close();
});
