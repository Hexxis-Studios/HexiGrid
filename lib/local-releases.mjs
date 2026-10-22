import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeSourceDigest } from './runtime-source.mjs';

const SELECTION_FILE = 'release-selection.json';
const LOCK_FILE = `${SELECTION_FILE}.lock`;
const MAX_RELEASES = 100;
const MAX_METADATA_BYTES = 128 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class LocalReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalReleaseError';
  }
}

function reject(message) {
  throw new LocalReleaseError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathKey(value) {
  let resolved = path.resolve(value);
  if (process.platform === 'win32') resolved = resolved.replace(/^\\\\\?\\/, '').toLowerCase();
  return path.normalize(resolved);
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) reject('Release id must be a safe opaque identifier.');
}

async function lstatOrNull(io, target) {
  try {
    return await io.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new LocalReleaseError('Unable to inspect the local release folder.');
  }
}

async function assertRealDirectory(io, target, message) {
  const stat = await lstatOrNull(io, target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) reject(message);
  let realPath;
  try {
    realPath = await io.realpath(target);
  } catch {
    reject(message);
  }
  if (!samePath(target, realPath)) reject(message);
}

async function assertRegularFile(io, target, message) {
  const stat = await lstatOrNull(io, target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) reject(message);
  let realPath;
  try {
    realPath = await io.realpath(target);
  } catch {
    reject(message);
  }
  if (!samePath(target, realPath)) reject(message);
}

async function readJsonFile(io, target, message) {
  let content;
  try {
    content = await io.readFile(target, 'utf8');
  } catch {
    reject(message);
  }
  try {
    return JSON.parse(content);
  } catch {
    reject(message);
  }
}

async function validateManagerRoot(root, io) {
  if (typeof root !== 'string' || !root.trim()) reject('An explicit manager root is required.');
  const requestedRoot = path.resolve(root);
  await assertRealDirectory(io, requestedRoot, 'Manager root must be a real HexiGrid directory.');
  const realRoot = await io.realpath(requestedRoot).catch(() => reject('Manager root must be a real HexiGrid directory.'));
  for (const file of ['package.json', 'server.mjs', 'Start-Control-Room.ps1']) {
    await assertRegularFile(io, path.join(realRoot, file), 'Manager root is not a valid HexiGrid repository.');
  }
  const manifest = await readJsonFile(io, path.join(realRoot, 'package.json'), 'Manager root has an invalid package manifest.');
  if (manifest?.name !== 'hexigrid') reject('Manager root is not a HexiGrid repository.');
  return realRoot;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateNodeRequirement(manifest, runtimeVersion) {
  const engineMatch = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(manifest?.engines?.node ?? '');
  const minimum = engineMatch ? [Number(engineMatch[1]), Number(engineMatch[2] ?? 0), Number(engineMatch[3] ?? 0)] : null;
  const runtime = parseVersion(runtimeVersion);
  if (!minimum || compareVersions(minimum, [22, 0, 0]) < 0 || !runtime || compareVersions(runtime, [22, 0, 0]) < 0 || compareVersions(runtime, minimum) < 0) {
    reject('Release must require Node.js 22 or newer and match the current runtime.');
  }
}

async function validatePrivateData(io, releaseRoot) {
  const dataPath = path.join(releaseRoot, 'data');
  const dataStat = await lstatOrNull(io, dataPath);
  if (!dataStat) return;
  await assertRealDirectory(io, dataPath, 'Release contains an unsafe private data folder.');
  let entries;
  try {
    entries = await io.readdir(dataPath, { withFileTypes: true });
  } catch {
    reject('Release private data folder could not be validated.');
  }
  if (entries.length !== 1 || entries[0].name !== '.gitkeep') reject('Release must not contain private data.');
  await assertRegularFile(io, path.join(dataPath, '.gitkeep'), 'Release must not contain private data.');
}

async function inspectRelease(root, id, io, runtimeVersion, source) {
  assertId(id);
  const releasesRoot = path.join(root, 'releases');
  const releaseRoot = path.join(releasesRoot, id);
  await assertRealDirectory(io, releasesRoot, 'Managed releases folder must be a real directory.');
  await assertRealDirectory(io, releaseRoot, 'Release folder must be a real directory below releases.');
  if (source !== undefined) {
    if (typeof source !== 'string' || !source.trim() || !samePath(path.resolve(source), releaseRoot)) reject('Source must resolve exactly to its managed release folder.');
    let sourceRealPath;
    try {
      sourceRealPath = await io.realpath(source);
    } catch {
      reject('Source must resolve exactly to its managed release folder.');
    }
    if (!samePath(sourceRealPath, releaseRoot)) reject('Source must resolve exactly to its managed release folder.');
  }

  for (const file of ['package.json', 'package-lock.json', 'server.mjs', 'Start-Control-Room.ps1']) {
    await assertRegularFile(io, path.join(releaseRoot, file), 'Release is missing a required regular file.');
  }
  for (const directory of ['lib', 'public', 'node_modules']) {
    await assertRealDirectory(io, path.join(releaseRoot, directory), 'Release is missing a required real directory.');
  }
  const manifest = await readJsonFile(io, path.join(releaseRoot, 'package.json'), 'Release has an invalid package manifest.');
  if (manifest?.name !== 'hexigrid') reject('Release package identity is not HexiGrid.');
  if (typeof manifest.version !== 'string' || manifest.version.length > 128 || !VERSION_PATTERN.test(manifest.version)) reject('Release package version is invalid.');
  validateNodeRequirement(manifest, runtimeVersion);
  await validatePrivateData(io, releaseRoot);

  let digest;
  try {
    digest = await runtimeSourceDigest(releaseRoot);
  } catch {
    reject('Release source could not be fingerprinted.');
  }
  return { id, version: manifest.version, digest, root: releaseRoot };
}

function emptySelection() {
  return { schemaVersion: 1, activeId: null, previousId: null, releases: [] };
}

function validateSelection(selection) {
  if (!isObject(selection) || selection.schemaVersion !== 1 || !Array.isArray(selection.releases) || selection.releases.length > MAX_RELEASES) {
    reject('Release selection metadata is malformed.');
  }
  const records = new Map();
  for (const record of selection.releases) {
    if (!isObject(record) || typeof record.version !== 'string' || record.version.length > 128 || !VERSION_PATTERN.test(record.version) || !/^[a-f0-9]{64}$/.test(record.digest)) {
      reject('Release selection metadata is malformed.');
    }
    assertId(record.id);
    if (records.has(record.id)) reject('Release selection metadata is malformed.');
    records.set(record.id, record);
  }
  for (const key of ['activeId', 'previousId']) {
    if (selection[key] !== null) assertId(selection[key]);
    if (selection[key] !== null && !records.has(selection[key])) reject('Release selection references an unknown release.');
  }
  if (selection.previousId !== null && (!selection.activeId || selection.previousId === selection.activeId)) reject('Release selection metadata is malformed.');
  return selection;
}

async function readSelection(root, io) {
  const metadataPath = path.join(root, SELECTION_FILE);
  const stat = await lstatOrNull(io, metadataPath);
  if (!stat) return emptySelection();
  if (!stat.isFile() || stat.isSymbolicLink()) reject('Release selection metadata must be a regular file.');
  let realPath;
  try {
    realPath = await io.realpath(metadataPath);
  } catch {
    reject('Release selection metadata must be a regular file.');
  }
  if (!samePath(metadataPath, realPath)) reject('Release selection metadata must be a regular file.');
  let content;
  try {
    content = await io.readFile(metadataPath, 'utf8');
  } catch {
    reject('Release selection metadata could not be read.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_METADATA_BYTES) reject('Release selection metadata is too large.');
  let selection;
  try {
    selection = JSON.parse(content);
  } catch {
    reject('Release selection metadata is malformed.');
  }
  return validateSelection(selection);
}

async function acquireLock(root, io) {
  try {
    return await io.open(path.join(root, LOCK_FILE), 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') reject('Another local release operation is in progress.');
    reject('Could not acquire the local release lock.');
  }
}

async function withLock(root, io, operation) {
  const handle = await acquireLock(root, io);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    try {
      await io.unlink(path.join(root, LOCK_FILE));
    } catch (error) {
      if (error?.code !== 'ENOENT') reject('Could not release the local release lock.');
    }
  }
}

async function writeSelectionAtomically(root, selection, io, assertAuthorized) {
  const metadataPath = path.join(root, SELECTION_FILE);
  const temporaryPath = path.join(root, `.release-selection.${randomUUID()}.tmp`);
  let handle;
  try {
    assertAuthorized();
    handle = await io.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(selection, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    assertAuthorized();
    await io.rename(temporaryPath, metadataPath);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temporaryPath).catch(() => {});
    reject('Could not atomically persist release selection.');
  }
}

function registeredRecord(selection, id) {
  return selection.releases.find((record) => record.id === id) ?? null;
}

async function assertRegisteredRelease(root, id, selection, io, runtimeVersion) {
  const record = registeredRecord(selection, id);
  if (!record) reject('Release is not registered.');
  const current = await inspectRelease(root, id, io, runtimeVersion);
  if (current.version !== record.version || current.digest !== record.digest) reject('Registered release source has changed.');
  return { ...record, root: current.root };
}

export async function registerLocalRelease({ root, id, source, io = fs, runtimeVersion = process.versions.node, assertAuthorized = () => {} }) {
  assertId(id);
  if (typeof source !== 'string' || !source.trim()) reject('A prepared release source is required.');
  const realRoot = await validateManagerRoot(root, io);
  return withLock(realRoot, io, async () => {
    await validateManagerRoot(realRoot, io);
    const selection = await readSelection(realRoot, io);
    const release = await inspectRelease(realRoot, id, io, runtimeVersion, source);
    const existing = registeredRecord(selection, id);
    if (existing && (existing.version !== release.version || existing.digest !== release.digest)) reject('Release id is already registered to different source.');
    if (!existing && selection.releases.length >= MAX_RELEASES) reject('Release registry is limited to 100 entries.');
    const next = existing ? selection : { ...selection, releases: [...selection.releases, { id, version: release.version, digest: release.digest }] };
    await writeSelectionAtomically(realRoot, next, io, assertAuthorized);
    return { id, version: release.version, digest: release.digest };
  });
}

export async function activateLocalRelease({ root, id, confirm = false, io = fs, runtimeVersion = process.versions.node, assertAuthorized = () => {} }) {
  if (!confirm) reject('Activation requires explicit --confirm.');
  assertId(id);
  const realRoot = await validateManagerRoot(root, io);
  return withLock(realRoot, io, async () => {
    await validateManagerRoot(realRoot, io);
    const selection = await readSelection(realRoot, io);
    const release = await assertRegisteredRelease(realRoot, id, selection, io, runtimeVersion);
    const nextPreviousId = selection.activeId === id ? selection.previousId : selection.activeId;
    const next = { ...selection, activeId: id, previousId: nextPreviousId };
    await writeSelectionAtomically(realRoot, next, io, assertAuthorized);
    return { id, version: release.version, digest: release.digest, appliesOn: 'next-startup' };
  });
}

export async function rollbackLocalRelease({ root, confirm = false, io = fs, runtimeVersion = process.versions.node, assertAuthorized = () => {} }) {
  if (!confirm) reject('Rollback requires explicit --confirm.');
  const realRoot = await validateManagerRoot(root, io);
  return withLock(realRoot, io, async () => {
    await validateManagerRoot(realRoot, io);
    const selection = await readSelection(realRoot, io);
    if (!selection.previousId) reject('No previous release is available to roll back to.');
    const release = await assertRegisteredRelease(realRoot, selection.previousId, selection, io, runtimeVersion);
    const next = { ...selection, activeId: selection.previousId, previousId: selection.activeId };
    await writeSelectionAtomically(realRoot, next, io, assertAuthorized);
    return { id: release.id, version: release.version, digest: release.digest, appliesOn: 'next-startup' };
  });
}

export async function resolveLocalRelease({ root, io = fs, runtimeVersion = process.versions.node }) {
  const realRoot = await validateManagerRoot(root, io);
  const selection = await readSelection(realRoot, io);
  if (!selection.activeId) return { root: realRoot, id: null, version: null, digest: null };
  const release = await assertRegisteredRelease(realRoot, selection.activeId, selection, io, runtimeVersion);
  return { root: release.root, id: release.id, version: release.version, digest: release.digest };
}

export async function getLocalReleaseStatus({ root, io = fs, runtimeVersion = process.versions.node }) {
  const realRoot = await validateManagerRoot(root, io);
  const selection = await readSelection(realRoot, io);
  for (const id of [selection.activeId, selection.previousId]) {
    if (id !== null) await assertRegisteredRelease(realRoot, id, selection, io, runtimeVersion);
  }
  return {
    activeId: selection.activeId,
    previousId: selection.previousId,
    releases: selection.releases.map(({ id, version, digest }) => ({ id, version, digest })),
    appliesOn: 'next-startup'
  };
}
