---
name: tinylab-image-batch
description: "TinyLab Playground Image Batch Project (批量项目): plan-transform-create-scheduler-generator flow, API endpoints, persistence, SSE contracts, and ModelScope async gap."
---

# TinyLab Playground Image Batch Project


## tinylab-image-batch-project-architecture


### TinyLab Image Batch Project 架构

Playground Image 模式「批量项目」(Batch Project)：AI 拆解批量创作要求 → 冻结 Prompt×Variant manifest → 后台单并发批量生成。入口：Image 模式单窗口侧栏「Batch Project」按钮（`pgOpenImageBatch`，多窗口 `pgState.splitCount>1` 时禁用）。`pg-lifecycle.js` 离开页面只关 EventSource，不取消任务。

#### 文件地图

| 层 | 文件 |
|---|---|
| 后端引擎 `internal/imagebatch/` | `types.go`（schema+校验+seed 算法）、`paths.go`（slug/槽位路径安全）、`project_store.go`（project.json 原子读写+WriteSlot）、`reconciler.go`（重启恢复）、`manager.go`（runtime/controls/subscribe）、`scheduler.go`（单并发调度）、`remote_generator.go`（GPT/xAI/ModelScope）、`comfy_generator.go`（loopback 8188）、`generator.go`（协议分派） |
| HTTP `internal/api/imagebatch/` | `register.go`（路由+32MiB）、`planning.go`（plan+callHelper+decodeStrictContent）、`projects.go`（transform/create/list/import/asset）、`controls.go`、`events.go`（SSE） |
| 前端 | `web/playground/static-pg/playground/pg-image-batch.js`（三步向导+dashboard） |
| 文档 | 根级 `image_batch_project_flow_review.md`（完整流程审核文稿，含全部提示词与结果契约）；docs/playground-architecture.md；PROJECT_MAP.md §10.13b/c |

#### API 面（`/api/image-batches`，auth-gated + 32 MiB）

- `POST /plan` — helper 生成计划；`POST /transform` — natural 直通前端，tag/json 调 helper
- `POST /`（create）— 冻结 manifest；`GET /`（list）；`POST /import`（json/yaml）
- `GET /{id}` snapshot、`GET /{id}/events` SSE（先发 snapshot 再 typed 事件）、`GET /{id}/manifest`、`GET /{id}/assets/{assetID}`
- `POST /{id}/pause|resume|stop`（stop 模式 `after-current`|`immediate`）、`POST /{id}/retry/{promptID}/{variantID}`（仅 failed/interrupted 可重试）

#### 三步向导与提示词（09ee6dc 起可自定义）

**Step1 规划** `POST /plan`，`PlanInput{helperModel, requirements, defaultNegativePrompt, defaultQuantity, customSystemPrompt?, customUserPrompt?}`（前端 🔍 弹窗可编辑 system+user 后真实生效；改前先 `readDraft()` 锁定草稿）。
- 默认 system：`Return only the requested output. For JSON, return valid JSON without Markdown fences. Preserve the user's subject and intent. Do not include explanations.`
- 默认 user：`Create a JSON image plan for these requirements: {requirements}\nDefault negative prompt: {defaultNegativePrompt}\nDefault quantity: {defaultQuantity}\nReturn {"title":string,"items":[{"id":string,"title":string,"naturalPrompt":string,"negativePrompt":string,"quantity":number}]}`
- 结果 `PlanOutput{title, items:[{id,title,naturalPrompt,negativePrompt,quantity}]}`；id 须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` 且唯一、naturalPrompt 非空、quantity 1–100。

**Step2 转换** `POST /transform`，`TransformInput{helperModel, format(natural|tag|json), items:[Prompt]}`。
- user 提示词固定：`Convert each prompt to format {format}. Preserve naturalPrompt exactly. Input: {items JSON}`
- 结果校验：format 一致、条数一致、**服务端强制回写 naturalPrompt 为输入原文**；json 格式前端校验 finalPromptObject 可 parse，失败标 `_invalid` 禁用启动。

**Step3 启动** `POST /` 冻结 manifest：`promptPlan{helperModel,sourceRequirement,outputFormat,planVersion}` + `imageConfig{model,protocol,endpoint,params}`（**params 冻结窗口全部图片参数；comfyui 时 params.workflow 冻结 workflow JSON、params.port 冻结端口**）+ `batchConfig{intervalMs,maxRetries,retryDelayMs,retryBackoff(fixed|exponential|exponential-jitter),onError(continue|stop),seedMode,baseSeed}`。缺省默认：exponential-jitter / continue / provider-controlled。Manifest 绝不写 API Key/Authorization/Base64。create 按 quantity 补 Variants（`{id}-v{NNNN}`）、算 seed、status=queued、启动调度。

#### 调度契约（scheduler.go）

- 固定单并发；intervalMs 相对**上次 variant 启动时间**（非完成）计时。
- 重试：可重试错误 = 429/500/502/503/timeout/temporarily unavailable/connection reset/eof（ctx 取消不可重试）；总尝试 maxRetries+1；退避 fixed 恒定 / exponential ×2^(n-1) / jitter 加 0..25% 均匀抖动。
- seed：random/provider-controlled 不发送；increment/fixed-base-plus-offset 发送 `baseSeed + (promptIndex-1)*variantsPerPrompt + (variantIndex-1)`。
- 终态（0a0028d 起）：`Failed>0||Interrupted>0`→`completed_with_errors`，否则 `completed`；onError=stop 出错→`failed`；stop immediate→`canceled`。项目级 + variant 级 `lastError` 均持久化。

#### 生成器

- Remote：`POST /v1/images/generations`（endpoint 含 edits → `/v1/images/edits`），body=model+prompt+negative_prompt+seed+params 展开+n=1 兜底；头 `X-TinyLab-Source: playground-batch`；结果 `data[]` 取 b64_json 或 SSRF 安全代拉 url；ModelScope 无 data 时轮询 `GET /v1/tasks/{id}`（300×200ms≈60s）；资产校验 image/*、≤32MiB、DecodeConfig 可解码。
- ComfyUI：只走 `127.0.0.1:{port}` 的 /prompt、/history、/view；注入冻结 workflow。
- 落盘：`{ImageSaveDir}/{slug}/p{NNNN}/v{NNNN}.{ext}`，`.part` 临时文件+fsync+rename，槽位已存在拒绝覆盖；只取 Assets[0]。

#### 持久化/恢复

- `project.json` 每次状态变更同步原子写（同目录 `.project-*.tmp` + rename，**无去抖**）。
- Reconcile：仅按合法图片恢复 succeeded，缺失→interrupted；`ScanUnmanaged` 只报告无 manifest 目录，绝不猜任务。

#### SSE 事件（前端 250ms 去抖重拉、100 条环形缓冲）

`project-status` / `planning-started` / `planning-completed` / `transform-completed`（后三者仅声明，plan/transform 是同步 API 调用从不 emit）/ `variant-started` / `variant-retry-wait` / `variant-completed` / `variant-failed` / `variant-interrupted` / `project-reconciled` / `project-completed` / `project-error`。

#### 调试要点

- helper 错误详情已透传（512 字符截断）；decode 与 Validate 错误分开返回；错误留在当前步骤不伪成功。
- 回归测试锚点：`internal/imagebatch/scheduler_test.go::TestSchedulerPersistsFailureDetailsAndTerminalStatus`（completed_with_errors + lastError 持久化契约）。

## tinylab-image-batch-redesign-plan-review


### TinyLab Image Batch redesign-plan audit

Use this procedure before approving a proposed UI/layout redesign for the Playground Image Batch Project.

#### 1. Establish the current contracts

Read the existing batch architecture guidance and inspect:

- `web/playground/static-pg/playground/pg-image-batch.js`
- `web/playground/static-pg/playground/pg-ui.js`
- `web/playground/static-pg/playground/pg-render.js`
- `web/playground/static-pg/playground/pg-lifecycle.js`
- `web/playground/static-pg/playground/pg-state.js`
- `web/playground/static-pg/playground/pg-request.js`
- `docs/playground-architecture.md`
- `PROJECT_MAP.md`

Record actual exported functions, DOM containers, mode/split behavior, and current Batch state fields before comparing the plan.

#### 2. Check the plan's integration points

Reject or return for revision if the plan:

- Calls an interface/export that does not exist, such as an unspecified `renderSidebarHtml`.
- Treats `pgRenderPanes()` as a generic arbitrary-HTML renderer even though it currently renders ordinary windows/messages.
- Injects Batch behavior directly into the ordinary Image renderer without an explicit top-level dispatch boundary.
- Uses `pgSetSplitCount()` without accounting for `pgIsGenerating()`, `modeWindows`, `windows`, active-window changes, or shortcut handlers.
- Does not define how ordinary Image/Normal/Search behavior remains unchanged.

Require explicit contracts for:

```js
uiMode, stage, projectId, snapshot, draft, plan, transform, traces, viewer
```

and explicit render entry points such as:

```js
pgImageBatchRenderPane(i)
pgImageBatchRenderSidebar()
pgImageBatchRenderCanvas()
pgImageBatchExitUI()
```

#### 3. Audit request transparency claims

If the plan displays request/response headers or bodies, verify that the current request helper actually exposes them. `pgApiPost()` commonly returns parsed JSON only. Require a Batch-specific trace abstraction for each request:

- `/api/image-batches/plan`
- `/api/image-batches/transform`
- `/api/image-batches`

Each trace should define method, URL, request headers/body, response status/headers/body, duration, loading, and error. Require redaction of Authorization, cookies, API keys, credentials, base64/data URLs, bounded body size, and memory-only storage.

Do not call a synchronous JSON request body “streaming” unless the backend protocol is also changed to SSE or chunked streaming.

#### 4. Audit stage and lifecycle semantics

Require behavior for:

- Step 1–3 cancel before a backend project exists.
- Stage 4 close/leave page while the backend task continues.
- Stop immediate vs after-current.
- Mode switch, reload, re-entry, and process restart.
- Stage 1–3 draft persistence and Stage 4 snapshot-first/SSE recovery.
- Preservation of `projectId`; UI visibility must not be confused with backend task lifetime.

Do not use a single `active=false` flag as the lifecycle model.

#### 5. Audit data isolation

Batch viewer state should remain separate from ordinary Image `generations`. Reusing DOM panes is acceptable, but do not inject Batch assets into `pgState.windows[i].image.generations` unless that contract is intentionally redesigned and tested.

Define the actual DOM mapping for main canvas, sidebars, request logs, and Batch viewer. Account for `#pg-req-left`, `#pg-main-inner`, `#pg-panes`, `#pg-side`, and `#pg-inputbar`.

#### 6. Audit validation and provider behavior

Require behavior assertions rather than fixed LLM output examples:

- natural skips transform;
- tag uses the approved Booru convention;
- json has `finalPromptObject.subject` and a usable natural-language `finalPrompt`;
- `naturalPrompt` remains unchanged;
- invalid format output blocks Start;
- ModelScope task IDs may be top-level or nested;
- polling handles pending, success, failure, timeout, transient errors, image retrieval, and image validation;
- a Variant cannot complete or advance until a real image asset exists;
- `onError` and terminal-state semantics remain intact.

#### 7. Return an implementation gate

Approve only after the plan includes:

1. State contract.
2. Pane/sidebar/canvas dispatch boundaries.
3. Request-trace API and redaction policy.
4. Lifecycle/recovery matrix.
5. Data-isolation rules.
6. Non-hardcoded UI and LLM verification matrix.
7. Phased implementation order that preserves ordinary Image behavior.

Otherwise return the plan for revision rather than implementing it.

## tinylab-imagebatch-modelscope-async-gap


### TinyLab Image Batch — ModelScope async gap

#### When to use
Fixing the Playground 批量项目 (Image Batch) generation path for async providers (ModelScope/DashScope), reviewing `internal/imagebatch/remote_generator.go`, or answering "why do all batch variants fail with no images".

#### Facts (verified 2026-08-11, commits 06101fa→0a0028d)
The batch flow's `RemoteGenerator.Generate` (internal/imagebatch/remote_generator.go) was written for sync OpenAI-format providers only; the async contract used by the WORKING manual canvas flow (`web/playground/static-pg/playground/pg-image-model.js`) was never wired in:

1. Submit POST /v1/images/generations lacks `X-Modelscope-Async-Mode: true` (manual canvas sets it when protocol == 'modelscope').
2. `remoteResponse` only parses `data/task_id/id/output/status`. ModelScope returns `{"output":{"task_status":"SUCCEEDED","results":[{"url":...}]}}` or async submit `{"output":{"task_id":"..."}}` → `data` empty, no top-level task_id → error "image response contains no assets" → every variant fails (not retryable; maxRetries useless). With onError=continue the scheduler marches through all variants → 0 images.
3. `pollTask` calls `caller.ImageTask(...)` via `ImageTaskCaller`, but `proxy.Handler` (internal/proxy/handler.go) never implements it (interface comment says "normal proxy does not need to implement it") → "image provider returned an asynchronous task".
4. `pollTask` builds GET /v1/tasks/{id} WITHOUT `?model=` query and WITHOUT `X-ModelScope-Task-Type: image_generation` header; cadence 300×200ms vs verified manual flow 60 polls × 2s interval, 10s per-attempt cap (MODELSCOPE_* constants in pg-image-model.js).
5. Batch forces `body["n"]=1` default; manual flow does not — ModelScope may 400 on it.

#### Fix plan (approved-review state; full detail in repo root `image_batch_project_flow_review.md` §15.2)
- A: implement `ImageTask(w,r)` on proxy.Handler — parse taskID from `/v1/tasks/{id}?model=` path, model from query, delegate to existing `TaskGet` (provider/key/upstream reuse).
- B: set async header for modelscope protocol (or model prefix); skip forced n:1 for it.
- C: tolerant response parsing: taskID from `task_id/output.task_id/result.task_id/request_id/data[0].task_id`; images from `output_images/data/results/output.output_images/output.results/output.images/image_url/output.image_url` (string or {url|image_url|oss_url} or {b64_json|base64}); also `revised_prompt`.
- D: rewrite pollTask: `?model={req.Model}` + X-ModelScope-Task-Type header; status from `task_status/status/output.*/data[0].task_status`, decision SUCCEED|SUCCESS|COMPLETE|DONE=done, FAIL|ERROR|CANCEL=failed; 10s per attempt, 2s interval, 60 max; return assets only after real image.
- E: adapter tests in internal/imagebatch/adapters_test.go (fakeImageProxy pattern; testPNG helper exists).

#### Related
- Manual canvas ModelScope contract: skill `tinylab-modelscope-image-async-flow` (working flow to mirror).
- Protocol values reach req.Protocol via `pgEffectiveProtocol` → model's `imgProtocol` ('gpt'/'xai'/'modelscope'/'comfyui'); model ids are `{providerPrefix}/{model}` (SplitModel-compatible for TaskGet).

