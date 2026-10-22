[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,

  [Parameter(Mandatory = $true)]
  [string]$UpstreamRoot,

  [Parameter(Mandatory = $true)]
  [string]$DataDirectory,

  [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$taskName = 'HexiGrid Local Account Pool'

function Resolve-RequiredPath {
  param([string]$Value, [string]$Name, [string]$PathType)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "$Name must be an absolute path without quotes or newlines."
  }
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute." }
  $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $resolved -PathType $PathType)) { throw "$Name must identify an existing $PathType." }
  return $resolved
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

function Test-PathEquals {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    $leftFull = [IO.Path]::GetFullPath($Left).TrimEnd('\')
    $rightFull = [IO.Path]::GetFullPath($Right).TrimEnd('\')
    return [string]::Equals($leftFull, $rightFull, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

$launcher = Resolve-RequiredPath $LauncherPath 'LauncherPath' 'Leaf'
$upstream = Resolve-RequiredPath $UpstreamRoot 'UpstreamRoot' 'Container'
$dataDirectoryResolved = Resolve-RequiredPath $DataDirectory 'DataDirectory' 'Container'
if ([IO.Path]::GetExtension($launcher) -ne '.ps1') { throw 'LauncherPath must identify the existing PowerShell launcher.' }
$adapterPath = Join-Path $PSScriptRoot 'Start-Worker-Model-Pool.ps1'
if (-not (Test-Path -LiteralPath $adapterPath -PathType Leaf)) { throw 'The tracked worker startup adapter is missing.' }

$powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
$launcherDirectory = [IO.Path]::GetDirectoryName($launcher)
$adapterDirectory = [IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $adapterPath).Path)
$originalArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-WindowsArgument $launcher)
$adapterArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-WindowsArgument $adapterPath) +
  ' -LauncherPath ' + (ConvertTo-WindowsArgument $launcher) +
  ' -UpstreamRoot ' + (ConvertTo-WindowsArgument $upstream) +
  ' -DataDirectory ' + (ConvertTo-WindowsArgument $dataDirectoryResolved)

try {
  $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction Stop)
} catch {
  throw "The existing '$taskName' task could not be read; no task was created or changed."
}
if ($tasks.Count -ne 1) { throw "The existing '$taskName' task is absent or ambiguous; no task was created or changed." }
$task = $tasks[0]
if ($null -eq $task.Actions -or $task.Actions.Count -ne 1) {
  throw "The existing '$taskName' task does not have exactly one action; no change was made."
}
$action = $task.Actions[0]
$commonExecutable = [string]::Equals([string]$action.Execute, [string]$powerShell, [StringComparison]::OrdinalIgnoreCase)
$matchesOriginal = $commonExecutable -and
  [string]::Equals([string]$action.Arguments, $originalArguments, [StringComparison]::Ordinal) -and
  (Test-PathEquals ([string]$action.WorkingDirectory) $launcherDirectory)
$matchesAdapter = $commonExecutable -and
  [string]::Equals([string]$action.Arguments, $adapterArguments, [StringComparison]::Ordinal) -and
  (Test-PathEquals ([string]$action.WorkingDirectory) $adapterDirectory)

if ($Restore) {
  if ($matchesOriginal) {
    Write-Output "'$taskName' already has the exact original launcher action."
    return
  }
  if (-not $matchesAdapter) { throw "The existing '$taskName' task is not the exact tracked adapter action; no change was made." }
  $replacement = New-ScheduledTaskAction -Execute $powerShell -Argument $originalArguments -WorkingDirectory $launcherDirectory
  Set-ScheduledTask -TaskName $taskName -Action $replacement -ErrorAction Stop | Out-Null
  Write-Output "Restored only the exact adapter action in '$taskName'."
  return
}

if ($matchesAdapter) {
  Write-Output "'$taskName' already has the exact tracked adapter action."
  return
}
if (-not $matchesOriginal) {
  throw "The existing '$taskName' task does not exactly match the original launcher action; no change was made."
}

$newAction = New-ScheduledTaskAction -Execute $powerShell -Argument $adapterArguments -WorkingDirectory $adapterDirectory
Set-ScheduledTask -TaskName $taskName -Action $newAction -ErrorAction Stop | Out-Null
Write-Output "Updated only the action in the existing '$taskName' task. Its trigger, settings, and principal were not changed."
