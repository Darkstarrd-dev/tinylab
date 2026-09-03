---
name: tinylab-playground-image
description: "TinyLab Playground Image mode: three-protocol (gpt/xai/modelscope) architecture, prompt-driven image canvas, ComfyUI protocol integration, CDN dependency audit, and ModelScope async flow."
---

# TinyLab Playground Image Mode


## tinylab-playground-image-mode-architecture


### TinyLab Playground Image Mode Architecture

#### Three-Protocol Design (gpt / xai / modelscope)

Image models in `pgState.models` carry `kind: 'image'` and `imgProtocol` ('gpt' | 'xai' | 'modelscope'). The protocol determines which parameter panel renders and which fields `pgBuildImageBody` sends.

##### Protocol determination
- `pgGetImgProtocol(modelId)` (pg-ui.js:659): looks up `pgGetModelInfo(modelId)`, returns `info.imgProtocol` or `'gpt'` fallback. Used by `pgBuildImageBody` and `pgSendImage` — requires a model to be selected.
- `pgRenderImageParams(cfg)` (pg-ui.js:738): calls `pgGetImgProtocol` internally to branch rendering.

##### Parameter panels per protocol
- **gpt**: `imgSize` (selectWithEdit), `imgQuality` (standard/high), `imgBackground` (opaque/transparent), `imgModeration` (auto/low)
- **xai**: `imgAspectRatio`, `imgResolution` (1k/2k/4k/8k), `imgN` (1-10)
- **modelscope**: `imgSize` (selectWithEdit), `imgNegativePrompt`, `imgSteps`, `imgGuidance`, `imgSeed`

#### Image Input Flow (shared across protocols)

##### Paste → base64 data URL
`pgPasteImage` (pg-ui.js:236-269): `FileReader.readAsDataURL(blob)` → `data:image/png;base64,...` → pushed to `w.config.imageUrls[]`. No file hosting intermediary (no imgur/catbox/etc.).

##### image_url field construction
`pgBuildImageBody` (pg-request.js:113-155): The `image_url` field is added **outside** all protocol branches (L148-152), so it's sent to ALL protocols regardless. Single image → string; multiple → array.

```js
// This runs AFTER protocol-specific branches — applies to all
if (cfg.imageEnabled && cfg.imageUrls) {
    body.image_url = imgUrls.length === 1 ? imgUrls[0] : imgUrls;
}
```

##### pgRenderImageBlock shared between modes
`pgRenderImageBlock(customMode)` (pg-ui.js:800-828) is used in BOTH:
- **Text mode** (L642): images become `image_url` content parts for multimodal chat
- **Image mode** (L626): images become `body.image_url` for image-to-image generation

The same function renders both contexts — changes affect both modes unless gated by `pgState.mode`.

#### Endpoint Routing

`pgSendImage` (pg-stream.js:271-363): fetches `/v1/images/generations` (hardcoded at L307). The backend proxy (`handleProxy`) transparently forwards any `/v1/*` path, so `/v1/images/edits` would also pass through without backend changes.

#### Config Persistence Pattern

##### Adding new config fields
1. Add to `PG_DEFAULT_CFG` in `pg-core.js:19-56`
2. `pgLoad` (pg-state.js:170-183) auto-restores by iterating `Object.keys(PG_DEFAULT_CFG)` — no changes needed in `pgLoad`
3. `pgOnParam(name, v)` (pg-ui.js:1212) is generic: writes `w.config[name] = v` + `pgSave()`. Works for any new field.
4. `pgReset` (pg-ui.js:410) resets to `PG_DEFAULT_CFG` deep clone — new fields auto-included.

##### Key config fields (image mode)
`imgSize`, `imgQuality`, `imgBackground`, `imgModeration`, `imgAspectRatio`, `imgResolution`, `imgN`, `imgNegativePrompt`, `imgSteps`, `imgGuidance`, `imgSeed`

##### parameterEnabled toggle system
`PG_DEFAULT_PARAMS` (pg-core.js:59) controls which param rows show enable toggles in text mode. Image mode params don't use this system — they're always shown when the protocol panel renders.

#### Size List System

##### pgImgBuiltinSizesFor(proto) (pg-modal.js:465)
Returns hardcoded default sizes per protocol. Used by the edit-sizes modal to prefill.

##### pgImgSizeOptionsFor(proto, modelId, builtin) (pg-ui.js:686)
Resolves size options: model's custom `imgSizes` list → builtin defaults. Never includes ''/Default or '__custom' sentinel (those appended by `pgImgParamSelectWithEdit`).

##### pgImgParamSelectWithEdit (pg-ui.js:706)
Renders size `<select>` with: Default entry + sizeOpts + Custom... sentinel. Label is a clickable button opening the per-model resolutions editor modal.

#### Backend (no changes needed for image mode frontend work)

- `ModelDef` (config/types.go:42): has `Kind`, `ImgProtocol`, `ImgSizes` fields
- `/v1/models` API (models/register.go:30-87): returns `kind`/`imgProtocol`/`imgSizes`
- `handleProxy`: transparent forward, no images API field validation
- Image save: `POST /api/save-image` (image/register.go) saves generated results to `imgs/`
- Image proxy: `GET /api/image-proxy` (image/register.go) same-origin proxy for display/CORS

## tinylab-playground-image-canvas-design


### Playground Image Canvas 交互设计

用于将 TinyLab Playground 的 Image 模式从聊天气泡改为 Prompt 驱动的图片画框工作台；当前只做方案或在实施前建立状态/数据契约时使用。

#### 产品模型

Image 模式主数据不应继续依赖 `messages[]` 气泡，而应使用每个窗口独立的 `w.image`：

- `phase`: `empty | generating | ready | error | canceled`
- `submittedPrompt`: 生成期间保留在输入框中的不可变 Prompt
- `requestId`
- `activeAssetIndex`
- `generations[]`: 生成记录历史

每条 generation 保存 Prompt、revised prompt、时间/耗时、model、protocol、endpoint、参数快照和 `assets[]`。每个 asset 保存稳定 `id`、URL、savedPath/savedFilename、mime、尺寸、字节数及协议来源信息。ComfyUI 还应保留 workflow、nodeId、filename、subfolder、type；不得只保留下载后的 data URL。

#### 交互状态

- 空闲：输入框可编辑，按钮为 Generate。
- 生成中：输入框显示 `submittedPrompt`，设为 readOnly 但可复制；按钮变为 Stop；不显示 Prompt 或 Waiting 气泡；画框显示 CSS 扫描/呼吸/旋转动画，右下角显示真实 elapsed time。
- 成功：直接在画框中以 `contain` 显示图片；清空输入框；底部显示分辨率、大小、格式、路径和操作按钮。
- Stop/Error：保留 Prompt；若已有图片继续显示旧图，否则显示停止/错误画框状态。
- 再次生成：旧图不覆盖，新增 generation；生成期间可暗化旧图作为背景，左右导航禁用；成功后切到最新结果。
- 左右导航切换扁平化后的所有 asset，显示 `current / total`；当前 asset 的 generation 决定底部 Prompt/参数内容。
- Regenerate 必须读取当前 generation 快照并走 Image 协议接口，不能复用通用聊天 `pgSend`；应追加新 generation，不删除旧结果。
- Delete 只删除 Playground 历史，不删除磁盘文件；异步保存回调必须按稳定 asset ID 更新，不能通过当前活动窗口和 URL 反查。

#### 关键源码事实

- Image 发送入口：`web/playground/static-pg/pg-ui.js` 的 `pgUserSend`，当前 push user + assistant loading message 并清空图片输入。
- GPT/xAI/ModelScope 结果归一化：`pg-stream.js::pgSendImage`；ModelScope 异步轮询在同文件 `pgPollModelScopeTask`。
- ComfyUI 请求链：`pg-comfyui.js::pgSendComfyImage`，`/prompt -> /history -> /view`；需在结果记录中补保存 workflow 和输出来源。
- 当前等待气泡：`pg-render.js::pgMsgInnerHTML` loading 分支；Image 模式应绕过该分支并渲染 canvas。
- 当前自动保存：`pg-stream.js::pgAutoSaveImageArtifact`，需要改成 asset-id 定位。
- 当前通用 regenerate：`pg-ui.js::pgRegenerate` 误走 `pgSend`，Image 模式必须专门分派。
- 当前图片预览：`pg-modal.js::pgShowImageModal`，可复用缩放/复制/保存基础设施，但主图应移入画框，Prompt/参数使用独立 overlay。
- Image 模式窗口隔离：`pg-ui.js::pgSetMode` 的 `modeWindows.image`；每个窗口必须持有自己的历史和 active index。
- 持久化风险：`pg-state.js::pgSave` 主要保存 window 0，原始 data URL 会造成 localStorage 膨胀；第一版建议 image history 仅会话内保存，若需要刷新恢复，应先建立 assetId/同源图片资产接口。

#### 推荐实施顺序

1. 增加 per-window image state 和 generation/asset schema。
2. 统一 GPT/xAI/ModelScope/ComfyUI 输出归一化并保存参数快照。
3. 修复 Image regenerate、stop/error、自动保存 asset ID 生命周期。
4. 在 `pg-render.js` 增加画框 renderer，`playground.css` 增加响应式 canvas、footer、导航和 reduced-motion 动画。
5. 在 `pg-modal.js` 增加 Prompt & Parameters overlay，并把 Copy/Save/Regenerate/Delete 放入画框底部。
6. 更新 `pg-i18n.js`、`PROJECT_MAP.md`、`docs/playground-architecture.md`。

#### 验收重点

验证无 Prompt/Waiting 气泡；生成中 Prompt 保留且只读；成功后画框直接显示图片并清空输入；多次生成可左右切换且旧结果不丢失；多图响应可导航；底部元数据和参数随 asset 切换；Regenerate 不走聊天端点；Delete 不删磁盘文件；延迟 autosave 不会修改已删除或其他窗口的 asset；ComfyUI metadata/workflow 不丢失；多窗口历史不串台；`prefers-reduced-motion` 下仍有状态文本和计时。

## tinylab-playground-comfyui-protocol


### TinyLab Playground ComfyUI 协议接入

用于在 TinyLab Playground Image 模式中维护 ComfyUI 协议集成。

#### 架构约束

- ComfyUI HTTP API 默认监听 `127.0.0.1:{port}`；浏览器不要直接依赖 ComfyUI CORS。
- 在 `internal/api/comfyui/register.go` 提供同源 `POST /api/comfyui/proxy`：目标 host 固定 `127.0.0.1`，仅允许 GET/POST，校验 port/path/query，重定向必须保持原 loopback 端口。
- ComfyUI 工作流请求可能超过通用 `/api` 1 MiB body limit；把 `/api/comfyui` 独立挂载并使用 32 MiB body limit，同时沿用 `AuthMiddleware`。
- `internal/api/router.go` 的 Playground `pgJSFiles` 是显式白名单；新增 `pg-comfyui.js` 必须加入该列表，并在 `web/static/index.html` 按依赖顺序加载。
- TinyLab CSP 若允许动态 ComfyUI 端口的 WebSocket，需显式处理；当前实现避免浏览器直连 ComfyUI WebSocket，使用同源 `/history/{prompt_id}` 轮询，规避 ComfyUI Origin 校验差异。

#### 前端实现

- `pg-core.js`：在 `PG_DEFAULT_CFG` 增加 `imgComfyPort`、`imgComfyConnected`、`imgComfyTemplateId`、`imgComfyWorkflow`、`imgComfyPasteJson`。
- `pg-state.js`：增加运行时 `pgState.comfy`，保存连接状态、版本、模型目录、sampler/scheduler 选项、历史模板。
- `pg-ui.js`：`pgImageProtocols()` 加 `comfyui`；协议选择时用 `__comfyui__` 作为占位 model；ComfyUI 协议渲染专用连接/模板/参数面板；发送分派至 `pgSendComfyImage`。
- 新建 `pg-comfyui.js`：
  - 通过 `/api/comfyui/proxy` 获取 `/system_stats`、`/models/*`、`/object_info/KSampler`、`/history`；
  - 从成功历史 prompt 提取 API workflow；无历史时支持粘贴 API-format JSON；
  - 识别 `UNETLoader`、`DiffusionModelLoader`、`CLIPLoader`、`VAELoader`、`CheckpointLoaderSimple`、`KSampler`/`KSamplerAdvanced`、`EmptyLatentImage`、`CLIPTextEncode`、`SaveImage`，生成 select/number/text 控件；未知节点保留原值；
  - 发送前深拷贝 workflow，把输入栏文本写入非 negative 的 `CLIPTextEncode`；
  - `POST /prompt` 后轮询 `/history/{prompt_id}`，完成后读取 `/view`，转 base64 data URL；
  - 复用 Playground 图片消息渲染及 `pgAutoSaveImageArtifact`（`/api/save-image` 支持 data URL）。
- `pg-i18n.js`：同步 `en` 和 `cn` ComfyUI keys。
- `playground.css`：维护 `.pg-comfy-*` 动态面板样式。

#### 验证流程

1. `node --check` 所有修改的 Playground JS。
2. `gofmt -w` 新增/修改 Go 文件。
3. `go test ./internal/api/...`，重点验证 proxy 的 invalid JSON/port/method/path/query 与 JSON/二进制响应透传。
4. `go build -tags playground -o <exe> .`。
5. 用临时目录和仅含 `port: <test-port>` 的严格 YAML 配置启动测试二进制；不要触碰用户配置。
6. 浏览器打开 Playground，切换 Image → ComfyUI，输入 8188，点击连接，确认 ComfyUI 版本、模型和模板列表出现。
7. 无历史时选择粘贴 API JSON；确认动态节点控件出现。
8. 输入 prompt 并生成，确认消息区有图片、无 `[Error]`、生成按钮恢复 Generate，且 TinyLab 图片目录出现 PNG。
9. 停止测试服务并删除临时 exe/config/目录。
10. 同步 `PROJECT_MAP.md` 的 `internal/api/comfyui`、Playground 文件清单和 Image 任务索引；同步 `docs/playground-architecture.md` 的最后核对行、API 表、模式说明、源码锚点、维护清单。

## tinylab-playground-cdn-dependency-audit


### TinyLab Playground CDN Dependency Audit

Use this when deciding whether `web/playground/static-pg/vendor` dependencies should move from embedded local assets to CDN URLs.

#### Inspect first

1. Read `PROJECT_MAP.md` §24 and `docs/playground-architecture.md`.
2. Check `web/static/index.html` for vendor load order and CSS/font references.
3. Check `internal/api/router.go` for `/vendor/*` cache headers and the explicit `pgJSFiles` allowlist.
4. Check `web/embed_playground.go` to confirm assets are compiled into the binary.
5. Search the frontend for globals and dependencies: `marked`, `markedKatex`, `katex`, `DOMPurify`, `hljs`, `mermaid`, and `Diff`.
6. Record dependency versions, source comments, hashes, and total size. Mermaid commonly dominates the bundle; do not judge by file count alone.

#### Decision rules

- CDN-only plus browser cache is not a reliability baseline: it fails on first launch, offline use, cleared caches, restricted networks, and DNS/proxy failures.
- Keep local embedded assets as the fallback for a localhost desktop application unless the product explicitly accepts an online dependency.
- If CDN is considered, require complete version pinning, SRI, `crossorigin="anonymous"`, preserved synchronous load order, and a tested local fallback. Never use `latest`.
- Treat CSS, KaTeX fonts, and UMD extensions as part of the dependency graph; a JS-only CDN migration is incomplete.
- Do not weaken security merely to enable CDN loading. Avoid broad CSP exceptions and account for third-party privacy/supply-chain exposure.
- For caching local assets, prefer content-hashed or release-versioned URLs with long-lived immutable caching. Keep the HTML entrypoint short-lived or `no-store` so asset URLs change on release. Do not long-cache fixed filenames across binary upgrades.
- The preferred optimization is local lazy loading of large optional dependencies, especially Mermaid, while retaining the embedded copy and showing a graceful code-block fallback if loading fails.

#### Recommended conclusion format

State the verdict first:

- **CDN-only:** not sufficiently robust.
- **Local embedded:** robust and reproducible, though larger.
- **Hybrid:** robust if local fallback remains authoritative.

Then cite concrete repository evidence, the dependency/load-order risks, cache invalidation strategy, and the smallest safer optimization.

## tinylab-modelscope-image-async-flow


### TinyLab Playground Image-mode ModelScope Async Flow

Diagnose/fix ModelScope image generation in TinyLab Playground — especially the "request returns a quick 2xx success then no image / no polling" regression class.

#### Where image-mode sends actually live (post-06101fa)

- The canvas flow `pgImageGenerate` in `web/playground/static-pg/playground/pg-image-model.js` is THE image-mode send path (wired from `pg-ui.js` send handler; also used by `pgImageRegenerate` with a generation snapshot).
- `pgSendImage` / `pgPollModelScopeTask` in `pg-stream.js` are **dead code** since commit `06101fa` (canvas+batch refactor) — zero call sites. Do not "fix" them; do not expect them to run.
- Normalize/asset extraction: `pgImageNormalizeResult(payload, protocol)` (pg-image-model.js) — handles `data[]`, `images[]`, `output_images[]` (strings OK), `output.images[]`, `image_url`, plus `url`/`b64_json`/`base64` per item.

#### ModelScope async contract (frontend side, verified 2026-08-10)

1. Submit: `POST /v1/images/generations` (or `/v1/images/edits`) MUST carry header `X-Modelscope-Async-Mode: true` or the upstream blocks/behaves differently. Without it the flow is broken even if polling exists.
2. Submit response (quick 2xx): `{task_id, task_status:"PENDING"}` (top-level task_id; request_id is a fallback but NOT the task id — commit 6b27ab4).
3. Poll: `GET /v1/tasks/{taskId}?model=<providerPrefix/model>` with headers `X-ModelScope-Task-Type: image_generation` + `X-TinyLab-Source: playground`. Interval 2s, ~60 attempts, transient-error retry 3s, abort-signal aware (AbortError → canceled path).
4. Poll success: `task_status` in `SUCCEED`/`SUCCESS`/`COMPLETED`; images from `output_images[]` (array of URL strings) or `data[].url|b64_json` or `output.images[].url` or `image_url`. `FAILED`/`ERROR` → fail immediately (do not retry — mark the error `terminal` so the catch doesn't swallow it).
5. Feed the polled payload straight into `pgImageNormalizeResult` — it already understands all the success shapes.

#### Backend (intact — do not suspect first)

- `internal/api/router.go`: `GET /v1/tasks/{taskId}` → `proxyHandler.TaskGet` (parses `?model=`, SplitModel → SelectKey → `forwardGetUpstream`).
- `internal/proxy/upstream.go`: `X-Modelscope-Async-Mode` forwarded in `forwardUpstream` (L73-75); `X-Modelscope-Task-Type` in both `forwardUpstream` (L76-78) and `forwardGetUpstream` (L156-158).
- `ImagesGenerations`/`ImagesEdits` → `handleProxy` → non-stream → `passThroughResponse` (body relayed untouched).

#### Verification notes

- `node --check` each touched pg-*.js.
- A mock upstream (submit → task_id PENDING; poll returns PENDING twice then SUCCEEDED + output_images + a real PNG URL) reproduces/verifies the whole loop without a real ModelScope key. Backend `allowPrivateNetwork: true` needed for loopback provider baseUrl.
- Playground assets only embed with `-tags playground` build tag.
- ModelScope protocol is chosen via model `imgProtocol: modelscope` (kind: image) in config; `pgEffectiveProtocol`/`pgGetImgProtocol` fall back to 'gpt' when unset.
- i18n: poll timeout/failure messages use `pgModelscopeTimeout` / `pgModelscopeTaskFailed` (en + cn in pg-i18n.js); missing keys return the key string, so add both before relying on them.

