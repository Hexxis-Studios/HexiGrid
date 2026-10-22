import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES_NAME = 'releases';
const LOCK_NAME = '.prepare-local-release.lock';
const MAX_TOOL_OUTPUT = 32 * 1024 * 1024;
const RELEASE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GENERIC_ERROR = 'Local release preparation failed.';

function fail() {
  throw new Error(GENERIC_ERROR);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isReservedWindowsName(segment) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
}

function pathHasPrivateName(normalized) {
  const parts = normalized.split('/');
  if (parts.some((part) => /^\.env/i.test(part))) return true;
  if (parts.some((part) => ['.git', '.npmrc', 'node_modules'].includes(part.toLowerCase()))) return true;
  if (parts.some((part) => /^(?:credentials?|client[_-]?secret|tokens?|sessions?)$/i.test(part))) return true;
  if (parts.some(isReservedWindowsName)) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(normalized)) return true;
  if (/(^|\/)(?:credentials?|client_secret|token)[^/]*\.json$/i.test(normalized)) return true;
  if (/(^|\/)(?:session|account-session)[^/]*\.(?:json|db|sqlite)$/i.test(normalized)) return true;
  if (/(^|\/)(?:control-room\.json|\.runtime\.json|\.instance\.lock|.*\.state-key|\.development-fresh-start)$/i.test(normalized)) return true;
  if (/(^|\/)data(?:\/|$)/i.test(normalized) && normalized !== 'data/.gitkeep' && normalized !== 'data') return true;
  return false;
}

function validateRelativePath(value, { allowDataDirectory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) fail();
  if (value.startsWith('/') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail();
  if (value.includes(':')) fail();
  const segments = value.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) fail();
  if (path.posix.normalize(value) !== value) fail();
  if (allowDataDirectory && value === 'data') return value;
  if (pathHasPrivateName(value)) fail();
  return value;
}

function validateAllowlist(files) {
  if (!Array.isArray(files) || files.length === 0) fail();
  const entries = [];
  for (const raw of files) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\\') || raw.includes('\0')) fail();
    const entry = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    validateRelativePath(entry);
    if (entry === 'releases' || entry.startsWith('releases/') || /^[*?]/.test(entry)) fail();
    entries.push(entry);
  }
  const includes = (name) => entries.some((entry) => entry === name || entry === `${name}/` || entry === `${name}/**` || entry === `${name}/*` || entry === `${name}/**/*`);
  if (!includes('server.mjs') || !includes('lib') || !includes('public')) fail();
}

async function lstatMaybe(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail();
  }
}

async function readRegularFile(target) {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
    return await fs.readFile(target);
  } catch {
    fail();
  }
}

async function readJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    fail();
  }
}

function validatePackageIdentity(packageJson, lockJson) {
  if (!packageJson || packageJson.name !== 'hexigrid' || typeof packageJson.version !== 'string' || !VERSION.test(packageJson.version)) fail();
  if (!lockJson || lockJson.name !== packageJson.name || lockJson.version !== packageJson.version) fail();
  const lockRoot = lockJson.packages?.[''] ?? lockJson;
  if (lockRoot.name !== packageJson.name || lockRoot.version !== packageJson.version) fail();
  validateAllowlist(packageJson.files);
}

async function resolveNpmCli() {
  const candidates = [];
  if (typeof process.env.npm_execpath === 'string' && process.env.npm_execpath.length > 0) {
    candidates.push(process.env.npm_execpath);
  } else {
    const nodeDir = path.dirname(process.execPath);
    candidates.push(
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(nodeDir, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
      '/usr/share/nodejs/npm/bin/npm-cli.js',
      '/usr/lib/node_modules/npm/bin/npm-cli.js',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js'
    );
    const searchPath = process.env.PATH ?? process.env.Path ?? '';
    for (const entry of searchPath.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(entry, 'npm-cli.js'), path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }

  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(path.resolve(candidate));
      if (path.basename(resolved).toLowerCase() !== 'npm-cli.js') continue;
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      // Check only the next explicit local npm-cli.js candidate.
    }
  }
  fail();
}

function minimalToolEnvironment(stagePath) {
  const env = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  if (pathValue) env.PATH = pathValue;
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const isolatedHome = path.join(stagePath, 'isolated-home');
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  env.npm_config_userconfig = path.join(stagePath, 'empty.npmrc');
  env.npm_config_globalconfig = path.join(stagePath, 'empty-global.npmrc');
  env.npm_config_cache = path.join(stagePath, 'npm-cache');
  env.npm_config_update_notifier = 'false';
  return env;
}

function spawnTool(command, args, options) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let outputLength = 0;
    let exceeded = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      reject(new Error(GENERIC_ERROR));
      return;
    }
    // Bound the owned subprocess only; never terminate an application or process tree.
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300_000);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      outputLength += chunk.length;
      if (outputLength <= MAX_TOOL_OUTPUT) stdout += chunk.toString('utf8');
      else exceeded = true;
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error(GENERIC_ERROR)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || exceeded || timedOut) reject(new Error(GENERIC_ERROR));
      else resolve({ stdout });
    });
  });
}

async function invokeTool(runTool, command, args, options) {
  try {
    const result = await runTool(command, args, { ...options, shell: false, windowsHide: true });
    if (result && typeof result === 'object' && Number.isInteger(result.code) && result.code !== 0) fail();
    if (typeof result === 'string' || Buffer.isBuffer(result)) return result.toString();
    return result?.stdout == null ? '' : Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout);
  } catch {
    fail();
  }
}

function parsePackResponse(stdout, packageJson) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    fail();
  }
  if (!Array.isArray(response) || response.length !== 1) fail();
  const pack = response[0];
  const expectedFilename = `hexigrid-${packageJson.version}.tgz`;
  if (!pack || pack.name !== 'hexigrid' || pack.version !== packageJson.version || pack.filename !== expectedFilename) fail();
  if (path.basename(pack.filename) !== pack.filename || pack.filename.includes('/') || pack.filename.includes('\\')) fail();
  if (!Array.isArray(pack.files) || pack.files.length === 0) fail();
  const paths = new Set();
  const foldedPaths = new Set();
  for (const item of pack.files) {
    if (!item || typeof item !== 'object') fail();
    const relativePath = validateRelativePath(item.path);
    if (relativePath === 'package-lock.json') fail();
    const folded = relativePath.toLowerCase();
    if (paths.has(relativePath) || foldedPaths.has(folded)) fail();
    paths.add(relativePath);
    foldedPaths.add(folded);
    if (item.mode !== undefined) {
      if (!Number.isInteger(item.mode)) fail();
      const kind = item.mode & 0o170000;
      if (kind !== 0 && kind !== 0o100000) fail();
    }
  }
  if (!paths.has('package.json') || !paths.has('server.mjs') || ![...paths].some((entry) => entry.startsWith('lib/')) || ![...paths].some((entry) => entry.startsWith('public/'))) fail();
  return { filename: pack.filename, files: paths };
}

async function ensureOwnedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const real = await fs.realpath(directory);
  if (!samePath(real, directory)) fail();
}

async function walkPayload(payload, { allowRootNodeModules = false } = {}) {
  const files = new Set();
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (allowRootNodeModules && relative === '' && entry.name === 'node_modules') {
        const nodeModulesStat = await fs.lstat(path.join(directory, entry.name));
        if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) fail();
        continue;
      }
      const childPath = validateRelativePath(childRelative, { allowDataDirectory: entry.isDirectory() });
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        await visit(fullPath, childPath);
      } else if (stat.isFile() && stat.nlink <= 1) {
        files.add(childPath);
      } else {
        fail();
      }
    }
  }
  await visit(payload);
  return files;
}

function sameStringSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

async function validatePayloadPackageAndServer(payload, expectedPackage) {
  const packageBytes = await readRegularFile(path.join(payload, 'package.json'));
  const serverStat = await lstatMaybe(path.join(payload, 'server.mjs'));
  if (!serverStat?.isFile() || serverStat.isSymbolicLink()) fail();
  const packedPackage = await readJson(packageBytes);
  if (packedPackage.name !== expectedPackage.name || packedPackage.version !== expectedPackage.version) fail();
  if (JSON.stringify(packedPackage.files) !== JSON.stringify(expectedPackage.files)) fail();
  validateAllowlist(packedPackage.files);
}

async function validatePayloadIdentity(payload, packageJson, lockBytes) {
  await validatePayloadPackageAndServer(payload, packageJson);
  const lockActualBytes = await readRegularFile(path.join(payload, 'package-lock.json'));
  if (!lockActualBytes.equals(lockBytes)) fail();
  const packedLock = await readJson(lockActualBytes);
  if (packedLock.name !== packageJson.name || packedLock.version !== packageJson.version) fail();
  const lockRoot = packedLock.packages?.[''] ?? packedLock;
  if (lockRoot.name !== packageJson.name || lockRoot.version !== packageJson.version) fail();
}

async function assertNoSourceNpmrc(sourceRoot) {
  const npmrc = await lstatMaybe(path.join(sourceRoot, '.npmrc'));
  if (npmrc) fail();
}

async function acquireLock(lockPath) {
  const marker = randomUUID();
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
    await handle.writeFile(marker, 'utf8');
    await handle.sync();
    const stat = await handle.stat();
    return { handle, marker, dev: stat.dev, ino: stat.ino };
  } catch {
    if (handle) {
      try {
        const stat = await handle.stat();
        await handle.close();
        const current = await fs.lstat(lockPath);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) await fs.unlink(lockPath);
      } catch { /* The exact partially-created lock could not be safely removed. */ }
    }
    fail();
  }
}

async function releaseLock(lockPath, ownership) {
  if (!ownership) return;
  try {
    await ownership.handle.close();
  } catch { /* Continue with ownership verification. */ }
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== ownership.dev || stat.ino !== ownership.ino) return;
    if ((await fs.readFile(lockPath, 'utf8')) !== ownership.marker) return;
    await fs.unlink(lockPath);
  } catch { /* A lock is removed only while its ownership is verifiable. */ }
}

async function cleanupStage(stagePath, releasesPath, releaseId, identity) {
  if (!stagePath) return;
  try {
    const resolved = path.resolve(stagePath);
    if (!samePath(path.dirname(resolved), releasesPath) || !path.basename(resolved).startsWith(`.prepare-${releaseId}-`)) return;
    if (!samePath(await fs.realpath(releasesPath), releasesPath)) return;
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) return;
    const real = await fs.realpath(resolved);
    if (!samePath(real, resolved) || !isInside(releasesPath, real)) return;
    await fs.rm(resolved, { recursive: true, force: false, maxRetries: 0 });
  } catch { /* Never broaden cleanup beyond this exact generated staging directory. */ }
}

async function resolveProspectivePath(target) {
  let cursor = path.resolve(target);
  const remainingParts = [];
  while (true) {
    const stat = await lstatMaybe(cursor);
    if (stat) {
      const real = await fs.realpath(cursor);
      return path.resolve(real, ...remainingParts);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) fail();
    remainingParts.unshift(path.basename(cursor));
    cursor = parent;
  }
}

async function prepareDirectories(managerRoot, sourceRoot, id) {
  let requestedRoot;
  try {
    requestedRoot = path.resolve(managerRoot);
    const prospectiveRoot = await resolveProspectivePath(requestedRoot);
    if (isInside(sourceRoot, prospectiveRoot)) fail();
    await fs.mkdir(requestedRoot, { recursive: true });
    const rootStat = await fs.lstat(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail();
    const managerReal = await fs.realpath(requestedRoot);
    if (isInside(sourceRoot, managerReal)) fail();
    const releasesPath = path.join(managerReal, RELEASES_NAME);
    try {
      await fs.mkdir(releasesPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') fail();
    }
    const releasesStat = await fs.lstat(releasesPath);
    if (!releasesStat.isDirectory() || releasesStat.isSymbolicLink()) fail();
    if (!samePath(await fs.realpath(releasesPath), releasesPath)) fail();
    // The explicit package allowlist excludes releases, allowing --root . safely.
    if (isInside(sourceRoot, managerReal)) fail();
    const destination = path.join(releasesPath, id);
    if (!samePath(path.dirname(destination), releasesPath) || !isInside(releasesPath, destination)) fail();
    return { managerReal, releasesPath, destination };
  } catch {
    fail();
  }
}

async function assertDestinationAbsent(destination) {
  const existing = await lstatMaybe(destination);
  if (existing) fail();
}

/**
 * Pack the trusted local source into an isolated staging directory and place it
 * at managerRoot/releases/id. This never registers or activates a release.
 */
export async function prepareLocalRelease({
  sourceRoot = SCRIPT_ROOT,
  managerRoot,
  id,
  installDependencies = false,
  runTool = spawnTool
} = {}) {
  if (typeof managerRoot !== 'string' || managerRoot.length === 0 || typeof id !== 'string' || !RELEASE_ID.test(id) || isReservedWindowsName(id)) fail();
  if (typeof installDependencies !== 'boolean' || typeof runTool !== 'function') fail();

  let sourceReal;
  try {
    sourceReal = await fs.realpath(path.resolve(sourceRoot));
    const sourceStat = await fs.stat(sourceReal);
    if (!sourceStat.isDirectory()) fail();
  } catch {
    fail();
  }

  const packageBytes = await readRegularFile(path.join(sourceReal, 'package.json'));
  const lockBytes = await readRegularFile(path.join(sourceReal, 'package-lock.json'));
  const packageJson = await readJson(packageBytes);
  const lockJson = await readJson(lockBytes);
  validatePackageIdentity(packageJson, lockJson);
  await assertNoSourceNpmrc(sourceReal);

  const { releasesPath, destination } = await prepareDirectories(managerRoot, sourceReal, id);
  const lockPath = path.join(releasesPath, LOCK_NAME);
  let lockOwnership;
  let stagePath;
  let stageIdentity;
  try {
    lockOwnership = await acquireLock(lockPath);
    await assertDestinationAbsent(destination);
    const npmCliPath = await resolveNpmCli();
    stagePath = await fs.mkdtemp(path.join(releasesPath, `.prepare-${id}-`));
    const stageStat = await fs.lstat(stagePath);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || !samePath(await fs.realpath(stagePath), stagePath) || !isInside(releasesPath, stagePath)) fail();
    stageIdentity = { dev: stageStat.dev, ino: stageStat.ino };

    const packDirectory = path.join(stagePath, 'pack');
    const payload = path.join(stagePath, 'payload');
    await fs.mkdir(packDirectory);
    await fs.mkdir(payload);
    await fs.writeFile(path.join(stagePath, 'empty.npmrc'), '', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(stagePath, 'empty-global.npmrc'), '', { flag: 'wx', mode: 0o600 });
    await ensureOwnedDirectory(stagePath);
    await ensureOwnedDirectory(packDirectory);
    await ensureOwnedDirectory(payload);

    const env = minimalToolEnvironment(stagePath);
    if ((await fs.readdir(packDirectory)).length !== 0) fail();
    const npmArgs = [npmCliPath, 'pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory];
    const packStdout = await invokeTool(runTool, process.execPath, npmArgs, { cwd: sourceReal, env });
    const packed = parsePackResponse(packStdout, packageJson);

    await ensureOwnedDirectory(stagePath);
    await ensureOwnedDirectory(packDirectory);
    const packContents = await fs.readdir(packDirectory);
    if (packContents.length !== 1 || packContents[0] !== packed.filename) fail();
    const archive = path.join(packDirectory, packed.filename);
    const archiveStat = await fs.lstat(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size <= 0 || !samePath(await fs.realpath(archive), archive)) fail();

    const tarArgs = ['--extract', '--gzip', '--file', archive, '--strip-components=1', '--directory', payload];
    await invokeTool(runTool, 'tar', tarArgs, { cwd: stagePath, env });
    await ensureOwnedDirectory(stagePath);
    await ensureOwnedDirectory(payload);
    const extractedFiles = await walkPayload(payload);
    if (!sameStringSet(extractedFiles, packed.files)) fail();

    await validatePayloadPackageAndServer(payload, packageJson);
    // package-lock.json is intentionally absent from npm pack output.
    const beforeLockFiles = await walkPayload(payload);
    if (!sameStringSet(beforeLockFiles, packed.files)) fail();
    await fs.copyFile(path.join(sourceReal, 'package-lock.json'), path.join(payload, 'package-lock.json'), fsConstants.COPYFILE_EXCL);
    await validatePayloadIdentity(payload, packageJson, lockBytes);
    const stagedFiles = await walkPayload(payload);
    const expectedWithLock = new Set(packed.files);
    expectedWithLock.add('package-lock.json');
    if (!sameStringSet(stagedFiles, expectedWithLock)) fail();

    if (installDependencies) {
      const ciArgs = [npmCliPath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
      await invokeTool(runTool, process.execPath, ciArgs, { cwd: payload, env });
      await ensureOwnedDirectory(payload);
      await validatePayloadIdentity(payload, packageJson, lockBytes);
      const nodeModules = await lstatMaybe(path.join(payload, 'node_modules'));
      if (!nodeModules?.isDirectory() || nodeModules.isSymbolicLink()) fail();
      const postInstallFiles = await walkPayload(payload, { allowRootNodeModules: true });
      if (!sameStringSet(postInstallFiles, expectedWithLock)) fail();
    }

    await assertDestinationAbsent(destination);
    await ensureOwnedDirectory(releasesPath);
    await fs.rename(payload, destination);
    await cleanupStage(stagePath, releasesPath, id, stageIdentity);
    stagePath = undefined;
    return {
      id,
      prepared: installDependencies,
      nextAction: installDependencies
        ? 'Review the prepared release locally; it is not registered or active.'
        : 'Prepare a new release id with --install-dependencies to include dependencies.'
    };
  } catch {
    await cleanupStage(stagePath, releasesPath, id, stageIdentity);
    fail();
  } finally {
    await releaseLock(lockPath, lockOwnership);
  }
}

function parseCli(argv) {
  const options = { root: undefined, id: undefined, installDependencies: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' && options.root === undefined && argv[index + 1]) options.root = argv[++index];
    else if (arg === '--id' && options.id === undefined && argv[index + 1]) options.id = argv[++index];
    else if (arg === '--install-dependencies' && !options.installDependencies) options.installDependencies = true;
    else fail();
  }
  if (!options.root || !options.id) fail();
  return options;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = await prepareLocalRelease({ managerRoot: options.root, id: options.id, installDependencies: options.installDependencies });
    process.stdout.write(`${JSON.stringify({ id: result.id, prepared: result.prepared, nextAction: result.nextAction })}\n`);
  } catch {
    process.stderr.write(`${GENERIC_ERROR}\n`);
    process.exitCode = 1;
  }
}
