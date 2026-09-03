---
name: tinylab-config
description: "TinyLab config handling: auto-migration of removed fields with strict typo detection, and partial-merge pitfalls for PATCH /api/settings sub-objects."
---

# TinyLab Config & Startup


## config-auto-migration


### TinyLab Config Auto-Migration for Removed Fields

Use when removing a field from a strict-YAML `Config` struct and old `config.yaml` files must not block startup.

#### Problem

`yaml.Decoder.KnownFields(true)` rejects unknown fields. Removing a struct field (e.g. `DownloadConfig.Proxy`) makes every old config fail with `field proxy not found in type config.DownloadConfig`.

#### Solution

Add a `decodeConfig` fallback in `internal/config/persistence.go`:

1. Try strict decode first. If it succeeds → no migration needed.
2. On strict failure, lenient-parse the raw bytes into `map[string]any`.
3. Strip known-deprecated field paths via `stripPaths(root, deprecatedFieldPaths)`.
4. Re-marshal the cleaned map, then strict-decode into `Config`.
5. If stripping + re-decode succeeds → mark `migrated=true` so `Load` persists the cleaned config back to disk (best-effort).
6. If stripping doesn't explain the error (genuine typo like `portt`) → surface the original strict error unchanged.

#### Key Design Points

- **Targeted stripping**: Only remove fields listed in `deprecatedFieldPaths` (a `[][]string` of map-key paths). A typo like `portt` is NOT in the list, so it still errors — preserving the typo-catching contract.
- **One-way migration**: The deprecated field is removed from the struct entirely (not retained with a deprecation warning). Old configs auto-upgrade on first successful load.
- **Best-effort save**: `Load` calls `Save(path, finalized)` only when `migrated=true`; a write failure does not block startup.
- **No struct pollution**: The removed field stays out of the struct. `getSettings`/`updateSettings` do not mention it.

#### Where to Add a New Deprecated Field

In `internal/config/persistence.go`:
- Append the path to `deprecatedFieldPaths`, e.g. `{"section", "fieldName"}`.
- Update the `config-registry-state-architecture.md` 最后核对 note.

#### Test Contract

`TestLoad_UnknownFieldStillErrors` (or equivalent) must still pass: a config with a genuine unknown field must still fail strict decode after the migration fallback.

#### Example: `download.proxy`

```go
var deprecatedFieldPaths = [][]string{
    {"download", "proxy"},
}
```

After migration, old `config.yaml` files have `download.proxy` stripped and re-saved without it. New configs use `download.useProxy` (bool) + the global `Proxy` config, resolved via `config.ResolveDownloadProxy`.

## tinylab-config-deprecated-field-migration


### TinyLab: removing a config field without breaking old config.yaml

#### Context
`config.Load` (internal/config/persistence.go) uses `yaml.NewDecoder` + `dec.KnownFields(true)` — strict. Removing a field from a struct makes old config.yaml files that still carry that key fail with `field X not found in type ...` at startup.

There are TWO documented patterns. Pick by semantics:

#### Pattern A — retain + warn (for fields that are inert/ignored)
Used historically for `MonitorConfig.Enabled` (v1.8.0). **Keep the field in the struct** (marked deprecated), and emit a deprecation warning in `finalizeConfig` (defaults.go). Strict parse still accepts it (field exists), behavior is inert. Documented in `config-registry-state-architecture.md` §7. Use when the old value carries no meaningful new behavior and you just want it to not error.

#### Pattern B — auto-migrate strip (preferred when semantics changed and you don't want the old field lingering)
Used for `download.proxy` (2026-07-30, replaced by `UseProxy` referencing the global upstream proxy). **Delete the field from the struct**, and add the field path to `deprecatedFieldPaths` in `persistence.go`. `decodeConfig` does:
1. strict decode (KnownFields true) → if ok, done.
2. on failure: lenient-decode into `map[string]any`, `stripPaths(root, deprecatedFieldPaths)`, re-marshal, strict-decode the cleaned bytes. If that succeeds → `migrated=true`, caller `Save`s the cleaned config back to disk.
3. if strip didn't remove anything OR strict still fails after strip → return the original strict error (so genuine typos like `portt` still surface).

`deprecatedFieldPaths` is `[][]string` (e.g. `{{"download","proxy"}}`); add new removed-field paths here as a list, don't special-case.

#### Critical constraints
- Pattern B preserves the typo-detection contract: `TestLoad_UnknownFieldStillErrors` (config_compat_test.go) asserts a typo like `portt` still errors. Do NOT use a blanket lenient fallback — it silently drops typos and breaks that test.
- The intermediate `yaml.Marshal(map[string]any)` is only for re-decode; the disk write is done by `Save(path, cfg)` which marshals the Config struct (canonical order, no comments — consistent with every other save). So reformatting is not a regression.
- finalizeConfig must still run on the migrated cfg before save.
- `state.yaml` uses lenient `yaml.Unmarshal` already (state.go) — no migration needed there; only `config.yaml` is strict.

#### When to update docs
- `docs/config-registry-state-architecture.md`: update the §4 struct field table (remove old field / add new), add a dated 最后核对 note describing the migration, and note the deviation from Pattern A if you chose Pattern B. The §7 "废弃字段向后兼容" paragraph historically says "future deletions follow Pattern A (retain+warn)" — a Pattern B deviation is documented in the latest dated note, which supersedes for that specific field.
- PROJECT_MAP.md §config types row + persistence.go row if the change is structural.

## tinylab-settings-partial-merge-pitfall


### TinyLab Settings PATCH — Partial-Merge Pitfall

#### Problem
`internal/api/settings/register.go::updateSettings` historically merged `Download *config.DownloadConfig` (a pointer to the whole struct). Go JSON unmarshal fills omitted fields with zero values, and the merge did `cfg.Download.YtDlpPath = updates.Download.YtDlpPath` (etc.) unconditionally — so a caller sending only `{defaultDir, ffmpegPath}` would **clear** ytDlpPath and every other string field.

This was latent while only ONE caller (the download popup) sent the same field set. It becomes a real regression the moment a second UI context sends a *different subset* (e.g. Gallery Edit sends only defaultDir+ffmpegPath; Settings page sends all 5).

#### Fix pattern — presence-aware pointer sub-struct
Replace the whole-struct field with an inline sub-struct of pointer fields, mirroring how the `Trace` update block already works:

```go
Download *struct {
    YtDlpPath           *string `json:"ytDlpPath"`
    FfmpegPath          *string `json:"ffmpegPath"`
    DefaultDir          *string `json:"defaultDir"`
    UseProxy            *bool   `json:"useProxy"`
    BrowserCookies      *string `json:"browserCookies"`
    CookiesPath         *string `json:"cookiesPath"`
    ConcurrentFragments *int    `json:"concurrentFragments"`
    MaxConcurrent       *int    `json:"maxConcurrent"`
} `json:"download"`
```
Merge: `if updates.Download.X != nil { cfg.Download.X = *updates.Download.X }` for each.

The frontend then sends ONLY the fields visible in its popup context; omitted fields are untouched. `nil` = "leave unchanged"; `*ptr` = "set (empty string = clear)".

#### Stale-read trap when extracting a push helper
If you extract a `pushDownloadSettings()` helper that re-fetches config via `h.d.Reg.Config()`, it reads the **registry's committed copy**, NOT the local `cfg` being mutated in `updateSettings` (which is only persisted by `SaveConfigAndReload` at the end). So the push would ship stale values.

`Registry.Config()` returns a `config.Config` **value (copy)**, not a pointer. Fix: pass the local mutated cfg into the helper:

```go
func (h *Handler) pushDownloadSettings(cfg config.Config) { ... }
// call sites inside updateSettings:
h.pushDownloadSettings(cfg)   // after Proxy branch AND after Download branch
```

Call it from BOTH the Proxy branch and the Download branch — changing the upstream proxy must also re-resolve the download's derived proxy URL.

#### Shared resolve helpers + circular import
`app` imports `api`, so `api/settings` cannot import `app`. Put path-resolution helpers (`ResolveDownloadProxy`, `ResolveTraceDir`) in package `config` (e.g. `internal/config/paths.go`) so both `app` (composition root) and `api/settings` (runtime update) call the same logic.

#### Smoke verification
- PATCH `{download:{defaultDir,ffmpegPath}}` only → GET, assert ytDlpPath preserved.
- PATCH `{trace:{logDir:"x"}}` → GET `/api/traces/dates` echoes the new dir (proves SetRequestLogDir repointed at runtime).

