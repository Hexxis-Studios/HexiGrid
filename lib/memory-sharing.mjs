import crypto from 'node:crypto';
import { normalizeContextScope } from './dated-memory.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHARE_ID = new RegExp(`^memory-share-${UUID}$`);
const LINEAGE_ID = new RegExp(`^lineage-${UUID}$`);
const LINK_ID = new RegExp(`^link-${UUID}$`);

export function normalizeMemoryShares(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!item || !SHARE_ID.test(String(item.id || '')) || seen.has(item.id) ||
      !LINEAGE_ID.test(String(item.sourceLineageId || '')) || !LINEAGE_ID.test(String(item.targetLineageId || '')) ||
      !LINK_ID.test(String(item.targetLinkId || '')) ||
      !String(item.sourceAgentId || '') || !String(item.targetAgentId || '') ||
      !['active', 'revoked'].includes(item.status) ||
      item.sourceAgentId === item.targetAgentId) return [];
    let scope;
    try { scope = normalizeContextScope(item.scope); } catch { return []; }
    if (!scope) return [];
    seen.add(item.id);
    return [{ id: item.id, sourceAgentId: String(item.sourceAgentId), sourceLineageId: item.sourceLineageId,
      targetAgentId: String(item.targetAgentId), targetLineageId: item.targetLineageId,
      targetLinkId: item.targetLinkId, scope,
      grantedAt: String(item.grantedAt || ''), grantedBy: String(item.grantedBy || ''),
      status: item.status === 'revoked' ? 'revoked' : 'active',
      revokedAt: item.status === 'revoked' ? String(item.revokedAt || '') : null }];
  });
}

export function findActiveMemoryShare(shares, { id, targetAgentId, targetLineageId, targetLinkId } = {}) {
  return (shares || []).find((item) => item.id === id && item.status === 'active' &&
    item.targetAgentId === targetAgentId && item.targetLineageId === targetLineageId &&
    item.targetLinkId === targetLinkId) || null;
}

export function grantMemoryShare(shares, { sourceAgentId, sourceLineageId, targetAgentId, targetLineageId, targetLinkId, scope, by, at } = {}) {
  const selected = normalizeContextScope(scope);
  if (!selected || !sourceAgentId || !targetAgentId || sourceAgentId === targetAgentId ||
    !LINEAGE_ID.test(String(sourceLineageId || '')) || !LINEAGE_ID.test(String(targetLineageId || '')) ||
    !LINK_ID.test(String(targetLinkId || ''))) {
    throw new Error('Memory sharing requires distinct active source and target agents.');
  }
  const existing = (shares || []).find((item) => item.status === 'active' && item.sourceAgentId === sourceAgentId &&
    item.sourceLineageId === sourceLineageId && item.targetAgentId === targetAgentId && item.targetLineageId === targetLineageId &&
    item.targetLinkId === targetLinkId &&
    item.scope.projectId === selected.projectId && (item.scope.topicId || '') === (selected.topicId || ''));
  if (existing) return { share: existing, created: false };
  const share = { id: `memory-share-${crypto.randomUUID()}`, sourceAgentId, sourceLineageId,
    targetAgentId, targetLineageId, targetLinkId, scope: selected, grantedAt: at || new Date().toISOString(), grantedBy: by || '',
    status: 'active', revokedAt: null };
  shares.push(share);
  return { share, created: true };
}

export function revokeMemoryShare(shares, id, at = new Date().toISOString()) {
  const share = (shares || []).find((item) => item.id === id);
  if (!share) return null;
  if (share.status === 'active') { share.status = 'revoked'; share.revokedAt = at; }
  return share;
}
