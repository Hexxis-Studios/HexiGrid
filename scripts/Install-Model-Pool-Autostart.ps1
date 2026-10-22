[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$launcher = (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($launcher) -ne '.ps1' -or $launcher.Contains('"')) { throw 'Provide the installed local pool PowerShell launcher.' }
$taskName = 'HexiGrid Local Account Pool'
$powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $powerShell -or $existing.Actions[0].Arguments -ne $arguments)) {
  throw 'A different startup task already uses this name. Review it before replacing it.'
}
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($launcher))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the separately installed local account pool and OpenCode after Windows sign-in; no model request or account change.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed '$taskName'. The existing launcher starts missing services without stopping running apps. Reboot acceptance remains a separate check."
