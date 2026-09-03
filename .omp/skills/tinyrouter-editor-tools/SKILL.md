---
name: tinylab-editor-tools
description: "TinyLab editor/utility maintenance: native file & directory picker deadlock (WebView2), Editor title rename vs physical file divergence, and StackEdit editor integration planning."
---


## tinylab-editor-native-picker-docdir-bootstrap


## tinylab-editor-rename-webview-recovery


## tinylab-stackedit-editor-planning


## tinylab-editor-native-picker-docdir-bootstrap

name: tinylab-editor-native-picker-docdir-bootstrap
description: "Use when fixing TinyLab Editor/WebView/Chrome native file or directory pickers that must lock the entire app, or when Editor Explorer must rebuild from the configured docs directory on first launch and noisy debug logs need removal."

# TinyLab Editor native picker and docs-dir bootstrap

## Scope

Use for TinyLab Editor changes involving native OS file/directory dialogs, WebView2/Chrome interaction locking, first-launch Explorer contents, or removal of temporary Editor diagnostics.

## Native picker contract

Use one shared page-level lock in `web/static/app.js`:

- `beginNativePickerLock(kind)` returns `false` if another native picker is active; otherwise sets `window.__nativePickerBusy`, records the kind, and appends a transparent full-screen `#native-picker-blocker` with a high z-index.
- Register capture-phase handlers for pointer, context-menu, drag, focus, and keyboard events. While busy, call `preventDefault()` and `stopImmediatePropagation()`.
- `endNativePickerLock()` clears the flags and removes the blocker.
- Add the App global `keydown` guard for both `__nativePickerBusy` and any feature-specific busy flag.

Call the shared lock around every native picker request:

- `web/static/download.js::fasBrowsePicker` calls `beginNativePickerLock(mode)` before `/api/browse`, restores browse controls in `finally`, then calls `endNativePickerLock()`.
- `web/static/utility/editor/editor_shell.js::openLocalFile` calls the same lock before `/api/editor/open`, keeps it active through import completion, and always releases it in the final promise handler.

Do not rely only on disabling buttons or setting the current modal's `pointer-events`; those do not block navigation controls outside that modal or app-level shortcuts.

## Editor first-launch Explorer contract

The configured server `docDir` is authoritative when Editor is first entered in an app session:

1. Call `GET /api/editor/tree` after `EditorWorkspace.init()`.
2. Rebuild stable folder/file nodes from `relPath`:
   - folders: `docdir:<relative-folder>`
   - files: `doc:<relative-file>` with `{fileId: relPath, isDoc: true}`
3. Clear the persisted `currentFileId` and set expanded folders from the server tree.
4. Load the first doc file if one exists; do not fall back to a stale IndexedDB current file.
5. Keep later Utility navigation within the same session stateful; guard the bootstrap with a session-local boolean.

Implement the replacement in `web/static/utility/editor/editor_workspace.js` as `replaceDocTree(files)` and invoke it from `editor_shell.js::renderEditor` before reading current/expanded state. Preserve the existing IndexedDB/in-memory persistence contract and re-run `node --check` immediately after structural edits.

## Debug output cleanup

Remove temporary success-path `console.log`/`console.debug`/`console.info` from `editor_shell.js` (load, import, picker success, retry status). Retain actionable `warn`/`error` handling for failed requests and user-visible error paths. Verify with a focused search and syntax check.

## Verification

Run:

```text
node --check web/static/app.js web/static/download.js web/static/utility/editor/editor_shell.js web/static/utility/editor/editor_workspace.js
go test ./...
go build ./...
go build -tags playground ./...
go build -tags "tray,webview" ./...
```

Browser smoke in the main world should verify:

- `beginNativePickerLock()` creates the blocker;
- synthetic click and keydown events are canceled and do not reach page listeners;
- Editor startup displays files returned by `/api/editor/tree`, not stale IndexedDB current state;
- no `.ed-action-rename` button is rendered if title is the sole rename entry;
- picker cleanup removes the blocker after the request resolves or fails.

Update `PROJECT_MAP.md` and `docs/playground-architecture.md` with the shared picker lock, first-launch docs-dir rebuild, and diagnostic-log policy.


## tinylab-editor-rename-webview-recovery

name: tinylab-editor-rename-webview-recovery
description: "Use when TinyLab Utility Editor title rename changes Explorer but not the physical file, fails in WebView2, or native file-picker shortcuts remain active; covers pathGrant identity precedence, title-only rename UI, picker keyboard locking, HTML srcdoc script cleanup, and verification."

# TinyLab Editor 重命名 / WebView 修复流程

## 症状与根因

- 标题和 Explorer 已改名，但物理文件未改名：前端不能把标题变化交给 Save；必须先调用 `/api/editor/rename`，后续 Save 只写内容。
- Chrome 正常、WebView2 无效：native picker 返回的 owner-bound `pathGrantId` 必须优先于可能同时存在的 docDir-relative `fileId`。open/save/rename 三个后端目标解析都使用 grant 优先级；重命名响应在 grant 模式只保留 `pathGrantId`，并通过 `Store.Rebind` 更新授权目标。
- Explorer 同时有 Rename 按钮和标题入口：保留 `#ed-title` 为唯一重命名入口，移除 `ed-action-rename` 的 DOM、动作映射和无入口 hook。
- 打开 native file picker 时应用快捷键仍生效：设置全局 `__editorFilePickerBusy`，在 `window` 捕获阶段拦截 `keydown`、`keyup`、`keypress`，并在 `app.js` 全局快捷键 handler 增加同一 guard；busy 必须覆盖 picker 请求以及文件导入完成。
- HTML 预览出现 `about:srcdoc` sandbox script warning：保留 zero-permission iframe sandbox，同时将 `<script>`、self-closing script 和 inline `on*` handler 从 `srcdoc` 清除后再写入 iframe。

## 实施步骤

1. 先读 `PROJECT_MAP.md §24`、`docs/playground-architecture.md`、`skill://tinylab-utility-page-migration` 与 `skill://safe-edit-long-files`。
2. 检查 `web/static/utility/editor/editor_shell.js` 的 `renameCurrent`、`editorTargetBody`、`openLocalFile`、HTML `renderPreview`；检查 `editor_layout.js` Explorer action 构建；检查 `web/static/app.js` 全局 keydown handler。
3. 检查 `internal/api/editor/register.go` 的 `openTarget`、`saveTarget`、`renameTarget` 与 `editorOpen` 响应；确保 `pathGrantId` 优先于 `fileId`，raw path 仍拒绝，rename 使用原子 `os.Rename`。
4. 检查 `internal/pathgrant/pathgrant.go::Store.Rebind`：只允许 owner + write capability、非目录、非 symlink 的已存在目标；失败时 rename handler 回滚物理改名。
5. 前端标题流程必须是：prompt → `POST /api/editor/rename` → 成功后更新 IndexedDB node/meta、标题、Explorer；不要调用 Save 来改名。
6. 为后端增加/保持回归覆盖：物理改名、改名后 Save、冲突和非法文件名、raw path 拒绝、grant 重绑定、同时提供 fileId+pathGrantId 时 grant 目标优先。
7. 更新 `PROJECT_MAP.md` 与 `docs/playground-architecture.md` 的当前事实和维护清单；历史记录可以保留，但必须另加当前入口/合同说明。

## 验证

```text
go test ./internal/api/editor ./internal/pathgrant
go test ./...
go build ./...
go build -tags playground ./...
go build -tags "tray,webview" ./...
node --check web/static/app.js
node --check web/static/utility/editor/editor_shell.js
node --check web/static/utility/editor/editor_layout.js
node --check web/static/utility/editor/editor_workspace.js
```

浏览器冒烟至少确认：

- Explorer 只有 Open/Save/New File/New Folder；`#ed-title` 点击仍打开 Rename。
- 物理改名后旧路径 404、新路径 200。
- native picker busy 期间全局快捷键不触发，导入完成后恢复。
- HTML preview iframe 仍有 `sandbox=""`，其 `srcdoc` 不含 script 和 inline event handler。

无法直接运行真实 WebView2 时，至少运行 `go build -tags "tray,webview" ./...`，并用混合身份后端测试证明 WebView 的 grant 优先合同。


## tinylab-stackedit-editor-planning

name: tinylab-stackedit-editor-planning
description: Use when planning a TinyLab Utility Editor enhancement toward StackEdit-style local Markdown editing without Vue or cloud/sync features.

# TinyLab StackEdit-style Editor planning

Use this procedure before implementing a StackEdit-inspired Utility Editor change in `Z:/Playground/tinylab`.

## Research

1. Read `PROJECT_MAP.md §24` and `skill://tinylab-utility-page-migration` plus `skill://tinylab-utility-header-menu`.
2. Inspect the current Editor contracts:
   - `web/static/utility/editor/editor-state.js`
   - `web/static/utility/editor/editor.js`
   - `web/static/utility/editor/editor-logs.js`
   - `web/static/utility/editor/review.js`
   - `web/static/fs-api.js`
   - `web/static/index.html` and `index-nopg.html`
   - `web/static/style.css`
   - `internal/api/editor/register.go` and the `/api/editor` route in `internal/api/router.go`
   - `internal/feature/feature.go` and `feature_test.go`
3. Inspect StackEdit primary sources, especially `Layout.vue`, `NavigationBar.vue`, `ButtonBar.vue`, `Explorer.vue`, `ExplorerNode.vue`, `Editor.vue`, `Preview.vue`, `FindReplace.vue`, `StatusBar.vue`, `localDbSvc.js`, `workspaceSvc.js`, `editorSvc.js`, `markdownConversionSvc.js`, and `ImportExportMenu.vue`.

## Scope decisions

- Reproduce local layout and behavior, not StackEdit's Vue/Vuex framework.
- Keep local file open/save, Markdown editing, preview, toolbar, find/replace, diff, import/export, print, and persistence.
- Exclude OAuth, cloud workspaces, sync/publish, remote providers, comments/discussions, remote history, PDF/Pandoc, and remote sharing.
- Keep the current Diff capability as a secondary Editor mode; make single-document editor + independent preview the default.
- Make Editor work in the no-Playground build because its assets are `RootStatic`; remove hidden dependencies on `T()`, `pgRenderMarkdown()`, `pgHighlight()`, and `hljs`.

## Recommended phases

1. **Runtime boundary:** mark Editor as not requiring Playground; use a local i18n adapter; use RootStatic markdown-it/Prism/DOMPurify; consolidate duplicate `.ed-*` CSS into `web/static/style.css`; align both HTML script orders.
2. **Workspace:** add an IndexedDB-backed local node/content model with files, folders, Trash, Temp, current file, expanded folders, CRUD, rename, move, restore, and migration from `sessionStorage.trEditor`.
3. **Layout:** implement Explorer + navigation/format toolbar + editor/preview split + control bar + status bar + responsive mobile behavior; use theme tokens and accessible labels.
4. **Editor core:** retain textarea as the source of truth with a Prism mirror; render Markdown via markdown-it and sanitize via DOMPurify; add scroll sync, TOC, reader/focus/preview toggles, and optional KaTeX from existing assets promoted to RootStatic if required.
5. **Commands:** add formatting actions, undo/redo history, StackEdit-style find/replace overlay, shortcuts, and preserve Diff as a secondary mode.
6. **Local IO:** integrate native `/api/editor/open`/`save`, `FsApi` fallback, Markdown/HTML import via Turndown, Markdown/HTML export, and print.
7. **Lifecycle/docs:** add `suspendEditor`/`resumeEditor` without destroying state; update `PROJECT_MAP.md §18.2/§24`, `docs/playground-architecture.md`, and relevant asset/license documentation.

## Verification

Run `node --check` for all Editor modules, `go test ./...`, `go build ./...`, and `go build -tags playground ./...`. Browser-smoke both shells and verify file-tree CRUD/persistence, edit/preview, sanitization, scroll sync/TOC, toolbar/undo/find/diff, import/export/print, external atomic save, responsive layouts, theme variants, and Utility page suspend/resume without duplicate listeners.

