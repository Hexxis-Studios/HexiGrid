import crypto from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_EVENTS = 1000;
const KINDS = new Set(['recall-context', 'recall-entity', 'semantic-search']);
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MEMORY_ID = /^memory-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PAGE_OUTS = 100;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const scopeDigest = ({ agentId, lineageId }) => {
  if (typeof agentId !== 'string' || !agentId || typeof lineageId !== 'string' || !lineageId) {
    throw new Error('Retrieval metric agent and lineage are required.');
  }
  return digest(`${agentId}\0${lineageId}`);
};

function validState(state, maxEvents) {
  if (!state || state.version !== 1 || !Array.isArray(state.events) || !Array.isArray(state.memories) ||
      state.events.length > maxEvents || state.memories.length > 100000 ||
      (state.scopeHash !== undefined && !HASH.test(state.scopeHash)) ||
      (state.inventory !== undefined && (!Array.isArray(state.inventory) || state.inventory.length > 100000)) ||
      (state.pageOuts !== undefined && (!Array.isArray(state.pageOuts) || state.pageOuts.length > MAX_PAGE_OUTS)) || !state.totals ||
      !['retrieved', 'rated', 'hits'].every((name) => count(state.totals[name])) ||
      state.totals.hits > state.totals.rated || state.totals.rated > state.totals.retrieved) return false;
  if (state.events.some(([id, event]) => !HASH.test(id) || !KINDS.has(event?.kind) ||
      !Array.isArray(event.ids) || event.ids.length > 100 || event.ids.some((hash) => !HASH.test(hash)) ||
      (event.linkHash !== undefined && !HASH.test(event.linkHash)) || typeof event.rated !== 'boolean')) return false;
  if (state.memories.some(([hash, metric]) => !HASH.test(hash) || !count(metric?.shown) ||
      !count(metric?.rated) || !count(metric?.useful) || metric.useful > metric.rated || metric.rated > metric.shown)) return false;
  if (state.inventory?.some(([hash, timestamp]) => !HASH.test(hash) || !Number.isFinite(Date.parse(timestamp)))) return false;
  if (state.pageOuts?.some((item) => {
    try { normalizePageOut(item); return false; } catch { return true; }
  })) return false;
  return true;
}

function normalizePageOut(input) {
  const contextId = (value) => typeof value === 'string' && CONTEXT_ID.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !KINDS.has(input.kind) || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) ||
      !Number.isSafeInteger(input.omittedCount) || input.omittedCount < 1 || input.omittedCount > 1000000 ||
      !input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope) ||
      Object.keys(input.scope).some((key) => !['projectId', 'topicId', 'entityId'].includes(key)) ||
      !contextId(input.scope.projectId) ||
      input.scope.topicId !== undefined && !contextId(input.scope.topicId) ||
      input.scope.entityId !== undefined && !contextId(input.scope.entityId) ||
      !Array.isArray(input.topics) || input.topics.length > 8 || input.topics.some((value) => !contextId(value)) ||
      !Array.isArray(input.entities) || input.entities.length > 8 || input.entities.some((value) => !contextId(value)) ||
      input.truncatedTopicCount !== undefined && !count(input.truncatedTopicCount) ||
      input.truncatedEntityCount !== undefined && !count(input.truncatedEntityCount) ||
      !['nextCursor', 'oversizeIds', 'nextCursor+oversizeIds'].includes(input.recovery)) {
    throw new Error('Memory page-out manifest is invalid.');
  }
  const importanceRange = input.importanceRange;
  if (importanceRange !== undefined && (!importanceRange || typeof importanceRange !== 'object' || Array.isArray(importanceRange) ||
      !Number.isFinite(importanceRange.min) || !Number.isFinite(importanceRange.max) || importanceRange.min < 0 ||
      importanceRange.max > 1 || importanceRange.min > importanceRange.max)) throw new Error('Memory page-out importance range is invalid.');
  return {
    at: new Date(input.at).toISOString(), kind: input.kind,
    scope: { projectId: input.scope.projectId, ...(input.scope.topicId ? { topicId: input.scope.topicId } : {}),
      ...(input.scope.entityId ? { entityId: input.scope.entityId } : {}) },
    omittedCount: input.omittedCount, ...(importanceRange ? { importanceRange: { min: importanceRange.min, max: importanceRange.max } } : {}),
    topics: [...input.topics], entities: [...input.entities], truncatedTopicCount: input.truncatedTopicCount || 0,
    truncatedEntityCount: input.truncatedEntityCount || 0, recovery: input.recovery
  };
}

// Private local telemetry. No query, fact text, source path, or raw IDs are
// retained. Relevance means explicit caller feedback, not a guessed hit.
export function createRetrievalMetrics({ maxEvents = MAX_EVENTS, deadWeightMinimum = 5, initialState, scope } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000 ||
      !Number.isSafeInteger(deadWeightMinimum) || deadWeightMinimum < 2) throw new Error('Retrieval metric limits are invalid.');
  // Memory IDs contain random UUIDs, so their SHA-256 digests are safe to
  // persist without a secret key or reversible plaintext identifier map.
  const selectedScope = scope === undefined ? null : scopeDigest(scope);
  const hash = (id) => digest(`${selectedScope || ''}\0${id}`);
  if (initialState && !validState(initialState, maxEvents)) {
    throw new Error('The private retrieval metrics file is invalid.');
  }
  if (initialState && (initialState.scopeHash || null) !== selectedScope) {
    throw new Error('The private retrieval metrics file belongs to another agent or lineage.');
  }
  const events = new Map(initialState?.events || []);
  const totals = initialState?.totals || { retrieved: 0, rated: 0, hits: 0 };
  const perMemory = new Map(initialState?.memories || []);
  const inventory = new Map(initialState?.inventory || []);
  const pageOuts = (initialState?.pageOuts || []).map(normalizePageOut);
  const ids = (records, strict = false) => {
    if (!Array.isArray(records) || records.length > 100) throw new Error('Retrieval metric records must be a bounded list.');
    const values = records.map((record) => typeof record === 'string' ? record : record?.id);
    if (strict && values.some((id) => typeof id !== 'string' || !MEMORY_ID.test(id))) throw new Error('Retrieval feedback memory ID is invalid.');
    return [...new Set(values.filter((id) => typeof id === 'string' && MEMORY_ID.test(id)).map((id) => hash(id.toLowerCase())))];
  };
  const linkHash = (linkId) => {
    if (!selectedScope) return null;
    if (typeof linkId !== 'string' || !linkId) throw new Error('Retrieval metric Link identity is required.');
    return digest(`${selectedScope}\0${linkId}`);
  };

  return Object.freeze({
    registerInventory({ records, now = new Date().toISOString() } = {}) {
      if (!Array.isArray(records) || records.length > 100000 || !Number.isFinite(Date.parse(now))) throw new Error('Retrieval inventory is invalid.');
      const timestamp = new Date(now).toISOString();
      const next = new Map();
      for (const record of records) {
        if (!record || typeof record.id !== 'string' || !MEMORY_ID.test(record.id)) throw new Error('Retrieval inventory contains an invalid memory ID.');
        const id = hash(record.id.toLowerCase());
        const created = record.createdAt && Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) <= Date.parse(timestamp)
          ? new Date(record.createdAt).toISOString() : timestamp;
        next.set(id, inventory.get(id) || created);
      }
      inventory.clear();
      for (const [id, firstSeen] of next) inventory.set(id, firstSeen);
      return { registered: inventory.size };
    },
    recordRetrieval({ kind, records, linkId, pageOutManifest, at = new Date().toISOString() } = {}) {
      if (!KINDS.has(kind)) throw new Error('Retrieval metric kind is invalid.');
      const recordHashes = ids(records);
      const pageOut = pageOutManifest === undefined ? null : normalizePageOut({ ...pageOutManifest, kind, at });
      const retrievalId = crypto.randomUUID();
      const selectedLink = linkHash(linkId);
      events.set(digest(retrievalId), { kind, ids: recordHashes, rated: false, ...(selectedLink ? { linkHash: selectedLink } : {}) });
      totals.retrieved += 1;
      for (const id of recordHashes) {
        const metric = perMemory.get(id) || { shown: 0, rated: 0, useful: 0 };
        metric.shown += 1;
        perMemory.set(id, metric);
      }
      if (pageOut) {
        pageOuts.push(pageOut);
        if (pageOuts.length > MAX_PAGE_OUTS) pageOuts.splice(0, pageOuts.length - MAX_PAGE_OUTS);
      }
      if (events.size > maxEvents) events.delete(events.keys().next().value);
      if (perMemory.size > 100000) perMemory.delete(perMemory.keys().next().value);
      return retrievalId;
    },
    listPageOuts({ limit = 3 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Memory page-out history limit must be 1 to 10.');
      const rows = pageOuts.slice(-limit).reverse().map((item) => structuredClone(item));
      return { pageOuts: rows, hasMore: pageOuts.length > rows.length,
        note: 'These are HexiGrid retrieval omissions only. They do not report what an external model provider removed from its hidden context.' };
    },
    recordFeedback({ retrievalId, usefulIds = [], linkId } = {}) {
      if (typeof retrievalId !== 'string' || !UUID.test(retrievalId)) throw new Error('Retrieval feedback ID is invalid.');
      const selectedLink = linkHash(linkId);
      const event = events.get(digest(retrievalId));
      if (!event || event.rated) throw new Error('Retrieval feedback is unknown or already recorded.');
      if ((event.linkHash || null) !== selectedLink) throw new Error('Retrieval feedback is unknown or already recorded.');
      const useful = ids(usefulIds, true);
      if (useful.some((id) => !event.ids.includes(id))) throw new Error('Retrieval feedback names a memory outside that result.');
      event.rated = true;
      totals.rated += 1;
      if (useful.length) totals.hits += 1;
      for (const id of event.ids) {
        const metric = perMemory.get(id);
        metric.rated += 1;
        if (useful.includes(id)) metric.useful += 1;
      }
      return { recorded: true };
    },
    summary({ records, now = new Date().toISOString(), days = 30 } = {}) {
      if (!Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('Retrieval metric window is invalid.');
      if (records !== undefined && (!Array.isArray(records) || records.length > 100000 ||
        records.some((record) => !record || typeof record.id !== 'string' || !MEMORY_ID.test(record.id)))) {
        throw new Error('Retrieval inventory is invalid.');
      }
      const currentInventory = records === undefined ? inventory : new Map(records.map((record) => {
        const key = hash(record.id.toLowerCase());
        const created = Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : now;
        return [key, inventory.get(key) || created];
      }));
      const cutoff = Date.parse(now) - days * 86400000;
      let everRetrieved = 0;
      let neverRetrievedOverN = 0;
      for (const [id, firstSeen] of currentInventory) {
        if ((perMemory.get(id)?.shown || 0) > 0) everRetrieved += 1;
        else if (Date.parse(firstSeen) <= cutoff) neverRetrievedOverN += 1;
      }
      const deadWeightCandidates = [...currentInventory.keys()].filter((id) => {
        const metric = perMemory.get(id);
        return metric && metric.rated >= deadWeightMinimum && metric.useful === 0;
      }).length;
      return {
        retrievals: totals.retrieved, ratedRetrievals: totals.rated,
        unratedRetrievals: totals.retrieved - totals.rated,
        hits: totals.hits, hitRate: totals.rated ? totals.hits / totals.rated : null,
        deadWeightCandidates, criterion: `${deadWeightMinimum} rated appearances without useful feedback`,
        inventoryCount: currentInventory.size, neverRetrievedOverN, neverRetrievedDays: days,
        storePercentEverRetrieved: currentInventory.size ? everRetrieved / currentInventory.size : null,
        automaticDeletion: false, retention: 'local private metrics file when configured'
      };
    },
    review({ records, now = new Date().toISOString(), days = 30, limit = 100, offset = 0 } = {}) {
      if (!Array.isArray(records) || records.length > 100000 ||
        !Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(days) || days < 1 || days > 3650 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0) throw new Error('Retrieval review page is invalid.');
      const cutoff = Date.parse(now) - days * 86400000;
      const current = records.map((record) => {
        if (!record || typeof record.id !== 'string' || !MEMORY_ID.test(record.id)) throw new Error('Retrieval review memory ID is invalid.');
        const id = record.id.toLowerCase();
        const key = hash(id);
        const metric = perMemory.get(key) || { shown: 0, rated: 0, useful: 0 };
        const firstSeen = inventory.get(key) || (Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : now);
        const neverRetrievedOverN = metric.shown === 0 && Date.parse(firstSeen) <= cutoff;
        const deadWeightCandidate = metric.rated >= deadWeightMinimum && metric.useful === 0;
        return { id, shown: metric.shown, rated: metric.rated, useful: metric.useful,
          hitRate: metric.rated ? metric.useful / metric.rated : null,
          neverRetrievedOverN, deadWeightCandidate, needsReview: neverRetrievedOverN || deadWeightCandidate };
      }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || a.id.localeCompare(b.id));
      return { total: current.length, candidateCount: current.filter((item) => item.needsReview).length,
        memories: current.slice(offset, offset + limit), nextOffset: offset + limit < current.length ? offset + limit : null,
        automaticDeletion: false };
    },
    snapshot() {
      return { version: 1, ...(selectedScope ? { scopeHash: selectedScope } : {}), totals: { ...totals }, events: [...events], memories: [...perMemory], inventory: [...inventory], pageOuts: pageOuts.map((item) => structuredClone(item)) };
    }
  });
}

// Persists only aggregate counts, opaque random request IDs, and hashes of
// random memory IDs. The selected file must live in the app's private data root.
export async function openLocalRetrievalMetrics({ file, maxEvents = MAX_EVENTS, deadWeightMinimum = 5, scope } = {}) {
  if (!path.isAbsolute(String(file || ''))) throw new Error('A private absolute retrieval metrics file is required.');
  let initialState;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('The private retrieval metrics file is invalid.');
    initialState = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let metrics = createRetrievalMetrics({ maxEvents, deadWeightMinimum, initialState, scope });
  const directory = path.dirname(file);
  async function persist() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.pending`;
    try {
      await writeFile(temporary, JSON.stringify(metrics.snapshot()), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  let queue = Promise.resolve();
  const mutate = (action) => {
    const next = queue.then(async () => {
      const before = metrics.snapshot();
      try { const result = action(); await persist(); return result; }
      catch (error) { metrics = createRetrievalMetrics({ maxEvents, deadWeightMinimum, initialState: before, scope }); throw error; }
    });
    queue = next.catch(() => {});
    return next;
  };
  return Object.freeze({
    registerInventory: (input) => mutate(() => metrics.registerInventory(input)),
    recordRetrieval: (input) => mutate(() => metrics.recordRetrieval(input)),
    listPageOuts: async (input) => { await queue; return metrics.listPageOuts(input); },
    recordFeedback: (input) => mutate(() => metrics.recordFeedback(input)),
    summary: async (input) => { await queue; return metrics.summary(input); },
    review: async (input) => { await queue; return metrics.review(input); }
  });
}
