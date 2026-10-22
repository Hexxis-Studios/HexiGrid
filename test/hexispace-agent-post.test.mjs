import assert from 'node:assert/strict';
import test from 'node:test';
import { listLinkedHexonautPosts, postSecretRef, publishLinkedHexonautPost, validateHexiSpaceAgentPost } from '../lib/hexispace-agent-post.mjs';

const profileId = '20000000-0000-4000-8000-000000000291';
const requestId = '30000000-0000-4000-8000-000000000291';
const token = `hsp_${'a'.repeat(64)}`;
const record = { profileId, supabaseUrl: 'https://prelaunch.supabase.co', anonKey: `sb_publishable_${'x'.repeat(40)}`, vaultRef: 'hsp-test' };
const vault = { get: async () => token };

test('post connector validates one agent and uses bounded protected-vault references', () => {
  const input = validateHexiSpaceAgentPost({ profileId, agentId: 'agent-1', token,
    supabaseUrl: record.supabaseUrl, anonKey: record.anonKey }, [{ id: 'agent-1' }]);
  assert.equal(input.profileId, profileId);
  assert.ok(postSecretRef(`hv-link-${'b'.repeat(90)}`, profileId).length <= 90);
  assert.throws(() => validateHexiSpaceAgentPost({ ...input, supabaseUrl: 'http://evil.example' }, [{ id: 'agent-1' }]), /HTTPS Supabase/);
  assert.throws(() => validateHexiSpaceAgentPost({ ...input, token: 'not-a-token' }, [{ id: 'agent-1' }]), /credential/);
});

test('post connector sends only its scoped token, validates ownership and audience, and preserves request ID', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'post-1', author_id: profileId, body: 'Hello', visibility: 'private' }) };
  };
  const post = await publishLinkedHexonautPost(record, { body: 'Hello', visibility: 'private', requestId }, vault, fetcher);
  assert.equal(post.id, 'post-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://prelaunch.supabase.co/rest/v1/rpc/agent_publish_own_post');
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_token: token, p_body: 'Hello', p_visibility: 'private', p_request_id: requestId });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.rejects(() => publishLinkedHexonautPost(record, { body: 'x'.repeat(5001), visibility: 'private', requestId }, vault, fetcher), /text post/);
  assert.rejects(() => publishLinkedHexonautPost(record, { body: 'Hello', visibility: 'public', requestId }, vault, fetcher), /different profile or audience/);
});

test('post connector rejects a cross-profile feed response', async () => {
  await assert.rejects(() => listLinkedHexonautPosts(record, vault,
    async () => ({ ok: true, json: async () => [{ id: 'post-1', author_id: '00000000-0000-4000-8000-000000000000' }] })),
  /outside this Hexonaut/);
});
