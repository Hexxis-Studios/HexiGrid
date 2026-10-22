[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'HexiGrid Local Account Pool'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed '$taskName'. Running pool, OpenCode and desktop apps were not stopped."
} else { Write-Output "'$taskName' is not installed." }
