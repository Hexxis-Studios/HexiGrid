import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FORMAT = 'hexigrid-whole-app-manifest';
const VERSION = 1;
const REQUIRED_AREAS = ['dated-memory', 'media', 'memory-index', 'plugins', 'workspace'];
let backupOperationActive = false;

export function beginBackupOperation() {
  if (backupOperationActive) return null;
  backupOperationActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    backupOperationActive = false;
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function stateForManifest(payload) {
  const state = structuredClone(payload);
  delete state.privateFiles;
  state.backup = { ...(state.backup || {}) };
  delete state.backup.manifest;
  return JSON.parse(JSON.stringify(state));
}

function fileRecords(payload, verifyBytes = false) {
  const files = payload?.privateFiles?.files;
  if (!Array.isArray(files)) throw new Error('The whole-app backup is missing its private-file bundle.');
  const records = files.map((file) => {
    const record = { area: String(file?.area || ''), path: String(file?.path || ''), size: Number(file?.size), sha256: String(file?.sha256 || '') };
    if (!REQUIRED_AREAS.includes(record.area) || !record.path || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('The whole-app backup manifest contains an invalid file record.');
    if (verifyBytes) {
      const bytes = Buffer.from(String(file.data || ''), 'base64');
      if (bytes.length !== record.size || digest(bytes) !== record.sha256) throw new Error('The whole-app backup failed a file integrity check.');
    }
    return record;
  });
  return records.sort((left, right) => `${left.area}/${left.path}`.localeCompare(`${right.area}/${right.path}`));
}

export function createWholeAppManifest(payload) {
  const files = fileRecords(payload, true);
  const areas = [...new Set(payload.privateFiles.areas || [])].sort();
  if (canonical(areas) !== canonical(REQUIRED_AREAS)) throw new Error('The whole-app backup does not contain every required private data area.');
  const stateSha256 = digest(canonical(stateForManifest(payload)));
  const filesSha256 = digest(canonical(files));
  return { format: FORMAT, version: VERSION, stateSha256, filesSha256, snapshotSha256: digest(canonical({ format: FORMAT, version: VERSION, stateSha256, filesSha256 })), files };
}

export function verifyWholeAppManifest(payload) {
  if (Number(payload?.backup?.version || 0) < 3 && !payload?.backup?.manifest) return { legacy: true };
  const supplied = payload?.backup?.manifest;
  if (!supplied || supplied.format !== FORMAT || supplied.version !== VERSION) throw new Error('The whole-app backup manifest is missing or unsupported.');
  const expected = createWholeAppManifest(payload);
  if (canonical(supplied) !== canonical(expected)) throw new Error('The whole-app backup manifest failed verification.');
  return { legacy: false, manifest: expected };
}

export function normalizeBackupSchedule(value = {}) {
  const intervalHours = Math.max(6, Math.min(24 * 30, Math.round(Number(value.intervalHours) || 24)));
  return {
    enabled: value.enabled === true,
    intervalHours,
    directory: typeof value.directory === 'string' ? value.directory.slice(0, 1000) : '',
    lastRunAt: typeof value.lastRunAt === 'string' ? value.lastRunAt : null,
    nextRunAt: typeof value.nextRunAt === 'string' ? value.nextRunAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 300) : ''
  };
}

export function configureBackupSchedule(currentValue, requestValue, defaultDirectory, nextRunAt) {
  const current = normalizeBackupSchedule(currentValue);
  const request = requestValue && typeof requestValue === 'object' ? requestValue : {};
  const enabled = request.enabled === true;
  if (!enabled) return {
    schedule: normalizeBackupSchedule({ ...current, enabled: false, directory: '', nextRunAt: null, lastError: '' }),
    preservePassphrase: false
  };

  const directoryOnly = current.enabled && typeof request.directory === 'string'
    && !Object.hasOwn(request, 'passphrase') && !Object.hasOwn(request, 'intervalHours');
  const requestedDirectory = typeof request.directory === 'string' ? request.directory.trim() : defaultDirectory;
  if (typeof requestedDirectory !== 'string' || requestedDirectory.length > 1000) throw new Error('Choose a shorter backup folder path.');
  if (!path.isAbsolute(requestedDirectory)) throw new Error('Choose an absolute local backup folder.');

  return {
    schedule: normalizeBackupSchedule({
      enabled: true,
      intervalHours: directoryOnly ? current.intervalHours : request.intervalHours,
      directory: path.resolve(requestedDirectory),
      lastRunAt: current.lastRunAt,
      nextRunAt: directoryOnly ? current.nextRunAt : nextRunAt,
      lastError: ''
    }),
    preservePassphrase: directoryOnly
  };
}

export function computeNextRunAt(schedule, nowMs) {
  const normalized = normalizeBackupSchedule(schedule);
  return new Date(nowMs + normalized.intervalHours * 60 * 60 * 1000).toISOString();
}

export function advanceScheduleAfterRun(schedule, outcome, nowMs) {
  const normalized = normalizeBackupSchedule(schedule);
  return normalizeBackupSchedule({
    ...normalized,
    lastRunAt: new Date(nowMs).toISOString(),
    nextRunAt: computeNextRunAt(normalized, nowMs),
    lastError: outcome?.ok === true ? '' : (outcome?.error?.message || String(outcome?.error || 'Backup failed.'))
  });
}

export async function writeEncryptedSnapshot({ directory, envelope, filename }) {
  if (!path.isAbsolute(String(directory || ''))) throw new Error('Choose an absolute local backup folder.');
  const targetDirectory = path.resolve(directory);
  const safeName = String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!/^hexigrid-backup-[a-zA-Z0-9._-]+\.json$/.test(safeName)) throw new Error('The local backup filename is invalid.');
  // Inspect parents before creating anything: recursive mkdir can otherwise
  // follow a junction and create folders outside the selected real location.
  await ensureSnapshotDirectory(targetDirectory);
  await cleanupOrphanedSnapshotStages(targetDirectory, safeName);
  const target = path.join(targetDirectory, safeName);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.pending`;
  let handle, staged = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); staged = true;
    await handle.writeFile(JSON.stringify(envelope));
    await handle.sync();
    await handle.close(); handle = null;
    // Restrict the staged file before publishing it or replacing a good snapshot.
    if (process.platform === 'win32') await ownerOnlyWindowsAcl(temporary);
    await fs.rename(temporary, target);
    return target;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (staged) await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupOrphanedSnapshotStages(directory, safeName) {
  const prefix = `${safeName}.`;
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.pending')) continue;
    const [processIdText, token, marker, ...extra] = name.slice(prefix.length).split('.');
    if (marker !== 'pending' || extra.length || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token || '')) continue;
    const processId = Number(processIdText);
    if (!Number.isSafeInteger(processId) || processId < 1) continue;
    try { process.kill(processId, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') continue;
      await fs.rm(path.join(directory, name), { force: true });
    }
  }
}

async function ensureSnapshotDirectory(directory) {
  const root = path.parse(directory).root;
  const components = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of [null, ...components]) {
    if (component !== null) current = path.join(current, component);
    let details;
    try { details = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || component === null) throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (created) { if (created.code !== 'EEXIST') throw created; }
      details = await fs.lstat(current);
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('The local backup folder and its parents must be real directories, not symbolic links or junctions.');
    }
  }
}

function ownerOnlyWindowsAcl(target) {
  const script = `$ErrorActionPreference='Stop'; $target=[Console]::In.ReadToEnd(); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetOwner($identity.User); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($target,$acl)`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk; });
    child.on('error', () => reject(new Error('The scheduled backup file could not be restricted to the current operating-system owner.')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`The scheduled backup file could not be restricted to the current operating-system owner.${errorText ? ' Check the folder permissions.' : ''}`)));
    child.stdin.end(target);
  });
}

export const wholeAppBackupAreas = Object.freeze([...REQUIRED_AREAS]);
