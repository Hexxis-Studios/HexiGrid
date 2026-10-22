import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { access, readFile, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { validateMcpCallToolResult } from './mcp-result.mjs';
import { readMcpHttpResponse } from './mcp-http-response.mjs';

const MAX_TOOLS = 128, MAX_BYTES = 1024 * 1024, MAX_SCHEMA = 65536, RPC_MS = 30000, SESSION_MS = 45000;
const PROTOCOL = '2025-06-18', TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (plain(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`; return JSON.stringify(v); }
const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonical(v)).digest('hex');

function safeArg(value) { const text = String(value); if (text.length > 2000 || /[\0\r\n]/.test(text)) throw new Error('MCP command arguments cannot contain line breaks or NUL characters.'); return text; }
function redact(value, secrets = {}) { let out = String(value || ''); for (const secret of Object.values(secrets)) if (typeof secret === 'string' && secret.length >= 3) out = out.split(secret).join('[redacted]'); return out; }
function diagnostic(value, secrets, fallback) { const lines = String(value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean); const safe = lines.find((v) => !/(token|secret|credential|password|private.?key|authorization)\s*[:=]/i.test(v)); return redact((safe || fallback).slice(0, 1000), secrets); }

function schema(value, depth = 0) {
  if (!plain(value) || depth > 6 || Buffer.byteLength(JSON.stringify(value)) > MAX_SCHEMA) throw new Error('An MCP tool published an invalid or oversized input schema.');
  const allowed = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']); const type = allowed.has(value.type) ? value.type : depth === 0 ? 'object' : null;
  if (!type) throw new Error('An MCP tool schema contains an unsupported type.');
  const result = { type }; if (typeof value.title === 'string') result.title = value.title.slice(0, 100); if (typeof value.description === 'string') result.description = value.description.slice(0, 1000);
  if (Array.isArray(value.enum) && value.enum.length <= 100) result.enum = structuredClone(value.enum);
  if (type === 'object') { result.properties = {}; for (const [name, child] of Object.entries(value.properties || {}).slice(0, 50)) if (/^[A-Za-z0-9_-]{1,80}$/.test(name)) result.properties[name] = schema(child, depth + 1); result.required = Array.isArray(value.required) ? [...new Set(value.required.filter((name) => result.properties[name]))].slice(0, 50) : []; result.additionalProperties = value.additionalProperties === true; }
  if (type === 'array') { result.items = schema(value.items || { type: 'string' }, depth + 1); result.maxItems = Math.min(100, Math.max(0, Number(value.maxItems) || 100)); }
  if (type === 'string') result.maxLength = Math.min(100000, Math.max(0, Number(value.maxLength) || 12000));
  if (['number', 'integer'].includes(type)) { if (Number.isFinite(value.minimum)) result.minimum = value.minimum; if (Number.isFinite(value.maximum)) result.maximum = value.maximum; }
  return result;
}

export function validateMcpValue(spec, value, label = 'Tool input', depth = 0) {
  if (depth > 8) throw new Error(`${label} is nested too deeply.`); const type = spec?.type || 'object';
  const valid = type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? plain(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (!valid) throw new Error(`${label} must be ${type === 'integer' ? 'a whole number' : type}.`); if (spec.enum && !spec.enum.some((v) => canonical(v) === canonical(value))) throw new Error(`${label} is not an allowed value.`);
  if (type === 'string' && value.length > (spec.maxLength ?? 12000)) throw new Error(`${label} is too long.`); if (['number', 'integer'].includes(type)) { if (spec.minimum !== undefined && value < spec.minimum) throw new Error(`${label} is below the minimum.`); if (spec.maximum !== undefined && value > spec.maximum) throw new Error(`${label} is above the maximum.`); }
  if (type === 'array') { if (value.length > (spec.maxItems ?? 100)) throw new Error(`${label} has too many items.`); value.forEach((item, i) => validateMcpValue(spec.items, item, `${label}[${i}]`, depth + 1)); }
  if (type === 'object') { for (const required of spec.required || []) if (!(required in value)) throw new Error(`${spec.properties?.[required]?.title || required} is required.`); for (const [name, child] of Object.entries(value)) { if (!spec.properties?.[name]) { if (!spec.additionalProperties) throw new Error(`${label} contains an undeclared field: ${name}.`); } else validateMcpValue(spec.properties[name], child, spec.properties[name].title || name, depth + 1); } }
  return value;
}

function normalizeTools(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) throw new Error(`MCP servers may publish at most ${MAX_TOOLS} tools.`); const names = new Set();
  const tools = raw.map((item) => { const name = String(item?.name || ''); if (!TOOL_NAME.test(name) || names.has(name)) throw new Error('The MCP server published an invalid or duplicate tool name.'); names.add(name); const normalized = { name, description: String(item?.description || '').slice(0, 2000), inputSchema: schema(item?.inputSchema || { type: 'object', properties: {}, additionalProperties: false }) }; return { ...normalized, digest: hash(normalized) }; }).sort((a, b) => a.name.localeCompare(b.name));
  return { tools, toolSetDigest: hash(tools.map(({ name, digest }) => ({ name, digest }))) };
}
function bounded(value) { let text; try { text = JSON.stringify(value); } catch { throw new Error('The MCP server returned a non-serializable result.'); } if (typeof text !== 'string') throw new Error('The MCP server returned a non-serializable result.'); if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('The MCP server result exceeded the safe output limit.'); return JSON.parse(text); }

async function executable(command) {
  const raw = String(command || '').trim(); if (!raw || raw.length > 1000 || /[\0\r\n]/.test(raw) || /\.(cmd|bat|ps1)$/i.test(raw)) throw new Error('MCP programs must be direct executables, not shell scripts.');
  const candidates = path.isAbsolute(raw) ? [raw] : (process.env.PATH || process.env.Path || '').split(path.delimiter).flatMap((folder) => process.platform === 'win32' ? [path.join(folder, raw), path.join(folder, `${raw}.exe`)] : [path.join(folder, raw)]);
  for (const candidate of candidates) try { await access(candidate); const resolved = await realpath(candidate); return { path: resolved, digest: hash(await readFile(resolved)) }; } catch {}
  throw new Error('The MCP server executable could not be resolved to a readable file.');
}

function isolationError(message) { const error = new Error(message); error.code = 'MCP_ISOLATION_UNAVAILABLE'; error.status = 503; return error; }

async function runBounded(command, args, { timeoutMs = 10000, env = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, settled = false;
    const abort = () => finish(new Error('The MCP request was cancelled.'));
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!child.killed) child.kill(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(isolationError('Podman did not respond to the isolation check in time.')), timeoutMs);
    if (signal?.aborted) { finish(new Error('The MCP request was cancelled.')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(isolationError('Podman is not installed or could not be started. Install rootless Podman before enabling local MCP servers.')));
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 65536) return finish(isolationError('Podman returned an oversized isolation response.')); stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (Buffer.byteLength(stderr) < 65536) stderr += chunk.toString().slice(0, 65536 - Buffer.byteLength(stderr)); });
    child.on('close', (code) => code === 0 ? finish(null, stdout.trim()) : finish(isolationError(diagnostic(stderr, {}, 'Podman rejected the isolation request.'))));
  });
}

async function podmanRuntime(server, options = {}) {
  const configured = options.podmanCommand || { command: process.env.HEXIGRID_PODMAN || 'podman', prefixArgs: [] };
  const podman = await executable(configured.command).catch(() => { throw isolationError('Podman is not installed. Install rootless Podman before adding a local MCP server, or use a secure HTTPS MCP server.'); });
  const prefixArgs = Array.isArray(configured.prefixArgs) ? configured.prefixArgs.map(safeArg) : [];
  const cleanEnv = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const infoText = await runBounded(podman.path, [...prefixArgs, 'info', '--format', 'json'], { env: cleanEnv, signal: options.signal });
  let info; try { info = JSON.parse(infoText); } catch { throw isolationError('Podman returned an unreadable security status.'); }
  const rootless = info?.host?.security?.rootless ?? info?.Host?.Security?.Rootless ?? info?.host?.rootless ?? info?.Host?.Rootless;
  if (rootless !== true) throw isolationError('Podman must run rootless before HexiGrid can start local MCP servers.');
  const inspectedText = await runBounded(podman.path, [...prefixArgs, 'image', 'inspect', server.image, '--format', 'json'], { env: cleanEnv, signal: options.signal });
  let inspected; try { inspected = JSON.parse(inspectedText); } catch { throw isolationError('Podman could not verify the pinned MCP image. Pull the exact digest-pinned image first.'); }
  const records = Array.isArray(inspected) ? inspected : [inspected];
  const digests = records.flatMap((item) => [...(item?.RepoDigests || item?.repoDigests || []), item?.Digest || item?.digest || '']);
  const expectedDigest = server.image.slice(server.image.lastIndexOf('@') + 1);
  if (!digests.some((value) => String(value).endsWith(`@${expectedDigest}`) || String(value) === expectedDigest)) throw isolationError('The local Podman image does not match the reviewed digest. Pull the exact image and re-check it.');
  return { path: podman.path, prefixArgs, digest: hash({ podman: podman.digest, image: server.image, command: server.command || '', args: server.args || [], workspaceAccess: server.workspaceAccess || 'none' }), cleanEnv };
}

function podmanRunArgs(server, runtime, secretNames) {
  const args = [...runtime.prefixArgs, 'run', '--rm', '--interactive', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1', '--user=65532:65532', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864'];
  if (server.workspaceAccess !== 'none') {
    if (!server.workspaceRoot || !path.isAbsolute(server.workspaceRoot)) throw isolationError('HexiGrid could not resolve the private workspace mount safely.');
    args.push(`--volume=${server.workspaceRoot}:/workspace:${server.workspaceAccess === 'write' ? 'rw' : 'ro'}`);
  }
  for (const name of secretNames) if (/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name)) args.push('--env', name);
  args.push(server.image);
  if (server.command) args.push(server.command);
  args.push(...(server.args || []).slice(0, 100).map(safeArg));
  return args;
}
function privateIp(address) { if (net.isIPv4(address)) { const p = address.split('.').map(Number); return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); } const v = address.toLowerCase().split('%')[0]; return v === '::' || v === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(v) || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.'); }
async function safeDestination(server) { const url = new URL(server.url), local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname); const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => { throw new Error('The MCP server address could not be resolved safely.'); }); if (!addresses.length) throw new Error('The MCP server address did not resolve.'); if (local && server.local === true) { if (addresses.some(({ address }) => !privateIp(address))) throw new Error('The local MCP name resolved outside this device.'); } else if (addresses.some(({ address }) => privateIp(address))) throw new Error('Remote MCP servers cannot resolve to private, loopback, link-local, or reserved networks.'); return addresses.sort((a, b) => a.family - b.family)[0]; }

function parseRpc(text, id) { let body; try { body = JSON.parse(text); } catch { const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter((line) => line && line !== '[DONE]').pop(); try { body = JSON.parse(data); } catch { throw new Error('The MCP server returned invalid JSON-RPC data.'); } } if (!plain(body) || body.jsonrpc !== '2.0' || (id !== undefined && body.id !== id)) throw new Error('The MCP server returned a mismatched JSON-RPC response.'); return body; }
function verifyServerIdentity(server, identity) { if (server.serverIdentity && identity !== server.serverIdentity) throw Object.assign(new Error('The MCP server identity changed after review. Re-check it before use.'), { code: 'MCP_IDENTITY_CHANGED' }); }
function verifyInit(value) { if (!plain(value) || value.protocolVersion !== PROTOCOL || !plain(value.serverInfo) || !String(value.serverInfo.name || '').trim()) throw new Error('The MCP server returned an invalid or unsupported initialization response.'); }
const serverIdentity = (value) => hash({ protocolVersion: value.protocolVersion, name: String(value.serverInfo.name).slice(0, 200), version: String(value.serverInfo.version || '').slice(0, 100) });

async function httpRpc(server, token, method, params, id, sessionId, signal) {
  const destination = await safeDestination(server); const url = new URL(server.url); const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }); if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('The MCP request exceeded the safe input limit.');
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId) ? { 'mcp-session-id': sessionId } : {}) };
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(RPC_MS)]);
  const response = await new Promise((resolve, reject) => { const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', headers, signal: requestSignal, lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family), ...(url.protocol === 'https:' ? { servername: url.hostname } : {}) }, resolve); request.on('error', (error) => { if (['AbortError', 'TimeoutError'].includes(error?.name) || signal.aborted) reject(new Error('The MCP server timed out or was cancelled.')); else reject(new Error('The MCP server could not be reached.')); }); request.end(body); });
  const status = response.statusCode || 0; if ([300,301,302,303,307,308].includes(status)) { response.resume(); throw new Error('MCP redirects are blocked.'); } if (status < 200 || status >= 300) { response.resume(); throw new Error([401, 403].includes(status) ? 'The MCP server rejected its protected key.' : `The MCP server returned HTTP ${status}.`); }
  if (Number(response.headers['content-length'] || 0) > MAX_BYTES) { response.destroy(); throw new Error('The MCP server response exceeded the safe output limit.'); }
  const rpc = await readMcpHttpResponse(response, id, { maxBytes: MAX_BYTES, signal: requestSignal }); const nextSession = typeof response.headers['mcp-session-id'] === 'string' && /^[\x21-\x7e]{1,256}$/.test(response.headers['mcp-session-id']) ? response.headers['mcp-session-id'] : sessionId; if (id === undefined) return { result: null, sessionId: nextSession };
  if (rpc.error) throw new Error(redact(String(rpc.error.message || 'The MCP server reported an error.').slice(0, 1000), { bearer: token })); return { result: bounded(rpc.result), sessionId: nextSession };
}

async function useHttp(server, secrets, action, signal) { const init = await httpRpc(server, secrets?.bearer || '', 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'HexiGrid', version: '0.1.0' } }, 1, '', signal); verifyInit(init.result); verifyServerIdentity(server, serverIdentity(init.result)); await httpRpc(server, secrets?.bearer || '', 'notifications/initialized', undefined, undefined, init.sessionId, signal); let id = 2; return { value: await action((method, params) => httpRpc(server, secrets?.bearer || '', method, params, id++, init.sessionId, signal)), serverIdentity: serverIdentity(init.result) }; }

async function useStdio(server, secrets, action, signal, options = {}) {
  const runtime = await podmanRuntime(server, options);
  const launchDigest = runtime.digest; if (server.executableDigest && launchDigest !== server.executableDigest) { const e = new Error('The Podman runtime, image, or container command changed after review. Re-check it before use.'); e.code = 'MCP_IDENTITY_CHANGED'; throw e; }
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.path, podmanRunArgs(server, runtime, Object.keys(secrets || {})), { windowsHide: true, shell: false, env: { ...runtime.cleanEnv, ...secrets }, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', stderr = '', output = 0, nextId = 1, settled = false, identity = ''; const waits = new Map(); const sessionTimer = setTimeout(() => finish(new Error('The MCP server session timed out.')), SESSION_MS); const abort = () => finish(new Error('The MCP request was cancelled.')); signal.addEventListener('abort', abort, { once: true });
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(sessionTimer); signal.removeEventListener('abort', abort); child.kill(); for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(error || new Error('The MCP server closed.')); } error ? reject(error) : resolve({ value, serverIdentity: identity, executableDigest: launchDigest, executablePath: runtime.path }); }
    function send(method, params, notification = false) { if (settled) return Promise.reject(new Error('The MCP server is closed.')); const id = notification ? undefined : nextId++, text = `${JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) })}\n`; if (Buffer.byteLength(text) > MAX_BYTES) return Promise.reject(new Error('The MCP request exceeded the safe input limit.')); child.stdin.write(text); if (notification) return Promise.resolve(); return new Promise((accept, deny) => { const timer = setTimeout(() => { waits.delete(id); deny(new Error('The MCP server request timed out.')); }, RPC_MS); waits.set(id, { accept, reject: deny, timer }); }); }
    child.stdout.on('data', (chunk) => { output += chunk.length; if (output > MAX_BYTES * 2) return finish(new Error('The MCP server exceeded the safe output limit.')); pending += chunk; if (Buffer.byteLength(pending) > MAX_BYTES) return finish(new Error('The MCP server sent an oversized message.')); const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const line of lines) { if (!line) continue; let message; try { message = parseRpc(line); } catch (e) { return finish(e); } const wait = waits.get(message.id); if (!wait) continue; waits.delete(message.id); clearTimeout(wait.timer); message.error ? wait.reject(new Error(redact(String(message.error.message || 'MCP server error.').slice(0, 1000), secrets))) : wait.accept(bounded(message.result)); } });
    child.stderr.on('data', (chunk) => { if (Buffer.byteLength(stderr) < 65536) stderr += chunk.toString().slice(0, 65536 - Buffer.byteLength(stderr)); }); child.stdin.on('error', () => { if (!settled) finish(new Error('The MCP server input stream closed unexpectedly.')); }); child.on('error', () => finish(new Error('The MCP server command could not be started.'))); child.on('close', (code) => { if (!settled) finish(new Error(diagnostic(stderr, secrets, `MCP server exited with code ${code}.`))); });
    (async () => { try { const init = await send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'HexiGrid', version: '0.1.0' } }); verifyInit(init); identity = serverIdentity(init); verifyServerIdentity(server, identity); await send('notifications/initialized', undefined, true); finish(null, await action(async (method, params) => ({ result: await send(method, params) }))); } catch (e) { finish(e); } })();
  });
}

async function withServer(server, secrets, action, options = {}) { const signal = options.signal || new AbortController().signal; const result = server.transport === 'http' ? await useHttp(server, secrets, action, signal) : await useStdio(server, secrets, action, signal, options); if (server.serverIdentity && result.serverIdentity !== server.serverIdentity) { const e = new Error('The MCP server identity changed after review. Re-check it before use.'); e.code = 'MCP_IDENTITY_CHANGED'; throw e; } return result; }
export async function discoverMcpServer(server, secrets = {}, options = {}) { const result = await withServer(server, secrets, async (rpc) => normalizeTools((await rpc('tools/list')).result?.tools), options); return { ...result.value, serverIdentity: result.serverIdentity, executableDigest: result.executableDigest || '', executablePath: result.executablePath || '' }; }
export async function callMcpTool(server, secrets, toolName, args, options = {}) { if (!options.expectedToolSetDigest || !options.expectedToolDigest) throw new Error('MCP calls require a reviewed and pinned tool manifest.'); const result = await withServer(server, secrets, async (rpc) => { const discovery = normalizeTools((await rpc('tools/list')).result?.tools); if (discovery.toolSetDigest !== options.expectedToolSetDigest) { const e = new Error('The MCP tool list changed after review. The server was disabled until you review it again.'); e.code = 'MCP_TOOL_DRIFT'; throw e; } const tool = discovery.tools.find((item) => item.name === toolName); if (!tool || tool.digest !== options.expectedToolDigest) { const e = new Error('This MCP tool changed after review. The server was disabled until you review it again.'); e.code = 'MCP_TOOL_DRIFT'; throw e; } const input = plain(args) ? args : {}; validateMcpValue(tool.inputSchema, input); await options.beforeCall?.(); return validateMcpCallToolResult((await rpc('tools/call', { name: toolName, arguments: input })).result); }, options); return result.value; }

export function validateMcpServer(input) {
  const name = String(input?.name || '').trim().slice(0, 100); if (!name) throw new Error('Give the MCP server a name.'); const transport = input.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'http') { let url; try { url = new URL(input.url); } catch { throw new Error('Enter a valid MCP server address.'); } const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Remote MCP servers require HTTPS.'); if (url.username || url.password || url.hash) throw new Error('Keep MCP credentials in the protected key field.'); if (![443, 80, 3000, 3001, 8000, 8080, 8787].includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw new Error('This MCP server uses a blocked network port.'); return { name, transport, url: url.href, local, enabled: false }; }
  const image = String(input.image || '').trim(); if (!IMAGE_REF.test(image)) throw new Error('Local MCP servers require a digest-pinned OCI image such as registry.example/server@sha256:…');
  const command = String(input.command || '').trim(); if (command.length > 1000 || /[\0\r\n]/.test(command)) throw new Error('The container command is invalid.');
  const args = Array.isArray(input.args) ? input.args.map(safeArg) : String(input.args || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean).map(safeArg);
  const workspaceAccess = ['none', 'read', 'write'].includes(input.workspaceAccess) ? input.workspaceAccess : 'none';
  return { name, transport, image, command, args, workspaceAccess, local: true, enabled: false };
}
