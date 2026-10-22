import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { findActiveMemoryShare, grantMemoryShare, normalizeMemoryShares, revokeMemoryShare } from '../lib/memory-sharing.mjs';

const id = (kind) => `${kind}-${crypto.randomUUID()}`;

test('an owner share stays bound to one target Link, lineage, and exact scope until revoked', () => {
  const shares = [];
  const sourceAgentId = id('agent');
  const sourceLineageId = id('lineage');
  const targetAgentId = id('agent');
  const targetLineageId = id('lineage');
  const targetLinkId = id('link');
  const input = { sourceAgentId, sourceLineageId, targetAgentId, targetLineageId, targetLinkId,
    scope: { projectId: 'private-project', topicId: 'current-plan' }, by: 'owner:session', at: '2026-09-28T00:00:00.000Z' };
  const first = grantMemoryShare(shares, input);
  assert.equal(first.created, true);
  assert.equal(grantMemoryShare(shares, input).created, false);
  assert.equal(shares.length, 1);
  assert.equal(findActiveMemoryShare(shares, { id: first.share.id, targetAgentId, targetLineageId, targetLinkId }), first.share);
  assert.equal(findActiveMemoryShare(shares, { id: first.share.id, targetAgentId, targetLineageId, targetLinkId: id('link') }), null);
  assert.equal(findActiveMemoryShare(shares, { id: first.share.id, targetAgentId, targetLineageId: id('lineage'), targetLinkId }), null);
  assert.equal(grantMemoryShare(shares, { ...input, scope: { projectId: 'private-project', topicId: 'other' } }).created, true);
  revokeMemoryShare(shares, first.share.id, '2026-09-28T01:00:00.000Z');
  assert.equal(findActiveMemoryShare(shares, { id: first.share.id, targetAgentId, targetLineageId, targetLinkId }), null);
  assert.equal(grantMemoryShare(shares, input).created, true);
});

test('normalization never revives malformed, duplicate, or unknown-status shares', () => {
  const item = grantMemoryShare([], { sourceAgentId: id('agent'), sourceLineageId: id('lineage'),
    targetAgentId: id('agent'), targetLineageId: id('lineage'), targetLinkId: id('link'),
    scope: { projectId: 'one' } }).share;
  const normalized = normalizeMemoryShares([item, { ...item }, { ...item, id: id('memory-share'), status: 'pending' },
    { ...item, id: id('memory-share'), scope: null }, { ...item, id: id('memory-share'), targetLinkId: id('bad-link') }]);
  assert.deepEqual(normalized, [item]);
  assert.throws(() => grantMemoryShare([], { ...item, scope: null }), /requires distinct active source and target agents/);
});
