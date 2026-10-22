import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PLUGIN_SCHEMA_VERSION = 2;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
const RISK_LEVELS = new Set(['none', 'low', 'medium', 'high', 'critical']);
const RISK_ORDER = ['none', 'low', 'medium', 'high', 'critical'];
const SAFE_HEADER = /^[a-z0-9-]{1,80}$/;
const FORBIDDEN_REQUEST_HEADERS = new Set(['authorization', 'cookie', 'host', 'proxy-authorization', 'x-api-key']);

function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value, max, fallback = '') { return typeof value === 'string' ? value.trim().slice(0, max) : fallback; }
function cleanId(value, label = 'Plugin') {
  const id = boundedText(value, 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(id)) throw new Error(`${label} ids use 2–49 lowercase letters, numbers, and hyphens.`);
  return id;
}
function relativeFile(value) {
  const file = String(value || '').replace(/\\/g, '/');
  if (!file || file.length > 240 || file.startsWith('/') || file.includes('\0') || file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Plugin files must use safe relative paths.');
  if (!/\.(?:mjs|js|json)$/i.test(file)) throw new Error('Plugin bundles may contain only .mjs, .js, and .json files.');
  return file;
}
function workspaceRoot(value) {
  const root = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!root || root.length > 180 || root.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Plugin file permissions need safe workspace-relative roots.');
  return root;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function sanitizeSchema(value, depth = 0) {
  if (!plainObject(value) || depth > 5) return { type: 'object', properties: {}, additionalProperties: false };
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const type = allowedTypes.has(value.type) ? value.type : 'object';
  const schema = { type };
  if (typeof value.title === 'string') schema.title = value.title.slice(0, 100);
  if (typeof value.description === 'string') schema.description = value.description.slice(0, 500);
  if (Array.isArray(value.enum) && value.enum.length <= 100) schema.enum = structuredClone(value.enum);
  if (type === 'object') {
    schema.properties = {};
    for (const [name, child] of Object.entries(value.properties || {}).slice(0, 50)) {
      if (/^[A-Za-z0-9_-]{1,80}$/.test(name)) schema.properties[name] = sanitizeSchema(child, depth + 1);
    }
    schema.required = Array.isArray(value.required) ? [...new Set(value.required.filter((name) => schema.properties[name]))].slice(0, 50) : [];
    schema.additionalProperties = value.additionalProperties === true;
  }
  if (type === 'array') {
    schema.items = sanitizeSchema(value.items || { type: 'string' }, depth + 1);
    schema.maxItems = Math.min(1000, Math.max(0, Number(value.maxItems) || 100));
  }
  if (type === 'string') {
    schema.maxLength = Math.min(100000, Math.max(0, Number(value.maxLength) || 12000));
    if (typeof value.pattern === 'string' && value.pattern.length <= 200) {
      try { new RegExp(value.pattern); schema.pattern = value.pattern; } catch {}
    }
  }
  if (['number', 'integer'].includes(type)) {
    if (Number.isFinite(value.minimum)) schema.minimum = value.minimum;
    if (Number.isFinite(value.maximum)) schema.maximum = value.maximum;
  }
  if (Object.hasOwn(value, 'default')) {
    validateSchemaValue(schema, value.default, `${schema.title || 'Schema'} default`);
    if (Buffer.byteLength(JSON.stringify(value.default)) > 4096) throw new Error('Schema defaults must be at most 4 KB.');
    schema.default = structuredClone(value.default);
  }
  return schema;
}

export function validateSchemaValue(schema, value, label = 'Value', depth = 0) {
  if (depth > 8) throw new Error(`${label} is nested too deeply.`);
  const type = schema?.type || 'object';
  const valid = type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? plainObject(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (!valid) throw new Error(`${label} must be ${type === 'integer' ? 'a whole number' : type}.`);
  if (schema.enum && !schema.enum.some((item) => canonical(item) === canonical(value))) throw new Error(`${label} is not an allowed value.`);
  if (type === 'string') {
    if (value.length > (schema.maxLength ?? 12000)) throw new Error(`${label} is too long.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${label} has an invalid format.`);
  }
  if (['number', 'integer'].includes(type)) {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label} is below the minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label} is above the maximum.`);
  }
  if (type === 'array') {
    if (value.length > (schema.maxItems ?? 100)) throw new Error(`${label} has too many items.`);
    value.forEach((item, index) => validateSchemaValue(schema.items, item, `${label}[${index}]`, depth + 1));
  }
  if (type === 'object') {
    for (const required of schema.required || []) if (!(required in value)) throw new Error(`${schema.properties?.[required]?.title || required} is required.`);
    for (const [name, child] of Object.entries(value)) {
      if (!schema.properties?.[name]) {
        if (!schema.additionalProperties) throw new Error(`${label} contains an undeclared field: ${name}.`);
      } else validateSchemaValue(schema.properties[name], child, schema.properties[name].title || name, depth + 1);
    }
  }
  return value;
}

function sanitizeNetworkRule(value) {
  if (!plainObject(value)) throw new Error('Each network permission must be an object.');
  let parsed;
  try { parsed = new URL(value.origin); } catch { throw new Error('Network permissions need an exact origin.'); }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Network permission origins cannot contain paths, credentials, queries, or fragments.');
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('Plugin network origins must use HTTPS; HTTP is allowed only for a loopback service.');
  const methods = [...new Set((Array.isArray(value.methods) ? value.methods : ['GET']).map((item) => String(item).toUpperCase()).filter((item) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(item)))];
  if (!methods.length) throw new Error('A network permission needs at least one allowed method.');
  const pathPrefix = String(value.pathPrefix || '/');
  if (!pathPrefix.startsWith('/') || pathPrefix.includes('..') || pathPrefix.length > 300) throw new Error('Network path prefixes must be absolute URL paths without traversal.');
  const secretHeaders = (Array.isArray(value.secretHeaders) ? value.secretHeaders : []).slice(0, 10).map((item) => {
    const header = String(item?.header || '').toLowerCase();
    const secret = String(item?.secret || '').toLowerCase();
    if (!SAFE_HEADER.test(header) || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(secret)) throw new Error('Secret header mappings need safe header and secret ids.');
    return { header, secret, prefix: typeof item?.prefix === 'string' ? item.prefix.slice(0, 30) : '' };
  });
  return { origin: parsed.origin, methods, pathPrefix, secretHeaders };
}

function sanitizeLimits(value) {
  const input = plainObject(value) ? value : {};
  return {
    timeoutMs: Math.min(30000, Math.max(250, Number(input.timeoutMs) || 10000)),
    memoryMb: Math.min(256, Math.max(32, Number(input.memoryMb) || 64)),
    outputBytes: Math.min(1024 * 1024, Math.max(1024, Number(input.outputBytes) || 65536)),
    requestBytes: Math.min(1024 * 1024, Math.max(1024, Number(input.requestBytes) || 262144)),
    brokerRequests: Math.min(100, Math.max(0, Number(input.brokerRequests) || 20)),
    concurrency: Math.min(4, Math.max(1, Number(input.concurrency) || 1))
  };
}

export function validatePluginManifest(input, { requirePackage = false } = {}) {
  if (!plainObject(input)) throw new Error('plugin.json must contain an object.');
  if (Number(input.schemaVersion) !== PLUGIN_SCHEMA_VERSION) throw new Error(`This plugin uses a legacy or unsupported manifest. HexiGrid requires schemaVersion ${PLUGIN_SCHEMA_VERSION}.`);
  const id = cleanId(input.id || input.name);
  const entry = relativeFile(input.entry || 'plugin.mjs');
  const secrets = (Array.isArray(input.secrets) ? input.secrets : []).slice(0, 30).map((item) => {
    const secretId = cleanId(item?.id, 'Secret');
    return { id: secretId, label: boundedText(item?.label, 100, secretId), required: item?.required !== false };
  });
  if (new Set(secrets.map((item) => item.id)).size !== secrets.length) throw new Error('Plugin secret ids must be unique.');
  const secretIds = new Set(secrets.map((item) => item.id));
  const capabilities = (Array.isArray(input.capabilities) ? input.capabilities : []).slice(0, 30).map((item) => {
    const capabilityId = cleanId(item?.id || item?.name, 'Capability');
    const permissions = plainObject(item?.permissions) ? item.permissions : {};
    const files = plainObject(permissions.files) ? permissions.files : {};
    const network = (Array.isArray(permissions.network) ? permissions.network : []).slice(0, 30).map(sanitizeNetworkRule);
    for (const rule of network) for (const mapping of rule.secretHeaders) if (!secretIds.has(mapping.secret)) throw new Error(`Capability ${capabilityId} references undeclared secret ${mapping.secret}.`);
    const readRoots = [...new Set((Array.isArray(files.readRoots) ? files.readRoots : []).slice(0, 30).map(workspaceRoot))];
    const writeRoots = [...new Set((Array.isArray(files.writeRoots) ? files.writeRoots : []).slice(0, 30).map(workspaceRoot))];
    let risk = RISK_LEVELS.has(item?.risk) ? item.risk : 'high';
    const floor = network.some((rule) => rule.secretHeaders.length || rule.methods.some((method) => method !== 'GET')) ? 'high' : writeRoots.length || network.length ? 'medium' : readRoots.length ? 'low' : 'none';
    if (RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf(floor)) risk = floor;
    return {
      id: capabilityId,
      label: boundedText(item?.label || item?.name, 100, capabilityId),
      description: boundedText(item?.description, 500),
      risk,
      inputSchema: sanitizeSchema(item?.inputSchema || { type: 'object', properties: {} }),
      outputSchema: sanitizeSchema(item?.outputSchema || { type: 'object', properties: {}, additionalProperties: true }),
      permissions: { files: { readRoots, writeRoots }, network },
      limits: sanitizeLimits(item?.limits)
    };
  });
  if (!capabilities.length) throw new Error('Declare at least one plugin capability.');
  if (new Set(capabilities.map((item) => item.id)).size !== capabilities.length) throw new Error('Plugin capability ids must be unique.');
  const publisher = plainObject(input.publisher) ? {
    id: cleanId(input.publisher.id, 'Publisher'),
    name: boundedText(input.publisher.name, 100, input.publisher.id),
    publicKey: boundedText(input.publisher.publicKey, 8000),
    signature: boundedText(input.publisher.signature, 12000)
  } : null;
  if (publisher && (!publisher.publicKey || !publisher.signature)) throw new Error('A signed publisher record needs both an Ed25519 public key and signature.');
  const packageRecord = plainObject(input.package) ? {
    digest: boundedText(input.package.digest, 80),
    files: Array.isArray(input.package.files) ? input.package.files.map((file) => ({ path: relativeFile(file?.path), sha256: boundedText(file?.sha256, 64), size: Number(file?.size) })).sort((a, b) => a.path.localeCompare(b.path)) : []
  } : null;
  if (requirePackage && (!packageRecord || !/^sha256:[a-f0-9]{64}$/.test(packageRecord.digest))) throw new Error('The installed plugin package identity is missing.');
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION, id, name: boundedText(input.name, 100, id), version: boundedText(input.version, 40, '1.0.0'),
    description: boundedText(input.description, 500), entry, secrets, capabilities,
    ...(publisher ? { publisher } : {}), ...(packageRecord ? { package: packageRecord } : {})
  };
}

function manifestIdentity(manifest) {
  const copy = structuredClone(manifest);
  delete copy.package;
  if (copy.publisher) delete copy.publisher.signature;
  return copy;
}

export function buildPackageIdentity(manifestInput, filesInput) {
  const manifest = validatePluginManifest(manifestInput);
  if (!Array.isArray(filesInput) || filesInput.length < 1 || filesInput.length > MAX_FILES) throw new Error('Upload 1–100 plugin files.');
  const seen = new Set();
  let total = 0;
  const files = filesInput.map((file) => {
    const filePath = relativeFile(file?.path);
    if (filePath === 'plugin.json' || seen.has(filePath)) throw new Error('Plugin file names must be unique and cannot replace plugin.json.');
    seen.add(filePath);
    const content = typeof file?.content === 'string' ? file.content : '';
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) throw new Error('Each plugin file is limited to 1 MB.');
    total += bytes;
    return { path: filePath, content, sha256: sha256(Buffer.from(content)), size: bytes };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (total > MAX_PACKAGE_BYTES) throw new Error('The plugin bundle is limited to 10 MB.');
  if (!seen.has(manifest.entry)) throw new Error(`The plugin entry file ${manifest.entry} was not included.`);
  const inventory = files.map(({ path: filePath, sha256: digest, size }) => ({ path: filePath, sha256: digest, size }));
  const digest = `sha256:${sha256(canonical({ manifest: manifestIdentity(manifest), files: inventory }))}`;
  if (manifest.package?.digest && manifest.package.digest !== digest) throw new Error('The plugin package digest does not match its manifest and files.');
  if (manifest.package?.files?.length && canonical(manifest.package.files) !== canonical(inventory)) throw new Error('The plugin file inventory does not match the uploaded files.');
  return { manifest: { ...manifest, package: { digest, files: inventory } }, files, digest };
}

export function publisherFingerprint(publicKey) {
  try {
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return sha256(key.export({ type: 'spki', format: 'der' }));
  } catch { throw new Error('Publisher keys must be valid Ed25519 public keys.'); }
}

export function verifyPublisherSignature(manifest) {
  if (!manifest.publisher) return null;
  try {
    const key = crypto.createPublicKey(manifest.publisher.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    const signature = Buffer.from(manifest.publisher.signature, 'base64');
    if (!signature.length || !crypto.verify(null, Buffer.from(manifest.package.digest), key, signature)) throw new Error();
    return publisherFingerprint(manifest.publisher.publicKey);
  } catch { throw new Error('The plugin publisher signature is invalid.'); }
}

async function writeExclusive(file, content) { await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }); }

export async function installPluginPackage({ pluginRoot, manifest: manifestInput, files: filesInput, trustMode, trustedPublisherKey = '' }) {
  const identity = buildPackageIdentity(manifestInput, filesInput);
  let trust;
  let publisherFingerprintValue = null;
  if (identity.manifest.publisher) {
    publisherFingerprintValue = verifyPublisherSignature(identity.manifest);
    if (!trustedPublisherKey) {
      const error = new Error('Review and trust this publisher key before installation.');
      error.code = 'PUBLISHER_TRUST_REQUIRED';
      error.publisher = { id: identity.manifest.publisher.id, name: identity.manifest.publisher.name, fingerprint: publisherFingerprintValue, publicKey: identity.manifest.publisher.publicKey };
      throw error;
    }
    if (publisherFingerprint(trustedPublisherKey) !== publisherFingerprintValue) throw new Error('The signed package does not match the trusted publisher key.');
    trust = 'signed-publisher';
  } else {
    if (trustMode !== 'owner-local') {
      const error = new Error('Unsigned plugins require explicit confirmation that you created or reviewed this local bundle.');
      error.code = 'LOCAL_TRUST_REQUIRED';
      throw error;
    }
    trust = 'owner-local';
  }
  const digestName = identity.digest.slice(7);
  const pluginBase = path.join(pluginRoot, identity.manifest.id);
  const target = path.join(pluginBase, digestName);
  const temporary = path.join(pluginRoot, `.installing-${crypto.randomUUID()}`);
  const pluginStoreReal = await fs.realpath(pluginRoot);
  try {
    const baseStat = await fs.lstat(pluginBase);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('The plugin install location is not a trusted directory.');
    const baseReal = await fs.realpath(pluginBase);
    if (path.relative(pluginStoreReal, baseReal).startsWith('..')) throw new Error('The plugin install location escapes the plugin store.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    await writeExclusive(path.join(temporary, 'plugin.json'), JSON.stringify(identity.manifest, null, 2));
    for (const file of identity.files) {
      const output = path.join(temporary, ...file.path.split('/'));
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await writeExclusive(output, file.content);
    }
    try {
      const baseStat = await fs.lstat(pluginBase);
      if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('The plugin install location is not a trusted directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(pluginBase, { recursive: false, mode: 0o700 });
    }
    try { await fs.rename(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY' && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      const verified = await verifyInstalledPlugin({ ...identity.manifest, installPath: `${identity.manifest.id}/${digestName}` }, pluginRoot);
      if (!verified.ok) throw new Error('An existing package with this digest failed verification.');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { ...identity.manifest, trust, publisherFingerprint: publisherFingerprintValue, installPath: `${identity.manifest.id}/${digestName}` };
}

async function packageFiles(directory) {
  const output = [];
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in plugin packages: ${rel}.`);
      if (stat.isDirectory()) await walk(absolute, rel);
      else if (stat.isFile() && rel !== 'plugin.json') output.push({ path: relativeFile(rel), content: await fs.readFile(absolute, 'utf8') });
      else if (!stat.isFile()) throw new Error(`Unsupported plugin package entry: ${rel}.`);
    }
  }
  await walk(directory);
  return output;
}

export async function verifyInstalledPlugin(plugin, pluginRoot) {
  try {
    const safe = validatePluginManifest(plugin, { requirePackage: true });
    const installPath = String(plugin.installPath || '').replace(/\\/g, '/');
    const expected = `${safe.id}/${safe.package.digest.slice(7)}`;
    if (installPath !== expected) throw new Error('The installed package path does not match its digest.');
    const directory = path.resolve(pluginRoot, ...installPath.split('/'));
    const relative = path.relative(path.resolve(pluginRoot), directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The plugin package path escapes the plugin store.');
    const realRoot = await fs.realpath(pluginRoot);
    const realDirectory = await fs.realpath(directory);
    const realRelative = path.relative(realRoot, realDirectory);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('The plugin package resolves outside the plugin store.');
    const baseStat = await fs.lstat(path.join(pluginRoot, safe.id));
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('The plugin package parent is not trustworthy.');
    const rootStat = await fs.lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The plugin package directory is not trustworthy.');
    const diskManifest = JSON.parse(await fs.readFile(path.join(directory, 'plugin.json'), 'utf8'));
    const identity = buildPackageIdentity(diskManifest, await packageFiles(directory));
    if (identity.digest !== safe.package.digest || canonical(identity.manifest) !== canonical(safe)) throw new Error('The installed plugin manifest or file digest changed.');
    if (safe.publisher) verifyPublisherSignature(safe);
    return { ok: true, directory, manifest: safe };
  } catch (error) { return { ok: false, error: error.message }; }
}

function insideRoot(relativePath, roots) { return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`)); }
function safeWorkspaceRelative(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.length > 500 || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Broker file paths must be safe workspace-relative paths.');
  return relative;
}
async function rejectSymlinkPath(workspaceRoot, relativePath) {
  let current = path.resolve(workspaceRoot);
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Broker file paths cannot cross symbolic links.'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}

function pluginAbortError() { return new Error('Plugin execution was cancelled.'); }

function throwIfPluginAborted(signal) {
  if (signal?.aborted) throw pluginAbortError();
}

function awaitWithPluginAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(pluginAbortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const complete = (callback, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(result);
    };
    const onAbort = () => complete(reject, pluginAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve(value).then(result => complete(resolve, result), error => complete(reject, error));
  });
}

function redactInjectedSecrets(value, secrets) {
  let result = String(value ?? '');
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
  return result;
}

export function createCapabilityBroker({ capability, workspaceRoot, secretResolver = async () => '', fetchImpl = globalThis.fetch, authorize = async () => {}, signal: callerSignal }) {
  let requests = 0;
  const receipts = [];
  async function dispatch(operation, args = {}) {
    requests += 1;
    if (requests > capability.limits.brokerRequests) throw new Error('Plugin exceeded its broker request limit.');
    const startedAt = new Date().toISOString();
    let target = '';
    let secretBoundRequest = false;
    let timedOut = false;
    const receiptOperation = ['files.readText', 'files.writeText', 'network.request'].includes(operation) ? operation : 'unknown';
    try {
      throwIfPluginAborted(callerSignal);
      const policyCapability = operation === 'files.readText' ? 'read_local' : operation === 'files.writeText' ? 'write_workspace' : String(args.method || 'GET').toUpperCase() === 'GET' ? 'network_read' : 'external_write';
      await awaitWithPluginAbort(authorize({ operation: receiptOperation, policyCapability, risk: capability.risk, capabilityId: capability.id, signal: callerSignal }), callerSignal);
      throwIfPluginAborted(callerSignal);
      let result;
      if (operation === 'files.readText' || operation === 'files.writeText') {
        const relative = safeWorkspaceRelative(args.path);
        const roots = operation === 'files.readText' ? capability.permissions.files.readRoots : capability.permissions.files.writeRoots;
        if (!insideRoot(relative, roots)) throw new Error('Plugin file request is outside its declared roots.');
        await rejectSymlinkPath(workspaceRoot, relative);
        const absolute = path.resolve(workspaceRoot, ...relative.split('/'));
        const fromRoot = path.relative(path.resolve(workspaceRoot), absolute);
        if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw new Error('Plugin file request escaped the workspace.');
        target = relative;
        if (operation === 'files.readText') {
          const stat = await fs.stat(absolute);
          if (!stat.isFile() || stat.size > capability.limits.requestBytes) throw new Error('Requested file is unavailable or exceeds the capability limit.');
          result = await awaitWithPluginAbort(fs.readFile(absolute, 'utf8'), callerSignal);
        } else {
          const content = typeof args.content === 'string' ? args.content : '';
          if (Buffer.byteLength(content) > capability.limits.requestBytes) throw new Error('Plugin write exceeds the capability request limit.');
          await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await rejectSymlinkPath(workspaceRoot, relative);
          throwIfPluginAborted(callerSignal);
          await fs.writeFile(absolute, content, { mode: 0o600 });
          result = { path: relative, bytes: Buffer.byteLength(content) };
        }
      } else if (operation === 'network.request') {
        if (Object.hasOwn(args, 'responseMode')) throw new Error('Plugins cannot select a secret response mode.');
        const url = new URL(args.url);
        if (url.username || url.password || url.hash) throw new Error('Plugin network requests cannot contain credentials or fragments.');
        const method = String(args.method || 'GET').toUpperCase();
        const safeUrl = `${url.origin}${url.pathname}`;
        const networkTarget = `${method} ${safeUrl}`.slice(0, 500);
        target = networkTarget;
        const rule = capability.permissions.network.find((item) => item.origin === url.origin && item.methods.includes(method) && (item.pathPrefix === '/' || url.pathname === item.pathPrefix || url.pathname.startsWith(`${item.pathPrefix.replace(/\/$/, '')}/`)));
        if (!rule) throw new Error('Plugin network request is outside its declared destination, path, or method.');
        const headers = {};
        for (const [rawName, rawValue] of Object.entries(plainObject(args.headers) ? args.headers : {})) {
          const name = rawName.toLowerCase();
          if (!SAFE_HEADER.test(name) || FORBIDDEN_REQUEST_HEADERS.has(name)) throw new Error(`Plugin cannot set the ${name || 'invalid'} request header.`);
          headers[name] = String(rawValue).slice(0, 2000);
        }
        const injectedSecrets = [];
        let metadataOnlyResponse = false;
        const body = args.body === undefined || args.body === null ? undefined : String(args.body);
        if (body && Buffer.byteLength(body) > capability.limits.requestBytes) throw new Error('Plugin network body exceeds the capability request limit.');
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort();
        callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
        if (callerSignal?.aborted) abortFromCaller();
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(10000, capability.limits.timeoutMs));
        const requestContext = (header = '', prefix = '') => Object.freeze({ operation: 'network.request', url: safeUrl,
          method, header, prefix, capabilityId: capability.id, signal: controller.signal });
        try {
          throwIfPluginAborted(controller.signal);
          for (const mapping of rule.secretHeaders) {
            secretBoundRequest = true;
            const context = requestContext(mapping.header, mapping.prefix);
            const resolution = secretResolver(mapping.secret, context);
            const resolved = await awaitWithPluginAbort(resolution, controller.signal);
            let secret;
            if (typeof resolved === 'string') {
              secret = resolved;
            } else if (plainObject(resolved)) {
              const keys = Reflect.ownKeys(resolved);
              const valueDescriptor = Object.getOwnPropertyDescriptor(resolved, 'value');
              const modeDescriptor = Object.getOwnPropertyDescriptor(resolved, 'responseMode');
              if (Object.getPrototypeOf(resolved) !== Object.prototype && Object.getPrototypeOf(resolved) !== null) throw new Error('Invalid plugin credential result.');
              if (keys.length !== 2 || !keys.includes('value') || !keys.includes('responseMode') ||
                  !valueDescriptor || !Object.hasOwn(valueDescriptor, 'value') ||
                  !modeDescriptor || !Object.hasOwn(modeDescriptor, 'value') ||
                  typeof valueDescriptor.value !== 'string' || !valueDescriptor.value || modeDescriptor.value !== 'metadata-only') {
                throw new Error('Invalid plugin credential result.');
              }
              // Copy the host-only response mode into a frozen internal record. It is
              // never read from plugin arguments or sent to the destination.
              const hostCredential = Object.freeze({ value: valueDescriptor.value, responseMode: modeDescriptor.value });
              secret = hostCredential.value;
              metadataOnlyResponse = true;
            } else {
              throw new Error('Invalid plugin credential result.');
            }
            if (typeof secret !== 'string' || !secret) throw new Error('Missing plugin credential.');
            headers[mapping.header] = `${mapping.prefix}${secret}`;
            injectedSecrets.push(secret);
          }
          const authorizationContext = { operation: 'network.request', policyCapability, risk: capability.risk,
            url: safeUrl, method, capabilityId: capability.id, signal: controller.signal };
          // Recheck after all asynchronous credential resolution, then again
          // immediately before handing the secret-bearing request to fetch.
          await awaitWithPluginAbort(authorize(authorizationContext), controller.signal);
          throwIfPluginAborted(controller.signal);
          await awaitWithPluginAbort(authorize(authorizationContext), controller.signal);
          throwIfPluginAborted(controller.signal);
          const response = await awaitWithPluginAbort(fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal }), controller.signal);
          if (metadataOnlyResponse) {
            // A live host reference may be used to make the request, but the plugin
            // receives no destination-controlled representation data.
            const status = response?.status;
            if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Invalid plugin network response.');
            result = { status, ok: status >= 200 && status <= 299, headers: {}, body: '' };
          } else {
            const rawBody = await awaitWithPluginAbort(response.text(), controller.signal);
            if (Buffer.byteLength(rawBody) > capability.limits.requestBytes) throw new Error('Plugin network response exceeds the capability request limit.');
            let responseBody = redactInjectedSecrets(rawBody, injectedSecrets);
            const responseHeaders = {};
            for (const name of ['content-type', 'etag', 'last-modified']) {
              const value = response.headers.get(name);
              if (value) responseHeaders[name] = redactInjectedSecrets(value.slice(0, 500), injectedSecrets);
            }
            result = { status: response.status, ok: response.ok, headers: responseHeaders, body: responseBody };
          }
          await awaitWithPluginAbort(authorize(authorizationContext), controller.signal);
          throwIfPluginAborted(controller.signal);
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', abortFromCaller);
          // Close an unread live-reference response without inspecting its body.
          controller.abort();
        }
      } else throw new Error('Plugin requested an unknown broker operation.');
      receipts.push({ operation: receiptOperation, target: target.slice(0, 500), status: 'completed', startedAt });
      return result;
    } catch (error) {
      receipts.push({ operation: receiptOperation, target: target.slice(0, 500), status: 'denied', startedAt });
      if (callerSignal?.aborted) throw pluginAbortError();
      if (timedOut) throw new Error('Plugin network request timed out.');
      if (secretBoundRequest) throw new Error('Plugin credential-bound request failed.');
      throw error instanceof Error ? error : new Error('Plugin broker request failed.');
    }
  }
  return { dispatch, receipts };
}

function loaderSource(pluginDirectory) {
  const rootUrl = pathToFileURL(`${path.resolve(pluginDirectory)}${path.sep}`).href;
  return `import {builtinModules} from 'node:module';
const root=${JSON.stringify(rootUrl)};
const allowed=new Set(['assert','buffer','crypto','path','querystring','string_decoder','url','util']);
const builtins=new Set(builtinModules.map(x=>x.replace(/^node:/,'')));
export async function resolve(specifier,context,nextResolve){
 const clean=String(specifier).replace(/^node:/,''); const base=clean.split('/')[0];
 if(builtins.has(clean)||builtins.has(base)){if(!allowed.has(base))throw new Error('Plugin import blocked: '+base);return nextResolve(specifier,context);}
 if(!specifier.startsWith('.')&&!specifier.startsWith('file:'))throw new Error('Plugin packages cannot import undeclared external packages.');
 const resolved=await nextResolve(specifier,context); if(resolved.url.startsWith('file:')&&!resolved.url.startsWith(root))throw new Error('Plugin import escaped its immutable package.'); return resolved;
}`;
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} resolve(); });
      killer.on('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export async function runPluginCapability(options) {
  const { plugin, capability, input = {}, pluginRoot, workspaceRoot, runnerPath, secretResolver, signal, fetchImpl, authorize } = options;
  throwIfPluginAborted(signal);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Plugin isolation requires Node.js 22 or newer.');
  const verified = await verifyInstalledPlugin(plugin, pluginRoot);
  if (!verified.ok) { const error = new Error(`Plugin quarantined: ${verified.error}`); error.code = 'PLUGIN_TAMPERED'; throw error; }
  validateSchemaValue(capability.inputSchema, input, 'Input');
  const executionController = new AbortController();
  const broker = createCapabilityBroker({ capability, workspaceRoot, secretResolver, fetchImpl, authorize, signal: executionController.signal });
  const runnerSource = await fs.readFile(runnerPath, 'utf8');
  const loader = `data:text/javascript,${encodeURIComponent(loaderSource(verified.directory))}`;
  const args = [
    '--permission', '--allow-worker', `--allow-fs-read=${verified.directory}`, '--no-addons', '--frozen-intrinsics',
    `--max-old-space-size=${capability.limits.memoryMb}`, '--experimental-loader', loader,
    '--input-type=module', '--eval', runnerSource, verified.directory, plugin.entry
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: workspaceRoot, windowsHide: true, detached: process.platform !== 'win32', env: { PATH: process.env.PATH || '', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false; let protocolBytes = 0; let rawOutputBytes = 0; let stderr = '';
    const finish = async (error, value) => {
      if (settled) return; settled = true; executionController.abort(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) await terminateProcessTree(child);
      if (error) { error.brokerReceipts = structuredClone(broker.receipts); reject(error); }
      else resolve({ ok: true, result: value, brokerReceipts: broker.receipts });
    };
    const onAbort = () => { executionController.abort(); void finish(new Error('Plugin execution was cancelled.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error(`Plugin timed out after ${capability.limits.timeoutMs} ms.`)), capability.limits.timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > capability.limits.outputBytes) finish(new Error('Plugin exceeded its diagnostic output limit.')); });
    child.stdout.on('data', (chunk) => { rawOutputBytes += chunk.length; if (rawOutputBytes > capability.limits.outputBytes) finish(new Error('Plugin exceeded its output limit.')); });
    child.on('error', (error) => finish(new Error(`Plugin could not start: ${error.message}`)));
    child.on('close', (code) => { if (!settled) finish(new Error(stderr.trim().slice(0, 1000) || `Plugin exited with code ${code}.`)); });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', async (line) => {
      protocolBytes += Buffer.byteLength(line);
      if (protocolBytes > capability.limits.outputBytes) return finish(new Error('Plugin exceeded its output limit.'));
      let message;
      try { message = JSON.parse(line); } catch { return finish(new Error('Plugin returned an invalid protocol message.')); }
      if (message.type === 'broker' && typeof message.id === 'string') {
        try {
          const result = await broker.dispatch(message.operation, message.args);
          if (!settled && child.exitCode === null) child.stdin.write(`${JSON.stringify({ type: 'broker-result', id: message.id, ok: true, result })}\n`);
        } catch (error) {
          if (!settled && child.exitCode === null) child.stdin.write(`${JSON.stringify({ type: 'broker-result', id: message.id, ok: false, error: String(error.message).slice(0, 500) })}\n`);
        }
      } else if (message.type === 'result') {
        try { validateSchemaValue(capability.outputSchema, message.result, 'Output'); finish(null, message.result); }
        catch (error) { finish(error); }
      } else if (message.type === 'error') finish(new Error(String(message.error || 'Plugin failed.').slice(0, 1000)));
      else finish(new Error('Plugin returned an unknown protocol message.'));
    });
    child.stdin.write(`${JSON.stringify({ type: 'invoke', capability: capability.id, input })}\n`);
  });
}
