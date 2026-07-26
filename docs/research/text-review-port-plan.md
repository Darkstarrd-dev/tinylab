# AI 文本审核 · 移植实施计划

> 状态：待执行确认。本文件为执行基线，子代理按 P1→P8 顺序接手。
> 来源：移植 `Z:\Playground\novelhelper\frontend\src\pages\m1-import`（四步：导入→切分→AI 清理→审校）至 TinyRouter。
> 最后核对：2026-07-25，仓库工作区 `main` @ `206be68` + 未提交 UI 改动（usage.js/theme.js/chart.umd.js/style.css/app.js/index.html）。

---

## 0. 已锁定的架构决策

1. **后端编排，前端接收器**：调度器、并发池、SSE 流式累积全在后端进程内。前端订阅 SSE。切页后后端任务继续，切回先 `GET /sessions/{id}` 快照再重连 SSE，已完成章直接显示、在途章继续流式。
2. **节点 = 单个 provider 的一个 model**（一组 key 由该 provider 配置提供）。用户设该节点的并发槽位数。多节点组成处理池，**总并发 = Σ 各节点并发**。
3. **并发自动回退（永久回写）**：某节点并发请求被拒（代理返回 502 "all keys exhausted"/"no available keys"）→ 该节点并发槽位 `Target-1`（最低 0），并**立即回写 `config.yaml` 的 `TextReviewNode.Concurrency`/`Enabled`**；槽位归 0 → `Enabled=false`。
4. **复用代理栈**：不重造 key 轮转/重试/熔断/配额锁。每章一次内部 `ChatCompletions` 调用，代理栈处理 per-key 失败、cooldown-wait、4xx 透传。只有"整节点耗尽 → 502"上升到编排层做槽位回退。
5. **会话驻内存**：满足"切页不丢"。重启 tinyrouter 不保留（不做 state.yaml 持久化，用户已确认默认不做）。

## 1. 失败判定规则（关键细化，基于代理当前行为）

代理栈现状（已核对 `forward_request.go`/`forward_retry.go`/`passthrough_test.go`/`handler.go`）：

| 代理返回 | 含义 | 编排层动作 |
|---|---|---|
| `200` + SSE 流 + `[DONE]` | 成功 | `status=completed`，`cleaned=累积文本` |
| `502` + body 含 `all keys exhausted`/`no available keys` | 整节点所有 key 耗尽（已 cooldown-wait 仍失败） | **节点 `Target-1`，回写 config；章节 `retry++` 重排队（≤3）；`Target==0` → `Enabled=false`** |
| `4xx` 透传（400/401/403 请求形状错误，key 不锁） | 单次请求错误（如 prompt 超长、模型不支持） | 章节标记 `failed` + 错误消息；**不回退节点**；不重排 |
| `200` 已提交后中途断流 | 上游中途断开 | 章节标记 `failed`（保留已累积部分供查看）；**不回退节点**；可手动重处理 |

判定实现：`streamingResponseWriter` 捕获 `WriteHeader` 的状态码 + body。`rec.Code==502` 且 body 含关键字才触发回退；否则按错误码分类。

## 2. 后端设计

### 2.1 配置扩展（`internal/config/types.go` + `defaults.go`）

```go
// TextReviewNode 处理池中的一个节点 = 一个 provider 的一个 model + 该节点的并发配置。
type TextReviewNode struct {
    ID          string `yaml:"id" json:"id"`                    // 自动生成或 "providerId/modelId"
    ProviderID  string `yaml:"providerId" json:"providerId"`
    ModelID     string `yaml:"modelId" json:"modelId"`
    Concurrency int    `yaml:"concurrency" json:"concurrency"`  // 用户设；运行中自动回退并回写
    Enabled     bool   `yaml:"enabled" json:"enabled"`
}

// SplitPattern 章节检测正则（持久化形，regex 为字符串）。
type SplitPattern struct {
    Key    string `yaml:"key" json:"key"`
    Label  string `yaml:"label" json:"label"`
    Regex  string `yaml:"regex" json:"regex"`
    Flags  string `yaml:"flags,omitempty" json:"flags,omitempty"`
    Builtin bool  `yaml:"builtin,omitempty" json:"builtin,omitempty"`
}

type TextReviewConfig struct {
    Nodes         []TextReviewNode `yaml:"nodes,omitempty" json:"nodes,omitempty"`
    SplitPatterns []SplitPattern   `yaml:"splitPatterns,omitempty" json:"splitPatterns,omitempty"`
    // 默认清理 prompt 直接复用 ReviewPreset（按 ID 引用），不在此处冗余存文本。
    DefaultPromptPresetID string `yaml:"defaultPromptPresetId,omitempty" json:"defaultPromptPresetId,omitempty"`
}
```

`Config` 末尾追加：`TextReview TextReviewConfig `yaml:"textReview,omitempty" json:"textReview,omitempty"``
`defaults.go`：`cfg.TextReview` 为空时注入内置 `SplitPattern`（移植 `split.ts::DEFAULT_SPLIT_PATTERNS`）。

### 2.2 Registry CRUD（`internal/registry`）

仿 `ReviewPreset` 的 `List/Add/Update/DeleteReviewPreset` 加四个方法：
`ListTextReviewNodes / AddTextReviewNode / UpdateTextReviewNode(id, patch) / DeleteTextReviewNode(id)`。
`UpdateTextReviewNode` 即回退回写入口（运行时调用 → `SaveConfig`）。

### 2.3 新包 `internal/textreview`

```
internal/textreview/
  session.go      // Session/Chapter/NodeRuntime 结构 + sessions sync.Map + CRUD
  scheduler.go     // dispatcher + worker 调度循环 + pause/resume/stop
  proxy_call.go    // streamingResponseWriter + 调 d.ProxyHandler.ChatCompletions + SSE 解析
  events.go        // SSE 订阅 mux（subs 列表 + 广播）
  prompt.go        // 内置默认清理 prompt 常量
```

**核心结构**：

```go
type Chapter struct {
    Index   int    `json:"index"`
    Title   string `json:"title"`
    Content string `json:"content"`          // 原文（不可变）
    Cleaned string `json:"cleaned"`          // 流式累积，可变
    Status  string `json:"status"`           // pending|processing|completed|failed
    Error   string `json:"error,omitempty"`
    NodeID  string `json:"nodeId,omitempty"` // 处理该章的节点
    Retry   int    `json:"retry"`
}

type NodeRuntime struct {
    config.TextReviewNode
    Active int `json:"active"` // 当前在用槽位
    Target int `json:"target"` // 当前允许槽位（回退用，初始=Concurrency）
}

type Session struct {
    ID, FileName string
    RawText      string
    Chapters     []Chapter
    Nodes        []NodeRuntime
    SystemPrompt string
    Status       string // idle|running|paused|completed
    mu           sync.Mutex
    cancel       context.CancelFunc
    done         chan struct{}
    subs         []*subscriber
}

var sessions sync.Map // map[string]*Session
```

**调度循环**（`scheduler.go`）：
- dispatcher 从待处理章队列取章 → 找 `active < target && enabled` 节点 → 起 worker goroutine。
- worker：`acquire(node)` → `proxyCall(ctx, node, chapter, systemPrompt)` →
  - 成功：`status=completed`，广播 `{chapterIdx, status:"completed"}`。
  - 502 耗尽：`release(node)` → `rampDown(node)`（`Target--`，回写 config；`Target==0`→`enabled=false`）→ 章节 `retry++`（≤3）重排队，否则 `failed`。
  - 4xx 透传：`status=failed` + 错误消息，不回退。
  - 中途断流：`status=failed`（保留已累积 `Cleaned`），不回退。
- pause = dispatcher 停止取新章（在途继续）；resume = 恢复；stop = `cancel()`（在途 abort）。

**`streamingResponseWriter`**（`proxy_call.go`）：
- 实现 `http.ResponseWriter` + `http.Flusher`。
- `WriteHeader(code)` 记录状态码。
- 每次 `Write` + `Flush` 把 SSE 字节投递到该 worker 的 `chunkCh`。
- 调用：`req := httptest.NewRequest("POST", "/v1/chat/completions", body); req.Header.Set("Content-Type","application/json"); d.ProxyHandler.ChatCompletions(rec, req)`（仿 `internal/api/gallery/register.go:1106`）。
- worker 从 `chunkCh` 读 SSE 行，解析 `data: {...}` → `delta.content` → `chapter.Cleaned += delta` → 广播事件。
- `[DONE]` 或 rec 完成时收尾判定。

**SSE mux**（`events.go`）：
- 每 sub 一个 `chan Event`（缓冲）。广播向所有非满 channel 非阻塞发送（满则丢旧，靠快照补全）。
- sub 退出（断连）从切片移除。
- Event JSON：`{type:"chunk"|"status"|"node", chapterIdx, delta?, status?, node?}`。

### 2.4 HTTP 端点（新包 `internal/api/textreview`，仿 `editor` 注册到 `/api/text-review/*` 并绕过 1MB body 限制）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/text-review/nodes` | 列出节点池 |
| POST | `/api/text-review/nodes` | 增/改节点 |
| DELETE | `/api/text-review/nodes/{id}` | 删节点 |
| GET | `/api/text-review/split-patterns` | 列出章节检测模式 |
| POST | `/api/text-review/split-patterns` | 增/改模式 |
| DELETE | `/api/text-review/split-patterns/{key}` | 删模式 |
| GET | `/api/text-review/prompt-default` | 内置默认清理 prompt |
| POST | `/api/text-review/sessions` | 新建会话（body: fileName/rawText/chapters/systemPrompt/nodeIds[]）→ 返回 sessionId，立即启动 |
| GET | `/api/text-review/sessions/{id}` | 全量快照（所有章当前 Cleaned/Status + 节点运行态）—— 切回页面先取这个 |
| GET | `/api/text-review/sessions/{id}/events` | SSE 订阅（live deltas） |
| POST | `/api/text-review/sessions/{id}/pause` `/resume` `/stop` | 控制 |
| POST | `/api/text-review/sessions/{id}/chapters/{idx}/reprocess` | Step4 单章重处理（复用同一调度路径，单章） |

**注**：Step2 正则切分纯前端（移植 `split.ts`）；Step2 AI 拆分走前端直调 `/v1/chat/completions`（一次性，无需跨页持久）。只有 Step3 清理（长任务）走后端编排。

## 3. 前端设计（新页面，与 Editor/Gallery 平级）

### 3.1 文件结构（`web/playground/static-pg/`）

| 文件 | 职责 |
|---|---|
| `tr-split.js` | 移植 `split.ts` 为纯 JS（`window.TR.splitChapters`/`detectChapterPattern`/`applyTitleTemplate` 等），无依赖 |
| `tr-diff.js` | 基于 `editorAlignedDiff` 扩展：行级 accept/reject/edit 按钮 + `applyLineDecisions`（移植 `alignedDiff.ts`） |
| `tr-state.js` | 会话本地态（sessionId、行决策、finalText 缓存）；行决策存 localStorage（UI 索引，切页不丢） |
| `text-review.js` | 入口：`renderTextReview/cleanupTextReview` + 四步向导编排 + 导航注册 |
| `text-review-clean.js` | Step3 面板：节点池 UI + 启动 + SSE 订阅 + 章节_tabs + 实时窗口 + 切页重连 |
| `text-review-review.js` | Step4 面板：逐章 diff + 行决策 + 批量 + 单章重处理 + 导出（复用 `/api/editor/save`） |

注册清单（须同步三处）：
1. `web/playground/static-pg/` 新增文件；
2. `internal/api/router.go` `pgJSFiles` 白名单追加 6 个文件；
3. `web/static/index.html` 加载顺序（在 `editor.js` 之后）；
4. `web/static/app.js` 导航按钮（新增第三态，与 Gallery/Editor 同级）—— **协调点：app.js 当前有未提交改动，执行时基于 HEAD + 该改动合入**；
5. `web/static/i18n.js` + `pg-i18n.js` 补文案；
6. `playground.css` 补样式（复用 `.gallery-review-*` token）。

### 3.2 切页不丢进度接收协议

1. 进入页面：若有 `trState.sessionId` → `GET /sessions/{id}` 拿快照渲染 → `new EventSource('/sessions/{id}/events')`。
2. SSE 事件增量更新对应章 DOM（chunk → 追加 `Cleaned`；status → 切换标签）。
3. 离开页面：`cleanupTextReview` 只 `eventSource.close()`，**不取消后端任务**。
4. 回来：从步骤 1 重新接。已完成章用快照渲染，在途章用快照已累积部分 + 继续 SSE。
5. 行决策（Step4）存 localStorage，切页不丢；finalText 客户端计算（diff + decisions → `applyLineDecisions`）。

## 4. 分阶段实施（执行顺序）

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P1** 配置基座 | `TextReviewConfig`/`SplitPattern` 类型 + `defaults.go` 内置模式 + Registry CRUD + `/api/text-review/nodes` & `/split-patterns` 端点 + `router.go` 注册 | curl CRUD 节点/模式，`config.yaml` 落盘 |
| **P2** 核心引擎 | `internal/textreview` 包：Session/NodeRuntime/调度器/`streamingResponseWriter`/SSE mux + `/sessions` POST/GET + `/events` SSE + pause/resume/stop | mock 上游跑通单章流式 + 多章并发 + 切页重连续传 |
| **P3** 并发回退 | 502 耗尽 → `Target-1` + 回写 config + `enabled=false`；4xx/中途断流分类不回退 | 429 上游验证槽位回退与 disable；400 上游验证不回退 |
| **P4** 前端算法 | `tr-split.js`（`split.ts` 全量移植）+ `tr-diff.js`（`applyLineDecisions`） | console 跑 demo 文本切分 + 决策应用 |
| **P5** 前端向导骨架 + Step1/2 | `text-review.js` + Step1（复用 `/api/editor/open`）+ Step2（正则 + AI 拆分走 `/v1/chat/completions`） | 浏览器跑通导入→切分 |
| **P6** Step3 面板 | `text-review-clean.js`：节点池 UI + 启动 + SSE 订阅 + 实时窗口 + 章节 tabs + 切页重连 | 浏览器跑通清理 + 切页回来看到进度 |
| **P7** Step4 面板 | `text-review-review.js`：diff + 行决策 + 批量 + 单章重处理 + 导出 | 跑通审核→导出 |
| **P8** 收尾 | i18n + 样式 + `playground-architecture.md` + `PROJECT_MAP.md` 同步 + `go build -tags playground` | 全流程 smoke |

## 5. 协调与风险

- **协调点**：`web/static/app.js` 导航按钮（与进行中的 usage.js 改动同文件，执行时基于最新 HEAD）。
- **风险**：浏览器后台 tab fetch 限制——本计划后端编排，前端只订阅 SSE，**不受此限**（后端任务在进程内持续）。EventSource 断连自动重连。
- **风险**：大文本单章超 token 上限——保留 `batchChars` 概念（可选，P2 后评估），超长章前端预切分或后端分段发送拼接。

## 6. 移植来源对照表

| novelhelper | TinyRouter 落点 |
|---|---|
| `alignedDiff.ts`（`diff` npm） | 复用 `editor.js::editorAlignedDiff` + `vendor/diff.min.js`；`applyLineDecisions` 移植到 `tr-diff.js` |
| `split.ts`（纯 TS） | 移植到 `tr-split.js`（纯 JS） |
| `CleanScheduler` + `circuitBreaker` + 节点池 | `internal/textreview/scheduler.go`（精简：代理栈已处理 per-key 失败，仅做"节点级 502 回退"） |
| `streamSingleChapter` SSE | `proxy_call.go` 内部 `ChatCompletions` + `streamingResponseWriter` |
| `useCleanRun` 编排 | 后端 `scheduler.go` |
| 节点池 UI / 实时窗口 / 调试日志 | `text-review-clean.js`（实时窗口 = SSE chunk 渲染） |
| `DiffView` + 行决策 | `tr-diff.js` + `text-review-review.js` |
| `ImportSession` 持久化 | 后端 `Session`（内存） + 前端 localStorage（行决策） |
| `ReviewPreset` prompt 管理 | 复用现有 `ReviewPreset` CRUD（已含 SystemPrompt/UserPrompt） |