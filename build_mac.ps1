# build_mac.ps1
#
# Build unsigned, uncompressed macOS command-line binaries for both CPU
# architectures. The outputs are raw Mach-O executables, not .app bundles.
#
#   - TinyRouter_Darwin_arm64  (Apple Silicon)
#   - TinyRouter_Darwin_amd64  (Intel, reported by macOS as x86_64)
#
# Usage:
#   ./build_mac.ps1
#   ./build_mac.ps1 -OutputDir dist

param(
    [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$outDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path $repoRoot $OutputDir
}

if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

$legacyDarwinPath = Join-Path $outDir "TinyRouter_Darwin"
if (Test-Path $legacyDarwinPath) {
    Remove-Item $legacyDarwinPath -Force
    Write-Host "Removed legacy Darwin artifact: $legacyDarwinPath"
}

$targets = @(
    @{ Name = "TinyRouter_Darwin_arm64"; GOARCH = "arm64" },
    @{ Name = "TinyRouter_Darwin_amd64"; GOARCH = "amd64" }
)

$oldGoOS = $env:GOOS
$oldGoArch = $env:GOARCH
$oldCgoEnabled = $env:CGO_ENABLED

try {
    Push-Location $repoRoot
    foreach ($target in $targets) {
        $outPath = Join-Path $outDir $target.Name
        $env:GOOS = "darwin"
        $env:GOARCH = $target.GOARCH
        $env:CGO_ENABLED = "0"

        Write-Host "Building $($target.Name) (darwin/$($target.GOARCH))..."
        $buildArgs = @(
            "build",
            "-tags", "playground",
            "-trimpath",
            "-ldflags", "-s -w -buildid=",
            "-o", $outPath,
            "."
        )
        & go @buildArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed for $($target.Name)"
        }

        $size = (Get-Item $outPath).Length
        Write-Host ("Done: {0} ({1:N0} bytes / {2:N2} MB)" -f $target.Name, $size, ($size / 1MB))
    }
} finally {
    Pop-Location
    if ($null -eq $oldGoOS) { Remove-Item Env:GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $oldGoOS }
    if ($null -eq $oldGoArch) { Remove-Item Env:GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $oldGoArch }
    if ($null -eq $oldCgoEnabled) { Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue } else { $env:CGO_ENABLED = $oldCgoEnabled }
}

Write-Host "`nUnsigned macOS binaries written to $outDir"
