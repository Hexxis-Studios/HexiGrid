import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openCodeCommand } from './opencode-command.mjs';

const DEFINITIONS = Object.freeze([
  { id: 'opencode', label: 'OpenCode', env: 'OPENCODE_CLI', command: 'opencode', authArgs: ['auth', 'list'], versionArgs: ['--version'] },
  { id: 'claude-code', label: 'Claude Code', env: 'CLAUDE_CLI', command: 'claude', authArgs: ['auth', 'status', '--json'], versionArgs: ['--version'] },
  { id: 'codex', label: 'Codex', env: 'CODEX_CLI', command: 'codex', authArgs: ['login', 'status'], versionArgs: ['--version'] }
]);

const SAFE_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ComSpec', 'COMSPEC', 'LANG', 'LC_ALL'];

function commandExists(command) {
  const value = String(command || '');
  if (!value) return false;
  if (path.isAbsolute(value) || /[\\/]/.test(value)) return existsSync(value);
  const pathValue = process.env.PATH || process.env.Path || '';
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  return pathValue.split(path.delimiter).filter(Boolean).some((folder) => extensions.some((extension) => existsSync(path.join(folder, value + extension))));
}

function resolveCommand(definition) {
  const configured = process.env[definition.env];
  const npmShim = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', `${definition.command}.cmd`) : '';
  const command = configured || (npmShim && existsSync(npmShim) ? npmShim : definition.command);
  if (definition.id === 'opencode') {
    try {
      const native = openCodeCommand(command);
      return { command: native.command, prefixArgs: native.args, installed: commandExists(native.command) };
    } catch { return { command, prefixArgs: [], installed: false }; }
  }
  if (process.platform === 'win32' && /\.ps1$/i.test(command)) {
    return { command: commandExists('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe', prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', command], installed: existsSync(command) };
  }
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) return { command: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', command], installed: existsSync(command) };
  return { command, prefixArgs: [], installed: commandExists(command) };
}

export function runHarnessProcess(command, args, { cwd = process.cwd(), timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(SAFE_ENV_KEYS.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    // Harness jobs are bounded, non-interactive requests. Leaving stdin as a
    // live pipe makes Codex wait for an impossible second prompt (it reports
    // "Reading additional input from stdin...") until the job timeout. Close
    // stdin immediately while retaining captured output for the parser.
    const child = spawn(command, args, { cwd, windowsHide: true, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error('The local harness did not respond in time.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 20_000) stderr += chunk.toString(); });
    child.on('error', () => finish(reject, new Error('The local harness could not be started.')));
    child.on('close', (code) => code === 0 ? finish(resolve, { stdout, stderr }) : finish(reject, new Error('The local harness reported that it is not ready.')));
  });
}

function authenticated(id, output) {
  const plain = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!plain || /not logged|not authenticated|no credentials|0 credentials/i.test(plain)) return false;
  if (id === 'claude-code') {
    try { const value = JSON.parse(plain); return value.loggedIn === true || value.authenticated === true || value.status === 'authenticated'; } catch { return /logged in|authenticated/i.test(plain); }
  }
  if (id === 'codex') return /logged in|authenticated/i.test(plain);
  const useful = plain.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^credentials:?$/i.test(line) && !/^[-=]+$/.test(line));
  return useful.length > 0;
}

export async function detectHarnesses() {
  return Promise.all(DEFINITIONS.map(async (definition) => {
    const resolved = resolveCommand(definition);
    if (!resolved.installed) return { id: definition.id, label: definition.label, installed: false, authenticated: false, version: '' };
    let version = '';
    let isAuthenticated = false;
    try {
      const result = await runHarnessProcess(resolved.command, [...resolved.prefixArgs, ...definition.versionArgs], { timeoutMs: 8000 });
      version = result.stdout.trim().split(/\r?\n/)[0].slice(0, 100);
    } catch { /* installed commands may not expose a version */ }
    try {
      const result = await runHarnessProcess(resolved.command, [...resolved.prefixArgs, ...definition.authArgs], { timeoutMs: 12000 });
      isAuthenticated = authenticated(definition.id, `${result.stdout}\n${result.stderr}`);
    } catch { isAuthenticated = false; }
    return { id: definition.id, label: definition.label, installed: true, authenticated: isAuthenticated, version };
  }));
}

export function harnessCommand(id) {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error('Unknown local harness.');
  const resolved = resolveCommand(definition);
  if (!resolved.installed) throw new Error(`${definition.label} is not installed on this computer.`);
  return { ...resolved, id: definition.id, label: definition.label };
}

export function publicHarnessConnection(record) {
  return { id: record.id, connectedAt: record.connectedAt, enabled: record.enabled !== false };
}

export function defaultHarnessModel(id) {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition || id === 'opencode') return null;
  // The Codex CLI can inherit a stale or unsupported model from its own
  // profile. Keep the HexiGrid route stable, but pass an explicit model to
  // the CLI so linked probes and owner jobs are deterministic. Owners can
  // override this without changing the route id via CODEX_MODEL.
  const remoteModel = id === 'codex' ? (process.env.CODEX_MODEL || 'gpt-5.6-terra') : '';
  return { id: `harness:${id}:default`, label: `${definition.label} · signed-in default`, provider: definition.label, free: false, cloud: true, harnessId: id, remoteModel };
}

// OpenCode also runs configured local/keyless models. Its credential inventory
// is not a prerequisite for connecting the CLI; individual providers still
// enforce their own authentication when called. Other CLIs require sign-in.
export function harnessCanConnect(status) {
  return status?.installed === true && (status.id === 'opencode' || status.authenticated === true);
}

export function harnessDefinitions() {
  return DEFINITIONS.map(({ id, label }) => ({ id, label }));
}

function parseClaudeOutput(raw) {
  try {
    const value = JSON.parse(String(raw).trim());
    const content = String(value.result || value.text || value.message?.content || '').trim();
    if (!content) throw new Error('Claude Code returned no reply.');
    return { content, sessionId: value.session_id || null, inputTokens: value.usage?.input_tokens ?? null, outputTokens: value.usage?.output_tokens ?? null, toolReceipts: [] };
  } catch (error) {
    if (error.message === 'Claude Code returned no reply.') throw error;
    throw new Error('Claude Code returned an unreadable reply.');
  }
}

function parseCodexOutput(raw) {
  const events = String(raw).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const messages = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message').map((event) => event.item.text).filter(Boolean);
  const usage = [...events].reverse().find((event) => event.type === 'turn.completed')?.usage || {};
  if (!messages.length) throw new Error('Codex returned no reply.');
  return { content: messages.join('\n').trim(), sessionId: null, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, toolReceipts: [] };
}

export async function executeTextHarness({ id, prompt, model = '', cwd, timeoutMs = 180000, signal }) {
  const harness = harnessCommand(id);
  if (id === 'claude-code') {
    const args = [...harness.prefixArgs, '--print', prompt, '--output-format', 'json', '--permission-mode', 'plan'];
    if (model) args.push('--model', model);
    return parseClaudeOutput((await runHarnessProcess(harness.command, args, { cwd, timeoutMs, signal })).stdout);
  }
  if (id === 'codex') {
    const args = [...harness.prefixArgs, 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return parseCodexOutput((await runHarnessProcess(harness.command, args, { cwd, timeoutMs, signal })).stdout);
  }
  throw new Error('This harness requires its dedicated runtime adapter.');
}
