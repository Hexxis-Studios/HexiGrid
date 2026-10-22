import crypto from 'node:crypto';
import { validateMemoryProposal } from './dated-memory.mjs';
import { processMemoryExtractionBatch } from './memory-extraction.mjs';

const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SOURCE_KINDS = new Set(['room-turn', 'task-run']);
const STORE_KEY = 'memoryLearningQueue';
const STORE_VERSION = 1;
const MAX_BATCH_QUARANTINES = 16;
const QUARANTINE_REASON_CODES = Object.freeze(['delayed_prompt_injection', 'high_confidence_ssn',
  'payment_card_number', 'unsupported_shape', 'input_too_large', 'write_spike']);
const DEFAULTS = Object.freeze({ maxQueue: 256, maxReceipts: 256, maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  baseRetryMs: 10_000, maxRetryMs: 60 * 60 * 1000, maxAttempts: 6, idleRetryMs: 5_000, quietMs: 3_000 });

/**
 * A one-tick worker for references to completed local room/task sources.
 * Persist `state.memoryLearningQueue` through the app's existing encrypted
 * state saver. Queue entries and receipts contain identifiers and status only;
 * retained transcript text exists only in the transient resolved source. This
 * module owns no timer, source hook, model, or direct memory-store write.
 *
 * The caller must ensure `extractLocally` is a local route and `submitCandidate`
 * is the existing idempotent proposal service that enforces effective policy
 * and review at commit. A source resolver must revalidate completion, stable
 * IDs, lineage, agent, and scope before returning text.
 */
export function createMemoryLearningWorker(options = {}) {
  const limits = normalizeOptions(options);
  let started = false;
  let activeController = null;
  let active = false;
  let yieldRequested = false;
  let idleSince = null;
  let mutationTail = Promise.resolve();

  function now() {
    try {
      const value = typeof options.now === 'function' ? options.now() : Date.now();
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
    } catch { return Date.now(); }
  }

  function readStore() {
    const current = options.state?.[STORE_KEY];
    if (current === undefined) return emptyStore();
    if (!current || current.version !== STORE_VERSION || !Array.isArray(current.jobs) ||
      !Array.isArray(current.receipts) || current.jobs.length > limits.maxQueue ||
      current.receipts.length > limits.maxReceipts) return null;
    const jobs = [];
    for (const value of current.jobs) {
      const job = normalizeStoredJob(value);
      if (!job) return null;
      jobs.push(job);
    }
    const receipts = [];
    for (const value of current.receipts) {
      const receipt = normalizeReceipt(value);
      if (!receipt) return null;
      receipts.push(receipt);
    }
    return { version: STORE_VERSION, jobs, receipts };
  }

  function mutateStore(change) {
    const operation = mutationTail.catch(() => {}).then(async () => {
      if (!options.state || typeof options.state !== 'object' || typeof options.saveState !== 'function') {
        return { ok: false, reason: 'state-adapter-unavailable' };
      }
      const current = readStore();
      if (!current) return { ok: false, reason: 'queue-state-invalid' };
      const changed = change(current, now());
      if (changed.result) return { ok: true, ...changed.result };
      const previous = options.state[STORE_KEY];
      options.state[STORE_KEY] = {
        version: STORE_VERSION,
        jobs: changed.store.jobs.slice(-limits.maxQueue),
        receipts: changed.store.receipts.slice(-limits.maxReceipts)
      };
      try {
        await options.saveState();
        return { ok: true, ...(changed.value || {}) };
      } catch {
        options.state[STORE_KEY] = previous;
        return { ok: false, reason: 'queue-state-save-failed' };
      }
    });
    mutationTail = operation.catch(() => {});
    return operation;
  }

  function start() {
    if (!limits) return { status: 'unavailable', reason: 'worker-adapters-invalid' };
    started = true;
    idleSince = null;
    yieldRequested = false;
    return { status: 'started' };
  }

  function stop() {
    started = false;
    idleSince = null;
    yieldRequested = false;
    if (activeController) activeController.abort();
    return { status: 'stopped' };
  }

  function notifyInteractive() {
    idleSince = null;
    yieldRequested = true;
    if (activeController) activeController.abort();
  }

  async function enqueueCompletedSource(value = {}) {
    if (!limits) return { status: 'unavailable', reason: 'worker-adapters-invalid' };
    const reference = normalizeReference(value);
    if (!reference) return { status: 'skipped', reason: 'source-reference-invalid' };
    const key = referenceKey(reference);
    const result = await mutateStore((store, at) => {
      const pruned = prune(store, at, limits);
      if (pruned.jobs.some((job) => job.key === key) || pruned.receipts.some((item) => item.key === key)) {
        return { store: pruned, result: { status: 'duplicate', key } };
      }
      if (pruned.jobs.length >= limits.maxQueue) return { store: pruned, result: { status: 'unavailable', reason: 'queue-full' } };
      const job = Object.freeze({ ...reference, key, enqueuedAt: at, attempts: 0, nextAttemptAt: at });
      return { store: { ...pruned, jobs: [...pruned.jobs, job] }, value: { status: 'queued', key } };
    });
    return result.ok ? { status: result.status || 'queued', ...(result.key ? { key: result.key } : {}), ...(result.reason ? { reason: result.reason } : {}) }
      : { status: 'unavailable', reason: result.reason };
  }

  async function tick() {
    if (!limits) return { status: 'unavailable', reason: 'worker-adapters-invalid' };
    if (!started) return { status: 'stopped' };
    if (active) return { status: 'busy' };
    // Claim the single-job slot before the first await. Otherwise two ticks
    // released together by the scheduler can both enter the same queue item.
    active = true;
    try { return await tickBody(); }
    finally {
      activeController = null;
      active = false;
    }
  }

  async function tickBody() {
    const idleWindow = await observeQuietWindow();
    if (!idleWindow.ready) return { status: 'deferred', reason: idleWindow.reason };
    const current = readStore();
    if (!current) return { status: 'unavailable', reason: 'queue-state-invalid' };
    const at = now();
    const store = prune(current, at, limits);
    const job = store.jobs.find((candidate) => candidate.nextAttemptAt <= at);
    if (store.jobs.length !== current.jobs.length || store.receipts.length !== current.receipts.length) {
      const saved = await mutateStore((latest, saveAt) => ({ store: prune(latest, saveAt, limits), value: {} }));
      if (!saved.ok) return { status: 'unavailable', reason: saved.reason };
      const afterPrune = await observeQuietWindow();
      if (!afterPrune.ready) return { status: 'deferred', reason: afterPrune.reason };
    }
    if (!job) return { status: 'idle' };
    // A persisted lease at the retry ceiling may represent a crash after the
    // proposal service committed but before the queue receipt was saved. Do
    // not execute it again; close it as uncertain and require reconciliation.
    if (job.attempts >= limits.maxAttempts) return complete(job, 'uncertain', 'retry-exhausted');
    if (!started) return { status: 'stopped' };
    activeController = new AbortController();
    const controller = activeController;
    const attempt = job.attempts + 1;
    const leaseAt = at + retryDelay(attempt, limits);
    const leased = await mutateStore((latest) => {
      const index = latest.jobs.findIndex((candidate) => candidate.key === job.key);
      if (index < 0) return { store: latest, result: { status: 'gone' } };
      const jobs = latest.jobs.slice();
      jobs[index] = Object.freeze({ ...jobs[index], attempts: attempt, nextAttemptAt: leaseAt });
      return { store: { ...latest, jobs }, value: { status: 'leased' } };
    });
    if (!leased.ok || leased.status === 'gone') {
      activeController = null;
      return { status: leased.ok ? 'idle' : 'unavailable', reason: leased.reason };
    }

    try {
      return await processJob(job, controller, attempt);
    } catch {
      return await retryOrFinish(job, attempt, 'worker-step-failed');
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  async function processJob(job, controller, attempt) {
    if (controller.signal.aborted || !started || yieldRequested) return defer(job, attempt);
    if (!await enabled(job)) return complete(job, 'skipped', 'learning-disabled');
    if (controller.signal.aborted || !started || yieldRequested) return defer(job, attempt);
    if (!await authorized(job, 'worker')) return complete(job, 'blocked', 'authorization-denied');
    if (controller.signal.aborted || !started || yieldRequested) return defer(job, attempt);
    if (await shouldYield()) return defer(job, attempt);

    let source;
    try {
      source = await options.resolveSource({ reference: publicReference(job), signal: controller.signal });
    } catch {
      if (controller.signal.aborted || !started) return defer(job, attempt);
      return retryOrFinish(job, attempt, 'source-resolution-failed');
    }
    if (controller.signal.aborted || !started) return defer(job, attempt);
    if (!source) return complete(job, 'skipped', 'source-unavailable');
    const resolved = normalizeResolvedSource(source, job);
    if (!resolved) return complete(job, 'skipped', 'source-identity-or-completion-changed');
    if (await shouldYield()) return defer(job, attempt);
    if (!await enabled(job)) return complete(job, 'skipped', 'learning-disabled');
    if (!await authorized(job, 'extract')) return complete(job, 'blocked', 'authorization-denied');
    if (controller.signal.aborted || !started || await shouldYield()) return defer(job, attempt);

    const report = await processMemoryExtractionBatch({
      enabled: true,
      agentId: job.agentId,
      lineageId: job.lineageId,
      scope: job.scope,
      source: resolved,
      signal: controller.signal,
      isEnabled: () => enabled(job),
      extractLocally: options.extractLocally,
      listCurrentFacts: (input) => options.listCurrentFacts({ ...input, agentId: job.agentId }),
      assessRelation: options.assessRelation,
      authorize: (input) => options.authorize({ ...input, agentId: job.agentId,
        jobReference: publicReference(job) }),
      submitCandidate: (input) => options.submitCandidate({ ...input, jobReference: publicReference(job) })
    });

    if (controller.signal.aborted || !started || report.status === 'cancelled') return defer(job, attempt);
    if (report.status === 'unavailable') return retryOrFinish(job, attempt, report.reason || 'extraction-unavailable', report);
    if (report.status === 'disabled') return complete(job, 'skipped', 'learning-disabled', report);
    if (report.status === 'blocked') return complete(job, 'blocked', report.reason || 'authorization-denied', report);
    return complete(job, report.status, report.reason || 'batch-processed', report);
  }

  async function enabled(job) {
    try { return await options.isEnabled({ agentId: job.agentId, lineageId: job.lineageId, scope: cloneScope(job.scope) }) === true; }
    catch { return false; }
  }

  async function authorized(job, phase) {
    try {
      const result = await options.authorize({ phase, agentId: job.agentId, lineageId: job.lineageId,
        scope: cloneScope(job.scope), sourceRef: publicReference(job) });
      return result === true || Boolean(result && typeof result === 'object' && result.allowed === true);
    } catch { return false; }
  }

  async function interactiveBusy() {
    try {
      const value = await options.isInteractiveBusy();
      return typeof value === 'boolean' ? value : null;
    }
    catch { return null; }
  }

  async function shouldYield() {
    const idleWindow = await observeQuietWindow();
    return !idleWindow.ready;
  }

  async function observeQuietWindow() {
    const busy = await interactiveBusy();
    if (busy === null) {
      idleSince = null;
      return { ready: false, reason: 'interactive-state-unavailable' };
    }
    if (busy) {
      idleSince = null;
      return { ready: false, reason: 'interactive-work-active' };
    }
    const observedAt = now();
    if (yieldRequested) {
      yieldRequested = false;
      idleSince = observedAt;
      return { ready: false, reason: 'interactive-work-active' };
    }
    if (idleSince === null || observedAt < idleSince) idleSince = observedAt;
    const ready = observedAt - idleSince >= limits.quietMs;
    return { ready, reason: ready ? '' : 'quiet-window' };
  }

  async function defer(job, attempt) {
    const at = now();
    const saved = await mutateStore((store) => {
      const index = store.jobs.findIndex((candidate) => candidate.key === job.key);
      if (index < 0) return { store, result: { status: 'gone' } };
      const jobs = store.jobs.slice();
      jobs[index] = Object.freeze({ ...jobs[index], attempts: Math.max(0, attempt - 1),
        nextAttemptAt: Math.max(jobs[index].nextAttemptAt, at + limits.idleRetryMs) });
      return { store: { ...store, jobs }, value: { status: 'deferred' } };
    });
    return saved.ok ? { status: 'deferred', reason: 'interactive-work-active' }
      : { status: 'unavailable', reason: saved.reason };
  }

  async function retryOrFinish(job, attempt, reason, report = null) {
    if (attempt >= limits.maxAttempts) return complete(job, 'uncertain', 'retry-exhausted', report);
    const at = now();
    const nextAttemptAt = at + retryDelay(attempt, limits);
    const saved = await mutateStore((store) => {
      const index = store.jobs.findIndex((candidate) => candidate.key === job.key);
      if (index < 0) return { store, result: { status: 'gone' } };
      const jobs = store.jobs.slice();
      jobs[index] = Object.freeze({ ...jobs[index], attempts: attempt, nextAttemptAt });
      return { store: { ...store, jobs }, value: { status: 'retry-scheduled' } };
    });
    return saved.ok ? { status: 'retry-scheduled', reason, nextAttemptAt }
      : { status: 'unavailable', reason: saved.reason };
  }

  async function complete(job, status, reason, report = null) {
    const at = now();
    const quarantineMetrics = report ? normalizeQuarantineMetrics(report.quarantinedCount,
      report.quarantineReasonCounts) : null;
    const receipt = Object.freeze({ key: job.key, at, status, reason,
      sourceKind: job.kind, sourceId: job.id, batchId: job.batchId, agentId: job.agentId,
      ...(report ? { submittedCount: report.submittedCount || 0, committedCount: report.committedCount || 0,
        pendingReviewCount: report.pendingReviewCount || 0, duplicateCount: report.duplicateCount || 0,
        skippedCount: report.skippedCount || 0, ...quarantineMetrics } : {}) });
    const saved = await mutateStore((store) => ({ store: {
      ...store, jobs: store.jobs.filter((candidate) => candidate.key !== job.key),
      receipts: [...store.receipts.filter((item) => item.key !== job.key), receipt]
    }, value: { status, reason } }));
    return saved.ok ? { status, reason } : { status: 'unavailable', reason: saved.reason };
  }

  return Object.freeze({ start, stop, notifyInteractive, enqueueCompletedSource, tick,
    status() {
      const store = readStore();
      return store ? Object.freeze({ started, active, queued: store.jobs.length, receipts: store.receipts.length })
        : Object.freeze({ started, active, queued: null, receipts: null, error: 'queue-state-invalid' });
    }
  });
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || !options.state || typeof options.saveState !== 'function' ||
    typeof options.resolveSource !== 'function' || typeof options.isEnabled !== 'function' ||
    typeof options.authorize !== 'function' || typeof options.isInteractiveBusy !== 'function' ||
    typeof options.extractLocally !== 'function' || typeof options.listCurrentFacts !== 'function' ||
    typeof options.assessRelation !== 'function' || typeof options.submitCandidate !== 'function') return null;
  const result = {};
  const maxima = { maxQueue: 1024, maxReceipts: 2048, maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    baseRetryMs: 60 * 60 * 1000, maxRetryMs: 24 * 60 * 60 * 1000,
    maxAttempts: 20, idleRetryMs: 60 * 60 * 1000, quietMs: 60_000 };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < (key === 'quietMs' ? 0 : 1) || value > maxima[key]) return null;
    result[key] = value;
  }
  if (result.maxRetryMs < result.baseRetryMs) return null;
  return Object.freeze(result);
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object' || value.completed !== true ||
    !SOURCE_KINDS.has(value.kind) || !validIdentifier(value.id) || !validIdentifier(value.batchId) ||
    !validIdentifier(value.agentId) || !LINEAGE_ID.test(String(value.lineageId || '')) || !Object.hasOwn(value, 'scope')) return null;
  if (value.kind === 'task-run' && value.successful !== true) return null;
  if (value.kind === 'room-turn' && value.successful === false) return null;
  let scope;
  if (value.scope === null) scope = null;
  else {
    try { scope = validateMemoryProposal({ text: 'scope validation', contextScope: value.scope }).contextScope; }
    catch { return null; }
  }
  return Object.freeze({ kind: value.kind, id: value.id, batchId: value.batchId,
    agentId: value.agentId, lineageId: String(value.lineageId).toLowerCase(), scope: cloneScope(scope) });
}

function normalizeResolvedSource(value, job) {
  if (!value || typeof value !== 'object' || typeof value.text !== 'string') return null;
  const reference = normalizeReference(value);
  if (!reference || value.kind !== job.kind || value.id !== job.id || value.batchId !== job.batchId ||
    referenceKey(reference) !== job.key) return null;
  return Object.freeze({ kind: value.kind, id: value.id, batchId: value.batchId, text: value.text });
}

function normalizeStoredJob(value) {
  if (!value || typeof value !== 'object') return null;
  const reference = normalizeReference({ ...value, completed: true, successful: true });
  if (!reference || typeof value.key !== 'string' || value.key !== referenceKey(reference) ||
    !Number.isSafeInteger(value.enqueuedAt) || value.enqueuedAt < 0 ||
    !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
    !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0) return null;
  return Object.freeze({ ...reference, key: value.key, enqueuedAt: value.enqueuedAt,
    attempts: value.attempts, nextAttemptAt: value.nextAttemptAt });
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || typeof value.key !== 'string' || !Number.isSafeInteger(value.at) ||
    value.at < 0 || typeof value.status !== 'string' || typeof value.reason !== 'string' ||
    !SOURCE_KINDS.has(value.sourceKind) || !validIdentifier(value.sourceId) || !validIdentifier(value.batchId) ||
    !validIdentifier(value.agentId)) return null;
  return Object.freeze({ key: value.key, at: value.at, status: value.status, reason: value.reason,
    sourceKind: value.sourceKind, sourceId: value.sourceId, batchId: value.batchId, agentId: value.agentId,
    ...countField(value, 'submittedCount'), ...countField(value, 'committedCount'),
    ...countField(value, 'pendingReviewCount'), ...countField(value, 'duplicateCount'),
    ...countField(value, 'skippedCount'),
    ...normalizeQuarantineMetrics(value.quarantinedCount, value.quarantineReasonCounts) });
}

function countField(value, name) {
  return Number.isSafeInteger(value[name]) && value[name] >= 0 ? { [name]: value[name] } : {};
}

function normalizeQuarantineMetrics(countValue, reasonCountsValue) {
  const quarantinedCount = Number.isSafeInteger(countValue) && countValue >= 0
    ? Math.min(countValue, MAX_BATCH_QUARANTINES) : 0;
  const quarantineReasonCounts = {};
  if (quarantinedCount > 0 && reasonCountsValue && typeof reasonCountsValue === 'object' && !Array.isArray(reasonCountsValue)) {
    try {
      for (const code of QUARANTINE_REASON_CODES) {
        const descriptor = Object.getOwnPropertyDescriptor(reasonCountsValue, code);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
        const count = descriptor.value;
        if (!Number.isSafeInteger(count) || count <= 0) continue;
        quarantineReasonCounts[code] = Math.min(count, quarantinedCount, MAX_BATCH_QUARANTINES);
      }
    } catch {
      // Persist only the fixed metric schema, never adapter-provided values.
    }
  }
  return { quarantinedCount, quarantineReasonCounts };
}

function publicReference(job) {
  return Object.freeze({ kind: job.kind, id: job.id, batchId: job.batchId, agentId: job.agentId,
    lineageId: job.lineageId, scope: cloneScope(job.scope) });
}

function referenceKey(value) {
  return crypto.createHash('sha256').update(JSON.stringify({ kind: value.kind, id: value.id,
    batchId: value.batchId, agentId: value.agentId, lineageId: value.lineageId, scope: value.scope })).digest('hex');
}

function retryDelay(attempt, limits) {
  return Math.min(limits.maxRetryMs, limits.baseRetryMs * (2 ** Math.min(20, Math.max(0, attempt - 1))));
}

function prune(store, at, limits) {
  const oldest = at - limits.maxAgeMs;
  return { version: STORE_VERSION,
    jobs: store.jobs.filter((job) => job.enqueuedAt >= oldest).slice(-limits.maxQueue),
    receipts: store.receipts.filter((receipt) => receipt.at >= oldest).slice(-limits.maxReceipts) };
}

function emptyStore() { return { version: STORE_VERSION, jobs: [], receipts: [] }; }
function validIdentifier(value) { return typeof value === 'string' && IDENTIFIER.test(value); }
function cloneScope(scope) { return scope == null ? null : Object.freeze({ ...scope }); }
