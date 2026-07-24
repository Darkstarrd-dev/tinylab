# PROJECT_MAP.md — TinyRouter 模块地图

> **项目入口文档。** 此文件是 TinyRouter 的"活地图"：项目启动 / 接手 / 评审时首先读取此文件以了解模块分布与文件归属。
>
> **同步约束（必须遵守）：** 项目推进过程中，凡涉及以下变更，必须**同一次改动中同步更新本文件**对应条目，使本文件始终代表项目的真实结构：
> - 新增 / 删除 / 重命名 任意源码文件或目录
> - 新增 / 移除 `internal/` 子包
> - 新增 / 移除 build tag 或构建变体
> - 新增 / 移除 前端页面或 `web/static`、`web/playground` 资产
> - 模块职责发生迁移（文件/目录改属）
> - 新增 / 移除 `docs/` 下的事实基线文档
>
> 不得让本文件与代码现状脱节。`AGENTS.md` / `CLAUDE.md` 中的模块说明已下放至此，两者仅保留约束与设计决策并引用本文件；若与本文件冲突，**以本文件为准**。

---

## 基本面

| 项 | 值 |
|---|---|
| 模块路径 | `github.com/tinyrouter/tinyrouter` |
| Go 版本 | 1.25.0（见 `go.mod`） |
| 项目版本 | 见 `internal/app/version.go` 的 `Version` 常量（唯一来源） |
| HTTP 路由 | `github.com/go-chi/chi/v5` |
| 配置 | `gopkg.in/yaml.v3` → `config.yaml` / `state.yaml` |
| 前端 | 原生 HTML + vanilla JS + CSS，经 `embed.FS` 内嵌 |
| 数据库 | 无（纯内存 + YAML 文件） |
| 部署形态 | 单二进制，仅监听 localhost |

---

## 1. 根目录源码（`/*.go`）

入口与宿主循环。所有 `host_*.go` 通过 build tag 互斥编译，决定进程以 console / 托盘 / WebView 哪种形态常驻。

| 文件 | build tag | 职责 |
|---|---|---|
| `main.go` | — | 进程入口：解析 `-config` flag，调用 `internal/app.New()` 构建组件，`app.Run(runHostLoop)` 进入宿主循环 |
| `host_loop.go` | — | `runHostLoopConsole`：共享的 OS 信号（SIGINT/SIGTERM）+ UI 关停阻塞循环，被各 host 变体复用 |
| `host_console.go` | `!tray && !webview` | 默认变体：`runHostLoop` 包裹 `runHostLoopConsole` |
| `host_tray_windows.go` | `tray && windows` | 系统托盘常驻（`fyne.io/systray`），内嵌 favicon，右键菜单"打开控制台/退出"，调用 `addWebviewMenuItem` |
| `host_tray_other.go` | `tray && !windows` | Linux/macOS 托盘回退为 console 行为 |
| `host_webview_windows.go` | `tray && webview && windows` | WebView2 原生独立窗口（`jchv/go-webview2`，纯 Go 无 CGO），菜单多一项"打开独立窗口" |
| `host_webview_other.go` | `tray && webview && !windows` | 非 Windows 的 webview stub：`addWebviewMenuItem` 返回 nil |
| `host_webview_stub.go` | `tray && windows && !webview` | webview tag 关闭时 `addWebviewMenuItem` no-op，保持托盘菜单降级 |

> 注：`version.go` 与 `server_manager.go` **不在根目录**，分别位于 `internal/app/version.go` 与 `internal/app/server_manager.go`。

---

## 2. `internal/app/` — 进程生命周期与组件装配

进程级"胶水层"：装配所有运行时组件、管理优雅启停、HTTP 服务器端口热切换、单实例锁、按 build tag 决定启动时是否开浏览器。

| 文件 | build tag | 职责 |
|---|---|---|
| `app.go` | — | `New()` 装配全部运行时组件（`buildComponents`），owns 生命周期与 graceful shutdown；绑定 `a.proxyHandler.SetQuickSlotOnlyProvider(a.apiRouter.QuickSlotOnly)` |
| `host.go` | — | `HostContext`：把 logger / ConsoleURL / ServerManager / Quit 传递给 host 循环 |
| `server_manager.go` | — | `ServerManager`：HTTP 服务器优雅重启，端口热切换无需重启进程；`net.Listen` + `Serve` 模式，集成端口冲突检测与解决 |
| `version.go` | — | `Version` 常量（项目版本号唯一来源） |
| `browser.go` | — | `OpenBrowser`：跨平台打开默认浏览器（委托 `internal/fsutil.OpenInBrowser`） |
| `browser_console.go` | `!tray` | console 构建：启动时自动开浏览器 |
| `browser_tray.go` | `tray` | tray/webview 构建：启动时不开浏览器 |
| `exit_console.go` | `!tray` | console 构建：`forceExitIfNeeded()` no-op，Shutdown 后正常返回 |
| `exit_tray.go` | `tray` | tray/webview 构建：`forceExitIfNeeded()` 调用 `os.Exit(0)` 防止僵尸进程 |
| `lock_windows.go` | `windows` | `LockFileEx` 单实例文件锁 |
| `lock_unix.go` | `!windows` | `unix.Flock` 单实例文件锁 |
| `log_file.go` | — | `writeErrorLog`/`clearErrorLog`：启动错误日志文件（`tinyrouter-error.log`），每次启动覆盖 |
| `port_conflict.go` | — | `resolvePortConflict`/`isAddrInUse`：端口冲突检测与解决，kill 另一个 TinyRouter 实例 |
| `port_owner_windows.go` | `windows` | `identifyPortOwner`：通过 PowerShell 查询占用端口的进程 PID/名称/路径 |
| `port_owner_unix.go` | `!windows` | `identifyPortOwner`：通过 lsof/ss 查询占用端口的进程 |
| `error_feedback_console.go` | `!tray` | `FeedbackFatalError`/`feedbackPortConflict`：console 变体 stderr 输出 + 日志文件 |
| `error_feedback_windows.go` | `tray && windows` | `FeedbackFatalError`/`feedbackPortConflict`：Windows tray 变体 MessageBox 弹窗 + 日志文件 |
| `error_feedback_other.go` | `tray && !windows` | `FeedbackFatalError`/`feedbackPortConflict`：非 Windows tray 变体 stderr 输出 + 日志文件 |
| `server_manager_test.go` | — | 测试 |
| `log_file_test.go` | — | 测试（writeErrorLog 覆盖/清除/格式） |
| `port_conflict_test.go` | — | 测试（isAddrInUse 表驱动） |
| `port_owner_test.go` | — | 测试（identifyPortOwner 未占用端口 + IsTinyRouter 检测） |

---

## 3. `internal/config/` — 配置结构与持久化

`config.yaml` 的类型定义、默认值、原子加载/保存、校验、API Key 的 AES-256-GCM 加密。架构基线见 [`docs/config-registry-state-architecture.md`](docs/config-registry-state-architecture.md)（与 registry/state 合著，含三层归属边界、原子持久化、AES-GCM 加密、双锁模型、源码锚点）。

| 文件 | 职责 |
|---|---|
| `types.go` | 配置结构体（`Config`/`Provider`/`Key`/`Combo`/`RotationConfig`/`SecurityConfig`/`AnySearchConfig`/`ThemeConfig` 等）+ YAML/JSON tag；`Config` 顶层新增 `QuickSlotOnly bool`（`yaml/json:"quickSlotOnly"`，控制 `/v1/models` 仅返回 QuickSlot 模型）；`AnySearchConfig` 含 `APIKey`/`MaxResults` 字段；`ThemeConfig` 含 `DarkVariant`/`LightVariant` 字段（双层主题 Mode/Variant 持久化）；`Provider` 新增 `AnthropicVersion`/`AnthropicBeta` 字段与 `IsAnthropic()` 方法（`APIType=="anthropic"`）；`ModelDef` 新增 `Protocols []string` 字段（yaml/json `protocols,omitempty`，记录多协议探测结果）+ `ProtocolOpenAICompat`/`ProtocolOpenAIResponses`/`ProtocolAnthropic` 常量；`Config` 顶层含 `AnySearch` 字段与 `ImageSaveDir` 字段（图片保存目录，默认 `"imgs"`）及 `Theme ThemeConfig` 字段 |
| `defaults.go` | 默认配置构造 + `Finalize*` 零值回填；`finalizeConfig` 为 anthropic provider 回填 `AnthropicVersion="2023-06-01"`；`finalizeConfig` 回填 `AnySearch.MaxResults` 默认值 5；`finalizeConfig` 回填 `Theme.DarkVariant`/`Theme.LightVariant` 默认值 `"default"` |
| `persistence.go` | `Load`/`Save`：`.tmp` 恢复 + 原子写（委托 `fsutil.AtomicWrite`） |
| `validate.go` | 尽力校验（API 类型、重复 ID/prefix、ModelDef.Protocols 值合法性），仅告警；anthropic provider 的 BaseURL 未以 `/v1/messages` 或 `*` 结尾时告警 |
| `crypto.go` | AES-256-GCM：API Key 静态加密，`GenerateKey`/`encryptKeysCopy` |
| `config.go` | 包文档 + 职责拆分说明 |
| `config_test.go` / `crypto_test.go` | 测试 |

---

## 4. `internal/registry/` — Provider/Key/Combo/QuickSlot CRUD 与运行时状态

线程安全的配置 + 运行时 key 状态映射；所有管理 API 的数据后端。架构基线见 [`docs/config-registry-state-architecture.md`](docs/config-registry-state-architecture.md)（与 config/state 合著，含 CRUD、KeyRuntimeState 归属、reload merge 语义、双锁模型、源码锚点）。

| 文件 | 职责 |
|---|---|
| `registry.go` | `Registry` 结构：`sync.RWMutex` 保护的 config + 运行时 key-state map；`New`/`Config`/`Reload` |
| `providers.go` | Provider CRUD |
| `keys.go` | Key CRUD（provider 内） |
| `models.go` | Provider 自定义模型列表（`ListModels`、`AddModel`、`DeleteModel`、`UpdateModelQuotaType`、`UpdateModelAlias` [含前缀自动剥离 `sanitizeAlias`]、`UpdateModelNote`、`UpdateModelNIMOverride`、`ResolveModelAlias` [含容错剥离]、`GetModelByAliasOrID`） |
| `combos.go` | Combo CRUD；新增 `GetComboByID`(id) 方法供 combo 测速排序 handler 使用 |
| `quickslots.go` | QuickSlot（预设模型切换槽）CRUD（含 `sanitizeQuickSlotModels` 自动化简 `prefix/prefix/model` 条目） |
| `state.go` | 每 key 运行时状态（`KeyRuntimeState`：冷却/锁/退避/NIM 计数）+ 合并/保留逻辑 |
| `crud_test.go` / `reload_merge_test.go` / `state_test.go` | 测试 |
| `models_protocols_test.go` / `probe_records_test.go` | 新增 ModelDef.Protocols CRUD 与 probeRecords 运行时状态测试 |

---

## 5. `internal/rotation/` — Key 选择策略 + 冷却/退避 + NIM

移植自 9router `src/sse/services/auth.js`。架构基线见 [`docs/rotation-architecture.md`](docs/rotation-architecture.md)（含 SelectKey 算法、三种策略、两套退避系统、配额锁、NIM、错误分类、源码锚点）。

| 文件 | 职责 |
|---|---|
| `selector.go` | `KeySelector` 接口 + `Selector`：组合 key 选择与冷却；`SelectKey`/`OnKeyFailure`/`IsNIMEnabled`/NIM 钩子 |
| `strategy.go` | 轮询策略（fill-first / round-robin / failover）+ stickyLimit |
| `cooldown.go` | 指数退避（1s→240s），429 日配额锁至次日 CST 00:05，per-model 锁 |
| `ratelimit.go` | 每 key 请求速率记账 |
| `error_rules.go` | 上游错误分类（transient vs fatal，429/5xx 规则） |
| `nim.go` | NVIDIA NIM 限速：per-key 请求计数、min interval、429 冷却阶梯、自动检测、`getEffectiveNIMSettings`/`getModelNIMOverride`、per-model `ModelNIMOverride` 支持 |
| `selector_test.go` / `cooldown_test.go` / `ratelimit_test.go` / `error_rules_test.go` / `nim_test.go` | 测试 |

---

## 6. `internal/combo/` — Combo 解析

架构基线见 [`docs/combo-architecture.md`](docs/combo-architecture.md)（含 Resolve 算法、三种策略目标排序、配额层级、状态持久化、源码锚点）。

| 文件 | 职责 |
|---|---|
| `resolver.go` | `Resolver` + `ComboPlan`/`ModelTarget`：按策略将 combo 解析为有序 provider+model 目标列表（greedy-squirrel 按配额层级排序） |
| `resolver_test.go` | 测试 |

策略：`fallback`（顺序尝试）/ `round-robin`（轮转）/ `greedy-squirrel`（按配额层级排序后 fallback）。

---

## 7. `internal/proxy/` — `/v1/*` 代理处理器

OpenAI 兼容透传 + SSE 流式转发 + 重试/故障转移 + 用量记录。架构基线见 [`docs/proxy-architecture.md`](docs/proxy-architecture.md)（含调用链、重试状态机、SSE 透传、Gemini 签名回填、在途跟踪、源码锚点）。

| 文件 | 职责 |
|---|---|
| `handler.go` | `Handler`（基于接口装配，非具体类型）：路由 `/v1/*`，构造 HTTP client（普通/流式/管理 + 代理变体）；`pgUsage UsageRecorder` + `SetPgUsage`：Playground 来源请求专用 ring 注入；Anthropic 入口 `Messages`（`POST /v1/messages`，`handleProxy(..., EntryFormatAnthropic)`）；OpenAI Responses 入口 `Responses`（`POST /v1/responses`，`handleProxy(..., EntryFormatOpenAIResponses)`）；新增 `quickSlotOnlyProvider func() bool` + `SetQuickSlotOnlyProvider` + `quickSlotOnly()` 方法，供 `ListModels` 过滤使用 |
| `interfaces.go` | handler 依赖的能力接口（`ModelResolver`（含 `ResolveModelAlias`）/`KeyProvider`（含 `IsNIMEnabled`）/`ComboResolver`（`Resolve(name, entryFormat)`）/`UsageRecorder`/`Logger` 等） |
| `forward.go` | 上游请求转发 / body 改写（替换 model 字段、注入 `stream_options`）；**非流式 keep-alive 刷新**（首字节 `\n` + 5s ticker ` ` 字节，§8.7 见 proxy-architecture.md）；`handleProxy`/`handleCombo`/`forwardWithRetry`/`forwardUpstream` 带 `entryFormat` 参数；**软策略**：客户端用什么协议入口请求就按该协议转发，proxy 不再因 `provider.APIType` 拒绝请求（已移除入口协议严格匹配 400 块） |
| `upstream.go` | `normalizeBaseURL`：最长优先剥除已知 endpoint 后缀（含 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 等）；`BuildUpstreamURL`：统一的 endpoint URL 拼接函数，启发式 A（判断路径是否含版本段如 `v1`/`v1beta`/`v2` 等决定是否注入 `/v1`）；`forwardUpstream` 按 `entryFormat` 三分支（OpenAI Chat / Anthropic / OpenAI Responses）；`buildAnthropicUpstreamRequest`+`setAnthropicHeaders`：`x-api-key`+`anthropic-version`(+可选 `anthropic-beta`)，URL 由 `BuildUpstreamURL` 统一构造，绝不设 `Authorization`；`buildResponsesUpstreamRequest`：URL 由 `BuildUpstreamURL` 统一构造，鉴权头 `Authorization: Bearer <key>`（同 OpenAI Chat） |
| `stream.go` | SSE 流式透传（`http.Flusher` 逐 chunk 转发），提取 JSON payload，用量计数；`entryFormat` 控制：anthropic 入口用 `parseAnthropicSSEUsage` 提取 `message_start`/`message_delta` 的 input/output tokens（复用 `recordUsage`，OpenAI `util.ExtractTokens` 加 guard 避免 anthropic `output_tokens` 干扰）；OpenAI Chat/Responses 入口走 `util.ExtractTokens`；客户端断开（`w.Write` 失败）→ `clientDisconnected` 标志 → `break` 退出循环 → `recordUsage(status="error", errMsg="client disconnected")` 保证 request-done 广播 |
| `retry.go` | 跨 key/combo 故障转移的重试状态机 |
| `models.go` | 模型列表/解析辅助；`ListModels` 新增 `quickSlotOnly()` 门控——开启时仅返回 QuickSlot 模型，跳过 provider/combo |
| `recorder.go` | `recordUsage`：按 source 分流写入 Recent Requests ring 或 Playground ring；payload/headers 仅在 debugMode 或 playground 来源时捕获；reqBody 截断 64KB、respBody 截断 512KB（见 proxy-architecture.md 2026-07-15 更新） |
| `request_events.go` | 生成全局唯一 request ID |
| `entry_tracker.go` | `EntryTracker`：在途（processing）usage 条目并发 map；`Register`/`Remove`/`Get`/`All`/`Exists`/`SetTTFT`/`UpdateTokens`；`SweepStale(maxAge)` 兜底清理超时条目（返回并删除，由 caller 写 error 记录到 RingBuffer + 广播 request-done） |
| `inflight.go` | `inflightEntry`：单条在途流式请求的实时输出 |
| `broadcaster.go` | `Broadcaster`：把事件扇出到所有 SSE 订阅 channel |
| `signature_cache.go` | `SignatureCacheProvider`：缓存 Gemini `thought_signature` 用于流式回填 |
| `*_test.go` | 测试（handler/retry/stream/e2e/signature 多套）；新增 `responses_test.go`（OpenAI Responses 路由）、`anthropic_test.go`（Anthropic 入口）、`anthropic_usage_test.go`（parseAnthropicSSEUsage） |

> Gemini `thought_signature` 自动回填：流式中提取签名并缓存，非流式响应自动补全，对 OpenAI 兼容端点透明（见 commit `c2f89c6`）。

---

## 8. `internal/usage/` — 内存统计 + 配额

| 文件 | 职责 |
|---|---|
| `ring.go` | `RingBuffer`：有界环形缓冲（默认 500 条）+ 摘要 |
| `accumulator.go` | `CumulativeSummary` + per-model 累计（单调）统计 |
| `quota.go` | `QuotaTracker`：per-model 配额展示/快照 |
| `ring_test.go` / `quota_test.go` | 测试 |

> 仅存内存，重启清零。Playground 来源请求由独立的 `pgUsageBuf`（容量 50）承载，与 Recent Requests 的 `usageBuf` 物理隔离。

---

## 9. `internal/console/` — 控制台日志 + SSE 推送

| 文件 | 职责 |
|---|---|
| `logger.go` | `Logger`：环形缓冲应用日志捕获 + 广播到 SSE 订阅者 |
| `logger_test.go` | 测试 |

日志格式与 9router 一致（详见 AGENTS.md "日志格式"）。

---

## 10. `internal/api/` — 管理 REST API（chi 路由）

管理 UI 与外部操作的全部 HTTP 端点。

| 文件 | 职责 |
|---|---|
| `router.go` | `New()`：装配 chi `Router`，注入所有 handler；`deps` 依赖束（含 `pgUsage *usage.RingBuffer`）；新增 `quickSlotOnly atomic.Bool` + `QuickSlotOnly()`/`SetQuickSlotOnly(bool)` 方法，供 proxy handler 通过 `quickSlotOnlyProvider` 获取实时状态 |
| `helpers.go` | 共享辅助（`saveConfig` + 状态持久触发） |
| `anysearch.go` | AnySearch 搜索代理：3 个 handler（`POST /api/anysearch/search`、`/subdomains`、`/extract`），委托 `internal/anysearch.Client` 调用 JSON-RPC API |
| `auth.go` | 本地密码鉴权：AES-256-GCM、session token、HttpOnly cookie、登录 |
| `rate_limit.go` | 登录速率限制 |
| `compress.go` | Brotli/gzip 响应压缩中间件；对 `/v1/images/generations` 与 `/v1/images/edits` 直接放行（见 proxy-architecture.md §8.7） |
| `sse_events.go` | usage/inflight 事件 SSE 流 |
| `console_logs.go` | 控制台日志 SSE |
| `providers.go` / `providers_validate.go` / `providers_models.go` / `providers_models_crud.go` | Provider 列表/重排（`reorderProvider`）/校验/模型拉取/模型增删改查（`addProviderModel`、`updateModelQuota`、`updateModelAlias`、`updateModelNote`、`updateModelNIM`、`updateModelKind`、`updateModelImgProtocol`、`updateModelImgSizes`、`deleteProviderModel`） |
| `keys.go` / `bulk_keys.go` / `model_keys.go` | Key 列表/CRUD、批量添加、模型可用 key 查询 |
| `models.go` | 模型列表（`/api/models`，返回 `prefix/alias` 或 `prefix/model_id`） |
| `combos.go` / `quickslots.go` | Combo / QuickSlot CRUD |
| `combo_speedtest.go` | Combo 批量测速排序 handler：`speedTestCombo`（`POST /combos/{id}/speed-test`，SSE 流式）对 combo 内全部模型（含 `DisabledModels`）全并发流式测速（发"写约1000字短篇小说"prompt，`stream:true`、`max_tokens:1200`），按 `TokensPerSec` 降序（失败排末尾）排序，分别写回 `Models` 与 `DisabledModels` 并 `saveConfig` 持久化；事件序列 `meta` → `model`*N → `done`；复用 `proxy.{BuildUpstreamURL,SSELineBuffer,SSEDataPayloads}`、`util.ExtractTokens`、`extractContentFromSSE`（位于 `probe_common.go` 包内）、`firstActiveKey`（位于 `providers_validate.go`）、`rt.proxyHandler.ManagementClient`；60s 整体超时、单模型早停（60 chunks 或 30s） |
| `settings.go` | GET/PUT 设置（server/security/rotation/quickSlotOnly/theme 等）；`getSettings` 返回 `quickSlotOnly`、`theme` 字段，`updateSettings` 接收并同步到 `cfg.QuickSlotOnly` + `rt.SetQuickSlotOnly()`、`cfg.Theme`（`ThemeConfig` 双层主题 variant 持久化） |
| `usage.go` / `usage_reset.go` / `quota.go` | 用量摘要/重置/配额；`getPlaygroundUsage`（`GET /api/usage/playground`）：返回 Playground 来源 ring + 在途条目；`getUsage` 开头调用 `SweepStale(10min)` 兜底：超时 processing 条目转 `Status="error"`/`Error="timeout"` 写入 RingBuffer + 广播 request-done |
| `probe_common.go` / `probe_model.go` / `probe_keys.go` | 单模型单协议探测 + 全 key 批量探测（共享 SSE 内容提取 / URL 归一化）；`probe_common.go` 提供 `probeOpenAICompat`/`probeOpenAIResponses`/`probeAnthropic` 单协议探测函数（提示词为 "generate 100 tokens self introduction"，`max_tokens: 150`，计算并返回 `outputTokens` 与 `tokensPerSec`）；`probe_model.go` 的 `testProviderModelProto` handler（`POST /providers/{id}/models/test-proto`，body `{model, proto}`）单协议单次探测，**不持久化**；`probe_keys.go` 的 `testProviderModelAllKeys`（`/models/test-all` 批量 key 探测）保持不变；`probe_test.go` / `probe_proto_test.go`（覆盖新 handler + URL 归一化）；删除 `probe_compound_test.go` |
| `monitor.go` / `terminal.go` | Monitor 命令状态 / Terminal WebSocket |
| `download.go` | 下载任务创建/状态（委托 `internal/download.Manager`）；`openDownloadDir` handler 调用 `fsutil.OpenInFileManager` 打开下载目录；`openExternalURL` 调用 `fsutil.OpenInBrowser`；`browseSystemPath` 调用 `fsutil.OpenFilePicker`/`fsutil.OpenDirectoryPicker`（现代 Common Item Dialog）；`retryDownloadTask` handler 原地重试失败/取消任务（`POST /downloads/{id}/retry`） |
| `image.go` | `saveImage`：保存图片到可配置目录（`Config.ImageSaveDir`，默认 `imgs/`）；支持 data: URL 和 http(s) URL |
| `url_validation.go` | `validateBaseURL` 辅助 |
| `gallery.go` | Gallery 图片查看器后端 handlers：`galleryListZip` (POST `/api/gallery/zip` 上传 zip → 返回 `{sessionId, manifest}`)，`galleryGetZipEntry` (GET `/api/gallery/zip/{sessionId}/{entryIndexOrPath:*}` 支持按 Index / Path 提取单图字节)，`galleryConvertTiff` (POST `/api/gallery/tiff` TIFF→JPEG 转码) |
| `gallery_fs.go` | Gallery 文件系统操作 handlers：`galleryOpenDir` (POST `/api/gallery/open-dir` 后端原生目录选择器 + 递归文件列表)，`galleryListDir` (POST `/api/gallery/list-dir`)，`galleryServeFile` (GET `/api/gallery/file?path=` 按绝对路径提供文件)，`galleryDeleteFs` (DELETE `/api/gallery/fs` 后端 os.Remove/os.RemoveAll)，`galleryZipFromPath` (POST `/api/gallery/zip-from-path` 从磁盘路径创建 zip 会话)，`galleryZipWriteback` (POST `/api/gallery/zip-writeback` 会话字节写回磁盘)，`galleryPastePaths` (POST `/api/gallery/paste-paths` 读取剪贴板 CF_HDROP 路径) |
| `gallery_session.go` | Gallery zip 会话存储：包级 `gallerySessions` LRU（线程安全，上限 32 个、5 分钟空闲过期），`sync.Once` 启动后台定时清理 goroutine |
| `*_test.go` | 测试（api/auth/bulk_keys/url_validation/settings） |

### 10.1 `internal/gallery/` — Gallery 图片查看器后端

为前端 Gallery 分页（图片查看器，playground 构建变体）提供 zip 解析与 TIFF 转码能力。不持久化、不写盘；状态仅驻进程内存（zip 会话 LRU）。

| 文件 | 职责 |
|---|---|
| `gallery.go` | 包文档 + `SupportedExts`、`IsSupportedExt`、`Entry`/`Manifest` 类型 |
| `zip.go` | `ListZipEntries(io.ReaderAt,size)` 列 zip 内图片条目（按名排序、过滤非图片）; `GetZipEntry(reader,size,name)` 取单个条目字节; `ErrEntryNotFound`; `contentTypeForExt` |
| `tiff.go` | `ConvertTIFFToJPEG(io.Reader,quality)` / `ConvertTIFFBlobToJPEG([]byte,quality)`：用 `golang.org/x/image/tiff` 解码后重编码为 JPEG（Chromium/WebView2 原生不支持 `<img>` 显示 TIFF） |
| `zip_test.go` / `tiff_test.go` | 测试 |

架构基线见 [`docs/playground-architecture.md`](docs/playground-architecture.md)（Gallery 一节）。

引入依赖：`golang.org/x/image`（webp/bmp/tiff/draw 子包），纯 Go 无 CGO。

---

## 11. `internal/state/` — `state.yaml` 运行时持久化

架构基线见 [`docs/config-registry-state-architecture.md`](docs/config-registry-state-architecture.md)（与 config/registry 合著，含 Snapshot 格式、500ms 去抖、回调模式破除循环依赖、源码锚点）。

| 文件 | 职责 |
|---|---|
| `state.go` | `Snapshot`/`KeySnapshot`/`ComboSnapshot`/`ProbeRecord`/`ProbeDetail` 类型 + YAML 序列化；`CurrentVersion=1`；`Snapshot.Probes map[string]*ProbeRecord`（精简明细，不含请求/响应 body）；`Save` 委托 `fsutil.AtomicWrite` 原子写入 |
| `manager.go` | `Manager`：500ms 去抖 + 定时器 + 原子写（经回调快照，避免 import cycle） |
| `state_test.go` | 测试 |

---

## 12. `internal/fsutil/` — 统一文件系统工具

原子写入、系统文件管理器/浏览器打开、文件/目录选择对话框的统一抽象。被 `config`、`state`、`api`、`app` 包共同依赖。

| 文件 | build tag | 职责 |
|---|---|---|
| `atomic.go` | — | `AtomicWrite(path, data, perm)`：确定性 `.tmp` + `os.Rename` 原子写，失败回退直写，保留 crash-recovery 语义 |
| `open.go` | — | `ErrUnsupportedPlatform` 共享错误变量 |
| `open_windows.go` | `windows` | `OpenInFileManager`（ShellExecute + `/select,`）、`OpenInBrowser`（rundll32）、`OpenFilePicker`/`OpenDirectoryPicker`（原生 COM IFileOpenDialog，现代 Windows 10/11 对话框，返回绝对路径） |
| `open_other.go` | `!windows` | macOS（`open -R`/`osascript`）、Linux（`xdg-open`）实现；文件/目录选择器 Linux 返回 `ErrUnsupportedPlatform` |
| `clipboard_windows.go` | `windows` | `GetClipboardFilePaths()`：读取 Windows 剪贴板 CF_HDROP 格式文件路径（OpenClipboard + DragQueryFileW） |
| `clipboard_other.go` | `!windows` | `GetClipboardFilePaths()` 返回 nil（非 Windows 平台不支持） |
| `atomic_test.go` | — | 测试 |

---

## 13. `internal/util/` — 通用辅助

| 文件 | 职责 |
|---|---|
| `util.go` | `SplitModel("provider/model")`、`TruncStr`、JSON 辅助 |

---

## 14. `internal/terminal/` — 交互式终端

Debug Mode 下的完整交互式终端（xterm.js + WebSocket + ConPTY/PTY），支持 vim、Ctrl+C、Tab 补全，会话持久保持。架构基线见 [`docs/terminal-monitor-architecture.md`](docs/terminal-monitor-architecture.md)（与 Monitor 合著，含会话模型、调试门控、单会话守卫、平台进程生成、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `session.go` | — | PTY 会话（`go-pty` + `gorilla/websocket`） |
| `process_windows.go` | `windows` | ConPTY 进程生成 |
| `process_unix.go` | `!windows` | PTY 进程生成 |
| `session_test.go` | — | 测试 |

---

## 15. `internal/monitor/` — Monitor 命令

实时流式运行白名单命令（如 `nvidia-smi -l 1`），输出内嵌 Console 页面。架构基线见 [`docs/terminal-monitor-architecture.md`](docs/terminal-monitor-architecture.md)（与 Terminal 合著，含 Manager、白名单、SSE 流、平台进程生成、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `manager.go` | — | 单条 monitor 命令调度 + 输出流 |
| `manager_windows.go` | `windows` | Windows 进程 spawn |
| `manager_unix.go` | `!windows` | Unix 进程 spawn |
| `manager_test.go` | — | 测试 |

---

## 16. `internal/download/` — 视频/音频下载

基于 yt-dlp + ffmpeg 的下载任务队列/执行器（VidBee 风格 Go 原生移植，无持久化）。架构基线见 [`docs/download-architecture.md`](docs/download-architecture.md)（含任务生命周期、yt-dlp 参数构造、API 端点、与归档计划的漂移、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `manager.go` | — | 下载任务队列管理 |
| `executor.go` | — | yt-dlp 执行调度 |
| `args.go` | — | yt-dlp 参数构造 |
| `types.go` | — | 下载任务类型 |
| `kill_windows.go` | `windows` | 进程终止 |
| `kill_unix.go` | `!windows` | 进程终止 |
| `download_test.go` | — | 测试 |

> 外部依赖：yt-dlp、ffmpeg 需用户自装（见 README.md）。

---

## 17. `internal/anysearch/` — AnySearch 搜索客户端

AnySearch JSON-RPC API 的 Go 客户端，供 Playground Search 模式使用。

| 文件 | 职责 |
|---|---|
| `client.go` | `Client` 结构体（`httpClient`+`apiKey`）；`New(apiKey)` 构造（30s 超时）；`Search`/`GetSubDomains`/`Extract` 方法调用 AnySearch JSON-RPC API（endpoint `https://api.anysearch.com/mcp`，method `tools/call`）；`callAPI` 私有方法发送 JSON-RPC 请求，提取 `result.content[].text` |

---

## 18. `web/` — 内嵌前端

### 18.1 Embed 门控

| 文件 | build tag | 职责 |
|---|---|---|
| `embed.go` | `!playground` | 内嵌 `static/` 到 `web.Static`；`PlaygroundCompiled()=false` |
| `embed_playground.go` | `playground` | 内嵌 `static/` + `playground/static-pg`；`PlaygroundCompiled()=true` |
| `embed_playground_stub.go` | `!playground` | 空 `PlaygroundStatic` FS（调用方须判 `PlaygroundCompiled()`） |

### 18.2 `web/static/` — 管理 SPA

| 类别 | 文件 |
|---|---|
| 入口 | `index.html`、`index-nopg.html`（无 playground 变体） |
| JS 模块 | `app.js`、`api.js`、`auth.js`、`i18n.js`、`theme.js`（ThemeSystem 双层主题注册表：Mode/Variant 管理 + localStorage + Settings API 持久化 + theme-picker UI 渲染）、`info_common.js`、`providers.js`、`combos.js`、`quickslots.js`、`usage.js`（`handleRequestStart` 去重、`handleRequestDone` 兖底清理、`updateProcessingLatencyCells` 超 10 分钟停止计时、`refreshQuotaData` stale 判定、`initTrendChart` resize 监听）、`console.js`、`terminal.js`、`monitor.js`、`download.js`、`endpoint.js`、`headerStats.js`、`shortcuts.js`（快捷键注册中心：系统预设 + 用户覆盖 + `Shortcuts.matchEvent`）、`fs-api.js`（统一文件 API：`FsApi.BlobTracker` 泄漏防护 + `pickFiles`/`pickDirectory`/`saveFile`/`collectFilesFromDataTransfer`/`walkDir`） |
| 三方 JS | `chart.umd.js` |
| 样式 | `style.css`（Usage & Gallery 贴边无缝矩形容器；修复全屏模式下动态自适应底部面板高度与视频进度条/控制栏联动 hover 呈现） |
| 图标 | `logo.png`(1024 源)、`logo-sm.png`、`favicon.ico`(7 尺寸)、`favicon.png`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`、`site.webmanifest` |
| 终端模拟器 | `xterm/`：`xterm.js`、`xterm.css`、`xterm-addon-fit.js` |

### 18.3 `web/playground/` — Playground 模块（仅 `-tags playground` 内嵌）

多模型同时请求测试 + 多模型聊天群聊。前后端事实基线见 [`docs/playground-architecture.md`](docs/playground-architecture.md)。

| 类别 | 内容 |
|---|---|
| 文档 | `README.md` |
| 核心 JS | `static-pg/playground.js`、`playground.css` |
| 模块 JS | `pg-core`、`pg-state`、`pg-setup`、`pg-request`、`pg-stream`、`pg-render`、`pg-markdown`、`pg-modal`、`pg-ui`、`pg-lifecycle`、`pg-i18n`、`pg-director`、`pg-autochat`、`pg-search`、`gallery.js` |
| vendor | `marked.min.js`、`marked-katex-extension`、`katex.min.js`/`.css`、`mermaid.min.js`、`highlight.min.js`、`purify.min.js`、`pg-highlight-theme.css`、`fonts/`(KaTeX woff2) |

---

## 19. `docs/` — 文档

| 路径 | 状态 | 内容 |
|---|---|---|
| `docs/playground-architecture.md` | **当前/权威** | Playground 前后端架构基线（共享时间线群聊模型、Director/Narrator、场景、源锚点） |
| `docs/proxy-architecture.md` | **当前/权威** | Proxy 代理核心架构基线（调用链、重试/故障转移状态机、SSE 透传、Gemini 签名回填、在途跟踪、源码锚点） |
| `docs/rotation-architecture.md` | **当前/权威** | Rotation Key 轮询架构基线（SelectKey 算法、三种策略、两套退避系统、配额锁 CST 00:05、NIM、错误分类、源码锚点） |
| `docs/download-architecture.md` | **当前/权威** | Download 下载架构基线（任务队列生命周期、yt-dlp 参数构造、SSE 进度、与归档计划漂移、源码锚点） |
| `docs/combo-architecture.md` | **当前/权威** | Combo 组合策略架构基线（Resolve 算法、三种策略目标排序、greedy-squirrel 配额层级、状态持久化、源码锚点） |
| `docs/terminal-monitor-architecture.md` | **当前/权威** | Terminal + Monitor 架构基线（PTY 会话、调试门控、白名单命令、SSE 流、平台进程生成、源码锚点） |
| `docs/config-registry-state-architecture.md` | **当前/权威** | Config/Registry/State 基础设施架构基线（三层归属边界、原子持久化、AES-GCM 加密、双锁模型、reload merge、回调去抖、源码锚点） |
| `docs/providerinfo.md` | 参考 | 各 Provider API 参考笔记（响应 schema、限速头、错误码） |
| `docs/research/` | 参考 | 调研笔记（`request.md`、`respond.md` 等） |
| `docs/archive/` | 归档 | 历史规划/审计/交接文档，**非当前事实来源** |

---

## 20. 脚本与构建产物

| 文件 | 职责 |
|---|---|
| `build.ps1` | 构建脚本，产出 13 个变体（default/tray/webview/debug × playground/strip） |
| `gen-icon.ps1` | 从 `web/static/logo.png` 经 `rsrc` 生成多尺寸 `favicon.ico` |
| `rsrc.manifest` | Windows exe 清单 |
| `rsrc.syso` | 图标资源（`go:generate` 自动同步，gitignored） |

构建变体与 build tag 矩阵详见 **README.md "构建变体"** 与 **AGENTS.md "构建变体"**。

---

## 21. 运行时文件（gitignored，首次运行生成）

| 文件 | 生成方 | 内容 |
|---|---|---|
| `config.yaml` | `internal/config` | providers + combos + settings |
| `state.yaml` | `internal/state` | key/combo 运行时状态（冷却级别、模型锁、轮转索引） |

---

## 22. Gitignored 参考副本（非本项目模块）

| 路径 | 说明 |
|---|---|
| `new-api/` | vendored 的 "new-api" LLM gateway 副本（~600+ `.go` 文件）。`.gitignore` 排除、`go.mod` 不引用、`package main` 不引用。**仅作实现参考**，不参与编译，勿计入本项目模块。 |

---

## 23. 规划中 / 暂未实现（占位）

> 以下为本文件预留的占位区。随项目推进新增"已规划但未落地"的模块时，在此登记占位；落地后移入上文对应章节并在此标注"已落地"。当前无未实现的占位项。

- _（暂无）_

---

## 24. 常见变更任务速查表

> 从**变更任务**出发的反向索引。先读"先读文档"列对应的架构基线，再按"涉及源码"列定位修改点。跨模块变更须同时读多份文档的"变更维护清单"。

| 变更任务 | 先读文档 | 涉及源码 |
|---|---|---|
| 新增/修改 Provider API 类型 | config-registry-state、proxy、rotation | `config/types.go`（`APIType`/`IsNIM`/`IsGeminiOpenAICompat`）、`config/validate.go`、`rotation/nim.go`、`proxy/forward.go` |
| 新增 Key 轮询策略 | rotation | `rotation/strategy.go`+`selector.go`、`config/types.go`（`RotationConfig`）、`proxy/forward.go`（`forwardWithRetry`） |
| 修改重试/故障转移逻辑 | proxy、rotation | `proxy/retry.go`、`rotation/error_rules.go`+`cooldown.go`、`proxy/forward.go` |
| 新增/修改 Combo 策略 | combo、proxy | `combo/resolver.go`、`proxy/forward.go`（`handleCombo`）、`config/types.go`（`Combo`） |
| Combo 批量测速排序 | combo、proxy | `api/combo_speedtest.go`（`speedTestCombo` SSE handler + `probeComboModel`，复用 `proxy.BuildUpstreamURL/SSELineBuffer/SSEDataPayloads`、`util.ExtractTokens`、`probe_common.go::extractContentFromSSE`、`providers_validate.go::firstActiveKey`、`proxy/handler.go::ManagementClient`）、`registry/combos.go`（`GetComboByID`）、`api/router.go`（路由注册）、`web/static/combos.js`（`runComboSpeedTest` + 编辑弹窗按钮 + `renderComboModelsList` 行 `data-fullid`/状态 span）、`web/static/i18n.js`（`comboSpeedTest*` 键） |
| 修改 SSE 流式透传 | proxy | `proxy/stream.go`、`proxy/forward.go` |
| 修改非流式 keep-alive 刷新 / 图片长响应超时 | proxy | `proxy/forward.go`（`forwardWithRetry` 内 keep-alive ticker，§8.7）、`api/compress.go`（`/v1/images/*` 绕过列表）、`proxy/stream.go`（`passThroughResponse` body 拼接）；前端 `pg-stream.js`（`pgSendImage` imgTimer）、`pg-render.js`（`pgTickWaiting` 安全网） |
| 修改上游 URL/body 改写 | proxy | `proxy/upstream.go`、`proxy/forward.go` |
| Provider 列表顺序调整与避让 | config-registry-state | `registry/providers.go`（`ReorderProvider`）、`api/providers.go`（`reorderProvider`）、`api/router.go`（`PUT /providers/{id}/reorder`）、`web/static/providers.js`（`renderProviderDetail` 顶栏排序输入框 + `changeProviderOrder`）、`web/static/style.css`（`.btn-order-input`）、`web/static/i18n.js`（`providerOrder*`/`invalidOrderRange` 翻译键） |
| 修改 Gemini thought_signature 回填 | proxy | `proxy/signature_cache.go`+`forward.go`+`stream.go`、`config/types.go`（`IsGeminiOpenAICompat`） |
| 新增管理 API 端点 | （对应模块文档）、config-registry-state | `api/router.go`（挂载+鉴权边界）、`api/<域>.go`、`registry/<域>.go` |
| 新增/修改配置字段 | config-registry-state | `config/types.go`（`ModelDef` 含 `Alias`/`Note`/`NIMOver`/`Kind`/`ImgProtocol`/`ImgSizes`；顶层 `Shortcuts ShortcutsConfig` 用户覆盖 + `QuickSlotOnly bool` 开关）+`defaults.go`（`finalizeConfig`，含 `Shortcuts` nil→空 map 归一）+`persistence.go`（严格解析）+`api/settings.go`（`getSettings` 返回 `shortcuts`/`quickSlotOnly`、PATCH 接收 `shortcuts`/`quickSlotOnly`）+`api/router.go`（`quickSlotOnly atomic.Bool`）+`proxy/handler.go`（`quickSlotOnlyProvider`）+`proxy/models.go`（`ListModels` 过滤门控）+`web/static/shortcuts.js`（前端系统预设与 `Shortcuts.matchEvent`）+`web/static/endpoint.js`（左侧边栏开关）+`web/static/i18n.js`（翻译键） |
| 修改全局快捷键/键映射 | PROJECT_MAP §18.2 | `web/static/shortcuts.js`（`SHORTCUT_PRESETS` 系统预设 + `Shortcuts` API）、`web/static/app.js`（全局 keydown 改 `Shortcuts.matchEvent`）、`web/playground/static-pg/pg-ui.js`+`pg-autochat.js`+`gallery-fullscreen.js`（按区域改 `matchEvent`）、`web/static/endpoint.js`（`openShortcutsModal`）、`internal/api/settings.go`（`shortcuts` 字段流转）、`internal/config/types.go`（`ShortcutsConfig`） |
| 修改 QuickSlot 头部交互 / Active 联动 | PROJECT_MAP §18.2 | `web/static/quickslots.js`（`openModelSelectorModal` 统一抽取全站模型选择模态框 + `openQuickSlotModalByOrder`/`openQuickSlotModalById`/`_qsModal*` modal 系统 + import... 尾项 + `+` 快捷键 + capture 阶段键盘处理 + 1s 自动关闭门限 + Del 删除 + `setupImportModalKeyboardAndFocus` + `attachModalFocusTrap` 导入 modal 焦点/Tab 锁/上下键/PgUpPgDn/Space/Enter 交互 + `_qsActiveId`/`qsSetActive`/`qsClearActive`/`qsGetActiveModel`/`_qsUpdateActiveClass` active 联动）、`web/static/combos.js`（`importModelsFromProvider` 复用 `openModelSelectorModal`）、`web/static/app.js`（1-9 改调 `openQuickSlotModalByOrder(n, true)`，移除旧 Alt/Ctrl+1-9）、`web/static/shortcuts.js`（移除旧 quickslot-import/delete 预设）、`web/static/style.css`（`.quickslot-header` 优先级高于 `.top-header-stats` + `.import-model-item.focused` 高亮 + `outline-offset: -1px` 修复焦点轮廓线截断）、`web/static/i18n.js`（`qsModalHint` + `import` 翻译键） |
| 修改运行时状态持久化 | config-registry-state | `state/manager.go`+`state.go`、`registry/state.go`（`KeySnapshot`）、`app/app.go`（回调接线） |
| 修改本地密码/鉴权 | config-registry-state | `config/crypto.go`、`api/auth.go`+`settings.go`、`config/types.go`（`SecurityConfig`） |
| 修改 NIM 限速 | rotation | `rotation/nim.go`+`selector.go`（`IsNIMEnabled`）、`config/types.go`（`NIMSettings`+`ModelNIMOverride`）、`proxy/retry.go`（429 分发）、`proxy/interfaces.go`（`KeyProvider`）、`proxy/forward.go`（NIM 门控） |
| 修改配额锁/冷却退避 | rotation | `rotation/cooldown.go`、`config/defaults.go`（`BackoffMaxSec`） |
| 新增 Provider 限速头解析 | rotation | `rotation/ratelimit.go`（adapter）、`proxy/recorder.go` |
| 修改下载参数/任务生命周期 | download | `download/args.go`+`executor.go`+`manager.go`、`api/download.go`、`web/static/download.js` |
| 修改终端/监控 | terminal-monitor | `terminal/session.go`、`monitor/manager.go`、`api/terminal.go`+`monitor.go`、`web/static/terminal.js`+`monitor.js` |
| 修改用量统计/在途跟踪/兜底清理 | proxy | `proxy/recorder.go`（source 分流 + captureDetails 门控）+`entry_tracker.go`（`SetTTFT`/`UpdateTokens`/`SweepStale`）+`inflight.go`+`broadcaster.go`、`proxy/forward.go`（`broadcastTTFT`/`broadcastTokens`，`processingEntry.InputTokens` 粗估）、`proxy/stream.go`（`contentCharsTotal` 累积 + token 进度广播 + `clientDisconnected` 断开路径补 recordUsage）、`api/sse_events.go`、`api/usage.go`（`getUsage` 调用 SweepStale + `getPlaygroundUsage`）、`usage/`、`web/static/usage.js`（`handleRequestTTFT`/`handleRequestTokens` + 筛选 Tag + stale 超时停止 + 去重 + 兜底清理） |
| 新增/修改 build tag | （AGENTS.md 构建变体）、PROJECT_MAP §1/§18 | `build.ps1`、`host_*.go`、`web/embed*.go`、`internal/app/browser_*.go` |
| 修改前端页面/资产 | PROJECT_MAP §18 | `web/static/<page>.js`、`web/static/index.html`、`web/playground/static-pg/` |
| 修改 Playground 图片功能 | playground | `pg-modal.js`（`pgShowImageModal`/`pgInitImageZoom`/`pgOpenImgSizesModal`）、`pg-render.js`（`pgMsgInnerHTML` 气泡 onclick）、`api/image.go`（save-image 端点）、`playground.css`（`.pg-img-btn`/`.pg-img-edit-btn`/`.pg-img-custom-row`）；Image 模式另涉 `pg-ui.js`（`pgRenderImageParams`/`pgGetImgProtocol`/`pgImgParamSelectWithEdit`/`pgOnImgSizeSelect`）、`pg-request.js`（`pgBuildImageBody`）、`pg-stream.js`（`pgSendImage`/`pgPollModelScopeTask`）、`pg-core.js`（`PG_DEFAULT_CFG` 图片参数 + `pgApiPatch` 桥接）、`pg-state.js`（`pgState.mode` 三态 + `pgState.models[]` 含 `imgSizes`/`providerId`/`realModelId`）、`pg-i18n.js`（图片 i18n key + `pgImgEditSizes`/`pgImgCustomSize` 系列）、`api/router.go`（`/v1/images/generations`/`/v1/tasks/{taskId}` + `PATCH /providers/{id}/models/imgSizes`）、`api/models.go`（`listModels` 返回 `kind`/`imgProtocol`/`imgSizes`/`providerId`/`realModelId`）、`proxy/handler.go`（`ImagesGenerations`/`PollTask`）、`proxy/upstream.go`（`X-Modelscope-Async-Mode` header）、`config/types.go`（`ModelDef.Kind`/`ImgProtocol`/`ImgSizes`）、`registry/models.go`（`UpdateModelKind`/`UpdateModelImgProtocol`/`UpdateModelImgSizes`）、`api/providers_models_crud.go`（`updateModelKind`/`updateModelImgProtocol`/`updateModelImgSizes`） |
| 新增/修改 Anthropic 协议路由 | proxy、rotation | proxy/handler.go（Messages+handleProxy 传入 EntryFormatAnthropic）、proxy/forward.go（handleProxy/handleCombo/forwardWithRetry/forwardUpstream 带 entryFormat）、proxy/upstream.go（buildAnthropicUpstreamRequest+setAnthropicHeaders，x-api-key/anthropic-version/anthropic-beta，URL 不注入 /v1 前缀）、proxy/stream.go（entryFormat 参数，anthropic 入口用 parseAnthropicSSEUsage 提取 usage）、combo/resolver.go（EntryFormat 类型 + Resolve(name, entryFormat) 签名）、api/router.go（r.Post(/v1/messages, proxyHandler.Messages)）、config/types.go（AnthropicVersion/AnthropicBeta/IsAnthropic()） |
| 修改多协议探测/单协议 Test / Responses 路由 / Provider 详情页 UI 与 Batch Manage | proxy、rotation | internal/proxy/forward.go+upstream.go+stream.go+handler.go、internal/api/probe_model.go+probe_common.go+probe_keys.go+providers_validate.go、internal/combo/resolver.go、internal/config/types.go+validate.go、internal/api/router.go、internal/registry/models.go+state.go、web/static/providers.js+style.css+i18n.js+app.js+auth.js |
| 修改 Provider / Combo / QuickSlot 卡片外观与 2x2 按钮布局 | PROJECT_MAP §18 | `web/static/providers.js`、`web/static/combos.js`、`web/static/quickslots.js`、`web/static/endpoint.js`、`web/static/style.css` |
| 新增/修改 Gallery 图片查看器 | playground | `web/playground/static-pg/gallery.js`、`internal/api/gallery.go`+`gallery_fs.go`+`gallery_session.go`、`internal/gallery/{zip,tiff}.go`、`internal/api/router.go`（新增 `/api/gallery/*` 路由 + `pgJSFiles` 含 `gallery.js`）、`web/static/{index.html,app.js,style.css,i18n.js}`、`internal/api/compress.go`（`skipTypes` 加 `image/tiff`）、`go.mod`（`golang.org/x/image`）、`internal/fsutil/clipboard_*.go`（剪贴板路径读取） |
| 新增/修改 Search 模式 | playground、config-registry-state | `web/playground/static-pg/pg-search.js`+`pg-ui.js`+`pg-render.js`+`pg-state.js`+`pg-i18n.js`、`internal/anysearch/client.go`、`internal/api/anysearch.go`+`settings.go`+`router.go`、`internal/config/types.go`（`AnySearchConfig`）+`defaults.go` |
| 修改 Search 状态持久化 | playground | `web/playground/static-pg/pg-state.js`（`pgLoadSearchHistory()`/`pgSaveSearchHistory()`/`pgSearchEntryToJSON()`、`PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY`/`PG_SEARCH_MAX_ENTRIES`、`pgLoad()` search 分支）、`web/playground/static-pg/pg-lifecycle.js`（`cleanupPlayground()` search early return、`renderPlayground()` 恢复后渲染）、`web/playground/static-pg/pg-search.js`（`pgSearchSend()` 即时保存、DOM 存在检查） |
| 新增/修改主题变体 | config-registry-state、PROJECT_MAP §18.2 | `web/static/theme.js`（ThemeSystem registry 扩展 9 暗 + 9 亮 Variant，支持弹窗 3×3 Grid 卡片式 Theme Picker 渲染与双 Mode 对勾标记）、`web/static/style.css`（18 种 `[data-theme="..."][data-theme-variant="..."]` CSS 变量覆盖层 + 弹窗样式）、`internal/config/types.go`（`ThemeConfig`）、`internal/config/defaults.go`、`internal/api/settings.go`（theme 字段流转）、`web/static/endpoint.js`（外观 Row 移至快捷键设置之后，使用 Modal 唤起 Theme Picker）、`web/static/i18n.js`（`appearance`/`appearanceDesc`/`themeDark`/`themeLight` 键） |

---

## 同步约束（重申）

本文件是项目结构的**唯一权威地图**。凡有以下变更，提交者**必须**在同一次改动中更新本文件：

1. 新增 / 删除 / 重命名 任意 `*.go` 或目录
2. 新增 / 移除 `internal/` 子包
3. 新增 / 移除 build tag 或构建变体
4. 新增 / 移除 前端页面或 `web/static`、`web/playground` 资产
5. 模块职责迁移（文件/目录改属）
6. 新增 / 移除 `docs/` 下的事实基线文档

> `AGENTS.md` 与 `CLAUDE.md` 已不再承载模块地图，统一引用本文件。若两者与本文件冲突，**以本文件为准**。
