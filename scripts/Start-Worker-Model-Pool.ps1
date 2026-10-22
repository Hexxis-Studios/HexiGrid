[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,

  [Parameter(Mandatory = $true)]
  [string]$UpstreamRoot,

  [Parameter(Mandatory = $true)]
  [string]$DataDirectory
)

$ErrorActionPreference = 'Stop'
$taskPort = 2455
$startupTimeoutSeconds = 30

function Assert-SafeAbsolutePath {
  param([string]$Value, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "$Name must be an absolute path without quotes or newlines."
  }
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute." }
}

function ConvertTo-WindowsArgument {
  param([string]$Value)
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw 'Command arguments cannot contain quotes or newlines.'
  }
  $trimmed = $Value.TrimEnd('\')
  $trailingBackslashes = $Value.Length - $trimmed.Length
  return '"' + $trimmed + ('\' * (2 * $trailingBackslashes)) + '"'
}

function Test-LocalPoolPort {
  $connected = Test-NetConnection -ComputerName '127.0.0.1' -Port $taskPort -InformationLevel Quiet -WarningAction SilentlyContinue
  return [bool]$connected
}

function Get-HttpStatusCode {
  param($Response)
  if ($null -eq $Response) { return 0 }
  try { return [int]$Response.StatusCode } catch { return 0 }
}

function Get-PoolModelsStatus {
  param([switch]$WorkerSelector)
  $headers = @{}
  if ($WorkerSelector) { [void]($headers['x-hexigrid-pool-worker'] = '1') }
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:2455/backend-api/codex/models' -Method Get -Headers $headers -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 4 -ErrorAction Stop
    return Get-HttpStatusCode $response
  } catch {
    return Get-HttpStatusCode $_.Exception.Response
  }
}

function Test-WorkerAuthReady {
  # GET /backend-api/codex/models cannot invoke inference. The control request makes sure a
  # generic API-key requirement is not mistaken for worker-header support.
  $ordinaryStatus = Get-PoolModelsStatus
  $workerStatus = Get-PoolModelsStatus -WorkerSelector
  return ($ordinaryStatus -ge 200 -and $ordinaryStatus -lt 300 -and $workerStatus -eq 401)
}

function Test-ProcessStillRunning {
  param($Process)
  if ($null -eq $Process) { return $false }
  try {
    $null = Get-Process -Id $Process.Id -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

Assert-SafeAbsolutePath $LauncherPath 'LauncherPath'
Assert-SafeAbsolutePath $UpstreamRoot 'UpstreamRoot'
Assert-SafeAbsolutePath $DataDirectory 'DataDirectory'

$launcher = (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).Path
$upstream = (Resolve-Path -LiteralPath $UpstreamRoot -ErrorAction Stop).Path
$dataDirectoryResolved = (Resolve-Path -LiteralPath $DataDirectory -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($launcher) -ne '.ps1') { throw 'LauncherPath must identify the existing PowerShell launcher.' }
if (-not (Test-Path -LiteralPath $upstream -PathType Container)) { throw 'UpstreamRoot must be an existing directory.' }
if (-not (Test-Path -LiteralPath $dataDirectoryResolved -PathType Container)) { throw 'DataDirectory must be an existing directory.' }

$pythonPath = Join-Path (Join-Path $upstream '.venv') 'Scripts/python.exe'
$workerWrapper = Join-Path $PSScriptRoot 'pool-worker-auth.py'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) { throw "The installed upstream Python executable is missing: $pythonPath" }
if (-not (Test-Path -LiteralPath $workerWrapper -PathType Leaf)) { throw "The tracked worker auth wrapper is missing: $workerWrapper" }
$powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source

# Child processes inherit these explicit local-only startup values. They are
# process environment values, not saved pool settings or copied credentials.
$env:CODEX_LB_DATA_DIR = $dataDirectoryResolved
$env:CODEX_LB_TELEMETRY_ENABLED = 'false'

$ownedWorkerProcess = $null
$portWasOccupied = Test-LocalPoolPort
if (-not $portWasOccupied) {
  $pythonArguments = (ConvertTo-WindowsArgument $workerWrapper) + ' --upstream ' + (ConvertTo-WindowsArgument $upstream) + ' --port ' + $taskPort
  $ownedWorkerProcess = Start-Process -FilePath $pythonPath -ArgumentList $pythonArguments -WorkingDirectory $upstream -WindowStyle Hidden -PassThru
}

$deadline = [DateTime]::UtcNow.AddSeconds($startupTimeoutSeconds)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-LocalPoolPort) {
    if (Test-WorkerAuthReady) {
      $ready = $true
      break
    }
    if ($portWasOccupied) {
      throw 'Port 2455 is occupied by a listener that does not prove worker-header authentication; no process was changed.'
    }
  }

  if ($ownedWorkerProcess -and -not (Test-ProcessStillRunning $ownedWorkerProcess)) {
    throw 'The hidden worker-auth process exited before its listener became ready; no process was stopped.'
  }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "The worker-auth listener did not become ready within $startupTimeoutSeconds seconds; no process was stopped." }

$launcherArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-WindowsArgument $launcher)
Start-Process -FilePath $powerShell -ArgumentList $launcherArguments -WorkingDirectory ([IO.Path]::GetDirectoryName($launcher)) -WindowStyle Hidden | Out-Null
Write-Output 'The authenticated local pool is ready; the existing pool/OpenCode launcher has been started.'
