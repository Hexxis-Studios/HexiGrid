import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function processStartedAt(pid) {
  if (process.platform !== 'win32') return NaN;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o')) }`;
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  return Date.parse(stdout.trim());
}

export async function instanceLockOwnerAlive(record, { exists = processExists, startedAt = processStartedAt } = {}) {
  const pid = Number(record?.pid);
  if (record?.product !== 'hexigrid' || !Number.isSafeInteger(pid) || pid <= 0 || !await exists(pid)) return false;
  const writtenAt = Date.parse(record.createdAt);
  if (!Number.isFinite(writtenAt)) return true;
  // Windows reuses PIDs after reboot and normal process exits. A process born
  // after this lock was written cannot be its owner. Unknown identity stays locked.
  try {
    const bornAt = await startedAt(pid);
    return !Number.isFinite(bornAt) || bornAt <= writtenAt;
  } catch { return true; }
}
