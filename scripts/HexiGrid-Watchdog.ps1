[CmdletBinding()]
param(
  [ValidateRange(5, 120)][int]$CheckIntervalSeconds = 15,
  [ValidateRange(5, 120)][int]$HealthyResetSeconds = 60
)

$ErrorActionPreference = 'Continue'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$launcher = Join-Path $projectRoot 'Start-Control-Room.ps1'
$dataRoot = if ($env:HEXIGRID_DATA_DIR) { [IO.Path]::GetFullPath($env:HEXIGRID_DATA_DIR) } else { Join-Path $projectRoot 'data' }
$logFile = Join-Path $dataRoot 'watchdog.log'
$port = if ($env:HEXIGRID_PORT) { [int]$env:HEXIGRID_PORT } else { 4318 }
$healthUrl = "http://127.0.0.1:$port/api/system/identity"
$retrySeconds = @(2, 4, 8, 16, 30)
$failureCount = 0
$healthySince = $null

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null

function Write-WatchdogLog([string]$Message) {
  if ((Test-Path -LiteralPath $logFile -PathType Leaf) -and ((Get-Item -LiteralPath $logFile).Length -gt 1MB)) {
    Move-Item -LiteralPath $logFile -Destination "$logFile.previous" -Force
  }
  Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message"
}

function Test-HexiGridHealth {
  try {
    $identity = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3 -MaximumRedirection 0
    return $identity.product -eq 'hexigrid' -and [int]$identity.port -eq $port
  } catch { return $false }
}

Write-WatchdogLog 'Watchdog started.'
while ($true) {
  if (Test-HexiGridHealth) {
    if ($null -eq $healthySince) { $healthySince = [DateTime]::UtcNow; Write-WatchdogLog 'HexiGrid is healthy.' }
    if (([DateTime]::UtcNow - $healthySince).TotalSeconds -ge $HealthyResetSeconds) { $failureCount = 0 }
    Start-Sleep -Seconds $CheckIntervalSeconds
    continue
  }

  $healthySince = $null
  $delay = $retrySeconds[[Math]::Min($failureCount, $retrySeconds.Count - 1)]
  Write-WatchdogLog "HexiGrid is unavailable. Restart attempt $($failureCount + 1) begins after ${delay}s."
  Start-Sleep -Seconds $delay
  try {
    & $launcher -NoBrowser -StartupTimeoutSeconds 30 | Out-Null
    Write-WatchdogLog 'Restart command completed.'
  } catch {
    Write-WatchdogLog "Restart failed: $($_.Exception.Message)"
  }
  $failureCount += 1
}
