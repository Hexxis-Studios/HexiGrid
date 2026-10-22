import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

export const OWNER_AGENT_CAPABILITIES = Object.freeze([
  'owner-filesystem-read', 'owner-filesystem-write', 'owner-process', 'desktop-system-keys'
]);
// Each signed companion request must fit the encrypted relay's bounded envelope.
const MAX_TRANSFER_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const activeWrites = new Set();
async function fileDigest(target) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

export function ownerAgentAuthorized(connection, bridge, capability) {
  if (connection?.status !== 'connected' || connection.trustLevel !== 'owner' || !connection.capabilities?.includes(capability)) {
    throw fail('Owner-agent access is not granted to this Link.', 403);
  }
  if (!bridge?.enabled || !bridge.ownerApproved || !bridge.agentControlActive || bridge.linkId !== connection.id) {
    throw fail('Start computer access for this owner agent before using machine tools.', 403);
  }
}

export function setOwnerAgentTrust(connection, trustLevel) {
  if (!['scoped', 'owner'].includes(trustLevel)) throw fail('Choose scoped or owner trust.');
  const previous = connection.trustLevel === 'owner' ? 'owner' : 'scoped';
  connection.trustLevel = trustLevel;
  connection.capabilities = trustLevel === 'owner' && previous !== 'owner'
    ? [...new Set([...connection.capabilities, ...OWNER_AGENT_CAPABILITIES])]
    : trustLevel === 'owner' ? [...connection.capabilities] : connection.capabilities.filter((item) => !OWNER_AGENT_CAPABILITIES.includes(item));
  connection.ownerGrantedCapabilities = trustLevel === 'owner'
    ? [...new Set(previous === 'owner' ? (connection.ownerGrantedCapabilities || connection.capabilities) : connection.capabilities)]
    : [];
  return { previous, trustLevel, capabilities: [...connection.capabilities] };
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    throw fail('Provide an absolute file path on this computer.');
  }
  if (process.platform === 'win32' && (/^\\\\[.?]\\/.test(value) || /^\\\\\?\\/.test(value))) throw fail('Device paths are unavailable.');
  return path.resolve(value);
}

export async function listOwnerAgentDirectory(inputPath) {
  const target = absolutePath(inputPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return { path: target, entries: entries.slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other' })), truncated: entries.length > 500 };
}

export async function readOwnerAgentFile(inputPath, { offset = 0, length = MAX_TRANSFER_BYTES } = {}) {
  const target = absolutePath(inputPath);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_TRANSFER_BYTES) throw fail('Invalid file range.');
  const handle = await fs.open(target, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail('The selected path is not a regular file.');
    const count = Math.min(length, Math.max(0, info.size - offset));
    const bytes = Buffer.alloc(count);
    const { bytesRead } = await handle.read(bytes, 0, count, offset);
    const data = bytes.subarray(0, bytesRead);
    return { path: target, offset, size: info.size, modifiedAt: info.mtimeMs, bytesRead, sha256: digest(data), data: data.toString('base64'), encoding: 'base64', eof: offset + bytesRead >= info.size };
  } finally { await handle.close(); }
}

export async function writeOwnerAgentFile({ path: inputPath, data, createOnly = false, append = false, expectedSha256 = '' } = {}) {
  const target = absolutePath(inputPath);
  const writeKey = process.platform === 'win32' ? target.toLowerCase() : target;
  if (activeWrites.has(writeKey)) throw fail('Another owner-agent write to this file is in progress.', 409);
  activeWrites.add(writeKey);
  try {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_TRANSFER_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw fail('Provide bounded base64 file data.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_TRANSFER_BYTES) throw fail('One file transfer chunk exceeds 512 KiB.', 413);
  if (append && createOnly) throw fail('Choose create-only or append, not both.');
  let existing = null;
  try { existing = await fs.lstat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !existing.isFile()) throw fail('The target path is not a regular file.');
  if (createOnly && existing) throw fail('The target file already exists.', 409);
  if (!createOnly && (!existing || !/^[a-f0-9]{64}$/i.test(expectedSha256) || await fileDigest(target) !== expectedSha256.toLowerCase())) throw fail('The target file changed or its expected SHA-256 was not supplied.', 409);
  const temporary = path.join(path.dirname(target), `.hexigrid-owner-write-${crypto.randomUUID()}`);
  try {
    if (append) {
      await fs.copyFile(target, temporary, constants.COPYFILE_EXCL);
      if (await fileDigest(temporary) !== expectedSha256.toLowerCase()) throw fail('The target file changed while preparing the append.', 409);
      await fs.appendFile(temporary, bytes);
    } else await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (createOnly) {
      await fs.link(temporary, target);
    } else {
      if (await fileDigest(target) !== expectedSha256.toLowerCase()) throw fail('The target file changed before replacement.', 409);
      await fs.rename(temporary, target);
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  const info = await fs.stat(target);
  return { path: target, created: !existing, size: info.size, sha256: await fileDigest(target) };
  } finally { activeWrites.delete(writeKey); }
}

export function runOwnerAgentProcess({ command, args = [], cwd, timeoutMs = 30000 } = {}, { spawnFn = spawn } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || !Array.isArray(args) || args.length > 100 || args.some((item) => typeof item !== 'string' || item.length > 8192 || item.includes('\0'))) throw fail('Provide one executable and a bounded argument list.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail('Process timeout must be 1–120 seconds.');
  const directory = cwd === undefined ? process.cwd() : absolutePath(cwd);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let outBytes = 0; let errBytes = 0; let done = false;
    let timer;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
    const capture = (chunks, isStdout) => (chunk) => {
      const bytes = Buffer.from(chunk);
      if (isStdout) outBytes += bytes.length; else errBytes += bytes.length;
      if (outBytes + errBytes > MAX_OUTPUT_BYTES) { child.kill(); finish(fail('The process output exceeded 128 KiB.', 413)); return; }
      chunks.push(bytes);
    };
    child.stdout?.on('data', capture(stdout, true));
    child.stderr?.on('data', capture(stderr, false));
    child.once('error', () => finish(fail('The owner-agent process could not start.', 502)));
    child.once('close', (code, signal) => finish(null, { exitCode: code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    timer = setTimeout(() => { child.kill(); finish(fail('The owner-agent process timed out.', 504)); }, timeoutMs);
  });
}
