---
name: tinylab-gallery-edit
description: "TinyLab gallery edit modal (web/playground/static-pg/gallery-edit.js): DOM structure, item shape, batch convert, replace-original/Same Path, background-task persistence, and metadata sidebar. Use when fixing or extending gallery edit features."
---

# TinyLab Gallery Edit Modal


## gallery-convert-all-sibling-bug


### Gallery "Convert All" = 0 + Output/Zip Naming — Root Cause & Fix

#### ⚠ f6997d6 REGRESSION (2026-07-28)
After the naming rewrite, `_getDestination()` in `gallery-edit.js` DROPPED the `input[name="ge-dest"]:checked` radio read and always returns `overwrite:false`. The default radio "Same Path" now silently saves a new file to the pre-filled download dir (named `<stem>.<ext>`), which looks like "in-place saved a new one" to the user. The entire replace-original path is DEAD from the UI: `_zipReplacePending` (single-file zip), the `_onBatchComplete` zip-writeback branch, and the `canReplace`/`geNoDiskPath` guard never fire. Tests still pass because they bypass the client. Full review + fix plan: managed skill `gallery-edit-f6997d6-review-findings`. Restore `_getDestination` radio read before assuming replace-original works.

#### Symptom (pre-f6997d6)
In the gallery Edit Image modal, checking "Convert all images in the folder" shows a count of 0 and `_startBatch` won't launch. Separately, converted files come out as `gallery-edit-XXXX.png` and the zip as `converted_images.zip`.

#### Root Cause (count = 0)
`web/playground/static-pg/gallery-edit.js` `_getSiblingImages` matched siblings by only three fields: `zipAbsPath`, `rootDirPath`, `absPath`.

Item kinds produced by different load paths (see `gallery-io.js`):
- `kind:'backend'` (native dir picker `onOpenDirBackend`) → has `absPath` + `rootDirPath` ✓ (worked)
- `kind:'fs'` (FSAA `walkDir`, used when backend picker falls back / drag-drop) → only `handle` + `rootDirHandle`, **no absPath/rootDirPath/zipAbsPath**
- `kind:'zip'` backend folder → `zipAbsPath` + `sessionId` ✓ (worked)
- `kind:'zip'` FSAA-dropped (`addZipBlob`) → `zipFileHandle` + `sessionId`, **no zipAbsPath**

So FSAA folder items and FSAA-dropped zip items hit zero matching keys → `_getSiblingImages` returns `[]` → count 0 → `_startBatch` early-returns. Confirmed via Node simulation: FSAA folder=0, FSAA zip=0, backend folder=2, backend zip=2.

#### Fix 1 — Sibling detection (`gallery-edit.js` `_getSiblingImages`)
Rewrite to dispatch by `kind`, mirroring `gallery-fullscreen.js` `itemsInNode` grouping:
- `backend` → match `rootDirPath` (fallback: dir of `absPath`) via `_normDir`
- `fs` → match `rootDirHandle` by identity (`===`)
- `zip` → match `zipAbsPath` (on-disk archive) or fall back to `'@sess:'+sessionId`
- `plain` (single pasted blob) → return `[]` (no siblings) — NOTE at f6997d6 this path has NO return statement and yields undefined → TypeError. Always end with `return []`.

#### Fix 2 — Per-item batch disk-path resolution (`gallery-edit.js` `_resolveBatchInput`)
`_startBatch` sent `body.inputPath = it.absPath`, undefined for FSAA/zip items → ffmpeg gets nothing. Added `_resolveBatchInput(item)` reusing the SAME two endpoints `triggerMediaEditor` already uses for single-file edit:
- `kind:'zip'` (no `absPath`, has `zipAbsPath` or `sessionId`) → `POST /edit/extract-zip-entry` `{zipAbsPath|sessionId, zipPath}` → `{tempPath}`
- otherwise + `typeof it.getBlob === 'function'` → `it.getBlob()` then `POST /edit/upload-temp?name=<name>` (raw blob) → `{tempPath}`
- has `absPath` → return it directly

Each batch item resolves independently; one failure marks one error, doesn't block others. Existing `_batchDone`/`_onBatchComplete` progress wiring reused. CAVEAT: the temp inputs produced here are NOT cleaned after the batch (server only removes writeback filePaths).

#### Fix 3 — Output filename (`StartRequest.OutputName`)
Without `OutputName`, the `OutputDir` non-overwrite branch in `internal/mediaedit/manager.go` `Start()` used `filepath.Base(req.InputPath)` stem — i.e. the temp name (`gallery-edit-upload-XXXX.png` / `gallery-edit-XXXX.png`) leaked into saved files AND zip entries (`zip-outputs` uses `filepath.Base(p)`).

- `internal/mediaedit/types.go`: add `OutputName string` (optional, **stem without extension**) to `StartRequest`.
- `internal/mediaedit/manager.go` `Start()`: in the `OutputDir && !Overwrite` branch, `outStem = req.OutputName` if set else `InputPath` stem; append `ext` from `buildArgs` (server is the single source of truth for ext — e.g. jpeg→`.jpg`); `relocateOutput` dedup gives `_2`/`_3`.
- Client `_startBatch`: pass `outputName: _stripExt(item.name)` only when `outputDir && !overwrite` (single-file edit path unchanged → behavior identical).

NOTE: f6997d6 ALSO added a `manager.go` branch `req.OutputName != "" && !req.Overwrite` (same-path) that builds `<OutputName>_<desc><ext>` in the source dir. This branch is UNREACHABLE as long as `_getDestination` returns overwrite:false (see ⚠ above); delete it once overwrite wiring is restored and Same Path properly hides sequential-rename.

#### Fix 4 — Zip name (`zip-outputs` `zipName`)
- `internal/api/gallery/register.go` `galleryEditZipOutputs`: accept optional `zip.Name` field. Hardening: `filepath.Base(zipName)` (prevent dir traversal) + force `.zip` suffix (reject non-zip extension); reuse existing `_2`/`_3` dedup loop. CAVEAT: io.Copy error ignored, Close errors unchecked, os.Create non-atomic (writeback endpoint uses fsutil.AtomicWrite — inconsistent style).
- Client `_batchOriginZipName()`: derive `<origin>_converted.zip` from the current edit item using the SAME grouping keys as `_getSiblingImages`:
  - `zip` + `zipAbsPath` → `filepath.Base(zipAbsPath)`
  - `zip` otherwise → first `path` segment (FSAA zip display name, e.g. `Vacation 2023.zip/p1.png` → `Vacation 2023.zip`)
  - `fs` → `rootDirHandle.name`
  - `backend` → `filepath.Base(rootDirPath)`
  - fallback → `converted_images`
  - strip any extension, append `_converted.zip`. CAVEAT: `stripExt("archive.v2")` → "archive"; only strip `.zip`.
- `_onBatchComplete`: pass `zipName: _batchOriginZipName()` to `/edit/zip-outputs`. CAVEAT: non-compress branch "Open Folder" button reads `_batchJobs` after `_batchJobs = []` → dead button at f6997d6; capture first outputPath locally before wiring.

#### Tests
`internal/mediaedit/manager_test.go`:
- `TestManager_TranscodeImage_OutputName` — input `gallery-edit-upload-XXXX.png` + `OutputName:"vacation_photo"` → asserts output is `vacation_photo.webp`.
- `TestManager_TranscodeImage_OutputName_Dedup` — second conversion of same `OutputName` stem → `vacation_photo_2.png`.

These tests pass at f6997d6 despite the client wiring being broken — they go direct to `Manager.Start`.

#### Verification
```
node --check web/playground/static-pg/gallery-edit.js
go build ./...
go test ./internal/api/gallery/ ./internal/mediaedit/
go test ./internal/mediaedit/ -run TestManager_TranscodeImage_OutputName
```

#### Related doc sync
- `docs/playground-architecture.md` §4.2 table (add `/edit/extract-zip-entry` `/edit/upload-temp` `/edit/zip-outputs`), §16 (9 handlers, StartRequest.OutputName, zipName, 兄弟匹配/输出命名 constraints + 变更维护清单 rows), header 增补#8.
- `PROJECT_MAP.md` §10.9 (register.go handler list 6→9), §10.9a (types.go OutputName, manager.go three output branches, manager_test.go new tests), §24 媒体编辑 row (handler count 6→9 + new endpoint names + Onaming/zipName/兄弟匹配 responsibilities).

#### Stale skill note
The `tinylab-gallery-edit-architecture` managed skill's field-availability section is OUT OF DATE: it claims items have "only `absPath`, no `rootDirPath`", that `rootDirPath` is added by `updateNavPanel` in `gallery-layout.js` (that function doesn't exist), and that archives use a `::` separator in absPath. Real code: backend items carry `absPath`+`rootDirPath` together (both set in `onOpenDirBackend`); FSAA items carry `rootDirHandle`; zip items carry `sessionId`+`zipAbsPath` (backend) or `zipFileHandle` (FSAA) — no `::` encoding. Trust the code, not that skill's field table.

## gallery-edit-background-task-smoke


### Gallery Edit — Background-Task Persistence + Lock Smoke

Extends `tinylab-gallery-edit-browser-smoke` (which covers the basic `openMediaEditor` craft-item smoke: i18n titles, tooltips, source rows, live console). Use THIS when verifying the **background-task persistence + reopen-lock** behavior of `web/playground/static-pg/gallery-edit.js` (the `_geActiveJob` state machine, added 增补#21, `docs/playground-architecture.md`).

#### Setup
- Build the playground variant: `go build -tags playground -o tinylab-pg.exe .` (default build does NOT embed playground assets — `//go:build playground` gates `web/playground/embed_playground.go`).
- Isolated smoke dir + config (STRICT yaml, never touch the user's `config.yaml`): `printf 'port: 18099\nenablePlayground: true\n' > $SMOKE/config.yaml` (`enablePlayground` is the config field, `internal/config/types.go`).
- `hub start` with `cwd=$SMOKE`, `ready={"port":18099}`, `pty:false`. ffmpeg/ffprobe must be on PATH (gallery edit resolves via `mediaedit.ResolveFfmpeg(cfg.Download.FfmpegPath)` → PATH fallback).
- Craft media with ffmpeg in `$SMOKE/media/`: a 30s 1280x720 `test.mp4` for video transcode; for **batch** use large NOISY PNGs (`-f lavfi -i testsrc2=size=6000x6000 -frames:v 1 slow.png`) — small/solid PNGs encode in <1s and finish before you can close+reopen, so the restore window never opens.

#### The state machine (what to assert)
Module globals (top-level `var`, classic scripts → `window.*` even under `'use strict'`):
- `window._geActiveJob` — `null` | `{kind:'single',jobId,item,mediaType,probe}` | `{kind:'batch',mediaType,item,probe}`. Set in `_startJob`/`_startBatch`; cleared in `_onCompleted`/`_onError`/`_onCancelled`/`_onBatchComplete` (any terminal state releases the lock).
- `window._editJobId` — live single-job poll id (null when idle).
- `window._batchJobs` (array of `{item,jobId,done,error,polling,...}`), `window._batchTotal`, `window._batchDone`, `window._geBatchPollingEnabled`.
- `window.openMediaEditor` is `async`; if `_geActiveJob` is set it does an in-flight check (single→`fetch /api/gallery/edit/status/{jobId}` `running`; batch→`_batchDone<_batchTotal`), then `_geResumeActive()` re-shows the persisted modal DOM (`overlay.classList.add('show')` — `pgCloseModal` only hides, never wipes) + resumes polling and **ignores the new item**. Terminal → clears `_geActiveJob` and falls through to a normal fresh load.

Key facts: `pgCloseModal()` (pg-modal.js) only removes `show` — it does NOT wipe `overlay.innerHTML` and does NOT stop polling or clear `_geActiveJob`. `cleanupMediaEditor` (fires on gallery page leave, `gallery.js`) stops polling + `_geBatchPollingEnabled=false` + disconnects the ResizeObserver but **keeps `_geActiveJob`**. The footer `Cancel` (geCancel) calls `pgCloseModal` (close, job continues); the progress `Cancel Job` (`#ge-cancel-btn` → `_cancelJob`) actually cancels (backend `POST /edit/cancel/{jobId}`) — and for a batch it cancels ALL non-done jobs + clears the lock.

#### Recipes (browser `run` cells)

**Single: height match + close-keeps-running + reopen-lock + release-on-complete**
```js
// open video editor, start transcode
await tab.evaluate(p=>window.openMediaEditor({absPath:p,name:'test.mp4',kind:'plain',path:p},'video'), vidPath);
await new Promise(r=>setTimeout(r,900)); await tab.click('#ge-start-btn'); await new Promise(r=>setTimeout(r,850));
const s1=await tab.evaluate(()=>{const ov=document.getElementById('pg-modal-overlay');const L=ov?.querySelector('.pg-modal:not(.ge-console-panel)');const C=document.getElementById('ge-console-panel');return{job:window._editJobId,LH:L&&Math.round(L.getBoundingClientRect().height),CH:C&&Math.round(C.getBoundingClientRect().height)};});
const jobId=s1.job;
await tab.evaluate(()=>window.pgCloseModal()); await new Promise(r=>setTimeout(r,400));
const closed=await tab.evaluate(async j=>{const r=await fetch('/api/gallery/edit/status/'+j);return r.ok?(await r.json()).status:'gone';}, jobId); // expect 'running'
// reopen with a DIFFERENT (image) item → must restore the VIDEO task, not load image
await tab.evaluate(p=>window.openMediaEditor({absPath:p,name:'test.png',kind:'plain',path:p},'image'), imgPath);
await new Promise(r=>setTimeout(r,1000));
const lock=await tab.evaluate(()=>{const t=document.querySelector('#pg-modal-overlay .pg-modal .pg-modal-title');return{title:t&&t.textContent.trim(),mt:window._editMediaType};}); // expect title='Video Convert', mt='video'
// wait completion, then opening image loads fresh
while(await tab.evaluate(()=>window._geActiveJob)) await new Promise(r=>setTimeout(r,500));
await tab.evaluate(p=>window.openMediaEditor({absPath:p,name:'test.png',kind:'plain',path:p},'image'), imgPath);
// expect title='Image Convert', mt='image'
```
Pass criterion: `LH===CH` (height fix); `closed==='running'`; reopen-with-image shows the **active** task's title/mediaType (lock); after completion, a new open loads the new item fresh.

**Batch: start via direct `_startBatch`, close, reopen-restores-batch, cancel**
```js
await tab.evaluate(p=>window.openMediaEditor({absPath:p,name:'slow1.png',kind:'plain',path:p},'image'), slow1);
await new Promise(r=>setTimeout(r,900));
await tab.evaluate((a,b)=>window._startBatch('image_transcode',{format:'webp',quality:90,scalePercent:100,stripMetadata:false},{overwrite:false,outputDir:''},false,[{absPath:a,name:'slow1.png',kind:'plain',path:a},{absPath:b,name:'slow2.png',kind:'plain',path:b}]), slow1, slow2);
await new Promise(r=>setTimeout(r,700)); // batch running: _batchDone=0, 2 console blocks
const ids=await tab.evaluate(()=>window._batchJobs.filter(j=>j.jobId&&!j.done).map(j=>j.jobId));
await tab.evaluate(()=>window.pgCloseModal()); await new Promise(r=>setTimeout(r,300));
// reopen with VIDEO → must restore the image BATCH (title 'Image Convert', mt 'image')
await tab.evaluate(p=>window.openMediaEditor({absPath:p,name:'test.mp4',kind:'plain',path:p},'video'), vidPath);
// expect title='Image Convert', mt='image' (NOT 'Video Convert')
// cancel: click #ge-cancel-btn → all jobs 'cancelled', _geActiveJob=null, _batchJobs=[]
await tab.click('#ge-cancel-btn');
const sts=await tab.evaluate(async I=>{const o=[];for(const i of I){const r=await fetch('/api/gallery/edit/status/'+i);o.push(r.ok?(await r.json()).status:'gone');}return o;}, ids); // expect ['cancelled','cancelled']
```
Pass criterion: `window._geActiveJob.kind==='batch'` while running; close keeps `done<total`; reopen-with-video restores the image batch (title `Image Convert`); cancel → every job backend-status `cancelled` and `_geActiveJob`/`_batchJobs` cleared.

#### Gotchas
- `tab.waitFor` takes a STRING selector, not a fn — use `await new Promise(r=>setTimeout(r,ms))` after `openMediaEditor` (the probe + `_bindModalEvents` run on `setTimeout`).
- Top-level `var` in these classic scripts is `window.*`-accessible; don't expect `_geActiveJob` on `window` if the script ever migrates to a module/`let`.
- `_geConsoleBlock` finds-or-creates by `data-job="jobId"`; on `_geResumeActive` the persisted console blocks survive (pgCloseModal didn't wipe), so the resumed poll updates the existing block (no duplicate).
- A batch that finishes before you close+reopen can't exercise the restore path — use 6000x6000+ noisy (`testsrc2`) PNGs so each webp encode takes ~2-4s.

#### Cleanup
`hub stop`; `rm -rf $SMOKE`; `rm -f tinylab-pg.exe`; remove any transcode output written to the user's real download dir (Set Path ON default → `$HOME/Downloads/<name>.<ext>`). Never leave smoke exes/config in the working tree.

## gallery-edit-f6997d6-review-findings


### Gallery Edit — f6997d6 Review Findings & Fix Plan

Context: commit f6997d6 (2026-07-28) reworked gallery-edit batch/naming/replace. Review found the headline "replace original" feature is UNREACHABLE from the UI. User confirmed symptom: "原地替换一直无法实现，表现为原地保存了一个新的" — root cause below. User wants TRUE in-place replacement restored (review-only mode; do not fix until asked).

#### Bug 1 (fatal, regression): `_getDestination()` drops the radio read
`web/playground/static-pg/gallery-edit.js` `_getDestination` (~line 1786) always returns `{overwrite:false, outputDir:<ge-dest-dir value>}`. Pre-commit it read `input[name="ge-dest"]:checked` and returned `overwrite:true` for the default radio. Consequences:
- `ge-dest-dir` is pre-filled with the default download dir on modal open → "Same Path" silently saves to the download dir as `<stem>.<ext>`.
- `_startJob` `_zipReplacePending` (needs overwrite=true) → single-file zip writeback DEAD.
- `_onBatchComplete` zip writeback branch (needs `_batchDest.overwrite`) → batch zip writeback (`ReplaceZipEntries`, `/edit/zip-writeback`, its tests) DEAD — reachable only via handcrafted API calls.
- `canReplace`/`geNoDiskPath` guard dead.
- i18n label mismatch: en `geReplaceOriginal:'Same Path'` vs zh `'原地替换原文件'` (pg-i18n.js:285/592).

#### Bug 2 (fatal for true replace, PRE-EXISTING server flaw): overwrite temp file uses ORIGINAL extension
`internal/mediaedit/manager.go` `runJob` (~line 112): `ext := filepath.Ext(outputPath)` (== input path in overwrite mode) → temp `photo.png.mediaedit_tmp.png`. ffmpeg picks encoder/muxer by output filename:
- image_transcode forces no encoder (`BuildImageTranscodeArgs` has no `-c:v`/`-f`) → PNG→WebP "replace" silently re-encodes PNG into photo.png.
- video_transcode forces `-c:v` but container from temp name → VP9/AV1 into .mp4 temp = ffmpeg error; mp4→mkv silently yields mp4.
Fix direction: pass buildArgs' target ext into runJob for the temp name; define replace semantics for ext change — recommended: output `<stem><newExt>` in original dir + delete original on success; zip writeback should RENAME the entry (`photo.png`→`photo.webp`), else archive holds png-named webp bytes. Alternative: restrict replace to same-format ops.

#### Bug 3 (high): batch non-compress "Open Folder" button is dead
`_onBatchComplete` (~line 734-745): onclick closure reads `_batchJobs`, but `_batchJobs = []` runs synchronously at function end before any click → loop over empty array. Compress branch works (captures `data.zipPath`); writeback branch works (captures `archivePath`). Fix: capture first successful outputPath in a local before wiring.

#### Bug 4 (high): `_getSiblingImages()` returns `undefined` for kind:'plain'
Function ends after the backend branch with no `return` (~line 393-395). Batch checkbox onchange (`sib.length`) and `_startBatch` (`siblings.length`) throw TypeError for pasted single-blob items (reachable via triggerMediaEditor upload-temp path which keeps kind:'plain'). Fix: `return []` at the end.

#### Bug 5 (must-fix-with-1): `_startBatch` lacks the canReplace guard
Once overwrite wiring is restored, fs/plain/FSAA-zip batch "Same Path" would "replace" temp inputs while originals stay untouched and UI reports success. Add the same `canReplace` check as `_startJob` (kind==='backend' || zip with zipAbsPath+zipPath) → else `showMsg(geNoDiskPath)`. Also hide the renorm (sequential rename) row when Same Path radio is on — rename contradicts in-place replace — and delete the then-unreachable `manager.go` `OutputName != "" && !Overwrite` same-path branch (~line 59-66) plus the wrong `_startBatch` comment claiming overwrite appends `_desc+ext`.

#### Medium/low
- Batch poll loops (`_pollBatchJob` setTimeout chains) have no cancel/generation guard; stale polls index into a NEW `_batchJobs` array after modal close/new batch → state pollution. Add `_batchSeq` generation token.
- `internal/gallery/zip_replace.go` doc claims untouched entries "copied byte-for-byte" — actually decompress+recompress. Use `zw.Copy(f)` (Go 1.17+) for true raw copy; non-Store/Deflate entries (bzip2) fail CreateHeader → whole writeback fails.
- `galleryEditZipOutputs`: io.Copy error ignored, Close errors unchecked, os.Create non-atomic (writeback endpoint uses fsutil.AtomicWrite — inconsistent).
- Dead code after "Show in Gallery" removal: `_addOutputToGallery` (~50 lines, no callers) + `geShowInGallery`; duplicate `var logHtml` in `_onCompleted` (line ~89 dead).
- `#dl-settings-overlay{z-index:10001}` hardcoded (tokens: --z-modal:50, --z-tooltip:10005); convention is calc(var(--z-modal) + 1).
- `_batchOriginZipName` stripExt eats "archive.v2"→"archive"; only strip .zip.
- Temp input files (extract-zip-entry/upload-temp) never cleaned after batch/single zip flows.
- After zip writeback, gallery session/thumbnails show stale bytes; no refresh/notice.

#### Fix order (proposed, NOT executed — user asked review-only)
1. `_getDestination` restores radio read (overwrite = value==='overwrite'; outputDir only for 'dir').
2. runJob temp uses target ext; replace semantics for ext change (new-ext file + delete original; zip entry rename). Reconcile labels en/zh back to "Replace Original File"/"替换原始文件".
3. `_startBatch` canReplace guard; hide renorm row on Same Path; remove manager.go dead same-path OutputName branch.
4. Fix Bug 3 (local capture) and Bug 4 (`return []`); delete dead code.
5. Tests: overwrite=true end-to-end incl. ext change; `_getSiblingImages` plain → []; batch complete button wiring. Existing tests pass precisely because they never touch the broken client paths.

#### Verification
`go build ./...`; `go test ./internal/api/gallery/ ./internal/mediaedit/ ./internal/gallery/`; `node --check web/playground/static-pg/gallery-edit.js` — all green at f6997d6 despite the bugs above.

## gallery-edit-item-shape


### TinyLab Gallery Edit — Item Shape & Batch-Flow Facts

Key file: `web/playground/static-pg/gallery-edit.js`. Related: `gallery-io.js`, `gallery-tree.js`, `gallery-video.js`, `internal/gallery/zip_replace.go`, `internal/mediaedit/`, `internal/api/gallery/register.go`.


#### Gallery item field availability (real shape, from gallery-io.js source)

Items in `galleryState.items` vary by `kind`:

| `kind` | created by | matching fields present | matching fields ABSENT |
|---|---|---|---|
| `'backend'` | `onOpenDirBackend` / paste-path | `absPath` (disk abs), `rootDirPath` (folder abs) | — |
| `'fs'` | `walkDir` (FSAA Directory Picker fallback / drag-drop folder) | `handle` (FileSystemFileHandle), `rootDirHandle` (FileSystemDirectoryHandle), `getBlob()` | `absPath`, `rootDirPath`, `zipAbsPath` |
| `'zip'` backend | archive inside a backend-opened folder | `zipPath` (rel in archive), `sessionId`, `zipAbsPath` (disk abs of .zip) | `absPath`, `rootDirPath` |
| `'zip'` FSAA-drop | `addZipBlob` (drag-drop a .zip) | `zipPath`, `sessionId`, `zipFileHandle`, `zipFile` | `zipAbsPath`, `absPath`, `rootDirPath` |
| `'plain'` | paste single file blob | `{ file }` only | no disk identity |

#### Sibling matching — canonical keys (`_getSiblingImages`, gallery-edit.js)

Groups by `kind`, mirroring `itemsInNode()` (gallery-tree.js):
- `'backend'` → `rootDirPath` (fallback: `_dirOfPath(absPath)`)
- `'fs'` → `rootDirHandle` identity-equal
- `'zip'` → `zipAbsPath` (backend archive) or fallback `sessionId` (FSAA-drop archive)
- `'plain'` → excluded

**Common bug source:** any matcher reading only `absPath`/`rootDirPath`/`zipAbsPath` returns `[]` for FSAA items (those fields absent) — this was the "Convert all = 0 / can't start" root cause.

#### Batch-convert flow
- `_resolveBatchInput(it)` → per-item disk path: `absPath` if present, else `POST /edit/extract-zip-entry {zipAbsPath|sessionId, zipPath}` (zip) or `getBlob()` + `POST /edit/upload-temp?name=` (fs). Mirrors single-file `triggerMediaEditor()`.
- `_startBatch` sends `/edit/start` with `outputName` = per-item stem (original, or `prefix+pad(idx+1,digits)` when sequential-rename on). Server appends the extension via `buildArgs`.
- `_captureBatchCfg()` reads rename/normalise control state into `_batchCfg` so async `_onBatchComplete` can still honour it after controls reset.

#### replace-original (where there IS a real source path)
- `'backend'` (file/dir): server ffmpeg `overwrite:true` writes back to the real `absPath`. Works.
- `'zip'` with `zipAbsPath` + `zipPath`: `POST /edit/zip-writeback {archivePath, entries:[{zipPath, filePath}]}` → `internal/gallery/zip_replace.go` `ReplaceZipEntries` (preserves untouched entries byte-for-byte: Method/Modified/Extra/comment), `fsutil.AtomicWrite` back to disk, best-effort deletes temp inputs.
- `'fs'` / FSAA-drop `'zip'` / `'plain'`: `_startJob` guard `overwrite && !canReplace` → `showMsg('geNoDiskPath')` and refuses (overwriting their temp input would silently no-op).
- Client flags: `_zipReplacePending` (single-image zip), `_zipWritebackBatch` (convert-all zip).

#### show-in-gallery fix (`_addOutputToGallery`)
- Set `item.path = <dir-basename>/<outputName>` (NOT bare `outputName`): `getDirPath()` (gallery-tree.js) groups on `path`, so a bare name falls into the Root bucket and `renderThumbnails` (filters by `currentFolderIndices`) never shows it.
- After `appendItems([item])`, call `updateCurrentFolderItems(idx)` + `renderTreePanel()` to re-derive `currentFolderIndices` and re-render the strip. `setActive(idx)` alone only updates the big-image view.

#### i18n gotcha (pg-i18n.js)
`pgT(key, args)` replaces `{0}`/`{1}`/`{i}` placeholders, NOT `%s`. Parameterized strings must use `{i}`; `%s` strings render literally (was the "✔ %s completed, %s failed" bug). Keys with args: `geBatchProgress`, `geBatchDone`, `geRenormHint`, `geOutputDims`, etc.

#### Verification
- `node --check web/playground/static-pg/gallery-edit.js`
- `go build ./...`
- `go test ./internal/api/gallery/ ./internal/mediaedit/ ./internal/gallery/`

## gallery-edit-naming-replace-conventions


### Gallery Edit Modal — Naming & Replace-Original Conventions

Use when fixing naming, "replace original file" / in-place replace, "show in gallery", or batch-convert behaviour in `web/playground/static-pg/gallery-edit.js` (the Gallery media edit modal).

#### Single source of truth: `pgT` placeholder format

`pgT(key, args)` in `web/playground/static-pg/pg-core.js` substitutes **`{0}`, `{1}`, …** from the args array — NOT `%s`. Several i18n strings in `pg-i18n.js` historically used `%s`, which silently rendered literally ("✔ %s completed, %s failed"). When a parameterised string shows raw `%s` to the user, the i18n key is wrong, not `pgT`. Fix the string to `{0}/{1}`.

#### `_getDestination` — the radio contract (critical)

`_getDestination()` MUST read `input[name="ge-dest"]:checked` to determine `overwrite`. The radio has two values:
- `"overwrite"` → Same Path (in-place replace): `overwrite: true, outputDir: null`
- `"dir"` → Save to directory: `overwrite: false, outputDir: <value>`

**Regression caution:** commit `f6997d6` dropped the radio read, making `overwrite` always `false` — "Replace Original File" silently became save-to-download-dir. Fixed in `05b73ee`. If you refactor `_getDestination`, always preserve the radio read.

#### In-place replace (overwrite) semantics

`_startJob(op, params, overwrite, outputDir)` is the single entry point for all single-file operations. `_startBatch(op, params, dest, compress)` is the batch entry point. Both carry `canReplace` guards:

- `canReplace = kind==='backend' || (kind==='zip' && zipAbsPath && zipPath)`
- `overwrite && !canReplace` → `showMsg('geNoDiskPath')` and refuse (fs/plain/FSAA-drop-zip have no writable original)
- `_startBatch` also has this guard (added in `05b73ee`)

##### Server-side: cross-format true overwrite (`internal/mediaedit/manager.go`)

`Start()` when `req.Overwrite`:
- **Same format** (e.g. png→png with quality change): `outputPath = inputPath` (BuildOutputPath returns it). `runJob` detects `outputPath == job.InputPath` → temp file + rename (atomic overwrite).
- **Cross-format** (e.g. png→webp): `outputPath = <dir>/<stem><newExt>` (ffmpeg picks encoder by output file extension — writing webp bytes into a `.png` path would silently keep PNG format). `runJob` signature includes `removeOnSuccess string`; on success the original file is deleted, leaving the new-format file in its place.

This is the **non-obvious design decision**: cross-format "replace original" = produce `<stem>.<newExt>` next to the original, then delete the original. Not overwriting the original path byte-for-byte (which would produce a mislabeled file).

##### Single-file zip replace

`_startJob` sets `_zipReplacePending` when `overwrite && kind==='zip' && zipAbsPath && zipPath`. On completion, `_onCompleted` POSTs `/edit/zip-writeback {archivePath, entries:[{zipPath,filePath}]}`. Server uses `internal/gallery/zip_replace.go` `ReplaceZipEntries` + `fsutil.AtomicWrite`.

#### Output naming: `OutputName` (`StartRequest.OutputName`)

Bare stem, no extension. Server appends extension from `buildArgs`. Sent only in the `outputDir && !overwrite` (Save-to-dir) branch. The dead `OutputName != "" && !Overwrite && OutputDir == ""` branch was removed in `05b73ee` (Same Path = overwrite, unreachable).

Batch: `_startBatch` computes per-item stems (original basename stem, or `prefix+padNum(i+1,digits)` when sequential-rename is on). Sequential rename is **mutually exclusive** with Same Path (`_refreshBatchUXVisibility` gates renorm row by `!samePath`; dest radio `onchange` calls `_refreshBatchUXVisibility`).

#### i18n label

`geReplaceOriginal` — en: `"Replace Original File"`, zh: `"原地替换原文件"`. Was temporarily changed to "Same Path"/"同路径" in `f6997d6` when the overwrite feature was broken; restored in `05b73ee`.

#### Batch non-compress Open Folder button

`_onBatchComplete` clears `_batchJobs = []` after rendering results. The Open Folder onclick must capture `outputPaths[0]` (or `data.zipPath` for compress, `archivePath` for zip-writeback) in a closure variable BEFORE clearing — reading `_batchJobs` inside the onclick after it's cleared is a dead button.

#### show-in-gallery

`_addOutputToGallery` — set `item.path = <dir-basename>/<outputName>` so the item lands in a navigable folder bucket. After `appendItems([item])`, call `updateCurrentFolderItems(newIdx)` + `renderTreePanel()`. `setActive(idx)` alone only updates the big-image view. (Note: this function is currently unused — "Show in Gallery" buttons were removed — but retained for potential future use.)

#### Verification

- `node --check web/playground/static-pg/gallery-edit.js`
- `go build ./...`
- `go test ./internal/api/gallery/ ./internal/mediaedit/ ./internal/gallery/`
- Key test: `TestManager_TranscodeImage_Overwrite` — png→webp overwrite, expects `source.webp` output + `source.png` deleted.

## tinylab-gallery-edit-architecture


### TinyLab Gallery Edit Architecture Facts

Key file: `web/playground/static-pg/gallery-edit.js`. Related: `gallery-layout.js`, `gallery-io.js`, `gallery-tree.js`, `gallery-video.js`, `web/static/style.css`, `web/static/download.js`, `pg-i18n.js`, `pg-core.js`.

#### ⚠ f6997d6 (2026-07-28) replace-original is UNREACHABLE from the UI
`_getDestination()` was rewritten to always return `overwrite:false` (dropped the `input[name="ge-dest"]:checked` radio read) AND `ge-dest-dir` is pre-filled with the default download dir on modal open. Net effect: "Same Path" silently saves a new file named `<stem>.<ext>` into the download dir — exactly the "in-place saved a new one" symptom. Everything depending on `overwrite=true` is dead from the UI: `_startJob` `_zipReplacePending` (single-file zip writeback), `_onBatchComplete` zip-writeback branch, the `canReplace`/`geNoDiskPath` guard. Full review + fix plan: managed skill `gallery-edit-f6997d6-review-findings`. A second pre-existing server flaw: `runJob` builds the overwrite temp file with the ORIGINAL extension (`photo.png.mediaedit_tmp.png`) and image_transcode forces no encoder, so format-changing "replace" silently re-encodes to the ORIGINAL format; restrict replace to same-format ops OR pass buildArgs' target ext into runJob + handle ext-change as new-ext-file + delete original.

#### i18n placeholder format (critical, easy to get wrong)
- `pgT(key, argsArray)` in `pg-core.js` replaces `{0}`/`{1}`/`{2}`... positional placeholders — NOT `%s`.
- Any new parameterised string MUST use `{0}`/`{1}`. The previous `geBatchProgress`/`geBatchDone` used `%s` and rendered the literal text "✔ %s completed, %s failed" — a real shipped bug. Check existing strings before copying their style.
- f6997d6 labels mismatch: en `geReplaceOriginal:'Same Path'` vs zh `'原地替换原文件'` — one name, two meanings; reconcile before claiming in-place replace works.

#### Gallery item field availability (verified against current code)
- `gallery-io.js` is the ONLY source of items; `gallery-layout.js`/`updateNavPanel`/`rootDirPath` assignments mentioned in older notes DO NOT EXIST there.
- Per kind, set by the loader:
  - `kind:'backend'` (native picker `onOpenDirBackend`): `absPath` (full disk path) + `rootDirPath` (dir of origin) — both set.
  - `kind:'fs'` (`walkDir`, FSAA fallback / drag-drop dir): `handle` + `rootDirHandle` only. NO `absPath`, NO `rootDirPath`, NO `zipAbsPath`.
  - `kind:'zip'` (backend zip on disk): `zipPath` + `sessionId` + `zipAbsPath`. NO `absPath`.
  - `kind:'zip'` (FSAA-dropped zip, `addZipBlob`): `zipPath` + `sessionId` + `zipFileHandle`. NO `zipAbsPath`, NO `absPath`.
  - `kind:'plain'` (single pasted path/blob): no disk folder/archive identity.
- The older note claiming items use a `::` absPath encoding for archive entries is STALE — zip items carry dedicated `zipAbsPath`/`sessionId`/`zipPath` fields instead.

#### Sibling grouping (the convert-all count path)
- `_getSiblingImages()` switches on `kind`: backend→`rootDirPath` (+absPath dir fallback); fs→`rootDirHandle` identity; zip→`zipAbsPath` or `sessionId`. `kind:'plain'` has no siblings.
- CAVEAT at f6997d6: the plain/unknown fall-through has NO `return` → returns `undefined` → `sib.length` throws in the batch checkbox onchange and `_startBatch`. Always end with `return []`.
- This mirrors `itemsInNode()` in `gallery-fullscreen.js`. When you change grouping, check both for parity.

#### show-in-gallery / thumbnail refresh (DEAD at f6997d6)
- `gallery-tree.js` `renderThumbnails` filters by `galleryState.currentFolderIndices` (only items in the current dir bucket show). Adding an item to `galleryState.items` alone does NOT make it visible.
- When adding outputs back into the gallery (`_addOutputToGallery`), set `item.path` to `<dirBucketBasename>/<outputName>` so the item lands in a navigable bucket, then call `updateCurrentFolderItems(newIdx)` + `renderTreePanel()` to refresh the strip and tree. `setActive(idx)` alone only updates the big-image view.
- f6997d6 removed all "Show in Gallery" buttons from completion result areas; `_addOutputToGallery` (~50 lines) is now dead code (no callers) and `geShowInGallery` is an orphan key.

#### Edit completion / replace-original paths (currently dead — see ⚠)
- `_startJob` guards replace-original: only `kind:'backend'` (real absPath) and `kind:'zip'` with `zipAbsPath`+`zipPath` can be replaced in place; others prompt `geNoDiskPath` instead of silently writing to a temp file. `_startBatch` does NOT have this guard (gap).
- zip in-place replace: POST `/api/gallery/edit/zip-writeback {archivePath, entries:[{zipPath,filePath}]}` → `internal/gallery/zip_replace.go` `ReplaceZipEntries` (re-compresses untouched entries despite the "byte-for-byte" comment — `zw.Copy(f)` is the true raw copy; non-Store/Deflate entries like bzip2 fail CreateHeader → whole writeback fails). `fsutil.AtomicWrite` writes back.
- "Open Folder" button: POST `/api/gallery/open-folder {path}` → `fsutil.OpenInFileManager` (cross-platform). Replaces the old "Download" button which was meaningless for same-machine files. CAVEAT: the non-compress batch branch reads `_batchJobs` after `_batchJobs = []` → dead button at f6997d6; capture first outputPath locally before wiring.

#### Video controls DOM structure (trim mode / control replacement)
- `#gallery-controls` contains `#gallery-video-ctrl` (seeker row, class `.gallery-video-hover-ctrl`) and `#gallery-ctrl-inner` (button row with `.gallery-ctrl-left`/`-center`/`-right`).
- To replace all video buttons, set `#gallery-ctrl-inner` innerHTML (recreating the three divs), NOT `.gallery-ctrl-center` directly. Save/restore via a snapshot variable. After innerHTML replacement, re-query buttons before binding events; `setTimeout(..., 0)` works.
- After restoring, call `bindVideoControls()` (from gallery-video.js).

#### Modal z-index stacking
- `--z-modal: 50` in `web/static/style.css`; both `.pg-modal-overlay` and download.js `#dl-settings-overlay` use it, so same-z modals stack by DOM order (later wins). The download settings modal opened from the gear button uses `#dl-settings-overlay{z-index:10001}` (HARDCODED — out of token convention; `--z-tooltip:10005`). Convention is `calc(var(--z-modal) + 1)`.

#### Trim mode flow
- Trim tab → "Select Trim Ranges" → `_enterTrimMode()` closes modal, swaps seeker for multi-segment bar + 4 buttons → `_exitTrimMode(save)` restores and reopens modal via cached `_editProbe` (no re-probe).
- `_editTrimSegments` (confirmed) vs `_trimSegments` (live during trim mode).
- Backend multi-segment: `VideoTrimParams.Segments []TrimSegment`; multi-segment forces re-encode via filter_complex trim/atrim/concat in `internal/mediaedit/args.go`.

#### Edit-mergeOperating caution specific to this file
- `gallery-edit.js` is ~2000 lines and touched frequently. Tool `edit` anchors go stale when earlier edits in the same turn shifted line numbers. Re-`read` the affected region right before each non-trivial `edit`, and prefer the tool's recovered-anchor path over blind SWAP ranges when warned.

#### Batch poll loops caveat (f6997d6)
`_pollBatchJob` setTimeout chains are not under `_stopPolling`/`cleanupMediaEditor` control. Closing the modal or starting a new batch leaves stale polls alive that index into a NEW `_batchJobs` array → state pollution (wrong `_batchDone`, premature complete). Add a generation token (`_batchSeq`) captured per job.

#### Verification commands
- `go build ./...`; `go test ./internal/api/gallery/ ./internal/mediaedit/ ./internal/gallery/`
- `node --check web/playground/static-pg/gallery-edit.js`
- All pass at f6997d6 despite the client-wiring bugs above — tests bypass the client path.

## tinylab-gallery-edit-browser-smoke


### Browser smoke-test for the Playground Gallery edit modal

Use when you change `web/playground/static-pg/gallery-edit*.js`, `pg-i18n.js`, `playground.css`, or the mediaedit/edit_handlers backend and need runtime proof of the Gallery ImageConvert/VideoConvert modal (i18n, tooltips, source rows, console panel). `node --check` only catches syntax; the modal is dynamic DOM built by JS and driven by `/api/gallery/edit/*` + ffprobe/ffmpeg.

The existing `tinylab-frontend-smoke-test` skill covers the **admin** web/static SPA; this covers the **playground gallery edit modal** specifically.

#### Build + run (isolated, never touch the user's config.yaml)
- Playground assets are embedded ONLY with `-tags playground` (`web/playground/embed_playground.go`); the default build serves no playground. Build: `go build -tags playground -o tinylab-pg.exe .`.
- Config is **strict YAML** — unknown fields abort. Use only `port: <port>` + `enablePlayground: true` (field is `enablePlayground` in `config/types.go:337`).
- `pg-*.js` + `gallery-edit*.js` load **unconditionally** in `index.html` (lines ~131–154), so `window.openMediaEditor` / `window.T` / `window.pgShowModal` are available on **any** page — you do NOT need to navigate to the gallery.
- ffmpeg/ffprobe: check `where ffmpeg`; the handler resolves via `mediaedit.ResolveFfmpeg(cfg.Download.FfmpegPath)` → `FFMPEG_PATH` env → `exec.LookPath`. On PATH it just works.
- Generate test media: `ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc=duration=30:size=1280x720:rate=25 -c:v libx264 -pix_fmt yuv420p <dir>/test.mp4` (long enough to stream multiple progress blocks); a still PNG via `-f lavfi -i color=c=steelblue:s=320x240:d=1 -frames:v 1 <dir>/test.png`.

#### Driving the modal without the native picker (headless-friendly)
The gallery loads items via a native directory picker / clipboard (`galleryPastePaths` CF_HDROP) — hard headless. Instead call the entry point directly:
```js
window.openMediaEditor({absPath:'<abs>/test.mp4', name:'test.mp4', kind:'plain', path:'<abs>/test.mp4'}, 'video');
// 'image' for the image modal; use test.png + kind:'plain'
```
`openMediaEditor` (`gallery-edit.js`) probes `/api/gallery/edit/probe` with `item.absPath` (real file → ffprobe returns dims/codec/duration) and fills source rows. Set `data-lang` + `localStorage.lang` before calling for the language you want.

`triggerMediaEditor` requires a real `galleryState` item — do NOT use it for smoke; `openMediaEditor` is self-contained given a crafted item.

#### Assertions
- **i18n**: title = `document.querySelector('#pg-modal-overlay .pg-modal .pg-modal-title').textContent` (first `.pg-modal` is the editor; the console panel appended after is the 2nd). cn → `图片转换`/`视频转换`, en → `Image Convert`/`Video Convert`, no `ge` prefix. `T('geVideoConvert')` runtime check; non-ge `T('cancel')` still returns the global translation (fallback intact).
- **Source rows** (`_renderSourceInfoRows(prefix)`): ids `ge-vid-src-row1`/`-row2` (video) and `ge-img-src-row1`/`-row2` (image). For a `kind:'plain'` item row1 = directory (`_editVideoPath`/`_editContainerPath` strip the filename), row2 = `name` + metadata.
- **Tooltips**: `#ge-settings-btn` (image + video), `#ge-archive-toggle` (**image-only**), `#ge-browse-dir-btn` should have `data-tooltip` and NOT `title`. Dynamic archive tooltip: `el.click()` then re-read `getAttribute('data-tooltip')` — it flips `geArchiveHint`↔`geSingleHint` and `data-archive` 0↔1.
- **Console panel** (the risky one): click `#ge-start-btn` (Start calls `_startJob` → `_showProgressSection()` in `gallery-edit-operations.js`). Then:
  - `#ge-console-panel` `getComputedStyle().display === 'flex'`.
  - Command: `#ge-console-log .ge-console-block-cmd` textContent starts with `$ ffmpeg` (NOT the top-level `#ge-console-cmd`, which is only cleared, never written — `_updateProgress` writes the block's cmd).
  - Live log: `#ge-console-log .ge-console-block-log` textContent **grows** between 600ms polls (`out_time_us` advances, ends `progress=end`). Polling is `setInterval` 600ms in `_startPolling`.
  - Completion: `#ge-result-area` gets a success marker (`✔ 完成…`); console stays `flex` (only `_onCancelled` hides it via `_hideProgressSection`).

#### Gotchas
- **Output lands in the default Downloads dir**: `openMediaEditor` sets `ge-img-setpath` ON and prefills `ge-dest-dir` from `/api/settings` `download.defaultDir` (the app default, even with a minimal config). The transcode writes there — clean it up (`<defaultDir>/test.mp4`) after. To force output next to source instead, uncheck `ge-img-setpath` before Start (empty dest-dir → `_startJob` omits `outputDir`).
- `tab.waitFor`/`tab.click` take **string selectors only** (not functions); use scope-level `wait(fn)` for polling, or plain `setTimeout` sleeps (the modal is created synchronously by `openMediaEditor`; only the probe is async — sleep ~1s for source rows).
- **Backend live-value fact**: `Manager.Get` returns `v.(*Job).Snapshot()` — so `galleryEditStatus` reading `job.LogTail`/`job.Command` directly IS correct: `Snapshot()` reads `logBuf` live while running, falls back to `LogTail` after finish. Don't "fix" the direct field access to call Snapshot — it already does.
- The console panel is appended to `#pg-modal-overlay` by `_geEnsureConsole()` (called after every editor-opening `pgShowModal`); it's hidden until `_showProgressSection`.

#### Cleanup
Stop server, `rm -rf` smoke dir, `rm` the playground-tagged exe + the transcode output in Downloads. Leave `tinylab.exe` (standard build, gitignored) unless you know it's yours.

## tinylab-gallery-meta-sidebar-architecture


### TinyLab Gallery 元数据侧边栏（gallery-meta.js）

Gallery 的生成元数据显示实现（2026-08-10 三轮回合定型：注入 → 弹窗 → **右侧 1/3 固定侧边栏**）。改这里之前先读 `docs/playground-architecture.md` §16（活文档，随代码同步）与 `skill://tinylab-escape-key-capture-phase-requirement`（ESC 陷阱）。

#### 布局模型（替换了原 hover 弹窗，勿回退）

- DOM：`gallery-layout.js::buildPanelHTML` 在图片/视频 pane 各建 `#gallery-meta-sidebar`（flex 子项，无 inline style）。按钮 `#gallery-meta-btn`（带 `gallery-meta-btn` class——缺了它 `.active` 样式永不匹配，这是历史 bug 根因）。
- 开关：`toggleMetaOverlay()` 翻转 `galleryState.metaOverlayEnabled`，给所有 `#gallery-main` 加/去 `.gallery-meta-open`；**CSS 驱动显隐**（`.gallery-main.gallery-meta-open .gallery-meta-sidebar{display:block}`），不要用 inline display 控制。
- 布局：侧边栏 `flex:0 0 33.333%;max-width:33.333%;height:100%;overflow-y:auto;scrollbar-width:none` + `::-webkit-scrollbar{display:none}`（可滚动无滚动条）；媒体元素在 `.gallery-meta-open` 下 `flex:1 1 auto;min-width:0;width/height:100%;object-fit:contain` —— 自动左移 2/3 并等比缩放。`.gallery-main` 本身 `display:flex;align-items:center;justify-content:center`（style.css:3377），open 时 `justify-content:flex-start`。
- 重渲染：`renderMetaSidebar(paneIsVideo)` 按 pane 匹配（split 双 pane 用 `querySelectorAll('#gallery-main')` + `isVidPane` 判定），内容走 metaCache 或异步 `readItemMetadata`（回调里守卫 `metaOverlayEnabled` + item 未变 + `sidebar.isConnected`）。挂载点：`renderActive`（gallery-tree.js）末尾 `renderMetaSidebar(false)`、`renderActiveVideo`（gallery-video.js）末尾 `renderMetaSidebar(true)`；`bindEventsForCurrentLayout` 在布局重建后重应用 `.gallery-meta-open` 并重渲染。
- 状态：`galleryState` 只有 `metaOverlayEnabled` + `metaCache`。**`metaOverlayVisible` 已删除**——侧边栏开合 == `metaOverlayEnabled`，别再引入第二个状态。`updateLayoutMode` 只重建 DOM，开合由 bindEvents 恢复。

#### 内容管线（客户端解析，勿动核心）

- `readPNGTextChunks`：PNG tEXt，重复 key 保留首个，越界保护；值经 `String.fromCharCode` 逐字节读（ComfyUI 写 `\uXXXX` ASCII-safe JSON，PIL 按 latin-1）。
- `readMP4Metadata`：`moov→udta→meta` full-box（meta 跳 4 字节 version/flags）；`keys` 条目 = `size(4)+namespace(4)+键名`（键名在 offset 8，offset 12 会截头 4 字符）；`ilst` 条目 = `size(4)+index(4,1-based)+data 子盒(type/flags(4)+locale(4)+值)`；值 UTF-8 解码。
- `_extractPromptMeta`：解析 `prompt` 键为对象时，把同文件 `workflow` 键解析后存为 `parsed.__workflow_graph`（浮层据此显示 Workflow Yes/No；渲染节点清单时跳过 `__` 前缀 key）。
- `_comfyPrompts` 三阶段正/负向提取：① sampler/guider 节点 `inputs.positive/negative[0]` 链接指向的 CLIPTextEncode id；② 未分类节点按 `_meta.title` 匹配 `/negative|neg\b|负面|负向|反向/i`；③ 无 CLIPTextEncode 时扫所有节点的 `inputs.prompt` 取最长（MiniMax H3 视频的 prompt 在 `MiniMaxH3ImageToVideo.inputs.prompt`，不在 CLIPTextEncode）。SDXL 节点 text 缺失时拼 `text_g`+`text_l`。
- `formatMetadataForOverlay`：Prompt 全量首显 + Negative Prompt 分行全显（`.gm-prompt` block + `white-space:pre-wrap`），其余（模型/参数/节点清单/来源/Workflow）折叠进 `<details class="gm-more">`；三形态（TinyLab 记录 / ComfyUI 图 / 兜底 `<pre>`），所有动态值 `escapeHtml`。
- i18n：`gmMetaToggle/gmMetaLoading/gmMetaNone/gmPrompt/gmModel/gmParams/gmSource/gmNegative/gmDetails`（en+cn 两本 dict）。

#### ESC（历史三连坑，见 escape-key-capture 技能）

`onMetaOverlayKeyDown` capture 阶段（模块加载时注册一次），条件 `galleryState.metaOverlayEnabled`，动作 `toggleMetaOverlay()`，必须 `stopImmediatePropagation`（仅 stopPropagation 无法挡住同节点同阶段的 `onFullscreenKey` → 会顺带退出全屏）。`onFullscreenKey`/`onGalleryKeyDown` 顶部各有兜底分支。

#### 用户偏好（本仓库维护节奏）

该用户端测为主：**明确要求不做浏览器端测**，交付前跑 `node --check`（改到的 JS）、`gofmt -l`、`go build ./...`、`go test ./internal/feature/...`、grep 确认旧符号零残留即可，尽快交付。改动后按 AGENTS.md 同步 PROJECT_MAP.md 最后核对行 + playground-architecture.md §16/§21/§23。

