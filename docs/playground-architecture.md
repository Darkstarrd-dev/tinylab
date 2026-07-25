# TinyRouter Playground 架构

> **文档定位：** Playground 前后端实现的 canonical 架构事实基线。后续设计、排障和代码评审应先读取本文，再按“源码锚点”核对本次变更涉及的局部代码。
>
> **最后核对：** 2026-07-25，仓库工作区（`main`）。本次新增/核对：(1) Editor 页面——双栏文本编辑器，支持原生文件打开/保存、原始/预览视图切换、`window.Diff` 行级 diff 对比、查找替换、行号、Tab 缩进自动缩进，Gallery 导航按钮切换画廊/编辑器的 toggle 逻辑；(2) 修复 Editor Open 闪退：`internal/fsutil/open_windows.go` 修正 `IFileDialog::GetResult` 的 vtable 索引 26→20（确认选择时返回路径而非访问违例闪退），`internal/api/editor.go` 缩短文件选择器 filter，修复 `editor.js` 初始化时 findbar 的 `document.getElementById` NPE（改为 `container.querySelector`）。涉及文件同原条目。

> **2026-07-22 更新（Search 模式 UI/UX 优化）：**
> - **双窗口左右并列布局与交互：** `pgState.mode === 'search'` 时强制使用 2 窗口布局（`splitCount = 2`，`1fr 1fr`），左侧窗口显示 Search Strategy 与 Raw Search Results 视图，右侧窗口专门渲染 Synthesized 最终回复；问句留在 `#pg-input` 并呈灰色锁定态（`pg-input-search-locked`）；打字时恢复亮色编辑。
> - **Raw 内容流式增量滚动与复制/保存：** `pgSearchFlushRender` 引入 Raw 增量比对，防止右侧回答推水时反复重绘左侧 DOM，使 Raw 接收时自动滚底、接收完毕后用户可完全自由拖动左侧滚动条查阅；修正左侧复制按钮直接复制 `msg.searchRaw`；左右窗口底部均增加 Save 按钮 (`PG_ICON_SAVE`) 支持另存为 Markdown。
> - **侧边栏面板与控件裁剪：** 将侧边栏 "Search Settings" 更名为 "Apikey Settings"，Search 模式下自动剪裁隐藏右边栏 Debug 面板，以及 Window Setup 下方的窗口数量与 Reset 按钮。
> - **全屏快捷键输入隔离与跨页持久化：** (1) `app.js` 与 `gallery-fullscreen.js` 增加 `isInput` 输入状态检测，在任意输入框/文本域打字输入字母 `f` 时自动屏蔽全屏切换热键，防止打字错乱；(2) 修正 HTML5 全屏作用目标为根节点 `document.documentElement`，重构 `navigateTo` 与 `cleanupGallery` 使全屏跨页无缝保持，并统一在 `app.js` 中调用 `toggleFullscreen()` 全管家逻辑（包含 HTML5 全屏、CSS 全屏与 Native WebView2 桌面窗口全屏分支），彻底修复全屏下切换页面后按 `f` 无法退出全屏的 bug；(3) 移除 `gallery-fullscreen.js` 中对 `F1~F6` 键的强行截断，并在 `onFullscreenKey` 中放行 `global.goto-*` 全局页面导航热键，确保全屏模式下敲击 `F1~F6` 可无缝且全屏保持地快速切换页面。
> - **AI 驱动的 Raw Markdown 结构修复：** 取消前端正则暴力清洗 Raw 结果的方案；左侧默认呈现 Raw 视角，Pretty 按钮在右侧生成回答期间保持灰色置灰禁用（`msg.status !== 'complete'`），右侧回答生成完毕后解锁恢复点击。点击 Pretty 后触发 `pgRepairSearchMarkdownAI`，向大模型发起专用 System Prompt 结构修复请求（`PG_SEARCH_REPAIR_MARKDOWN_PROMPT`：严禁归纳/总结/删减/前言，只修补粘连的代码块、标题、表格与列表），修补后的 Markdown 缓存于 `msg.prettyMarkdown` 中，并送入标准 Marked 解析器渲染。
> - **确认关机/全局弹窗键盘焦点与交互增强：** `confirmModal`（含 Esc 触发的 Shut Down 确认弹窗）打开后同步加上 `show` class 并自动聚焦 Confirm（确定）按钮，添加高亮 focus 边框发光；更新 `topOpenModal` 识别正在挂载与激活的弹窗，修复单次按 `Esc` 键直接关闭弹窗；支持按 `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` 方向键在 Confirm（确定）与 Cancel（取消）之间切换焦点；按 `Enter` 键触发当前聚焦按钮的确定/取消操作；弹窗出现时强制屏蔽 `Tab` 键向背景页面泄露焦点。

> **2026-07-14 更新：** Playground 请求详情弹窗改为复用 Usage 页面的 `info-modal-overlay` + `renderInfoSection` 基础设施，具备 pretty/raw 切换和 copy 按钮；服务端 `recorder.go`、`forward.go`、`stream.go` 不再依赖 debug mode 门控，始终捕获请求/响应 payload 与 headers，使弹窗在 debug mode 关闭时也能显示完整信息。`app.js` 的 `topOpenModal()`/`dismissTopModal()` 扩展支持 `pg-modal-overlay`，修复 Playground 弹窗 ESC 穿透触发关闭应用的问题。图片发送改为在 `pgUserSend` 阶段将用户消息构建为多模态 content parts 并清空 `imageUrls`/`imageEnabled`，使发送后输入区缩略图消失、图片随用户气泡渲染。Reasoning 气泡改为 markdown 渲染、移除滚动条约束、随内容自然增长，reasoning 结束后自动折叠。Recent Requests 面板新增 SSE 订阅（`/api/usage/events`），请求发送即实时出现、完成后实时更新，轮询降为 10 秒后备。新增 Custom Endpoint 面板（普通模式），启用后直接 fetch 自定义 URL + Key，绕过 TinyRouter 代理栈。Image Preview 弹窗新增 Copy/Save/Reset 按钮、鼠标滚轮缩放（以图片中心为轴心，最小不低于 auto-fit）、鼠标拖拽平移、图片 auto-fit 容器；聊天气泡图片缩略图可点击打开预览；新增 `POST /api/save-image` 后端端点保存图片到 `imgs/` 目录。

> **2026-07-14 更新（Image 模式）：** Playground 新增第三种模式 Image（图片生成），模式系统从布尔 `autoChat.enabled` 改为三态 `pgState.mode`（'normal'|'autochat'|'image'）。新增 `POST /v1/images/generations` 代理端点（透明转发，复用 `handleProxy`）和 `POST /v1/tasks/{taskId}` 端点（ModelScope 异步轮询）。模型选择器支持 `kindFilter` 按文本/图片过滤。`ModelDef` 新增 `Kind` 和 `ImgProtocol` 字段。图片参数面板按协议（GPT/xAI/ModelScope）分支渲染。`pgSendImage` 处理非流式 images API 响应；`pgPollModelScopeTask` 处理 ModelScope 异步任务轮询。

> **2026-07-14 更新（Image 预览与复制）：** Image Preview 弹窗（`pg-modal.js` 的 `pgShowImageModal`/`pgInitImageZoom`）修正 auto-fit：移除 `<img>` 上相互冲突的 `max-width/max-height/object-fit` 约束，改由 `transform: scale(fitScale)` 单独负责缩放——大图缩到正好填满、小图（如 256px）按原 `c58c08a` 意图放大铺满窗口。新增底部 footer 显示分辨率（`naturalWidth × naturalHeight`）、大小（`pgFormatBytes`，经同源 `/api/image-proxy` 取 Blob 的 `size`）、格式（Blob `type` 或 data: 的 mime）。复制按钮改为经同源 `/api/image-proxy` 拉取图片字节后用 `ClipboardItem` 写入剪贴板（解决 ModelScope 图片 CDN 无 CORS 头导致直接 `fetch(url)` 失败、回退成复制网址字符串的问题）。渲染层（`pg-render.js` 的 `pgMsgInnerHTML`）在纯图片结果下去掉空文本气泡（原先 `pgTextContent` 返回空串仍渲染了一个空 `pg-bubble`）。后端 `internal/api/image.go` 新增 `GET /api/image-proxy?url=...` 端点（服务端代拉、透传 Content-Type/Content-Length），供前端同源读取图片字节。

> **2026-07-14 更新（Image 模式编辑/缩略图/等待计数）：** 图片编辑类模型（如 ModelScope `FireRed-Image-Edit`）现可正常工作：图片模式侧栏新增"图片"面板（`pgRenderImageBlock`/`imgBlock`，原先仅在文本模式渲染），用于粘贴/管理输入图 URL；`pgBuildImageBody`（`pg-request.js`）在开启并填了输入图时按 ModelScope `/v1/images/generations` 规范写入 `image_url`（单图=字符串、多图=数组）。发送前输入栏左侧显示待发送缩略图（`pgRenderInputThumbs`）；发送后该缩略图移到提示词气泡上方（`pg-render.js` 从消息的 `msg.images` 渲染，发送时把输入图捕获到该条 user 消息并清空 `config.imageUrls`/`imageEnabled`，输入栏与侧栏随之清空），避免与气泡上方重复。等待状态（`pgMsgInnerHTML` 的 loading 分支）新增秒级计数器：全局计时器 `pgTickWaiting` 每秒按 `msg.startedAt` 重绘 loading 气泡，只要 POST 已接受、未返回错误就持续累加，所有 loading 消息结束后自动停表。

> **2026-07-15 更新（Reasoning 气泡滚动 + Mermaid 渲染稳定化）：** 修复两个前端渲染问题。(1) Reasoning 气泡 `.pg-thinking-body`：原先因 `web/static/style.css` 遗留的 `max-height:240px; overflow-y:auto` 覆盖生效（`playground.css` 未显式设置这两项），气泡超过 240px 即出现内滚动条；流式刷新每次 `pgRenderBubble` 重建 DOM 使内 `scrollTop` 归零、`pgScrollBottom` 仅滚外层 `#pg-messages-*`，导致滚动条总跳回顶部。`playground.css` 现显式设置 `max-height:60vh; overflow-y:auto`（增大高度）并改 `white-space:normal`；新增 `pgScrollBottomReasoning` 在流式更新（与 `pgFinish`）时将该气泡的 `.pg-thinking-body` 滚至底部（折叠态跳过）。(2) Mermaid 渲染不稳（完成后变空、切换 raw/parsed 时多图随机只显一图）：根因为多个 `mermaid.run` 并发 + 占位符无稳定 ID 导致 ID 冲突。`pgRenderMermaid` 现为每个占位符分配唯一 `id="pg-mmd-N"`、经 `pgMermaidQueue` 串行执行 `mermaid.run`、并以源码为 key 缓存渲染后 SVG（`PG_MERMAID_MAP`），完成态命中缓存直接克隆 SVG（避免重渲染抖动）；流式中不缓存（避免缓存半截图），仅完成态缓存供后续 raw/parsed 切换复用。`pgPostProcessCode` 与 `pgRenderBubble` 新增 `isStreaming` 入参与传递。(3) 同步清算历史债：此前从 `web/static/style.css` 中分离 `.pg-*` 段到 `playground.css` 时未删除原段，导致两个 CSS 仍在 `index.html` 同时被加载、`.pg-thinking-body` 等多处出现 style.css 与 playground.css 规则并存（style.css 后被 playground.css 仅部分覆盖）。本次把 `web/static/style.css` 中整个 Playground 段（原 529–762 行，约 234 行，含 `.pg-layout`/`.pg-bubble`/`.pg-thinking*`/`.pg-mermaid`/`.pg-side`/`.pg-input*`/`.pg-debug-*` 等全部 `.pg-` 选择器）彻底删除；`index-nopg.html`（不加载 playground.css/不渲染 `.pg-` DOM）和 `index.html`（加载 playground.css）均无依赖残余校验通过。playground 的样式现在单一来源 `playground.css`，style.css 不再含任何 `.pg-` 规则。

> **2026-07-15 更新（图片请求超时兜底）：** 修复图片生成在用户切走 Playground 页面（切到 Console，或将 WebView2 窗口失焦/最小化）后的 UI 卡死问题。根因：Chromium 对后台 tab / 失焦页面的 `fetch()` 会施加调度限制甚至中止未完成请求，但**fetch promise 不一定被 reject**——`pgFail` 不会被调用 → `w.streaming` 保持 true → Generate 按钮卡在 Stop、`pgTickWaiting` 计时器永远跑。两处兜底统一为 300 秒（5 分钟，覆盖 4k 图片 ~4 分钟实际耗时 + 缓冲）：
> - **`pgSendImage` `imgTimer`（`pg-stream.js`）：** 发起 `fetch` 前注册 300s setTimeout，超时则 `abortCtrl.abort()` + `pgFail('Request timed out (300s)')`。`.then`/`.catch` 中 `clearTimeout` 取消（成功/正常失败时不触发）。
> - **`pgTickWaiting` 安全网（`pg-render.js`）：** 常量 `pgSafetyNetMs = 300000`，每秒检查 `status==='loading'` 的消息若 `Date.now() - m.startedAt > pgSafetyNetMs` 则直接 `pgFail`，作为 imgTimer 之外的顶层兜底防 timer 漏走。
>
> 两者协同覆盖 fetch 挂起场景；触发后 `msg.status` 变为 `'error'`，`pgTickWaiting` 自动停表、Generate 按钮恢复可用。重要约束：**Generate 后须保持在 Playground 页面**——这是 Chromium 行为，无法通过代码让后台 fetch 在那种调度限制下保活到数十秒级。代理侧已配合实施 keep-alive 刷新（见 `proxy-architecture.md` §8.7），使前台保持时图片正常显示。

> **2026-07-15 更新（图片尺寸编辑 + 自定义尺寸输入）：** Image 模式的 Size 下拉列表新增两个特性：
> - **编辑按钮**（`pg-modal.js` `pgOpenImgSizesModal`）：Size 下拉右侧的 "Edit" 按钮打开弹窗，弹窗内 textarea 每行一个分辨率；保存时通过 `pgApiPatch('/providers/{id}/models/imgSizes', {model, imgSizes})` 写入 `config.yaml` 的 `ModelDef.ImgSizes` 字段，并同步更新 `pgState.models[].imgSizes`。空列表回退内置默认列表（gpt 8 个 / modelscope 5 个）。后端 `updateModelImgSizes`（`api/providers_models_crud.go`）做去重/裁剪/200 上限清洗，`registry.UpdateModelImgSizes` 写入 provider Models。PATCH 路由挂载于 `api/router.go:251`。
> - **自定义尺寸输入**（`pg-ui.js` `pgImgParamSelectWithEdit` / `pgOnImgSizeSelect`）：Size 下拉末项 "Custom Size..."，选中后展开下方的 `pg-img-custom-row` 文本输入框；用户输入 `WxH`（如 `1234x5678`）即时写入 `w.config.imgSize` 参与请求。"Edit" 弹窗保存的列表和自定义输入互不干扰——自定义值不写入 `config.yaml`，仅在当前 `w.config.imgSize` 中随 localStorage 持久化。
> - **数据传递：** `/api/models` 的 `modelInfo`（`internal/api/models.go`）新增 `realModelId`（用于 PATCH 入参，取 `ModelDef.ID`，不受 alias 遮盖）、`providerId`（内部 provider ID，用于 PATCH URL 路径）、`imgSizes`（自定义列表）；前端 `pgState.models[]` 语义同步扩展。`pg-core.js` 新增 `pgApiPatch` 桥接。

## 1. 范围与结论

Playground 是 TinyRouter 管理 UI 中的可选交互式 LLM 客户端，覆盖以下能力：

- 1–4 窗口的普通并行模型对话；
- OpenAI-compatible 流式和非流式聊天；
- Markdown、KaTeX、代码高亮、Mermaid、HTML 预览和来源展示；
- 多 Agent 自动群聊；
- AI 场景/角色设定生成；
- Director/Narrator 剧情推进；
- 请求、响应和原始 SSE 调试视图。

Playground **没有独立的 Go 业务 handler**。后端专属代码只负责资源编译、静态路由和入口选择；模型请求复用 TinyRouter 通用代理栈。

```mermaid
flowchart LR
    Browser["浏览器管理 UI"]
    PG["Playground JS 模块"]
    Models["GET /api/models"]
    Chat["POST /v1/chat/completions"]
    Proxy["通用 Proxy Handler"]
    Route["Combo / QuickSlot / Provider 解析"]
    Select["Key 选择、冷却与重试"]
    Upstream["上游 OpenAI-compatible API"]
    Side["Usage / Quota / Console / State"]

    Browser --> PG
    PG --> Models
    PG --> Chat
    Chat --> Proxy --> Route --> Select --> Upstream
    Proxy --> Side
```

## 2. 事实优先级

出现冲突时按以下优先级判断：

1. 当前源码和测试；
2. 本文；
3. `web/playground/README.md`（仅作为入口）；
4. `handoff.md`、`docs/research/*`、历史提交信息（仅作历史背景）。

本文的关键结论都在第 14 节列出源码锚点。修改相关模块后，应同步更新本文的“最后核对”、接口、状态和风险章节。

## 3. 编译、嵌入与运行时门控

### 3.1 两层开关

Playground 同时受编译期开关和运行时开关控制：

| `playground` build tag | `enablePlayground` | 根页面 | Playground 静态路由 |
|---|---:|---|---|
| 无 | 任意 | `index-nopg.html` | 不注册 |
| 有 | `true` | `index.html` | 注册 |
| 有 | `false` | `index-nopg.html` | 仍注册 |

- 编译期：`web/embed_playground.go` 嵌入 `web/playground/static-pg`，`PlaygroundCompiled()` 返回 `true`。
- 无 tag：`web/embed.go` 只嵌入核心 `web/static`；`web/embed_playground_stub.go` 提供空 `PlaygroundStatic`。
- 运行期：`Config.EnablePlayground` 只影响根路径选择哪个 HTML 入口，默认值为 `true`。
- 旧 YAML 未出现 `enablePlayground` 时，加载逻辑补为 `true`。

因此，`enablePlayground=false` 是 **UI 可见性开关，不是能力或安全开关**。带 tag 的二进制仍能直接访问 Playground 资产，`/v1/chat/completions` 也始终存在。

### 3.2 构建方式

```powershell
# 默认构建：不含 Playground
go build -o tinyrouter.exe .

# 含 Playground
go build -tags playground -o tinyrouter-pg.exe .

# Windows 构建脚本
./build.ps1 -Playground
./build.ps1 -Variant tray -Playground
./build.ps1 -Variant webview -Playground -Strip
```

`build.ps1` 将 `-Playground` 转为 `playground` tag，并和 `tray`、`webview` tag 合并。`debug` 变体明确忽略 Playground。Playground 资产当前约增加 4 MiB，主要来自 vendor 库。

### 3.3 静态路由

`internal/api/router.go` 在 `PlaygroundCompiled()` 为真时挂载：

- `/playground.css`；
- `/vendor/*`；
- 显式白名单中的 `playground.js`、`pg-i18n.js` 和所有 `pg-*.js`。

新增或重命名前端模块时必须同时更新：

1. `web/playground/static-pg/` 中的文件；
2. `internal/api/router.go` 的 `pgJSFiles`；
3. `web/static/index.html` 的加载顺序。

`playground.js` 当前只有兼容说明，不承载实现。

## 4. 后端架构

### 4.1 后端职责边界

Playground 后端相关职责只有三类：

| 职责 | 实现位置 | 说明 |
|---|---|---|
| 资源编译 | `web/embed*.go` | build tag 决定是否嵌入 |
| UI 入口与静态路由 | `internal/api/router.go` | 选择 index、挂载静态文件 |
| 运行时配置 | `internal/config/*`、`internal/api/settings.go` | 保存 `enablePlayground` |
| Gallery 图片查看器后端 | `internal/api/gallery*.go`、`internal/gallery/*` | 仅随 `-tags playground` 编译可用；zip/tiff 解析与转码，会话驻内存 LRU |

聊天、模型解析、轮转、冷却、重试、用量统计等均属于通用代理能力，不是 Playground 私有实现。Gallery（图片查看器分页）同理：仅在 `-tags playground` 编译时随 Playground 资产一起嵌入，无 tag 的二进制不含此功能。

### 4.2 Playground 使用的 HTTP 接口

| 接口 | 用途 | 鉴权 | Body 上限 |
|---|---|---|---:|
| `GET /api/models` | 侧栏模型选择器 | 管理 session；未启用密码时放行 | `/api` 统一 1 MiB（GET 无 body） |
| `POST /v1/chat/completions` | 普通聊天、群聊、摘要、场景生成、导演和旁白 | 无应用层鉴权 | 32 MiB |
| `POST /v1/images/generations` | Image 模式图片生成（GPT/xAI/ModelScope） | 无应用层鉴权 | 32 MiB |
| `POST /v1/tasks/{taskId}` | ModelScope 异步任务轮询 | 无应用层鉴权 | 32 MiB |
| `GET/PATCH /api/settings` | 读取/修改 `enablePlayground` | 管理 session | 1 MiB |
| `POST /api/save-image` | Image Preview 保存图片到 `imgs/` 目录 | 管理 session | 32 MiB |
| `GET /api/image-proxy` | 同源代拉远程图片字节（供 Copy/footer 元数据，规避 CORS） | 管理 session | 32 MiB |
| `POST /api/anysearch/search` | Search 模式搜索代理 | 管理 session | 1 MiB |
| `POST /api/anysearch/subdomains` | Search 模式子域查询 | 管理 session | 1 MiB |
| `POST /api/anysearch/extract` | Search 模式 URL 内容提取 | 管理 session | 1 MiB |
| `POST /api/editor/open` | Editor 原生文件选择器打开文本文件 | 管理 session | 32 MiB |
| `POST /api/editor/save` | Editor 原子写保存文本文件 | 管理 session | 32 MiB |

前端源码中的 `pgApiGet('/models')` 经宿主 `apiGet` 自动加 `/api`，实际请求是 `/api/models`。聊天相关代码直接 `fetch('/v1/chat/completions')`。

`/api/models` 返回：

```json
{
  "models": [
    { "id": "provider-prefix/model-id", "provider": "Provider Name", "type": "provider" },
    { "id": "combo-name", "provider": "fallback", "type": "combo" }
  ]
}
```

它聚合启用 Provider 的模型和 Combo；Provider 未配置模型时暴露 `prefix/*`。

### 4.3 通用代理调用链

`POST /v1/chat/completions` 的调用链为：

```text
api.Router
  -> proxy.Handler.ChatCompletions
  -> handleProxy
  -> Combo / QuickSlot / provider-prefix 解析
  -> rotation.Selector.SelectKey
  -> forwardWithRetry
  -> forwardUpstream
  -> streamResponse / non-stream response
```

后端只强制校验 JSON 和非空 `model`。`messages` 不做完整 schema 校验；其他字段原则上透传。发送上游前会：

- 将客户端模型名替换为真实上游模型名；
- 用选中的 Provider Key 重建 `Authorization: Bearer ...`；
- 流式请求设置 `Accept: text/event-stream`；
- 按 Provider 配置可注入 `stream_options.include_usage`；
- 对 Gemini OpenAI-compatible 请求按需补 `thought_signature`；
- 执行 key 轮转、冷却、重试、Combo fallback 和配额逻辑。

所有 Playground 模型请求都会进入通用 Usage、Quota、Console、运行时状态和 debug tracking 链路。

### 4.4 响应契约

流式成功响应：

- `Content-Type: text/event-stream`；
- `Cache-Control: no-cache`；
- `Connection: keep-alive`；
- `X-TinyRouter-Provider`；
- `X-TinyRouter-Key`；
- 按 chunk flush；默认不解析/改写 SSE 内容。

当 `NormalizeStreamChunks` 开启时，代理可将无 error 的 `"choices": null` 规范为 `[]`，这是“原样透传”的已知例外。

非流式响应强制为 JSON，保留上游状态码并附加 Provider/Key 响应头。TinyRouter 本地代理错误统一为：

```json
{"error":{"message":"...","type":"proxy_error"}}
```

### 4.5 鉴权与网络边界

- TinyRouter 监听 `127.0.0.1:<port>`；localhost 是主要安全边界。
- 管理密码只保护 `/api/*` 管理接口。
- Playground 静态文件和 `/v1/*` 不经过 `AuthMiddleware`。
- `/v1/*` 支持 CORS preflight，并暴露 Provider/Key 调试响应头。
- 客户端提供的 Authorization 不会原样送给上游；上游认证始终换为 TinyRouter 选中的 Key。

## 5. 前端模块拓扑

### 5.1 加载顺序

`web/static/index.html` 的顺序是运行时契约：

```text
vendor:
katex -> marked -> marked-katex-extension -> DOMPurify -> highlight.js -> mermaid

modules:
pg-i18n -> pg-core -> pg-state -> pg-markdown -> pg-request -> pg-stream
-> pg-autochat -> pg-setup -> pg-director -> pg-search -> pg-render -> pg-ui -> pg-modal
-> pg-lifecycle
```

全部模块使用浏览器全局函数/变量协作，没有 ES module、bundler、事件总线或响应式框架。

### 5.2 文件职责

| 文件 | 职责 |
|---|---|
| `pg-core.js` | 默认配置、localStorage key、宿主适配、限制和公共常量 |
| `pg-state.js` | 全局/窗口状态、加载保存、四窗初始化、模型目录 |
| `pg-request.js` | body、内容/图片、SSE 行和错误解析 |
| `pg-stream.js` | 流式/非流式请求、chunk 聚合、完成/失败/停止 |
| `pg-markdown.js` | Markdown、KaTeX、DOMPurify、reasoning 拆分 |
| `pg-render.js` | 消息、来源、代码/Mermaid/HTML、debug 渲染 |
| `pg-ui.js` | 输入、消息操作、窗口/侧栏/参数/图片交互 |
| `pg-modal.js` | 调试、图片预览（含 zoom/pan/copy/save/reset）、模型选择等 modal |
| `pg-autochat.js` | 共享时间线、多 Agent 调度、摘要、群聊 modal |
| `pg-setup.js` | 场景向导、ScenarioProfile、导入导出和应用 |
| `pg-director.js` | Director 判断、Narrator 生成和生命周期 |
| `pg-search.js` | Search 模式：3 步 AI 编排（分类→搜索→综合）、搜索设置面板、结果渲染 |
| `pg-lifecycle.js` | `renderPlayground`（含 search 模式恢复后重新渲染） / `cleanupPlayground`（search 模式 early return 不 abort） |
| `pg-i18n.js` | Playground 独立中英文字典 |
| `playground.css` | 全屏布局、消息、侧栏、modal、响应式样式 |

### 5.3 宿主适配契约

`pg-core.js` 读取可选的 `window.PG_HOST`：

```text
apiGet(path) -> Promise<object>
toast(message, type?)
escapeHtml(value)
copyToClipboard(text, label?)
t(key, args?)
```

未注入时回退 TinyRouter 管理 UI 的同名全局函数。此契约只覆盖模型目录和 UI 基础能力；聊天、场景和导演请求仍硬编码为 same-origin `/v1/chat/completions`，所以当前并非完全后端无关的组件。

## 6. 页面生命周期与布局

管理 UI 的 `navigateTo('playground')` 调用 `renderPlayground(container)`：

1. `pgLoad()` 从 localStorage 恢复状态；
2. `pgEnsureWindows()` 初始化到四个窗口；
3. `pgInitMarker()` 初始化 Markdown；
4. 注入 `.pg-layout`、消息 panes、输入栏和侧栏；
5. 立即渲染；
6. 异步获取模型目录后重绘。

离开 Playground 时 `cleanupPlayground()`：

- **Search 模式（`mode === 'search'`）：** 不 abort 请求（让搜索在后台继续运行），仅调用 `pgSaveSearchHistory()` 持久化 searchHistory + `pgSaveMode()` 保存模式，然后 early return。
- 停止自动群聊；
- 停止 Recent Requests 左侧面板的轮询（`pgStopReqLeftPolling`）；
- abort 每个窗口的在途 fetch；
- 清除 streaming 标记；
- reset Director/Narrator。

CSS 在 Playground 页面禁用主容器滚动，只允许消息区和侧栏内部滚动；宽度不超过 900px 时切为单列。

### 6.1 模式切换

Playground 侧栏顶部的"窗口设置"面板标题右侧有四个模式按钮：**普通**、**自动对话**、**图片** 和 **搜索**。模式状态由四态字段 `pgState.mode`（`'normal'`|`'autochat'`|`'image'`|`'search'`）驱动，不额外持久化（重载后默认普通模式）。

- **普通模式**（`mode = 'normal'`）：侧栏不显示 Auto Chat、Director 和 Agent Identity 面板；输入栏不显示 auto chat 停止按钮。
- **Auto Chat 模式**（`mode = 'autochat'`）：显示全部面板，行为同原实现。切换到 Auto Chat 时若窗口数 < 2 会 toast 警告并回退。
- **Image 模式**（`mode = 'image'`）：侧栏仅显示模型选择、图片参数面板（按协议分支：GPT 显示 size/quality/background/moderation，xAI 显示 aspect_ratio/resolution/n，ModelScope 显示 size/negative_prompt/steps/guidance/seed）、"图片"面板（粘贴/管理编辑输入图 URL，原先仅在文本模式渲染，现 image 模式也显示，供图生图/图片编辑附加输入图）和 Debug 面板。输入栏文案改为"生成"，发送前左侧显示待发送缩略图、发送后清空（输入图改为显示在提示词气泡上方）。模型选择器仅显示 `kind==='image'` 的模型。发送时 `pgBuildImageBody()` 按协议构建请求体；若开启了图片附加并填了输入图 URL，按 ModelScope `/v1/images/generations` 规范写入 `image_url`（单图=字符串、多图=数组）。随后调用 `pgSendImage()` 走 `/v1/images/generations`。`pgSendImage` 发起 fetch 前注册 300s `imgTimer` 兜底（见下方"图片请求超时兜底"更新）。等待响应期间，loading 气泡显示秒级计数器（`pgTickWaiting` 全局计时器每秒按 `msg.startedAt` 重绘 loading 气泡）；`pgTickWaiting` 已含 300s 安全网——loading 超 300s 未结束时 `pgFail` 强制收尾，避免 fetch 挂起致 UI 永远等待。POST 已接受且未返回错误即持续累加，全部 loading 结束后自动停表。

- **Search 模式**（`mode = 'search'`）：第四种模式，单窗口，侧栏显示模型选择 + 搜索设置面板（AnySearch API Key 输入 + Max Results 滑块） + Debug 面板。输入栏按钮文案为"Search"。发送时调用 `pgSearchSend()` 执行 3 步 AI 编排流程：分类（Categorize）→ 搜索（Search）→ 综合（Synthesize）。分类阶段将用户查询归类并提取搜索关键词；搜索阶段调用 `POST /api/anysearch/search` 代理执行 AnySearch JSON-RPC 搜索；综合阶段将搜索结果与原始查询合并，调用 LLM 生成最终回答。搜索中间结果（分类信息、原始搜索结果）在消息气泡中可折叠渲染。`pgState.search` 保存 `maxResults` 和 `apiKey` 配置。

切换入口为 `pgSetMode(mode)`，接收字符串参数，内部调用 `pgAutoChatToggle`。`pgAutoChatToggle` 在修改状态后同时调用 `pgRenderSidebar()` 和 `pgRenderPanes()`，后者负责布局切换和左侧面板的启停。

### 6.2 Recent Requests 左侧面板

在**普通模式 + 单窗口**（`splitCount === 1`）时，布局自动切换为三列：

```text
grid-template-columns: 260px 1fr 320px
  列1: .pg-req-left    — Recent Requests 面板（固定窄宽，占满全部高度）
  列2: .pg-main         — 聊天窗口（右对齐，max-width 取消，填满列宽）
  列3: .pg-side         — 右侧栏（不变）
```

左侧面板通过 `pgRenderReqLeft(showReqLeft)` 构建，包含标题和可滚动表格。数据来自 `GET /api/usage/playground?limit=50`（经 `pgApiGet` 适配器），每 10 秒轮询一次（`pgReqLeftTimer`）作为后备。同时通过 SSE 订阅 `/api/usage/events`，实时接收 `request-start` 和 `request-done` 事件——请求发送即立即出现 processing 条目，完成后即时更新最终状态。processing 条目的 latency 由 500ms 定时器（`pgReqLeftProcTimer`）实时刷新。

**来源过滤（物理分流 + 前端双保险）：** 后端 `recordUsage` 按 `X-TinyRouter-Source` 头分流：`source == "playground"` 的请求写入独立的 `pgUsageBuf`（经 `Handler.SetPgUsage` 注入），其余写入 `usageBuf`；`GET /api/usage/playground` 仅返回 `pgUsageBuf` 的条目 + playground 来源的 inflight 条目。`GET /api/usage` 过滤掉 playground 来源的 inflight。前端 `pgFetchReqLeft` 改用 `/api/usage/playground`，`pgRenderReqLeftContent` 仍过滤 `source === 'playground'` 作双保险。Playground 请求始终捕获 payload/headers（不依赖 debug mode），Recent Requests 的请求仅在 debug mode 时捕获。

表格仅显示 4 列，**不依赖 debug mode**，始终可见：

| 列 | 数据字段 | 显示格式 |
|---|---|---|
| 状态指示 | `status` | 彩色圆点：success=绿、error=红、retry=黄、processing=蓝(脉冲) |
| 时间 | `timestamp` | `toLocaleTimeString()` |
| Latency | `latencyMs` | `(latencyMs/1000).toFixed(1) + 's'`；processing 时实时计算 |
| Tokens | `inputTokens` / `outputTokens` | `in/out`；processing 时显示 `—` |

离开普通模式或切换到多窗口时，`pgStopReqLeftPolling()` 清除定时器并清空面板内容。`cleanupPlayground()` 也会调用此函数。

**点击查看详情：** 表格每一行带 `onclick="pgShowReqDetail(i)"`，`pgShowReqDetail` 复用主 UI 的 `info-modal-overlay`（与 Usage 页面 Recent Requests 详情相同的模态），通过 `renderInfoSection` / `buildInfoField`（`info_common.js`）构建内容，每字段具备 pretty/raw 切换和 copy 按钮、模态头部有 Copy All。展示该条目的全部字段：Request Info（时间/Provider/模型/Key/状态/延迟/首 Token/Tokens/错误/上游/响应状态）、Request Body、Request Headers、Response Headers、Response Body。**不依赖 debug mode**——服务端始终捕获 payload 和 headers。当前条目缓存于模块变量 `pgReqLeftEntries`。

## 7. 状态模型与持久化

### 7.1 核心状态

```text
pgState
├─ splitCount / activeWin
├─ mode ('normal'|'autochat'|'image'|'search')
├─ models[]
├─ windows[4]
│  ├─ config / parameterEnabled / messages
│  ├─ streaming / abortCtrl
│  ├─ pendingContent / pendingReasoning / pendingSources
│  ├─ sseEvents / debugRequest / debugResponse
│  └─ replyCount / autoChatPending / lastReadTimelineId / ...
├─ autoChat
│  ├─ enabled / iterations / userName / delaySeconds
│  ├─ isRunning / abortFlag / session
│  ├─ timeline[] / timelineId
│  ├─ scenario
│  └─ director
└─ search
   ├─ maxResults
   └─ apiKey
```

每个窗口有独立模型、采样参数、system prompt、消息、网络状态和群聊游标。全局状态通过直接引用共享，UI 依靠显式 render/update 调用保持同步。

### 7.2 localStorage

| Key | 内容 | 是否完整恢复 |
|---|---|---|
| `tinyrouter.playground.cfg.v2` | window 0 config | 是 |
| `tinyrouter.playground.params.v2` | window 0 参数开关 | 是 |
| `tinyrouter.playground.msg.v2` | window 0 消息 | 受容量裁剪 |
| `tinyrouter.playground.autochat.v1` | 用户名、迭代、延迟、Director 配置 | 仅配置 |
| `tinyrouter.playground.scenario.v1` | 最近 ScenarioProfile | 是 |
| `tinyrouter.playground.search.history.v1` | searchHistory 列表（最多 50 条） | 是（不含 streaming 状态） |
| `tinyrouter.playground.search.active.v1` | activeSearchId | 是 |

关键语义：

- **只有 window 0 的普通 config、参数和消息持久化。** window 1–3 在首次进入时克隆 window 0 配置，但清空消息和运行态。
- `splitCount`、`activeWin`、timeline、群聊运行状态、回复计数和读游标不持久化。
- 普通保存有 500 ms debounce。
- 消息上限：原始 JSON 1 MiB、最多 100 条、单条 content/reasoning 40k 字符、总计约 120k 字符。
- ScenarioProfile 独立持久化，但应用到各窗口后的 window 1–3 配置本身不会直接持久化；刷新后可从场景 review 再次应用。
- **Search 模式持久化：** `searchHistory`（最多 50 条）和 `activeSearchId` 通过 `PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY` 持久化到 localStorage。`pgSearchSend()` 创建 entry 后立即调用 `pgSaveSearchHistory()`；`pgLoad()` 中 mode 加载后立即调用 `pgLoadSearchHistory()` 恢复历史，search 模式下跳过 localStorage messages 加载改用 `pgSyncSearchMessages()` 从 searchHistory 同步消息引用。`cleanupPlayground()` 在 search 模式下 early return 不 abort 请求，仅持久化状态。渲染函数（`pgSearchFlushRender`/`pgSearchFinish`/`pgSearchFail`）检查 DOM 存在性，后台 tab 渲染时容器已被清空则静默跳过。

## 8. 普通多窗口聊天

### 8.1 请求流程

```mermaid
sequenceDiagram
    participant U as User
    participant UI as pg-ui
    participant Req as pg-request
    participant Stream as pg-stream
    participant API as /v1/chat/completions
    participant Render as pg-render

    U->>UI: 输入并发送
    loop 每个已选模型窗口
        UI->>UI: push user + loading assistant
        UI->>Stream: pgSend(window, assistantIndex)
        Stream->>Req: 构建并 finalize body
        Stream->>API: fetch
        API-->>Stream: SSE chunks 或 JSON
        Stream->>Render: 50ms 节流更新 / 最终渲染
    end
```

普通模式把同一用户消息广播到当前分屏中所有已选择模型的窗口；未选择模型的窗口跳过。任一窗口正在生成时，不允许发起新一轮普通广播。

发送按钮可见性：`pgRenderInputBar` 在没有任何窗口选择模型时把发送按钮设为 `disabled`（forbidden 光标），Enter 走 `pgOnInputKey` 不受该属性限制。`pgOnModelChange` 选模型后调用 `pgUpdateInputBar()` 重新渲染输入栏，使按钮即时可用；模型目录加载完成回调也补一次 `pgUpdateInputBar()`。

标准 body 包含：

- `model`、`messages`、`stream`；
- 可选 `temperature`、`top_p`、`max_tokens`；
- 可选 `frequency_penalty`、`presence_penalty`、`seed`；
- 可选 `thinking: {type: "enabled", budget_tokens: ...}`。

`systemPrompt` 在消息中没有 system role 时前插。启用图片时，用户消息在 `pgUserSend` 阶段即被构建为 OpenAI 多模态 content parts（`[{type:"text",...}, {type:"image_url",...}]`），同时清空 `imageUrls` 并关闭 `imageEnabled`，使输入区缩略图消失、图片缩略图随用户消息气泡渲染。`pgFinalizeBodyForSend` 中的 image 注入逻辑仅作为后备（当 `imageEnabled` 仍为 true 且 `imageUrls` 非空时触发）。

“Custom body”会先 `JSON.parse` 用户输入，但后续仍假定 `body.messages` 存在，并继续执行 system/image finalize；它不是任意 JSON 的完全原样透传入口。

### 8.1b Custom Endpoint

侧栏 Custom Body 面板上方有 **Custom Endpoint** 面板（`pg-ui.js` 的 `pgRenderSidebar`），包含开关（`useCustomEndpoint`）、Endpoint URL 输入框（`customEndpoint`）和 API Key 输入框（`customEndpointKey`）。启用后，`pgStream` 和 `pgSendNonStream` 的 fetch 目标从 `/v1/chat/completions` 改为用户填入的 URL，`Authorization: Bearer <key>` 头由用户填入的 Key 生成，不附带 `X-TinyRouter-Source` 头。此功能**仅在普通模式生效**，auto chat / director / narrator / setup 等辅助请求仍走 `/v1/chat/completions`。Custom Endpoint 的请求不经过 TinyRouter 代理栈（key 轮转、重试、combo 解析等），由前端直接 fetch。

### 8.2 流式解析

前端只处理逐行 `data:`：

- `[DONE]` 结束；
- JSON 的 `choices[0].delta.content` 进入内容；
- `reasoning_content`、`reasoning`、`thinking`、`thought` 进入思考内容；
- `sources`、`citations`、`web_search_citation`、`web_search` 进入来源列表；
- `pgMergeChunk` 同时兼容增量 chunk 和累计全文 chunk；
- 50 ms 定时器将 pending 状态刷入消息 DOM。

它不是完整 SSE 实现：不合并多行 data，也不处理 event/id/retry 字段。

### 8.3 渲染与安全

- Markdown 使用 marked；数学公式使用 KaTeX；代码使用 highlight.js。
- Markdown HTML 经 DOMPurify 清洗。
- 来源 URL 只允许 `http:` / `https:`。
- Mermaid 以 `securityLevel: strict` 初始化。
- HTML/SVG 预览使用 sandboxed iframe，不允许脚本执行。
- Provider/Key 响应头、实际请求、原始 SSE/响应进入 debug 视图。
- Reasoning 气泡使用 `pgRenderMarkdown` 渲染（与 content 相同的 Markdown 管线），无 `max-height`/`overflow-y` 约束，随内容自然增长；reasoning 结束后自动折叠（`collapsed` CSS class），用户可手动展开/折叠。
- 图片预览弹窗（`pgShowImageModal` → `pg-modal-overlay`）支持：鼠标滚轮缩放（以图片中心为轴心，最小不低于 auto-fit 比例）、鼠标拖拽平移、Reset 按钮复位、Copy 按钮（经同源 `/api/image-proxy` 代拉图片字节后 `ClipboardItem` 写入剪贴板，复制的是图片本身而非网址）、Save 按钮（`POST /api/save-image` 保存到 `imgs/` 目录）。弹窗尺寸 90vw × 90vh；auto-fit 由 `transform: scale(fitScale)` 单独负责缩放（大图缩小到正好填满、小图放大铺满窗口）。底部 footer 显示分辨率（`naturalWidth × naturalHeight`）、大小（`pgFormatBytes`，经同源 `/api/image-proxy` 取 Blob 的 `size`）、格式（Blob `type` 或 data: 的 mime）。输入区缩略图和聊天气泡缩略图均可点击打开预览。纯图片结果（无文本）下不再渲染空文本气泡。

## 9. 自动群聊

### 9.1 核心模型

自动群聊要求至少两个窗口。`pgState.autoChat.timeline` 是唯一事实源，每条记录概念结构为：

```text
{ id, sender, senderType, winIdx, content, ts, status }
```

`senderType` 包括 `user`、`agent`、`system`、`narrator`。每个窗口用 `lastReadTimelineId` 表示自己的消费位置。

发送前按窗口重建视角：

- 自己过去的发言映射为 `assistant`；
- 用户和其他 Agent 映射为带 `[sender]:` 前缀的 `user`；
- system 和 narrator 映射为 `system`；
- 未配置角色 system prompt 时使用默认群聊 prompt，并允许精确输出 `<pass/>`。

### 9.2 事件驱动循环

```mermaid
flowchart TD
    Start["pgAutoChatStart"] --> Timeline["用户消息进入 timeline"]
    Timeline --> Wake["唤醒所有可回复窗口"]
    Wake --> Unread{"有未读且未到迭代上限?"}
    Unread -->|否| Done["pgAutoChatCheckAllDone"]
    Unread -->|是| Delay["可选随机延迟 + session 守卫"]
    Delay --> Perspective["从 timeline 重建窗口视角"]
    Perspective --> Send["pgSend"]
    Send --> Finish["pgFinish / pgFail"]
    Finish --> Broadcast["回复或 pass 写回 timeline"]
    Broadcast --> Director["可选 Director 评估"]
    Broadcast --> Wake
    Director --> Narrator["可选 Narrator 注入"]
    Narrator --> Wake
```

循环由 fetch 完成回调和 `setTimeout` 驱动，没有阻塞式 while：

- 延迟为配置值的 0.5–1.5 倍；被 `@AgentName` 提及时缩为基础延迟的 0.3 倍。
- `session` epoch 在 start/stop 时递增，使旧 timer 回调失效。
- 正常回复增加窗口 `replyCount`，写入 timeline 并唤醒其他窗口。
- 精确 `<pass/>` 写入 pass 记录，但不增加迭代数。
- 用户运行中发言可通过 `@name` 定向唤醒；没有 mention 时广播。
- 单窗口失败最多在 3 秒后重试一次；耗尽后仍推进群聊完成逻辑。

### 9.3 终止与摘要

所有窗口达到迭代上限，或没有 streaming/pending/未读工作时进入终止检查。Director/Narrator 在途时会阻止过早结束；Director 还可获得一次 final-chance 判断。

timeline 较长时可异步滚动摘要：旧记录被压缩为 system summary，并保留最近记录。摘要是 best-effort，失败静默，不阻塞主流程。

stop/finish 会 abort 请求、清 timer 和运行态，但保留 timeline 供当前页面查看，并追加终止原因；刷新或离开页面后 timeline 不恢复。

## 10. 场景生成

### 10.1 三种管线

场景向导至少要求两个已选模型窗口，支持：

| 模式 | 调用阶段 | 定位 |
|---|---:|---|
| M1 | 5 | 方向 → 架构 → 侧写 → 人物卡 → 客户端合成，控制最多 |
| M2 | 2 | 场景和侧写 → 完整人物卡，默认平衡模式 |
| M3 | 1 | 一次生成场景和完整人物卡，速度最快 |

所有阶段都调用 `/v1/chat/completions`，固定 `stream:false`。可显式选择生成模型，否则回退第一个有模型的窗口。请求有 AbortController 和阶段超时，输出通过去围栏、平衡括号等方式宽容提取 JSON。

### 10.2 ScenarioProfile

持久化/导入导出的事实 schema：

```text
schema: "tr.playground.scenario"
version: 1
createdAt
seedInput
scenario
  ├─ coreSeed / world / tone / openingSituation / relationships
characters[]
agents[]
  ├─ agentName / systemPrompt / params / paramsRationale / paramsOverridden
director
  └─ plotOutline / suggestedEveryNReplies
```

客户端将人物 `personaAxes` 映射为 temperature、topP、maxTokens、随机 seed 和 thinkingBudget，并将场景与人物卡合成为每个 Agent 的 system prompt。

应用 Profile 时，按“当前有模型的窗口”顺序映射 Agent，确认是否覆盖已有 system prompt，设置参数开关，保存 ScenarioProfile，自动启用群聊，并将 `openingSituation` 预填到输入框。

Profile 支持 JSON 导入/导出，导入校验 schema/version；单个角色支持 regenerate/enrich 后重新合成 Agent 配置。

## 11. Director / Narrator

Director 是群聊的可选 best-effort 子系统：

1. 每收到一次 Agent 完成事件（包含 pass）累加计数；
2. 达到 `everyNReplies` 后，用场景、大纲、最近 20 条 timeline 和旁白历史发起非流式判断；
3. 只有 `decision=advance` 才启动 Narrator；
4. Narrator 根据方向和最近 10 条上下文生成旁白；
5. 旁白以 `senderType=narrator` 写入 timeline，并唤醒所有 Agent。

Director 和 Narrator 模型可以独立配置；空值回退第一个有模型窗口。Director 超时 30 秒，Narrator 超时 60 秒。网络或解析失败通常静默跳过，不影响主对话。

## 12. 已知约束与风险

以下是当前实现事实，不代表都要在同一轮修复：

1. **Lite 入口漂移。** `index-nopg.html` 已落后于 `index.html`，当前还缺少 Download 导航、`download.js`、`info_common.js`、Chart.js 等非 Playground 内容；关闭 Playground 会连带改变其他模块。
2. **多窗口持久化不对称。** 只有 window 0 是普通聊天 reload 后的事实源；window 1–3 是临时态。
3. **运行时开关不是安全边界。** 它只切换入口 HTML，不撤销已编译资源，也不关闭 `/v1/*`。
4. **配置能力与编译能力可能不一致。** Lite 构建中 `enablePlayground` 仍可为 true，Settings API 也不暴露 `PlaygroundCompiled()` 能力位。
5. **显式路由清单易漂移。** 新增 JS 时漏改 `pgJSFiles` 会产生运行时 404，目前无自动完整性测试。
6. **Custom body 有隐式结构要求。** 缺少 `messages` 会在后续发送链触发前端异常。
7. **SSE 支持是 OpenAI 常用子集。** 不支持完整 SSE 多行/命名事件语义。
8. **群聊不恢复。** timeline、在途状态和多窗消息刷新后丢失。
9. **摘要模型固定取 window 0。** window 0 无模型时不会执行滚动摘要，即使其他窗口有模型。
10. **场景生成离页清理不完整。** `cleanupPlayground()` 没有显式 abort `pgSetupState.abortCtrl`；场景生成可能在离页后继续到完成或超时。
11. **辅助模型失败多为静默。** 摘要、Director、Narrator 的失败不阻塞主流程，但可观测性较弱。
12. **静态缓存策略不一致。** 核心静态文件显式 `no-cache`，Playground 专属静态路由未设置同样 header。
13. **`fs.Sub` 失败静默。** 嵌入根路径变更时可能只表现为前端 404。

## 13. 测试与验证现状

已有覆盖：

- `enablePlayground` 默认 true；
- 显式 false 的配置保存/加载；
- 旧配置缺字段时的兼容迁移；
- 通用代理的流式、非流式、重试和响应行为。

当前缺口：

- `PlaygroundCompiled × EnablePlayground` 路由矩阵测试；
- Playground 静态资源及 JS 白名单完整性测试；
- `index.html` / `index-nopg.html` 同步约束测试；
- 前端 JS 单元测试；
- 浏览器集成或 Playground E2E；
- 自动执行 `go test -tags playground ./...` 的 CI。

修改 Playground 时的最低建议验证：

```powershell
go test ./...
go test -tags playground ./...
go build -tags playground -o tinyrouter-pg.exe .
```

涉及前端交互时还应手工或用浏览器验证：普通流式、非流式、多窗、停止/离页、群聊、场景向导和 Director/Narrator。

## 14. 源码锚点

后端与集成：

- `web/embed.go`：无 tag 的核心静态资源与能力位；
- `web/embed_playground.go`：Playground 资产嵌入；
- `web/embed_playground_stub.go`：无 tag 空 FS；
- `internal/api/router.go`：路由、鉴权边界、静态挂载和入口矩阵；
- `internal/api/models.go`：Playground 模型目录（响应 `modelInfo` 含 `kind`/`imgProtocol`/`imgSizes`/`providerId`/`realModelId`/`note` 字段，按 `ModelDef.Kind`/`ImgProtocol`/`ImgSizes`/`Note`；`note` 供前端 `pg-modal.js` 模型选择项 hover 显示；`providerId`/`realModelId` 供图片尺寸编辑发送 PATCH）；
- `internal/api/settings.go`：运行时开关 API；
- `internal/config/types.go`、`internal/config/defaults.go`：配置结构和默认值；
- `internal/proxy/forward.go`、`internal/proxy/upstream.go`、`internal/proxy/stream.go`：代理契约；
- `build.ps1`：Windows 构建矩阵。

前端：

- `web/static/index.html`：完整入口和硬依赖加载顺序；
- `web/static/index-nopg.html`：Lite 入口；
- `web/static/app.js`：导航和生命周期接入；
- `web/static/api.js`：`/api` 宿主适配；
- `web/playground/static-pg/pg-core.js`：公共契约；
- `web/playground/static-pg/pg-state.js`：状态与持久化（含 `pgLoadSearchHistory()`/`pgSaveSearchHistory()`/`pgSearchEntryToJSON()` Search 历史 localStorage 持久化、`PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY`/`PG_SEARCH_MAX_ENTRIES` 常量）；
- `web/playground/static-pg/pg-request.js`：请求体契约（含 `pgBuildImageBody` 按协议构建 images 请求体，并写入 `image_url`（图生图/图片编辑，单图=字符串、多图=数组））；
- `web/playground/static-pg/pg-stream.js`：网络和流生命周期（含 `pgSendImage` 发送到 `/v1/images/generations`、`pgPollModelScopeTask` ModelScope 异步轮询）；
- `web/playground/static-pg/pg-autochat.js`：群聊事实源和调度；
- `web/playground/static-pg/pg-setup.js`：ScenarioProfile；
- `web/playground/static-pg/pg-director.js`：剧情推进；
- `web/playground/static-pg/pg-markdown.js`、`pg-render.js`：内容安全与渲染（`pg-render.js` 的 `pgMsgInnerHTML` 负责气泡内缩略图（含 image 模式气泡上方编辑输入图、右侧对齐）、空文本气泡剔除、loading 气泡秒级等待计数（`pgTickWaiting`/`pgEnsureWaitingTicker`））；
- `web/playground/static-pg/pg-ui.js`、`pg-modal.js`、`pg-lifecycle.js`：交互和页面生命周期（`pg-ui.js` 含 `pgRenderImageParams`/`pgGetImgProtocol`/`pgImgParamSelectWithEdit`/`pgImgSizeOptionsFor`/`pgOnImgSizeSelect` 图片参数面板与协议分支+Size 下拉编辑按钮+自定义尺寸输入、`pgRenderImageBlock`/`pgRenderInputThumbs` 图片附加 UI 与输入栏缩略图（image 模式发送前后位移）、发送时将输入图捕获到 `msg.images` 并清空 `config.imageUrls`；`pg-modal.js` 模型选择器支持 `kindFilter` 按 kind 过滤、Image Preview 弹窗 `pgShowImageModal`/`pgInitImageZoom`/`pgCopyImage` 含 auto-fit、footer 分辨率/大小/格式、经同源 `/api/image-proxy` 复制、图片尺寸编辑弹窗 `pgOpenImgSizesModal`/`pgSaveImgSizesModal` 调用 `pgApiPatch` 持久化 `ModelDef.ImgSizes`）；
- `web/playground/static-pg/pg-ui.js` 中的 `pgRenderReqLeft`/`pgStartReqLeftPolling`/`pgRenderReqLeftContent`/`pgShowReqDetail`：普通模式左侧 Recent Requests 面板（来源过滤 + 点击详情，复用 `info-modal-overlay`）；
- `web/playground/static-pg/playground.css` 中的 `.pg-mode-toggle`、`.pg-req-left`、`.pg-req-table`：模式切换按钮和左侧面板布局。
- `web/playground/static-pg/pg-search.js`：Search 模式 3 步 AI 编排（分类→搜索→综合）、搜索设置面板、结果渲染（含 `pgSearchFlushRender()`/`pgSearchFinish()`/`pgSearchFail()` DOM 存在检查防御后台 tab 渲染、`pgSearchSend()` 创建 entry 后立即调用 `pgSaveSearchHistory()`）；
- `web/playground/static-pg/pg-state.js` 中的 `pgState.mode` 四态含 `'search'` 与 `pgState.search` 子树；
- `web/playground/static-pg/pg-ui.js` 中的 `pgSetMode` search 分支、`pgSearchSend` 调用入口、搜索设置面板渲染；
- `web/playground/static-pg/pg-render.js` 中的 search loading 状态与 searchRaw/searchClassification 折叠渲染；
- `web/playground/static-pg/pg-i18n.js` 中的 search 相关中英文键；
- `web/playground/static-pg/playground.css` 中的 `.pg-search-*` 样式类；
- `internal/anysearch/client.go`：AnySearch JSON-RPC API 客户端（`Search`/`GetSubDomains`/`Extract` 方法）；
- `internal/api/anysearch.go`：3 个 Search 模式 HTTP handler（`POST /api/anysearch/search`、`/subdomains`、`/extract`）；
- `internal/config/types.go` 中的 `AnySearchConfig` 结构体（`APIKey`/`MaxResults` 字段）+ `Config.AnySearch` 字段；
- `internal/config/defaults.go` 中的 `AnySearch.MaxResults` 默认值 5 回填。

## 15. 变更维护清单

| 变更类型 | 必查位置 |
|---|---|
| 新增/删除前端模块 | `static-pg/`、`pgJSFiles`、`index.html`、本文模块表 |
| 修改入口或运行时开关 | 两个 index、`serveUI`、Settings、路由矩阵测试 |
| 修改请求字段 | `pg-request.js`、`pg-stream.js`、proxy 透传/改写规则；改 Custom Endpoint 须同步 `pg-stream.js` 的 `pgStream`/`pgSendNonStream` fetch URL/headers 与 `pg-core.js` 的 `PG_DEFAULT_CFG` |
| 修改群聊 | timeline schema、视角映射、终止守卫、Director hooks |
| 修改场景档案 | schema/version、导入迁移、localStorage、应用映射 |
| 修改持久化 | localStorage key/version、容量限制、多窗口语义 |
| 修改渲染 | DOMPurify、URL 协议、iframe sandbox、Mermaid security；改 reasoning 渲染须同步 `pg-render.js` 的 `pgMsgInnerHTML`/`pgRenderBubble` 与 `playground.css` 的 `.pg-thinking-body` |
| 修改图片功能 | `pg-modal.js` 的 `pgShowImageModal`/`pgInitImageZoom`/`pgCopyImage`、`pg-render.js` 的 `pgMsgInnerHTML`（气泡缩略图 onclick、空文本气泡剔除、loading 秒级计数）、`playground.css` 的 `.pg-img-btn`/`.pg-image-row`；改保存或同源代理须同步 `internal/api/image.go` 的 `saveImage`/`imageProxy` 端点与 `/api/save-image`/`/api/image-proxy` 路由 |
| 修改 Image 模式或图片参数 | `pg-ui.js` 的 `pgRenderImageParams`/`pgGetImgProtocol`/`pgImgParamSelectWithEdit`/`pgImgSizeOptionsFor`/`pgOnImgSizeSelect`、`pg-request.js` 的 `pgBuildImageBody`、`pg-stream.js` 的 `pgSendImage`/`pgPollModelScopeTask`、`pg-core.js` 的 `PG_DEFAULT_CFG` 图片参数 + `pgApiPatch` 桥接、`pg-i18n.js` 图片 i18n key + `pgImgEditSizes`/`pgImgCustomSize` 系列、`proxy/handler.go` 的 `ImagesGenerations`/`PollTask`、`proxy/upstream.go` 的 `X-Modelscope-Async-Mode` header 转发、`api/router.go` 的 `/v1/images/generations`、`/v1/tasks/{taskId}`、`/api/image-proxy` 路由 + `PATCH /providers/{id}/models/imgSizes`、`internal/api/image.go` 的 `imageProxy` 端点 |
| 修改图片尺寸列表 | `pg-modal.js` 的 `pgOpenImgSizesModal`/`pgSaveImgSizesModal`/`pgResetImgSizesTextarea`/`pgImgBuiltinSizesFor`（弹窗编辑+保存）+ `pg-ui.js` 的 `pgImgParamSelectWithEdit`/`pgImgSizeOptionsFor`/`pgOnImgSizeSelect`（下拉渲染+自定义输入）+ `internal/api/providers_models_crud.go` 的 `updateModelImgSizes`（PATCH 端点）+ `internal/registry/models.go` 的 `UpdateModelImgSizes`（写入 `ModelDef.ImgSizes`）+ `internal/config/types.go` 的 `ModelDef.ImgSizes` 字段 + `internal/api/models.go` 的 `modelInfo.ImgSizes`/`providerId`/`realModelId` 回显 + `playground.css` 的 `.pg-img-edit-btn`/`.pg-img-custom-row` 样式 |
| 修改图片请求超时兜底 | `pg-stream.js` 的 `pgSendImage` 的 `imgTimer`（300s fetch 兜底 `pgFail`）、`pg-render.js` 的 `pgTickWaiting` 的 `pgSafetyNetMs`（300s loading 安全网）；改兜底阈值须同时调两侧并覆盖 4k 实际耗时上限；代理侧 keep-alive 见 `proxy-architecture.md` §8.7 的 `forward.go` keep-alive ticker 与 `compress.go` 绕过列表 |
| 修改模式切换或左侧面板 | `pgSetMode`、`pgAutoChatToggle`、`pgRenderPanes` 布局类、`pgRenderReqLeft*`、`pgShowReqDetail`、`info-modal-overlay`/`info_common.js`（详情弹窗基础设施）、`.pg-req-left-mode` CSS；改来源过滤须同步 `pg-stream.js` 的 `X-TinyRouter-Source` 头与 `recordUsage` 的 `Entry.Source` 回填 + `Handler.SetPgUsage` 注入 + `api/usage.go` `getPlaygroundUsage`；改详情弹窗须同步 `app.js` 的 `topOpenModal`/`dismissTopModal` 对 `pg-modal-overlay` 的 ESC 处理；改 Recent Requests 实时性须同步 SSE 事件处理与 `/api/usage/events` 后端 |
| 发布 Playground 变体 | 无 tag/tag 测试、资源 200、完整首页手测 |
| 新增/修改 Search 模式 | `pg-search.js`（3 步 AI 编排）、`pg-ui.js`（`pgSetMode` search 分支 + 搜索设置面板 + `pgSearchSend`）、`pg-state.js`（`pgState.mode` `'search'` + `pgState.search`）、`pg-render.js`（search loading 状态 + 折叠渲染）、`pg-i18n.js`（search 键）、`playground.css`（`.pg-search-*` 样式）、`internal/anysearch/client.go`（JSON-RPC 客户端）、`internal/api/anysearch.go`（3 个 handler）、`internal/api/settings.go`（`anySearch` 字段流转）、`internal/api/router.go`（路由注册 + `pgJSFiles` 含 `pg-search.js`）、`internal/config/types.go`（`AnySearchConfig`）+`defaults.go`（`MaxResults` 默认值 5） |
| 修改 Search 状态持久化 | `pg-state.js`（`pgLoadSearchHistory()`/`pgSaveSearchHistory()`/`pgSearchEntryToJSON()`、`PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY`/`PG_SEARCH_MAX_ENTRIES`、`pgLoad()` search 分支跳过 localStorage messages）、`pg-lifecycle.js`（`cleanupPlayground()` search early return、`renderPlayground()` 恢复后重新渲染）、`pg-search.js`（`pgSearchSend()` 即时保存、`pgSearchFlushRender()`/`pgSearchFinish()`/`pgSearchFail()` DOM 存在检查） |
| 修改/新增 Editor 功能 | `editor-state.js`、`editor.js`、`playground.css`（`.ed-*`）、`internal/api/editor.go`、`internal/api/router.go`（路由 + pgJSFiles）、`web/static/app.js`（`gotoGalleryToggle`/`navigateTo`）、`web/static/auth.js`（nav-item toggle）、`web/static/i18n.js`（`editor*` 键）、`web/static/shortcuts.js`（F6 label）、`web/static/index.html`（脚本加载） |

## 16. Gallery 模块（图片查看器分页）

Gallery 是 playground 构建变体（`-tags playground`）下的图片查看器分页，绑定 F6 快捷键，UI 由 `web/playground/static-pg/gallery.js` 实现（约 827 行 vanilla JS，IIFE + `window.renderGallery`/`window.cleanupGallery` 入口）。

### 交互方式
- **拖拽**：drop 事件读 `DataTransferItem.getAsFileSystemHandle()` 拿 `FileSystemDirectoryHandle`/`FileSystemFileHandle`，立即调用 `requestPermission({mode:'readwrite'})` 前置授权（一次性系统弹窗，之后所有磁盘操作免确认），递归 BFS 遍历目录；不支持 FS Access API 时降级 `DataTransfer.files` blob。
- **粘贴**：优先调用后端 `POST /api/gallery/paste-paths` 读取 Windows 剪贴板 CF_HDROP 绝对路径（零弹窗）；若后端无路径（截图/非 Windows）则降级为 FSAA `clipboardData.items` blob。
- **“打开”**：优先调用后端 `POST /api/gallery/open-dir`（原生 COM IFileOpenDialog 目录选择器，返回绝对路径 + 递归文件列表，后续磁盘操作零弹窗）；后端不可用时降级 `showDirectoryPicker({mode:'readwrite'})` / `showOpenFilePicker({multiple:true, mode:'readwrite'})`，无 FS Access API 时降级 `<input type=file multiple webkitdirectory>`。

### 支持格式
`webp png jpg jpeg bmp tiff`（`tif` 同 tiff）。目录/单图/多图全部前端 `FsApi.BlobTracker.create(blob)` + `<img>` 显示（浏览器原生 GPU 加速，BlobTracker 追踪防泄漏）。TIFF 因 Chromium/WebView2 原生不支持 `<img>` 显示，走后端 `POST /api/gallery/tiff` 解码转 JPEG 后再显示。

### 后端协作
zip、tiff 及文件系统操作需后端参与：
- **POST `/api/gallery/open-dir`**：后端调用 `fsutil.OpenDirectoryPicker()`（原生 COM 对话框），返回 `{dirPath, files:[{name,path,rel,size,kind}]}`（递归列出支持的图片/视频/zip 文件）。
- **POST `/api/gallery/list-dir`**：按给定目录路径返回文件列表（用于粘贴路径展开目录）。
- **GET `/api/gallery/file?path=`**：按绝对路径提供文件二进制（替代 FSAA `handle.getFile()`）。
- **DELETE `/api/gallery/fs`**：按绝对路径删除文件/目录（`{path, recursive?}`），Go 后端 `os.Remove`/`os.RemoveAll`，零浏览器权限弹窗。
- **POST `/api/gallery/zip-from-path`**：从磁盘路径直接创建 zip 会话（避免上传往返）。
- **POST `/api/gallery/zip-writeback`**：将 zip 会话字节写回磁盘原文件（`fsutil.AtomicWrite`）。
- **POST `/api/gallery/paste-paths`**：读取 Windows 剪贴板 CF_HDROP 格式文件路径（`fsutil.GetClipboardFilePaths()`）。
- **POST `/api/gallery/zip`**：上 zip 二进制（500MB 上限覆盖 `/api` 1MB 组级限制），返回 `{sessionId, manifest:{entries:[{path,size,kind}], total}}`；zip bytes 缓存于进程内 LRU 会话（上限 32 个、5 分钟空闲过期，`internal/api/gallery_session.go:10`）。
- **GET `/api/gallery/zip/{sessionId}/{entryPath:*}`**：从会话取 zip 内单张图二进制。`{entryPath:*}` 是 chi 通配匹配含 `/` 的路径；前端 `encodeURIComponent` 拼接。
- **POST `/api/gallery/tiff`**：上 TIFF 二进制（50MB 上限），后端用 `golang.org/x/image/tiff` 解码后重编码为 JPEG 返回。解码后检查图片尺寸：任一维度超过 `maxTIFFDim`（16384）时返回错误，防止解压炸弹 DoS（`internal/gallery/tiff.go:15`、`internal/gallery/tiff.go:29-31`）。

### 全屏交互
进入全屏后**仅**键盘操作：`←` 前一张 / `→` 或 `Space` 下一张 / `Esc` / `Enter` 退出全屏 / `1`-`9` 设置 9 档间隔时间（按序映射到 1/2/3/5/10/15/30/60/120 秒）/ `a` 切换自动播放。capture 阶段绑定 keydown（`galleryState.keyHandler = onFullscreenKey`，`document.addEventListener('keydown', ..., true)`）以拦截 app.js 全局 F1-F6。

> 2026-07-19：除 1-9（间隔档位，全屏内仍硬编码不可自定义）外的所有全屏键已切到 `web/static/shortcuts.js` 注册中心。`onFullscreenKey` 与 `onGalleryKeyDown` 改用 `Shortcuts.matchEvent('gallery.<actionID>', e)`：`gallery.prev`/`gallery.next`/`gallery.prev-folder`/`gallery.next-folder`/`gallery.toggle-autoplay`/`gallery.toggle-fullscreen`/`gallery.toggle-tree`/`gallery.exit-fullscreen`/`gallery.toggle-split`/`gallery.toggle-media`/`gallery.switch-focus`。视频激活时 `ArrowLeft/Right/Up/Down/Space/1-9`（媒体控制：倒退 10 秒、上一/下一视频、音量、暂停）仍保持硬编码，**刻意不纳入自定义**以避免与全局 quickslot 1-9（弹出模型选择 modal）产生跨区域冲突；`Space`/`PageUp`/`PageDown` 仍走通用导览分支作为快捷的同义键。详见 §16.x（快捷键注册中心）与 §23“变更维护清单”。

> 2026-07-26：Gallery & Usage UI 矩形无缝化重构与交互优化：(1) 移除 Usage 和 Gallery 页面所有容器间隙 (`gap: 0`)、内边距 (`padding: 0`) 与圆角 (`border-radius: 0`)，采用 1px `--glass-border` 分割网格，Usage 页 `repeat(2, minmax(0, 1fr))` 解决分辨率/DPI 切换时 50/50 破坏并重绘 Chart.js；(2) 视频 hover 控制栏精简为单行，进度条在非全屏模式下贴底常驻；(3) 在 `gallery-io.js` 调用 File System Access API 发起 `requestPermission` 之前前置弹出居中提示模态框 (`showPermissionNoticeModal`)，说明读写权限用途；(4) 全屏模式下，`.gallery-bottom` 控制栏取消死板的 `height: 42px` 限制，改为 `height: auto` 动态包裹 104px 缩略图与 42px 操作栏，避免操作控件溢出屏幕下方，且仅当鼠标滑入底部热区时进度条与操作栏合体联动 Overlay 浮现。涉及 `web/static/style.css`、`web/static/usage.js`、`web/playground/static-pg/gallery-layout.js`、`web/playground/static-pg/gallery-video.js`、`web/playground/static-pg/gallery-io.js`。

### 缩略图
前端懒生成：IntersectionObserver 触发 → `createImageBitmap(blob)` + `OffscreenCanvas(THUMB_SIZE=300)` 等比例缩放 → `convertToBlob('image/jpeg',0.8)` → `FsApi.BlobTracker.create`；失败回退原 blob。

### AI Review（图片审核）

AI Review 从硬编码"广告审核"（`is_ad` 字段）泛化为通用二值判断审核系统。用户可配置提示词或通过调用 LLM 自动生成，提示词生成模型与视觉审核模型可分别选择，预设持久化到 `config.yaml`。LLM 返回字段统一为 `match`，同时向后兼容旧 `is_ad` 字段（`ParseReviewResponse` 按顺序回退 `matchField` → `match` → `is_ad`）。

#### 后端架构

- **`internal/gallery/review.go`**：定义 `ReviewStrategy`（`all`/`head-tail`）、`ReviewStatus`（`running`/`completed`/`cancelled`/`error`）、`ReviewResult`（`Index`/`Path`/`IsMatch`/`Reason`）、`ReviewResponse`（`Match`/`Reason`）类型；`ParseReviewResponse(body, matchField)` 解析 LLM 返回的 JSON，按 `matchField` → `match` → `is_ad` 尝试读取 bool 字段；`PromptGenSystemPrompt` 常量定义提示词生成器的 system prompt，`PromptGenUserPromptTemplate` 是用户消息模板，`DefaultUserPrompt` 是审核启动时的默认 user prompt。
- **`internal/api/gallery_review.go`**：`galleryStartReview`（`POST /api/gallery/review/start`）接受 `{sessionId, provider, model, systemPrompt, userPrompt, matchField, strategy, headSize, tailSize, concurrency}` 启动审核；`galleryReviewStatus`（`GET /api/gallery/review/status/{sessionId}`）返回 `{status, total, processed, failed, results}`（results 只含 `isMatch=true` 的条目）；`galleryCancelReview`（`POST /api/gallery/review/cancel/{sessionId}`）取消审核；`galleryGeneratePrompt`（`POST /api/gallery/review/gen-prompt`）接受 `{provider, model, judgeTarget}`，调用 LLM 生成审核提示词。审核引擎使用 worker pool 并发处理图片，每张图片经 `analyzeImage` → `resizeImage`（max 1024px）→ `sendVisionRequest`（经 `httptest` 调用 `/v1/chat/completions` 代理转发）→ `ParseReviewResponse` 解析结果。
- **`internal/api/review_presets.go`**：`listReviewPresets`（`GET /api/review-presets`）、`upsertReviewPreset`（`POST /api/review-presets` 创建/更新）、`deleteReviewPreset`（`DELETE /api/review-presets/{id}`）。
- **`internal/config/types.go:265-272`**：`ReviewPreset` 结构体（`ID`/`Name`/`SystemPrompt`/`UserPrompt`）；`Config.ReviewPresets` 字段（`config/types.go:290`）。
- **`internal/config/defaults.go:168-177`**：首次启动（`ReviewPresets == nil`）注入内置"广告审核"预设。
- **`internal/registry/review_presets.go`**：`ListReviewPresets`/`AddReviewPreset`/`UpdateReviewPreset`/`DeleteReviewPreset` CRUD 方法，线程安全（`cfgMu` 保护）。
- **`internal/api/router.go:306-309`**：`/api/review-presets` 路由块；`router.go:377`：`POST /api/gallery/review/gen-prompt` 路由；`router.go:374-377`：review start/status/cancel 路由；`router.go:401`：`pgJSFiles` 含 `gallery-review.js`。

#### 前端架构

- **`web/playground/static-pg/gallery-review.js`**（757 行，独立 IIFE 模块）：提供 `window.renderReviewPanel`（渲染审核面板）、`window.startReviewPolling`（800ms 轮询审核进度）、`window.loadReviewPresets`（加载预设列表）、`window.cleanupReview`（停止轮询）四个全局钩子。面板分配置态（预设选择、提示词生成模型选择、审核目标描述、生成提示词、审核模型选择、策略/并发/首尾参数、启动按钮、保存预设）和运行态（进度条、取消按钮、结果列表、过滤模式切换、重置按钮）。
- **`web/playground/static-pg/gallery-state.js:170-194`**：`reviewState` 对象包含 `active`/`status`/`total`/`processed`/`failed`/`results`/`sessionId`/`promptModelId`/`reviewModelId`/`judgeTarget`/`systemPrompt`/`userPrompt`/`matchField`/`availablePresets`/`selectedPresetId`/`strategy`/`headSize`/`tailSize`/`concurrency`/`reviewMode`/`pollTimer`/`originalIndices`。
- **`web/playground/static-pg/gallery-tree.js:189-192`**：审核面板渲染由 `gallery-review.js` 接管，此处只暴露容器（`<div id="gallery-review-section">`）并调用 `window.renderReviewPanel`。
- **`web/playground/static-pg/gallery.js:30-40,76-77`**：初始化时恢复运行中审核的轮询、加载预设；`cleanupGallery` 时调用 `window.cleanupReview`。
- **`web/playground/static-pg/gallery-fullscreen.js:471-474`**：`toggleReviewItemMark` 在全屏 review 模式下切换当前项的删除标记并前进。
- **`web/static/style.css:1996-2021`**：`.gallery-review-*` 样式类（按钮、输入框、选择框、进度条、结果列表、标签、字段、行等）。
- **`web/static/index.html:137`**：在 `gallery-tree.js` 后插入 `<script src="/gallery-review.js">`。

#### 数据流

1. 用户选择预设或填写审核目标描述 → 可选择"提示词生成模型"调用 `POST /api/gallery/review/gen-prompt` 自动生成 system prompt
2. 用户选择"视觉审核模型"、填写/确认 system prompt、选择策略/并发数
3. 点击 Start Review → `POST /api/gallery/review/start` → 后端启动 worker pool 并发处理图片
4. 前端每 800ms 轮询 `GET /api/gallery/review/status/{sessionId}` 获取进度
5. 完成后结果列表只显示 `isMatch=true` 的条目；用户可切换过滤模式（`reviewMode`）仅显示匹配图片
6. 预设可保存（`POST /api/review-presets`）或删除（`DELETE /api/review-presets/{id}`）

### 配套改动
- `internal/api/compress.go` `skipTypes` 追加 `image/tiff`
- `internal/api/router.go` `pgJSFiles` 数组追加 `gallery.js`
- `web/static/index.html` 增加 Gallery nav-item + `<script src="/gallery.js">`
- `web/static/app.js` 加 `case 'gallery'` / F6 快捷键 / `cleanupGallery` 钩子；2026-07-19 起 F6 与 1-9 quickslot 改为经 `Shortcuts.matchEvent('global.goto-gallery' / 'global.quickslot-cycle-N', e)`；2026-07-23 起 1-9 行为从直接 cycle 改为弹出 quickslot 模型选择 modal（`openQuickSlotModalByOrder(n, true)`，1s 无操作自动关闭）
- `web/static/i18n.js` 加 `gallery` 与 14 个 gallery 专用 key（en/cn）+ 2026-07-19 新增 20 个 `shortcut*` key（en/cn，对应 Settings > Shortcut Settings 弹窗）
- `web/static/style.css` 末尾追加 `.gallery-*` 段（约 35 行）
- `go.mod` 新增直接依赖 `golang.org/x/image v0.44.0`

### 源码锚点
- `web/playground/static-pg/gallery.js`（playground 静态资源，由 embed_playground.go 注入）
- `web/playground/static-pg/gallery-review.js`（AI Review 独立面板模块）
- `internal/gallery/{gallery,zip,tiff,review}.go` + 测试
- `internal/api/gallery.go` + `gallery_session.go`
- `internal/api/gallery_review.go`（审核启动/状态/取消/提示词生成处理器）
- `internal/api/review_presets.go`（ReviewPreset HTTP CRUD）
- `internal/registry/review_presets.go`（ReviewPreset CRUD 数据层）
- `internal/api/router.go::Gallery` 路由块与 `pgJSFiles`
- `internal/api/compress.go::skipTypes`

### 变更维护清单
| 触发变更 | 涉及源码 |
|---|---|
| 修改拖拽/粘贴/打开交互 | `web/playground/static-pg/gallery-io.js`（`onOpenClick`/`onOpenDirBackend`/`onPaste`/`onDrop`/`loadBackendPaths`）、`internal/api/gallery_fs.go`（后端 Picker/列表/删除/剪贴板） |
| 修改磁盘删除/写回操作 | `web/playground/static-pg/gallery-fullscreen.js`（`deleteMarkedFromDisk`/`deleteNodeFromDisk`/`deleteCurrentVideo`）、`internal/api/gallery_fs.go`（`galleryDeleteFs`/`galleryZipWriteback`）、`internal/fsutil/clipboard_*.go` |
| 修改 Gallery modal 交互/焦点 | `web/playground/static-pg/gallery-fullscreen.js`（`deleteItemPrompt`/`deleteZipPrompt`/`deleteCurrentVideo` 自动 focus）、`web/static/app.js`（全局 modal handler 按钮循环） |
| 修改双屏 focus/树面板切换 | `web/playground/static-pg/gallery-layout.js`（`updateFocusUIOnly`/`bindEventsForCurrentLayout` 树面板点击）、`web/playground/static-pg/gallery-tree.js`（`toggleTreePanel` DOM focus 同步） |
| 修改 zip 解压格式或上传限制 | `internal/gallery/zip.go`、`internal/api/gallery.go::galleryListZip`（500MB 上限） |
| 修改 TIFF 转码质量或格式 | `internal/gallery/tiff.go`、`internal/api/gallery.go::galleryConvertTiff` |
| 修改 zip 会话 LRU 容量/过期 | `internal/api/gallery_session.go` |
| 修改自动播放档位 | `web/playground/static-pg/gallery.js::AUTOPLAY_INTERVALS` |
| 修改全屏快捷键集 | `web/playground/static-pg/gallery.js::onFullscreenKey` |
| 修改 Gallery i18n 文案 | `web/static/i18n.js` (`gallery*` 键) |
| Gallery 不再随 playground 编译 | `internal/api/router.go::pgJSFiles` 移除 `gallery.js`、`web/embed_playground.go`、`web/static/index.html` |
| 修改 AI Review 提示词逻辑 | `internal/gallery/review.go`（`ParseReviewResponse`/`PromptGenSystemPrompt`/`DefaultUserPrompt`）、`internal/api/gallery_review.go`（`galleryGeneratePrompt`/`analyzeImage`/`sendVisionRequest`） |
| 修改审核策略/并发 | `internal/api/gallery_review.go`（`galleryStartReview`/`runReview`/`selectReviewIndices`/`selectHeadTailIndices`） |
| 修改审核前端交互 | `web/playground/static-pg/gallery-review.js`（`renderReviewPanel`/`startPolling`/`applyReviewFilter`）、`web/playground/static-pg/gallery-state.js`（`reviewState`）、`web/static/style.css`（`.gallery-review-*`） |
| 修改审核预设 CRUD | `internal/api/review_presets.go`、`internal/registry/review_presets.go`、`internal/config/types.go`（`ReviewPreset`）、`internal/config/defaults.go`（内置预设） |

## 17. Editor 模块（双栏文本编辑器）

Editor 是 playground 构建变体（`-tags playground`）下的双栏文本编辑器，与 Gallery 共享同一个导航按钮（第 1 次点击 → Gallery，第 2 次 → Editor，循环 toggle）。UI 由 `web/playground/static-pg/editor.js` + `editor-state.js` 实现（vanilla JS，`window.renderEditor`/`window.cleanupEditor` 入口）。

### 核心功能
- **双栏编辑**：左右两个独立编辑面板，每面板有独立的文件名、脏标记、打开/保存、原始/预览视图切换、自动换行切换。
- **原始/预览视图**：`raw` 模式显示带行号的 textarea（等宽字体、Tab=2空格、Enter 自动缩进）；`parsed` 模式基于文件扩展名渲染——`.md` 用 `marked` + `DOMPurify`（复用 playground 的 `pgRenderMarkdown`/`pgHighlight`），代码扩展名用 `highlight.js`，其余用 `<pre>` 纯文本。
- **Diff 对比**：`mode: 'diff'` 切换为双栏对齐的对比视图，基于 vendored `diff` 库（`window.Diff.diffLines`/`diffChars`）。支持 `Before→After`（左→右或右→左）方向选择。行类型：`context`/`del`/`add`/`mod`（mod 行有字符级高亮）。头部统计：删除/新增/修改行数 + 字符保留率。自动滚动到首个差异行。纯查看，无接受/拒绝/编辑按钮。
- **查找替换**：Ctrl+F 切换查找栏（大小写敏感、正则、匹配计数 `current/total`、前一/后一、替换、全部替换）。Ctrl+H 快速切换到替换模式。Esc 关闭。F3/Enter 下一匹配；Shift+F3/Shift+Enter 上一匹配。
- **跳转到行**：Ctrl+G 弹出 prompt 跳转到指定行。
- **文件 IO**：`POST /api/editor/open` 后端原生文件选择器（失败回退 `FsApi.pickFiles`）；`POST /api/editor/save` 后端原子写（无 path 时回退浏览器下载）。Ctrl+S 保存当前面板；Ctrl+Shift+S 全部保存。
- **脏追踪**：`content !== original` 时显示黄色脏点 `.ed-dirty-dot`，启用保存按钮。
- **无持久化**：状态在内存中保持（同 `galleryState`），页面切换不丢失。

### 导航 toggle 逻辑
- Gallery 导航按钮和 F6 快捷键共享 `gotoGalleryToggle()`：Gallery → Editor → Gallery 循环。Gallery 页面时按钮显示 t('gallery')，Editor 页面时按钮显示 t('editor')。高亮始终在 Gallery 按钮上。
- 注册于 `web/static/app.js`（`navigateTo` switch、`currentPage` guard、`main-no-scroll`）、`web/static/auth.js`（nav-item click 事件绑定额外判断 `gotoGalleryToggle()`）、`web/static/shortcuts.js`（F6 label 改为 "Toggle Gallery / Editor"）。

### HTTP 接口
| 接口 | 用途 | 鉴权 | Body 上限 |
|---|---|---|---:|
| `POST /api/editor/open` | 原生文件选择器打开文本文件，返回 `{path,name,size,content}` 或 `{cancelled:true}` 或 `{unsupported:true}` | 管理 session | 32 MiB |
| `POST /api/editor/save` | 原子写保存 `{path,content}`，返回 `{ok:true,path}` | 管理 session | 32 MiB |

原生文件选择器复用 `internal/fsutil/open_windows.go` 的 COM `IFileOpenDialog`；取消路径此前可正常返回 `{cancelled:true}`，确认路径因 `IFileDialog::GetResult` 的 vtable 索引错误触发访问违例并闪退，2026-07-25 已修正（索引 26→20）。

### 依赖
- `diff.min.js`（vendored 至 `vendor/diff.min.js`，暴露 `window.Diff`）
- 复用 playground 已有 vendor：`marked.min.js`、`highlight.min.js`、`katex.min.js`、`marked-katex-extension`、`purify.min.js`

### 源码锚点
- `web/playground/static-pg/editor-state.js`：状态对象 + 常量 + 辅助函数
- `web/playground/static-pg/editor.js`：`renderEditor`/`cleanupEditor` + `editorAlignedDiff` + 全部编辑、diff、查找替换逻辑
- `web/playground/static-pg/playground.css`：Editor/Diff 样式（`.ed-*` 前缀）
- `internal/api/editor.go`：后端 handlers `editorOpen`/`editorSave`（由另一 worker 创建）
- `internal/api/router.go`：`/api/editor/*` 路由注册 + `pgJSFiles` 含 `editor-state.js`、`editor.js`
- `web/static/app.js`：`gotoGalleryToggle()`、`navigateTo` switch 新增 `case 'editor'`、cleanup guard、active toggle、main-no-scroll
- `web/static/auth.js`：Gallery nav-item click 改调 `gotoGalleryToggle()`
- `web/static/i18n.js`：`editor` 及所有 Editor UI 字符串
- `web/static/shortcuts.js`：`global.goto-gallery` label 更新
- `web/static/index.html`：`diff.min.js` + `editor-state.js` + `editor.js` 脚本
