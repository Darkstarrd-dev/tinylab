# build-max-minimal.ps1
#
# Windows-only maximum-compression build of the FULL-FEATURE binary:
#   tray + webview + playground (all build tags), no functionality removed.
#
# Output: dist\TinyLab_Max.exe
#
# Size pipeline (each step stacks):
#   1. CGO_ENABLED=0            pure-Go toolchain, no libc runtime
#   2. -tags tray,webview,playground   all features compiled in
#   3. -ldflags "-H windowsgui -s -w -buildid="
#        strip symbol table + DWARF + zero buildid
#   4. -gcflags "all=-l -B"     disable inlining & bounds-check elimination
#                               (smaller code object count; same behavior)
#   5. -trimpath                remove absolute paths from binary
#   6. UPX --ultra-brute --lzma extreme PE packing
#
# WARNING (documented in docs/build-variants.md): Windows loader may reject
# some UPX-packed PEs with STATUS_INVALID_PAGE_PROTECTION (0xC0000047 /
# 0xC0000045) -> "app can't run". This script is for size experiments /
# controlled distribution, NOT the recommended release artifact
# (use ./build-minimal-webview-pg.ps1 without -Upx for releases).
#
# Usage:
#   ./build-max-minimal.ps1                 # max compression (slow: ultra-brute)
#   ./build-max-minimal.ps1 -Fast           # skip --ultra-brute (--best --lzma only)
#   ./build-max-minimal.ps1 -OutputDir dist

param(
    [string]$OutputDir = "dist",
    [switch]$Fast
)

$ErrorActionPreference = "Stop"

# --- Locate UPX ---------------------------------------------------------------
$UPX_EXE = $null
foreach ($cand in @(
        (Get-Command upx -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\UPX.UPX_Microsoft.Winget.Source_8wekyb3d8bbwe\upx-5.2.0-win64\upx.exe"
    )) {
    if ($cand -and (Test-Path $cand)) { $UPX_EXE = $cand; break }
}
if (-not $UPX_EXE) {
    Write-Error "UPX not found. Install: winget install UPX.UPX"
    exit 1
}

# --- Ensure rsrc.syso exists (icon/manifest resource, shared convention) ------
$needGenerate = $false
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

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

# --- Build: full features, minimum compile-time size ---------------------------
$outName = "TinyLab_Max.exe"
$outPath = Join-Path $OutputDir $outName

$env:CGO_ENABLED = "0"
$env:GOOS = "windows"
$env:GOARCH = "amd64"

Write-Host "=== Building $outName (windows/amd64, tray+webview+playground) ==="
$buildArgs = @(
    "build",
    "-tags", "tray,webview,playground",
    "-ldflags", "-H windowsgui -s -w -buildid=",
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

# --- Pack: UPX extreme ----------------------------------------------------------
$packArgs = @("--best", "--lzma")
if (-not $Fast) { $packArgs += "--ultra-brute" }
Write-Host ("Packing with UPX ({0})..." -f ($packArgs -join ' '))
& $UPX_EXE @packArgs $outPath
if ($LASTEXITCODE -ne 0) {
    Write-Warning "UPX packing failed (exit $LASTEXITCODE); keeping UNPACKED binary."
    exit 0
}

# --- Verify: UPX self-test + report ---------------------------------------------
& $UPX_EXE --test $outPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "UPX --test FAILED on $outPath; packed image is corrupt. Rebuild without packing."
    exit $LASTEXITCODE
}

$packedSize = (Get-Item $outPath).Length
$ratio = 1 - ($packedSize / $rawSize)
Write-Host ""
Write-Host ("Final: {0}" -f $outPath)
Write-Host ("  before pack: {0:N0} bytes ({1:N2} MB)" -f $rawSize, ($rawSize / 1MB))
Write-Host ("  after  pack: {0:N0} bytes ({1:N2} MB), saved {2:P1}" -f $packedSize, ($packedSize / 1MB), $ratio)
