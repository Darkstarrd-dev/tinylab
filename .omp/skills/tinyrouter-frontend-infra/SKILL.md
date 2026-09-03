---
name: tinylab-frontend-infra
description: "TinyLab frontend build/test infrastructure: smoke-testing web/static changes, frontend equivalent demo, script-load ordering, doc-sync map, console-output independence, download modal, and shared popups."
---

# TinyLab Frontend Build & Test Infrastructure


## tinylab-frontend-smoke-test


### TinyLab Frontend Smoke-Test (isolated)

When changing `web/static/*` JS/HTML and needing runtime proof (JS loads, no console errors, i18n resolves, page renders), run the real binary in isolation. `node --check` only catches syntax — runtime reference/DOM errors need a live page.

#### Build
`go build -o <exe>.exe .` (default console variant). `//go:embed all:static` (web/embed.go) embeds the **whole** `web/static` dir and `http.FileServer(http.FS(staticFS))` (internal/api/router.go) serves any file in it — **no whitelist to edit** when adding `.js` files. You MUST still reference new scripts in BOTH `index.html` and `index-nopg.html`.

#### Run in isolation (never touch the user's config.yaml)
- `SMOKE=$(mktemp -d /tmp/trsmokeXXXXXX)`; copy the exe in.
- `printf 'port: 18099\n' > "$SMOKE/config.yaml"` — the config parser is **STRICT**: unknown fields abort startup (`field logLevel not found in type config.Config`). Use `port:` only (confirm any other field exists in `internal/config/types.go` first).
- `hub start` with `cwd=$SMOKE`, `ready={"port":18099,"timeout":30}`, `pty:false`. The console build auto-opens the user's real browser (`OpenBrowser`, non-blocking) — drive a separate headless tab.
- Admin UI: `http://127.0.0.1:18099/`. The former "Usage" page is now the **Monitor** nav button.

#### Browser checks (headless)
- `browser open` (networkidle2); `run`: attach `page.on('console', type==='error')` + `pageerror` + `requestfailed`; click the `Monitor` nav; wait ~2.5s. Assert: `#quota-tbody` exists + `.quota-empty`/rows render; `typeof window.<fn>` === 'function' for changed AND onclick-called fns (`toggleQuotaRowExpand`/`showUsageEntryInfoById`/`copyStreamingText`/`resetQuotaTimers`); `ERRORS: []`.
- `requestfailed` on `/api/usage/events` with `net::ERR_ABORTED` is the headless networkidle2 navigation tearing down the persistent EventSource — NOT a bug. Confirm the route (`grep "/usage/events"` → `r.Get("/usage/events", h.streamUsageEvents)` in `internal/api/sse/register.go`) rather than chasing it.
- i18n: `document.documentElement.setAttribute('data-lang','cn')`, re-render, call `t('<key>')` — must return the translation, not the raw key string (a missing key returns the key itself, so `t('x') || 'fallback'` never triggers).

#### Cleanup
`hub stop`; `rm -rf "$SMOKE"`; `rm -f <exe>.exe` from the repo. Never leave smoke exes/config in the working tree.

#### Splitting a `web/static/<x>.js` into multiple files
Update BOTH `index.html` + `index-nopg.html` `<script>` order (deps first, entry last). Keep all declarations **global** — inline `onclick="fn()"` requires `fn` global; do NOT IIFE-wrap unless you first migrate every onclick to `addEventListener` (the namespace-tidiness benefit rarely justifies that risk on this admin SPA). Verify: before/after top-level declaration count equal, `node --check` each file, then the browser smoke above.

## tinylab-frontend-equivalent-demo


### TinyLab equivalent frontend demo

#### Goal
Provide fast style/layout validation without maintaining a second frontend implementation. The demo MUST load the same `web/static` and, when applicable, `web/playground/static-pg` HTML/CSS/JS used by the compiled binary.

#### Architecture
Use a development HTTP server or a development static-resource mode:

- Production: resources come from `embed.FS`.
- Development: resources come directly from the repository filesystem.
- Keep the exact production HTML variant (`index.html` vs `index-nopg.html`), script order, CSS, JS, root data attributes, and asset paths.
- Do not copy or rewrite the frontend into a separate demo implementation.

Recommended modes:

1. **Live mode** — serve filesystem frontend assets while connecting `/api/*` and `/v1/*` to the real TinyLab backend. Use this for end-to-end behavior, authentication, configuration, SSE, and real page navigation.
2. **Fixture mode** — serve the same frontend assets with a mock API/SSE server and deterministic scenarios such as monitor-empty, monitor-active, errors, settings, download-running, and gallery states. Use this for repeatable visual edge cases.

#### CSS workflow
Load the production stylesheet first, then an optional demo-only override stylesheet:

```html
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/__demo__/style-preview.css">
```

Edit only the preview override during exploration. After visual confirmation, merge the confirmed rules into `web/static/style.css` and remove or clear the override. Avoid Demo-only wrapper selectors or inflated specificity; selectors should remain valid when moved into production CSS.

#### Equivalence requirements
For a valid equivalence claim, keep these identical to the compiled frontend:

- HTML variant and script load order.
- All frontend JS/CSS/vendor assets.
- Playground build/runtime availability.
- Root attributes: `data-theme`, `data-theme-variant`, `data-theme-style`, `data-font-size`, and `data-lang`.
- Browser viewport, zoom, fonts, and local/session storage state.
- API response field shapes, authentication state, and SSE event formats in live mode; fixture mode must document that only backend data is simulated.

Only resource origin (filesystem vs `embed.FS`), backend data source (real vs fixture), and demo tooling/preview CSS may differ.

#### Avoid
- A duplicated `web-demo/static` frontend.
- A React/Vue rewrite used as a visual substitute.
- Opening `index.html` with `file://`; absolute assets, fetch, EventSource, and browser-origin behavior will differ.

#### Verification
Run the demo over HTTP. Exercise every affected navigation/page and interaction in a browser. Capture console errors, page errors, failed requests, theme/language state, and screenshots at the target viewport. Treat `ERR_ABORTED` from EventSource teardown during navigation as a harness artifact only after confirming the corresponding real route exists. For production equivalence, also run the compiled binary with embedded assets and compare the same scenario/viewport.

## puppeteer-core-browser-smoke-fallback


### Puppeteer-core browser smoke fallback (no omp browser daemon)

#### When to use
The `browser` (xd://browser) tool fails with "Shared browser daemon unavailable" / "connect ENOENT \\.\pipe\omp-daemon-*" / "Tab is not alive", or `hub` fails to start its broker — but you still need to drive a localhost web app (TinyLab frontend, etc.) headlessly for smoke verification.

#### Prerequisites (present on this Windows box)
- Node ≥ 20 (`node --version` works; `C:\nvm4w\nodejs`).
- Chrome: `C:/Program Files/Google/Chrome/Application/chrome.exe` (Edge also available).
- No internet-blocking proxy issue for `npm install puppeteer-core` (25 packages, ~8s).

#### Recipe (verified 2026-08-11)
1. Scratch dir + install:
   ```
   mkdir -p C:/tmp/tr-puppeteer && cd C:/tmp/tr-puppeteer
   npm init -y >/dev/null 2>&1 && npm install puppeteer-core --no-fund --no-audit
   ```
2. Launch script essentials:
   - `executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'`, `headless: 'new'`, args `['--no-sandbox','--disable-gpu']`.
   - **`waitUntil: 'domcontentloaded'`, NOT networkidle2** — TinyLab keeps SSE streams (monitor/usage) open forever, so networkidle2 times out at 60s.
   - Collect `page.on('pageerror')` + `page.on('console')` (type error) into an array — the fastest signal of a broken frontend.
3. Drive the app via `page.evaluate` (globals like `pgSetMode('image')`, `pgOpenImageBatch()`, `pgState`) and assert DOM afterwards. Re-render loops need `await new Promise(r => setTimeout(r, 300-800))` before querying.
4. Verifying a control exists AND works: check the element in DOM, then simulate the interaction (e.g. click custom-select trigger → click option) and assert the underlying value changed (`selectEl.value`, label text, `.selected` class). Presence alone is not proof of function.
5. Caveats: functions inside IIFE closures (e.g. `readDraft` in pg-image-batch.js) are NOT reachable from page scope — assert on DOM/state objects exposed on window (e.g. `pgState.imageBatch.draft`) instead.

#### Git Bash /tmp gotcha
The bash tool's `/tmp` maps to `C:\msys64\tmp`, while the write tool's `C:/tmp` is the real `C:\tmp`. If a file written via the write tool isn't visible under `/c/tmp`… it is; but a `go build -o /tmp/x.exe` from bash may land in msys64 tmp while the first invocation of this recipe resolved to C:/tmp. Always use absolute `C:/...` paths in bash commands for cross-tool consistency; verify with `ls` after builds.

#### Cleanup
`powershell -Command "Stop-Process -Name <exe> -Force"` to kill the served binary (taskkill //F syntax breaks in Git Bash); then `rm -rf` scratch dirs. Locked files (.tinylab.lock) block deletion until the process exits.

## tinylab-appjs-dependency-ordering


### TinyLab app.js script dependency graph

When editing `<script>` tags in `web/static/index.html` or `web/static/index-nopg.html`, be aware that `app.js` (loaded early, typically at line 99) calls functions from modules loaded **later** in the HTML. These are **not guarded by `typeof` checks** in all cases, so removing a script tag can break page navigation with a ReferenceError.

#### Current dependency from app.js (navigateTo)

| Function called | Defined in | Has typeof guard? | Risk if removed |
|---|---|---|---|
| `stopUsageRefresh()` | `usage.js` | ❌ (was added 2026-07-31 after a crash) | `ReferenceError: stopUsageRefresh is not defined` at `app.js:37` |
| `cleanupPlayground()` | `pg-core.js` | ✅ `typeof cleanupPlayground === 'function'` | Silent no-op |
| `cleanupGallery()` | `gallery.js` | ✅ `typeof cleanupGallery === 'function'` | Silent no-op |
| `cleanupEditor()` | `editor.js` | ✅ `typeof cleanupEditor === 'function'` | Silent no-op |
| `closeConsoleStream()` | `console.js` | ✅ `typeof closeConsoleStream === 'function'` | Silent no-op |
| `downloadEventSource` | `download.js` | ✅ `typeof downloadEventSource !== 'undefined'` | Silent no-op |

#### Script load order (index.html)

```
app.js          ← defines navigateTo, calls stopUsageRefresh() etc.
...
usage.js        ← defines stopUsageRefresh()  ← MUST be loaded before navigateTo is called
console.js
download.js
```

#### Safe modification rule

When removing a script tag from the HTML, **always check `app.js`** for hard (unguarded) calls to that module's functions. If the call lacks a `typeof` guard:
1. Add the guard: `if (typeof fnName === 'function') fnName();`
2. Then remove the script tag

The `stopUsageRefresh` function is the only one that had a hard crash — it was fixed 2026-07-31 with a `typeof` guard. Any future dependencies added to `navigateTo` should use `typeof` guards from the start.

## tinylab-web-static-docsync


### When to use
After changing any `web/static/*` (or `web/playground/static-pg/*`) file in the TinyLab repo, AGENTS.md mandates doc-sync in the SAME change. Use this to know exactly which docs to touch (and the non-obvious architecture-doc coverage).

### Mandatory doc-sync targets for web/static changes

#### 1. PROJECT_MAP.md §18.2 — web/static module inventory
Update when files are **added/removed/renamed** or a module's responsibility shifts. List each JS file + one-line role. Adding i18n **keys** to the existing single `i18n.js` does NOT require it (no structural change). Load order lives in `index.html`/`index-nopg.html`, not §18.2.

#### 2. PROJECT_MAP.md §24 — reverse-index "变更任务" rows
Grep §24 for the changed filename; update any row that references it. E.g. the "修改用量统计/在途跟踪/兜底清理" row lists `web/static/usage` frontend (handleRequestTTFT/Tokens, session grouping).

#### 3. docs/*-architecture.md — coverage map (NON-OBVIOUS cross-coverage)
A `proxy` doc covers a frontend file — don't miss it:
- **proxy-architecture.md** covers `web/static/usage*` FRONTEND: §8 Recent Requests merge/dedup/inflight/session-grouping notes + 变更维护清单 "修改用量/在途/兜底清理" row reference `usage.js`. So changes to usage merge/Quota-Monitor/SSE-handler logic trigger this doc's "最后核对" line + 变更维护清单. (Historical §8 dated update-notes stay accurate if behavior is preserved; just add a new dated note + map moved functions→files; leave giant checklist rows contextualized by the note rather than risk corrupting ~1600-char lines.)
- **download-architecture.md** covers `web/static/download.js`.
- **terminal-monitor-architecture.md** covers `web/static/terminal.js` + `monitor.js`.
- **playground-architecture.md** covers `web/playground/static-pg/*` (uses "增补#N" numbered notes + a `pgJSFiles` whitelist in router.go).
- No dedicated architecture doc for `providers.js`/`combos.js`/`quickslots.js`/`theme.js`/`app.js`/`endpoint.js`/`info_common.js` frontend logic — only §18.2/§24.

#### 4. Embed / serving facts
- `web/embed.go`: `//go:embed all:static` → new `web/static` files are auto-included; served by `http.FileServer(http.FS(staticFS))` in router.go. **No whitelist** for admin static (unlike `pgJSFiles` for playground). So adding JS files needs only the HTML `<script>` tags, no Go/router change.
- Build with `go build -o x.exe .` (default console variant) to re-embed; smoke via the `tinylab-frontend-smoke-test` skill.

### Splitting a vanilla-JS file (behavior-preserving)
- Keep ALL top-level `var`/`function` declarations **global** (no IIFE, no namespace). Many are referenced by inline `onclick="fn(...)"` in HTML built by this code (usage: `toggleQuotaRowExpand`, `showUsageEntryInfoById`, `copyStreamingText`, `resetQuotaTimers`, `closeUsageEntryInfo`). Wrapping in an IIFE that only exposes a few entry points BREAKS the UI — must migrate every inline onclick to `addEventListener` first (defer unless explicitly wanted).
- Function declarations hoist, so script load order is flexible for onclick (fires at runtime after all scripts load); but load **state-first** (vars) then logic then entry. No top-level executing statements in usage.js → any order works.
- Verify: `node --check` each file (syntax; doesn't catch runtime/undefined-global refs) + `go build` (embed recompiles) + browser smoke (functions still `typeof === 'function'` global, no console errors, page renders). Count declarations before/after (no drops/dups).
- Update `index.html` + `index-nopg.html` `<script>` tags in dependency order.

## tinylab-console-output-independence


### TinyLab Console Output Independence

TinyLab has **three independent** console/output display systems. They are **not** coupled:

| System | DOM | Data Source | Module |
|---|---|---|---|
| Usage page right panel (logs) | `#console-layout` → `#log-container` | `/api/console-logs/stream` SSE | `console.js` |
| Console Monitor sub-view | `#monitor-output` | `/api/monitor/stream` SSE | `monitor.js` (toggle from `console.js`) |
| Console Terminal sub-view | `#terminal-container` xterm | `/api/terminal/ws` WebSocket | `terminal.js` (toggle from `console.js`) |
| Download yt-dlp log | `#dl-log-modal` independent overlay | `/api/downloads/{id}/log` REST fetch | `download.js` (`viewLog()`) |
| Gallery-edit ffmpeg output | `#ge-console-panel` inside `#pg-modal-overlay` | `/api/gallery/edit/status/{id}` poll | `gallery-edit.js` (`_geEnsureConsole()`) |

**Key facts:**
- `monitor.js` and `terminal.js` are only referenced by `console.js` (toolbar buttons + `switchConsoleTab`) and `app.js` (cleanup on page nav).
- Gallery-edit `_geEnsureConsole()` creates its own DOM inside `pg-modal-overlay`, completely separate from `console.js`. It polls `/api/gallery/edit/status/{id}` for `logTail`.
- Download `viewLog()` creates a standalone modal overlay, fetches log text via `/api/downloads/{id}/log`.
- Removing monitor/terminal from the console toolbar does NOT affect download or gallery-edit output displays.
- The `btn-toggle` CSS class is shared by both Monitor and Terminal toggle buttons in console toolbar.

## download-js-browse-modal-edit


#### When editing `web/static/download.js`

- `node --check web/static/download.js` validates after edits.
- After any SWAP that deletes the closing `}` of `openPathSettingsModal`, the next top-level `function`/`async function` is silently swallowed into the modal body. Always add the missing `}` BEFORE the next top-level function.
- `browseRow` takes 7 args: `labelKey, inputId, value, placeholder, mode, getToolHtml, initialPath`. A SWAP that drops the `return ...` statement breaks the HTML output.
- `openPathSettingsModal` is defined in `download.js`; `openPathModal` is defined in `endpoint.js`. Do NOT add `openPathModal` into `download.js` — it was a one-time mistake from copy-paste.

#### When adding browse initial-dir support

- Backend: add `OpenFilePickerAt(filter, initialDir)` / `OpenDirectoryPickerAt(initialDir)` with new functions, keep old wrappers.
- `SHCreateItemFromParsingName` takes `(pszPath, pbc, riid, ppv)` — 4 args, path first.
- `IFileDialog::SetFolder` vtable index is 12; pass an `IShellItem*`.
- `resolveBrowseInitialDir` should call `os.MkdirAll` when the path doesn't exist (idempotent).
- Frontend: pass `data-initial` from `browseRow` button; click handler reads it and forwards to `fasBrowsePicker(inputEl, mode, initialPath)`.

#### When fixing layout (inline style strings in JS)

- Use Proxy toggle row: `<div class="dl-settings-row" style="justify-content:space-between; align-items:center;">` with label `<span>` left and `<label class="toggle-switch">` right.
- SWAP edits on long inline HTML are fragile — prefer rewriting the full block in one shot.

## tinylab-shared-popup-multi-context


### TinyLab — Shared Popup Reused Across Contexts

#### When a popup is called from 3+ places
A popup defined in one `web/static/*.js` file (e.g. `download.js::openDownloadSettingsModal`) gets reused by:
1. Its own page's inline `onclick` button.
2. The Settings page sidebar (a different page, `endpoint.js`).
3. The Playground (`web/playground/static-pg/gallery-edit.js`).

`download.js` is loaded globally in `index.html` (line ~118, BEFORE playground modules), so its globals are reachable on every admin page and in playground modules. Keep the shared popup in that globally-loaded file; do NOT move it to a page-local file.

#### Refactor to section-visibility
Rename to `openXxxModal(opts)` where `opts = { title?, sections: {<field>:bool, ...}, <toggles>? }`. Build rows conditionally:

```js
var formRows = '';
if (sections.ytDlpPath) formRows += browseRow('ytDlpPath', 'modal-dl-ytdlp-path', ...);
if (sections.ffmpegPath) formRows += browseRow(...);
...
```
Save payload: send ONLY visible fields. The backend MUST merge presence-aware (see `tinylab-settings-partial-merge-pitfall` skill) so omitted fields aren't cleared.

#### Keep the overlay id stable
If any caller polls for the overlay's removal (gallery-edit polls `document.getElementById('dl-settings-overlay')` to know when to re-check ffmpeg), DO NOT rename the overlay id/class — or update every poller. Renaming the *function* is fine (update call sites); the id is an implicit contract.

#### index-nopg.html script-load gotcha
`index-nopg.html` (the no-playground build) has a STRIPPED nav (only Monitor + Settings) and a SMALLER script list. If a new Settings-page feature depends on a function defined in a file that `index-nopg.html` does NOT load (e.g. download.js was omitted from nopg), the no-playground build breaks with a silent ReferenceError on the inline onclick.

When a globally-loaded file's function becomes a Settings-page dependency, add the `<script src>` to BOTH `index.html` AND `index-nopg.html`. Verify the file's top-level has no immediately-executing DOM-touching code (only function declarations + a page-render entry called by app.js navigation) so loading it on a page that doesn't render its content is harmless.

#### typeof guard in playground callers
Playground callers often guard with `if (typeof openXxxModal === 'function')`. This works in production because classic top-level `function` declarations resolve via the page scope chain. NOTE for smoke tests: `page.evaluate(() => typeof window.openXxxModal)` returns `"undefined"` even when the function is callable from inline onclick — a harness artifact (evaluate's `window.X` access doesn't reflect page globals). Do NOT treat that as a bug. Verify behaviorally (click the button, assert the overlay renders the right sections) instead of via `window.X` typeof.

#### Verification recipe
1. Build: `go build -o .smoke.exe .` (default console embeds `//go:embed all:static`).
2. Isolated run: temp dir + `printf 'port: 18099\n' > config.yaml` (strict YAML — port only), `hub start`.
3. Browser: open admin UI; click Settings nav; click the new Path-row Settings button → assert popup title + section input ids match the expected subset; assert Use-Proxy toggle present/absent per context.
4. For contexts without a nav (e.g. download page absent in the default build), inject a `<button onclick="openXxxModal({...the exact opts...})">` and click it — runs in the page global scope, same as the real button.
5. API contracts via `fetch` (same-origin): presence-aware merge, logDir repoint, imageSaveDir round-trip.
6. Cleanup: `hub stop`; `rm -rf .smoke .smoke.exe` (retry once — file handles release a moment after stop).

