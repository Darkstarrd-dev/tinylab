# gen-icon.ps1 - Generate a multi-size favicon.ico from web/static/logo-sm.png
#
# Embeds 7 sizes (16/24/32/48/64/128/256) into a single ICO container so that
# the .exe icon, taskbar, Alt+Tab, jumplist, and systray all pick a sharp
# resolution matching the current DPI.
#
# Uses only System.Drawing (built into Windows PowerShell 5.1 / pwsh+Win).
# No third-party toolchain required.
#
# Usage:
#   ./gen-icon.ps1                       # default paths
#   ./gen-icon.ps1 -Source web/static/logo-sm.png -Out web/static/favicon.ico

param(
    [string]$Source = "web/static/logo-sm.png",
    [string]$Out    = "web/static/favicon.ico"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)

# --- Load source PNG ----------------------------------------------------------
if (-not (Test-Path $Source)) {
    Write-Error "Source image not found: $Source"
    exit 1
}
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)
Write-Host ("Source: {0}x{1}" -f $src.Width, $src.Height)
if ($src.Width -lt 256 -or $src.Height -lt 256) {
    Write-Warning "Source smaller than 256x256; icons may be blurry at high DPI"
}

# --- Render each size to PNG bytes -------------------------------------------
# ICO format: ICONDIR header (6 bytes) + N x ICONDIRENTRY (16 bytes each)
#              + N x (PNG bytes). Modern ICO allows PNG-encoded entries.
$pngBytesList = New-Object System.Collections.Generic.List[byte[]]
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Flush()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytesList.Add($ms.ToArray())
    $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
}
$src.Dispose()

# --- Assemble ICO file -------------------------------------------------------
# ICONDIR: reserved(2)=0, type(2)=1, count(2)=N
$dir = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter $dir
$bw.Write([uint16]0)                       # reserved
$bw.Write([uint16]1)                       # type = ICO
$bw.Write([uint16]$sizes.Count)            # image count

# Offset to image data = 6 + 16 * count
$dataOffset = 6 + 16 * $sizes.Count

# ICONDIRENTRY per image: width(1), height(1), colors(1)=0, reserved(1)=0,
#                         planes(2)=0, bpp(2)=0, size(4), offset(4)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $png = $pngBytesList[$i]
    $w = if ($s -ge 256) { [byte]0 } else { [byte]$s }   # 256 encoded as 0
    $h = $w
    $bw.Write($w)
    $bw.Write($h)
    $bw.Write([byte]0)                  # colorCount
    $bw.Write([byte]0)                  # reserved
    $bw.Write([uint16]0)                # planes
    $bw.Write([uint16]0)                # bpp (0 = inherit from PNG)
    $bw.Write([uint32]$png.Length)
    $bw.Write([uint32]$dataOffset)
    $dataOffset += $png.Length
}

# Append PNG payloads
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $bw.Write($pngBytesList[$i])
}
$bw.Flush()

# --- Save ----------------------------------------------------------------------
$icoBytes = $dir.ToArray()
$bw.Dispose(); $dir.Dispose()

# Ensure parent dir exists
$parent = Split-Path $Out -Parent
if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
}
[System.IO.File]::WriteAllBytes((Resolve-Path (Get-Location)).Path + "\" + $Out, $icoBytes)

$finalLen = (Get-Item $Out).Length
Write-Host ("Wrote {0}: {1} bytes ({2:N2} KB) with {3} sizes" -f $Out, $finalLen, ($finalLen / 1KB), $sizes.Count)
