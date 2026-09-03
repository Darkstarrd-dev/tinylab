---
name: tinylab-audit-release
description: "TinyLab pre-release audit and recovery: vibe-worker audit driving, domain-sequenced remediation, post-checkout feature recovery, feature modularity, deployed-instance reconcile, and archive compatibility planning."
---

# TinyLab Pre-Release Audit & Recovery


## tinylab-release-audit-driver


### Driving a TinyLab Pre-Release Code Audit via Vibe Workers

Use when asked to run a pre-release / comprehensive code audit of TinyLab (or a similar multi-module Go+JS repo) by directing concurrent worker CLIs.

#### Workstream split (5 independent domains)
1. **Core** (good): `internal/proxy/` all + `internal/rotation/` + `internal/combo/` + `internal/sse/`,`urlutil/`,`util`. Docs: `docs/{proxy,rotation,combo}-architecture.md`.
2. **Infra** (good): `internal/config/`,`registry/`,`state/`,`keystate/`,`api/auth/`,`fsutil/`,`api/settings/register.go`,`api/apibase/deps.go`. Doc: `docs/config-registry-state-architecture.md`.
3. **Tools backend** (good): `internal/download/`,`mediaedit/`,`api/gallery/`,`gallery/`,`textreview/`,`api/textreview/`,`anysearch/`,`procutil/`. Docs: `docs/download-architecture.md` + playground-arch Gallery/TextReview sections.
4. **Frontend** (good): `web/static/` (admin SPA, 24 JS) + `web/playground/static-pg/` (37 JS). Prioritize web/static + XSS.
5. **Build verify** (fast): `go build`/`go vet ./...`/`go test ./...`/`gofmt -l .` + PROJECT_MAP §1–§18 vs disk drift + docs last-verified freshness.

#### Concurrency rules (HARD-WON — two rate-limit incidents)
- **Max 2 subagents concurrent.** 4–5 good-model agents at once trigger "502 all keys exhausted" / server rate limits and every session aborts with 0 tool calls. Batch: spawn 2, wait for BOTH to finish, spawn next 2, repeat.
- **Workers MUST NOT spawn internal subagents.** State this explicitly in every brief: *"do NOT spawn/fork/delegate to any sub-agent, scout, or secondary session; if throttled, retry the same call yourself."* A worker spawning an "i18n scout" subagent = 2 concurrent = rate-limit stall; symptom is the session stuck on "Waiting for … scout result" forever. This is the #1 stall cause.
- A `good` + `fast` pair in one batch is fine (different model tiers). Pair to balance: batch1 = core+build, batch2 = infra+tools, batch3 = frontend alone.

#### Brief pattern (per worker, self-contained — workers start blank)
Give each: project identity + location (`C:/opencode/tinylab`, Go 1.25, local LLM proxy, YAML config, AES-GCM keys, no DB); exact file scope; architecture docs to read for INTENDED behavior (to detect code-vs-doc drift); audit angles (concurrency, error handling, edge cases, resource leaks, security, maintainability, test gaps); "run `go vet`/`go test` on YOUR scoped packages only — do NOT run full `go test ./...` (a sibling owns that)"; run `gofmt -l` on scoped files.
Output contract: **write full findings to `C:/opencode/tinylab/.audit/<area>.md`** (Chinese, structured: 汇总 counts + 发现清单 with `[严重]`/`[高]`/… headers, `file:line`, 现象/影响/建议, severity-descending) **THEN reply with a short summary object** (counts + top5 + report path). Write file first, yield summary last (a null-yield = failed turn even when the file is complete).

#### Director verification (don't take the worker's word)
After each result, `read` the cited `file:line` for the top 1–2 findings yourself before trusting. Verified-critical examples from the 2026-08-03 audit:
- `cooldown.go:139` `IsDailyQuota429 = strings.Contains(body, model)` + `retry.go:217` fall-through → ordinary 429 (body contains model name) misclassified as daily quota lock. Real.
- `settings/register.go:144` `cfg.Rotation = *updates.Rotation` (whole-struct copy) wipes `StatePersist` (types.go:17, no omitempty) → state.yaml persistence disabled after restart. Contrast pointer-merge in trace/download/security at 157–183. Real.

#### Recovery patterns
- **Worker "failed" with null yield but already wrote `.audit/<area>.md`** → the report is likely complete (the failure was only the final summary yield). `read` the file; do NOT re-run the audit. (2026-08-03 tools audit "failed" this way but tools.md was fully written, 101 tool calls done.)
- **Worker stuck "Waiting for … result"** → it spawned a subagent and stalled on rate limit. `vibe_kill` it, re-spawn with the explicit no-subagent constraint.
- **`502 all keys exhausted`** mid-turn → transient quota drain; the session retains context. `vibe_send` a follow-up: "write the report NOW from evidence already gathered, do not re-read, do not spawn subagents." If the report file was already written before the 502, you may just `read` it and `vibe_kill` the follow-up.
- Use `vibe_list` when you lose track of the roster (dead/idle/running).

#### Empirical reproduction without touching the repo
Use `go test -overlay` (temp dir + overlay JSON pointing into `%TEMP%`/`$TMPDIR`) to inject a repro test for a suspected bug, run it, then delete the scratch file. Confirmed-working for the StatePersist-wipe repro. Verify `git status --porcelain` is clean after.

#### Environment fact
This Windows dev box has **no C compiler** → `go test -race` is unrunnable (`cgo: C compiler "C:\Program" not found`). All concurrency/race findings are **manual lock-order analysis only**, unverified by the race detector. Call this out in the report; recommend a CI with a C compiler run `-race`.

#### Cleanup
`.audit/` holds the per-area reports (core/infra/tools/frontend/build.md) + possibly scratch (e.g. `xss-test.html`). Leave for regression reference or delete; they're gitignored scratch, not repo files.

## tinylab-remediation-domain-sequencing


### TinyLab Audit Remediation — Domain Sequencing

#### Order (proven)
1. **build/docs-sync baseline** FIRST — establishes a green `go test ./...` + empty `gofmt -l .` + synced PROJECT_MAP/docs so every later domain can gate on full-suite-green.
   - Fix the known stale/failing test (e.g. `/api/usage/quotas` → `/api/monitor/quotas` after the usage→monitor rename — adjacent tests often already use the new path, so the missed one is the failure).
   - `gofmt -w` on every file in `gofmt -l .` (often ~60 files, many just missing trailing newline).
   - Fix PRE-EXISTING doc drift: phantom removed files in PROJECT_MAP §18, truncated module lists, duplicate section numbers, undocumented source files, stale `last verified` lines, renamed-file references in §24/docs.
2. **infra** (config/registry/state/security) — foundational; the StatePersist wipe (rotation PATCH whole-struct copy) breaks ALL downstream state persistence.
3. **core** (proxy/rotation/combo) — the 429 misclassification + trace/log + lock-order + truncation.
4. **tools** (download/mediaedit/gallery/textreview) — subprocess/lifecycle/decode-bound.
5. **frontend** (web/static + playground) — XSS class (last; no Go tests, gate = `node --check` + go build embed).

#### Per-domain worker brief essentials
- One `good` session per domain, sequential (1 concurrent avoids rate limits). Never respawn for follow-up on the same domain — `vibe_send` to the same idle session.
- **No sub-agents** instruction in EVERY brief (workers that spawn "scouts" stall on the resulting 2-concurrent rate limit).
- **Minimal final reply** ("reply ONLY a minimal JSON {branch,commit,files,gates,deferred}; NO prose; yield immediately after commit") — reduces the summary-stall risk (see `vibe-rate-limit-and-summary-stall-recovery` skill).
- AGENTS.md doc-sync mandate: each domain commit must update affected docs (`PROJECT_MAP.md` / `docs/*-architecture.md`) for behavioral changes IN THE SAME commit.
- Gate per domain: `go build ./...` + `GOOS=windows GOARCH=amd64 go build -tags playground ./...` + `go vet ./...` + `go test ./...` (0 fail) + `gofmt -l .` (empty). For frontend also `node --check` on all non-vendor `.js`.
- Commit: scoped `git add <specific files>` (never `git add -A`; never stage `.audit/` scratch — verify with `git diff --cached --name-only | grep audit` empty). Message: `fix(<domain>): <summary>`.
- `-race` is unavailable on Windows without a C compiler — note in each commit; verify locking by reasoning, recommend CI add a C compiler for `-race`.

#### Stalled worker recovery (happened twice: core, tools)
Worker completes all edits + tests green but hangs ~500s on the final model call. Recovery: `vibe_kill` → spawn `fast` triage worker → if stranded edits are green, `gofmt -w` drift + scoped `git add` + `git commit` with the intended message → report hash. The stranded edits are almost always complete and green. See the `vibe-rate-limit-and-summary-stall-recovery` skill for the exact triage prompt.

#### Director verification
After each domain commit, read the headline changed files yourself to confirm fix LOGIC (tests can be weak):
- core C1: `internal/rotation/cooldown.go` `IsDailyQuota429` narrowed (quota keyword + daily marker + exclude "try again in") + `cooldown_test.go` negative cases for OpenAI/Anthropic/Zhipu rate-limit bodies.
- core H3: `internal/proxy/stream.go` `passThroughResponse` uses `io.ReadAll(resp.Body)` (no `LimitReader`) for the client write; cap only the usage-capture copy.
- infra C2: `internal/api/settings/register.go` rotation handling calls a presence-aware merge helper (not `cfg.Rotation = *updates.Rotation`); `register_test.go` asserts StatePersist survives a 5-field PATCH + Save/Load round-trip.
- infra H4: `internal/registry/models.go` `ResolveModelAlias` inlines the prefix match (no `GetProviderByPrefix` call under held RLock).
- tools H6: `internal/download/binary.go` `destRe` makes quotes optional (`"?`).
- frontend C3: `web/static/monitor_quota.js` uses `escapeForJsString` (not `escapeHtml(...).replace`) in onclick.
- frontend H9: `web/playground/static-pg/pg-ui.js` `pgEscapeAttr` now escapes `"` (was missing).
- frontend H11: `web/static/index-nopg.html` has both the `<script src="/info_common.js">` AND the `#info-modal-overlay` DOM.

#### Result shape
5 commits on `main` above the pre-remediation HEAD; all gates green; `.audit/` reports uncommitted (reference or clean up later); deferred low-risk items noted per domain.

## post-checkout-feature-recovery-audit


### Post-checkout feature recovery audit

Use when a user reports that an accidental `checkout` or other agent action may have lost work, but they committed during or before the incident.

#### 1. Establish the committed baseline

1. Inspect recent history, reflog, current HEAD, and the relevant commit diff.
2. Identify the user’s feature commit by message, timestamp, and changed-file set.
3. Confirm whether later commits, reverts, resets, or checkout effects actually removed any feature files or merely left uncommitted follow-up fixes absent.
4. Never reset, checkout, or amend the user’s commit during this audit.

#### 2. Audit the observable contract, not just changed files

Build a checklist from the original request. For each item, inspect the concrete symbol/call path and label pass/fail with file and line evidence.

For Playground Image work, cover at least:

- UI rendering and event handlers (including normal text-mode behavior that a new image-mode path could accidentally bypass).
- Config defaults and persistence.
- Request body fields plus endpoint selection.
- Existing data-URL (`data:image/...;base64,...`) image input preservation.
- Protocol-specific behavior and bounds.
- i18n in English and Chinese.
- `PROJECT_MAP.md` plus `docs/playground-architecture.md` consistency.

Compare altered handlers to their parent-commit form when an unrelated call disappears. A removed cleanup/invalidation call can be a regression even when the new feature passes its direct checks.

#### 3. Repair minimally

- Restore only behavior proven lost or regressed.
- Update documentation tables and source-anchor descriptions when new request paths or fields are now canonical.
- Do not introduce migrations, fallbacks, multipart conversion, or unrelated refactors while recovering the feature.
- Preserve the user’s commit; leave repair changes separately visible for review/commit.

#### 4. Verify

1. Read every repaired code and documentation range after the worker edits it.
2. Run syntax checks for changed frontend JS.
3. Build the relevant tagged binary when assets depend on build tags.
4. Run the project test suite.
5. Add focused static or VM assertions for the recovered contract when browser automation is unavailable.

Report separately:
- what remained intact in the user commit,
- each real regression or documentation gap repaired,
- exact commands and outcomes,
- uncommitted repair files if any.

## tinylab-feature-modularity-audit


### TinyLab 功能模块化审计

#### 目标
在 TinyLab 中区分产品基础能力、扩展能力、同级附加功能和附加功能之间的可选联动，并核验编译时是否能精确裁剪。

#### 事实采集顺序
1. 先读 `PROJECT_MAP.md` §24，再读涉及域的架构文档：`docs/playground-architecture.md`、`docs/proxy-architecture.md`、`docs/config-registry-state-architecture.md`、`docs/download-architecture.md`。
2. 读取 `internal/app/app.go` 的 `buildComponents`、`Run`、`Shutdown`，记录无条件初始化/启动的组件。
3. 读取 `internal/api/router.go`：先列 `/v1` 代理入口，再列 `/api` 通用鉴权组、独立大 body 路由、静态资源路由和 `serveUI` 的 build/runtime 条件。
4. 读取 `web/embed.go`、`web/embed_playground.go`、`web/embed_playground_stub.go`、`index.html`、`index-nopg.html`，区分资源嵌入、静态白名单、根页面选择和运行时配置门控。
5. 用 `go list ./...` 与 `go list -tags playground ./...` 比较包集合；如相同，说明当前 tag 主要只裁剪资源而没有裁剪 Go 后端。
6. 对每个用户定义功能追踪三条链：前端入口/脚本顺序、API 路由/handler、业务包/外部依赖。
7. 用 `grep` 查跨模块调用点，特别检查是否直接写对方全局状态、是否只通过 path/session/job ID/JSON/SSE 交接。

#### 推荐输出结构
- 结论：现有 build tag 真正控制什么，不能控制什么。
- 模块层级表：基础（Monitor/Settings）、扩展（Playground）、同级附加（FileTransfer/Gallery/Download/Editor/GIF）、共享支撑（Proxy/Config/Registry/Rotation/Usage/TraceCore）。
- 依赖树和启动流程 Mermaid 图。
- 跨模块通信表，明确“已实现/部分实现/未实现”。
- 当前风险表：无条件启动、Router 总耦合点、static-pg 混装、运行时开关不等于能力关闭、脚本白名单漂移、文档与源码漂移。
- 编译 profile/tag 建议：保留 host/strip/debug 正交维度，新增 `feature_gallery`、`feature_download`、`feature_editor`、`feature_gif`、`feature_filetransfer` 等；先拆 registrar 和 FeatureSet，再增加 build tags。
- 迁移顺序：修复真实路由缺口 → 拆静态入口和 capability manifest → 拆 Router registrar → 条件初始化 → 抽取共享 content-core/content-diff → 定义 MediaAsset/MediaBridge → 加 Go tags → 扩展 Windows/macOS 构建脚本 → 做 profile 矩阵验证。

#### 关键已知事实
- `playground` tag 当前只让 `web/embed_playground.go` 额外嵌入 `web/playground/static-pg`，并让 `router.go` 注册 Playground 静态路由；`internal/api/gallery`、`internal/gallery`、`mediaedit`、`download`、`filetransfer`、`textreview` 等当前无 build tag。
- `Config.EnablePlayground` 只影响 `serveUI` 返回 `index.html` 还是 `index-nopg.html`；带 tag 时 Playground 静态资源路由仍存在。
- `index-nopg.html` 仍加载 Download、GIF、FileTransfer；完整 `index.html` 继续加载 Playground、Gallery、Editor、Text Review。
- Download→Gallery 已通过 `web/static/download.js::playVideo` 直接写 `galleryState.videoItems` 实现；目标重构应改为 `MediaAsset`/`MediaBridge`，避免跨模块直接操作对方状态。
- Gallery 内部已支持视频/GIF/WebP 播放和 FFmpeg 输出 GIF，但未发现 Gallery→独立 GIF 页面或 Download→GIF 的直接入口。
- Editor 的 Trace Reader 通过 `/api/traces/dates|index|req/{id}` 展示 Proxy Trace；TraceCore 应留在共享基础层，TraceViewer 属于 Editor。
- Editor 的 AI Text Review 与 Gallery 的 AI 图片 Review 是两个不同模块；前者复用 `editorAlignedDiff`/`content` 解析，后者使用 Vision 模型和 Gallery entry/session。
- FileTransfer 业务层实现 `Handler.Upload`，前端请求 `/api/filetransfer/upload`，但审计时 `internal/api/router.go` 只注册了 `/path-info`，需单独核验后再修复并同步文档。

#### 约束
只读审计不修改文件；代码变更时必须按 `AGENTS.md` 同步 `PROJECT_MAP.md` 和受影响架构文档。

## tinylab-deployed-instance-reconcile


### Reconcile "feature missing" reports against the deployed TinyLab build

#### When to use
A user reports a feature "is gone / now missing / 不见了" in their running TinyLab, but the source repo looks fine. Before concluding "stale build" or editing source, verify what the **deployed** binary actually serves — it may differ from the working tree, and the deployed instance is NOT always the repo you're editing.

#### The deployed instance is separate from the repo
- Source repo (editing): `C:\opencode\tinylab`
- Deployed runtime: `C:\Tools\TinyLab` — contains `tinylab-webview-pg-stripped.exe` + `config.yaml` + `state.yaml` + `imgs/` + `docs/` + `.tinylab.lock`
- The deployed exe is a built artifact; its embedded `web/` assets are what the user actually sees. Source truth ≠ deployed truth until rebuilt+redeployed.

#### Find the running instance and port
```bash
# is it running?
tasklist | grep -i tinylab
# port is in the deployed config.yaml (NOT the repo's)
grep -i port C:/Tools/TinyLab/config.yaml   # e.g. "port: 20102"
```
The deployed instance typically runs as `tinylab-webview-pg-str` (webview-pg-stripped variant). Confirm the listening port via the config `port:` line.

#### Curl the served JS — ground truth for the deployed build
The embedded FS serves playground modules at `/playground/<module>.js` and web/static at `/static/<module>.js`. Curl and grep for the feature's specific markers (IDs, function names, label text):

```bash
PORT=20102
# does the deployed build contain the feature's marker?
curl -s "http://127.0.0.1:$PORT/playground/pg-image-batch.js" | grep -c "pg-img-batch-format"
curl -s "http://127.0.0.1:$PORT/playground/pg-image-batch.js" | grep -n "pg-img-batch-format-wrap\|formatOpts"
# compare against current source
grep -n "pg-img-batch-format-wrap" web/playground/static-pg/playground/pg-image-batch.js
```

This is read-only and non-disruptive — safe to run against the user's live instance.

#### Interpretation
- Deployed JS **has** the marker → the feature IS in the deployed build; the user's report is likely a stale browser cache, a different page/mode, or a runtime rendering failure (then headless-render to confirm). Do NOT edit source "to restore" it.
- Deployed JS **lacks** the marker but source **has** it → deployed exe is a stale build predating the source change. Fix = rebuild + redeploy to `C:\Tools\TinyLab`, not a source edit.
- Both lack it → genuine source gap; proceed with source fix.

#### If you need to confirm rendering (not just bytes)
Fall back to headless Chrome via `puppeteer-core-browser-smoke-fallback` (the omp browser/hub daemon is often unavailable). Drive the feature's entry point and assert the DOM:
- Build a fresh playground exe: `go build -tags playground -o C:/tmp/tinylab-pg-test.exe .`
- Temp config (strict YAML rejects unknown fields — port only): `port: 20991`
- Git Bash path gotcha: `/tmp` maps to `C:\msys64\tmp`, NOT `C:\tmp`. The `write` tool and `go build -o /tmp/...` use `C:/tmp`. Reference `C:/tmp/...` explicitly in bash commands to avoid path mismatch.
- Wait `domcontentloaded` (NOT `networkidle2` — SSE usage/monitor streams prevent idle and cause navigation timeout).
- Playground modal entry: `pgSetMode('image')` → wait `pgState.mode==='image'` → call the feature opener (e.g. `pgOpenImageBatch()`) → wait ~500ms → DOM-assert selectors.

#### Common pitfall
Do not assume the repo working tree == what the user runs. The repo may have uncommitted or post-deploy changes; the deployed exe is frozen at its build time. The curl-served-JS check is the only ground truth for the deployed binary.

## tinylab-archive-compatibility-planning


### TinyLab 归档兼容规划流程

用于在 TinyLab 中规划 ZIP/7z/RAR 支持、Gallery/GIF/Download 交接和按功能编译裁剪；只做实施前设计时使用。

#### 1. 先建立事实基线

读取 `PROJECT_MAP.md` §24，以及：

- `docs/playground-architecture.md`
- `docs/download-architecture.md`
- `docs/config-registry-state-architecture.md`
- `gif_implented.md`
- `internal/app/app.go`
- `internal/api/router.go`
- `web/embed*.go`

盘点当前 ZIP、Gallery、GIF editor、Download、MediaEdit、FileTransfer 的真实链路。明确哪些是现有实现，哪些只是计划。

#### 2. 追踪三条媒体链路

对每个功能记录：

1. 前端入口、脚本加载顺序和页面状态。
2. API 路由、body 上限、鉴权边界和 handler。
3. 后端业务包、外部工具和临时文件生命周期。

特别检查：

- Gallery 当前 ZIP session、entry 读取、ZIP 删除/替换、FFmpeg 输入。
- GIF editor 当前浏览器端帧驻留、GIF/PNG/ZIP 导出，以及是否直接写 `galleryState`。
- Download 完成后是否直接操作 Gallery 状态。

#### 3. 先冻结兼容边界

推荐第一阶段：

- ZIP：读、写、原子回写。
- 7z/RAR：读取；工具具备能力时生成新归档。
- 7z/RAR：暂不原地回写。
- 加密、分卷、嵌套递归、密码交互：明确返回“不支持”，不能静默当作空归档。
- 外部工具：配置路径 → 环境变量 → PATH；不内嵌二进制，不复用 FFmpeg resolver。

#### 4. 设计独立 ArchiveCore

建议规划 `internal/archive/`，至少定义：

- `Format`、`Source`、`SourceRef`、`Entry`、`Manifest`、`Budget`
- `AssetRef`/`MediaAsset`
- Reader：list/read entry
- Writer：ZIP replace、multi-format pack
- strict archive path 校验
- 外部工具 resolver/capability probe/argv runner
- 私有 workspace、asset/session TTL 和启动 scavenger

ArchiveCore 不依赖 Gallery、GIF、Download；Gallery/GIF 只依赖接口。

#### 5. 安全合同必须前置

归档条目路径在任何 `path.Clean` 前拒绝：

- `..`、`.` 逃逸段
- `/`、反斜杠绝对路径、盘符、UNC、`\\?\`、`\\.\`
- NUL、ADS、Windows 保留设备名、尾随点/空格等价碰撞
- 符号链接/硬链接逃逸
- 规范化后重复路径

同时限制：输入压缩大小、条目数、单条展开大小、总展开大小、压缩比、嵌套深度、输出大小、临时磁盘、进程时间和并发数。外部命令必须使用 `exec.CommandContext` 参数数组、process group、deadline 和 stderr tail，禁止 shell 拼接。

#### 6. 不让浏览器提交任意路径

将 `zipAbsPath`、`filePath`、`outputDir` 等绝对路径交接迁移为后端签发的 `sourceId`/`assetId`。token 绑定 owner/auth session、job、创建时间、大小和 mtime/hash。删除、回写、cleanup 只能操作登记过的 source/output；写回使用原子替换和并发冲突检查。

现有 ZIP session 可暂时兼容，但统一目标应加入总字节上限、TTL、pin 预算和私有 workspace。

#### 7. Settings 设计

归档工具放入顶层 `Config.Archive`，不要放到 `DownloadConfig`：

- `sevenZipPath`
- `rarPath`
- `tempDir`

GET `/api/settings` 返回 `archive`。PATCH 使用 presence-aware 指针字段，逐项 nil merge；空字符串表示清除。运行时更新必须传入当前已合并的局部 config，不能重新从 Registry 读取旧值。工具缺失不应阻塞核心代理启动；status endpoint 返回能力和可诊断错误。

#### 8. 用 MediaBridge 解耦前端

规划共享 `MediaBridge`：

- `register(asset)`
- `openGallery(assetId)`
- `consume/release(assetId)`

Gallery、GIF editor、Download 不直接读写彼此全局状态。大 Blob、临时路径和密钥不进入前端持久化数据；只交接短期 asset token 和展示元数据。

#### 9. 以 registrar/asset manifest 为先，再加 build tags

当前 `playground` 主要裁剪 embed 静态资源，不能当作 Gallery/GIF/Download 的总开关。建议最终拆出：

- `feature_archive`
- `feature_archive_external`
- `feature_gallery`
- `feature_gif`
- `feature_download`
- `feature_filetransfer`
- `feature_editor`

但先拆 FeatureSet、API registrar、App component factory 和静态 asset manifest，再加入 tag/stub，避免 Router 和组件装配断裂。验证每个 profile 的 Go 包、embed 资产、路由、导航和运行时初始化。

#### 10. 计划文档必须包含

- 当前实现事实与缺口表。
- 模块层级树和依赖 Mermaid 图。
- 统一 Go/API/前端合同。
- 工具发现和能力探测规则。
- session/temp/asset 生命周期图。
- Gallery/GIF/Download 迁移步骤。
- P0 安全前置 → P1 ZIP adapter → P2 外部工具 → P3 Gallery → P4 MediaBridge → P5 feature tags 的阶段顺序。
- Go 单测、API 集成、浏览器 smoke、Windows/macOS/Linux 构建矩阵。
- `PROJECT_MAP.md`、Playground/Download/Config/Build/GIF 文档同步清单。

实施前必须明确两项产品选择：是否允许 7z/RAR 原地回写，以及本机路径是否只允许 picker/grant + 配置根目录 containment。

