import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map(), ownership = new AsyncLocalStorage();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 8 * 1024 * 1024;

// Reentrant within one operation; shared by store instances in this local engine.
export async function withMemoryLineageLock(directory, task) {
  const key = process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  if (ownership.getStore()?.get(key)?.active) return task();
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const lease = { active: true }, context = new Map(ownership.getStore() || []); context.set(key, lease);
    try { return await ownership.run(context, task); } finally { lease.active = false; }
  });
  queues.set(key, operation);
  try { return await operation; } finally { if (queues.get(key) === operation) queues.delete(key); }
}

async function details(target, allowMissing = false) {
  let value;
  try { value = await lstat(target); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (value.isSymbolicLink()) throw new Error('Memory erasure recovery refuses symbolic links.');
  return value;
}
async function boundedJson(file) {
  const info = await details(file);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Memory erasure recovery metadata is invalid.');
  const bytes = await readFile(file);
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}
async function cleanup(directory, name) {
  const target = path.resolve(directory, name);
  if (path.dirname(target) !== path.resolve(directory) || !/^\.erasure-(?:preparing|cleanup)-[0-9a-f-]{36}$/.test(name)) throw new Error('Invalid erasure cleanup path.');
  const info = await details(target, true);
  if (info && !info.isDirectory()) throw new Error('Memory erasure cleanup is not a directory.');
  if (info) await rm(target, { recursive: true, force: true });
}
async function retire(directory, active) {
  const name = `.erasure-cleanup-${crypto.randomUUID()}`;
  await rename(active, path.join(directory, name));
  await cleanup(directory, name);
}

export async function recoverMemoryErasure({ directory, lineageId, writeLog, validateLogs }) {
  const info = await details(directory, true);
  if (!info) return;
  if (!info.isDirectory()) throw new Error('Invalid memory lineage directory.');
  for (const name of await readdir(directory)) if (/^\.erasure-(?:preparing|cleanup)-[0-9a-f-]{36}$/.test(name)) await cleanup(directory, name);
  const active = path.join(directory, '.erasure-transaction');
  const activeInfo = await details(active, true);
  if (!activeInfo) return;
  if (!activeInfo.isDirectory()) throw new Error('Invalid memory erasure journal directory.');
  const { value: manifest } = await boundedJson(path.join(active, 'manifest.json'));
  if (manifest.version !== 1 || manifest.lineageId !== lineageId || !Array.isArray(manifest.files) || !manifest.files.length ||
      manifest.files.some(item => !datePattern.test(item.date) || !/^[a-f0-9]{64}$/.test(item.sha256)) ||
      new Set(manifest.files.map(item => item.date)).size !== manifest.files.length) throw new Error('Invalid memory erasure journal.');
  const committed = await details(path.join(active, 'committed.json'), true);
  if (committed) {
    const { value } = await boundedJson(path.join(active, 'committed.json'));
    if (value.version !== 1 || value.committed !== true) throw new Error('Invalid memory erasure commit marker.');
  } else {
    // Validate every backup before touching a canonical file. A damaged journal fails closed.
    const originals = [];
    for (const item of manifest.files) {
      const { value, bytes } = await boundedJson(path.join(active, `${item.date}.json`));
      if (digest(bytes) !== item.sha256 || value.date !== item.date || value.lineageId !== lineageId) throw new Error('Memory erasure recovery backup is damaged.');
      originals.push(value);
    }
    validateLogs(originals);
    for (const log of originals) await writeLog(path.join(directory, `${log.date}.json`), log);
  }
  await retire(directory, active);
}

export async function commitMemoryErasure({ directory, lineageId, originals, logs, writeLog, validateLogs, assertAuthorized }) {
  const stageName = `.erasure-preparing-${crypto.randomUUID()}`, stage = path.join(directory, stageName);
  const active = path.join(directory, '.erasure-transaction');
  await mkdir(stage, { mode: 0o700 });
  let published = false;
  try {
    const files = [];
    for (const log of originals) {
      const file = path.join(stage, `${log.date}.json`);
      await writeLog(file, log);
      files.push({ date: log.date, sha256: digest(await readFile(file)) });
    }
    await writeLog(path.join(stage, 'manifest.json'), { version: 1, lineageId, files });
    assertAuthorized?.();
    await rename(stage, active); published = true;
    for (const log of logs) await writeLog(path.join(directory, `${log.date}.json`), log, assertAuthorized);
    assertAuthorized?.();
    await writeLog(path.join(active, 'committed.json'), { version: 1, committed: true });
    await retire(directory, active);
  } catch (error) {
    if (published) {
      try { await recoverMemoryErasure({ directory, lineageId, writeLog, validateLogs }); }
      catch { throw Object.assign(new Error('Memory erasure recovery is pending; reads are blocked until its journal can be recovered.'), { cause: error }); }
    } else await cleanup(directory, stageName);
    throw error;
  }
}
