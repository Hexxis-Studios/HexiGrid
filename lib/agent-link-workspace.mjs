import crypto from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_LINK_WORKSPACE_FILE_BYTES = 1024 * 1024;
const BLOCKED_DIRECTORIES = new Set([
  '.agents', '.aws', '.azure', '.codex', '.config', '.firebase', '.git', '.gnupg', '.ssh',
  'credentials', 'data', 'node_modules', 'secrets'
]);
const BLOCKED_FILES = new Set([
  '.netrc', '.npmrc', '.pypirc', 'credentials', 'id_ed25519', 'id_rsa'
]);
const BLOCKED_EXTENSIONS = new Set(['.db', '.jks', '.kdbx', '.key', '.pem', '.p12', '.pfx', '.sqlite', '.sqlite3']);
const writeLocks = new Map();
const failure = (message, status = 400, code = 'workspace_request_invalid') => Object.assign(new Error(message), { status, code });
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function blockedSegment(segment, isDirectory = false) {
  const lower = segment.toLowerCase();
  if (BLOCKED_DIRECTORIES.has(lower)) return true;
  if (!isDirectory && (BLOCKED_FILES.has(lower) || lower.startsWith('.env') || BLOCKED_EXTENSIONS.has(path.extname(lower)))) return true;
  if (!isDirectory && (/^service-account.*\.json$/.test(lower) || /^firebase-adminsdk.*\.json$/.test(lower))) return true;
  return false;
}

function parseRelative(relativePath, { allowRoot = false, allowPrivatePaths = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || relativePath.includes('\0') || relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw failure('Use a project-relative path with forward slashes.');
  }
  const value = relativePath.trim();
  if (!value || value === '.') {
    if (allowRoot) return [];
    throw failure('A file path is required.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) throw failure('The workspace path is invalid.');
  for (const [index, segment] of segments.entries()) {
    if (!allowPrivatePaths && blockedSegment(segment, index < segments.length - 1)) throw failure('This path is outside the agent-accessible project files.');
  }
  return segments;
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('The workspace path escapes the owner-approved project.', 403, 'workspace_path_denied');
}

async function realRoot(rootPath) {
  try { return await fs.realpath(rootPath); }
  catch { throw failure('The owner-approved project workspace is unavailable.', 503, 'workspace_unavailable'); }
}

async function walkExisting(root, segments, { allowMissingFinal = false, createDirectories = false } = {}) {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let entry;
    try { entry = await fs.lstat(current); }
    catch (error) {
      if (createDirectories && error.code === 'ENOENT') {
        try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        entry = await fs.lstat(current);
      } else {
        if (allowMissingFinal && index === segments.length - 1 && error.code === 'ENOENT') return { path: current, exists: false };
        if (error.code === 'ENOENT') throw failure('That project path does not exist.', 404, 'workspace_path_missing');
        throw error;
      }
    }
    if (entry.isSymbolicLink()) throw failure('Symbolic links are not accessible through the project door.', 403, 'workspace_symlink_denied');
    const real = await fs.realpath(current);
    assertInside(root, real);
    if (index < segments.length - 1 && !entry.isDirectory()) throw failure('A parent path is not a directory.', 400, 'workspace_path_not_directory');
    current = real;
  }
  return { path: current, exists: true };
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw failure('Binary files are not available through the text workspace door.', 415, 'workspace_binary_denied');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw failure('Only valid UTF-8 text files are available through the workspace door.', 415, 'workspace_text_denied'); }
}

async function withWriteLock(key, operation) {
  const previous = writeLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  writeLocks.set(key, queued);
  await previous.catch(() => {});
  try { return await operation(); }
  finally {
    release();
    if (writeLocks.get(key) === queued) writeLocks.delete(key);
  }
}

export async function listAgentLinkWorkspace(rootPath, relativePath = '.') {
  const root = await realRoot(rootPath);
  const segments = parseRelative(relativePath, { allowRoot: true });
  const resolved = segments.length ? await walkExisting(root, segments) : { path: root, exists: true };
  const directory = await fs.lstat(resolved.path);
  if (!directory.isDirectory()) throw failure('The selected project path is not a directory.', 400, 'workspace_path_not_directory');
  const entries = await fs.readdir(resolved.path, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.hexigrid-write-') || blockedSegment(entry.name, entry.isDirectory())) continue;
    const itemPath = path.join(resolved.path, entry.name);
    try {
      const info = await fs.lstat(itemPath);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
      if (!info.isDirectory() && info.size > MAX_LINK_WORKSPACE_FILE_BYTES) continue;
      result.push({ name: entry.name, type: info.isDirectory() ? 'directory' : 'text-file', size: info.isFile() ? info.size : null });
      if (result.length >= 500) break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { path: segments.join('/'), entries: result, truncated: result.length >= 500 };
}

// Options are supplied only by trusted callers. Never forward Link request flags
// here: the human editor uses its own private workspace; scoped Links keep defaults.
export async function readAgentLinkWorkspaceFile(rootPath, relativePath, options = {}) {
  const segments = parseRelative(relativePath, options);
  const root = await realRoot(rootPath);
  const resolved = await walkExisting(root, segments);
  const info = await fs.lstat(resolved.path);
  if (!info.isFile()) throw failure('The selected project path is not a regular file.', 400, 'workspace_path_not_file');
  if (info.size > MAX_LINK_WORKSPACE_FILE_BYTES) throw failure(`Text files are limited to ${MAX_LINK_WORKSPACE_FILE_BYTES} bytes.`, 413, 'workspace_file_too_large');
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fs.open(resolved.path, flags);
  try {
    const buffer = await handle.readFile();
    if (buffer.length > MAX_LINK_WORKSPACE_FILE_BYTES) throw failure(`Text files are limited to ${MAX_LINK_WORKSPACE_FILE_BYTES} bytes.`, 413, 'workspace_file_too_large');
    const text = decodeText(buffer);
    return { path: segments.join('/'), text, size: buffer.length, sha256: hash(buffer) };
  } finally { await handle.close(); }
}

export async function writeAgentLinkWorkspaceFile(rootPath, { path: relativePath, text, expectedSha256 = '', createOnly = false } = {}, options = {}) {
  if (typeof createOnly !== 'boolean') throw failure('createOnly must be a boolean.');
  if (typeof expectedSha256 !== 'string') throw failure('expectedSha256 must be a string.');
  if (typeof text !== 'string' || text.includes('\0')) throw failure('Provide UTF-8 text content.');
  const content = Buffer.from(text, 'utf8');
  if (content.length > MAX_LINK_WORKSPACE_FILE_BYTES) throw failure(`Text files are limited to ${MAX_LINK_WORKSPACE_FILE_BYTES} bytes.`, 413, 'workspace_file_too_large');
  const segments = parseRelative(relativePath, options);
  const root = await realRoot(rootPath);
  const parent = await walkExisting(root, segments.slice(0, -1), {createDirectories:options.createDirectories === true});
  const parentInfo = await fs.lstat(parent.path);
  if (!parentInfo.isDirectory()) throw failure('The file parent path is not a directory.', 400, 'workspace_path_not_directory');
  const targetName = segments.at(-1);
  const target = path.join(parent.path, targetName);
  return withWriteLock(target, async () => {
  let prior = null;
  try {
    prior = await fs.lstat(target);
    if (prior.isSymbolicLink() || !prior.isFile()) throw failure('Only regular text files can be replaced.', 403, 'workspace_target_denied');
    const realTarget = await fs.realpath(target);
    assertInside(root, realTarget);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const creating = createOnly || (!prior && !expectedSha256);
  if (creating) {
    if (prior) throw failure('The file already exists; use its current SHA-256 to replace it.', 409, 'workspace_file_exists');
  } else {
    if (!prior || !/^[a-f0-9]{64}$/.test(String(expectedSha256))) throw failure('Replacing a file requires its current SHA-256 digest.', 409, 'workspace_expected_hash_required');
    if (prior.size > MAX_LINK_WORKSPACE_FILE_BYTES) throw failure(`Text files are limited to ${MAX_LINK_WORKSPACE_FILE_BYTES} bytes.`, 413, 'workspace_file_too_large');
    const existing = await fs.readFile(target);
    decodeText(existing);
    if (hash(existing) !== expectedSha256) throw failure('The file changed since it was read; read it again before replacing it.', 409, 'workspace_file_changed');
  }
  const outputHash = hash(content);
  const temp = path.join(parent.path, `.hexigrid-write-${crypto.randomUUID()}.tmp`);
  const mode = prior ? prior.mode & 0o777 : 0o600;
  try {
    const handle = await fs.open(temp, 'wx', mode);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    const verifiedParent = await fs.realpath(parent.path);
    assertInside(root, verifiedParent);
    if (creating) {
      try { await fs.link(temp, target); }
      catch (error) { if (error.code === 'EEXIST') throw failure('The file already exists; use its current SHA-256 to replace it.', 409, 'workspace_file_exists'); throw error; }
    } else {
      const latest = await fs.readFile(target);
      if (hash(latest) !== expectedSha256) throw failure('The file changed while the update was being prepared; read it again before replacing it.', 409, 'workspace_file_changed');
      await fs.rename(temp, target);
    }
    return { path: segments.join('/'), size: content.length, sha256: outputHash, created: !prior };
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  });
}
