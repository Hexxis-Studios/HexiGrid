[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'HexiGrid Local Engine'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed '$taskName'. The currently running HexiGrid process was not stopped."
} else {
  Write-Output "'$taskName' is not installed."
}
