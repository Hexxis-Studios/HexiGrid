param([Parameter(Mandatory = $true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HexiGridUiaNativeWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$request = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Send-Fallback([string]$Reason, [bool]$MayHaveApplied = $false) {
  $result = @{ ok = $false; fallback = 'screenshot-coordinate'; reason = $Reason }
  if ($MayHaveApplied) { $result.mayHaveApplied = $true }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
}
function Get-ForegroundRoot {
  $handle = [HexiGridUiaNativeWindow]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return $null }
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return $null }
  if ($null -eq $root) { return $null }
  return @{ handle = [int64]$handle.ToInt64(); root = $root }
}
function Test-Pattern($Element, $Pattern) {
  try { return $null -ne $Element.GetCurrentPattern($Pattern) } catch { return $false }
}
function Test-ValueWritable($Element) {
  try { return -not $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.IsReadOnly } catch { return $false }
}
function Limit-Text([string]$Value, [int]$Length) {
  if ($null -eq $Value) { return '' }
  $clean = $Value -replace '[\x00-\x1f\x7f]', ' '
  if ($clean.Length -gt $Length) { return $clean.Substring(0, $Length) }
  return $clean
}
function Get-Node($Element, [int]$Depth) {
  try {
    $current = $Element.Current
    if ($current.IsOffscreen -or -not $current.IsEnabled) { return $null }
    if ($current.IsPassword) { return $null }
    $runtime = @($Element.GetRuntimeId() | ForEach-Object { [int]$_ })
    if ($runtime.Count -lt 1 -or $runtime.Count -gt 16) { return $null }
    $bounds = $current.BoundingRectangle
    return [ordered]@{
      runtimeId = $runtime
      name = Limit-Text ([string]$current.Name) 160
      automationId = Limit-Text ([string]$current.AutomationId) 100
      controlType = [string]$current.ControlType.ProgrammaticName
      bounds = @{ x = [double]$bounds.X; y = [double]$bounds.Y; width = [double]$bounds.Width; height = [double]$bounds.Height }
      enabled = [bool]$current.IsEnabled
      supports = @{ setValue = (Test-ValueWritable $Element); toggle = (Test-Pattern $Element ([System.Windows.Automation.TogglePattern]::Pattern)) }
      depth = $Depth
    }
  } catch { return $null }
}
if ([string]$request.operation -eq 'inspect') {
  $active = Get-ForegroundRoot
  if ($null -eq $active) { Send-Fallback 'Windows did not expose an accessible active window.'; exit 0 }
  try {
    $window = $active.root.Current
    $controls = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@{ element = $active.root; depth = 0 })
    $truncated = $false
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($queue.Count -gt 0) {
      $item = $queue.Dequeue()
      if ($item.depth -gt 0) {
        $node = Get-Node $item.element $item.depth
        if ($null -ne $node) { $controls.Add($node) }
      }
      if ($controls.Count -ge 128) { $truncated = $true; break }
      if ($item.depth -ge 8) { continue }
      try { $child = $walker.GetFirstChild($item.element) } catch { $child = $null }
      while ($null -ne $child) {
        if ($queue.Count -ge 1024) { $truncated = $true; break }
        $queue.Enqueue(@{ element = $child; depth = ($item.depth + 1) })
        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
      }
    }
    if ($controls.Count -eq 0) { Send-Fallback 'The active window did not expose usable accessible controls.'; exit 0 }
    $result = @{ ok = $true; operation = 'inspect'; windowHandle = $active.handle; windowName = (Limit-Text ([string]$window.Name) 160); controls = @($controls.ToArray()); truncated = $truncated }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 12))
    exit 0
  } catch { Send-Fallback 'The active window UI Automation tree could not be read safely.'; exit 0 }
}
if ([string]$request.operation -notin @('toggle', 'set-value')) { Send-Fallback 'That UI Automation operation is not supported.'; exit 0 }
$active = Get-ForegroundRoot
if ($null -eq $active -or $active.handle -ne [int64]$request.windowHandle) { Send-Fallback 'The active window changed after inspection. Inspect it again before acting.'; exit 0 }
try {
  $wantedId = (@($request.runtimeId | ForEach-Object { [int]$_ }) -join ',')
  if (-not $wantedId -or $wantedId.Length -gt 160) { Send-Fallback 'The inspected control identifier is invalid.'; exit 0 }
  $matches = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ element = $active.root; depth = 0 })
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  while ($queue.Count -gt 0 -and $matches.Count -lt 2) {
    $item = $queue.Dequeue()
    try { $runtime = @($item.element.GetRuntimeId() | ForEach-Object { [int]$_ }) -join ',' } catch { $runtime = '' }
    if ($runtime -eq $wantedId) { $matches.Add($item.element) }
    if ($item.depth -ge 8) { continue }
    try { $child = $walker.GetFirstChild($item.element) } catch { $child = $null }
    while ($null -ne $child) {
      if ($queue.Count -lt 1024) { $queue.Enqueue(@{ element = $child; depth = ($item.depth + 1) }) }
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  if ($matches.Count -ne 1) { Send-Fallback 'The inspected control is missing or ambiguous. Inspect the active window again.'; exit 0 }
  $element = $matches[0]
  if ($element.Current.IsOffscreen -or -not $element.Current.IsEnabled -or $element.Current.IsPassword) { Send-Fallback 'The inspected control is offscreen, disabled, or sensitive.'; exit 0 }
  $fingerprint = $request.fingerprint
  $current = $element.Current
  $currentName = Limit-Text ([string]$current.Name) 160
  $currentAutomationId = Limit-Text ([string]$current.AutomationId) 100
  $currentControlType = [string]$current.ControlType.ProgrammaticName
  $currentBounds = $current.BoundingRectangle
  if ($null -eq $fingerprint -or $currentName -cne [string]$fingerprint.name -or $currentAutomationId -cne [string]$fingerprint.automationId -or $currentControlType -cne [string]$fingerprint.controlType -or
    [math]::Round($currentBounds.X) -ne [double]$fingerprint.bounds.x -or [math]::Round($currentBounds.Y) -ne [double]$fingerprint.bounds.y -or
    [math]::Round($currentBounds.Width) -ne [double]$fingerprint.bounds.width -or [math]::Round($currentBounds.Height) -ne [double]$fingerprint.bounds.height) {
    Send-Fallback 'The inspected control changed since the last inspection. Inspect the active window again.'; exit 0
  }
  $changed = $false
  $actionAttempted = $false
  if ([string]$request.operation -eq 'toggle') {
    if (-not (Test-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern))) { Send-Fallback 'The control no longer supports a toggle action.'; exit 0 }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $expected = if ($request.expected -eq $true) { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
    if ($pattern.Current.ToggleState -notin @([System.Windows.Automation.ToggleState]::On, [System.Windows.Automation.ToggleState]::Off)) { Send-Fallback 'Three-state toggles are not changed by this provider.'; exit 0 }
    if ($pattern.Current.ToggleState -ne $expected) { $actionAttempted = $true; $pattern.Toggle(); $changed = $true }
    if ($element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne $expected) { Send-Fallback 'Windows did not confirm the requested toggle state.' $actionAttempted; exit 0 }
  } else {
    if (-not (Test-ValueWritable $element)) { Send-Fallback 'The control no longer supports a writable value action.'; exit 0 }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $actionAttempted = $true; $pattern.SetValue([string]$request.value); $changed = $true
    if ($element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -cne [string]$request.value) { Send-Fallback 'Windows did not confirm the requested text.' $actionAttempted; exit 0 }
  }
  $result = @{ ok = $true; operation = [string]$request.operation; verified = $true; changed = $changed }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
} catch { Send-Fallback 'The active UI Automation action could not be verified.' $actionAttempted }
