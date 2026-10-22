param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HexiGridCursorCapture {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
  public const int CURSOR_SHOWING = 1;
  public const uint DI_NORMAL = 0x0003;
}
'@
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = $null
try {
  $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
  $cursor = New-Object HexiGridCursorCapture+CURSORINFO
  $cursor.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($cursor)
  if ([HexiGridCursorCapture]::GetCursorInfo([ref]$cursor) -and ($cursor.flags -band [HexiGridCursorCapture]::CURSOR_SHOWING)) {
    $icon = New-Object HexiGridCursorCapture+ICONINFO
    $hotX = 0; $hotY = 0
    if ([HexiGridCursorCapture]::GetIconInfo($cursor.hCursor, [ref]$icon)) {
      $hotX = $icon.xHotspot; $hotY = $icon.yHotspot
      if ($icon.hbmMask -ne [IntPtr]::Zero) { [void][HexiGridCursorCapture]::DeleteObject($icon.hbmMask) }
      if ($icon.hbmColor -ne [IntPtr]::Zero) { [void][HexiGridCursorCapture]::DeleteObject($icon.hbmColor) }
    }
    $device = $graphics.GetHdc()
    try { [void][HexiGridCursorCapture]::DrawIconEx($device, $cursor.ptScreenPos.X - $screen.Left - $hotX, $cursor.ptScreenPos.Y - $screen.Top - $hotY, $cursor.hCursor, 0, 0, 0, [IntPtr]::Zero, [HexiGridCursorCapture]::DI_NORMAL) }
    finally { $graphics.ReleaseHdc($device) }
  }
  $stream = New-Object System.IO.FileStream($OutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $stream.Flush()
} finally {
  if ($stream) { $stream.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
