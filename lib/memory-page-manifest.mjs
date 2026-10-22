// Describes facts left out of one bounded retrieval response. This is not a
// record of model-context eviction: the caller decides what enters its prompt.
export function retrievalPageManifest({ projectId, topicId, entityId, records, nextOffset, oversizeIds,
  nextCursor, maxBytes = Infinity, basePacket } = {}) {
  const remaining = records.slice(nextOffset);
  const omittedCount = remaining.length + oversizeIds.length;
  if (!omittedCount) return {};
  const oversized = new Set(oversizeIds);
  const omitted = [...remaining, ...records.filter((record) => oversized.has(record.id))];
  let min = Infinity;
  let max = -Infinity;
  for (const record of omitted) {
    if (!Number.isFinite(record.importance)) continue;
    min = Math.min(min, record.importance);
    max = Math.max(max, record.importance);
  }
  const topics = [...new Set(omitted.map((record) => record.contextScope?.topicId).filter(Boolean))];
  const entities = [...new Set(omitted.flatMap((record) => Array.isArray(record.entityIds) ? record.entityIds : []))];
  const scope = { projectId, ...(topicId ? { topicId } : {}), ...(entityId ? { entityId } : {}) };
  const recovery = nextCursor && oversizeIds.length ? 'nextCursor+oversizeIds'
    : nextCursor ? 'nextCursor' : 'oversizeIds';
  const warning = nextCursor && oversizeIds.length
    ? 'Incomplete memory page: follow nextCursor and get-memory for oversizeIds.'
    : nextCursor ? 'Incomplete memory page: follow nextCursor.'
      : 'Incomplete memory page: use get-memory for oversizeIds.';
  const full = {
    pageOutManifest: {
      kind: 'retrieval-page', scope, omittedCount,
      ...(min !== Infinity ? { importanceRange: { min, max } } : {}),
      topics: topics.slice(0, 8), entities: entities.slice(0, 8),
      truncatedTopicCount: Math.max(0, topics.length - 8), truncatedEntityCount: Math.max(0, entities.length - 8),
      recovery
    },
    blindSpotWarning: warning
  };
  if (!basePacket || !Number.isFinite(maxBytes)) return full;
  const variants = [full,
    { pageOutManifest: { kind: 'retrieval-page', scope, omittedCount }, blindSpotWarning: warning },
    { blindSpotWarning: warning },
    { blindSpotWarning: 'Incomplete memory page.' },
    {}];
  return variants.find((fields) => Buffer.byteLength(JSON.stringify({ ...basePacket, ...fields }), 'utf8') <= maxBytes) || {};
}
