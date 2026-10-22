import crypto from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stableContinuityJson } from './continuity-transfer.mjs';
import { validateDatedMemoryBytes, validateDatedMemoryChain } from './dated-memory.mjs';

export const MEMORY_SYNC_FORMAT = 'hexigrid-memory-sync';
export const MEMORY_SYNC_VERSION = 1;
const SYNC_ID = /^memory-sync-[0-9a-f-]{36}$/i;
const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEMORY_PATH = /^(lineage-[0-9a-f-]{36})\/(\d{4}-\d{2}-\d{2})\.json$/i;
const MAX_FILES = 10000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function iso(value = new Date().toISOString()) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error('Memory sync requires a valid timestamp.');
  return timestamp.toISOString();
}

function normalizeFileRecord(input, lineageId) {
  const filePath = String(input?.path || '').replaceAll('\\', '/');
  const match = filePath.match(MEMORY_PATH);
  if (!match || match[1].toLowerCase() !== lineageId) throw new Error('Memory sync contains an unsafe or unrelated file path.');
  const bytes = Number(input?.bytes);
  const sha256 = String(input?.sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES || !SHA256.test(sha256)) throw new Error('Memory sync contains invalid file metadata.');
  return { path: `${lineageId}/${match[2]}.json`, bytes, sha256 };
}

export function normalizeMemorySyncManifest(input = {}) {
  const lineageId = String(input.lineageId || '').toLowerCase();
  const syncId = String(input.syncId || '').toLowerCase();
  const sourceAgentId = String(input.sourceAgentId || '').trim();
  if (!LINEAGE_ID.test(lineageId) || !SYNC_ID.test(syncId) || !AGENT_ID.test(sourceAgentId)) throw new Error('Memory sync identity is invalid.');
  if (!Array.isArray(input.files) || input.files.length > MAX_FILES) throw new Error(`Memory sync may contain at most ${MAX_FILES} dated files.`);
  const seen = new Set(); let totalBytes = 0;
  const files = input.files.map((file) => {
    const normalized = normalizeFileRecord(file, lineageId);
    if (seen.has(normalized.path)) throw new Error('Memory sync file paths must be unique.');
    seen.add(normalized.path); totalBytes += normalized.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Memory sync exceeds the 512 MB transfer limit.');
    return normalized;
  }).sort((left, right) => left.path.localeCompare(right.path));
  const rootDigest = digest(stableContinuityJson(files));
  if (input.rootDigest && input.rootDigest !== rootDigest) throw new Error('Memory sync manifest digest is invalid.');
  return {
    format: MEMORY_SYNC_FORMAT, version: MEMORY_SYNC_VERSION, syncId, lineageId, sourceAgentId,
    sourceActivityState: input.sourceActivityState === 'suspended' ? 'suspended' : 'active',
    createdAt: iso(input.createdAt), files, totalBytes, rootDigest
  };
}

export function createMemorySyncManifest({ files, lineageId, sourceAgentId, sourceActivityState = 'suspended', createdAt = new Date().toISOString(), syncId = `memory-sync-${crypto.randomUUID()}` } = {}) {
  return normalizeMemorySyncManifest({ format: MEMORY_SYNC_FORMAT, version: MEMORY_SYNC_VERSION, syncId, lineageId, sourceAgentId, sourceActivityState, createdAt, files, rootDigest: '' });
}

async function safeDetails(target, { missing = false } = {}) {
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink()) throw new Error('Memory sync storage cannot use symbolic links.');
    return details;
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(target, expectedBytes) {
  const details = await safeDetails(target, { missing: true });
  if (!details || !details.isFile() || details.size !== expectedBytes) return '';
  return digest(await readFile(target));
}

function safeTarget(root, relativePath) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...relativePath.split('/'));
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Memory sync path escaped its private root.');
  return target;
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await safeDetails(path.dirname(target));
  await safeDetails(target, { missing: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class MemorySyncReceiver {
  #root;
  #memoryRoot;

  constructor({ root, memoryRoot }) {
    if (!path.isAbsolute(String(root || '')) || !path.isAbsolute(String(memoryRoot || ''))) throw new Error('Memory sync requires absolute private roots.');
    this.#root = path.resolve(root);
    this.#memoryRoot = path.resolve(memoryRoot);
  }

  #sessionDirectory(syncId) { return safeTarget(this.#root, syncId); }
  #statePath(syncId) { return path.join(this.#sessionDirectory(syncId), 'state.json'); }
  #stageRoot(syncId) { return path.join(this.#sessionDirectory(syncId), 'files'); }

  async begin(input) {
    const manifest = normalizeMemorySyncManifest(input);
    const sessionDirectory = this.#sessionDirectory(manifest.syncId);
    const existing = await this.status(manifest.syncId).catch(() => null);
    if (existing) {
      if (existing.manifest.rootDigest !== manifest.rootDigest) throw new Error('A memory sync ID was reused with different content.');
      return existing;
    }
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await safeDetails(sessionDirectory);
    const state = { status: 'awaiting-sync', manifest, received: [], startedAt: new Date().toISOString(), verifiedAt: null };
    await atomicWrite(this.#statePath(manifest.syncId), Buffer.from(`${stableContinuityJson(state)}\n`));
    return state;
  }

  async status(syncId) {
    const selected = String(syncId || '').toLowerCase();
    if (!SYNC_ID.test(selected)) throw new Error('Memory sync ID is invalid.');
    const statePath = this.#statePath(selected);
    const details = await safeDetails(statePath, { missing: true });
    if (!details) return null;
    if (!details.isFile() || details.size > 4 * 1024 * 1024) throw new Error('Memory sync state is invalid.');
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch { throw new Error('Memory sync state cannot be read safely.'); }
    state.manifest = normalizeMemorySyncManifest(state.manifest);
    if (!['awaiting-sync', 'verified'].includes(state.status)) throw new Error('Memory sync state is invalid.');
    state.received = Array.isArray(state.received) ? state.received.filter((item) => state.manifest.files.some((file) => file.path === item)) : [];
    return state;
  }

  async missing(syncId) {
    const state = await this.status(syncId);
    if (!state) throw new Error('Memory sync session was not found.');
    const missing = [];
    for (const file of state.manifest.files) {
      const finalTarget = safeTarget(this.#memoryRoot, file.path);
      if (await hashFile(finalTarget, file.bytes) === file.sha256) continue;
      const stagedTarget = safeTarget(this.#stageRoot(syncId), file.path);
      if (await hashFile(stagedTarget, file.bytes) === file.sha256) continue;
      missing.push(file);
    }
    return missing;
  }

  async receive(syncId, relativePath, content) {
    const state = await this.status(syncId);
    if (!state || state.status !== 'awaiting-sync') throw new Error('Memory sync is not accepting files.');
    const file = state.manifest.files.find((item) => item.path === String(relativePath || '').replaceAll('\\', '/'));
    if (!file) throw new Error('That file is not part of this memory sync.');
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('A memory sync file failed digest verification.');
    const match = file.path.match(MEMORY_PATH);
    validateDatedMemoryBytes(bytes, { lineageId: match[1], date: match[2] });
    const target = safeTarget(this.#stageRoot(syncId), file.path);
    if (await hashFile(target, file.bytes) !== file.sha256) await atomicWrite(target, bytes);
    if (!state.received.includes(file.path)) state.received.push(file.path);
    await atomicWrite(this.#statePath(syncId), Buffer.from(`${stableContinuityJson(state)}\n`));
    return { accepted: true, path: file.path, remaining: (await this.missing(syncId)).length };
  }

  async finalize(syncId, { failAt = '' } = {}) {
    const state = await this.status(syncId);
    if (!state) throw new Error('Memory sync session was not found.');
    // A prior verification may have preceded a crash before profile activation.
    // Recheck the actual files instead of trusting a saved verified flag.
    const missing = await this.missing(syncId);
    if (missing.length) throw new Error(`Memory sync is incomplete; ${missing.length} file${missing.length === 1 ? '' : 's'} remain.`);
    if (failAt === 'before-commit') throw new Error('Injected memory sync failure before commit.');
    const lineageId = state.manifest.lineageId;
    const incoming = new Set(state.manifest.files.map((file) => file.path));
    const logs = [];
    const lineageDirectory = safeTarget(this.#memoryRoot, lineageId);
    const lineageDetails = await safeDetails(lineageDirectory, { missing: true });
    if (lineageDetails && !lineageDetails.isDirectory()) throw new Error('Memory sync lineage path is invalid.');
    if (lineageDetails) for (const name of await readdir(lineageDirectory)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const relativePath = `${lineageId}/${name}`;
      if (incoming.has(relativePath)) continue;
      const target = safeTarget(this.#memoryRoot, relativePath);
      const details = await safeDetails(target);
      if (!details.isFile() || details.size > MAX_FILE_BYTES) throw new Error('Memory sync found an invalid local dated log.');
      logs.push(validateDatedMemoryBytes(await readFile(target), { lineageId, date: name.slice(0, 10) }));
    }
    for (const file of state.manifest.files) {
      const finalTarget = safeTarget(this.#memoryRoot, file.path);
      const target = await hashFile(finalTarget, file.bytes) === file.sha256
        ? finalTarget : safeTarget(this.#stageRoot(syncId), file.path);
      const details = await safeDetails(target);
      if (!details.isFile() || details.size !== file.bytes) throw new Error('A staged memory sync file changed before commit.');
      const bytes = await readFile(target);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('A staged memory sync file changed before commit.');
      logs.push(validateDatedMemoryBytes(bytes, { lineageId, date: file.path.match(MEMORY_PATH)[2] }));
    }
    validateDatedMemoryChain(logs, { lineageId });
    for (const file of state.manifest.files) {
      const finalTarget = safeTarget(this.#memoryRoot, file.path);
      if (await hashFile(finalTarget, file.bytes) === file.sha256) continue;
      const stagedTarget = safeTarget(this.#stageRoot(syncId), file.path);
      const bytes = await readFile(stagedTarget);
      if (digest(bytes) !== file.sha256) throw new Error('A staged memory sync file changed before commit.');
      await atomicWrite(finalTarget, bytes);
    }
    if (failAt === 'after-commit') throw new Error('Injected memory sync failure after file commit.');
    for (const file of state.manifest.files) {
      if (await hashFile(safeTarget(this.#memoryRoot, file.path), file.bytes) !== file.sha256) throw new Error('Memory sync final verification failed.');
    }
    state.status = 'verified'; state.verifiedAt ||= new Date().toISOString(); state.received = state.manifest.files.map((file) => file.path);
    await atomicWrite(this.#statePath(syncId), Buffer.from(`${stableContinuityJson(state)}\n`));
    await rm(this.#stageRoot(syncId), { recursive: true, force: true });
    return state;
  }

  async pruneIncomplete(syncId) {
    const state = await this.status(syncId);
    if (!state || state.status === 'verified') return false;
    await rm(this.#sessionDirectory(syncId), { recursive: true, force: true });
    return true;
  }
}
