---
name: tinylab-backend-maintenance
description: "TinyLab backend maintenance: internal/api domain route mounting (chi 404), proxy capture gating, trace-log reader contract, FileTransfer settings, and Text Review SSE snapshot contract."
---


## tinylab-chi-route-mount-check


## tinylab-proxy-capture-gating


## tinylab-trace-log-reader-contract


## tinylab-filetransfer-maintenance


## tinylab-textreview-sse-snapshot-contract


## tinylab-chi-route-mount-check

name: tinylab-chi-route-mount-check
description: "Use when adding or debugging an internal/api/domain/ sub-package in TinyLab whose routes 404 in the browser despite passing unit tests — the sub-package's Register(r) may not self-scope its prefix."

# TinyLab chi route-mount prefix check

## When to use
- You added a new `internal/api/<domain>/register.go` sub-package and its routes 404 in the browser (but unit tests pass).
- You're debugging a `GET /api/<x>/<y>` returning 404/400 where you expect it to work.
- After touching `internal/api/router.go` Routes() mounting.

## The gotcha
In `internal/api/router.go` Routes(), sub-packages are mounted inside the auth group:
```go
r.Group(func(r chi.Router) {
    r.Use(authMW)
    XHandler.Register(r)   // r here is scoped to /api (just + authMW)
    ...
})
```
Each sub-package's `Register(r chi.Router)` is responsible for its OWN sub-prefix. Two conventions exist in the repo:
- **Self-scoping** (correct): `Register` does `r.Route("/providers", func(r chi.Router){ r.Get("/{id}", ...) })` → lands at `/api/providers/{id}`. Example: providers, gallery, settings, etc.
- **Bare** (BUG): `Register` does `r.Get("/dates", ...)` directly → lands at `/api/dates` instead of the intended `/api/<domain>/dates`. Example that bit us: `trace.Register` did `r.Get("/dates")` with no `/traces` wrapper → `/api/dates` (browser calls `/api/traces/dates` → 404).

## Why unit tests miss it
`register_test.go` files construct the Handler and call its methods (or a test chi router) directly — they test the Handler logic, NOT the production mount in `router.go`. A bare-Register sub-package passes all tests but 404s in the browser.

## The fix / check
When a sub-package's `Register` does bare `r.Get("/leaf", ...)` (no `r.Route("/prefix", ...)` wrapper inside Register), the CALLER must wrap it:
```go
r.Route("/traces", traceHandler.Register)   // NOT traceHandler.Register(r)
```
`r.Route("/prefix", fn)` creates a sub-router scoped to `/api/prefix`; `fn` receives it and `r.Get("/leaf")` inside lands at `/api/prefix/leaf`. `traceHandler.Register` has signature `func(chi.Router)`, which matches `r.Route`'s `fn` arg directly.

## Verification (don't trust tests alone)
- Grep `router.go` for the sub-package: confirm it's either self-scoped inside its Register OR wrapped in `r.Route("/<prefix>", XHandler.Register)` at the mount site.
- For a bare-Register sub-package, the only proof the mount is right is an end-to-end request — run the binary and `curl http://localhost:<port>/api/<prefix>/<leaf>` (with the session cookie / auth) and confirm 200, not 404.
- The chi mount bug class: tests green + browser 404 → suspect this first.

## Related (don't confuse)
- Playground STATIC asset 404 (e.g. `/editor-logs.js` 404) is a DIFFERENT bug: the `pgJSFiles` allowlist in `router.go` (~line 431) gates explicit routes for `web/playground/static-pg/` JS files — adding a JS file needs the filename added there. See `tinylab-playground-asset-registration` skill.


## tinylab-proxy-capture-gating

name: tinylab-proxy-capture-gating
description: "Use when editing TinyLab capture/trace/usage-ring gating (internal/proxy/recorder.go captureDetails, stream.go streamResponse/passThroughResponse captureDetails, usage.js loadTraceDetails/handleRequestDone) or reviewing/auditing a fix that proposes to \"unify\" the stream.go and recorder.go captureDetails gates — the accumulation-vs-storage gate asymmetry is intentional and a fixplan will misdiagnose it as waste (updated 2026-07-28)."

# TinyLab Capture/Trace Gating — the intentional asymmetry

Three independent gating systems control what gets captured, and the asymmetry between two `captureDetails` locals is **intentional**, not a bug. A fixplan/audit WILL propose "unifying" them to "avoid waste" — that proposal is wrong and harmful. Verify the current formulas before acting; they evolved through 2026-07-26 → 2026-07-28.

## The three systems (as of 2026-07-28)

### 1. Response-body ACCUMULATION (stream.go `streamResponse` ~L22, `passThroughResponse` ~L307)
```go
captureDetails := h.logRequests() || isPlayground || h.debugMode()
```
Broadest gate — accumulate (sseBuf / bodyBytes) if ANY consumer needs it:
- `h.logRequests()` → the trace file (writeRequestLog) needs the full body
- `h.debugMode()` → the ring needs it (when trace off)
- `isPlayground` → pgUsage ring always

The accumulated body flows into `recordUsage(... respBody ...)` → `writeRequestLog` (if trace on) AND the ring (if ring-gate below is true). **Accumulation is NOT waste when trace is on** — `writeRequestLog` (recorder.go:42, gated by `h.logRequests()`) consumes it and writes the JSONL trace file. The "discard" only applies to the *ring* path, not the trace path.

### 2. Ring STORAGE (recorder.go:53)
```go
captureDetails := isPlayground || (h.debugMode() && !h.logRequests())
```
Narrowest gate — store payload/headers in the usage ring ONLY when:
- playground (always — pgUsage is decoupled, owns its own conversation records), OR
- debug on AND trace off (when trace is on, the full body is already on disk in JSONL; the ring stays a lightweight table — time/provider/model/key/latency/tokens — to avoid duplicate memory). When debug is off and trace off, the ring has no payload either (Recent Requests is a pure table).

### 3. Debug live broadcast (stream.go `parseAndBroadcastChunk` ~L109)
```go
if h.debugMode() && reqID != "" { h.parseAndBroadcastChunk(...) }
```
Gates the real-time reasoning-stream SSE broadcast to the debug console panel. Independent of both capture gates.

## The trap to REJECT (fixplan2.md P4 pattern)

A report will claim: *"stream.go's captureDetails (includes logRequests) accumulates sseBuf for the whole stream, but recorder.go's captureDetails (excludes logRequests) discards it → pure memory waste; unify them to `isPlayground || (h.debugMode() && !h.logRequests())`."*

**This is wrong.** Unifying stream.go to exclude `logRequests` would starve `writeRequestLog` of the response body → trace files would have empty `respBody` for successful streaming responses when debug is off + trace on. (This was a real bug, fixed in commit `f0eee6f` by ADDING `h.logRequests()` to the accumulation gate.) The asymmetry is the fix, not the bug.

The two locals serve different populations: stream.go's gate answers "does ANY consumer need the body accumulated?" (trace OR ring OR playground); recorder.go's gate answers "does the RING need the body stored?" (ring only, minus trace-on to avoid dup). They MUST differ.

## Recent Requests modal — trace as a data source (usage.js)

When trace is on, ring entries have no payload (`!e.reqPayload && !e.respPayload && !e.reqHeaders && !e.respHeaders`). The modal (`showUsageEntryInfoWithData`) inserts a `#trace-loading-section` placeholder and calls `loadTraceDetails(e)` which fetches `GET /api/traces/req/{e.id}` (apiGet already prepends `/api` — pass BARE path `/traces/req/...`, NOT `/api/traces/req/...` or it 404s → "(trace not available)"). `renderInfoSection(title, data)` expects an OBJECT (it does `for...in`); pass objects directly, or wrap strings as `{ Body: formatBody(str) }` — never pass a raw string.

`handleRequestDone`: when modal is open and `completeEntry.respPayload` is empty but `traceEnabled`, clean the streaming sections (`#streaming-reasoning/assistant/usage/response-body-section`) and call `loadTraceDetails(completeEntry)` — otherwise the modal stays stuck in "Thinking..." (P2 bug, fixed). Also merge `inflightEntry.reqPayload/reqHeaders/upstreamUrl` into `completeEntry` when the completed entry lacks them (P5 — visual continuity).

`showUsageEntryInfoById` fallback: must use `await apiGet('/usage?limit=500')`, NOT a bare `usage.entries` (that var is local to `renderUsage` → ReferenceError silently caught → dead code, P1 bug, fixed).

## Long-stream keep-alive (P3)

`getUsage` calls `EntryTracker.SweepStale(10*time.Minute)` on every `GET /api/usage`, sweeping in-flight entries older than 10 min → writes a timeout-error record to the ring. For streams >10 min this races the completion: the error record lands first, the ring (no dedup) keeps both, the frontend (keeps first) shows success as timeout. Fix: `EntryTracker.Refresh(id)` bumps the entry's Timestamp to now; `streamResponse` calls it at most once per second. Do NOT change SweepStale's window or logic.


## tinylab-trace-log-reader-contract

name: tinylab-trace-log-reader-contract
description: "Use when editing the TinyLab trace Log Reader (web/playground/static-pg/editor-logs.js, playground.css) or the /api/traces/* read API (internal/api/trace/register.go) or the trace writer (internal/proxy/request_log.go) — the data contract and the three capture toggles are non-obvious and have caused real bugs."

# TinyLab Trace Log Reader — data contract & toggle map

Non-obvious contract that has caused real bugs. Verify against code before relying on it (file:lines shift).

## Files
- Writer: `internal/proxy/request_log.go` — `writeRequestLog` (proxy traffic) + `TraceMgmtCall` (management probes) + `SweepTraces`.
- Read API: `internal/api/trace/register.go` — `getDates` / `getIndex` / `getReq` / `clearTraces`.
- Reader UI: `web/playground/static-pg/editor-logs.js` (playground-only, needs `-tags playground`).
- Styles: `web/playground/static-pg/playground.css` — the log reader has NO built-in CSS; you must add/maintain `.log-reader-*` / `.attempt-card` / `.code` rules there.

## Two-tier JSONL on disk (under `<configDir>/traces/`)
- `index-YYYYMMDD.jsonl` — one **index** line per `recordUsage` call; same reqID overwrites last-write-wins on read. Daily-rotated (`now.Format("20060102")`, 8-digit, no dashes).
- `req/<reqID>.jsonl` — exactly one **request** line (written once, first call) + N **attempt** lines (appended per call).

`traceLine` schema (request_log.go `traceLine` struct): `type` ∈ {`index`,`request`,`attempt`}.
- **index** line fields: reqID, session, provenance(omitempty), source, model, originalModel, provider, upstreamURLBase, decision, latencyMs, ttftMs, attempts, finalKey, finalKeyName, inputTokens, outputTokens, httpStatus, status, error, ts. **No reqHeaders/reqBody/respBody.**
- **request** line fields: reqID, session, provenance, source, model, originalModel, provider, upstreamURLBase, **reqHeaders (masked), reqBody (parsed JSON or string)**, latencyMs, ttftMs, inputTokens, outputTokens. **No status/respBody.**
- **attempt** line fields: reqID, n (attempt #), key, keyName, decision, error, latencyMs, ttftMs, respStatus, **respHeaders (masked), respBody**, sentAt, model, provider, upstreamURL.

## Read API contracts (register.go)
- `GET /api/traces/dates` → `{dates:[{date,count}]}` where `date` is **dashed** `YYYY-MM-DD`.
- `GET /api/traces/index?date=&limit=&offset=&status=&q=` → accepts **YYYYMMDD OR YYYY-MM-DD** (normalized by stripping dashes), validates `^\d{8}$`, filename `index-<8digit>.jsonl`. Returns `{total, lines:[...index lines...]}`.
- `GET /api/traces/req/{reqID}` → **`{reqID, lines:[...]}` — NOT flattened.** There are no top-level `session`/`reqHeaders`/`reqBody` on the response object; everything is inside `lines`.

## Frontend data-flow gotcha (the #1 bug source)
`editor-logs.js` `logsRenderDetail` must NOT read `data.session`/`data.reqHeaders`/`data.reqBody` off the top-level `data` (they are `undefined`). Derive:
- **Header summary grid** (session/provenance/source/model/originalModel/provider/status/latencyMs/attempts) → from the **index line**, looked up from the module-level `logsAllLines` array (last match = current state, since index is last-write-wins). Pass it as a 3rd arg to `logsRenderDetail`.
- **Request section** (reqHeaders/reqBody) → from the `type:"request"` line found inside `data.lines`.
- **Attempt cards** (respHeaders/respBody/decision/error/key/latency) → from each `type:"attempt"` line in `data.lines`.

## SSE response body rendering
`respBody` for streaming responses is a **raw SSE string** (`parseBodyForJSON` returns a string for non-JSON input). `JSON.stringify(string)` collapses newlines to escaped `\n` → one unreadable line. Use a formatter (`logsFormatBody`) that splits on `\r?\n`, and for each line starting with `data: ` pretty-prints the JSON payload (`JSON.parse`+`stringify(…,null,2)`), handles `data: [DONE]`, falls back to the raw line on parse error. CSS: `.code{white-space:pre-wrap;word-break:break-all;word-wrap:break-word}`.

## The three capture/broadcast toggles (do not confuse them)
| Toggle | What it gates | Where |
|---|---|---|
| `Trace.Enabled` → `h.logRequests()` (atomic `logRequests`, router.go) | Whether `writeRequestLog`/`TraceMgmtCall` **write JSONL trace files**. Default **false**. | `recorder.go:41` `if h.logRequests() { writeRequestLog(...) }`; guard `if h.requestLogDir=="" \|\| !h.logRequests() { return }` must be on BOTH `writeRequestLog` and `TraceMgmtCall`. |
| `captureDetails` (**hardcoded `true`**, recorder.go:52 / stream.go:21) | Whether payload/headers are stored in the **Recent Requests in-memory ring**. Always on since 2026-07-26 decoupling — viewable regardless of debugMode/tracing. NOT gated by debugMode. | `recorder.go:52`, `stream.go:111` |
| `debugMode()` (atomic `debugMode`, router.go) | Only: (1) **live SSE chunk broadcast** to the reasoning panel `stream.go:108` `if h.debugMode() && ...`; (2) **Terminal WebSocket** `terminal/register.go:41` returns 403 when off. Does NOT gate storage. | — |

Stale comment to fix if encountered: `recorder.go:40` says the per-request log "mirrors debugMode" — wrong; it's gated by `logRequests()` (Trace.Enabled), independent of debugMode.

## Default + docs
`TraceConfig.Enabled` defaults to **false** (`internal/config/defaults.go` `DefaultConfig()` + `finalizeConfig`). Architecture docs (proxy-architecture.md, terminal-monitor-architecture.md, PROJECT_MAP.md) previously claimed default `true`; corrected to `false` on 2026-07-27 — if you see "默认 true"/"Enabled=true" for Trace in docs, it's stale, fix to false.

## Asset registration
`editor-logs.js` must be listed in the `pgJSFiles` whitelist in `internal/api/router.go` or it 404s in the playground build. See the `tinylab-playground-asset-registration` skill.

## Verification
- `go build ./...`, `go vet ./...`, `go test ./internal/proxy/... ./internal/config/... ./internal/api/...`
- `go build -tags playground ./...` and `node --check web/playground/static-pg/editor-logs.js`.
- Do NOT launch the binary for UI smoke tests by default: it conflicts with the user's running instance (singleton lock `.tinylab.lock`, real config.yaml with live API keys) and a console build auto-opens a browser tab (`app.Run` `openBrowserOnStart()`, build-tag gated — only the `!tray`/console variant). Let the user rebuild (`./build.ps1 -Variant webview -Playground -Strip`) and verify visually.


## tinylab-filetransfer-maintenance

name: tinylab-filetransfer-maintenance
description: "Maintain TinyLab Settings FileTransfer: arbitrary file drag/paste collection, ZIP packaging, authenticated upload route, ordered anonymous temporary-host fallback, and browser/Go verification."

# TinyLab FileTransfer maintenance

Use this skill when modifying or verifying the Settings → FileTransfer feature in `Z:/Playground/tinylab`.

## Architecture

- Frontend entry: `web/static/settings.js` adds the left Settings row and calls `openFileTransferModal()`.
- Frontend modal: `web/static/filetransfer.js` collects arbitrary files through the file picker, `FsApi.collectFilesFromDataTransfer`, drag/drop, browser clipboard files, and `/api/gallery/paste-paths` for Windows clipboard file paths. It displays selected files and only uploads after user confirmation.
- Frontend assets: load `fs-api.js` before `filetransfer.js` in both `web/static/index.html` and `web/static/index-nopg.html`; translations live in `web/static/i18n.js`; styles live in `web/static/style.css`.
- Backend: `internal/filetransfer/upload.go` receives `multipart/form-data` at `POST /api/filetransfer/upload`, accepts `files` parts and a JSON `paths` field, packages them with standard-library `archive/zip` Deflate, and returns the first successful host URL.
- Route: `internal/api/router.go` mounts `/api/filetransfer` outside the generic 1 MiB `/api` group, retains auth middleware, and applies a 600 MiB request limit.

## Host order

The fixed fallback order is:

1. tfLink — `POST https://tmpfile.link/api/upload`, multipart field `file`, JSON `downloadLink` response.
2. tmpfiles.org — `POST https://tmpfiles.org/api/v1/upload`, multipart field `file` plus `expire=172800`, JSON `data.url` response.
3. temp.sh — `POST https://temp.sh/upload`, multipart field `file`, plain-text URL response.
4. Filebin — `POST https://filebin.net/{random-bin}/{archive-name}` with raw ZIP bytes, JSON `file.filename` response.

Do not add a host that requires renaming the archive unless the product requirement changes. Uguu was excluded because the tested upload required a `.bin` filename. Litterbox, 0x0.st, and storage.to were not included because the tested environment had TLS/Cloudflare failures.

## Safety and limits

- Maximum 2,000 files.
- Maximum 500 MiB per source file.
- Maximum 500 MiB resulting archive.
- Clean ZIP entry names with slash normalization, traversal removal, absolute-path removal, and duplicate-name suffixes.
- Reject symbolic links for native local paths.
- Remove multipart temporary files with `r.MultipartForm.RemoveAll()` and close all opened source files.

## Verification

Run:

```powershell
gofmt -w internal/filetransfer/upload.go internal/filetransfer/upload_test.go internal/api/router.go
go test ./...
node --check web/static/filetransfer.js
node --check web/static/settings.js
node --check web/static/i18n.js
node --check web/static/app.js
go build -o tinylab-filetransfer-smoke.exe .
```

Browser smoke:

1. Start the built binary on an isolated port/config.
2. Open Settings.
3. Click the FileTransfer `Open` button.
4. Confirm the modal has the drop zone and browse control.
5. Submit with no files and verify the inline validation message.
6. Select a small file, confirm the file count/size row, click `Package and upload`, and verify either the returned link or the ordered service failure list.
7. Stop the smoke process and remove generated binary/config/test files.

Update `PROJECT_MAP.md` and `docs/config-registry-state-architecture.md` whenever the route, asset list, host order, limits, or ownership boundaries change.


## tinylab-textreview-sse-snapshot-contract

name: tinylab-textreview-sse-snapshot-contract
description: "Use when editing TinyLab text-review SSE subscription (web/playground/static-pg/text-review-step3.js trSubscribeSession/trS3OpenEventSource) or the /sessions/{id}/events handler (internal/textreview/events.go Subscribe/broadcast, internal/api/textreview/sessions.go sessionEvents) or reviewing/auditing a fix for the snapshot/EventSource race in step3 — the SSE stream is forward-only and the GET /sessions/{id} snapshot is authoritative, so client-side race elimination is impossible without server-side on-connect replay or sequence numbers."

# TinyLab Text-Review SSE / Snapshot Contract

The AI text-review (step3) live-progress model is **forward-only SSE + authoritative snapshot**, with re-snapshot as the sole recovery mechanism for any SSE loss/race. This is non-obvious and has caused real incorrect fix proposals.

## The contract (source anchors)

- `internal/textreview/events.go` `Subscribe` (L43-47): on SSE connect it does **NOT** replay current chapter state — it only registers a buffered forward channel (`make(chan Event, 64)`). There is no initial status/cleaned dump on connect.
- `internal/textreview/events.go` `broadcast` (L65-75): non-blocking send; on a slow/full subscriber it **drops** the event with the comment `// drop — subscriber too slow; snapshot compensates`.
- `internal/api/textreview/sessions.go` `sessionEvents` (L56-96): subscribes, then only forwards `sub.Events()` (future events). No state replay.
- `internal/textreview/scheduler.go` `ReprocessChapter` (L478-495): resets one chapter (`Cleaned=""`, `Status=StatusPending`, `Error=""`, `Retry=0`), then broadcasts **chapter-level `EventStatus{Status:StatusPending}`** (L490) BEFORE any session-level running event. If the session was not running, `e.Start(s)` → broadcasts session `EventStatus{Status:SessionRunning}` (L70). So chapter-pending always precedes session-running on the wire.
- Client `web/playground/static-pg/text-review-step3.js`:
  - `trS3ReconcileFromSnapshot` (L1005-1013): **replaces** `trS3Chapters` entirely with `snap.chapters` — snapshot overwrites any in-memory ES-applied deltas.
  - `trS3MaybeSessionDone` (L992-999): synthesizes `trS3SessionStatus='completed'` when every chapter is completed/failed (intended; comment L989).
- Architecture: `docs/playground-architecture.md` L978 — "切页存活… 取会话快照 + 重新订阅… (snapshot + re-subscribe)"；re-snapshot is the documented recovery path.

## Consequences — do NOT propose these as "race fixes"

The snapshot/EventSource race (`trSubscribeSession` opens ES sync, fetches snapshot async; later snapshot overwrites ES-applied events) is **real**, but these two client-side "fixes" are both wrong:

1. **"Snapshot-first, then ES" (serialize) — WRONG.** Because SSE is forward-only, events broadcast in the window `(snapshot-compute-time Tg, ES-subscribe-time T3)` are in **neither** the snapshot (cutoff Tg) **nor** the ES stream (starts T3) → **permanently lost**. Serializing makes this lossy window *deterministic and larger*, not smaller. Framing it as "no real-time events during snapshot, acceptable" is a misjudgment: the dispatcher keeps broadcasting and updating server state; events in the gap are silently dropped with no recovery. For a chapter actively streaming at subscribe time this produces a **gap (corruption) in cleaned text**, not "slightly behind".

2. **"Buffer ES events, replay after snapshot applied" — WRONG (double-apply).** Buffered `chunk` deltas broadcast *before* the snapshot cutoff Tg are already baked into `snapshot.cleaned`; replaying `c.cleaned += delta` duplicates them. Triggers ~50% of the time (when ES subscribes before the snapshot is computed). `status` events are idempotent so only chunks corrupt.

## Correct approaches

- **Lean on the documented model**: the system is *designed* to recover from SSE loss via re-snapshot. The actual linchpin is the **reconnect→snapshot** path (`trS3OpenEventSource` `onerror` must re-`trSubscribeSession`, not just set a dead `trS3NeedsReconcile` flag). Fixing reconnect is the correct, in-architecture mitigation for race/drop staleness — not client-side race elimination.
- **To truly eliminate the race** requires server-side support (not yet implemented): on-connect state replay in `Subscribe` (emit current chapter statuses/cleaned as initial events), or per-event sequence IDs for client-side dedup against the snapshot.
- Stale-mirror bugs (e.g. a reprocessed chapter still showing `completed` because its `pending` event was dropped) are SSE-drop artifacts — recovered by reconnect→snapshot, not by client status guards that paper over the symptom.

## When auditing a text-review fix plan

- Verify every claimed line ref against current source (these plans drift fast).
- Trace **event ordering** on the wire before accepting a "state A then state B causes override" scenario — e.g. chapter-pending precedes session-running, so `trS3MaybeSessionDone` short-circuits in the normal reprocess flow; an "all chapters still completed/failed → override to completed" premise is usually wrong unless an SSE drop is assumed.
- Check **fix composability** across bugs (e.g. `pending`→clear cleaned must compose with the chunk status guard that only accepts pending/processing).
- Check fixes against `docs/playground-architecture.md` (snapshot+re-subscribe is the intended design).

