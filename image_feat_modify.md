# TinyRouter Playground Image 功能实施方案

> 文档状态：实施前冻结方案
>
> 文档用途：本文件是后续实现、子代理分配、评审、测试和验收的唯一执行上下文。实现开始前，所有参与者必须先阅读本文。本文描述手动 Image Canvas、Prompt Inspire、Batch Project、后台生成、二维结果浏览、项目目录和文件系统恢复的完整落地范围。
>
> 当前阶段：仅建立实施方案，不修改业务代码。代码实施完成后，必须同步更新 `PROJECT_MAP.md` 与 `docs/playground-architecture.md` 的相关条目。

---

## 0. 目标与非目标

### 0.1 目标

将 Playground 的 Image 模式拆成两个互不混淆的交互层：

```text
Image
├── Manual Canvas
│   ├── Generate：直接生成图片
│   ├── Inspire：生成/完善 Prompt
│   └── 单次生成的一维图片历史
└── Batch Project
    ├── 输入批量创作要求
    ├── 辅助模型生成每张图的自然语言描述
    ├── Natural / Tag / JSON 格式转换
    ├── 每张图片独立数量与 Seed 策略
    ├── Prompt × Variant 二维结果模型
    ├── 后台顺序队列、间隔、重试、暂停、停止、继续
    ├── ComfyUI 与远程图片 API 统一适配
    ├── imgs/<project>/ 项目目录
    ├── project.json / YAML 导入导出
    └── 基于文件系统扫描的进度恢复
```

### 0.2 非目标

本次实施不得扩大为以下工作：

- 不改变普通聊天、Auto Chat、Search、Director/Narrator 的交互模型。
- 不把 Manual Canvas 的单次生成改造成后台项目任务。
- 不引入 React、Vue、前端构建系统或数据库。
- 不把 API Key、Authorization Header、Base64 图片写入项目 Manifest。
- 不保证第三方远程服务在“立即停止”后绝对不产生已接受但未返回的生成结果；系统只能保证本地槽位不被错误覆盖，并记录尝试状态。
- 不让无 `project.json` 的旧图片目录自动猜测 Prompt、数量或模型并续跑。
- 不允许批量任务依赖浏览器页面生命周期；页面离开后批量后台任务必须继续。
- 不在本次实施中实现多并发图片生成；第一版固定顺序执行，最大并发为 1。

---

## 1. 当前仓库上下文

### 1.1 技术与运行边界

- Go 1.25+，原生 HTML + Vanilla JS + CSS。
- Playground 仅在 `-tags playground` 变体中嵌入。
- TinyRouter 仅监听 localhost；`/api/*` 由管理 session 保护，`/v1/*` 不经过应用层鉴权。
- 没有数据库。配置使用 YAML，运行时状态通常驻内存，文件写入应采用临时文件 + rename 的原子方式。
- 现有图片默认保存目录由 `config.ResolveImageSaveDir` 解析：默认是 `<configDir>/imgs`，配置相对路径相对 `configDir`，绝对路径直接使用。

### 1.2 Playground 前端加载顺序

`web/static/index.html` 当前模块顺序是运行时契约：

```text
pg-i18n
→ pg-core
→ pg-state
→ pg-markdown
→ pg-request
→ pg-stream
→ pg-comfyui
→ pg-autochat
→ pg-setup
→ pg-director
→ pg-search
→ pg-render
→ pg-ui
→ pg-modal
→ pg-lifecycle
```

全部模块使用浏览器全局变量/函数，没有 ES module、bundler、事件总线或响应式框架。新增 `pg-*.js` 必须同时：

1. 放入 `web/playground/static-pg/`；
2. 加入 `internal/api/router.go` 的 `pgJSFiles` 显式白名单；
3. 在 `web/static/index.html` 按依赖关系加载；
4. 同步 `PROJECT_MAP.md` 的 Playground 文件清单与 Image 任务索引；
5. 同步 `docs/playground-architecture.md` 的模块拓扑、接口、状态和维护清单。

推荐新增模块及加载位置：

```text
pg-i18n
→ pg-core
→ pg-state
→ pg-markdown
→ pg-request
→ pg-stream
→ pg-comfyui
→ pg-image-model       // 图片请求规范化、Manual Canvas 状态辅助
→ pg-image-inspire     // Manual Inspire modal 与辅助模型调用
→ pg-image-batch       // Batch UI、Snapshot、SSE、二维浏览
→ pg-autochat
→ pg-setup
→ pg-director
→ pg-search
→ pg-render
→ pg-ui
→ pg-modal
→ pg-lifecycle
```

如果实现者决定把 `pg-image-model` 或 `pg-image-inspire` 合并到现有模块，必须保持同样的职责边界，并更新本文的文件清单；禁止出现同一逻辑在多个模块复制实现。

### 1.3 现有 Image 数据流

当前手动 Image 模式位于：

- `pg-ui.js:114-177`：`pgUserSend` 处理 Image 输入，为每个窗口追加 user message 和 assistant loading message，然后分派 `pgSendImage` 或 `pgSendComfyImage`。
- `pg-request.js:113-168`：`pgBuildImageBody` 根据协议构建 GPT/xAI/ModelScope body；参数没有复制到 assistant message。
- `pg-stream.js:271-370`：`pgSendImage` 调用 `/v1/images/generations` 或 `/v1/images/edits`，解析 URL/base64/revised prompt，并异步自动保存。
- `pg-comfyui.js:383-468`：浏览器通过 `/api/comfyui/proxy` 提交 `/prompt`，轮询 `/history`，调用 `/view` 转 data URL，再复用消息渲染。
- `pg-render.js:191-410`：Image 结果仍按消息气泡和 `content[]` image parts 渲染；loading 是 waiting 气泡。
- `pg-render.js:488-581`：消息底部 action 包含 Copy/Save/Regenerate/Delete 等通用动作。
- `pg-modal.js:94-127`：旧 Image Preview modal；`pg-modal.js:427-449` 通过当前活动窗口查找 `savedPath`/`savedFilename`。
- `pg-state.js:1-33`：每个窗口有 `messages`、`streaming`、`abortCtrl`；没有独立 Image generation/history 模型。
- `pg-lifecycle.js:66-90`：离开 Playground 会 abort 每个窗口的在途 fetch；Search 有专门的后台继续例外，但 Image 没有。

现有自动保存接口：

- `internal/api/image/register.go:63-67` 注册 `/api/save-image` 与 `/api/image-proxy`。
- `internal/api/image/register.go:69-197` 的 `saveImage` 接收 URL/data URL，写入解析后的图片字节，当前文件名为时间戳随机名，目录为根图片目录。
- `/api/save-image` 当前没有项目、Prompt、槽位、Asset ID 或原子 rename 契约。

### 1.4 现有 ComfyUI 边界

- `internal/api/comfyui/register.go` 的 `/api/comfyui/proxy` 固定访问 `127.0.0.1:{port}`，只允许 GET/POST，限制路径、查询和重定向端口。
- `internal/api/router.go:354-365` 将 ComfyUI 路由置于 32 MiB body limit 的独立 `/api/comfyui` 组，并复用 auth middleware。
- 现有浏览器 ComfyUI 流程不依赖 ComfyUI CORS 或 WebSocket，而是 HTTP `/prompt`、`/history`、`/view`。
- `pg-comfyui.js:423-455` 当前只把 URL 存入消息，丢失 ComfyUI filename/subfolder/type/nodeId/workflow 等批量所需元数据。
- 批量后台实现不得依赖页面里的 `/api/comfyui/proxy`；必须增加后端可调用的 ComfyUI client/adapter，继续复用 loopback、端口、路径和重定向安全约束。

### 1.5 现有后端可参考模式

`internal/textreview/` 已实现后台 Session 的部分模式：

- `session.go`：Session 状态、Snapshot、Pause/Resume/Cancel、并发锁、订阅者。
- `scheduler.go`：后台 dispatcher、暂停等待、Context 取消、事件广播。
- `web/playground/static-pg/editor_textreview_step3.js`：离开页面关闭 SSE、后台会话继续；重新进入先 GET snapshot，再重新订阅 SSE。

Image Batch 必须建立独立 `internal/imagebatch` 包，不能直接复用 Text Review 的 Chapter/Node 数据结构或全局状态。

---

## 2. 产品交互规范

## 2.1 Manual Canvas

Image 模式进入后默认是 Manual Canvas。其特点：单次输入、当前页面生成、画框显示、一维图片历史。

### 2.1.1 右侧按钮

右侧操作区固定为：

```text
┌──────────────┐
│   Generate   │  上方按钮：直接生成
├──────────────┤
│   Inspire    │  下方按钮：辅助生成/完善 Prompt
├──────────────┤
│ Batch Project│  打开批量项目 modal
├──────────────┤
│    Clear     │  清除手动模式历史
└──────────────┘
```

`Generate` 与 `Inspire` 不得混为一个按钮：

- `Generate` 使用当前 Prompt 和图片参数调用图片模型。
- `Inspire` 只调用 Prompt helper model，不直接调用图片模型。
- `Batch Project` 只打开批量项目入口，不直接开始图片生成。
- `Clear` 清空 Manual Canvas 历史，不删除磁盘上的已保存图片。

### 2.1.2 Prompt helper model

侧栏新增：

```text
Prompt helper model
[ provider/text-model ▼ ]
```

字段建议：

```js
cfg.imgPromptModel = ''
```

下拉只允许 `kind === 'text'` 的可用模型；不得显示 image、embedding、ComfyUI 占位模型。该字段保存到现有 Playground 配置 localStorage；Batch 项目创建时复制到项目快照，项目运行后不能被侧栏改动影响。

若未选择 helper model：

- Generate 不受影响；
- Inspire 和 Batch Planning 的辅助步骤点击后显示明确错误；
- 不发出模型为空的请求。

### 2.1.3 Manual Inspire Modal

点击 Inspire 打开 modal，字段：

```text
Prompt helper model
Output format: Natural | Tag | JSON
Current input
[textarea]
[Generate Inspiration] [Cancel]
```

Current input 来源是当前 Prompt input 的草稿；有输入时传入用户要求，无输入时传入“随机生成”意图。

成功后只在 modal 内预览：

```text
Generated Prompt
[结果预览]
[Regenerate] [Apply to Input] [Cancel]
```

默认不自动覆盖输入框。只有用户点击 `Apply to Input` 才写入 Prompt input。

### 2.1.4 三种 Inspire 输出

#### Natural

- 有输入：保留主体和意图，完善主体、动作、环境、构图、光线、风格、质量等。
- 无输入：随机产生完整自然语言图片 Prompt。
- 输出只包含 Prompt，不包含解释、标题或 Markdown 围栏。

#### Tag

- 有输入：提取并补充为逗号分隔标签。
- 无输入：随机产生标签集合。
- 输出只包含标签，不包含解释、编号或 Markdown。

#### JSON

- 有输入：转为结构化图片描述。
- 无输入：随机产生合法 JSON。
- 必须是可解析 JSON，不允许 ```json 围栏。
- 这是图片 Prompt 描述对象，不是完整 OpenAI request body，也不是 ComfyUI workflow。

建议 Schema：

```json
{
  "subject": "an orange cat wearing a space suit",
  "action": "walking across the moon surface",
  "environment": "Earth visible in the background",
  "composition": "wide-angle shot",
  "style": ["cinematic", "science fiction", "digital art"],
  "lighting": "dramatic rim lighting",
  "quality": ["highly detailed", "sharp focus"],
  "negative": ["blurry", "watermark", "text"]
}
```

JSON 结果在 Apply 前必须 `JSON.parse` 成功；发送图片时根据当前协议将 JSON 作为 Prompt 字符串使用，Overlay 同时保留解析对象。

### 2.1.5 Manual Canvas 画框

Image 模式不得渲染 user/assistant Prompt 气泡或 waiting 气泡。使用独立画框状态：

```text
empty → generating → ready
              ├→ canceled
              └→ error
```

生成中：

- Prompt 仍显示在底部 input；
- input `readOnly`，可以复制；
- Generate 变为 Stop；
- 画框使用 CSS shimmer/ring/scan 动画；
- 右下角显示真实 elapsed time；
- 有旧图时保留旧图并加 loading overlay；
- 有 `prefers-reduced-motion` 时停止动画但保留状态文字和计时。

成功后：

- 清空 Prompt input；
- 结果直接显示在画框；
- 底部显示分辨率、大小、格式、保存路径；
- 底部放置 Prompt/Parameters、Copy、Save、Regenerate、Delete；
- 点击图片可打开旧的 zoom/pan modal，但 modal 不再承担主要结果展示职责。

Manual Canvas 一维导航：

- 一个请求返回多个图片时扁平显示为同一历史序列；
- 左右按钮切换图片；
- 显示 `current / total`；
- 当前图片的 Prompt/参数必须随图片切换同步；
- Regenerate 使用当前记录快照，追加新记录，不覆盖旧记录；
- Delete 只删除 Manual 历史中的 asset，不删除磁盘文件。

### 2.1.6 Manual 数据模型

建议每个 Window 增加：

```js
w.image = {
  mode: 'manual',
  phase: 'empty',
  draftPrompt: '',
  submittedPrompt: '',
  activeAssetIndex: -1,
  generations: [],
  activeRequestId: '',
  error: ''
}
```

生成记录：

```js
{
  id,
  status,
  prompt,
  promptFormat: 'natural' | 'tag' | 'json',
  promptObject: null,
  revisedPrompt,
  createdAt,
  completedAt,
  durationMs,
  model,
  protocol,
  endpoint,
  params,
  assets: [
    {
      id,
      url,
      savedPath,
      savedFilename,
      mime,
      width,
      height,
      bytes
    }
  ]
}
```

自动保存回写必须通过 `generationId + assetId` 定位，禁止再通过“当前活动窗口 + URL 反查”作为唯一机制。

### 2.1.7 Manual Regenerate 修复

当前 `pgRegenerate` 会走通用 `pgSend`，Image 模式必须修正：

```text
当前 generation 快照
→ 恢复 Prompt 和 params
→ 新建 generation
→ 走当前 Image protocol adapter
→ 成功后追加新结果
→ activeAsset 切到最新结果
```

不得删除目标后的所有消息，不得发送 `/v1/chat/completions` 作为图片重生成请求。

---

## 2.2 Batch Project

Batch Project 是独立的项目工作流，不复用 Manual Canvas 的输入发送状态。

### 2.2.1 入口

右侧点击 `Batch Project` 打开 modal。项目创建分三步：

```text
Step 1 Planning
→ Step 2 Format Conversion
→ Step 3 Review & Start
```

### 2.2.2 Step 1 Planning

字段：

- Project name：必填。
- Prompt helper model：默认继承侧栏，可覆盖。
- Image model：必填。
- Image requirements：批量创作要求。
- 输出格式：Natural / Tag / JSON。
- 可选默认 Negative Prompt。
- 可选默认每张图片数量。

用户输入的是创作要求，而不是某一张图片的最终 Prompt，例如：

```text
生成一组冬季幻想图片，包括雪地森林、冰雪城堡、雪狐和空中城市。
整体风格统一，但每张图主体、构图和环境要有明显区别。
```

### 2.2.3 两阶段 Prompt Pipeline

批量规划必须严格分两阶段：

```text
用户批量要求
→ Helper model 返回结构化的每张图自然语言描述
→ 用户编辑/删除/排序/设数量
→ 将每张 naturalPrompt 转为 Natural / Tag / JSON
→ 用户 Review
→ 冻结项目
→ 开始图片生成
```

禁止让模型第一次直接输出 Tag/JSON 作为唯一事实来源；必须保留 `naturalPrompt`，否则无法稳定重新转换格式或审查中间语义。

第一阶段严格 JSON Schema：

```json
{
  "title": "Winter Fantasy Collection",
  "items": [
    {
      "id": "p0001",
      "title": "Snowy Forest",
      "naturalPrompt": "A vast snowy forest illuminated by pale blue moonlight...",
      "negativePrompt": "blurry, low quality, watermark",
      "quantity": 4
    }
  ]
}
```

校验：

- `items` 必须是非空数组；
- `id` 在项目内唯一；
- `naturalPrompt` 非空；
- `quantity` 为正整数并受配置上限保护；
- helper model 不得返回额外不可解析的说明包裹 JSON；
- 解析失败时显示原始结果供诊断，但不得进入 Start。

### 2.2.4 Format Conversion

转换针对每个 `naturalPrompt` 单独执行：

- Natural：`finalPrompt = naturalPrompt`；
- Tag：输出逗号分隔标签；
- JSON：输出合法图片 Prompt JSON；
- 转换结果可编辑、可单项重新生成、可恢复 naturalPrompt；
- JSON 转换失败时该项状态为 `invalid`，禁止 Start；
- 转换阶段不修改原始 `naturalPrompt`。

建议 Batch item 内保存：

```js
{
  id,
  title,
  naturalPrompt,
  negativePrompt,
  finalFormat: 'natural' | 'tag' | 'json',
  finalPrompt,
  finalPromptObject,
  quantity,
  variants: []
}
```

### 2.2.5 Review & Start

Start 前必须显示：

```text
Prompt count: N
Total variants: Σ quantity
Maximum attempts: total variants × (1 + maxRetries)
Image model / protocol
Helper model
Interval
Retry policy
Seed policy
Project directory
```

点击 Start 后冻结以下字段并写入 Manifest：

- 项目名、slug、projectID；
- helper model；
- 原始批量要求；
- Prompt 规划结果；
- final format；
- 每个 item 的 naturalPrompt/finalPrompt/negativePrompt/quantity；
- Image model/protocol/endpoint/参数；
- interval、maxRetries、retryDelay、backoff、onError；
- Seed mode/baseSeed；
- schemaVersion。

运行中的项目不允许从 UI 直接修改 Prompt 或数量。修改应创建新版本/新项目；失败 Variant 可以单独 Retry。

---

## 3. Batch 二维结果模型

### 3.1 坐标定义

批量结果是二维结构：

```text
横轴：Prompt
纵轴：同一个 Prompt 的 Variant

P001: V001 V002 ... V010
P002: V001 V002 ... V006
P003: V001 V002 ... V004
```

导航：

- 左/右：切换不同 Prompt；
- 上/下：切换当前 Prompt 的 Variant；
- Prompt thumbnail：跳到 Prompt；
- Variant thumbnail：跳到当前 Prompt 的 Variant；
- 键盘左右/上下与按钮语义一致；
- 边界按钮 disabled，不循环，除非后续产品决定加入循环选项。

画框显示：

```text
Prompt 02 / 24 · Variant 07 / 10
```

### 3.2 调度游标与浏览游标分离

必须区分：

```text
schedulerCursor = 后台正在生成的 P08/V02
viewerCursor    = 用户正在查看的 P02/V07
```

用户浏览、打开 Prompt Overlay、切换图片不得改变后台调度。UI 同时显示：

```text
Batch progress: 74 / 240
Viewing: Prompt 02 / 24 · Variant 07 / 10
```

### 3.3 Variant 与 Seed

默认每个 Prompt 的 quantity 建议 4，允许用户调整；第一版 UI 可限制 1–100，后端仍需配置上限，防止无限任务。

Seed mode：

```text
random
increment
fixed-base-plus-offset
provider-controlled
```

确定性 Seed 示例：

```text
baseSeed = 420000
P001/V001 → 420000
P001/V002 → 420001
P002/V001 → 420010  // 使用全局槽位偏移，避免不同 Prompt 重复
```

协议差异：

- ComfyUI：修改 KSampler/KSamplerAdvanced seed；
- ModelScope：使用现有 `imgSeed`；
- GPT/xAI：只有上游明确支持时才发送 seed；
- 不支持可控 seed 时每次仍独立执行，但记录 `seed: null` 和 `seedMode: provider-controlled`，不得伪造“仅 Seed 不同”。

批量每个 Variant 固定 `n=1`，避免一个请求返回多张导致独立重试、保存和进度难以对应。

---

## 4. Batch 后台任务架构

### 4.1 任务必须在后端运行

当前 `cleanupPlayground()` 会中止 Image fetch，因此 Batch 不得依赖：

```text
w.streaming
w.abortCtrl
pgSendImage
pgSendComfyImage
```

页面职责：创建项目、渲染 Snapshot、控制 Pause/Resume/Stop、连接/断开 SSE、浏览结果。

后端职责：规划（若采用后台规划 API）、顺序调度、调用协议适配器、写图片、更新 Manifest、文件系统 reconcile、广播事件。

页面离开：

```text
关闭 SSE / polling
不调用 batch stop
不取消后端 Batch Manager
```

重新进入：

```text
GET Snapshot
→ 文件系统 reconcile
→ 渲染二维结果
→ 建立 SSE
```

### 4.2 推荐包结构

```text
internal/imagebatch/
├── types.go              // Project/Prompt/Variant/Asset/BatchConfig schema
├── manager.go            // project store、生命周期、控制方法
├── scheduler.go          // 顺序 dispatch、interval、retry、pause/stop
├── generator.go          // ImageGenerator 接口与结果归一化
├── remote_generator.go   // GPT/xAI/ModelScope 适配入口
├── comfy_generator.go    // ComfyUI 后端 REST client/adapter
├── project_store.go      // project.json 读写、原子更新
├── reconciler.go         // imgs/<project>/ 文件扫描与槽位修复
├── events.go             // snapshot/event subscribers
├── paths.go              // slug、安全相对路径、项目目录
└── *_test.go

internal/api/imagebatch/
├── register.go           // 路由与 Handler
├── planning.go           // plan/transform API
├── projects.go           // create/list/get/import/export
├── controls.go           // pause/resume/stop/retry
├── events.go             // SSE
└── register_test.go
```

如果实现者选择不同文件拆分，必须保留上述职责，不得把所有逻辑堆进单个 `register.go`。

### 4.3 核心 Go 接口契约

计划实现以下接口，具体命名可在代码评审时微调，但字段语义必须保持：

```go
type ImageGenerator interface {
    Generate(ctx context.Context, req ImageGenerationRequest) (ImageGenerationResult, error)
}

type ImageGenerationRequest struct {
    ProjectID       string
    PromptID        string
    VariantID       string
    Model           string
    Protocol        string
    Endpoint        string
    Prompt          string
    PromptFormat    string
    NegativePrompt  string
    Params          map[string]any
    Seed            *int64
}

type ImageGenerationResult struct {
    Assets         []GeneratedAsset
    RevisedPrompt  string
    Provider       string
    Key            string
    Duration       time.Duration
    RawMeta        map[string]any // 只允许小型、脱敏、非凭据元数据
}
```

`ImageGenerator` 不负责决定重试、项目路径或 UI 状态；Scheduler 负责这些策略。

### 4.4 远程 API 适配

远程 GPT/xAI/ModelScope 必须尽量复用现有 Proxy/Rotation/Provider/Usage 链路，不在 Batch 中复制 Key 轮换和 Provider 重试。

实现时优先顺序：

1. 为 Proxy 抽出可复用的内部服务调用接口；
2. 若无法安全抽取，可通过受控内部 request adapter 调用现有 Handler，但必须保留 `X-TinyRouter-Source: playground-batch` 的 Usage 分流并正确传播 Context；
3. 禁止 Batch Manager 自己读取 config 中的 API Key；
4. Batch 层 `maxRetries` 是 Proxy 最终失败后的外层重试，不取代现有 Key/Provider 重试。

每次 Batch attempt 必须有 `projectID/promptID/variantID/attempt` 关联，便于 Usage、日志和恢复诊断。

### 4.5 ComfyUI 后端适配

后台 ComfyUI adapter 必须：

1. 固定 loopback `127.0.0.1:{port}`；
2. 只允许 GET/POST；
3. 校验 path/query；
4. 重定向必须保留原 loopback 端口；
5. 支持 `/prompt`、`/history/{promptID}`、`/view`；
6. 保存 ComfyUI prompt ID；
7. 保存输出的 nodeId/filename/subfolder/type；
8. 读取图片字节后交给 ProjectWriter，禁止先转成巨大 Base64 放进 Manifest；
9. 尽量支持 ComfyUI queue cancel；不支持时标记为 best-effort；
10. 继承 Batch Context 取消和超时。

浏览器端现有 `pg-comfyui.js` 仍可服务 Manual Canvas；Batch adapter 是独立后端实现，二者不能互相依赖。

### 4.6 生命周期状态

Project：

```text
draft
→ planning
→ converting
→ review
→ queued
→ running
├── paused
├── stopping
├── completed
├── completed_with_errors
├── failed
└── canceled
```

Variant：

```text
pending
→ running
├── retry_wait
├── succeeded
├── failed
├── interrupted
└── canceled
```

Pause：

- 不再启动新的 Variant；
- 当前请求允许完成；
- retry_wait 的倒计时停止；
- 已完成结果正常写入并更新 Manifest。

Stop after current：

- 当前请求允许完成；
- 当前请求完成后不再取下一个 Variant；
- 未开始槽位保持 pending。

Cancel immediately：

- 调用 adapter cancel/Context cancel；
- 删除 `.part`；
- 当前 Variant 标记 interrupted；
- 未开始槽位标记 canceled 或保持 pending，必须由 API 参数明确；
- Resume 时 interrupted 槽位重新执行，已存在有效文件的槽位跳过。

进程退出：

- 当前运行任务标记 interrupted；
- 默认不在进程重启后自动消耗远程额度；
- 用户点击 Resume 后恢复；
- 若未来支持 auto-resume，必须是显式配置且有幂等检查。

### 4.7 间隔和重试

第一版最大并发固定为 1。任务顺序：

```text
P001/V001 → P001/V002 → ... → P002/V001 → ...
```

`intervalMs` 定义为相邻请求开始时间的最小间隔：

```text
nextStart >= previousStart + intervalMs
```

若上一请求耗时已经超过 interval，下一请求可立即开始；若上一请求很快结束，则等待剩余间隔。

`maxRetries = 2` 表示首次尝试 + 两次额外尝试，共最多 3 次。

建议错误分类：

| 错误 | 默认处理 |
|---|---|
| 网络超时、连接断开 | Batch 重试 |
| 500/502/503 | Batch 重试 |
| 429 | 使用 Retry-After/退避后重试 |
| ComfyUI 暂时不可用 | Batch 重试 |
| 请求格式错误 | 不重试，Variant failed |
| Workflow 无效、模型不存在 | 不重试，Project 可继续 |
| 内容审核拒绝 | 默认不重试 |
| Prompt 缺失 | 不重试 |

retryBackoff 支持：

```text
fixed
exponential
exponential-jitter
```

默认建议 `retryDelayMs=10000`、`exponential-jitter`。所有等待使用可取消 Timer，Pause/Stop 必须能解除等待。

---

## 5. Project 文件与恢复

### 5.1 目录布局

使用 `config.ResolveImageSaveDir` 得到根图片目录：

```text
imgs/
└── winter-fantasy-collection/
    ├── project.json
    ├── p0001/
    │   ├── v0001.png
    │   ├── v0002.png
    │   └── v0003.png
    ├── p0002/
    │   ├── v0001.png
    │   └── v0002.png
    └── p0003/
        └── v0001.png
```

槽位命名固定为 `p####/v####.<ext>`，不使用完整 Prompt 做文件名，避免 Windows 非法字符、路径过长、跨语言和信息泄露。

### 5.2 Project name / slug

Manifest 同时保存：

```text
displayName：用户输入名称
slug：安全目录名
projectId：系统唯一 ID
```

slug 规则：

- 删除/替换路径分隔符、控制字符、`..`；
- 处理 Windows 保留名；
- 限制长度；
- 保留 unicode 兼容性策略；
- 不允许跨出 image root；
- 同名不静默覆盖。

同名项目 UI：

```text
[打开现有项目] [创建带后缀的新项目] [取消]
```

后端必须再次校验，不能只依赖前端。

### 5.3 原子图片写入

每个 Variant 成功流程：

```text
调用 Generator
→ 写入 p0001/v0001.png.part
→ 校验扩展名、大小、可解码
→ rename 到 p0001/v0001.png
→ 更新 project.json
→ 广播 variant-completed
```

`.part` 不计入完成数。已存在的最终槽位文件不能被新 attempt 覆盖，除非用户明确执行“重新生成并替换”且后端提供单独语义。

### 5.4 文件系统 reconcile

`GET project`、`Resume`、`List projects` 可触发 reconcile，需避免每个 SSE event 都全量扫描。

判定规则：

```text
最终槽位文件存在 + 大小 > 0 + 可解码 → succeeded
最终文件不存在 → pending 或 interrupted
.part 文件存在 → interrupted，清理或重试
未知文件 → orphan，不自动归入任务
```

文件系统是图片“是否已完成”的最终事实；`project.json` 保存 Prompt、参数、Seed、attempt、路径和状态上下文；运行时内存只保存活跃调度状态。

没有 `project.json` 的目录只显示为 `Unmanaged Image Folder`，可以查看文件，但不得猜测任务并自动续跑。

### 5.5 Manifest Schema

运行时权威文件为 `project.json`，YAML 仅作为导入导出格式。

建议结构：

```json
{
  "schemaVersion": 1,
  "projectId": "imgproj_01JXYZ",
  "displayName": "winter fantasy collection",
  "slug": "winter-fantasy-collection",
  "status": "paused",
  "createdAt": "2026-08-04T12:00:00Z",
  "updatedAt": "2026-08-04T12:15:00Z",
  "promptPlan": {
    "helperModel": "provider/text-model",
    "sourceRequirement": "生成一组冬季幻想主题图片",
    "outputFormat": "json",
    "planVersion": 1
  },
  "imageConfig": {
    "model": "provider/image-model",
    "protocol": "comfyui",
    "endpoint": "generations",
    "params": {}
  },
  "batchConfig": {
    "intervalMs": 3000,
    "maxRetries": 2,
    "retryDelayMs": 10000,
    "retryBackoff": "exponential-jitter",
    "onError": "continue",
    "seedMode": "increment",
    "baseSeed": 420000
  },
  "stats": {
    "promptCount": 24,
    "totalVariants": 240,
    "completed": 43,
    "running": 0,
    "pending": 197,
    "failed": 0,
    "interrupted": 0,
    "canceled": 0
  },
  "prompts": [
    {
      "id": "p0001",
      "index": 1,
      "title": "Snowy Forest",
      "naturalPrompt": "A vast snowy forest illuminated by pale blue moonlight",
      "finalPrompt": "...",
      "finalPromptObject": null,
      "negativePrompt": "blurry, low quality, watermark",
      "quantity": 10,
      "variants": [
        {
          "id": "p0001-v0001",
          "index": 1,
          "status": "succeeded",
          "seed": 420000,
          "attempt": 1,
          "relativePath": "p0001/v0001.png",
          "width": 1024,
          "height": 1024,
          "bytes": 1843200,
          "mime": "image/png",
          "durationMs": 42000,
          "createdAt": "2026-08-04T12:01:00Z"
        }
      ]
    }
  ]
}
```

不得写入：

- API Key、Authorization Header；
- Base64 图片；
- 巨大完整 upstream response；
- 含隐私或凭据的 debug body。

ComfyUI 可保存小型来源元数据：

```json
{
  "comfyui": {
    "templateId": "template-001",
    "promptId": "comfy-prompt-id",
    "nodeId": "9",
    "filename": "ComfyUI_00001.png",
    "subfolder": "",
    "type": "output"
  }
}
```

### 5.6 Manifest 原子更新

`project.json` 更新必须：

1. 在项目目录外或同目录生成临时文件；
2. 完整 JSON encode + flush/close；
3. rename 替换正式文件；
4. 失败时保留旧 Manifest 并返回错误；
5. 加项目级锁，避免 Scheduler、reconcile、控制 API 并发覆盖。

YAML 导出使用 `gopkg.in/yaml.v3`；导入必须先验证 schema、相对路径和槽位状态，再写入受控项目目录。

---

## 6. API 契约
所有 `/api/image-batches/*` 路由必须满足以下约束：

- 复用管理 auth middleware；
- 建议在 `internal/api/router.go` 中置于通用 `/api` 1 MiB body-limit 组之外，单独挂载受保护的 `/api/image-batches` 路由组；请求 body 上限建议 32 MiB，避免 JSON/YAML 项目导入和 Prompt 规划被通用限制截断；
- 使用 JSON 错误信封 `{"error":"..."}`；
- 对 projectID/promptID/variantID 做路径字符校验；
- 不接受任意绝对文件路径；
- 图片资产通过 projectID + asset/slot ID 映射到受控相对路径。

建议路由：

```text
POST /api/image-batches/plan
POST /api/image-batches/transform

POST /api/image-batches
GET  /api/image-batches
POST /api/image-batches/import

GET  /api/image-batches/{projectID}
GET  /api/image-batches/{projectID}/events
GET  /api/image-batches/{projectID}/manifest?format=json|yaml
GET  /api/image-batches/{projectID}/assets/{assetID}

POST /api/image-batches/{projectID}/pause
POST /api/image-batches/{projectID}/resume
POST /api/image-batches/{projectID}/stop
POST /api/image-batches/{projectID}/retry/{promptID}/{variantID}
```

### 6.1 `POST /plan`

请求：

```json
{
  "helperModel": "provider/text-model",
  "requirements": "生成一组冬季幻想主题图片",
  "defaultNegativePrompt": "blurry, low quality",
  "defaultQuantity": 4
}
```

响应必须是经过后端 JSON 校验的结构化自然语言计划：

```json
{
  "title": "Winter Fantasy Collection",
  "items": []
}
```

该接口只规划，不启动图片任务。

### 6.2 `POST /transform`

请求：

```json
{
  "helperModel": "provider/text-model",
  "format": "tag",
  "items": []
}
```

响应包含每项 `finalPrompt`，JSON 格式额外包含 `finalPromptObject`。转换 API 不改变 `naturalPrompt`。

### 6.3 `POST /api/image-batches`

请求必须包含已审核冻结的 Prompt 列表、Image model/protocol、params、batchConfig。后端重新校验所有字段，创建目录和 Manifest，然后启动后台 Scheduler。

响应：

```json
{
  "projectId": "imgproj_01JXYZ",
  "snapshot": {}
}
```

### 6.4 Snapshot

`GET project` 返回可直接渲染的完整状态，至少包含：

- 项目元信息和 status；
- prompt items 与 variants；
- stats；
- scheduler cursor；
- 当前 error/retry 信息；
- lastUpdated；
- project directory 的逻辑路径，不暴露不必要的系统绝对路径。

### 6.5 SSE

事件建议：

```text
project-status
planning-started
planning-completed
transform-completed
variant-started
variant-retry-wait
variant-completed
variant-failed
variant-interrupted
project-reconciled
project-completed
project-error
```

SSE 不是事实来源；客户端断线后必须先 GET Snapshot，再重新订阅，不能只依赖错过的事件。

### 6.6 控制接口

- Pause：幂等；已 paused/completed 时返回当前 Snapshot。
- Resume：先 reconcile，再启动未完成槽位；有效图片槽位跳过。
- Stop：请求体明确 `mode: "after-current" | "immediate"`。
- Retry：只允许对 failed/interrupted 槽位执行，必须保留原 attempt 记录或增加 attempt counter。

---

## 7. 前端模块与实现任务

### 7.1 `pg-core.js`

负责：

- 增加 `imgPromptModel` 默认值；
- 增加 Manual Image state schema 的默认/迁移版本；
- 增加 Batch UI 配置常量与 localStorage key（只保存草稿/最近项目 ID，不保存 Base64）；
- 增加 Prompt format 常量：`natural`、`tag`、`json`。

### 7.2 `pg-state.js`

负责：

- 为每个 Window 增加 `image` Manual state；
- 增加全局 `pgState.imageBatch`：当前项目 ID、Snapshot、SSE、viewer cursor、connection status；
- 页面重建时保留 Batch project ID，不把后台运行状态绑定到 DOM；
- 旧 Image message 数据只做兼容读取，不继续作为新 Image UI 的事实来源。

### 7.3 `pg-image-model.js`

负责：

- Manual generation record/asset schema；
- GPT/xAI/ModelScope/ComfyUI 结果归一化；
- generationId/assetId 关联；
- params snapshot；
- autosave 回写；
- metadata dimensions/bytes/mime 获取；
- stale response/delete guard。

### 7.4 `pg-image-inspire.js`

负责：

- Inspire modal；
- helper model 选择/校验；
- Natural/Tag/JSON 选择；
- 输入有/无两种 Prompt pipeline；
- 非流式 helper request；
- JSON 解析、错误显示、预览、Apply/Regenerate；
- 不触发图片生成。

推荐 helper system prompt 必须约束：

```text
Return only the requested output.
For JSON, return valid JSON without Markdown fences.
Preserve the user's subject and intent.
Do not include explanations.
```

### 7.5 `pg-image-batch.js`

负责：

- Batch Create modal 三步状态机；
- Plan API 调用；
- natural item table 编辑/删除/排序/quantity；
- Transform API 调用；
- final Prompt review；
- Start/Save/Cancel；
- Batch Snapshot 渲染；
- SSE connect/reconnect；
- Pause/Resume/Stop/Retry；
- Prompt 横向、Variant 纵向 viewer cursor；
- 离开页面只关闭订阅，不取消任务；
- 重新进入先 Snapshot + reconcile，再 SSE。

### 7.6 现有模块修改

`pg-ui.js`：

- Image 模式右侧按钮改为 Generate/Inspire/Batch/Clear；
- Image input draft/readOnly/clear 规则；
- 不再为 Manual Image 生成 user/assistant bubble 作为主渲染；
- Batch 入口和当前模式状态协调。

`pg-render.js`：

- `pgState.mode === 'image'` 时委托 Manual Canvas renderer；
- 不影响 normal/search/autochat renderer；
- 不再显示 Image waiting/Prompt bubble；
- 兼容旧消息时显示 Legacy Result，但不伪造 Prompt/params。

`pg-stream.js`：

- 保留现有普通 Image API 发送能力，但改为写入 generation record；
- 自动保存通过稳定 asset ID 回写；
- Image Regenerate 不得回到 `pgSend`。

`pg-comfyui.js`：

- Manual 继续使用浏览器同源 proxy；
- 结果元数据尽量补全；
- Batch 后端 adapter 不在此实现。

`pg-modal.js`：

- 增加 Prompt & Parameters overlay；
- 旧 Image Preview 保留为 zoom/pan 辅助；
- Copy/Save 从消息 action 迁移为 Canvas footer 入口；
- metadata 查找使用 generation/asset 引用，不依赖 active window。

`pg-lifecycle.js`：

- 离开时停止 Manual fetch 与正常请求仍按现有规则；
- 若 Batch project active，只关闭 Batch SSE/polling，不调用 batch stop；
- 重新渲染后恢复 Batch subscription。

`pg-i18n.js`：

- en/cn 同步增加所有 Manual Inspire、Batch、状态、错误、控制、Prompt format、恢复文案。

`playground.css`：

- `.pg-image-canvas`、loading、footer、二维 arrows/thumbnails、Inspire modal、Batch modal、progress/status、responsive mobile；
- 使用现有语义 Token；
- 支持 `prefers-reduced-motion`；
- 不用 inline style 承担动态状态颜色，状态使用 class。

`web/static/index.html`、`internal/api/router.go`：

- 新增模块加入正确加载顺序和白名单。

---

## 8. 子代理分配方案

实现时按以下独立工作流分配。每个子代理必须只修改负责的文件范围，跳过 formatter、lint、项目级测试；最终由主代理统一验证。跨工作流的接口以本文第 4.3、6、7 节为准。

### Agent A — Image Domain Lead

**目标文件：** `internal/imagebatch/types.go`、`generator.go`、`events.go`。

**任务：**

- 定义 Project/Prompt/Variant/Asset/BatchConfig/Status schema；
- 定义 `ImageGenerator` request/result contract；
- 定义 Snapshot 和 SSE event JSON；
- 定义 schema validation；
- 不实现 HTTP handler、不写前端。

**交付条件：** Go 类型可被 Manager/API/测试共同引用；字段 JSON tag 与本文 Manifest/API 契约一致。

### Agent B — Batch Manager / Scheduler

**目标文件：** `internal/imagebatch/manager.go`、`scheduler.go`、控制相关测试。

**任务：**

- 内存 Manager 生命周期；
- 顺序 scheduler，最大并发 1；
- interval、retry、backoff、pause/resume/stop；
- Context 取消；
- 调度 cursor 与 viewer cursor 分离；
- 事件广播；
- 不负责路径解析和图片字节写盘。

**依赖：** Agent A 的类型 contract。

**交付条件：** 可用 fake generator 测试成功、失败重试、429/可重试错误、Pause、Stop after current、Immediate Stop、Resume。

### Agent C — Project Store / Filesystem Reconciler

**目标文件：** `internal/imagebatch/project_store.go`、`reconciler.go`、`paths.go`、测试；必要时 `internal/config/paths.go` 测试。

**任务：**

- Resolve image root；
- 安全 slug/project ID/相对路径；
- 创建项目目录；
- `.part` + decode check + atomic rename；
- project.json 原子保存；
- JSON/YAML 导入导出；
- 扫描 p####/v#### 文件、识别 orphan/未完成/损坏文件；
- 同名项目保护。

**依赖：** Agent A 的 Manifest schema。

**交付条件：** 路径穿越、Windows 保留名、同名、损坏图片、`.part`、中断恢复和并发写 Manifest 均有确定性测试。

### Agent D — Generator Adapters

**目标文件：** `internal/imagebatch/remote_generator.go`、`comfy_generator.go`，必要时对 `internal/proxy` 做最小接口抽取。

**任务：**

- GPT/xAI/ModelScope 统一结果 adapter；
- ComfyUI 后端 REST client；
- Context cancel、timeout、prompt ID、filename/subfolder/type/nodeId；
- 使用现有 Proxy/Rotation，不读取 API Key；
- Usage source 标记为 `playground-batch`；
- 不实现 Scheduler。

**依赖：** Agent A 类型、现有 `internal/proxy` 和 `internal/api/comfyui` 安全约束。

**交付条件：** fake remote/ComfyUI server 能验证 success、malformed response、timeout、cancel、image bytes、source metadata；不绕过 loopback/SSRF 契约。

### Agent E — Batch HTTP API

**目标文件：** `internal/api/imagebatch/`、`internal/api/router.go`、`internal/api/apibase/deps.go`（仅必要字段）。

**任务：**

- plan/transform/create/list/get/import/export；
- events SSE；
- pause/resume/stop/retry；
- auth/body limit；
- projectID/relative asset 安全校验；
- 将 Manager、Store、Generator 注入，不使用包级可变全局。

**依赖：** Agent A/B/C/D 的 public interfaces；如并行开发，先按本文接口用 fake 实现。

**交付条件：** handler tests 覆盖非法 JSON、空 helper/image model、无效 format、路径穿越、未知 project/variant、SSE snapshot/reconnect、控制幂等。

### Agent F — Manual Canvas + Inspire Frontend

**目标文件：** `web/playground/static-pg/pg-core.js`、`pg-state.js`、`pg-ui.js`、新增 `pg-image-model.js`、`pg-image-inspire.js`、`pg-render.js`、`pg-modal.js`、`playground.css`、`pg-i18n.js`。

**任务：**

- Manual Canvas 画框状态和一维历史；
- Generate/Inspire/Batch/Clear 右侧按钮；
- Inspire 三格式 modal；
- helper model filter；
- Prompt snapshot、JSON parse、Apply；
- image regenerate 正确走图片协议；
- assetId 回写和 footer 操作；
- 不实现 Batch 后台 UI，可保留 Batch 入口。

**交付条件：** 浏览器可证明不显示 Prompt/waiting bubble，生成期间 input locked，成功清空，Stop/Error 保留，左右历史和 metadata 正确。

### Agent G — Batch Frontend

**目标文件：** 新增 `web/playground/static-pg/pg-image-batch.js`，必要时 `pg-ui.js`、`pg-lifecycle.js`、`playground.css`、`pg-i18n.js` 的 Batch 部分。

**任务：**

- 三步 Batch modal；
- Plan/Transform/Review；
- 每项 quantity；
- interval/retry/seed；
- 2D Prompt × Variant viewer；
- scheduler/viewer cursor 分离；
- Snapshot + SSE reconnect；
- 离开/重新进入；
- Pause/Resume/Stop/Retry；
- 项目目录和进度状态展示。

**依赖：** Agent E API contract；前端先使用 fixture 可独立开发。

**交付条件：** fixture API 下完整走完 Plan→Transform→Review→Start→Pause→Resume→二维浏览；SSE 断开后 Snapshot 恢复。

### Agent H — Security / Reviewer

**类型：** 只读审查，不直接修改业务实现，除非主代理另行分配修复。

**审查范围：**

- slug/path traversal；
- 任意文件读取；
- Manifest import 绕过；
- API Key/Header/Prompt secret 泄漏；
- ComfyUI loopback/redirect/port；
- SVG/图片类型；
- SSE session isolation；
- stale autosave、删除后异步回写；
- Stop/retry duplicate slot。

**交付条件：** 输出按严重级别排序的证据报告；所有 High/Critical 必须在验收前关闭。

### Agent I — Documentation / Integration

**目标文件：** `PROJECT_MAP.md`、`docs/playground-architecture.md`、`web/static/index.html`、`internal/api/router.go` 加载清单和本方案相关文档。

**任务：**

- 记录新增包、API、前端模块、状态、Manifest、生命周期；
- 更新源码锚点和“最后核对”行；
- 验证 `pgJSFiles` 与 index 顺序一致；
- 不改业务逻辑。

---

## 9. 实施顺序与合并规则

### Phase 0 — Contract Freeze

主代理确认：

- Agent A 的 Go types；
- API JSON；
- Manifest schemaVersion；
- statuses；
- asset path contract；
- SSE event names；
- 前端 Batch snapshot shape。

未冻结 contract 前不得让多个代理各自发明字段。

### Phase 1 — Backend Foundation

并行：A、C。

完成后由主代理检查类型与 Manifest 是否一致。

### Phase 2 — Scheduler / Adapters / API

并行：B、D、E；使用 Phase 1 contract。E 可以先用 fake Manager/Generator，但不得修改已冻结字段。

### Phase 3 — Manual Frontend

F 实现 Manual Canvas + Inspire。此阶段不依赖 Batch API，可先用现有 `/v1/chat/completions` helper request。

### Phase 4 — Batch Frontend

G 接入真实 API；先 fixture smoke，再 real backend smoke。

### Phase 5 — Review / Docs / Integration

H 审查全部后端和前端；I 同步地图和架构文档；主代理修复审查问题。

### 文件冲突规则

- A/B/C/D 不共享同一实现文件；跨包只依赖公开 contract。
- F/G 若都要改 `pg-ui.js`/`playground.css`/`pg-i18n.js`，先按职责切分：F 负责 Manual/Inspire，G 负责 Batch；冲突时主代理按本文合并，不接受任意一方覆盖另一方。
- 所有代理禁止重排无关代码、全文件格式化或修改非本任务模块。
- 每个代理完成后只报告：改动文件、实现的 contract、未解决风险；最终验证集中执行。

---

## 10. 验收标准

## 10.1 Manual Canvas

- [ ] Image 模式不显示 Prompt user bubble。
- [ ] Image 模式不显示 waiting bubble。
- [ ] 右侧 Generate 上方、Inspire 下方，Batch Project 独立入口。
- [ ] Generate 使用当前 Image protocol；普通聊天请求不被触发。
- [ ] 生成期间 Prompt 留在 input，input readOnly 且可复制。
- [ ] 生成期间按钮变为 Stop，画框有 CSS loading 和 elapsed time。
- [ ] 有旧图时生成中保留旧图并加 overlay。
- [ ] Stop/Error 后 Prompt 保留，成功后清空。
- [ ] 图片完成后直接显示在画框，底部显示 resolution/size/format/path。
- [ ] Footer 有 Prompt & Parameters、Copy、Save、Regenerate、Delete。
- [ ] Regenerate 走图片 endpoint，追加新 generation，不删除旧图。
- [ ] Delete 不删除磁盘文件；异步 autosave 不会重新修改已删除记录。
- [ ] 左右切换多图历史时 Prompt/params/path 同步。
- [ ] Manual 页面刷新/切模式不产生重复请求或 stale DOM 异常。

## 10.2 Manual Inspire

- [ ] helper model 下拉只显示 text models。
- [ ] 无 helper model 时阻止请求并显示明确提示。
- [ ] 有输入时 Natural/Tag/JSON 均按用户意图完善。
- [ ] 无输入时三种格式均可随机生成。
- [ ] Natural 无解释文本；Tag 无 Markdown/编号；JSON 可 JSON.parse。
- [ ] Inspire 只更新 modal 预览，不直接生成图片。
- [ ] 只有 Apply 才写回 input。
- [ ] JSON 非法时 Apply disabled，并显示可重试错误。
- [ ] 双语文案存在且主题样式一致。

## 10.3 Batch Planning

- [ ] Batch Project 入口打开三步 modal。
- [ ] 项目名必填、非法路径名被拒绝或安全归一化。
- [ ] helper model 与 image model 可独立选择。
- [ ] Plan 阶段返回并校验结构化自然语言列表。
- [ ] 用户可以编辑、删除、排序 item，修改每项 quantity。
- [ ] Transform 由 naturalPrompt 转 Natural/Tag/JSON，不丢失 naturalPrompt。
- [ ] 每个 finalPrompt 可预览和编辑。
- [ ] JSON finalPrompt 可解析；非法 item 阻止 Start。
- [ ] Start 前显示 Prompt 数、总 Variant 数、最大尝试数、参数、间隔、重试。
- [ ] Start 后 Prompt、数量、参数快照冻结。

## 10.4 Batch Scheduler

- [ ] 最大并发固定为 1，按 Prompt/Variant 稳定顺序运行。
- [ ] `intervalMs` 按请求开始时间限制频率。
- [ ] `maxRetries` 语义为额外重试次数，计数准确。
- [ ] 可重试错误重试，不可重试错误不无限重试。
- [ ] retry delay/backoff 可取消。
- [ ] Pause 不启动新 Variant，当前任务安全完成。
- [ ] Stop after current 语义正确。
- [ ] Immediate Stop 标记 interrupted，删除 `.part`。
- [ ] Resume 跳过有效已完成槽位，从第一个未完成槽位继续。
- [ ] 一个 Variant 失败不会隐式删除其他 Prompt 的结果。
- [ ] scheduler cursor 与 viewer cursor 独立。
- [ ] 页面离开不取消 Batch；后台仍生成和写盘。
- [ ] 进程重启默认不自动消耗远程额度；用户 Resume 后恢复。

## 10.5 协议适配

- [ ] GPT/xAI/ModelScope 使用现有 Proxy/Rotation/Usage 链路，不读取 API Key。
- [ ] 每个 Batch attempt 带 project/prompt/variant/attempt 关联。
- [ ] ModelScope 异步任务可完成、超时、失败并正确更新 Variant。
- [ ] ComfyUI 后端 adapter 固定 loopback，端口/path/query/redirect 校验正确。
- [ ] ComfyUI 保存 promptId、filename、subfolder、type、nodeId 等小型 metadata。
- [ ] ComfyUI cancel best-effort，不影响 Manifest 幂等性。
- [ ] 上游响应解析失败不会把空文件标记为成功。

## 10.6 文件系统与恢复

- [ ] 默认目录为 `ResolveImageSaveDir` 解析的 imgs。
- [ ] 项目目录为安全 slug，不会覆盖同名项目。
- [ ] 槽位使用 `p####/v####.<ext>`。
- [ ] 图片先写 `.part`，校验后原子 rename。
- [ ] `.part` 不计完成；损坏/空文件不计完成。
- [ ] 打开/Resume project 会扫描子目录并 reconcile。
- [ ] 有效最终文件优先于 Manifest 的错误状态。
- [ ] 未知 orphan 文件不自动绑定任务。
- [ ] 没有 Manifest 的目录只读查看，不能自动猜测续跑。
- [ ] `project.json` 原子写入，崩溃不会产生半个 JSON。
- [ ] YAML 导入导出通过 schema validation，不接受绝对路径和 `..`。
- [ ] Manifest 不包含 Key、Header、Base64 图片或巨大 raw response。
- [ ] Asset API 不能通过任意路径读取文件。

## 10.7 二维 Batch UI

- [ ] 左右切 Prompt，上下切 Variant。
- [ ] Prompt thumbnail 与 Variant thumbnail 可直接定位。
- [ ] 状态图例至少有 pending/running/retry/succeeded/failed/interrupted/canceled。
- [ ] 后台进度和当前查看位置同时显示。
- [ ] 切换图片时 Prompt/negative/seed/params/path/duration 同步。
- [ ] 生成中的 slot、失败 slot、已完成 slot 的按钮语义清晰。
- [ ] 移动端布局不裁切图片和控制按钮。
- [ ] SSE 断线后 Snapshot 重建，不能依赖丢失事件。

## 10.8 文档与构建

- [ ] `node --check` 通过所有修改的 Playground JS。
- [ ] Go 修改文件通过 `gofmt`。
- [ ] `pgJSFiles`、`index.html`、磁盘文件一致。
- [ ] `PROJECT_MAP.md` 已记录新增包/文件/API。
- [ ] `docs/playground-architecture.md` 已记录 Image Canvas、Inspire、Batch、后台生命周期、Manifest 和源码锚点。
- [ ] `go test ./...` 通过。
- [ ] `go build -tags playground` 通过。

---

## 11. 测试与验证矩阵

### 11.1 Go 单元测试

至少覆盖：

| 区域 | 必测行为 |
|---|---|
| types/validation | format、quantity、retry、slug、schema invalid |
| scheduler | 顺序、interval、retry、pause、stop、resume、cancel |
| store | atomic JSON、并发更新、旧 Manifest 恢复 |
| reconciler | final file、`.part`、空文件、损坏图片、orphan、missing slot |
| paths | `..`、分隔符、保留名、同名项目、相对路径 |
| adapters | remote response、ModelScope task、ComfyUI history/view/cancel |
| API | invalid JSON、unknown ID、auth、SSE、control idempotency |
| image save | project slot、extension allowlist、不能覆盖、原子写入 |

建议命令：

```powershell
go test ./internal/imagebatch/...
go test ./internal/api/imagebatch/...
go test ./internal/api/image/...
go test ./internal/api/comfyui/...
go test ./internal/api/...
```

### 11.2 前端静态检查

```powershell
node --check web/playground/static-pg/pg-core.js
node --check web/playground/static-pg/pg-state.js
node --check web/playground/static-pg/pg-image-model.js
node --check web/playground/static-pg/pg-image-inspire.js
node --check web/playground/static-pg/pg-image-batch.js
node --check web/playground/static-pg/pg-render.js
node --check web/playground/static-pg/pg-ui.js
node --check web/playground/static-pg/pg-modal.js
node --check web/playground/static-pg/pg-stream.js
node --check web/playground/static-pg/pg-comfyui.js
```

### 11.3 浏览器 Manual smoke

使用 `-tags playground` 二进制和临时配置：

1. 打开 Playground → Image → Manual；
2. 确认 Generate/Inspire/Batch/Clear 按钮布局；
3. 选择 text helper model；
4. 有输入调用 Inspire Natural/Tag/JSON，检查预览和 Apply；
5. 无输入重复检查随机生成；
6. 输入 Prompt，点击 Generate；
7. 确认无 Prompt bubble/waiting bubble，输入框锁定，画框动画和计时存在；
8. 完成后确认输入清空、图片直接出现、footer metadata 正确；
9. 再生成，检查左右历史；
10. Regenerate 检查请求是 Image endpoint；
11. Delete 后检查历史移除但磁盘文件保留；
12. 手动切换到 normal/search/autochat，确认其他模式无回归。

### 11.4 浏览器 Batch smoke

使用 deterministic mock helper/image backend 或测试 Provider：

1. 创建 Batch Project；
2. helper model 生成结构化自然语言计划；
3. 编辑/删除/排序 item，修改数量；
4. 转为 Natural、Tag、JSON，制造非法 JSON 并确认 Start 被阻止；
5. Review 显示总任务数和最大尝试数；
6. Start；
7. 确认项目目录、`project.json`、`p####/v####` 文件产生；
8. Pause 后不启动新槽位；
9. Resume 后跳过有效槽位；
10. Stop after current 与 Immediate Stop 分别验证；
11. 离开 Playground，确认后台继续；
12. 重新进入，先 Snapshot/reconcile 后继续 SSE；
13. 删除或损坏某个文件，执行 reconcile，确认槽位状态恢复为 pending/interrupted；
14. 通过左右/上下浏览二维结果，确认 scheduler cursor 不受影响；
15. 导出 JSON/YAML，再导入到新项目，确认路径隔离和 schema 校验。

### 11.5 ComfyUI smoke

在本机可用 ComfyUI 时：

1. 连接 Manual ComfyUI，确认原有流程仍可生成；
2. Batch 使用 ComfyUI adapter，确认浏览器离开后仍能生成；
3. 检查 promptId/history/view/filename metadata；
4. Pause/Stop/Resume；
5. 检查项目目录文件和 Manifest；
6. 断开 ComfyUI，验证 retry 与失败分类；
7. 恢复 ComfyUI 后 Resume，已完成槽位必须跳过。

### 11.6 构建验证

```powershell
gofmt -w <modified-go-files>
go test ./...
go build -tags playground -o tinyrouter-image-test.exe .
```

使用临时 config，禁止触碰用户现有 `config.yaml`、`state.yaml`、`imgs`。验证结束清理临时 exe、配置和输出目录。

---

## 12. 风险与处理决策

### R1：浏览器离开页面取消请求

**决策：** Manual 保持页面级行为；Batch 完全后端化，页面只订阅。

### R2：远程请求已被上游接受但本地 Stop

**决策：** attempt 记录 + 幂等槽位 + 不覆盖最终文件；不声称绝对取消。

### R3：ComfyUI 输出已生成但 TinyRouter 尚未写入

**决策：** 保存 promptId/source metadata；`.part`/orphan 诊断；Resume 按最终项目槽位文件判定。

### R4：Manifest 与文件状态不一致

**决策：** reconcile 时有效最终图片优先；Manifest 作为上下文，不作为图片是否落盘的唯一事实。

### R5：localStorage 被 Base64 图片撑爆

**决策：** Manual 新历史不把大 Base64 复制进额外 batch 数据；Batch Manifest 只保存相对路径和 metadata；必要时增加资产 API。

### R6：同名项目覆盖

**决策：** displayName/slug/projectID 分离；后端同名保护；不静默覆盖。

### R7：Prompt helper 返回格式不稳定

**决策：** system prompt + 后端/前端双重 parse/schema validate；非法结果不可 Start/Apply；保留脱敏原始错误供诊断。

### R8：批量配置修改影响运行任务

**决策：** Start 时冻结快照；侧栏配置后续变化不影响项目；修改创建新版本/新项目。

### R9：共享全局 JS 函数冲突

**决策：** 新函数使用 `pgImage*` / `pgBatch*` 命名空间前缀；禁止使用通用 `send`、`render`、`state` 等全局短名。

### R10：跨代理接口漂移

**决策：** Phase 0 冻结 Agent A contract；所有 API/Manifest/SSE 字段以本文为准；主代理在 Phase 2 合并前做 contract diff。

---

## 13. 完成定义 Definition of Done

只有同时满足以下条件，才可宣布本功能完成：

1. Manual Canvas、Manual Inspire、Batch Planning、Batch Scheduler、二维 Viewer、项目文件恢复全部实现；
2. GPT/xAI/ModelScope/ComfyUI 至少有统一 adapter 入口，ComfyUI 后台路径不依赖浏览器；
3. 页面离开后 Batch 继续，重新进入可 Snapshot + SSE 恢复；
4. Pause/Resume/Stop/Retry/间隔/Seed/数量语义经过测试；
5. `project.json` 原子写入，文件扫描能修复中断进度；
6. 所有安全检查通过，无任意路径读取、凭据泄漏、loopback 绕过或 stale autosave；
7. Manual 和 Batch 交互互不污染，普通聊天/Search/Auto Chat 无回归；
8. Go 单元测试、前端 `node --check`、浏览器 smoke、playground build 全部通过；
9. `PROJECT_MAP.md` 与 `docs/playground-architecture.md` 已同步真实源码；
10. 最终评审报告列出实际验证命令和结果，不以“代码已写”代替验收证据。

---

## 14. 实施时的主代理执行清单

```text
[ ] 阅读本文与 AGENTS.md / PROJECT_MAP.md §24
[ ] Phase 0 冻结 Go/API/Manifest/SSE contract
[ ] 分配 A-I 子代理并发送各自文件边界
[ ] 合并 Agent A/C 基础 contract
[ ] 合并 Scheduler/Adapter/API，并先跑后端测试
[ ] 实现 Manual Canvas/Inspire，并进行浏览器 smoke
[ ] 实现 Batch modal/二维 viewer/SSE，并接真实 API
[ ] 运行 Security reviewer，修复 High/Critical
[ ] 运行完整 Go/JS/build/browser 验证
[ ] 更新 PROJECT_MAP.md 和 docs/playground-architecture.md
[ ] 检查未留下临时文件、mock、TODO、占位实现
[ ] 输出实际文件、API、测试和已知限制
```

本文件本身是实施计划，不代替代码或架构事实文档。实现完成后，事实以源码、测试和同步后的 `docs/playground-architecture.md` 为准。
