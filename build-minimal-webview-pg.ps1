# build-minimal-webview-pg.ps1
#
# Minimal-size build of the Windows and Linux binaries:
#   - TinyRouter_Win11.exe (Windows 11 amd64 / webview + tray + playground)
#   - TinyRouter_Linux     (Linux amd64 / playground)
#
# macOS binaries are built by build_mac.ps1. They intentionally skip UPX so
# the resulting Mach-O files remain suitable for later signing/notarization.
#
# Pipeline: CGO_ENABLED=0, -s -w -buildid=, -gcflags="all=-l", -trimpath.
# UPX is opt-in: packed PE files can be rejected by Windows with
# STATUS_INVALID_PAGE_PROTECTION (0xC0000045).
# Use -Upx only for a controlled, non-release size experiment.

param(
    [string]$OutputDir = "dist",
    [switch]$Upx,
    [switch]$ForceSyso
)

$ErrorActionPreference = "Stop"

# --- Locate UPX --------------------------------------------------------------
$UPX_EXE = $null
foreach ($cand in @(
        (Get-Command upx -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\UPX.UPX_Microsoft.Winget.Source_8wekyb3d8bbwe\upx-5.2.0-win64\upx.exe"
    )) {
    if ($cand -and (Test-Path $cand)) { $UPX_EXE = $cand; break }
}

# --- Ensure rsrc.syso exists --------------------------------------------------
function Invoke-EnsureSyso {
    $needGenerate = $ForceSyso
    if (-not (Test-Path rsrc.syso)) {
        $needGenerate = $true
    } else {
        foreach ($dep in @("web/static/favicon.ico", "rsrc.manifest")) {
            if ((Test-Path $dep) -and
                (Get-Item $dep).LastWriteTime -gt (Get-Item rsrc.syso).LastWriteTime) {
                $needGenerate = $true; break
            }
        }
    }
    if ($needGenerate) {
        Write-Host "Regenerating rsrc.syso from web/static/favicon.ico + rsrc.manifest..."
        & go generate ./...
        if ($LASTEXITCODE -ne 0) {
            Write-Error "go generate failed (install rsrc: go install github.com/akavel/rsrc@latest)"
            exit $LASTEXITCODE
        }
    }
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Invoke-EnsureSyso

$targets = @(
    @{ Name = "TinyRouter_Win11.exe"; GOOS = "windows"; GOARCH = "amd64"; Tags = "tray,webview,playground"; LdFlags = "-H windowsgui -s -w -buildid="; UpxExtra = @() },
    @{ Name = "TinyRouter_Linux";     GOOS = "linux";   GOARCH = "amd64"; Tags = "playground";                LdFlags = "-s -w -buildid=";                UpxExtra = @() }
)

Write-Host "=== Building Windows/Linux minimal binaries ==="

foreach ($t in $targets) {
    $outName = $t.Name
    $outPath = "$OutputDir/$outName"
    $env:CGO_ENABLED = "0"
    $env:GOOS = $t.GOOS
    $env:GOARCH = $t.GOARCH

    Write-Host "`n--- Building $outName ($($t.GOOS)/$($t.GOARCH)) ---"
    $buildArgs = @(
        "build",
        "-tags", $t.Tags,
        "-ldflags", $t.LdFlags,
        "-gcflags", "all=-l",
        "-trimpath",
        "-o", $outPath,
        "."
    )
    & go @buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed for $outName"
        exit $LASTEXITCODE
    }

    $rawSize = (Get-Item $outPath).Length
    Write-Host ("Stripped: {0} ({1:N0} bytes / {2:N2} MB)" -f $outName, $rawSize, ($rawSize / 1MB))

    if ($Upx) {
        if (-not $UPX_EXE) {
            Write-Warning "UPX not found; skipping compression."
        } else {
            $upxArgs = @("--best") + $t.UpxExtra + @($outPath)
            Write-Host ("Packing {0} with UPX..." -f $outName)
            & $UPX_EXE @upxArgs | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $packedSize = (Get-Item $outPath).Length
                $ratio = 1 - ($packedSize / $rawSize)
                Write-Host ("UPX Packed: {0} ({1:N0} bytes / {2:N2} MB, saved {3:P1})" -f $outName, $packedSize, ($packedSize / 1MB), $ratio)
            } else {
                Write-Warning "UPX packing failed for $outName, keeping uncompressed binary."
            }
        }
    }
}

Write-Host "`n=== Final Artifacts Summary in $OutputDir ==="
Get-ChildItem "$OutputDir/TinyRouter_*" | Sort-Object Name |
    ForEach-Object { "{0,-24} {1,11:N0} bytes ({2,6:N2} MB)" -f $_.Name, $_.Length, ($_.Length / 1MB) }
