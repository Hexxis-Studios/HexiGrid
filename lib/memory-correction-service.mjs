import crypto from 'node:crypto';
import { createMemoryMistakeLedger, memoryMistakeDatedEntry } from './memory-mistake-ledger.mjs';

function excerpt(value, limit) {
  const text = String(value ?? '').trim();
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let output = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit - 18) break;
    output += character; bytes += size;
  }
  return `${output} [excerpt limited]`;
}

/** Called only after the route resolves retained evidence and trusted authority.
 * No model output or supplied excerpt is an independent write authorization. */
export async function commitMemoryCorrection({ store, request, authority, assertAuthorized,
  resolveRecurrence, onCommitStateChange = () => {} } = {}) {
  if (!store || typeof assertAuthorized !== 'function') throw new TypeError('Correction requires an authorized canonical store.');
  assertAuthorized();
  const current = await store.getById({ lineageId: request.lineageId, id: request.id, depth: 2 });
  assertAuthorized();
  if (!current) throw new Error('Memory record was not found.');
  let timestamp = request.createdAt;
  let source = request.source;
  if (!source || !['owner-feedback', 'agent-link-message'].includes(source.kind) || !source.text) {
    throw new Error('An exact retained correction source is required.');
  }
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sameChanges = (saved, requested) => {
    const keys = Object.keys(saved).filter(key => !['importance', 'verification'].includes(key)).sort();
    const requestedKeys = Object.keys(requested || {}).filter(key => !['importance', 'verification'].includes(key)).sort();
    return same(keys, requestedKeys) && keys.every(key => same(saved[key], requested[key]));
  };
  const prior = current.revision !== request.expectedRevision && current.revisions.find(revision =>
    revision.number === request.expectedRevision + 1 && revision.learning?.source?.kind === source.kind &&
    revision.learning.source.text === source.text && (!source.id || revision.learning.source.id === source.id) &&
    (!source.linkId || revision.learning.source.linkId === source.linkId) && revision.why === request.why &&
    revision.learning.expectedNextBehavior === request.expectedNextBehavior &&
    sameChanges(revision.changes, request.changes) &&
    (authority.author.kind === 'owner' ? revision.by.startsWith('owner:') : revision.by === request.by));
  if (current.revision !== request.expectedRevision && !prior) throw new Error('Memory revision conflict; reload the current record.');
  let before = current;
  let author = authority.author;
  if (prior) {
    const historical = await store.getById({ lineageId: request.lineageId, id: request.id, asOf: prior.at, depth: 0 });
    assertAuthorized();
    before = { ...historical, text: prior.previous.text,
      contextScope: Object.hasOwn(prior.previous, 'contextScope') ? prior.previous.contextScope : historical.contextScope };
    timestamp = prior.at;
    source = prior.learning.source;
    if (authority.author.kind === 'owner') author = { kind: 'owner', id: prior.by.slice('owner:'.length) };
  }
  const sourceId = source.id || `feedback-${crypto.createHash('sha256')
    .update(JSON.stringify([request.id, request.expectedRevision, source.text])).digest('hex').slice(0, 32)}`;
  const exactSource = { ...source, id: sourceId, createdAt: source.createdAt || timestamp };
  const kind = source.kind === 'agent-link-message' ? 'link-message' : 'owner-feedback';
  const trusted = { ...authority, author, contextScope: before.contextScope ?? null };
  let correctionReceipt;
  const ledger = createMemoryMistakeLedger({
    authorize: () => { assertAuthorized(); return { allowed: true }; },
    verifyEvidence: async ({ reference }) => ({ verified: true, ...reference,
      excerpt: excerpt(exactSource.text, 4096), observedAt: exactSource.createdAt }),
    loadById: async ({ id }) => {
      const saved = await store.getById({ lineageId: request.lineageId,
        id: `memory-${id.slice('mistake-'.length)}`, depth: 2 });
      assertAuthorized();
      return saved?.metadata?.memoryMistake?.record
        ? { ...saved.metadata.memoryMistake.record, status: saved.status, revision: saved.revision } : null;
    },
    commit: async (record, options) => {
      options.assertAuthorized();
      if (prior) throw new Error('The historical correction has no matching canonical mistake receipt.');
      onCommitStateChange(true);
      try {
        correctionReceipt = await store.appendCorrection({ ...request, source: exactSource,
          mistakeEntry: memoryMistakeDatedEntry(record), assertAuthorized: options.assertAuthorized });
      } finally { onCommitStateChange(false); }
      return { created: true, record };
    }, resolveRecurrence, now: () => timestamp
  });
  const recorded = await ledger.record({ whatWentWrong: excerpt(before.text, 2048),
    correction: excerpt(request.changes?.text, 2048), resultingFix: excerpt(request.expectedNextBehavior, 2048),
    evidence: { kind, id: sourceId }, recurrenceOf: request.recurrenceOf === undefined ? [] : request.recurrenceOf,
    idempotencyKey: `correction-${request.id}-${request.expectedRevision}` }, trusted);
  if (prior) return { id: request.id, revisionId: prior.id, revision: prior.number,
    date: current.date, committedDate: prior.at.slice(0, 10), mistakeId: recorded.id, duplicate: true };
  if (!correctionReceipt) throw new Error('Canonical mistake receipt exists without its correction revision.');
  const { mistakeEntry, ...receipt } = correctionReceipt;
  return { ...receipt, mistakeId: mistakeEntry.metadata.memoryMistake.record.id };
}
