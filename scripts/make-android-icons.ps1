# One-shot Android launcher icon regenerator (Windows / System.Drawing).
# Rebuilds the full mipmap set for the Tauri Android project from
# packages/app/src-tauri/icons/icon.png — the desktop icon (dark rounded rect
# + light Pi mark at 61% of the canvas).
#
# Usage: powershell -File scripts/make-android-icons.ps1
#
# Why this exists (mirrors dsh-app/scripts/make-android-icons.ps1):
# tauri icon's own Android output is not controllable — its legacy
# ic_launcher.png renders the mark at ~53% of the canvas while the desktop
# icon shows it at 61%, so the launcher icon looks smaller than the desktop.
# This script regenerates:
#   - ic_launcher.png            — the desktop icon resized as-is (mark 61%,
#                                 rounded rect + transparent corners kept)
#   - ic_launcher_round.png      — same, circle-masked
#   - ic_launcher_foreground.png — the Pi mark alone (alpha>=250 bright
#                                 pixels, so the rounded-rect AA edge and the
#                                 dark tile are excluded) at 40% of the
#                                 canvas, centered: after the launcher mask
#                                 crops the outer ~1/3, the mark reads at
#                                 ~65% of the visible icon, matching the
#                                 desktop look.
#
# GDI+ (System.Drawing) is used: same interp as dsh, no chroma-keying.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $ROOT 'packages\app\src-tauri\icons\icon.png'

# ---- extract the Pi mark: opaque (alpha>=250) bright pixels ----
$src = [System.Drawing.Bitmap]::FromFile($iconPath)
$w = $src.Width
$h = $src.Height
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
$keep = [System.Collections.Generic.List[object]]::new()
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $p = $src.GetPixel($x, $y)
    if ($p.A -ge 250 -and $p.R -ge 240 -and $p.G -ge 240 -and $p.B -ge 240) {
      $keep.Add(@($x, $y))
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw 'no Pi mark found in icon.png' }
$mw = $maxX - $minX + 1
$mh = $maxY - $minY + 1
$crop = New-Object System.Drawing.Bitmap($mw, $mh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
foreach ($pt in $keep) {
  $p = $src.GetPixel($pt[0], $pt[1])
  $crop.SetPixel($pt[0] - $minX, $pt[1] - $minY, [System.Drawing.Color]::FromArgb(255, $p.R, $p.G, $p.B))
}
$src.Dispose()
Write-Host "Pi mark bbox: ${mw}x$mh ($([math]::Round($mw / 512 * 100))% of the desktop icon)"

$legacySizes = @{ 48 = 'mdpi'; 72 = 'hdpi'; 96 = 'xhdpi'; 144 = 'xxhdpi'; 192 = 'xxxhdpi' }
$fgSizes = @{ 108 = 'mdpi'; 162 = 'hdpi'; 216 = 'xhdpi'; 324 = 'xxhdpi'; 432 = 'xxxhdpi' }
$fgMarkRatio = 0.367 # mark width as a fraction of the foreground canvas (~= desktop 56% after the ~35% mask crop)

function Write-Png($canvas, $outPath) {
  New-Item -ItemType Directory -Force (Split-Path $outPath) | Out-Null
  $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Write-Scaled($source, $outPath, $size) {
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()
  Write-Png $canvas $outPath
  $canvas.Dispose()
}

function Write-CircleMasked($source, $outPath, $size) {
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  # circular mask: zero alpha outside the inscribed circle
  $cx = ($size - 1) / 2; $cy = ($size - 1) / 2; $r = $size / 2
  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $dx = $x - $cx; $dy = $y - $cy
      if ($dx * $dx + $dy * $dy -gt $r * $r) {
        $canvas.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
    }
  }
  $g.Dispose()
  Write-Png $canvas $outPath
  $canvas.Dispose()
}

function Write-Foreground($mark, $outPath, $size) {
  $tW = [math]::Round($size * $fgMarkRatio)
  $tH = [math]::Round($tW * $mark.Height / $mark.Width)
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $ox = [math]::Round(($size - $tW) / 2); $oy = [math]::Round(($size - $tH) / 2)
  $g.DrawImage($mark, (New-Object System.Drawing.Rectangle($ox, $oy, $tW, $tH)))
  $g.Dispose()
  Write-Png $canvas $outPath
  $canvas.Dispose()
}

$resDirs = @(
  (Join-Path $ROOT 'packages\app\src-tauri\gen\android\app\src\main\res'),
  (Join-Path $ROOT 'packages\app\src-tauri\icons\android')
)

$icon = [System.Drawing.Bitmap]::FromFile($iconPath)
$genRes = $resDirs[0]
foreach ($res in $resDirs) {
  foreach ($size in $legacySizes.Keys) {
    $d = "mipmap-$($legacySizes[$size])"
    Write-Scaled $icon (Join-Path $res "$d\ic_launcher.png") $size
    Write-CircleMasked $icon (Join-Path $res "$d\ic_launcher_round.png") $size
  }
  foreach ($size in $fgSizes.Keys) {
    $d = "mipmap-$($fgSizes[$size])"
    Write-Foreground $crop (Join-Path $res "$d\ic_launcher_foreground.png") $size
  }
  # keep the adaptive-icon background bitmaps (dark tile) in sync with the build dir
  if ($res -ne $genRes) {
    foreach ($size in $legacySizes.Keys) {
      $d = "mipmap-$($legacySizes[$size])"
      $bg = Join-Path $genRes "$d\ic_launcher_background.png"
      if (Test-Path $bg) { Copy-Item $bg (Join-Path $res "$d\ic_launcher_background.png") -Force }
    }
  }
  Write-Host "wrote mipmaps for $res"
}
$icon.Dispose()
$crop.Dispose()
Write-Host 'done'