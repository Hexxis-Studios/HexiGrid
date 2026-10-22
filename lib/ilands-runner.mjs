import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const jobs = new Map();
const jobProcesses = new Map();
const daemons = new Map();

export function supportedRunnerHarnesses(platform = process.platform) {
  return platform === 'win32' ? ['codex', 'claude-code'] : ['codex', 'claude-code', 'openclaw', 'hermes', 'pi'];
}

export function resolveIlandsRunner(env = process.env) {
  const candidates = [
    env.ILANDS_RUNNER,
    process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ilands-runner', 'bin', 'ilands-runner.exe') : null,
    process.platform !== 'win32' ? path.join(os.homedir(), '.local', 'bin', 'ilands-runner') : null
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || '';
}

function runnerEnvironment(home) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)', 'ComSpec', 'COMSPEC', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  env.ILANDS_RUNNER_HOME = home;
  return env;
}

function readableError(stderr, fallback) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const safe = lines.find((line) => !/(token|secret|credential|devicecode|private.?key)\s*[:=]/i.test(line));
  return (safe || fallback).slice(0, 800);
}

function parseJsonLine(line) {
  try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

export function publicRunnerEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.event === 'runner_activation_created') {
    return { event: value.event, activationId: value.activationId, expiresAt: value.expiresAt };
  }
  if (value.event === 'runner_authorization_required') {
    let verificationUrlComplete;
    try {
      const candidate = new URL(value.verificationUrlComplete);
      const host = candidate.hostname.toLowerCase();
      if (candidate.protocol === 'https:' && (host === 'ilands.ai' || host.endsWith('.ilands.ai'))) verificationUrlComplete = candidate.href;
    } catch { /* omit malformed or non-iLands links */ }
    return {
      event: value.event,
      authorizationMode: value.authorizationMode,
      verificationUrlComplete,
      userCode: value.userCode,
      expiresAt: value.expiresAt,
      pollIntervalSeconds: value.pollIntervalSeconds
    };
  }
  if (typeof value.status === 'string' || value.ok !== undefined) {
    return {
      event: 'runner_complete',
      ok: value.ok === true,
      status: value.status || (value.ok ? 'ready' : 'failed'),
      agentId: typeof value.agentId === 'string' ? value.agentId : undefined,
      harness: typeof value.harness === 'string' ? value.harness : undefined,
      serviceError: typeof value.serviceError === 'string' ? value.serviceError.slice(0, 800) : undefined,
      appDownload: value.appDownload && typeof value.appDownload === 'object' ? value.appDownload : undefined
    };
  }
  return null;
}

export function runRunner(home, args, { timeoutMs = 20000, input = '', runner = resolveIlandsRunner() } = {}) {
  return new Promise((resolve, reject) => {
    if (!runner || !existsSync(runner)) return reject(new Error('The official iLands Runner is not installed on this computer.'));
    const child = spawn(runner, args, { windowsHide: true, shell: false, cwd: home, env: runnerEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { child.kill(); settled = true; reject(new Error('The iLands Runner command timed out.')); } }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('The official iLands Runner could not be started.')); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) reject(new Error(readableError(stderr, `iLands Runner exited with code ${code}.`)));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function cleanServiceStatus(raw) {
  const root = parseJsonLine(raw.trim());
  const status = root?.status && typeof root.status === 'object' ? root.status : root;
  if (!status) throw new Error('The iLands Runner returned unreadable status data.');
  return {
    installed: status.installed === true,
    loaded: status.loaded === true,
    process: typeof status.process === 'string' ? status.process : 'unknown',
    connection: typeof status.connection === 'string' ? status.connection : 'unknown',
    agentId: typeof status.agentId === 'string' ? status.agentId : null,
    harness: typeof status.harness === 'string' ? status.harness : null,
    daemonState: typeof status.daemonState === 'string' ? status.daemonState : null,
    runnerAuthReason: typeof status.runnerAuthReason === 'string' ? status.runnerAuthReason : null,
    lastHeartbeatAt: status.lastHeartbeatAt || null,
    lastRunId: status.lastRunId || null,
    lastRunStatus: status.lastRunStatus || null,
    lastError: typeof status.lastError === 'string' ? status.lastError.slice(0, 800) : null,
    checkedAt: new Date().toISOString()
  };
}

export async function runnerProfileStatus(profile) {
  try {
    const result = await runRunner(profile.home, ['service', 'status', '--output', 'json'], { timeoutMs: 15000 });
    return { available: true, ...cleanServiceStatus(result.stdout) };
  } catch (error) {
    return { available: Boolean(resolveIlandsRunner() && existsSync(resolveIlandsRunner())), installed: false, connection: 'unknown', error: error.message, checkedAt: new Date().toISOString() };
  }
}

export function startRunnerJob(profile, action = 'bind') {
  if (action !== 'bind' && action !== 'prepare') throw new Error('Unsupported Runner job.');
  const runner = resolveIlandsRunner();
  if (!runner || !existsSync(runner)) throw new Error('Install the official iLands Runner before connecting an account.');
  if (jobs.has(profile.id) && jobs.get(profile.id).state === 'running') throw new Error('This Runner profile already has an active setup job.');
  const job = { id: `runner-job-${crypto.randomUUID().slice(0, 8)}`, profileId: profile.id, action, state: 'running', events: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
  jobs.set(profile.id, job);
  const args = action === 'bind'
    ? ['bind', 'activate', '--harness', profile.harness, '--timeout-seconds', '1800']
    : ['harness', 'prepare', '--harness', profile.harness];
  const child = spawn(runner, args, { windowsHide: true, shell: false, cwd: profile.home, env: runnerEnvironment(profile.home), stdio: ['ignore', 'pipe', 'pipe'] });
  jobProcesses.set(profile.id, child);
  let pending = ''; let stderr = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
    for (const line of lines) { const event = publicRunnerEvent(parseJsonLine(line)); if (event) job.events.push(event); }
    job.events = job.events.slice(-30);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', () => { jobProcesses.delete(profile.id); job.state = 'failed'; job.error = 'The iLands Runner could not be started.'; job.finishedAt = new Date().toISOString(); });
  child.on('close', (code) => {
    jobProcesses.delete(profile.id);
    const event = publicRunnerEvent(parseJsonLine(pending)); if (event) job.events.push(event);
    job.state = code === 0 ? 'complete' : 'failed';
    job.error = code === 0 ? null : readableError(stderr, `iLands Runner exited with code ${code}.`);
    job.finishedAt = new Date().toISOString();
  });
  return publicRunnerJob(job);
}

export function publicRunnerJob(jobOrProfileId) {
  const job = typeof jobOrProfileId === 'string' ? jobs.get(jobOrProfileId) : jobOrProfileId;
  return job ? structuredClone(job) : null;
}

export function stopRunnerJob(profileId) {
  const child = jobProcesses.get(profileId);
  const job = jobs.get(profileId);
  if (!child || !job || job.state !== 'running') return { stopped: false };
  child.kill();
  jobProcesses.delete(profileId);
  job.state = 'cancelled'; job.error = 'Stopped by the owner.'; job.finishedAt = new Date().toISOString();
  return { stopped: true };
}

export function stopAllRunnerJobs() {
  let stopped = 0;
  for (const profileId of jobProcesses.keys()) if (stopRunnerJob(profileId).stopped) stopped += 1;
  return stopped;
}

export function startManagedRunner(profile) {
  if (!profile.agentId) throw new Error('Connect this profile before starting its Runner.');
  const current = daemons.get(profile.id);
  if (current && !current.exited) return { running: true, pid: current.pid, startedAt: current.startedAt };
  const runner = resolveIlandsRunner();
  if (!runner || !existsSync(runner)) throw new Error('The official iLands Runner is not installed.');
  const child = spawn(runner, ['daemon', '--agent-id', profile.agentId, '--harness', profile.harness], {
    windowsHide: true, shell: false, cwd: profile.home, env: runnerEnvironment(profile.home), stdio: ['ignore', 'ignore', 'pipe']
  });
  const record = { child, pid: child.pid, startedAt: new Date().toISOString(), exited: false, lastError: null };
  child.stderr.on('data', (chunk) => { record.lastError = readableError(chunk.toString(), 'Runner reported an error.'); });
  child.on('error', () => { record.exited = true; record.lastError = 'The iLands Runner could not be started.'; });
  child.on('close', () => { record.exited = true; });
  daemons.set(profile.id, record);
  return { running: true, pid: record.pid, startedAt: record.startedAt };
}

export function managedRunnerStatus(profileId) {
  const record = daemons.get(profileId);
  return record && !record.exited
    ? { running: true, pid: record.pid, startedAt: record.startedAt, lastError: record.lastError }
    : { running: false, lastError: record?.lastError || null };
}

export function stopManagedRunner(profileId) {
  const record = daemons.get(profileId);
  if (!record || record.exited) return { running: false };
  record.child.kill(); record.exited = true;
  return { running: false };
}

export function stopAllManagedRunners() {
  let stopped = 0;
  for (const profileId of daemons.keys()) {
    if (managedRunnerStatus(profileId).running) stopped += 1;
    stopManagedRunner(profileId);
  }
  return stopped;
}
