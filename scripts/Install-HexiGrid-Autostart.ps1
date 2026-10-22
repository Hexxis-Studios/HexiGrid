[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$watchdog = Join-Path $projectRoot 'scripts\HexiGrid-Watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdog -PathType Leaf)) { throw 'The HexiGrid watchdog script is missing.' }

$taskName = 'HexiGrid Local Engine'
$taskDescription = 'Starts and supervises the local HexiGrid engine after sign-in.'
$taskUser = "$env:USERDOMAIN\$env:USERNAME"
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
$quotedWatchdog = '"' + $watchdog.Replace('"', '""') + '"'
$actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedWatchdog"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $actionArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  function Get-HexiGridTaskUserSid([string]$UserId) {
    $accountName = ([string]$UserId).Trim()
    if (-not $accountName) { return '' }
    if ($accountName -notmatch '\\') { $accountName = "$env:USERDOMAIN\$accountName" }
    try {
      $account = [Security.Principal.NTAccount]::new($accountName)
      return $account.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return '' }
  }
  $sameAction = $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -eq $powerShell -and
    $existing.Actions[0].Arguments -eq $actionArguments -and $existing.Actions[0].WorkingDirectory -eq $projectRoot
  $sameTrigger = $existing.Triggers.Count -eq 1 -and $existing.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and
    (Get-HexiGridTaskUserSid $existing.Triggers[0].UserId) -eq $currentUserSid
  $sameOwner = (Get-HexiGridTaskUserSid $existing.Principal.UserId) -eq $currentUserSid -and $existing.Principal.LogonType -eq 'Interactive' -and
    $existing.Principal.RunLevel -eq 'Limited'
  if (-not ($sameAction -and $sameTrigger -and $sameOwner -and $existing.Description -eq $taskDescription)) {
    throw "A different scheduled task already uses '$taskName'. Review it before replacing it."
  }
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $taskDescription -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started '$taskName'. HexiGrid will resume after reboot, sign-in, sleep, wake, and process failure."
