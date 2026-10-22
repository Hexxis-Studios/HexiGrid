$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

# The independent HexiGrid watchdog does not inherit Codex's per-session pipe.
# Discover only pipes owned by a running, signed OpenAI desktop executable.
$native = @'
using System;
using System.Runtime.InteropServices;
public static class HexiGridPipeOwner {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type -TypeDefinition $native
$approved = @{}
$foundPipes = @()
foreach ($entry in (Get-ChildItem -LiteralPath '\\.\pipe\' -ErrorAction Stop)) {
  if ($entry.Name -notmatch '^codex-browser-use-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { continue }
  $pipePath = '\\.\pipe\' + $entry.Name
  $handle = [HexiGridPipeOwner]::CreateFile($pipePath, 0, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle.ToInt64() -eq -1) { continue }
  try {
    [uint32]$ownerPid = 0
    if (-not [HexiGridPipeOwner]::GetNamedPipeServerProcessId($handle, [ref]$ownerPid)) { continue }
    if (-not $approved.ContainsKey($ownerPid)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
      $valid = $false
      if ($process -and [IO.Path]::GetFileName([string]$process.ExecutablePath) -ieq 'ChatGPT.exe') {
        $signature = Get-AuthenticodeSignature -LiteralPath $process.ExecutablePath
        $valid = $signature.Status -eq 'Valid' -and [string]$signature.SignerCertificate.Subject -match 'OpenAI'
      }
      $approved[$ownerPid] = $valid
    }
    if ($approved[$ownerPid]) { $foundPipes += $pipePath }
  } finally { [void][HexiGridPipeOwner]::CloseHandle($handle) }
}
ConvertTo-Json -InputObject @($foundPipes) -Compress
