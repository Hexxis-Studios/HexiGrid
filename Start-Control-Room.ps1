[CmdletBinding()]
param(
  [switch]$Network,
  [switch]$NoBrowser,
  [ValidateRange(3, 60)][int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$managerRoot = $projectRoot
$serverFile = Join-Path $projectRoot "server.mjs"
$packageFile = Join-Path $projectRoot "package.json"
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf) -or -not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
  throw "HexiGrid cannot start because server.mjs or package.json is missing from the application folder."
}
$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
if ([string]$package.name -ne "hexigrid" -or [string]$package.version -notmatch '^\d+\.\d+\.\d+$') {
  throw "This folder is not a valid HexiGrid installation."
}

$nodeCommand = @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath $_.Source -PathType Leaf }) | Select-Object -First 1
if (-not $nodeCommand) { throw "Node.js 22 or newer is required. Install Node.js from https://nodejs.org and try again." }
$nodeVersionText = (& $nodeCommand.Source --version 2>$null).TrimStart('v')
$nodeVersion = $null
if (-not [Version]::TryParse($nodeVersionText, [ref]$nodeVersion) -or $nodeVersion.Major -lt 22) {
  throw "HexiGrid requires Node.js 22 or newer. This computer has $nodeVersionText."
}

# The stable launcher keeps private data outside immutable prepared releases.
# Selection changes apply on next startup; this never stops an existing engine.
$releaseResolver = Join-Path $managerRoot 'scripts\manage-local-releases.mjs'
$selectedDigest = $null
if (Test-Path -LiteralPath (Join-Path $managerRoot 'release-selection.json')) {
  if (-not (Test-Path -LiteralPath $releaseResolver -PathType Leaf)) { throw 'Local release recovery tools are missing. No process was changed.' }
  $resolvedText = & $nodeCommand.Source $releaseResolver resolve --root $managerRoot
  if ($LASTEXITCODE -ne 0) { throw 'The selected local release failed validation. Use local release rollback; no process was changed.' }
  try { $selection = $resolvedText | ConvertFrom-Json } catch { throw 'Local release selection could not be read.' }
  $projectRoot = [IO.Path]::GetFullPath([string]$selection.root)
  $selectedDigest = [string]$selection.digest
  $serverFile = Join-Path $projectRoot 'server.mjs'
  $packageFile = Join-Path $projectRoot 'package.json'
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  if ([string]$package.name -ne 'hexigrid' -or [string]$package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Selected release package identity is invalid.' }
}

$portText = if ($env:HEXIGRID_PORT) { $env:HEXIGRID_PORT } else { "4318" }
$port = 0
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) { throw "HEXIGRID_PORT must be a whole number from 1024 through 65535." }
$dataRoot = if ($env:HEXIGRID_DATA_DIR) { [IO.Path]::GetFullPath($env:HEXIGRID_DATA_DIR) } else { Join-Path $managerRoot "data" }
$runtimeFile = Join-Path $dataRoot ".runtime.json"
$scheme = if ($Network) { "https" } else { "http" }
$address = "${scheme}://127.0.0.1:$port"

if ($Network) {
  $hasPfx = -not [string]::IsNullOrWhiteSpace($env:HEXIGRID_TLS_PFX)
  $hasPemPair = -not [string]::IsNullOrWhiteSpace($env:HEXIGRID_TLS_CERT) -and -not [string]::IsNullOrWhiteSpace($env:HEXIGRID_TLS_KEY)
  if (-not $hasPfx -and -not $hasPemPair) { throw "Secure phone/tablet access requires HTTPS. Set HEXIGRID_TLS_PFX or both HEXIGRID_TLS_CERT and HEXIGRID_TLS_KEY. See docs/SECURE-NETWORK.md." }
}

function Get-HexiGridIdentity {
  try { return Invoke-RestMethod -Uri "$address/api/system/identity" -Method Get -TimeoutSec 2 -MaximumRedirection 0 }
  catch { return $null }
}

function Confirm-HexiGridIdentity([object]$Identity, [object]$ExpectedPid) {
  if (-not $Identity -or $Identity.product -ne "hexigrid" -or $Identity.version -ne [string]$package.version -or [string]$Identity.instanceId -notmatch '^[0-9a-f-]{36}$') { return $false }
  if ($selectedDigest -and $Identity.sourceDigest -ne $selectedDigest) { return $false }
  if ($null -ne $ExpectedPid -and [int]$Identity.pid -ne [int]$ExpectedPid) { return $false }
  if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { return $false }
  try { $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } catch { return $false }
  if ($runtime.product -ne "hexigrid" -or $runtime.version -ne [string]$package.version -or $runtime.instanceId -ne $Identity.instanceId -or [int]$runtime.pid -ne [int]$Identity.pid -or [int]$runtime.port -ne $port) { return $false }
  try { $processRecord = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Identity.pid)" -ErrorAction Stop } catch { return $false }
  if (-not $processRecord -or [IO.Path]::GetFileName([string]$processRecord.ExecutablePath) -ine "node.exe") { return $false }
  return ([string]$processRecord.CommandLine).IndexOf($serverFile, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $identity = Get-HexiGridIdentity
  if (-not (Confirm-HexiGridIdentity $identity ([int]$listener.OwningProcess))) { throw "Port $port is already used by another or unverifiable program. HexiGrid did not open or stop it. Choose another HEXIGRID_PORT or close that program yourself." }
  if ($Network -and $identity.scheme -ne "https") { throw "HexiGrid is already running without secure network access. Close that HexiGrid process yourself, then start again with -Network." }
} else {
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  $arguments = @('"' + $serverFile + '"')
  if ($Network) { $arguments += "--network" }
  $priorDataRoot = $env:HEXIGRID_DATA_DIR
  $priorManagerRoot = $env:HEXIGRID_RELEASE_MANAGER_ROOT
  try {
    $env:HEXIGRID_DATA_DIR = $dataRoot
    $env:HEXIGRID_RELEASE_MANAGER_ROOT = $managerRoot
    $started = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  } finally { $env:HEXIGRID_DATA_DIR = $priorDataRoot; $env:HEXIGRID_RELEASE_MANAGER_ROOT = $priorManagerRoot }
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $identity = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $started.HasExited) {
    Start-Sleep -Milliseconds 200
    $identity = Get-HexiGridIdentity
    if (Confirm-HexiGridIdentity $identity $started.Id) { break }
  }
  if (-not (Confirm-HexiGridIdentity $identity $started.Id)) {
    if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
    throw "HexiGrid did not pass its startup identity check within $StartupTimeoutSeconds seconds. The incomplete process was stopped; no existing process was changed."
  }
}

Write-Output "HexiGrid verified at $address (process $($identity.pid), version $($identity.version))."
if (-not $NoBrowser) { Start-Process "$address/" }
