[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$launcher = Join-Path $projectRoot 'Start-Control-Room.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The HexiGrid launcher is missing.' }

$powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
$programs = [Environment]::GetFolderPath('Programs')
if (-not $programs) { throw 'The current Windows account has no Start Menu Programs folder.' }
$shortcutPath = Join-Path $programs 'HexiGrid.lnk'
$appId = 'Hexxis.Studios.HexiGrid'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShell
$shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $launcher.Replace('"', '""') + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Open the local HexiGrid control room'
$shortcut.Save()
$toastShortcutSetup = Join-Path $PSScriptRoot 'Set-HexiGridToastShortcut.ps1'
if (-not (Test-Path -LiteralPath $toastShortcutSetup -PathType Leaf)) { throw 'The Windows toast shortcut property helper is missing; the Start Menu entry was written without changing any permissions.' }
& $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $toastShortcutSetup -ShortcutPath $shortcutPath -AppUserModelId $appId -ToastActivatorClsid 'eb1fdd5b-8f70-4b5a-b230-998a2dc19303'
if ($LASTEXITCODE -ne 0) { throw 'Windows call alerts could not be registered on the HexiGrid Start Menu shortcut.' }
Write-Output "Installed HexiGrid in the current account's Start Menu and registered Windows call notifications as $appId."
