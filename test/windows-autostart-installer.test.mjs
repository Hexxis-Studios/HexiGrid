import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = path.join(root, 'scripts', 'Install-HexiGrid-Autostart.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runMockedInstaller(mode) {
  const encodedPath = Buffer.from(installer, 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$installer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$script:registerCount = 0
$script:startCount = 0
function Get-Command { param($Name, $CommandType, $ErrorAction) [pscustomobject]@{ Source = 'mock-powershell.exe' } }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) [pscustomobject]@{ UserId = $User } }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit, $RestartCount, $RestartInterval) [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{ UserId = $UserId } }
function Get-ScheduledTask { param($TaskName, $ErrorAction)
  if ('${mode}' -eq 'conflict') { return [pscustomobject]@{ Description = 'unrelated task'; Actions = @(); Triggers = @(); Principal = [pscustomobject]@{ UserId = 'SOMEONE\\ELSE' } } }
  if ('${mode}' -eq 'matching') {
    $trigger = [pscustomobject]@{ UserId = $taskUser; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } }
    return [pscustomobject]@{ Description = $taskDescription; Actions = @([pscustomobject]@{ Execute = $powerShell; Arguments = $actionArguments; WorkingDirectory = $projectRoot }); Triggers = @($trigger); Principal = [pscustomobject]@{ UserId = $env:USERNAME; LogonType = 'Interactive'; RunLevel = 'Limited' } }
  }
}
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Settings, $Principal, $Description, [switch]$Force) $script:registerCount += 1 }
function Start-ScheduledTask { param($TaskName) $script:startCount += 1 }
try {
  . $installer
  if ('${mode}' -eq 'conflict' -or $script:registerCount -ne 1 -or $script:startCount -ne 1) { throw 'Expected the startup task to register and start once.' }
  [Console]::Out.WriteLine('installed')
} catch {
  if ('${mode}' -eq 'conflict' -and $script:registerCount -eq 0 -and $_.Exception.Message -like '*different scheduled task*') { [Console]::Out.WriteLine('conflict-blocked'); exit 0 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `PowerShell exited ${code}.`)));
  });
}

test('Windows autostart installs when the named task is unoccupied and remains isolated', {
  skip: process.platform !== 'win32'
}, async () => {
  assert.match(await runMockedInstaller('empty'), /^Installed and started 'HexiGrid Local Engine'\. HexiGrid will resume after reboot, sign-in, sleep, wake, and process failure\.\r?\ninstalled$/);
});

test('Windows autostart accepts its exact existing task and starts it without changing identity', {
  skip: process.platform !== 'win32'
}, async () => {
  assert.match(await runMockedInstaller('matching'), /^Installed and started 'HexiGrid Local Engine'\./);
});

test('Windows autostart refuses to overwrite an unrelated task with the same name', {
  skip: process.platform !== 'win32'
}, async () => {
  assert.equal(await runMockedInstaller('conflict'), 'conflict-blocked');
});
