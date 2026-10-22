param([Parameter(Mandatory = $true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HexiGridNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, MIDDLEDOWN=0x0020, MIDDLEUP=0x0040, KEYUP=0x0002, UNICODE=0x0004, MOUSEWHEEL=0x0800;

  public static uint Click(uint down, uint up) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type=INPUT_MOUSE; inputs[0].data.mouse.dwFlags=down;
    inputs[1].type=INPUT_MOUSE; inputs[1].data.mouse.dwFlags=up;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Press(ushort key) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type=INPUT_KEYBOARD; inputs[0].data.keyboard.wVk=key;
    inputs[1].type=INPUT_KEYBOARD; inputs[1].data.keyboard.wVk=key; inputs[1].data.keyboard.dwFlags=KEYUP;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint TypeText(string text) {
    INPUT[] inputs = new INPUT[text.Length * 2];
    for (int i=0; i<text.Length; i++) {
      inputs[i*2].type=INPUT_KEYBOARD; inputs[i*2].data.keyboard.wScan=text[i]; inputs[i*2].data.keyboard.dwFlags=UNICODE;
      inputs[i*2+1].type=INPUT_KEYBOARD; inputs[i*2+1].data.keyboard.wScan=text[i]; inputs[i*2+1].data.keyboard.dwFlags=UNICODE | KEYUP;
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Scroll(int steps) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type=INPUT_MOUSE; inputs[0].data.mouse.mouseData=unchecked((uint)(steps * 120)); inputs[0].data.mouse.dwFlags=MOUSEWHEEL;
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$input = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$before = New-Object HexiGridNativeInput+POINT
$after = New-Object HexiGridNativeInput+POINT
if (-not [HexiGridNativeInput]::GetCursorPos([ref]$before)) { throw 'Windows could not read the current cursor position.' }
$eventsSent = 0
switch ([string]$input.kind) {
  'mouse.move' {
    if (-not [HexiGridNativeInput]::SetCursorPos([int]$input.x, [int]$input.y)) { throw 'Windows refused the cursor move.' }
    if (-not [HexiGridNativeInput]::GetCursorPos([ref]$after) -or $after.X -ne [int]$input.x -or $after.Y -ne [int]$input.y) { throw 'Windows did not apply the cursor move.' }
  }
  'mouse.click' {
    $down = 0; $up = 0
    if ($input.button -eq 'left') { $down=[HexiGridNativeInput]::LEFTDOWN; $up=[HexiGridNativeInput]::LEFTUP }
    elseif ($input.button -eq 'right') { $down=[HexiGridNativeInput]::RIGHTDOWN; $up=[HexiGridNativeInput]::RIGHTUP }
    elseif ($input.button -eq 'middle') { $down=[HexiGridNativeInput]::MIDDLEDOWN; $up=[HexiGridNativeInput]::MIDDLEUP }
    else { throw 'Unsupported mouse button.' }
    $eventsSent = [HexiGridNativeInput]::Click($down, $up)
    if ($eventsSent -ne 2) { throw "Windows accepted only $eventsSent of 2 mouse events." }
  }
  'mouse.scroll' {
    $eventsSent = [HexiGridNativeInput]::Scroll([int]$input.steps)
    if ($eventsSent -ne 1) { throw "Windows accepted only $eventsSent of 1 scroll event." }
  }
  'key.press' {
    $eventsSent = [HexiGridNativeInput]::Press([UInt16]$input.keyCode)
    if ($eventsSent -ne 2) { throw "Windows accepted only $eventsSent of 2 keyboard events." }
  }
  'text.type' {
    $eventsSent = [HexiGridNativeInput]::TypeText([string]$input.text)
    $expected = ([string]$input.text).Length * 2
    if ($eventsSent -ne $expected) { throw "Windows accepted only $eventsSent of $expected text events." }
  }
  default { throw 'Unsupported computer input.' }
}
if (-not [HexiGridNativeInput]::GetCursorPos([ref]$after)) { throw 'Windows could not verify the cursor position after input.' }
[pscustomobject]@{
  ok = $true
  kind = [string]$input.kind
  eventsSent = $eventsSent
  cursorBefore = @{ x = $before.X; y = $before.Y }
  cursorAfter = @{ x = $after.X; y = $after.Y }
} | ConvertTo-Json -Compress
