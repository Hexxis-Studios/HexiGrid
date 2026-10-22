import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAgentLinkInvite, acceptAgentLinkInvite, signatureFor } from '../lib/agent-link.mjs';
import { handleAgentLinkRequest } from '../lib/agent-link-routes.mjs';

function fixture(grants = ['harness-jobs']) {
  const state = { settings: {} }, agent = { id: 'agent-harness-test' };
  const invite = createAgentLinkInvite(state, { agentId: agent.id, baseUrl: 'http://127.0.0.1:4318', requestedCapabilities: grants });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: grants });
  let starts = 0, cancellations = 0, match = null;
  const job = { id: 'harness-job-test', agentId: agent.id, linkId: paired.connection.id, status: 'completed', output: 'Synthetic result' };
  async function invoke(method, suffix = '', body = null) {
    const pathname = `/agent-link/v1/harness-jobs${suffix}`, timestamp = new Date().toISOString(), nonce = crypto.randomUUID();
    let result;
    await handleAgentLinkRequest({ socket: {}, headers: { authorization: `Bearer ${paired.token}`,
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token: paired.token, method, pathname, timestamp, nonce, body }) } }, {}, {
      state, pathname, method, readBody: async () => body, json: (_, status, body) => { result = { status, body }; },
      connectorPolicy: () => null, findAgent: () => agent,
      startHarnessJob: async () => { starts++; return job; },
      findHarnessJob: (id, scope) => { match = scope; return id === job.id && scope.linkId === job.linkId && scope.agentId === job.agentId ? job : null; },
      publicHarnessJob: value => ({ ...value }), cancelHarnessJob: () => { cancellations++; return true; },
      addReceipt: () => {}, saveState: async () => {}
    });
    return result;
  }
  return { invoke, job, agent, counts: () => ({ starts, cancellations }), scope: () => match };
}

test('signed result and cancellation pin both the paired Link and agent', async () => {
  const qa = fixture();
  assert.equal((await qa.invoke('GET', '/harness-job-test')).status, 200);
  assert.deepEqual(qa.scope(), { linkId: qa.job.linkId, agentId: qa.agent.id });
  qa.job.agentId = 'unrelated-agent';
  assert.equal((await qa.invoke('GET', '/harness-job-test')).status, 404);
  assert.equal((await qa.invoke('POST', '/harness-job-test/cancel', {})).status, 404);
  assert.equal(qa.counts().cancellations, 0);
});

test('item POST cannot silently create another job; collection POST can', async () => {
  const qa = fixture();
  assert.equal((await qa.invoke('POST', '/harness-job-test', { prompt: 'Synthetic' })).status, 404);
  assert.equal(qa.counts().starts, 0);
  assert.equal((await qa.invoke('POST', '', { prompt: 'Synthetic' })).status, 202);
  assert.equal(qa.counts().starts, 1);
});

test('ungranted signed harness access is denied before result lookup or dispatch', async () => {
  const qa = fixture(['messages']);
  assert.equal((await qa.invoke('GET', '/harness-job-test')).status, 403);
  assert.equal((await qa.invoke('POST', '', { prompt: 'Synthetic' })).status, 403);
  assert.equal(qa.scope(), null); assert.equal(qa.counts().starts, 0);
});
