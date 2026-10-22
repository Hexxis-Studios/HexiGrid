import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { publicAvatarPresence, updateAvatarPresence } from '../lib/avatar-presence.mjs';
import { createAgentLinkInvite, acceptAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';

test('avatar updates are bounded, revision checked and atomic', () => {
  const agent = { id: 'a' };
  assert.equal(publicAvatarPresence(agent).revision, 0);
  updateAvatarPresence(agent, { expectedRevision: 0, visible: true, yaw: 90, animation: 'Walking' });
  const saved = JSON.stringify(agent);
  for (const patch of [{ expectedRevision: 0, visible: false }, { expectedRevision: 1, yaw: 181 }, { expectedRevision: 1, scale: 0 }, { expectedRevision: 1, visible: 'true' }, { expectedRevision: 1, agentId: 'other' }]) {
    assert.throws(() => updateAvatarPresence(agent, patch));
    assert.equal(JSON.stringify(agent), saved);
  }
  assert.equal(updateAvatarPresence(agent, { expectedRevision: 1, visible: false }).revision, 2);
});

test('signed avatar control binds to own identity and honors policy, grants and revocation', async () => {
  const state = { settings: {} }, own = { id: 'own' }, other = { id: 'other' };
  const invite = createAgentLinkInvite(state, { agentId: own.id, baseUrl: 'http://127.0.0.1:4318', requestedCapabilities: ['messages'] });
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)), capabilities: ['messages'], identity: { name: 'QA' } });
  let blocked = false, saves = 0, receipts = 0;
  const invoke = async (method, body, valid = true) => {
    const pathname = '/agent-link/v1/avatar', timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    let result;
    await handleAgentLinkRequest({ headers: { authorization: `Bearer ${paired.token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce, 'x-hexigrid-signature': valid ? signatureFor({ token: paired.token, method, pathname, timestamp, nonce, body }) : 'invalid' } }, {}, {
      state, method, pathname, readBody: async () => body, findAgent: id => id === own.id ? own : other,
      connectorPolicy: () => blocked ? { denied: true, error: 'Planning mode' } : null,
      addReceipt: () => { receipts++; }, saveState: async () => { saves++; }, json: (_res, status, value) => { result = { status, ...value }; }
    });
    return result;
  };
  assert.equal((await invoke('GET', null)).avatar.agentId, own.id);
  assert.equal((await invoke('POST', { expectedRevision: 0, visible: true })).status, 200);
  assert.equal(other.avatarPresence, undefined);
  assert.equal(saves, 1); assert.equal(receipts, 1);
  assert.equal((await invoke('POST', { expectedRevision: 1, agentId: other.id })).status, 400);
  blocked = true;
  assert.equal((await invoke('POST', { expectedRevision: 1, visible: false })).status, 403);
  assert.equal((await invoke('POST', { expectedRevision: 1 }, false)).status, 401);
  assert.equal(saves, 1);
  blocked = false; state.settings.workMode = 'plan';
  assert.equal((await invoke('POST', { expectedRevision: 1, visible: false })).status, 403);
  assert.equal((await invoke('GET', null)).status, 200);
  state.agentLinks[0].capabilities = [];
  assert.notEqual((await invoke('GET', null)).status, 200);
  state.agentLinks[0].status = 'revoked';
  assert.equal((await invoke('GET', null)).status, 410);
});
