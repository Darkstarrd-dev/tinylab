---
name: tinylab-usage-monitor
description: "TinyLab Usage/Monitor page: quota monitor architecture, exhausted-key display, in-flight initial display, latency/speed blank cells, and Monitor/Terminal removal audit."
---

# TinyLab Usage / Monitor Page


## tinylab-usage-page-architecture


### TinyLab Usage/Monitor Page (`web/static/usage.js`)

Vanilla JS SPA module (~1635 lines), no framework, no `'use strict'`; module-level `var` globals. The nav label is **Monitor** (renamed from Usage). Loaded as a plain `<script>`, so function declarations are global — inline `onclick="..."` handlers call them directly (see IIFE caveat below).

#### Data flow & refresh lifecycle
- `renderUsage(c)` — initial render; `refreshQuotaData()` — periodic (~5s) + SSE-triggered via `scheduleQuotaRefresh()` (300ms debounce; SSE `usage-updated`/`key-inflight` → `applyUsageSSEHandlers`).
- **Both call `mergeUsageEntries(apiEntries)`** — the single shared dedup/merge function (defined once, before `renderUsage`). It: builds `apiIds`; indexes `lastUsageEntries` by id into a Map (O(n), **not** `.find()` per entry — that was the old O(n²)); dedups preferring the terminal ring entry over a duplicate inflight; copies `__streamingReasoning/__streamingAssistant/__streamingUsage` buffers; merges live `inflightEntries` (drops ones > `MAX_PROCESSING_MS`); cleans inflight for terminal entries; `sortEntriesByTimeDesc`; retains up to `MAX_PRESERVED_TERMINAL` ring-evicted terminal entries; re-sorts; commits `lastUsageEntries`; returns merged. **Do not re-duplicate this logic in the two callers.**
- Globals it relies on (all pre-existing): `lastUsageEntries`, `inflightEntries`, `MAX_PROCESSING_MS`, `MAX_PRESERVED_TERMINAL`, `sortEntriesByTimeDesc`.

#### Quota Monitor table (`updateQuotaTable(bars)`)
- Main rows live in `quotaBarItems[key]` (`key = provider + '/' + model`). **Sub-rows are DOM SIBLINGS of the main row (class `quota-key-row` + `data-parent=key`), NOT children.** Any reorder must move the main row + its sub-row group together, or sub-rows get orphaned.
- Structure: **Pass 1** patches existing rows + creates new ones detached (no DOM moves). Then drop stale `.quota-empty` placeholders. **Pass 2** computes `liveMain` (tbody children minus `quota-key-row`/`quota-empty`); if its order != `orderedKeys` order, build a `DocumentFragment` and append each main row + its `querySelectorAll('.quota-key-row[data-parent=key]')` siblings, then `tbody.appendChild(frag)` — one reflow, group stays intact. Steady state = **0 DOM moves**.
- Sub-row lifecycle: created by `toggleQuotaRowExpand` (from `keyDetailCache`), updated on data change by `fetchModelKeyDetail → renderQuotaKeyRowsInto`. `updateQuotaTable` does NOT rebuild sub-rows each cycle (that was removed — it caused per-cycle churn).
- Empty state: `<tr class="quota-empty">…t('noQuota')…</tr>` — the `quota-empty` class is how Pass 2 detects/clears stale placeholders.
- Removed rows: cleanup loop also removes their sub-rows.

#### Sub-row insertion loop contract (IMPORTANT — was a hang bug)
`toggleQuotaRowExpand` (cache branch) and `renderQuotaKeyRowsInto` both build sub-row `<tr>` HTML via `renderQuotaKeyRows`, set `tmp.innerHTML = html` on a detached `<tbody>`, then move each child into the live DOM after the previous one. The correct pattern (post-fix):

```js
var parent = el;
while (tmp.firstElementChild) {
  var node = tmp.firstElementChild;        // capture BEFORE moving
  node.setAttribute('data-parent', key);
  parent.parentNode.insertBefore(node, parent.nextSibling);
  parent = node;                            // parent = the node just moved (now in live DOM)
}
```

**NEVER** write `parent = tmp.firstElementChild` after the `insertBefore`. `insertBefore(tmp.firstElementChild, …)` moves that child OUT of `tmp`, so `tmp.firstElementChild` then refers to the NEXT pending child — assigning it to `parent` makes the next iteration's `parent.parentNode` be `tmp` itself, so `insertBefore(node, node.nextSibling)` becomes a no-op inside `tmp`, the node never leaves, and `tmp.firstElementChild` never becomes null → **synchronous infinite loop**. This hangs the renderer (webview unrecoverable, must restart; the stale "加载中……" frame stays painted). It only triggers with **≥2 sub-rows** (multi-key provider); a single sub-row runs one iteration and terminates, so single-key providers never exhibited the bug. This was introduced by the bars→table refactor (`2e21abd`) which switched from `wrap.innerHTML = html` (one-shot) to per-row `insertBefore`; the old bar layout was immune. If you re-introduce a per-row insertion loop, capture the node before moving it.

#### Per-key detail fetching
- `KEY_DETAIL_TTL = 3000`. `refreshAllKeyDetails()` is TTL-throttled (`_lastPerKeyRefresh`); it **skips collapsed rows** (`!expandedModels.has(setKey)`) AND **rows with fresh cache** (`keyDetailCache[key].ts < TTL`) — so a row just fetched (e.g. freshly expanded) isn't re-requested next tick.
- `toggleQuotaRowExpand` calls `fetchModelKeyDetail(provider, model)` **directly, bypassing TTL** — correct for user-initiated expand (immediate fetch). Do NOT route expand through the throttled `refreshAllKeyDetails` or the expanded row stalls on "Loading…" within the TTL window.

#### i18n conventions (see also skill `tinylab-i18n-t-function-xss-semantics`)
- `t(key)` returns raw msg (key string if missing — truthy, so `t(k) || 'fallback'` never fires). `t(key, [args])` escapes string args via `tEscapeHtml` internally → safe to drop into `innerHTML` directly (do NOT also wrap in `escapeHtml` or you double-escape).
- `renderInfoSection(title, data)` escapes its title arg internally (info_common.js) — pass `t(...)` raw. For **inline HTML** section titles (built into an `innerHTML` string), wrap: `escapeHtml(t('infoXxx'))`.
- `.replace('{0}', x)` (manual) and `t()`'s internal `.replace('{i}', x)` both have the `$&`/`$$` replacement-pattern quirk — benign display glitch, not XSS.
- Info Modal + loadFailed keys (EN+ZH in `web/static/i18n.js`, near `failed:`): `loadFailed, infoRequestInfo, infoRequestBody, infoRequestHeaders, infoResponseBody, infoResponseHeaders, infoStatus, infoTraceDetail, infoLoadingTrace, infoReasoning, infoAssistantMsg, infoUsage, infoContent, infoTokenStats, infoThinking, infoWaiting, infoCopy, infoCopied, infoTraceNA`.

#### Dead code (removed — do not reintroduce)
`lastUsageSig`, `lastQuotaSig`, `showUsageEntryInfo(ts)` (timestamp variant; the live path is `showUsageEntryInfoById(id)` → `showUsageEntryInfoWithData(e)`), `openRecentRequests`/`closeRecentRequests`/`updateRecentRequestsModal`/`clearUsageFromModal` (recent-requests modal was abandoned; inline list is `updateRecentRequestsInline`).

#### Verifying frontend changes
1. `node --check web/static/usage_quota.js` — parse-only (file uses browser globals; won't execute).
2. `go build -o <exe> .` — confirms embed FS compiles.
3. Smoke-test the binary **isolated** (don't clobber the user's `config.yaml`): temp dir + `config.yaml` containing `port:` + a multi-key provider (provider needs a `prefix` or it's skipped; empty prefix logs "skipping"). Strict YAML rejects unknown fields. The console build auto-opens the default browser (non-blocking). Run via `hub start` with `ready:{log:"starting on http",port,timeout:30}`.
4. Seed a quota bar: POST `/v1/chat/completions` with `model: "<prefix>/<modelId>"` — it 502s upstream but registers the model in usage stats so `/api/usage/quotas` returns a bar.
5. Headless browser: open `http://127.0.0.1:<port>/`, click **Monitor**, wait ~1.3s. Assert: `#quota-tbody` has main rows; multi-key rows show a chevron. NOTE: this harness runs `page.evaluate` in an **isolated world** — main-world globals (`renderUsage`, `expandedModels`, `t`) are NOT visible to `page.evaluate`; inject a `<script>` element (runs in main world) and communicate results back via a DOM attribute (`document.body.setAttribute('data-xxx', …)`) read by isolated-world `page.evaluate`. `page.on('console')` does NOT capture main-world logs here.
6. To exercise the expand path: either click `#quota-tbody .quota-row` (real flow, fetch + `renderQuotaKeyRowsInto`) or isolate `renderQuotaKeyRowsInto` directly with crafted data after clearing timers (`usagePeriodicTimer`, `lockCountdownInterval`, `processingTimer`) and closing `usageEventSource` so periodic refresh can't interfere. Guard each `page.evaluate` with `Promise.race([... , setTimeout(rej('HANG'), N)])` — a hung renderer makes the evaluate never resolve. The pre-fix multi-key expand hung the renderer (reads timed out); post-fix it renders N sub-rows and stays responsive.
7. i18n check: `document.documentElement.setAttribute('data-lang','cn')`, re-render, assert `t('loadFailed')`/`t('infoTraceDetail')` etc. resolve to Chinese (not the raw key).

#### IIFE/namespace caveat (Phase 4 of the fix plan, NOT done)
`toggleQuotaRowExpand`, `showUsageEntryInfoById`, `copyStreamingText`, `resetQuotaTimers`, `closeUsageEntryInfo`, `clearUsageFromModal` (if reintroduced) are invoked from **inline `onclick="…"`** in rendered HTML strings. Wrapping usage.js in an IIFE namespace breaks these unless every inline handler is first migrated to `addEventListener` binding. File-split (§4.1) is safe; the IIFE encapsulation (§4.2) is the risky half.

## tinylab-quota-exhausted-key-display


### TinyLab Quota Monitor — Exhausted Key Handling

#### Problem solved
After app restart, `QuotaTracker` (memory) and `ModelQuotas` (not persisted wholesale) are empty, so the provider-level `TotalUsed`/`TotalCapacity` no longer counts exhausted keys — making "used" reflect only the currently-active key. Additionally the expanded per-key list showed exhausted keys (misleading) and the quota cell only showed `used/capacity` with no success/failure counts.

#### Architecture decisions (2026-07-31)

##### Persistence: lightweight, NOT wholesale `ModelQuotas`
- `internal/state/state.go` `KeySnapshot` gained `ExhaustedModelLimits map[string]int` (yaml `exhausted_model_limits,omitempty`).
- `registry/state.go::snapshotKeyState` saves ONLY entries where `ModelQuotas[m].ModelLimit > 0 && ModelRemaining == 0` (model→ModelLimit). Partial-usage snapshots are NOT persisted — they're re-fetched live on next probe/request.
- `RestoreKeyState` writes them back into `ModelQuotas[m] = &QuotaInfo{ModelLimit: lim, ModelRemaining: 0, LastUpdated: time.Time{}}` BUT only when `state.ModelQuotas[m] == nil` — never clobbers a fresh live probe entry restored/updated during the same session.

##### Why no timezone problem
`ExhaustedModelLimits` stores only `model→limit`, no timestamps. `ModelLocks` (already persisted) holds the CST 00:05 unlock time; the server's timezone decides when the lock clears. After unlock, next probe repopulates `ModelQuotas` with `Remaining > 0`, and the next `snapshotKeyState` drops it from `ExhaustedModelLimits` (condition `Remaining==0` no longer holds). So cross-timezone upstream access works correctly.

##### getQuotas recompute
`internal/api/usage/register.go::getQuotas` now recomputes `TotalUsed`/`TotalCapacity` per bar from per-key `KeyRuntimeState.ModelQuotas` via lock-safe `st.GetQuota(model)` (NOT manual locking — `GetQuota` takes the state lock internally; manual locking after `Lock()` would deadlock per the non-reentrant `sync.Mutex`). It overwrites `QuotaTracker`'s in-session aggregates. Logic:
```
for each bar, find matching provider, for each IsActive key:
  q = GetKeyState(...).GetQuota(bar.Model)
  if q != nil && q.ModelLimit > 0:
    totalCapacity += q.ModelLimit
    totalUsed += q.ModelLimit - q.ModelRemaining  # exhausted (Remaining=0) contributes full ModelLimit
if totalCapacity > 0: bar.TotalCapacity/TotalUsed/HasQuota = recomputed
```
After restart, `QuotaTracker` is empty so bars come only from `ModelStats` (also empty until a request arrives). The persistence only helps once a request for that model comes in (creates a bar) — then `getQuotas` recomputes and the restored exhausted `ModelQuotas` (Remaining=0) gets counted. This matches the design "在重试的时候获取数据" — no auto-probe on startup; data converges as requests arrive.

#### Frontend (`web/static/usage_quota.js` + `style.css`)

##### Exhausted key filter
`renderQuotaKeyRows` skips keys where `data.hasQuota && k.hasQuota && k.modelRemaining === 0` at the top of the `data.keys.forEach` callback. After the loop, if `rows === ''` and `data.hasQuota`, returns a `noKeysConfigured` empty row (colspan=8).

##### Cell format (Option A — "success/capacity + error badge")
New `formatQuotaCell(bar)` helper:
- Limited (`hasQuota`): `<span class="quota-success">successCount</span><span class="quota-sep"> / </span><span class="quota-capacity">totalCapacity</span>`
- Unlimited: same with `∞` (U+221E) as capacity
- Error badge appended only when `errorCount > 0`: `<span class="quota-error-badge">errorCount</span>`
- `renderQuotaRow` uses it for initial HTML; `patchQuotaRow` uses `innerHTML = formatQuotaCell(bar)` (NOT textContent — cell now has structured spans).

##### CSS
`.quota-success` (green `--accent2`), `.quota-sep` (`--text-muted`), `.quota-capacity` (`--text-secondary`), `.quota-error-badge` (red badge: `rgba(239,83,80,0.15)` bg + `--danger` text + `--font-badge`). Column 4 widened 84→110px. All theme-variable-based, no hardcoded colors.

#### Tests (defend real contracts)
- `TestSnapshotKeyState_PersistsExhaustedModelLimits` — only Remaining==0 persists; partial usage NOT persisted.
- `TestRestoreKeyState_RestoresExhaustedAsZeroRemaining` — restore sets Remaining=0; re-restore doesn't clobber a live probe entry (the "don't clobber" invariant).
- `TestGetQuotas_AggregationFromKeyStates` — seeds ak1 exhausted (100/0) + ak2 partial (100/80), asserts `TotalUsed=120` (100 exhausted + 20 used), `TotalCapacity=200`. Catches the bug (without the fix, TotalUsed would be 20).

#### Verification gotchas
- Browser smoke-test requires the `xd://browser` device to be mounted. When unmounted, substitute a node unit test of `formatQuotaCell` with real stdout capture as proof (the function is pure string construction).
- `node --check web/static/usage_quota.js` only parses — doesn't catch undefined-global refs. Always pair with a runtime check of the helper.
- `getQuotas` aggregation uses `GetQuota` (lock-safe) — do NOT wrap in `state.Lock()/Unlock()` or it deadlocks (`sync.Mutex` non-reentrant).

#### Doc-sync targets (per AGENTS.md rule)
- `docs/config-registry-state-architecture.md` — header 增补#N note + §11 snapshotKeyState/RestoreKeyState bullets + §13 KeySnapshot field list
- `docs/proxy-architecture.md` — header dated note (covers usage frontend per docsync skill)
- `PROJECT_MAP.md` — §4 state.go row, §18.2 usage_quota.js, §24 "修改运行时状态持久化" + "修改用量统计/在途跟踪/兜底清理" rows

## tinylab-quota-inflight-initial-display


### TinyLab Quota Monitor: in-flight initialization

Use this procedure when Monitor shows Console/Recent Requests activity but Quota Monitor is empty until a request completes.

#### Root cause

`GET /api/usage/quotas` historically merged only:

- `QuotaTracker.All()` — populated after upstream rate-limit headers are parsed
- `Usage.ModelStats()` — populated after `recordUsage` adds a completed entry

An in-flight proxy request is already visible through `EntryTracker` and the Recent Requests SSE/REST path, but it is absent from both sources. During that window `getQuotas` returns `quotas: []`, so the frontend has no row to render. Completion makes the row appear, creating the misleading symptom that a later Recent Request caused quota initialization.

#### Fix

In `internal/api/usage/register.go::getQuotas`, after merging `ModelStats`, iterate `h.d.ProxyHandler.EntryTracker.All()` and add a provisional `internalusage.QuotaBar` for each non-Playground entry with non-empty `Provider` and `Model` that is not already in `barMap`.

Preserve these invariants:

- Existing quota bars and completed model stats win; never duplicate a `provider/model` key.
- Exclude `entry.Source == "playground"`; Playground usage remains physically isolated.
- Provisional bars are non-quota bars (`HasQuota: false`) and contain only provider/model identity. Existing current-key and in-flight-key decoration can run afterward.

#### Regression test

Add an API test using the normal test fixture:

1. Register a `usage.Entry{Status: "processing", Provider: "Test", Model: "model-a"}` in `rt.deps.proxyHandler.EntryTracker`.
2. GET `/api/usage/quotas`.
3. Assert the response contains exactly the expected `Test/model-a` bar.

Keep the test behavior-oriented; do not assert source text or incidental field defaults.

#### Verification

Run:

```text
gofmt -w internal/api/usage/register.go internal/api/api_test.go
go test ./internal/api ./internal/usage
go test ./...
node --check web/static/usage.js
node --check web/static/usage_quota.js
node --check web/static/usage_io.js
git diff --check
```

For live proof, build the default binary and run it in an isolated temp directory with a strict-valid config and a delayed mock upstream. Start a request that remains processing, open Monitor before it completes, and assert `#quota-tbody .quota-row` exists while Recent Requests also contains the processing row. Stop the app/mock and remove smoke artifacts afterward.

When frontend or usage API behavior changes, update `PROJECT_MAP.md` §24 and `docs/proxy-architecture.md` in the same change.

## tinylab-quota-metrics-blank-debug


### TinyLab Quota Monitor latency/speed blank diagnosis

Use when Monitor → Quota Monitor shows `—` or blank latency / avg speed values.

#### Root-cause checklist

1. `web/static/usage_quota.js::renderQuotaRow` initially renders `.quota-td-latency` and `.quota-td-speed` as `—`.
2. `patchQuotaRow` updates quota and token cells but does not fill latency/speed.
3. `patchQuotaRowActiveMetrics` is the filler; it runs after `fetchModelKeyDetail` receives `/api/usage/model-keys`.
4. `refreshAllKeyDetails` must fetch every quota bar, including collapsed rows. Only sub-row rendering should be gated by `expandedModels`. A collapsed-row `continue` causes never-expanded rows to remain `—` forever.
5. `renderUsage` should call `refreshAllKeyDetails()` immediately after `updateQuotaTable()` on first render; otherwise the first values wait for the periodic refresh.
6. Keep `KEY_DETAIL_TTL` cache throttling to avoid duplicate requests. Expanded-row manual fetch remains direct and bypasses the TTL.

#### Data-path consistency checks

- Proxy usage entries use provider name + resolved model ID + key ID.
- `/api/usage/model-keys` queries `Accumulator().KeyStatsFor(provider.Name, model)` and maps stats by key ID.
- Frontend expects `avgTtftMs`, `avgSpeed`, `liveSpeed`, `inFlight`, `keyId`, and `inUseKeyID` JSON fields.
- `internal/usage/accumulator.go` computes average TTFT and output speed from successful per-key entries; do not change this math for a frontend fetch regression.

#### Verification

- `node --check web/static/usage_quota.js`
- `node --check web/static/usage_io.js`
- `node --check web/static/usage.js`
- `go test ./internal/usage ./internal/api`
- Build and run TinyLab in an isolated temporary directory with a local mock upstream.
- Seed one successful streaming request, open Monitor without expanding the quota row, and assert the top-level cells contain values such as `0.1s` and `55.4 tok/s`.
- Run `go test ./...` for final regression coverage.
- Synchronize `docs/proxy-architecture.md` and `PROJECT_MAP.md` when changing `web/static/usage*`.

## tinylab-usage-quota-exhausted-key


### TinyLab Usage Quota Monitor — Exhausted Key Diagnosis

Use when auditing or fixing the Monitor usage/quota page behavior around multi-key providers, expanded key lists, provider-level used/capacity counts, and post-restart quota accuracy.

#### Relevant code paths

- Frontend: `web/static/usage_quota.js`
  - `renderQuotaKeyRows` renders expanded per-key rows
  - `updateQuotaTable` builds/patch top-level quota bars
- Backend quota data: `internal/usage/quota.go`
  - `QuotaTracker.Update` stores per-key quota snapshots
  - `QuotaBar.TotalUsed` / `TotalCapacity` are in-memory aggregates
- Usage API: `internal/api/usage/register.go`
  - `getQuotas` returns quota bars + current key + in-flight keys
  - `getModelKeys` returns ordered per-key detail used when expanding
- Key runtime state: `internal/keystate/state.go`
  - `KeyRuntimeState.ModelQuotas` holds latest quota snapshot per model
- Persisted state: `internal/state/state.go`
  - `KeySnapshot` currently omits `ModelQuotas`
- Registry state restore: `internal/registry/state.go`
  - `snapshotKeyState` / `RestoreKeyState` do not persist quota snapshots

#### Typical bug pattern to check

1. Expanded key list shows exhausted keys but should hide them.
2. Provider-level `used/capacity` undercounts because exhausted keys are omitted or not persisted across restart.
3. After restart, `ModelLocks`/`ModelStatus` survive in `state.yaml`, but quota counts are wrong because `ModelQuotas` was never persisted.

#### Diagnostic checks

- Confirm `renderQuotaKeyRows` does not filter `k.hasQuota && k.modelRemaining === 0`.
- Confirm `getQuotas` relies only on `QuotaTracker.All()` rather than aggregating from persisted `KeyRuntimeState`.
- Confirm `KeySnapshot` lacks `ModelQuotas` and `snapshotKeyState` does not copy quota data.

#### Fix direction

- Frontend: skip exhausted keys in `renderQuotaKeyRows`; show empty state if none remain.
- Persistence: add `ModelQuotas` to `KeySnapshot`; snapshot/restore it in registry.
- Aggregate: in `getQuotas`, rebuild `TotalUsed`/`TotalCapacity` from active keys’ `ModelQuotas[model]`, including exhausted keys’ full limit in capacity and `limit - remaining` in used.

## console-monitor-terminal-removal-audit


### Console Monitor + Terminal Removal Audit

When asked to remove the Monitor and Terminal features from the TinyLab console/usage page (the right-side log panel in `web/static/usage.js` → `buildConsoleInto()` in `console.js`), this is the complete affected-code map.

#### Key Principle
The console page (`console.js`) has **three independent output systems** (see skill `tinylab-console-output-independence`): the log SSE panel, the Monitor sub-view, and the Terminal sub-view. Removing Monitor+Terminal does NOT affect the log SSE panel, the download page's yt-dlp log modal, or the gallery-edit ffmpeg console panel — they are all independent DOM + API.

#### Two Critical Corrections (do NOT get these wrong)

##### 1. DebugMode MUST stay
`DebugMode` / `debugMode` is a core feature, NOT terminal-specific. It is used by:
- `endpoint.js` — Settings page "Debug Mode" toggle UI
- `api/settings/register.go` — Settings API read/write of `debugMode`
- `proxy/handler.go` — proxy caches request/response details when debug mode is on (for Usage page inspection)
- `app.go:183` — `SetDebugModeProvider` injects debugMode into proxy
- `usage_modal.js` — shows processing details when `usageDebugMode`
- `usage.js:39` — stores `usageDebugMode`

Terminal was only ONE consumer. After removing terminal, what becomes dead in `console.js`:
- `consoleDebugMode` variable (console.js:9)
- The `apiGet('/settings')` fetch in `buildConsoleInto` (console.js:16-22) — existed solely to gate the Terminal button

##### 2. MonitorConfig backward-compat
`internal/config/types.go` `MonitorConfig` struct is referenced by strict YAML parser (`KnownFields(true)`). Removing the struct entirely breaks old `config.yaml` files with a `monitor:` section. Two options:
- **A. Keep deprecated struct** — keep `MonitorConfig` with all fields, mark deprecated, stop filling defaults. Zero risk, ~10 lines dead code.
- **B. Auto-migration** — remove struct + strip `monitor:` key before strict parse (see skill `tinylab-config-deprecated-field-migration` / `config-auto-migration`). Cleaner but needs migration logic + tests.

#### Full Removal Map

##### Monitor — frontend
- `web/static/monitor.js` — entire file, only loaded by index.html/index-nopg.html, only called by console.js
- `index.html` / `index-nopg.html` — remove `<script src="/monitor.js">`
- `app.js` — remove `closeMonitorStream()` calls (lines 14, 60). Keep `closeConsoleStream()` — it's for the log SSE, not monitor.

##### Monitor — backend
- `internal/api/monitor/register.go` — 4 routes: GET /monitor/status, POST /monitor/start, POST /monitor/stop, GET /monitor/stream
- `internal/monitor/manager.go` — Manager core
- `internal/monitor/manager_test.go` — tests
- `internal/monitor/manager_unix.go` — Unix process kill (`//go:build !windows`)
- `internal/monitor/manager_windows.go` — Windows process kill (`//go:build windows`)
- `internal/api/router.go` — 4 spots: `monitor` import, `monitorMgr` field, `monitor.New()` init (line 124), Cleanup `Stop()` (line 184), route registration (line 366)
- `internal/api/apibase/deps.go` — `MonitorMgr *monitor.Manager` field

##### Monitor — config
- `internal/config/types.go` — `MonitorConfig` struct (lines 203-206), `Monitor MonitorConfig` field in Config (line 348) — see correction #2 above
- `internal/config/defaults.go` — `AllowedCommands` / `MaxLineLength` defaults (lines 117-122), deprecation warning (lines 184-188)
- `internal/config/config_compat_test.go` — entire file, tests legacy `monitor.enabled` compat

##### Terminal — frontend
- `web/static/terminal.js` — entire file
- `web/static/xterm/xterm.js` — entire file (~1.5MB), only used by terminal.js
- `web/static/xterm/xterm.css` — only used by terminal.js
- `web/static/xterm/xterm-addon-fit.js` — **already dead code** (no HTML loads it, terminal.js uses custom `doFit()`)
- `web/static/style.css` — `.xterm-container`, `#terminal-xterm`, `#terminal-xterm .xterm`, `#terminal-xterm .xterm-scrollable-element`, `#terminal-cmd-slot` (lines 512-517)
- `web/static/theme.js` — `updateTerminalTheme()` call (line 169), function only defined in terminal.js
- `index.html` / `index-nopg.html` — remove `<script src="/terminal.js">`, `<script src="/xterm/xterm.js">`, `<link href="/xterm/xterm.css">`
- `app.js` — remove `closeTerminalSession()` calls (lines 15, 61)
- `console.js` — remove: `consoleDebugMode` var, settings fetch, `btn-toggle-terminal` button, `terminal-cmd-slot`, `toggleTerminalView()`, `switchConsoleTab` terminal branch, `clearCurrentView` terminal branch, `cleanupTerminal()` call

##### Terminal — backend
- `internal/api/terminal/register.go` — 2 routes: GET /terminal/ws, POST /terminal/stop
- `internal/terminal/` — entire package directory:
  - `session.go` — Session core (NewSession/ReadLoop/WriteLoop/Close)
  - `path.go` — buildShellEnv
  - `path_other.go` — `//go:build !windows`
  - `path_windows.go` — `//go:build windows`, registry PATH merge
  - `path_test.go`
  - `process_unix.go` — `//go:build !windows`
  - `process_windows.go` — `//go:build windows`
  - `session_test.go`
  - `session_lifecycle_test.go` — end-to-end PTY test
- `internal/api/router.go` — 5 spots: `apiterminal` import, `terminalState` field, init (line 125), Cleanup close (lines 187-193), route registration (line 369)
- `internal/api/apibase/deps.go` — `TerminalState` struct + field + `terminal` import (lines 26, 63-73)

##### External dependencies (go.mod) — all become unused
- `github.com/gorilla/websocket v1.5.3` — ONLY imported by terminal package (verified: `api/terminal/register.go` + `terminal/session.go`)
- `github.com/aymanbagabas/go-pty v0.2.3` — ONLY imported by `terminal/session.go`
- `github.com/creack/pty v1.1.24` (indirect) — only dependency of go-pty

##### Docs (AGENTS.md mandates sync)
- `docs/terminal-monitor-architecture.md` — **delete entire file**
- `docs/config-registry-state-architecture.md` — update MonitorConfig.Enabled compat paragraph (~line 183)
- `docs/download-architecture.md` — update reference to `monitor/manager_unix.go` (line 543)
- `PROJECT_MAP.md` — update entries for `internal/terminal/`, `internal/monitor/`, `web/static/terminal.js`, `monitor.js`, `xterm/`

#### What stays (NOT affected)
- `closeConsoleStream()` in app.js — console log SSE, not monitor/terminal
- `DebugMode` feature — proxy caching, settings toggle, usage modal
- console.js log viewer — SSE via `/api/console-logs/stream`, level filters, search, clear
- download.js `viewLog()` — independent modal, fetches `/api/downloads/{id}/log`
- gallery-edit.js `_geEnsureConsole()` — independent `ge-console-panel` in pg-modal-overlay, polls `/api/gallery/edit/status/{id}` for `logTail`

