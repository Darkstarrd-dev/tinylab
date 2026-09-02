# TinyLab build presets
# Usage:
#   ./build.ps1                                  # default: console + browser, no playground
#   ./build.ps1 -Strip                           # + minimal size (stripped symbols)
#   ./build.ps1 -Playground                      # include playground module (build tag)
#   ./build.ps1 -Variant tray                    # tray-resident, hidden console
#   ./build.ps1 -Variant tray -Playground -Strip # tray + playground + minimal size
#   ./build.ps1 -Variant webview                 # tray + native WebView2 window (Win11 runtime preinstalled)
#   ./build.ps1 -Variant debug                   # no flags, full DWARF for dlv
#   ./build.ps1 -All                             # build all 13 variants at once into dist/
#
# Without -All, exactly one variant is produced per invocation (selected by -Variant
# plus -Playground/-Strip toggles). -All ignores -Variant/-Playground/-Strip and
# builds the full matrix: default|tray|webview x {pg,strip} combinations + debug.
#
# All artifacts land in ./dist/ with descriptive names:
#   tinylab.exe                        default console (current behavior)
#   tinylab-pg.exe                     default console + playground
#   tinylab-tray.exe                    tray resident
#   tinylab-tray-pg.exe                tray + playground
#   tinylab-tray-stripped.exe           tray + strip
#   tinylab-tray-pg-stripped.exe       tray + playground + strip
#   tinylab-webview.exe                tray + WebView2 window (pure Go, no CGO)
#   tinylab-webview-pg.exe             tray + WebView2 + playground
#   tinylab-debug.exe                  full DWARF, no stripping, console window
#
# See the 13-artifact matrix at the bottom of this file.

param(
    [ValidateSet("default", "tray", "webview", "debug")]
    [string]$Variant = "default",

    [switch]$Playground,
    [switch]$Strip,
    [switch]$All,

    [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

# --- Ensure rsrc.syso exists (generated from web/static/favicon.ico) -------
# Shared by both single-build and -All paths. Idempotent: re-runs `go generate`
# only when syso is missing OR favicon.ico/rsrc.manifest is newer than syso.
function Invoke-EnsureSyso {
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
}

# --- Core: build one variant ------------------------------------------------
# Inputs: variantName (string), withPg (bool), withStrip (bool).
# Output: writes one .exe into $OutputDir; returns its final size in bytes.
function Invoke-BuildOne {
    param(
        [string]$variant,
        [bool]$withPg,
        [bool]$withStrip
    )

    $tags = @()
    $ldflags = @()

    switch ($variant) {
        "default" { $base = "tinylab" }
        "tray" {
            $tags += "tray"
            $ldflags += "-H windowsgui"
            $base = "tinylab-tray"
        }
        "webview" {
            $tags += "tray", "webview"
            $ldflags += "-H windowsgui"
            $base = "tinylab-webview"
        }
        "debug" { $base = "tinylab-debug" }
    }

    if ($withPg -and $variant -ne "debug") { $tags += "playground" }
    # debug always keeps full DWARF regardless of withStrip.
    if ($withStrip -and $variant -ne "debug") {
        $ldflags += "-s", "-w"
    }

    # Compose output filename: base + [-pg] + [-stripped] + .exe
    $nameParts = @($base)
    if ($withPg -and $variant -ne "debug") { $nameParts += "pg" }
    if ($withStrip -and $variant -ne "debug") { $nameParts += "stripped" }
    $out = ($nameParts -join "-") + ".exe"

    $buildArgs = @("build")
    if ($tags.Count -gt 0) { $buildArgs += "-tags", ($tags -join ",") }
    if ($ldflags.Count -gt 0) { $buildArgs += "-ldflags", ($ldflags -join " ") }
    $buildArgs += "-o", "$OutputDir/$out", "."

    # jchv/go-webview2 is pure Go; all variants work with CGO_ENABLED=0.
    $env:CGO_ENABLED = "0"

    $desc = $variant
    if ($withPg -and $variant -ne "debug")   { $desc += " +pg" }
    if ($withStrip -and $variant -ne "debug") { $desc += " +strip" }
    Write-Host ("Building {0,-22} -> {1}" -f $desc, $out)
    Write-Host ("  tags:    {0}" -f ($tags -join ','))
    Write-Host ("  ldflags: {0}" -f ($ldflags -join ' '))

    & go @buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed for $out"
        exit $LASTEXITCODE
    }

    $size = (Get-Item "$OutputDir/$out").Length
    Write-Host ("Done: {0} ({1:N0} bytes / {2:N2} MB)`n" -f $out, $size, ($size / 1MB))
    return $size
}

# --- Prepare output dir -----------------------------------------------------
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Invoke-EnsureSyso

if ($All) {
    # Full 13-artifact matrix: default|tray|webview x {(none),(pg),(strip),(pg+strip)} + debug only.
    # -Variant/-Playground/-Strip are ignored when -All is set.
    if ($Playground -or $Strip -or $PSBoundParameters.ContainsKey("Variant")) {
        Write-Warning "-All ignores -Variant/-Playground/-Strip; building complete matrix."
    }
    Write-Host "=== Building all 13 variants ===`n"
    $results = @()
    foreach ($v in @("default", "tray", "webview")) {
        $results += Invoke-BuildOne $v $false $false
        $results += Invoke-BuildOne $v $true  $false
        $results += Invoke-BuildOne $v $false $true
        $results += Invoke-BuildOne $v $true  $true
    }
    $results += Invoke-BuildOne "debug" $false $false

    Write-Host "=== Summary ==="
    Get-ChildItem "$OutputDir/*.exe" | Sort-Object Name |
        ForEach-Object {
            $s = $_.Length
            "{0,-40} {1,10:N0} bytes ({2,6:N2} MB)" -f $_.Name, $s, ($s / 1MB)
        }
    Write-Host ("`nTotal: {0} artifacts, {1:N2} MB" -f $results.Count, (($results | Measure-Object -Sum).Sum / 1MB))
} else {
    # Single-variant mode: -Variant + -Playground + -Strip select one artifact.
    Invoke-BuildOne $Variant ([bool]$Playground) ([bool]$Strip)
}

# --- 13-artifact output matrix (for reference) -------------------------------
# | Variant  | PG   | Strip | Output                              |
# |----------|------|-------|-------------------------------------|
# | default  | no   | no    | tinylab.exe                         |
# | default  | yes  | no    | tinylab-pg.exe                      |
# | default  | no   | yes   | tinylab-stripped.exe                |
# | default  | yes  | yes   | tinylab-pg-stripped.exe             |
# | tray     | no   | no    | tinylab-tray.exe                    |
# | tray     | yes  | no    | tinylab-tray-pg.exe                 |
# | tray     | no   | yes   | tinylab-tray-stripped.exe           |
# | tray     | yes  | yes   | tinylab-tray-pg-stripped.exe       |
# | webview  | no   | no    | tinylab-webview.exe                 |
# | webview  | yes  | no    | tinylab-webview-pg.exe              |
# | webview  | no   | yes   | tinylab-webview-stripped.exe        |
# | webview  | yes  | yes   | tinylab-webview-pg-stripped.exe    |
# | debug    | -    | -     | tinylab-debug.exe                   |
