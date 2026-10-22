import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'scripts', 'Start-Worker-Model-Pool.ps1');
const workerWrapperPath = path.join(repoRoot, 'scripts', 'pool-worker-auth.py');
const installerPath = path.join(repoRoot, 'scripts', 'Install-Worker-Pool-Startup.ps1');
const powershellCheck = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' })
  : { status: 1 };
const canRunPowerShell = process.platform === 'win32' && powershellCheck.status === 0;

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function makeSandbox(t) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-pool-startup-'));
  const paths = {
    tempRoot,
    launcher: path.join(tempRoot, 'Synthetic Launcher', 'Start-Local-Test.ps1'),
    upstream: path.join(tempRoot, 'Synthetic Upstream'),
    python: path.join(tempRoot, 'Synthetic Upstream', '.venv', 'Scripts', 'python.exe'),
    data: path.join(tempRoot, 'Synthetic Data'),
    harness: path.join(tempRoot, 'mock-harness.ps1'),
  };
  await mkdir(path.dirname(paths.launcher), { recursive: true });
  await mkdir(path.dirname(paths.python), { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await writeFile(paths.launcher, '# synthetic launcher; never executed\n');
  await writeFile(paths.python, 'synthetic executable placeholder; never executed\n');

  t.after(async () => {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedParent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolvedTemp).toLowerCase(), resolvedParent.toLowerCase(), 'generated cleanup target must be a direct child of the OS temp directory');
    assert.ok(path.basename(resolvedTemp).startsWith('hexigrid-pool-startup-'), 'generated cleanup target must carry the test prefix');
    await rm(resolvedTemp, { recursive: true, force: true });
  });
  return paths;
}

function powershellBase(paths, setup) {
  return `
$ErrorActionPreference = 'Stop'
$adapterPath = ${psString(adapterPath)}
$workerWrapperPath = ${psString(workerWrapperPath)}
$installerPath = ${psString(installerPath)}
$launcherPath = ${psString(paths.launcher)}
$upstreamPath = ${psString(paths.upstream)}
$dataPath = ${psString(paths.data)}
$global:portOpen = $false
$global:autoOpen = $true
$global:ordinaryStatus = 200
$global:workerStatus = 401
$global:processAlive = $true
$global:portChecks = 0
$global:stopCalls = 0
$global:events = @()
$global:startCalls = @()
$global:webCalls = @()
$global:task = $null
$global:taskMissing = $false
$global:getTaskCalls = 0
$global:setTaskCalls = 0

function global:Start-Sleep {
  [CmdletBinding()]
  param([int]$Seconds)
}
function global:Test-NetConnection {
  [CmdletBinding()]
  param([string]$ComputerName, [int]$Port, [string]$InformationLevel)
  $global:portChecks++
  if ($ComputerName -ne '127.0.0.1' -or $Port -ne 2455) { throw 'Unexpected network probe.' }
  return [bool]$global:portOpen
}
function global:Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [string]$Method, [hashtable]$Headers, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec)
  if ($MaximumRedirection -ne 0) { throw 'Redirects must remain disabled.' }
  if ($Uri -ne 'http://127.0.0.1:2455/backend-api/codex/models' -or $Method -ne 'Get') { throw 'Unexpected HTTP request.' }
  if ($Headers.Count -gt 1 -or ($Headers.Count -eq 1 -and $Headers['x-hexigrid-pool-worker'] -ne '1')) { throw 'Unexpected auth header.' }
  $selected = $Headers.ContainsKey('x-hexigrid-pool-worker')
  $global:webCalls += [pscustomobject]@{ Selected = $selected; Method = $Method; Uri = $Uri }
  if ($selected) { return [pscustomobject]@{ StatusCode = $global:workerStatus } }
  return [pscustomobject]@{ StatusCode = $global:ordinaryStatus }
}
function global:Get-Process {
  [CmdletBinding()]
  param([int]$Id)
  if (-not $global:processAlive) { throw 'Synthetic process exited.' }
  return [pscustomobject]@{ Id = $Id }
}
function global:Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [string]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle, [switch]$PassThru)
  $global:startCalls += [pscustomobject]@{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    WorkingDirectory = $WorkingDirectory
    WindowStyle = $WindowStyle
    PassThru = [bool]$PassThru
    DataDirectory = $env:CODEX_LB_DATA_DIR
    Telemetry = $env:CODEX_LB_TELEMETRY_ENABLED
  }
  if ($FilePath -like '*python.exe') {
    $global:events += 'worker'
    if ($global:autoOpen) { $global:portOpen = $true }
    if ($PassThru) { return [pscustomobject]@{ Id = 713 } }
  } else {
    $global:events += 'launcher'
  }
}
function global:Stop-Process { $global:stopCalls++ }

${setup}
`;
}

async function runPowerShell(paths, source) {
  await writeFile(paths.harness, source, 'utf8');
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.harness,
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

function assertPowerShellPass(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('starts only a hidden owned adapter when port 2455 is absent, then preserves the original launcher', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const setup = `
& $adapterPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath
if ($global:startCalls.Count -ne 2) { throw 'Expected one worker start and one original launcher start.' }
if ($global:events -join ',' -ne 'worker,launcher') { throw 'The original launcher ran before worker readiness.' }
if ($global:startCalls[0].WindowStyle -ne 'Hidden' -or -not $global:startCalls[0].PassThru) { throw 'The owned worker was not started hidden and tracked.' }
if (-not [string]::Equals($global:startCalls[0].FilePath, (Join-Path (Join-Path $upstreamPath '.venv') 'Scripts/python.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The existing upstream Python was not selected.' }
$expectedWorkerPrefix = '"' + $workerWrapperPath + '" --upstream '
if (-not $global:startCalls[0].ArgumentList.StartsWith($expectedWorkerPrefix, [StringComparison]::OrdinalIgnoreCase) -or $global:startCalls[0].ArgumentList -notmatch 'Synthetic Upstream" --port 2455') { throw 'Worker wrapper or upstream arguments were not quoted safely.' }
if ($global:startCalls[0].DataDirectory -ne (Resolve-Path $dataPath).Path -or $global:startCalls[0].Telemetry -ne 'false') { throw 'Required process environment was not applied.' }
if ($global:startCalls[1].WindowStyle -ne 'Hidden' -or $global:startCalls[1].WorkingDirectory -ne (Split-Path $launcherPath)) { throw 'Original launcher invocation was not hidden or used its own directory.' }
if ($global:startCalls[1].DataDirectory -ne (Resolve-Path $dataPath).Path -or $global:startCalls[1].Telemetry -ne 'false') { throw 'The original launcher did not inherit the same local environment.' }
if ($global:webCalls.Count -ne 2 -or $global:webCalls[0].Selected -or -not $global:webCalls[1].Selected) { throw 'The harmless control and worker-header checks were not paired.' }
if ($global:webCalls | Where-Object { $_.Method -ne 'Get' -or $_.Uri -ne 'http://127.0.0.1:2455/backend-api/codex/models' }) { throw 'Readiness made a non-read-only request.' }
if ($global:portChecks -lt 2 -or $global:stopCalls -ne 0) { throw 'A real port probe or process stop escaped the helpers.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('reuses a compatible occupied listener without starting or stopping it', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const setup = `
$global:portOpen = $true
& $adapterPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath
if ($global:startCalls.Count -ne 1 -or $global:events -join ',' -ne 'launcher' -or $global:stopCalls -ne 0) { throw 'An occupied listener was restarted or a launcher was skipped.' }
if ($global:webCalls.Count -ne 2) { throw 'Expected worker-header preflight and no-key control.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('fails closed for an incompatible occupied listener without starting anything', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const setup = `
$global:portOpen = $true
$global:workerStatus = 200
$failed = $false
try { & $adapterPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath } catch { $failed = $true }
if (-not $failed) { throw 'An incompatible listener was accepted.' }
if ($global:startCalls.Count -ne 0 -or $global:events.Count -ne 0 -or $global:stopCalls -ne 0) { throw 'A process was started or stopped despite an occupied incompatible port.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('does not invoke the original launcher if the owned worker exits before readiness', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const setup = `
$global:workerStatus = 200
$global:ordinaryStatus = 200
$global:processAlive = $false
$failed = $false
try { & $adapterPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath } catch { $failed = $true }
if (-not $failed) { throw 'An exited worker process was accepted.' }
if ($global:events -join ',' -ne 'worker') { throw 'The original launcher ran before worker readiness.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

function mockTaskCommands(paths, existingAction, extraSetup = '') {
  return `
$global:powerShellExe = (Get-Command powershell.exe -CommandType Application).Source
$global:launcherDir = Split-Path $launcherPath
$global:adapterFile = Join-Path ${psString(path.join(repoRoot, 'scripts'))} 'Start-Worker-Model-Pool.ps1'
$global:adapterDir = Split-Path $global:adapterFile
$global:quotedLauncher = '"' + $launcherPath + '"'
$global:quotedAdapter = '"' + $global:adapterFile + '"'
$global:quotedUpstream = '"' + $upstreamPath + '"'
$global:quotedData = '"' + $dataPath + '"'
$global:originalTaskArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $global:quotedLauncher
$global:adapterTaskArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $global:quotedAdapter + ' -LauncherPath ' + $global:quotedLauncher + ' -UpstreamRoot ' + $global:quotedUpstream + ' -DataDirectory ' + $global:quotedData
$global:triggerMarker = [pscustomobject]@{ Name = 'preserve-trigger' }
$global:settingsMarker = [pscustomobject]@{ Name = 'preserve-settings' }
$global:principalMarker = [pscustomobject]@{ Name = 'preserve-principal' }
$global:existingAction = ${existingAction}
$global:task = [pscustomobject]@{
  Actions = [object[]]@($global:existingAction)
  Triggers = @($global:triggerMarker)
  Settings = $global:settingsMarker
  Principal = $global:principalMarker
}
function global:Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  $global:getTaskCalls++
  if ($global:taskMissing) { throw 'Synthetic task absent.' }
  if ($TaskName -ne 'HexiGrid Local Account Pool') { throw 'Unexpected task lookup.' }
  return $global:task
}
function global:New-ScheduledTaskAction {
  [CmdletBinding()]
  param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
  return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}
function global:Set-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, $Action)
  if ($TaskName -ne 'HexiGrid Local Account Pool') { throw 'Unexpected task update.' }
  $global:setTaskCalls++
  $global:task.Actions = @($Action)
  return $global:task
}
function global:Register-ScheduledTask { throw 'The installer must not create or replace a task.' }
function global:Start-ScheduledTask { throw 'The installer must not run a task.' }
${extraSetup}
`;
}

test('migrates only the exact original task action and preserves the rest of the task', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const existing = `[pscustomobject]@{ Execute = $global:powerShellExe; Arguments = $global:originalTaskArguments; WorkingDirectory = $global:launcherDir }`;
  const setup = `${mockTaskCommands(paths, existing)}
$triggers = $global:task.Triggers
$settings = $global:task.Settings
$principal = $global:task.Principal
& $installerPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath
if ($global:setTaskCalls -ne 1 -or $global:task.Actions.Count -ne 1) { throw 'Expected one action-only migration.' }
if ($global:task.Actions[0].Arguments -ne $global:adapterTaskArguments -or $global:task.Actions[0].WorkingDirectory -ne $global:adapterDir) { throw 'Unexpected adapter task action.' }
if (-not [object]::ReferenceEquals($global:task.Triggers, $triggers) -or -not [object]::ReferenceEquals($global:task.Settings, $settings) -or -not [object]::ReferenceEquals($global:task.Principal, $principal)) { throw 'Task settings, trigger, or principal changed.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('restores only the exact adapter task action to the original launcher action', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const existing = `[pscustomobject]@{ Execute = $global:powerShellExe; Arguments = $global:adapterTaskArguments; WorkingDirectory = $global:adapterDir }`;
  const setup = `${mockTaskCommands(paths, existing)}
& $installerPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath -Restore
if ($global:setTaskCalls -ne 1 -or $global:task.Actions.Count -ne 1) { throw 'Expected one action-only restore.' }
if ($global:task.Actions[0].Arguments -ne $global:originalTaskArguments -or $global:task.Actions[0].WorkingDirectory -ne $global:launcherDir) { throw 'Unexpected restored action.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('leaves unrelated and absent tasks unchanged and rejects unsafe path arguments', { skip: !canRunPowerShell }, async (t) => {
  const paths = await makeSandbox(t);
  const wrongAction = `[pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-File unrelated.ps1'; WorkingDirectory = ${psString(path.dirname(paths.launcher))} }`;
  const setup = `${mockTaskCommands(paths, wrongAction)}
$failed = $false
try { & $installerPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath } catch { $failed = $true }
if (-not $failed -or $global:setTaskCalls -ne 0) { throw 'An unrelated task action was changed.' }
$global:taskMissing = $true
$failed = $false
try { & $installerPath -LauncherPath $launcherPath -UpstreamRoot $upstreamPath -DataDirectory $dataPath } catch { $failed = $true }
if (-not $failed -or $global:setTaskCalls -ne 0) { throw 'An absent task was created or changed.' }
$beforeLookups = $global:getTaskCalls
$failed = $false
try { & $installerPath -LauncherPath ($launcherPath + '"') -UpstreamRoot $upstreamPath -DataDirectory $dataPath } catch { $failed = $true }
if (-not $failed -or $global:getTaskCalls -ne $beforeLookups) { throw 'An unsafe quoted path was accepted or inspected a task.' }
`;
  assertPowerShellPass(await runPowerShell(paths, powershellBase(paths, setup)));
});

test('records the startup contract and keeps the test independent of packages', async () => {
  const [adapter, installer, decision] = await Promise.all([
    readFile(adapterPath, 'utf8'),
    readFile(installerPath, 'utf8'),
    readFile(path.join(repoRoot, 'docs', 'MODEL-POOL-INTEGRATION.md'), 'utf8'),
  ]);
  assert.match(adapter, /CODEX_LB_DATA_DIR/);
  assert.match(adapter, /CODEX_LB_TELEMETRY_ENABLED = 'false'/);
  assert.match(adapter, /-WindowStyle Hidden/);
  assert.match(adapter, /\[DateTime\]::UtcNow\.AddSeconds\(\$startupTimeoutSeconds\)/);
  assert.match(adapter, /Start-Sleep -Seconds 1/);
  assert.match(installer, /Set-ScheduledTask -TaskName \$taskName -Action/);
  assert.doesNotMatch(installer, /Register-ScheduledTask|Start-ScheduledTask/);
  assert.match(decision, /Soju06\/codex-lb/);
  assert.match(decision, /license: MIT; inspected integration version1\.25\.0-beta\.9/);
});

