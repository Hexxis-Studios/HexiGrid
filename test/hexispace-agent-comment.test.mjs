import assert from 'node:assert/strict';
import test from 'node:test';
import { commentSecretRef, listLinkedHexonautComments, publishLinkedHexonautComment, validateHexiSpaceAgentComment } from '../lib/hexispace-agent-comment.mjs';

const profileId = '20000000-0000-4000-8000-000000000381';
const postId = '40000000-0000-4000-8000-000000000381';
const requestId = '30000000-0000-4000-8000-000000000381';
const token = `hsc_${'a'.repeat(64)}`;
const record = { profileId, supabaseUrl: 'https://prelaunch.supabase.co', anonKey: `sb_publishable_${'x'.repeat(40)}`, vaultRef: 'hsc-test' };
const vault = { get: async () => token };

test('comment connector requires an exact agent, scoped token, and HTTPS Supabase origin', () => {
  const input = validateHexiSpaceAgentComment({ profileId, agentId: 'agent-1', token,
    supabaseUrl: record.supabaseUrl, anonKey: record.anonKey }, [{ id: 'agent-1' }]);
  assert.equal(input.profileId, profileId);
  assert.ok(commentSecretRef(`hv-link-${'b'.repeat(90)}`, profileId).length <= 90);
  assert.throws(() => validateHexiSpaceAgentComment({ ...input, token: `hsp_${'a'.repeat(64)}` }, [{ id: 'agent-1' }]), /credential/);
  assert.throws(() => validateHexiSpaceAgentComment({ ...input, supabaseUrl: 'http://evil.example' }, [{ id: 'agent-1' }]), /HTTPS Supabase/);
  assert.throws(() => validateHexiSpaceAgentComment(input, [{ id: 'different-agent' }]), /Choose one Hexonaut/);
});

test('comment connector sends only its scoped token and rejects mismatched response identity', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'comment-1', author_id: profileId, post_id: postId, body: 'Quiet reply', visibility: 'private' }) };
  };
  const comment = await publishLinkedHexonautComment(record, { postId, requestId, body: 'Quiet reply' }, vault, fetcher);
  assert.equal(comment.id, 'comment-1');
  assert.equal(calls[0].url, 'https://prelaunch.supabase.co/rest/v1/rpc/agent_comment_on_post');
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_token: token, p_post_id: postId, p_body: 'Quiet reply', p_request_id: requestId });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await assert.rejects(() => publishLinkedHexonautComment(record, { postId, requestId, body: 'x'.repeat(2001) }, vault, fetcher), /post ID/);
  await assert.rejects(() => publishLinkedHexonautComment(record, { postId: '00000000-0000-4000-8000-000000000000', requestId, body: 'Quiet reply' }, vault, fetcher), /different comment/);
});

test('comment read-back is limited to the exact profile and target post', async () => {
  await assert.rejects(() => listLinkedHexonautComments(record, postId, vault,
    async () => ({ ok: true, json: async () => [{ id: 'comment-1', author_id: profileId, post_id: '00000000-0000-4000-8000-000000000000' }] })),
  /outside this Hexonaut or post/);
});
