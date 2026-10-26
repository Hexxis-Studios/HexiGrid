#!/usr/bin/env node
/**
 * Outbound companion client for HexiGrid Link.
 *
 * It uses only Node 22 built-ins and the encrypted HTTPS long-poll relay. The
 * companion never opens a listener and never needs an SSH tunnel to the owner.
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const companionModuleCandidates = [
  path.resolve(scriptDirectory, '../../../lib/companion-client.mjs'),
  path.resolve(scriptDirectory, '../lib/companion-client.mjs')
];
const companionModulePath = companionModuleCandidates.find((candidate) => existsSync(candidate));
if (!companionModulePath) throw new Error('The bundled HexiGrid companion runtime is missing. Reinstall the complete hexigrid-link skill.');
const { OutboundCompanionConnection, normalizeCompanionRelayOrigin } = await import(pathToFileURL(companionModulePath).href);

const CONFIG_DIR = path.join(os.homedir(), '.hexigrid-link');
const VAULT_DIR = path.join(CONFIG_DIR, 'vault');
const CAPABILITIES = ['messages', 'status', 'receipts', 'cognition', 'identity', 'token-metering', 'continuity-export', 'memory-read', 'memory-write', 'vision', 'voice', 'tasks', 'harness-jobs', 'desktop-view', 'desktop-control', 'desktop-type', 'camera-view', 'microphone-listen', 'speaker-output', 'workspace-read', 'workspace-write', 'hexispace-profile', 'hexispace-posts', 'hexispace-comments', 'hexispace-friends', 'hexispace-relationships', 'hexispace-reactions'];

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv; const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) continue;
    const name = item.slice(2); const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; index += 1; }
    else flags[name] = true;
  }
  return { command, flags };
}

function requireFlag(flags, name) { const value = typeof flags[name] === 'string' ? flags[name].trim() : ''; if (!value) throw new Error(`Supply --${name} <value>; a bare --${name} is not a value.`); return value; }
function memoryDepth(flags) { const value = String(flags.depth ?? '0'); if (!/^[012]$/.test(value)) throw new Error('Memory depth must be 0, 1, or 2.'); return Number(value); }
function skillDepth(flags) { const value = String(flags.depth ?? '0'); if (!/^[01]$/.test(value)) throw new Error('Skill depth must be 0 or 1.'); return Number(value); }
function skillLimit(flags) { if (flags.limit === undefined) return 10; const value = Number(flags.limit); if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error('Skill page limit must be 1 to 20.'); return value; }
function skillRevision(flags) { const depth = skillDepth(flags); if (flags['before-revision'] === undefined) return {}; if (depth !== 1) throw new Error('--before-revision requires --depth 1.'); const value = Number(flags['before-revision']); if (!Number.isSafeInteger(value) || value < 1) throw new Error('Skill revision cursor must be a positive integer.'); return { beforeRevision: value }; }
function memoryId(flags) { const value = requireFlag(flags, 'id'); if (!/^memory-[0-9a-f-]{36}$/i.test(value)) throw new Error('Memory ID is invalid.'); return value; }
function retrievalFeedback(flags) {
  const retrievalId = requireFlag(flags, 'retrieval');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(retrievalId)) throw new Error('Retrieval ID is invalid.');
  if (flags.useful === true) throw new Error('--useful needs comma-separated memory IDs or an empty string.');
  const usefulIds = flags.useful === undefined || flags.useful === '' ? [] : String(flags.useful).split(',').map((value) => value.trim());
  if (usefulIds.length > 100 || usefulIds.some((value) => !/^memory-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))) {
    throw new Error('Useful memory IDs must be a list of at most 100 exact memory IDs.');
  }
  return { retrievalId, usefulIds: [...new Set(usefulIds)] };
}
function memoryContextId(flags, name) { const value = requireFlag(flags, name); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Memory context ${name} is invalid.`); return value; }
function memoryContextBytes(flags) { if (flags['max-bytes'] === undefined) return 8192; const value = Number(flags['max-bytes']); if (!Number.isSafeInteger(value) || value < 512 || value > 32768) throw new Error('Memory context byte budget must be 512 to 32768.'); return value; }
function memoryScopeBytes(flags) { const value = memoryContextBytes(flags); if (value < 1024) throw new Error('Memory scope byte budget must be 1024 to 32768.'); return value; }
function validConnectionId(value) { return /^link-[A-Za-z0-9-]+$/.test(value) ? value : (() => { throw new Error('Invalid connection ID.'); })(); }
function configPath(connectionId) { return path.join(CONFIG_DIR, `${validConnectionId(connectionId)}.json`); }
function aliasLabel(connectionId) {
  const words = ['an', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on'];
  // A public connection ID names the entry; the credential belongs only in its value.
  return [...crypto.createHash('sha256').update(validConnectionId(connectionId)).digest('hex').slice(0, 32)].map(digit => words[parseInt(digit, 16)]).join('.');
}
function credentialAlias(connectionId) { return `hexigrid-link.token.${aliasLabel(connectionId)}`; }
function routingAlias(connectionId) { return `hexigrid-link.routing.${aliasLabel(connectionId)}`; }
function recordRoutingAlias(record) { return recordAlias(record) === `hexigrid-link-${record.connectionId}` ? `hexigrid-link-routing-${record.connectionId}` : routingAlias(record.connectionId); }
async function readConfig(connectionId) {
  let cached;
  try { cached = JSON.parse(await fs.readFile(configPath(connectionId), 'utf8')); }
  catch { /* A missing or damaged disposable cache can be recovered from the vault. */ }
  if (cached && cached.storage !== 'platform-vault') return cached;
  for (const [alias, tokenAlias] of [[routingAlias(connectionId), credentialAlias(connectionId)], [`hexigrid-link-routing-${connectionId}`, `hexigrid-link-${connectionId}`]]) {
    try {
      const record = JSON.parse(extractSecretValue(secretCli(['get', `--alias=${alias}`])));
      if (record.connectionId !== connectionId || record.tokenAlias !== tokenAlias || !record.origin || record.mode !== 'outbound-companion') throw new Error();
      recordOrigin(record);
      return { ...record, storage: 'platform-vault' };
    } catch { /* Retain read compatibility with the exact connection's old labels. */ }
  }
  if (cached) return cached;
  throw Object.assign(new Error('No readable saved connection was found. Check this runtime\'s protected vault before requesting another invitation; temporary storage failure is not a lost credential. Replace the connection only if its details were never saved or were lost.'), { code: 'CONNECTION_STORAGE_UNAVAILABLE' });
}
async function writeConfig(record) {
  if (['token', 'secret', 'credential', 'inviteSecret'].some(key => Object.hasOwn(record, key))) throw new Error('Credentials cannot be written into routing metadata.');
  if (record.storage === 'platform-vault') {
    const serialized = JSON.stringify(record);
    const alias = recordRoutingAlias(record);
    secretCli(['put', `--alias=${alias}`, '--value-from=-', '--kind=HexiGrid Link routing', '--usage-hint=Restore only this exact saved HexiGrid connection after a sandbox rebuild'], serialized);
    if (!isDeepStrictEqual(JSON.parse(extractSecretValue(secretCli(['get', `--alias=${alias}`]))), JSON.parse(serialized))) throw new Error('The protected vault did not retain the connection details. Do not report setup as complete.');
  }
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const destination = configPath(record.connectionId);
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  } catch (error) { if (record.storage !== 'platform-vault') throw error; }
}
const recordOrigin = (record) => normalizeCompanionRelayOrigin(record.origin || record.baseUrl || '');
const recordAlias = (record) => String(record.tokenAlias || record.secretAlias || '');
const vaultPath = (alias) => path.join(VAULT_DIR, String(alias).replace(/[^A-Za-z0-9._-]/g, '_'));

function secretCli(args, input = undefined) {
  let command;
  try { command = JSON.parse(process.env.HEXIGRID_LINK_SECRET_COMMAND || '["ilands","secret"]'); } catch { throw new Error('The platform secret helper command must be a JSON argument list.'); }
  if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part || part.includes('\0'))) throw new Error('The platform secret helper command is invalid.');
  const completed = spawnSync(command[0], [...command.slice(1), ...args], { input, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 256 * 1024 });
  if (completed.error?.code === 'ENOENT') throw Object.assign(new Error('The platform secret store is unavailable.'), { code: 'SECRET_STORE_UNAVAILABLE' });
  if (completed.error || completed.status !== 0) {
    const error = Object.assign(new Error('The platform secret store could not complete the request. Inspect the captured failure locally; do not publish provider output.'), { code: 'SECRET_STORE_OPERATION_FAILED', operation: args[0], exitCode: completed.status, helperErrorCode: completed.error?.code, signal: completed.signal || undefined });
    // Keep the native failure in memory for local diagnosis, out of serialized results.
    Object.defineProperty(error, 'providerDiagnostic', { value: { stdout: completed.stdout || '', stderr: completed.stderr || '' } });
    throw error;
  }
  return completed.stdout.trim();
}

function extractSecretValue(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (typeof value === 'string') return value;
  if (value && Object.hasOwn(value, 'details')) {
    const details = value.details;
    if (value.isError !== true && !['not_found', 'error', 'failed', 'denied', 'revoked'].includes(String(details?.status || '').toLowerCase()) && typeof details?.payload?.value === 'string') return details.payload.value;
    throw new Error('The protected secret response format is not supported. No values were disclosed.');
  }
  if (value?.connectionId && value?.mode) return raw;
  for (const key of ['value', 'secret', 'token', 'content', 'data']) {
    if (typeof value?.[key] === 'string') return value[key];
    if (value?.[key] && typeof value[key] === 'object') return extractSecretValue(JSON.stringify(value[key]));
  }
  throw new Error('The protected secret response format is not supported. No values were disclosed.');
}

async function checkStorage(flags = {}) {
  const requiresDurableStore = Boolean(flags.ephemeral) || /^i[\s_-]*lands(?:\b|[\s_-])/i.test(String(flags.framework || ''));
  const connectionId = `link-${crypto.randomUUID()}`;
  const alias = credentialAlias(connectionId);
  const routeAlias = routingAlias(connectionId);
  const value = crypto.randomBytes(32).toString('base64url');
  const route = { mode: 'outbound-companion', connectionId, origin: 'https://example.invalid', inviteId: `link-invite-${crypto.randomUUID()}`, deviceId: `device-${crypto.randomUUID()}`, clientDeviceId: `companion-device-${crypto.randomUUID()}`, tokenAlias: alias, storage: 'platform-vault', lastSequence: 0, lastAudioSequence: 0, lastSpeakerSequence: 0, capabilities: [] };
  let stage = 'credential-write';
  try {
    secretCli(['put', `--alias=${alias}`, '--value-from=-', '--kind=HexiGrid Link token', '--usage-hint=Disposable connection-storage check'], value);
    stage = 'credential-read';
    if (extractSecretValue(secretCli(['get', `--alias=${alias}`])) !== value) throw new Error('The protected vault failed its storage check. The invitation has not been used.');
    stage = 'routing-write';
    secretCli(['put', `--alias=${routeAlias}`, '--value-from=-', '--kind=HexiGrid Link routing', '--usage-hint=Disposable connection-storage check'], JSON.stringify(route));
    stage = 'routing-read';
    if (!isDeepStrictEqual(JSON.parse(extractSecretValue(secretCli(['get', `--alias=${routeAlias}`]))), route)) throw new Error('The protected vault failed its routing storage check. The invitation has not been used.');
    return 'platform-vault';
  } catch (error) {
    error.stage = stage;
    if (error.code !== 'SECRET_STORE_UNAVAILABLE') throw error;
    if (requiresDurableStore) throw new Error('This runtime rebuilds its files and has no supported persistent secret store. The invitation has not been used. Use a supported persistent connection; do not fall back to files or browser pairing.');
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const probe = path.join(CONFIG_DIR, `${alias}.tmp`);
    try { await fs.writeFile(probe, value, { mode: 0o600, flag: 'wx' }); if (await fs.readFile(probe, 'utf8') !== value) throw new Error('Local connection storage could not be verified.'); }
    finally { await fs.rm(probe, { force: true }); }
    return 'private-local-profile';
  } finally {
    for (const probe of [alias, routeAlias]) {
      try { secretCli(['revoke', `--alias=${probe}`]); } catch { /* Only our own random probes are eligible for cleanup. */ }
    }
  }
}

async function getSecret(alias) {
  try {
    const raw = secretCli(['get', `--alias=${alias}`]);
    const token = extractSecretValue(raw);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('The protected credential format is invalid.');
    return token;
  } catch (error) {
    try {
      const target = vaultPath(alias); const stat = await fs.stat(target);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('The fallback token file permissions are not private.');
      const token = (await fs.readFile(target, 'utf8')).trim();
      if (token.length < 32) throw new Error('The fallback token file is invalid.');
      return token;
    } catch (fallbackError) {
      throw Object.assign(new Error('The saved Link credential is not readable. Check the protected vault without displaying values; do not re-pair on a temporary vault failure.'), { code: 'CREDENTIAL_STORAGE_UNAVAILABLE' });
    }
  }
}

async function saveToken(alias, token, requirePlatform = false) {
  try {
    secretCli(['put', `--alias=${alias}`, '--value-from=-', '--kind=HexiGrid Link token', '--usage-hint=Use only with the paired HexiGrid origin'], token);
    if (extractSecretValue(secretCli(['get', `--alias=${alias}`])) !== token) throw new Error('The protected vault did not retain the credential. Do not report setup as complete.');
  } catch (error) {
    if (requirePlatform || error.code !== 'SECRET_STORE_UNAVAILABLE') throw error;
    await fs.mkdir(VAULT_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(vaultPath(alias), token, { mode: 0o600 });
    await fs.chmod(vaultPath(alias), 0o600).catch(() => {});
  }
}

async function connectionStorageStatus(connectionId) {
  validConnectionId(connectionId);
  let record, routingReadable = false, credentialReadable = false;
  try { record = await readConfig(connectionId); routingReadable = true; } catch { /* Report readability only, never provider output. */ }
  for (const alias of record ? [recordAlias(record)] : [credentialAlias(connectionId), `hexigrid-link-${connectionId}`]) {
    try { credentialReadable = Boolean(await getSecret(alias)); if (credentialReadable) break; } catch { /* Missing and temporarily unavailable remain indistinguishable. */ }
  }
  return { ok: routingReadable && credentialReadable, connectionId, routingReadable, credentialReadable,
    code: routingReadable && credentialReadable ? 'SAVED_CONNECTION_READABLE' : !routingReadable && !credentialReadable ? 'CONNECTION_STORAGE_UNREADABLE' : routingReadable ? 'CREDENTIAL_STORAGE_UNREADABLE' : 'ROUTING_STORAGE_UNREADABLE',
    invitationUsed: false };
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pair(flags) {
  const invite = requireFlag(flags, 'invite');
  const storage = await checkStorage(flags);
  const client = new OutboundCompanionConnection({ inviteUrl: invite, capabilities: CAPABILITIES, automaticControl: false });
  const session = await client.connect();
  try {
    const result = await client.pair({ name: requireFlag(flags, 'name'), framework: String(flags.framework || 'external-agent'), externalId: String(flags['external-id'] || ''), version: 'companion-1' });
    const connectionId = result.connection.id; const alias = credentialAlias(connectionId);
    const record = { mode: 'outbound-companion', connectionId, origin: client.invitation.origin, inviteId: client.invitation.inviteId, deviceId: client.invitation.deviceId, clientDeviceId: client.clientDeviceId, tokenAlias: alias, storage, lastSequence: 0, lastAudioSequence: 0, lastSpeakerSequence: 0, capabilities: result.connection.capabilities };
    let saveStage = 'credential';
    for (let attempt = 0; ; attempt++) {
      try { saveStage = 'credential'; await saveToken(alias, result.token, storage === 'platform-vault'); saveStage = 'routing'; await writeConfig(record); break; }
      catch {
        if (attempt < 2) continue;
        output({ ok: false, paired: true, saved: false, connectionId, storage, code: saveStage === 'credential' ? 'CREDENTIAL_SAVE_FAILED' : 'ROUTING_SAVE_FAILED', error: 'Connected, but the protected connection save failed. Do not report setup as complete or reuse the invitation. Keep this runtime available for recovery.' });
        process.exitCode = 1; return;
      }
    }
    output({ ok: true, transport: 'outbound-companion', connectionId, capabilities: result.connection.capabilities, orientation: result.orientation, relayPeer: session.peerId,
      saved: true, storage, persistence: storage === 'platform-vault' ? 'credential-and-routing-vault-readback-verified' : 'requires-this-local-profile-to-survive', nextCommand: `node scripts/companion_client.mjs status --connection ${connectionId}`,
      backgroundCommand: `node scripts/companion_client.mjs watch --connection ${connectionId}`,
      notice: 'Pairing is complete. Reuse this saved connection on later turns; do not reuse the invitation. Background watch is optional and must run in a supported persistent process.' });
  } finally { await client.close(); }
}

async function openSaved(flags, { automaticControl = false } = {}) {
  const record = await readConfig(requireFlag(flags, 'connection'));
  record.origin = recordOrigin(record); record.tokenAlias = recordAlias(record);
  if (!record.clientDeviceId) { record.clientDeviceId = `companion-device-${crypto.randomUUID()}`; await writeConfig(record); }
  const token = await getSecret(record.tokenAlias);
  if (!token) throw new Error('The HexiGrid Link token is unavailable in the protected secret store.');
  if (!record.storage) {
    try {
      if (extractSecretValue(secretCli(['get', `--alias=${record.tokenAlias}`])) === token) {
        record.storage = 'platform-vault'; await writeConfig(record);
      }
    } catch { /* A legacy local profile stays usable; no new durability claim. */ }
  }
  const client = new OutboundCompanionConnection({ resume: { ...record, token }, automaticControl });
  await client.connect();
  return { record, token, client };
}

async function listen(flags) {
  const { record, client } = await openSaved(flags, { automaticControl: false });
  const deadline = Date.now() + Math.max(1, Math.min(55, Number(flags.timeout) || 25)) * 1000;
  try {
    let received = null;
    client.onEvent = async (event) => {
      const latest = await readConfig(record.connectionId);
      latest.lastSequence = Math.max(Number(latest.lastSequence || 0), Number(event.sequence) || 0);
      await writeConfig(latest);
      received = event;
    };
    while (!received && Date.now() < deadline) {
      const result = await client.pollEvents({ waitMs: Math.min(20000, Math.max(0, deadline-Date.now())), limit:1 });
      if (!result.ok && !received) throw new Error(result.body?.error || 'The Link event request failed.');
    }
    output({ ok:true, events:received ? [received] : [], timedOut:!received, ...(client.pendingEventAck ? {ackPending:true} : {}) });
  } finally { await client.close(); }
}

async function watch(flags) {
  const duration = flags['for-seconds'] === undefined ? 0 : Number(flags['for-seconds']);
  if (!Number.isInteger(duration) || duration < 0 || duration > 86_400) {
    throw new Error('--for-seconds must be an integer from 0 to 86400.');
  }
  const { record, client } = await openSaved(flags, { automaticControl: false });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let pendingSave = Promise.resolve();
  let failure = null;
  const stop = () => { void client.close(); finish(); };
  client.onEvent = async (detail) => {
    // Print before acknowledging progress on disk. A restarted watcher may
    // repeat an event, so consumers should deduplicate by sequence number.
    output({ type: 'event', connectionId: record.connectionId, event: detail });
    pendingSave = pendingSave.then(async () => {
      const latest = await readConfig(record.connectionId);
      latest.lastSequence = Math.max(Number(latest.lastSequence || 0), Number(detail.sequence || 0));
      await writeConfig(latest);
    });
    try { await pendingSave; }
    catch (error) { failure = error; stop(); throw error; }
  };
  const emitOrientation = async () => {
    const result = await client.linkRequest('/agent-link/v1/orientation');
    if (!result.ok) throw new Error(result.body?.error || 'The Link orientation could not be refreshed.');
    output({ type: 'orientation', connectionId: record.connectionId, orientation: result.body.orientation });
  };
  client.addEventListener('reconnected', () => {
    output({ type: 'reconnected', connectionId: record.connectionId });
    void emitOrientation().catch((error) => output({ type: 'orientation-error', connectionId: record.connectionId, reason: error.message }));
  });
  client.addEventListener('closed', ({ detail }) => {
    output({ type: 'closed', connectionId: record.connectionId, reason: detail.reason });
    finish();
  }, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timer = duration ? setTimeout(stop, duration * 1000) : null;
  output({ type: 'ready', connectionId: record.connectionId, transport: 'outbound-companion' });
  await emitOrientation();
  client.automaticControl = true;
  client.startControlLoops();
  try {
    await finished;
    await pendingSave;
    if (failure) throw failure;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await client.close();
  }
}

async function command(flags, pathname, body = null, method = 'POST', includeStatus = false) {
  const { record, client } = await openSaved(flags, { automaticControl: false });
  try {
    const result = await client.linkRequest(pathname, { method, headers: body === null ? {} : { 'content-type': 'application/json' }, body });
    if (includeStatus) {
      const ok = result.ok && !(result.body?.jsonrpc === '2.0' && result.body?.error);
      output({ ok: Boolean(ok), status: result.status, result: result.body });
      if (!ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) throw new Error(result.body?.error || `HexiGrid returned HTTP ${result.status}.`);
    if (result.body?.jsonrpc === '2.0' && result.body?.error) {
      output({ ok: false, status: result.status, result: result.body });
      process.exitCode = 1;
      return;
    }
    if (pathname === '/agent-link/v1/capabilities' && method === 'POST') {
      const actual = result.body?.connection?.capabilities;
      const requested = [...new Set(body.capabilities)];
      const mismatch = requested.find(capability => !actual?.includes(capability)) || actual?.find(capability => !requested.includes(capability));
      if (!Array.isArray(actual) || mismatch) throw new Error(`Capability update was not applied${mismatch ? ` for ${mismatch}` : ''}; read current capabilities before retrying.`);
    }
    output({ ok: true, result: result.body });
  } finally { await client.close(); }
}

async function signedRequest(flags) {
  if (Object.keys(flags).some(key => !['connection', 'method', 'path', 'file', 'stdin'].includes(key))) {
    throw new Error('Request accepts only --connection, --method, --path and one of --file or --stdin.');
  }
  validConnectionId(requireFlag(flags, 'connection'));
  const pathname = requireFlag(flags, 'path');
  const method = flags.method === undefined ? 'GET' : requireFlag(flags, 'method').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Request method must be GET, POST, PUT, PATCH or DELETE.');
  if (pathname.length > 2048 || !/^\/agent-link\/v1\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathname) ||
      pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Request path must be an exact /agent-link/v1/ endpoint, without a URL, query, fragment or traversal.');
  }
  if (flags.stdin !== undefined && flags.stdin !== true) throw new Error('Use bare --stdin to read piped JSON.');
  if (flags.file !== undefined && flags.stdin !== undefined) throw new Error('Choose only --file or --stdin.');
  if (method === 'GET' && (flags.file !== undefined || flags.stdin !== undefined)) throw new Error('GET requests cannot have a JSON body.');
  const maxBytes = 8 * 1024 * 1024;
  let bytes;
  if (flags.file !== undefined) {
    const file = await fs.open(requireFlag(flags, 'file'), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('Request body must be a regular file of at most 8 MiB.');
      // Read no more than the budget even if another process grows the file.
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > info.size) throw new Error('Request body file grew during reading; retry with a stable file.');
      bytes = buffer.subarray(0, offset);
    } finally { await file.close(); }
  } else if (flags.stdin === true) {
    if (process.stdin.isTTY) throw new Error('Pipe one JSON object to --stdin and close the input.');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw new Error('Request body exceeds 8 MiB.');
      chunks.push(bytes);
    }
    bytes = Buffer.concat(chunks);
  }
  let body = null;
  if (bytes !== undefined) {
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Unrepresentable JSON number.');
      return value;
    }); }
    catch { throw new Error('Request body must contain valid UTF-8 JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be one JSON object.');
  }
  return command(flags, pathname, body, method, true);
}

async function events(flags) {
  const after = flags.after === undefined ? undefined : Number(flags.after);
  const waitMs = flags['wait-ms'] === undefined ? 0 : Number(flags['wait-ms']);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error('--after must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25000) throw new Error('--wait-ms must be an integer from 0 to 25000.');
  const { record, client } = await openSaved(flags, { automaticControl: false });
  try {
    const result = await client.linkRequest('/agent-link/v1/events/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { after: after ?? Number(record.lastSequence || 0), waitMs } });
    if (!result.ok) throw new Error(result.body?.error || `HexiGrid returned HTTP ${result.status}.`);
    output({ ok: true, result: result.body });
  } finally { await client.close(); }
}

async function desktopFrame(flags) {
  const { client } = await openSaved(flags);
  try {
    const result = await client.linkRequest('/agent-link/v1/desktop/frame');
    if (!result.ok) throw new Error(result.body?.error || 'The owner did not provide a screen frame.');
    if (flags.output && result.body?.frame?.data) { await fs.writeFile(String(flags.output), Buffer.from(result.body.frame.data, 'base64')); result.body.frame = { ...result.body.frame, data: undefined, savedTo: String(flags.output) }; }
    else if (result.body?.frame) result.body.frame = { ...result.body.frame, data: undefined, notice: 'Use --output to save the private frame locally; it is never printed to the terminal.' };
    output({ ok: true, result: result.body });
  } finally { await client.close(); }
}

async function desktopMedia(flags) {
  const { record, client } = await openSaved(flags);
  try {
    const result = await client.linkRequest('/agent-link/v1/desktop/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { afterCameraSequence: Number(flags['after-camera'] || record.lastCameraSequence || 0), afterAudioSequence: Number(flags['after-audio'] || 0), afterSpeakerSequence: Number(flags['after-speaker'] || 0) } });
    if (!result.ok) throw new Error(result.body?.error || 'The owner did not provide media.');
    const latestAudio = result.body?.audio?.at(-1)?.sequence;
    const latestSpeaker = result.body?.speaker?.at(-1)?.sequence;
    const latestCamera = result.body?.video?.at(-1)?.sequence;
    if (Number.isFinite(Number(latestAudio))) record.lastAudioSequence = Math.max(Number(record.lastAudioSequence || 0), Number(latestAudio));
    if (Number.isFinite(Number(latestSpeaker))) record.lastSpeakerSequence = Math.max(Number(record.lastSpeakerSequence || 0), Number(latestSpeaker));
    if (Number.isFinite(Number(latestCamera))) record.lastCameraSequence = Math.max(Number(record.lastCameraSequence || 0), Number(latestCamera));
    await writeConfig(record);
    if (!flags['include-data']) {
      if (result.body?.camera) result.body.camera = { ...result.body.camera, data: undefined };
      for (const group of ['video', 'audio', 'speaker']) if (Array.isArray(result.body?.[group])) result.body[group] = result.body[group].map((item) => ({ ...item, data: undefined }));
      result.body.notice = 'Media bytes were omitted. Re-run with --include-data only when the private data is needed locally.';
    }
    output({ ok: true, result: result.body });
  } finally { await client.close(); }
}

async function cameraSnapshot(flags) {
  const { record, client } = await openSaved(flags);
  let temporaryDirectory;
  try {
    const result = await client.linkRequest('/agent-link/v1/desktop/media', { method: 'POST', body: { freshCamera: true } });
    if (!result.ok) throw new Error(result.body?.error || 'A fresh camera frame is unavailable.');
    const frame = result.body?.camera;
    if (result.body.freshCamera !== true || !frame?.data || !(frame.sequence > 0) || !Number.isFinite(Date.parse(frame.capturedAt))) throw new Error('No new camera frame was returned. Do not describe an earlier image as current.');
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-camera-'));
    const extension = { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[frame.mimeType];
    if (!extension) throw new Error('The camera returned an unsupported image format.');
    const file = path.join(temporaryDirectory, `snapshot.${extension}`);
    await fs.writeFile(file, Buffer.from(frame.data, 'base64'), { flag: 'wx', mode: 0o600 });
    record.lastCameraSequence = frame.sequence;
    await writeConfig(record);
    output({ ok: true, connectionId: record.connectionId, snapshot: { file, sequence: frame.sequence, capturedAt: frame.capturedAt, width: frame.width, height: frame.height },
      temporary: true, cleanup: 'Inspect this exact file, then delete it and its temporary directory in a finally block. Never put the image in memory or reuse it for a later observation.' });
    temporaryDirectory = null;
  } finally {
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await client.close();
  }
}

async function voiceCallProbe(flags) {
  const { client } = await openSaved(flags);
  const sentAt = new Date().toISOString();
  const started = performance.now();
  try {
    const payload = Buffer.from(`hexigrid-synthetic-audio:${crypto.randomUUID()}`).toString('base64');
    const result = await client.linkRequest('/agent-link/v1/voice-call/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: `probe-${crypto.randomUUID()}`, sentAt, data: payload } });
    if (!result.ok) throw new Error(result.body?.error || 'The synthetic voice-call probe failed.');
    const clientRoundTripMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
    output({ ok: true, synthetic: true, clientRoundTripMs, result: { ...result.body, probe: { ...result.body?.probe, data: undefined } } });
  } finally { await client.close(); }
}

async function voiceCallMedia(flags) {
  const callId = requireFlag(flags, 'call-id');
  if (!/^voice-call-[0-9a-f-]{36}$/i.test(callId)) throw new Error('--call-id must be the exact voice-call ID returned by voice-call-status.');
  const waitMs = flags['wait-ms'] === undefined ? 8000 : Number(flags['wait-ms']);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new Error('--wait-ms must be an integer from 0 to 10000.');
  if (flags['after-audio'] !== undefined && (!Number.isSafeInteger(Number(flags['after-audio'])) || Number(flags['after-audio']) < 0)) throw new Error('--after-audio must be a nonnegative safe integer.');
  const { record, client } = await openSaved(flags);
  const afterAudioSequence = flags['after-audio'] === undefined
    ? record.voiceCallAudioCallId === callId ? Number(record.voiceCallAudioSequence || 0) : 0
    : Number(flags['after-audio']);
  try {
    const response = await client.linkRequest('/agent-link/v1/voice-call/media', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: { callId, afterAudioSequence, waitMs } });
    if (!response.ok) throw new Error(response.body?.error || `HexiGrid returned HTTP ${response.status}.`);
    const result = response.body || {};
    const latest = result.audio?.at(-1)?.sequence;
    if (flags['include-data'] === true && Number.isSafeInteger(Number(latest))) {
      const sameCall = record.voiceCallAudioCallId === callId;
      record.voiceCallAudioCallId = callId;
      record.voiceCallAudioSequence = sameCall ? Math.max(Number(record.voiceCallAudioSequence || 0), Number(latest)) : Number(latest);
      await writeConfig(record);
    } else if (Array.isArray(result.audio)) {
      result.audio = result.audio.map(({ data, ...segment }) => ({ ...segment, data: undefined }));
      result.notice = 'Private audio bytes were omitted. Use --include-data only when your active speech-recognition runtime needs the audio locally.';
    }
    output({ ok: true, result });
  } finally { await client.close(); }
}

async function voiceCallReply(flags) {
  const text = requireFlag(flags, 'text');
  const body = { text, ...(flags['call-id'] ? { callId: String(flags['call-id']) } : {}) };
  if (flags['media-epoch'] !== undefined) {
    const epoch = Number(flags['media-epoch']);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('--media-epoch must be the nonnegative selection number from the current call.');
    body.mediaEpoch = epoch;
  }
  const audioPath = typeof flags['audio-file'] === 'string' ? flags['audio-file'].trim() : '';
  if (audioPath) {
    const target = path.resolve(audioPath);
    const handle = await fs.open(target, 'r');
    let bytes;
    let info;
    try {
      info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > 680 * 1024) throw new Error('--audio-file must be a regular audio file between 1 byte and 680 KiB.');
      const bounded = Buffer.alloc(680 * 1024 + 1);
      const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
      if (bytesRead > 680 * 1024) throw new Error('--audio-file must be a regular audio file between 1 byte and 680 KiB.');
      bytes = bounded.subarray(0, bytesRead);
    } finally { await handle.close(); }
    const extension = path.extname(target).toLowerCase();
    const mimeType = ({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4' })[extension];
    if (!mimeType) throw new Error('--audio-file supports WAV, MP3, OGG, WebM or M4A audio.');
    body.audio = { mimeType, data: bytes.toString('base64') };
  }
  return command(flags, '/agent-link/v1/voice-call/reply', body);
}

async function main() {
  const { command: commandName, flags } = parseArgs(process.argv.slice(2));
  if (commandName === 'request' && flags.help === true && Object.keys(flags).length === 1) {
    output({ ok: true, usage: 'request --connection <id> --method <GET|POST|PUT|PATCH|DELETE> --path <exact /agent-link/v1/ path> [--stdin | --file <JSON file>]',
      defaults: { method: 'GET' }, maxBodyBytes: 8 * 1024 * 1024,
      guidance: 'One JSON object; GET has no body. No URLs, queries, fragments, traversal, custom headers or owner /api/. Current signed authority applies. Passive output {ok,status,result}; denial exit1. Keep private input off argv and private output local.' });
    return;
  }
  if (commandName === 'request') return signedRequest(flags);
  if (commandName === 'storage-check') { const storage = await checkStorage(flags); output({ ok: true, storage, credentialAndRouting: storage === 'platform-vault' ? 'vault-backed' : 'requires-persistent-local-profile', invitationUsed: false }); return; }
  if (commandName === 'storage-status') { output(await connectionStorageStatus(requireFlag(flags, 'connection'))); return; }
  if (commandName === 'pair') return pair(flags);
  if (commandName === 'listen') return listen(flags);
  if (commandName === 'events') return events(flags);
  if (commandName === 'watch') return watch(flags);
  if (commandName === 'avatar-read') return command(flags, '/agent-link/v1/avatar', null, 'GET');
  if (commandName === 'avatar-portrait-read') return command(flags, '/agent-link/v1/avatar/portrait', null, 'GET');
  if (commandName === 'avatar-portrait') {
    if (flags.image && (await fs.stat(flags.image)).size > 1024 * 1024) throw new Error('Choose a portrait smaller than 1 MB.');
    const image = flags.image ? await fs.readFile(flags.image) : null;
    const type = image ? image[0] === 137 ? 'png' : image[0] === 255 ? 'jpeg' : 'webp' : '';
    return command(flags, '/agent-link/v1/avatar/portrait', { ...(image ? { imageData: `data:image/${type};base64,${image.toString('base64')}` } : {}), animate: flags.still !== true && flags.still !== 'true' });
  }
  if (commandName === 'avatar-update') return command(flags, '/agent-link/v1/avatar', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'send') {
    if (flags['thread-id'] && flags['thread-name']) throw new Error('Choose either --thread-id or --thread-name.');
    const threadId = flags['thread-id'] ? String(flags['thread-id']) : '';
    if (threadId && !/^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/.test(threadId)) throw new Error('The Codex thread ID is invalid.');
    return command(flags, '/agent-link/v1/messages', { clientMessageId: flags['client-message-id'] ? String(flags['client-message-id']) : `msg-${crypto.randomUUID()}`, type: 'message', text: requireFlag(flags, 'text'),
      ...(threadId ? { metadata: { codexThreadId: threadId } } : flags['thread-name'] ? { metadata: { codexThreadName: String(flags['thread-name']) } } : {}) });
  }
  if (commandName === 'codex-deliveries') return command(flags, '/agent-link/v1/codex/deliveries', null, 'GET');
  if (commandName === 'codex-chats') return command(flags, '/agent-link/v1/codex/chats', null, 'GET');
  if (commandName === 'codex-projects') return command(flags, '/agent-link/v1/codex/projects', null, 'GET');
  if (commandName === 'codex-chat-create') return command(flags, '/agent-link/v1/codex/chats', {
    projectId: requireFlag(flags, 'project'), prompt: requireFlag(flags, 'text'),
    ...(flags.title ? { title: String(flags.title) } : {})
  });
  if (commandName === 'history') return command(flags, '/agent-link/v1/messages/history', {
    ...(flags.before ? { before: String(flags.before) } : {}),
    limit: flags.limit === undefined ? 100 : Number(flags.limit)
  });
  if (commandName === 'ask') return command(flags, '/agent-link/v1/cognition', { clientMessageId: `cognition-${crypto.randomUUID()}`, content: requireFlag(flags, 'text') });
  if (commandName === 'heartbeat') return command(flags, '/agent-link/v1/heartbeat', { transport: 'outbound-https' });
  if (commandName === 'orientation' || commandName === 'status') return command(flags, '/agent-link/v1/orientation', null, 'GET');
  if (commandName === 'capabilities') return command(flags, '/agent-link/v1/capabilities', null, 'GET');
  if (commandName === 'capabilities-set') return command(flags, '/agent-link/v1/capabilities',
    { capabilities: JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')).capabilities });
  if (commandName === 'identity') return command(flags, '/agent-link/v1/identity', { identity: JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')) });
  if (commandName === 'continuity') return command(flags, '/agent-link/v1/continuity', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'continuity-request') return command(flags, '/agent-link/v1/continuity/export-request', {});
  if (commandName === 'continuity-request-status') return command(flags, `/agent-link/v1/continuity/export-request/${encodeURIComponent(requireFlag(flags, 'request'))}`, null, 'GET');
  if (commandName === 'memory-append' || commandName === 'memory-propose') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose-memory', arguments: JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')) } });
  if (commandName === 'memory-correction-propose') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose-correction', arguments: JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')) } });
  if (commandName === 'memory-owner-correction-propose') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose-owner-memory-correction', arguments: JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')) } });
  if (commandName === 'memory-health') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect-memory-health', arguments: flags.after === undefined ? {} : { after: requireFlag(flags, 'after') } } });
  if (commandName === 'memory-read') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read-log-range', arguments: { from: requireFlag(flags, 'from'), to: requireFlag(flags, 'to') } } });
  if (commandName === 'memory-get') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-memory', arguments: { id: memoryId(flags), depth: memoryDepth(flags) } } });
  if (commandName === 'memory-owner-notes') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-owner-notes', arguments: { limit: Number(flags.limit || 20), maxBytes: memoryContextBytes(flags), ...(flags.cursor === undefined ? {} : { cursor: requireFlag(flags, 'cursor') }) } } });
  if (commandName === 'memory-owner-note') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-owner-note', arguments: { id: memoryId(flags) } } });
  if (commandName === 'memory-select') {
    const threadId = flags['thread-id'] === undefined ? '' : String(flags['thread-id']);
    if (threadId && !/^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/.test(threadId)) throw new Error('The Codex thread ID is invalid.');
    return command(flags, '/agent-link/v1/memory-scope', { scope: { projectId: memoryContextId(flags, 'project'), ...(flags.topic === undefined ? {} : { topicId: memoryContextId(flags, 'topic') }) }, ...(threadId ? { codexThreadId: threadId } : {}) });
  }
  if (commandName === 'memory-clear') {
    const threadId = flags['thread-id'] === undefined ? '' : String(flags['thread-id']);
    if (threadId && !/^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/.test(threadId)) throw new Error('The Codex thread ID is invalid.');
    return command(flags, '/agent-link/v1/memory-scope', { scope: null, ...(threadId ? { codexThreadId: threadId } : {}) });
  }
  if (commandName === 'memory-context') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall-context', arguments: { projectId: memoryContextId(flags, 'project'), ...(flags.topic === undefined ? {} : { topicId: memoryContextId(flags, 'topic') }), ...(flags.query === undefined ? {} : { query: requireFlag(flags, 'query') }), maxBytes: memoryContextBytes(flags), ...(flags.cursor === undefined ? {} : { cursor: requireFlag(flags, 'cursor') }) } } });
  if (commandName === 'memory-feedback') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record-retrieval-feedback', arguments: retrievalFeedback(flags) } });
  if (commandName === 'memory-entity') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall-entity', arguments: { alias: requireFlag(flags, 'alias'), projectId: memoryContextId(flags, 'project'), ...(flags.topic === undefined ? {} : { topicId: memoryContextId(flags, 'topic') }), maxBytes: memoryContextBytes(flags), ...(flags.cursor === undefined ? {} : { cursor: requireFlag(flags, 'cursor') }) } } });
  if (commandName === 'memory-scopes') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-context-scopes', arguments: { maxBytes: memoryScopeBytes(flags), ...(flags.cursor === undefined ? {} : { cursor: requireFlag(flags, 'cursor') }) } } });
  if (commandName === 'memory-shares') return command(flags, '/agent-link/v1/shared-memory', { operation: 'list', limit: flags.limit === undefined ? 10 : Number(flags.limit), ...(flags.after ? { after: String(flags.after) } : {}) });
  if (commandName === 'memory-shared-context') return command(flags, '/agent-link/v1/shared-memory', { operation: 'recall', shareId: requireFlag(flags, 'share'), maxBytes: memoryContextBytes(flags), ...(flags.cursor === undefined ? {} : { cursor: requireFlag(flags, 'cursor') }) });
  if (['skill-create', 'skill-revise', 'skill-retire'].includes(commandName)) return command(flags, '/agent-link/v1/skills', { ...JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')), operation: commandName.slice('skill-'.length) });
  if (commandName === 'tasks') return command(flags, '/agent-link/v1/tasks', { operation: 'list', ...(flags.after ? { after: flags.after } : {}), ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}) });
  if (['task-get', 'task-run', 'task-cancel'].includes(commandName)) return command(flags, '/agent-link/v1/tasks', { operation: commandName.slice('task-'.length), taskId: requireFlag(flags, 'id') });
  if (['task-create', 'task-update'].includes(commandName)) return command(flags, '/agent-link/v1/tasks', { ...JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')), operation: commandName.slice('task-'.length) });
  if (commandName === 'skills') return command(flags, '/agent-link/v1/skills', { operation: 'list', limit: skillLimit(flags), ...(flags.after === undefined ? {} : { after: requireFlag(flags, 'after') }) });
  if (commandName === 'skill') return command(flags, '/agent-link/v1/skills', { operation: 'get', skillId: requireFlag(flags, 'id'), depth: skillDepth(flags), ...skillRevision(flags), ...(flags.limit === undefined ? {} : { limit: skillLimit(flags) }) });
  if (commandName === 'room-reply') return command(flags, '/agent-link/v1/rooms/reply', { roomId:requireFlag(flags,'room'), eventId:requireFlag(flags,'event'), text:requireFlag(flags,'text') });
  if (commandName === 'memory-search') return command(flags, '/agent-link/v1/memory-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic-search', arguments: { query: requireFlag(flags, 'query'), limit: Number(flags.limit || 5) } } });
  if (commandName === 'hexispace-profiles') return command(flags, '/agent-link/v1/hexispace/profiles', null, 'GET');
  if (commandName === 'hexispace-profile') return command(flags, '/agent-link/v1/hexispace/profile', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-hexipets') return command(flags, '/agent-link/v1/hexispace/hexipets', { profileId: requireFlag(flags, 'profile') });
  if (commandName === 'hexispace-hexipet-equip') return command(flags, '/agent-link/v1/hexispace/hexipet/equip', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-hexipet-unequip') return command(flags, '/agent-link/v1/hexispace/hexipet/unequip', { profileId: requireFlag(flags, 'profile') });
  if (commandName === 'hexispace-hexipet-outfit') return command(flags, '/agent-link/v1/hexispace/hexipet/outfit', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-posts') return command(flags, '/agent-link/v1/hexispace/posts', { profileId: requireFlag(flags, 'profile') });
  if (commandName === 'hexispace-post') return command(flags, '/agent-link/v1/hexispace/post', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-comments') return command(flags, '/agent-link/v1/hexispace/comments', { profileId: requireFlag(flags, 'profile'), postId: requireFlag(flags, 'post') });
  if (commandName === 'hexispace-comment') return command(flags, '/agent-link/v1/hexispace/comment', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-friendships') return command(flags, '/agent-link/v1/hexispace/friendships', { profileId: requireFlag(flags, 'profile') });
  if (commandName === 'hexispace-friend-request') return command(flags, '/agent-link/v1/hexispace/friendship/request', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-friend-respond') return command(flags, '/agent-link/v1/hexispace/friendship/respond', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-relationships') return command(flags, '/agent-link/v1/hexispace/relationships', { profileId: requireFlag(flags, 'profile') });
  if (commandName === 'hexispace-relationship-request') return command(flags, '/agent-link/v1/hexispace/relationship/request', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-relationship-respond') return command(flags, '/agent-link/v1/hexispace/relationship/respond', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'hexispace-reaction') return command(flags, '/agent-link/v1/hexispace/reaction', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'tokens') return command(flags, '/agent-link/v1/tokens', { origin: flags.origin === 'ilands' ? 'ilands' : 'hexigrid', before: Number(requireFlag(flags, 'before')), after: Number(requireFlag(flags, 'after')), unit: String(flags.unit || ''), note: String(flags.note || '') });
  if (commandName === 'harness') return command(flags, '/agent-link/v1/harness-jobs', { clientJobId: `job-${crypto.randomUUID()}`, prompt: requireFlag(flags, 'text'), approved: flags.approved === true });
  if (commandName === 'job') return command(flags, `/agent-link/v1/harness-jobs/${encodeURIComponent(requireFlag(flags, 'job'))}`, null, 'GET');
  if (commandName === 'cancel-job') return command(flags, `/agent-link/v1/harness-jobs/${encodeURIComponent(requireFlag(flags, 'job'))}/cancel`, {});
  if (commandName === 'desktop-frame') return desktopFrame(flags);
  if (commandName === 'desktop-media') return desktopMedia(flags);
  if (commandName === 'camera-snapshot') return cameraSnapshot(flags);
  if (commandName === 'desktop-input') return command(flags, '/agent-link/v1/desktop/input', { input: JSON.parse(requireFlag(flags, 'json')) });
  if (commandName === 'desktop-uia-inspect') return command(flags, '/agent-link/v1/desktop/uia-inspect', {});
  if (commandName === 'desktop-uia-act') return command(flags, '/agent-link/v1/desktop/uia-act', { action: JSON.parse(requireFlag(flags, 'json')) });
  if (commandName === 'desktop-start') return command(flags, '/agent-link/v1/desktop/start', {});
  if (commandName === 'desktop-stop') return command(flags, '/agent-link/v1/desktop/stop', {});
  if (commandName === 'desktop-speaker') return command(flags, '/agent-link/v1/desktop/speaker', JSON.parse(requireFlag(flags, 'json')));
  if (commandName === 'workspace-list') return command(flags, '/agent-link/v1/workspace/list', { path: flags.path || '.' });
  if (commandName === 'workspace-read') {
    const { client } = await openSaved(flags);
    try {
      const response = await client.linkRequest('/agent-link/v1/workspace/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: requireFlag(flags, 'path') } });
      if (!response.ok) throw new Error(response.body?.error || `HexiGrid returned HTTP ${response.status}.`);
      const result = response.body;
      if (flags.output) {
        await fs.writeFile(String(flags.output), result.text, { encoding: 'utf8', mode: 0o600 });
        output({ ok: true, result: { ...result, text: undefined, savedTo: String(flags.output) } });
      } else output({ ok: true, result: { ...result, text: undefined, notice: 'File content omitted. Pass --output <local-file> when the text is needed.' } });
    } finally { await client.close(); }
    return;
  }
  if (commandName === 'workspace-write') {
    if (flags['create-only'] !== true && (typeof flags['expected-sha256'] !== 'string' || !/^[a-f0-9]{64}$/i.test(flags['expected-sha256']))) throw new Error('For a new file use --create-only. To replace an existing file, read it with workspace-read and pass --expected-sha256 <existing-file-digest>. Use --file <local-UTF8-file> for the new contents.');
    const body = { path: requireFlag(flags, 'path'), text: await fs.readFile(requireFlag(flags, 'file'), 'utf8') };
    if (flags['create-only'] === true) body.createOnly = true;
    else body.expectedSha256 = requireFlag(flags, 'expected-sha256');
    return command(flags, '/agent-link/v1/workspace/write', body);
  }
  if (commandName === 'owner-list') return command(flags, '/agent-link/v1/owner/fs/list', { path: requireFlag(flags, 'path') });
  if (commandName === 'owner-read') {
    const { client } = await openSaved(flags);
    const outputPath = requireFlag(flags, 'output');
    const file = await fs.open(outputPath, 'wx', 0o600);
    try {
      let offset = 0; let size; let modifiedAt; let chunks = 0;
      do {
        const response = await client.linkRequest('/agent-link/v1/owner/fs/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: requireFlag(flags, 'path'), offset, length: 512 * 1024 } });
        if (!response.ok) throw new Error(response.body?.error || `HexiGrid returned HTTP ${response.status}.`);
        const result = response.body;
        if (size === undefined) { size = result.size; modifiedAt = result.modifiedAt; }
        if (result.size !== size || result.modifiedAt !== modifiedAt || result.offset !== offset) throw new Error('The owner file changed during transfer.');
        const bytes = Buffer.from(result.data, 'base64');
        if (bytes.length !== result.bytesRead || crypto.createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw new Error('The owner file chunk failed verification.');
        let written = 0;
        while (written < bytes.length) {
          const resultWrite = await file.write(bytes, written, bytes.length - written);
          if (!resultWrite.bytesWritten) throw new Error('The local file write stalled.');
          written += resultWrite.bytesWritten;
        }
        offset += bytes.length; chunks += 1;
        if (result.eof) break;
        if (!bytes.length) throw new Error('The owner file transfer stalled.');
      } while (true);
      output({ ok: true, result: { savedTo: outputPath, size, chunks } });
    } catch (error) { await file.close(); await fs.rm(outputPath, { force: true }); throw error; }
    finally { await file.close().catch(() => {}); await client.close(); }
    return;
  }
  if (commandName === 'owner-write') {
    const { client } = await openSaved(flags);
    const file = await fs.open(requireFlag(flags, 'file'), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Choose a regular local file.');
      let offset = 0; let expectedSha256 = flags['create-only'] === true ? '' : requireFlag(flags, 'expected-sha256'); let chunks = 0;
      do {
        const buffer = Buffer.alloc(Math.min(512 * 1024, Math.max(0, info.size - offset)));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (bytesRead !== buffer.length) throw new Error('The local file changed during transfer.');
        const body = { path: requireFlag(flags, 'path'), data: buffer.toString('base64'), ...(chunks === 0 && flags['create-only'] === true ? { createOnly: true } : { expectedSha256, append: chunks > 0 }) };
        const response = await client.linkRequest('/agent-link/v1/owner/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!response.ok) throw new Error(response.body?.error || `HexiGrid returned HTTP ${response.status}.`);
        expectedSha256 = response.body.sha256; offset += bytesRead; chunks += 1;
        if (offset >= info.size) break;
      } while (true);
      output({ ok: true, result: { path: requireFlag(flags, 'path'), size: offset, chunks, sha256: expectedSha256 } });
    } finally { await file.close(); await client.close(); }
    return;
  }
  if (commandName === 'owner-exec') return command(flags, '/agent-link/v1/owner/exec', JSON.parse(await fs.readFile(requireFlag(flags, 'file'), 'utf8')));
  if (commandName === 'voice-call-status') return command(flags, '/agent-link/v1/voice-call', null, 'GET');
  if (commandName === 'voice-call-answer') return command(flags, '/agent-link/v1/voice-call/answer', {});
  if (commandName === 'voice-call-initiate') return command(flags, '/agent-link/v1/voice-call/initiate', {});
  if (commandName === 'voice-call-end') return command(flags, '/agent-link/v1/voice-call/end', {});
  if (commandName === 'voice-call-reply') return voiceCallReply(flags);
  if (commandName === 'voice-call-media') return voiceCallMedia(flags);
  if (commandName === 'voice-call-probe') return voiceCallProbe(flags);
  if (commandName === 'set-origin') {
    const origin = normalizeCompanionRelayOrigin(requireFlag(flags, 'origin'));
    const record = await readConfig(requireFlag(flags, 'connection')); record.origin = origin; delete record.baseUrl; await writeConfig(record); output({ ok: true, connectionId: record.connectionId, origin: record.origin }); return;
  }
  if (commandName === 'forget') {
    const record = await readConfig(requireFlag(flags, 'connection'));
    const aliases = record.storage === 'platform-vault' ? [recordAlias(record), recordRoutingAlias(record)] : record.storage ? [] : [recordAlias(record)];
    for (const alias of aliases) {
      try { secretCli(['revoke', `--alias=${alias}`]); }
      catch (error) { if (record.storage === 'platform-vault' || error.code !== 'SECRET_STORE_UNAVAILABLE') throw error; }
    }
    await fs.rm(vaultPath(recordAlias(record)), { force: true });
    await fs.rm(configPath(record.connectionId), { force: true });
    output({ ok: true, forgotten: record.connectionId }); return;
  }
  output({ ok: false, error: 'Commands: request, storage-check, storage-status, pair, status, orientation, watch, listen, events, avatar-read, avatar-update, avatar-portrait, avatar-portrait-read, send, room-reply, codex-chats, codex-projects, codex-chat-create, history, ask, heartbeat, capabilities, capabilities-set, identity, tokens, continuity, continuity-request, continuity-request-status, memory-propose (memory-append legacy alias), memory-correction-propose, memory-owner-correction-propose, memory-read, memory-get, memory-owner-notes, memory-owner-note, memory-scopes, memory-select, memory-clear, memory-context, memory-feedback, memory-entity, memory-shares, memory-shared-context, memory-search, skills, skill, skill-create, skill-revise, skill-retire, tasks, task-get, task-create, task-update, task-run, task-cancel, workspace-list, workspace-read, workspace-write, owner-list, owner-read, owner-write, owner-exec, hexispace-profiles, hexispace-profile, hexispace-hexipets, hexispace-hexipet-equip, hexispace-hexipet-unequip, hexispace-hexipet-outfit, hexispace-posts, hexispace-post, hexispace-comments, hexispace-friendships, hexispace-friend-request, hexispace-friend-respond, hexispace-relationships, hexispace-relationship-request, hexispace-relationship-respond, hexispace-reaction, harness, job, cancel-job, desktop-frame, desktop-media, camera-snapshot, desktop-input, desktop-uia-inspect, desktop-uia-act, desktop-start, desktop-stop, desktop-speaker, voice-call-status, voice-call-initiate, voice-call-answer, voice-call-media, voice-call-end, voice-call-reply, voice-call-probe, set-origin, forget.' });
}

export { checkStorage };

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) main().catch((error) => {
  if (process.argv[2] === 'storage-check') output({ ok: false, code: error.code || 'STORAGE_CHECK_FAILED', stage: error.stage || 'storage-setup', operation: error.operation, exitCode: error.exitCode, helperErrorCode: error.helperErrorCode, signal: error.signal, error: error.message, invitationUsed: false });
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
