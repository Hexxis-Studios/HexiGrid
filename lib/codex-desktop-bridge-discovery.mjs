import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const PIPE = /^\\\\\.\\pipe\\codex-(?:app-tools|browser-use)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Find only Codex desktop pipes whose server process passed the Windows signature check. */
export async function discoverCodexDesktopPipes({ projectRoot, exec = execFileAsync } = {}) {
  if (process.platform !== 'win32') return [];
  const script = path.join(projectRoot, 'scripts', 'Find-CodexDesktopBridge.ps1');
  const systemModules = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
    { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024, env: { ...process.env, PSModulePath: systemModules } });
  const values = JSON.parse(stdout.trim());
  if (!Array.isArray(values)) throw new Error('The Codex desktop bridge discovery response is invalid.');
  return [...new Set(values.filter((value) => typeof value === 'string' && PIPE.test(value)))].slice(0, 16);
}

/** Verify a candidate with a read-only Codex app tool before trusting it for Link traffic. */
export async function resolveCodexDesktopEnvironment({ projectRoot, sourceEnv = process.env, probe, discover = discoverCodexDesktopPipes } = {}) {
  if (typeof probe !== 'function') throw new Error('A Codex desktop bridge probe is required.');
  const inherited = String(sourceEnv.CODEX_APP_TOOLS_PIPE_PATH || '');
  if (PIPE.test(inherited)) {
    const env = { ...sourceEnv, CODEX_APP_TOOLS_PIPE_PATH: inherited };
    try { if (await probe(env)) return env; } catch { /* Discover a current desktop pipe. */ }
  }
  let found;
  try { found = await discover({ projectRoot }); }
  catch { throw new Error('The Codex desktop bridge is unavailable.'); }
  const candidates = [...new Set(found.filter((value) => PIPE.test(value)))].sort((a, b) => Number(b.includes('codex-app-tools-')) - Number(a.includes('codex-app-tools-')));
  for (const pipePath of candidates) {
    const env = { ...sourceEnv, CODEX_APP_TOOLS_PIPE_PATH: pipePath };
    try { if (await probe(env)) return env; }
    catch { /* Try another verified local desktop pipe. */ }
  }
  throw new Error('The Codex desktop bridge is unavailable.');
}
