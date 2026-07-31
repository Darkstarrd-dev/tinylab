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
| `app.go` | — | `New()` 装配全部运行时组件（`buildComponents`），owns 生命周期与 graceful shutdown；绑定 `a.proxyHandler.SetQuickSlotOnlyProvider(a.apiRouter.QuickSlotOnly)`、`a.proxyHandler.SetLogRequestsProvider(a.apiRouter.LogRequests)`、`a.proxyHandler.SetRequestLogDir(filepath.Join(a.configDir, "request-logs"))`；从 `cfg.Trace` 加载 `TraceConfig`（`Enabled`/`RetainDays`/`MaxDiskMB`）并注入 `apibase.Deps.Trace`；`app.go:191` 启动 `go a.proxyHandler.SweepTraces(a.shutdownCtx, cfg.Trace.RetainDays, cfg.Trace.MaxDiskMB)` 后台保留清理 goroutine |
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
| `types.go` | 配置结构体（`Config`/`Provider`/`Key`/`Combo`/`RotationConfig`/`SecurityConfig`/`AnySearchConfig`/`ThemeConfig` 等）+ YAML/JSON tag；`Config` 顶层新增 `QuickSlotOnly bool`（`yaml/json:"quickSlotOnly"`，控制 `/v1/models` 仅返回 QuickSlot 模型）；`AnySearchConfig` 含 `APIKey`/`MaxResults` 字段；`ThemeConfig` 含 `DarkVariant`/`LightVariant`/`Style` 字段（双层主题 Mode/Variant + 独立风格维度持久化）；`Provider` 新增 `AnthropicVersion`/`AnthropicBeta` 字段与 `IsAnthropic()` 方法（`APIType=="anthropic"`）；`ModelDef` 新增 `Protocols []string` 字段（yaml/json `protocols,omitempty`，记录多协议探测结果）+ `ProtocolOpenAICompat`/`ProtocolOpenAIResponses`/`ProtocolAnthropic`/`ProtocolOpenAIEmbedding` 常量；`ModelDef.Kind` 支持 `"text"`（默认）/`"image"`/`"embedding"`；`Config` 顶层含 `AnySearch` 字段与 `ImageSaveDir` 字段（图片保存目录，默认 `"imgs"`）及 `Trace TraceConfig` 字段（trace 配置，yaml/json `trace`）；`TraceConfig` 结构体含 `Enabled bool`、`RetainDays int`、`MaxDiskMB int` 三个字段 |
| `paths.go` | 共享路径解析函数：`ResolveDownloadProxy(cfg)` 由 `DownloadConfig.UseProxy` + 全局 `Proxy`（Host:Port）合成 yt-dlp `--proxy` URL；`ResolveTraceDir(logDir, configDir)` 解析 `TraceConfig.LogDir`（空→`{configDir}/traces`，相对拼 configDir，绝对原样）。被 `app.go` 装配与 `api/settings/register.go` 运行时更新共用，避免 `app`→`api` 循环导入。 |
| `defaults.go` | 默认配置构造 + `Finalize*` 零值回填；`finalizeConfig` 为 anthropic provider 回填 `AnthropicVersion="2023-06-01"`；`finalizeConfig` 回填 `AnySearch.MaxResults` 默认值 5；`finalizeConfig` 回填 `Theme.DarkVariant`/`Theme.LightVariant`/`Theme.Style` 默认值 `"default"`；`finalizeConfig` 在 `TextReview.SplitPatterns == nil`（首次启动）时注入内置章节检测模式（移植自 novelhelper `split.ts::DEFAULT_SPLIT_PATTERNS`，nil 判断避免用户清空 `[]` 后重新注入）；`DefaultConfig()` 中 `Trace` 字段默认值：`Enabled=false`、`RetainDays=2`、`MaxDiskMB=500` |
| `persistence.go` | `Load`/`Save`：`.tmp` 恢复 + 原子写（委托 `fsutil.AtomicWrite`） |
| `validate.go` | 尽力校验（API 类型、重复 ID/prefix、ModelDef.Protocols 值合法性），仅告警；anthropic provider 的 BaseURL 未以 `/v1/messages` 或 `*` 结尾时告警 |
| `crypto.go` | AES-256-GCM：API Key 静态加密，`GenerateKey`/`encryptKeysCopy` |
| `config.go` | 包文档 + 职责拆分说明 |
| `config_test.go` / `crypto_test.go` / `text_review_test.go` | 测试（`text_review_test.go` 覆盖 TextReview 默认 split-pattern 注入与配置持久化往返） |

---

## 4. `internal/registry/` — Provider/Key/Combo/QuickSlot CRUD 与运行时状态

线程安全的配置 + 运行时 key 状态映射；所有管理 API 的数据后端。架构基线见 [`docs/config-registry-state-architecture.md`](docs/config-registry-state-architecture.md)（与 config/state 合著，含 CRUD、KeyRuntimeState 归属、reload merge 语义、双锁模型、源码锚点）。**2026-07-25：** per-key 运行时状态类型 `KeyRuntimeState`/`QuotaInfo` 及其自带锁纯方法抽离到新包 [`internal/keystate`](#keystate)（见 §4 末），registry 仍持有 `states map[string]*keystate.KeyRuntimeState` 并负责 `GetKeyState`/snapshot/restore/reload-merge/`ResetAllCooldowns`/probe records；`rotation` 不再 `import registry`（改用 `keystate` + `KeyStateProvider` 接口）。

| 文件 | 职责 |
|---|---|
| `registry.go` | `Registry` 结构：`sync.RWMutex` 保护的 config + 运行时 key-state map；`New`/`Config`/`Reload` |
| `providers.go` | Provider CRUD |
| `keys.go` | Key CRUD（provider 内） |
| `models.go` | Provider 自定义模型列表（`ListModels`、`AddModel`、`DeleteModel`、`UpdateModelQuotaType`、`UpdateModelAlias` [含前缀自动剥离 `sanitizeAlias`]、`UpdateModelNote`、`UpdateModelNIMOverride`、`ResolveModelAlias` [含容错剥离]、`GetModelByAliasOrID`） |
| `combos.go` | Combo CRUD；新增 `GetComboByID`(id) 方法供 combo 测速排序 handler 使用 |
| `quickslots.go` | QuickSlot（预设模型切换槽）CRUD（含 `sanitizeQuickSlotModels` 自动化简 `prefix/prefix/model` 条目） |
| `state.go` | per-key 运行时状态**访问**：`GetKeyState`（返回 `*keystate.KeyRuntimeState`）、`SnapshotKeyStates`/`snapshotKeyState`/`RestoreKeyState`/`ResetAllCooldowns`、probe records（`UpdateProbeRecord`/`GetProbeRecord`/`SnapshotProbeRecords`/`RestoreProbeRecord`）。**类型定义已迁出**至 `internal/keystate`。**2026-07-31：** `KeySnapshot` 新增 `ExhaustedModelLimits map[string]int`（持久化 `ModelQuotas` 中 `ModelRemaining==0` 的 model→limit 子集），`snapshotKeyState`/`RestoreKeyState` 同步此字段。 |
| `crud_test.go` / `reload_merge_test.go` / `state_test.go` | 测试 |
| `models_protocols_test.go` / `probe_records_test.go` | 新增 ModelDef.Protocols CRUD 与 probeRecords 运行时状态测试 |
| `text_review.go` | TextReview 处理池与切分模式 CRUD：`ListTextReviewNodes`/`AddTextReviewNode`/`UpdateTextReviewNode`/`DeleteTextReviewNode` + `ListSplitPatterns`/`AddSplitPattern`/`UpdateSplitPattern`/`DeleteSplitPattern`（线程安全，`cfgMu` 保护） |

<a id="keystate"></a>
**`internal/keystate/`（新包，2026-07-25）** — per-key 运行时状态**类型定义**抽离自 `registry/state.go`，打破原先 rotation→registry 的反向依赖：

| 文件 | 职责 |
|---|---|
| `state.go` | `KeyRuntimeState` 结构（`mu`/`BackoffLevel`/`ModelLocks`/`ModelStatus`/`ModelErrors`/`LastUsedAt`/`ConsecCount`/`RotatedAt`/`ModelQuotas`/`InFlight`/NIM 四字段）+ `QuotaInfo`；自带锁纯方法 `IncInFlight`/`DecInFlight`/`GetInFlight`/`Lock`/`Unlock`/`UpdateQuota`/`GetQuota`。无 map、无 registry/rotation/config/state 依赖（叶包，仅 sync+time） |

**依赖方向：** `keystate` ← `registry`（持有 map + snapshot/restore）与 ← `rotation`（类型 + `KeyStateProvider` 接口返回类型）；`rotation` 不再 import `registry`，无循环。map/snapshot/restore/reload-merge 留在 registry（与 config CRUD 强耦合，迁移无收益）。

---

## 5. `internal/rotation/` — Key 选择策略 + 冷却/退避 + NIM

移植自 9router `src/sse/services/auth.js`。架构基线见 [`docs/rotation-architecture.md`](docs/rotation-architecture.md)（含 SelectKey 算法、三种策略、两套退避系统、配额锁、NIM、错误分类、源码锚点）。

| 文件 | 职责 |
|---|---|
| `selector.go` | `KeySelector` 接口 + `Selector`：组合 key 选择与冷却；`SelectKey`/`OnKeyFailure`/`IsNIMEnabled`/NIM 钩子；定义 `KeyStateProvider` 接口（`GetProvider`/`GetKeyState`，`*registry.Registry` 结构性满足）——`Selector.reg` 字段类型为该接口，故 rotation **不 import registry**（改 import `keystate`） |
| `strategy.go` | 轮询策略（fill-first / round-robin / failover）+ stickyLimit |
| `cooldown.go` | 指数退避（1s→240s），429 日配额锁至次日 CST 00:05，per-model 锁；`CooldownManager` 接口新增 `SonestCooldown(providerID, model, excludeKeyIDs)` + `CooldownInfo`（最早 `ModelLocks[model]` 到期 + keyName/reason），供 proxy "无可用 key" 时等待最近冷却到期而非即时 502 |
| `ratelimit.go` | 每 key 请求速率记账 |
| `error_rules.go` | 上游错误分类（transient vs fatal，429/5xx 规则）；新增 `ActionPassThrough`（请求格式 4xx → 原样返回客户端，不重试/不锁/不排除，key 健康），400/422 默认 `ActionPassThrough`（文本规则优先可覆盖），并新增聚合器文本规则 `{BodyMatch:"upstream request failed", Action:ActionBackoff}`（聚合器自身上游瞬时失败 → 重试） |
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
| `handler.go` | `Handler`（基于接口装配，非具体类型；P1-6 后字段拆为窄能力：`reg ModelResolver` 保留供测试 + `quickSlots`/`providers`/`keyState`/`aliases`/`comboList` registry 侧 5 窄字段 + `keySel`/`nim`/`cooldown`/`quotaLock`/`rotSet` selector 侧 5 窄字段；`New` 签名不变）：路由 `/v1/*`，构造 HTTP client（普通/流式/管理 + 代理变体）；`pgUsage UsageRecorder` + `SetPgUsage`：Playground 来源请求专用 ring 注入；Anthropic 入口 `Messages`（`POST /v1/messages`，`handleProxy(..., EntryFormatAnthropic)`）；OpenAI Responses 入口 `Responses`（`POST /v1/responses`，`handleProxy(..., EntryFormatOpenAIResponses)`）；OpenAI Embeddings 入口 `Embeddings`（`POST /v1/embeddings`，`handleProxy(..., EntryFormatOpenAI)`）；新增 `quickSlotOnlyProvider func() bool` + `SetQuickSlotOnlyProvider` + `quickSlotOnly()` 方法，供 `ListModels` 过滤使用；新增 `logRequestsProvider`/`requestLogDir`/`SetLogRequestsProvider`/`logRequests()`/`SetRequestLogDir`/`TracesDir`/`TraceMgmtCall`/`SweepTraces` 字段与方法 |
| `interfaces.go` | handler 依赖的能力接口。P1-6 接口隔离：`KeyProvider` 拆为 5 窄接口 + composite——`KeySelector`/`NIMProvider`/`CooldownManager`/`QuotaLocker`/`RotationSettings`（24-52）组合为 `KeyProvider`（56-62）；`ModelResolver` 拆为 5 窄接口 + composite——`QuickSlotResolver`/`ProviderResolver`/`KeyStateAccessor`/`AliasResolver`/`ComboLister`（65-91）组合为 `ModelResolver`（100-106）；另有 `Logger`（16-21）、`ComboResolver`（111-114，`Resolve(name, entryFormat)`）、`UsageRecorder`（118-120）、`QuotaTracker`（125-128）。`Handler` 持有窄字段，`New` 入参仍为 `ModelResolver`/`KeyProvider` composite（向后兼容，行为不变）。`CooldownManager` 新增 `SonestCooldown`（`*rotation.Selector` 结构性满足，供 forward_retry 冷却等待） |
| `forward.go` | 转发路径共享叶级工具：`resolveDisplayModel`（日志显示名解析）、`requestCallerTag`+`maskAuth`+`clipStr`（控制台请求者标识：`src=`/masked `auth=`/`ua=`/`from=`，全 key 恒掩码，~80 字节硬上限）、`generateToolCallID`/`ensureToolCallIDs`（请求体 tool_call id 回填防御）、`writeError`/`maskURL`（响应工具）、`backfillThoughtSignatures`/`hasThoughtSignature`（Gemini `thought_signature` 回填）、`sessionKeyFromMessages`+`extractMessageContent`+`truncateRunes`+`reqLogTag`（会话连续性指纹：system+首条 user 内容各截 4096 rune 后 FNV-1a 64→8 hex，空=单发/未分组；`reqLogTag` 把 `|sess:<key>` 拼进 `[reqID]` 控制台日志标签，空 key 时仅 `[reqID]`） |
| `forward_request.go` | `(h *Handler) handleProxy`：`/v1/*` 请求解析/归一化入口（`MaxBytesReader` 32 MiB、`json.Unmarshal`、`model` 校验、quickslot 解析、combo 名分发、`SplitModel`+`GetProviderByPrefix`+`ResolveModelAlias`），带 `entryFormat` 参数；**软策略**：客户端用什么协议入口请求就按该协议转发，proxy 不再因 `provider.APIType` 拒绝请求（已移除入口协议严格匹配 400 块） |
| `forward_combo.go` | `(h *Handler) handleCombo`：combo/quickslot 策略路由（`fallback`/`round-robin`/`greedy-squirrel` 三分支逐目标调 `forwardWithRetry`，全失败回 502） |
| `forward_retry.go` | `(h *Handler) forwardWithRetry`：重试循环 + body 改写（替换 `model` 字段、注入 `stream_options`、调 `backfillThoughtSignatures`）；**reqID 提至循环顶部生成一次**（跨重试共享，关联 REQUEST/SEND/PROXY/错误行 + EntryTracker 条目）+ `callerTag`（`requestCallerTag(r)`）贯穿日志；**Part B 冷却等待**：`SelectKey` 失败时先调 `cooldown.SonestCooldown` 查最近 `ModelLock` 到期，有则 `select{Context|time.After(wait)}`（上限 30s）等待后重试一次 `SelectKey`，避免冷却窗口内并发请求即时 502 突发；仍返回 502 于真正耗尽；**非流式不再 keep-alive 刷新**（H-8，见前）；+ `broadcastRequestStart`/`broadcastTTFT`/`broadcastTokens` 三个事件广播辅助 |
| `upstream.go` | 委托 `internal/urlutil` 的 `BuildUpstreamURL`/`normalizeBaseURL`/`isOllamaBaseURL`/`normalizeOllamaBaseURL` 进行 URL 构造；`forwardUpstream` 按 `entryFormat` 三分支（OpenAI Chat / Anthropic / OpenAI Responses）；**统一上游请求构造器** `buildUpstreamRequest(ctx, sel, body, endpointPath, authBearer bool)`（upstream.go:84）：URL 由 `urlutil.BuildUpstreamURL` 统一构造；`authBearer=true` 时设 `Authorization: Bearer <key>`（OpenAI Chat / Responses 入口），`authBearer=false` 时调 `setAnthropicHeaders`（`x-api-key`+`anthropic-version`+可选 `anthropic-beta`，绝不设 `Authorization`，Anthropic 入口）；原 `buildAnthropicUpstreamRequest`/`buildResponsesUpstreamRequest` 两个独立函数已于 Phase 2 合并为单一 `buildUpstreamRequest` + `authBearer` 开关 |
| `stream.go` | SSE 流式 / 非流式 I/O 透传循环：`(h *Handler) streamResponse`（`http.Flusher` 逐 chunk 转发 + 客户端断开保护）与 `(h *Handler) passThroughResponse`（非流式整段读取透传上游状态码）；委托 `internal/sse` 的 `SSELineBuffer`/`NormalizeSSEChunk` 行帧缓冲与 chunk 规范化；`entryFormat` 控制 anthropic 走 `parseAnthropicSSEUsage`、OpenAI Chat/Responses 走 `util.ExtractTokens`；客户端断开 → `clientDisconnected` 标志 → `break` → `recordUsage(status="error")` |
| `stream_usage.go` | OpenAI 格式 token/usage 解析：`sseContentLength`（content 字段字节扫描）、`parseSSEChunkDelta`+`chunkDelta`、`formatTokenDelta`/`itoa`（usage chunk 摘要格式化） |
| `stream_anthropic.go` | Anthropic 专用 usage 解析：`parseAnthropicSSEUsage`（读 `message_start`/`message_delta` 的 input/output tokens） |
| `stream_debug.go` | 调试态 SSE chunk 广播：`(h *Handler) parseAndBroadcastChunk`（`entryFormat == EntryFormatOpenAI` 时经 `RequestUpdates.Broadcast` 发 `request-chunk` 事件） |
| `retry.go` | 跨 key/combo 故障转移的重试状态机；`handleUpstreamError` 改返回 `bool`（true=4xx 请求格式错误已 `ActionPassThrough` 原样写客户端 + 停止重试，false=继续切 key），新增 pass-through 分支（不调 `OnKeyFailure`/`MarkRateLimited`/不排除 key，转发上游原始 body+状态码）；各动作新增中文后果 WARN（指数退避/冷却 Ns/锁至次日 CST 00:05）；`logRequest`/`handleNetworkError`/`handle429`/`handleUpstreamError` 新增 `sessionKey string` 参数贯穿 `[reqID|sess:<key>]` 控制台标签（`forward.go::reqLogTag`，空 key 退化为 `[reqID]`）+ callerTag + 网络错误 WARN，并下传至各 `recordUsage` 调用点 |
| `models.go` | 模型列表/解析辅助；`ListModels` 新增 `quickSlotOnly()` 门控——开启时仅返回 QuickSlot 模型，跳过 provider/combo |
| `recorder.go` | `recordUsage`：按 source 分流写入 Recent Requests ring 或 Playground ring；payload/headers 现始终捕获（`captureDetails` 恒为 `true`，2026-07-26 与 debugMode 解耦），使 Recent Requests 在任意 debugMode 状态下可查看；reqBody 截断 64KB、respBody 截断 512KB；内存开销由 ring 容量（`config.UsageRingSize`，默认 500）× 单条 body 大小封顶（见 proxy-architecture.md 2026-07-26 更新）；新增 `decision string`、`provenance string` 参数写入 `usage.Entry`（会话连续性指纹由 `forward.go::sessionKeyFromMessages` 在 `handleProxy` 计算后经 `forwardWithRetry`/`handleCombo`/`retry.go` handlers/`stream.go` 一路下传至所有 `recordUsage` 调用点）；`writeRequestLog` hook 在 body 截断前调用（保证完整 body 被捕获），受 `h.logRequests()` 运行时原子开关（加载自持久化 `cfg.Trace.Enabled`）控制；所有约 15 个调用点在 `forward_retry.go`/`stream.go`/`retry.go` 中传递 decision 字符串（如 "success"、"backoff 2s, switch key"、"429 quota exhausted → daily lock"、"pass-through 4xx to client"、"5xx backoff 500ms"） |
| `request_log.go` | 两层 JSONL 追踪日志系统（`traceLine` 结构体为 JSONL 行 schema）：`writeRequestLog` 写入 `traces/index-YYYYMMDD.jsonl`（每日轮转，同 reqID 末次写入覆盖）+ `traces/req/<reqID>.jsonl`（追加，仅首次调用写 request 行，后续每次调用写 attempt 行）；`TraceMgmtCall` 方法捕获 ManagementClient 路径（probe/combo-speedtest/providers-probe）的调用，attempt n=1，decision="management probe"；`SweepTraces(ctx, retainDays, maxDiskMB)` + `sweepTracesOnce` 后台保留清理（按 modifyTime/文件名日期删除过期 index+req 文件，按 MaxDiskMB 删除最旧 req 文件），在 `app.go:191` 以 `go a.proxyHandler.SweepTraces(a.shutdownCtx, cfg.Trace.RetainDays, cfg.Trace.MaxDiskMB)` 启动，立即执行一次后每小时运行，shutdown ctx 停止；`TracesDir() string` getter 返回 `h.requestLogDir`；敏感请求头（`Authorization`/`X-Api-Key`）遮蔽为 `***`+末 4 字符（保留 scheme 前缀），base64 图像数据（data URLs、`b64_json`、Anthropic `{type:base64,data:}`）剥离；`sanitizeFilename`/`maskSecret`/`maskToken`/`isSecretHeader`/`formatBody`/`stripBase64Images`/`stripBase64InMap` 辅助函数（已测试） |
| `request_events.go` | 生成全局唯一 request ID |
| `entry_tracker.go` | `EntryTracker`：在途（processing）usage 条目并发 map；`Register`/`Remove`/`Get`/`All`/`Exists`/`SetTTFT`/`UpdateTokens`；`SweepStale(maxAge)` 兜底清理超时条目（返回并删除，由 caller 写 error 记录到 RingBuffer + 广播 request-done） |
| `inflight.go` | `inflightEntry`：单条在途流式请求的实时输出 |
| `broadcaster.go` | `Broadcaster`：把事件扇出到所有 SSE 订阅 channel |
| `signature_cache.go` | `SignatureCacheProvider` 接口 + `SignatureCache`（TTL+LRU 惰性驱逐）：缓存 Gemini `thought_signature` 用于流式回填；**`extractThoughtSignature`**（扫描 OpenAI SSE payload 的 `delta.tool_calls[].extra_content.google.thought_signature`，流式中捕获签名 `sigCache.Put`）亦位于此文件，作为缓存的自然伴生提取器 |
| `*_test.go` | 测试（handler/retry/stream/e2e/signature 多套）；新增 `responses_test.go`（OpenAI Responses 路由）、`anthropic_test.go`（Anthropic 入口）、`anthropic_usage_test.go`（parseAnthropicSSEUsage） |

> Gemini `thought_signature` 自动回填：流式中提取签名并缓存，非流式响应自动补全，对 OpenAI 兼容端点透明（见 commit `c2f89c6`）。

---

## 8. `internal/usage/` — 内存统计 + 配额

| 文件 | 职责 |
|---|---|
| `ring.go` | `RingBuffer`：有界环形缓冲（默认 500 条）+ 摘要；`Entry` 结构体新增 `SessionKey string`（`json:"sessionKey,omitempty"`，会话连续性指纹，空=单发/未分组，由 proxy `sessionKeyFromMessages` 计算，经 `/usage` JSON 自动暴露） |
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
<!-- last verified: 2026-07-27 -->

### 10.10 `internal/api/trace/` — 追踪读取 API

认证保护（`/api/traces` 路径下），提供追踪数据的只读查询接口。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + 三个 GET 路由：`GET /api/traces/dates` → `{"dates":[{"date","count","sizeBytes"}],"dir"}`（按日期降序）；`GET /api/traces/index?date=YYYYMMDD&limit=200&offset=0&status=&q=` → `{"lines":[...],"total":N}`（ newest-first， filtered+paginated）；`GET /api/traces/req/{reqID}` → `{"reqID","lines":[...]}`（ chronological: request line + attempt lines）。`sanitizePathParam` 路径穿越防护（拒绝 `/`、`\`、`..`、null 字节）。 |

### 10.11 `internal/api/settings/` — Settings / 生命周期

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `getSettings`/`updateSettings`。GET 返回 `trace` 字段：`{"trace":{"enabled":<live>,"retainDays":<cfg>,"maxDiskMB":<cfg>}}`；PATCH 接受 `{"trace":{"enabled?","retainDays?","maxDiskMB?"}}`（部分更新，持久化到 `cfg.Trace`），同时更新运行时原子镜像 `apibase.Deps.LogRequests`。 |

| `api_test.go` | API 集成测试 |
| `probe_test.go` / `probe_proto_test.go` | 探测协议测试（仍在根包，引用 `apibase` 构造 `*Deps`） |
| `bulk_keys_test.go` / `selector_hot_reload_test.go` | 批量 key / 选择器热重载测试 |

### 10.1 `internal/api/apibase/` — 共享依赖与辅助

为 `internal/api` 子包提供共享类型和辅助函数，避免父包与子包间的循环导入。

| 文件 | 职责 |
|---|---|
| `deps.go` | `Deps` 结构体（`Reg`/`ConfigPath`/`Usage`/`PgUsage`/`QuotaTracker`/`Logger`/`ProxyHandler`/`Selector`/`ComboRes`/`DownloadMgr`/`Shutdown`/`TestClient`/`MonitorMgr`/`DebugMode`/`QuickSlotOnly`/`LogRequests`/`RestartFn`/`ServerCfgFn`/`UpstreamTimeoutFn`/`StateSaveFn`/`TerminalState`/`Trace`（`TraceConfig`，含 `Enabled`/`RetainDays`/`MaxDiskMB`））+ `TerminalState`（`Mu sync.Mutex` + `Term *terminal.Session`）+ `SaveConfig`/`SaveConfigAndReload` 方法 + `WriteAPIError`/`GenerateID`/`SyncIDCounter`/`CheckPortAvailable`/`ValidateBaseURL`/`IsBlockedSSRFHost` 函数 |

### 10.2 `internal/api/auth/` — 鉴权

| 文件 | 职责 |
|---|---|
| `handler.go` | `Handler` 结构体 + `Register`/`AuthMiddleware`/`AuthStatusHandler`/`LoginHandler`/`LogoutHandler` + `SessionStore`/`GenerateToken`/`IsValidSession`/`SetSessionCookie` |
| `rate_limit.go` | 登录速率限制（`loginRateLimiter`） |
| `auth_test.go` | 测试 |

### 10.3 `internal/api/anysearch/` — AnySearch 搜索代理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `anySearchHandler`/`anySearchSubDomainsHandler`/`anySearchExtractHandler`，委托 `internal/anysearch.Client` 调用 JSON-RPC API |

### 10.4 `internal/api/combos/` — Combo CRUD + 测速

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listCombos`/`createCombo`/`updateCombo`/`reorderCombo`/`deleteCombo`/`getCombo` + `comboSpeedTest`（SSE 流式测速，`comboSpeedCache` 进程内缓存）+ 辅助 `fullSortedOrder`/`probeComboModel`/`firstActiveKey`/`extractContentFromSSE` |

### 10.5 `internal/api/compress/` — 响应压缩中间件

| 文件 | 职责 |
|---|---|
| `compress.go` | Brotli/gzip 响应压缩中间件；对 `/v1/images/generations` 与 `/v1/images/edits` 直接放行（见 proxy-architecture.md §8.7） |

### 10.6 `internal/api/console_logs/` — 控制台日志 SSE

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `getConsoleLogs`/`streamConsoleLogs`/`clearConsoleLogs` |

### 10.7 `internal/api/download/` — 下载任务管理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `createDownload`/`listDownloads`/`getDownload`/`cancelDownload`/`removeDownload`/`clearCompletedDownloads`/`streamDownloadEvents`/`getDownloadLog`/`getVideoInfo`/`getPlaylistInfo`/`createPlaylistDownload`/`playDownloadFile`/`openDownloadDir`/`retryDownloadTask`/`openExternalURL`/`browseSystemPath` + `validateDownloadURL`/`validateDownloadDir` 辅助（SSRF 拦截经 `apibase.IsBlockedSSRFHost`） |

### 10.8 `internal/api/editor/` — 编辑器后端

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `editorOpen`/`editorSave`。`/api/editor/*` 独立于 `/api` 组外以绕过 1MB body 上限（最大 32MB） |

### 10.9 `internal/api/gallery/` — Gallery HTTP handler

Gallery 图片查看器的 HTTP 路由层。zip 解析与 TIFF 转码能力委托顶层 `internal/gallery/` 包；本子包仅持有 HTTP handler、会话 LRU 存储、AI 审核编排。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` 结构体（字段 `d`/`sessions`/`reviews`/`media`/`proxy`）+ `NewHandler` + `Register` + 空白图片格式 decoder import + `proxyCaller` 接口 |
| `session_store.go` | 内存 zip 会话 LRU 存储（`gallerySessionStore`/`zipSession`/`newGallerySessionID`），Handler 字段 `h.sessions` |
| `fs_handlers.go` | Gallery 文件系统 handlers + 辅助（`isGalleryFile`/`isGalleryZip`/`galleryFsEntry`/`listGalleryFiles`/`galleryOpenDir`/`ListDir`/`ServeFile`/`DeleteFs`/`OpenFolder`/`PastePaths`） |
| `zip_handlers.go` | 内存 zip 会话 handlers（`galleryListZip`/`GetZipEntry`/`DeleteZipSession`/`TouchSession`/`ConvertTiff`/`DeleteZipEntry`/`ZipFromPath`/`ZipWriteback`） |
| `review_engine.go` | AI 审核引擎核心（`reviewTask`/`runReview`/`analyzeImage`/`sendVisionRequest`/`mimeTypeForEntry`/`resizeImage`/`selectReviewIndices`/`selectHeadTailIndices`） |
| `review_handlers.go` | AI 审核 HTTP handlers（`startReviewRequest`/`genPromptRequest`/`galleryStartReview`/`ReviewStatus`/`CancelReview`/`GeneratePrompt`） |
| `edit_handlers.go` | Gallery 媒体编辑（ffmpeg）handlers（`resolveFfmpeg`/`probeRequest`/`galleryEditFfmpegStatus`/`Probe`/`SubtitleUpload`/`Start`/`Status`/`Cancel`/`ExtractZipEntry`/`UploadTemp`/`ZipOutputs`/`ZipWriteback`）；Handler 字段 `h.media`（`*mediaedit.Manager`） |
| `register_test.go` | 测试：`gallerySessionStore` LRU 驱逐契约（容量 128，最早会话先驱逐）、`touch` MRU 提升、`remove` 幂等；HTTP 层 `DELETE /zip/{sessionId}`（204）与 `POST /zip/{sessionId}/touch`（204/404），并验证 chi 区分 `DELETE /zip/{sessionId}`（会话删除）与 `DELETE /zip/{sessionId}/*`（条目删除） |


### 10.9a `internal/mediaedit/` — Gallery 媒体编辑器（ffmpeg job runner）

自包含的 ffmpeg 子进程 job runner（leaf 包，不导入 config/registry/api）。接收 ffmpeg 路径与参数经 method args 传入，为 Gallery UI 提供图片/视频转码、裁剪、字幕烧录能力。

| 文件 | 职责 |
|---|---|
| `types.go` | `Job`/`JobStatus`/`ProbeResult`/`StartRequest`（含可选 `OutputName`——无扩展名 stem，OutputDir 非覆盖分支优先用作输出文件名 + `buildArgs` 的 `ext`，避免临时输入名泄漏到保存的文件/zip 条目名）+ per-operation params 类型（`ImageTranscodeParams`/`VideoTranscodeParams`/`VideoTrimParams`/`VideoSubtitleParams`） |
| `binary.go` | `ResolveFfmpeg`（config → `FFMPEG_PATH` env → `exec.LookPath`）+ `ResolveFfprobe`（`FFPROBE_PATH` env → 同目录派生 → `exec.LookPath`） |
| `probe.go` | `Probe(ffprobePath, path)`：`ffprobe -v error -select_streams ... -of json` → `ProbeResult`（宽/高/编码/时长/帧率/IsImage/HasAudio），含 15s 超时与 `procutil.SetProcessGroup` |
| `args.go` | 四种操作的 ffmpeg 参数构造器（`BuildImageTranscodeArgs`/`BuildVideoTranscodeArgs`/`BuildVideoTrimArgs`/`BuildVideoSubtitleArgs`）→ `(args, desc, ext, error)`；含编码-容器兼容校验、质量映射（JPEG `-q:v`/PNG `-compression_level`/H264-H265-VP9-AV1 CRF）、`BuildOutputPath`（非覆盖时追加 `_desc` 后缀并去重） |
| `executor.go` | `RunFfmpeg`：`exec.CommandContext` + `procutil.SetProcessGroup`/`KillProcessGroup` + StdoutPipe（progress 解析 `out_time_us`→百分比）+ StderrPipe（`tailBuffer` 16KB）+ `ErrCancelled`；`tailBuffer` 定长环形缓冲 |
| `manager.go` | `Manager`（`sync.Map` 存 job）：`Start`（验证输入→构建 args→探测时长→选输出路径：覆盖同格式→原文件（`runJob` temp+rename 覆盖）、覆盖跨格式→`<dir>/<stem><newExt>`（ffmpeg 按输出扩展名选编码器）+ 成功后 `removeOnSuccess` 删原文件、非覆盖无 OutputDir→同目录 `{base}_{desc}.{ext}` 去重、非覆盖有 OutputDir→`relocateOutput(OutputDir, outStem+ext)`，`outStem` 优先 `req.OutputName` 否则 `InputPath` stem →`generateID`→后台 `runJob(…, removeOnSuccess)`）/`Get`/`Cancel`/`ProbeMedia` |
| `args_test.go` | 参数构建器测试（格式/质量/缩放/裁剪/字幕/兼容性校验/输出路径去重） |
| `manager_test.go` | 集成测试（需 ffmpeg，否则 skip）：探针、图片转码、跨格式覆盖模式（`TestManager_TranscodeImage_Overwrite`——png→webp 验证 outputPath=`source.webp` + 原 `source.png` 删除）、取消、job snapshot、`OutputName` 命名（`TestManager_TranscodeImage_OutputName`/`_Dedup`——构造 `gallery-edit-upload-XXXX.png` 临时输入 + `OutputName="vacation_photo"` → `vacation_photo.webp`，二次同 stem → `_2`） |
> Gallery HTTP handler（`internal/api/gallery/edit_handlers.go`）通过 `h.media`（`*Manager`）与 `resolveFfmpeg` 助手调用此包。路由挂载于 `/api/gallery/edit/*`（`/api/gallery` 组，绕过 1MB body 上限，auth-gated）。
>
> 2026-07-29 更新（Gallery 编辑控制台面板联动）：`types.go` `Job` 新增 `Command string`（ffmpeg 完整命令行，`json:"command"`）+ `logBuf *tailBuffer`（运行期实时日志引用，不序列化），`Snapshot()` 运行中优先 `logBuf.Read()`、结束回退 `LogTail`；`executor.go` `tailBuffer` 加 `sync.Mutex`（`Append`/`Read` 自同步）、提取包级 `ffmpegCommonFlags`、新增导出 `FfmpegCommandString()`、移除 `RunFfmpeg` 内局部 `mu`；`manager.go` `runJob` 调 `RunFfmpeg` 前置 `job.Command`/`job.logBuf`、结束后清 `logBuf=nil`；`edit_handlers.go` `galleryEditStatus` 响应新增 `logTail`/`command`（经 `Get→Snapshot` 取运行期实时值，供前端右侧控制台面板显示 ffmpeg 指令与实时输出，详见 `docs/playground-architecture.md` 增补#20）。

### 10.10 `internal/api/image/` — 图片保存与同源代理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `saveImage`（`POST /api/save-image`，下载图片到 `ImageSaveDir`）+ `imageProxy`（`GET /api/image-proxy`，同源代理避免 CORS）+ `saveImageRequest` 类型 + `extensionFromContentType` 辅助（SSRF 拦截经 `apibase.IsBlockedSSRFHost`） |

### 10.11 `internal/api/keys/` — Key 管理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listKeys`/`createKey`/`bulkAddKeys`/`updateKey`/`deleteKey`/`getKeyState` |

### 10.12 `internal/api/models/` — 模型列表

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listModels`（`/api/models`，返回 `prefix/alias` 或 `prefix/model_id`） |

### 10.13 `internal/api/monitor/` — Monitor 命令状态

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `getMonitorStatus`/`startMonitor`/`stopMonitor`/`streamMonitor`（SSE，含 buffered replay + keepalive） |

### 10.14 `internal/api/probe/` — 模型协议探测

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（`POST /providers/{id}/models/test-proto`、`POST /providers/{id}/models/test-all`）+ `probeModel`/`probeKey` + 通用 `probeEndpoint`（4 协议：`openai-compat`/`openai-responses`/`anthropic`/`openai-embedding`）+ `ProbeResult` 类型 + 协议常量与测试 prompt |

### 10.15 `internal/api/providers/` — Provider CRUD / 校验 / 模型管理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（17 路由：provider CRUD 6 + test 1 + model 10）+ `listProviders`/`createProvider`/`validateProvider`/`updateProvider`/`reorderProvider`/`deleteProvider`/`testProviderKey`/`fetchProviderModels`/`addProviderModel`/`updateModelQuota`/`updateModelAlias`/`updateModelNote`/`updateModelNIM`/`updateModelKind`/`updateModelImgProtocol`/`updateModelImgSizes`/`updateModelProtocols`/`deleteProviderModel`（BaseURL 校验经 `apibase.ValidateBaseURL`） |

### 10.16 `internal/api/quickslots/` — QuickSlot 管理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listQuickSlots`/`createQuickSlot`/`updateQuickSlot`/`deleteQuickSlot` |

### 10.17 `internal/api/review_presets/` — 审核预设

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listReviewPresets`/`upsertReviewPreset`/`deleteReviewPreset` |

### 10.18 `internal/api/settings/` — Settings / 生命周期

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（`GET/PATCH /settings`、`POST /reload`、`POST /shutdown`）+ `getSettings`/`updateSettings`/`reload`/`handleShutdown`/`validateProxyConfig`（端口可用性经 `apibase.CheckPortAvailable`；debug/quickSlotOnly 开关写 `atomic.Bool`；restart/serverCfg/upstreamTimeout 回调） |

### 10.19 `internal/api/sse/` — Usage/inflight 事件 SSE 流

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `streamUsageEvents`（`GET /api/usage/events`） |

### 10.20 `internal/api/terminal/` — Terminal WebSocket

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（`GET /terminal/ws`、`POST /terminal/stop`）+ `handleTerminalWS`（debug-mode 门 + 单会话守卫，状态经 `apibase.Deps.TerminalState`）+ `stopTerminal` + `upgrader` |

### 10.21 `internal/api/usage/` — 用量 / 配额 / 模型 key 状态

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（7 路由：`GET /usage`、`GET /usage/playground`、`GET /usage/summary`、`GET /usage/quotas`、`GET /usage/model-keys`、`DELETE /usage`、`POST /usage/reset-quota`）+ `getUsage`/`getPlaygroundUsage`/`getUsageSummary`/`getQuotas`/`getModelKeys`/`clearUsage`/`resetQuota` + `getIntQuery` 辅助。**2026-07-31：** `getQuotas` 现从 per-key `KeyRuntimeState.ModelQuotas`（经 `GetQuota` 锁安全读取）重算 `TotalUsed`/`TotalCapacity`，覆盖 `QuotaTracker` 纯会话聚合，使重启后 exhausted key 的配额贡献仍计入 provider 级总量。 |

### 10.22 `internal/gallery/` — Gallery 图片查看器后端（库）

为前端 Gallery 分页（图片查看器，playground 构建变体）提供 zip 解析与 TIFF 转码能力。不持久化、不写盘；状态仅驻进程内存（zip 会话 LRU）。

| 文件 | 职责 |
|---|---|
| `zip.go` | `ListZipEntries(io.ReaderAt,size)` 列 zip 内图片条目（按名排序、过滤非图片）; `GetZipEntry(reader,size,name)` 取单个条目字节; `CleanZipPath`（导出，`\\`→`/`、trim 前导 `/`、`path.Clean`，带 doc comment）; `ErrEntryNotFound`; `contentTypeForExt`。所有调用方（`zip_delete.go`/`zip_replace.go`/测试）已更新为 `gallerylib.CleanZipPath` |
| `zip_replace.go` | `ReplaceZipEntries(data, replacements map[string][]byte) ([]byte, Manifest, error)`：zip 条目替换/原位回写核心——按已清洗 zipPath 替换命中条目内容、未命中条目字节级保留（含 Method/Modified/Extra/comment、归档注释），输出新归档字节 + 新 Manifest。被 `internal/api/gallery/zip_handlers.go` `galleryEditZipWriteback` 调用（replace-original convert-all/单图 zip 路径），支持 Store+Deflate（及任何 stdlib 支持的方法）。调用方负责 zipPath 清洗（handler 内调用 `gallerylib.CleanZipPath`，此前 `cleanZipPathNormalize` 重复函数已移除）。不依赖 `zip_delete.go` |
| `zip_replace_test.go` | 测试：`TestReplaceZipEntries_Store_ReplacesAndPreserves` / `_Deflate_ReplacesAndPreserves`（验证 deflate 实际压缩：结果尺寸<裸总和）/ `_MissingKey_NoOp`（空映射/未知键字节等价于原）/ `_CleanedKeyContract`（调用方提供已清洗键的契约） |
| `tiff.go` | `ConvertTIFFToJPEG(io.Reader,quality)` / `ConvertTIFFBlobToJPEG([]byte,quality)`：用 `golang.org/x/image/tiff` 解码后重编码为 JPEG（Chromium/WebView2 原生不支持 `<img>` 显示 TIFF） |
| `zip_test.go` / `tiff_test.go` | 测试 |

架构基线见 [`docs/playground-architecture.md`](docs/playground-architecture.md)（Gallery 一节）。

引入依赖：`golang.org/x/image`（webp/bmp/tiff/draw 子包），纯 Go 无 CGO。

### 10.23 `internal/api/textreview/` — AI 文本审核 HTTP handler

AI 文本审核（Text Review）4 步向导的 HTTP 路由层：处理节点池/切分模式/默认 prompt 的 CRUD 与会话调度端点（SSE 进度 + pause/resume/stop/reprocess）。会话引擎委托 [`internal/textreview`](#textreview)；`NodePersister`（ramp-down 落盘）实现在 `nodepersister.go`。`/api/text-review/*` 独立于 `/api` 组外以绕过 1MB body 上限（最大 32MB，与会话携带的 `rawText` 相称），仍经 `AuthMiddleware` 鉴权。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（路由注册 + 文档注释列出全部端点）+ 配置 CRUD handler（`listReviewNodes`/`upsertReviewNode`/`deleteReviewNode`/`listSplitPatterns`/`upsertSplitPattern`/`deleteSplitPattern`/`getPromptDefault`）+ `engineOnce` 懒构造 `*tr.Engine`（默认 `ProxyCleaner`，测试可经 `SetCleanerForTest` 注入 fake）+ 内置默认清理 system prompt 常量 |
| `sessions.go` | 会话/调度 handler：`createSession`（POST `/sessions`）/`getSession`（GET `/sessions/{id}` 快照）/`streamSessionEvents`（GET `/sessions/{id}/events` SSE 实时流）/`pauseSession`/`resumeSession`/`stopSession`/`reprocessChapter`（POST `/sessions/{id}/chapters/{idx}/reprocess`） |
| `nodepersister.go` | `registryPersister`：`tr.NodePersister` 生产实现，ramp-down 决策（`UpdateNodeConcurrency`/`DisableNode`）写回 registry + `SaveConfig` 持久化到 `config.yaml` |
| `routes_test.go` / `sessions_test.go` | 测试：路由注册契约 + 会话端点（含 fake Cleaner） |

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
| `open_windows.go` | `windows` | `OpenInFileManager`（ShellExecute + `/select,`）、`OpenInBrowser`（rundll32）、`OpenFilePicker`/`OpenDirectoryPicker`（原生 COM IFileOpenDialog，现代 Windows 10/11 对话框，返回绝对路径）；2026-07-25 修正 `IFileDialog::GetResult` vtable 索引 26→20，修复确认选择时进程闪退 |
| `open_other.go` | `!windows` | macOS（`open -R`/`osascript`）、Linux（`xdg-open`）实现；文件/目录选择器 Linux 返回 `ErrUnsupportedPlatform` |
| `clipboard_windows.go` | `windows` | `GetClipboardFilePaths()`：读取 Windows 剪贴板 CF_HDROP 格式文件路径（OpenClipboard + DragQueryFileW） |
| `clipboard_other.go` | `!windows` | `GetClipboardFilePaths()` 返回 nil（非 Windows 平台不支持） |
| `atomic_test.go` | — | 测试 |

---

## 13. `internal/util/` — 通用辅助

| 文件 | 职责 |
|---|---|
| `util.go` | `SplitModel("provider/model")`、`TruncStr`、JSON 辅助 |


## 13a. `internal/sse/` — SSE  framing 工具

通用 SSE（Server-Sent Events）行帧缓冲、data payload 提取与 chunk 规范化。从 `internal/proxy/stream.go` 中提取，供 proxy 处理器与 API 探测/测速代码共同使用。无外部依赖（仅 stdlib）。

| 文件 | 职责 |
|---|---|
| `sse.go` | `SSELineBuffer`（行帧缓冲 + Feed/Remaining）、`SSEDataPayloads`（提取 data payload）、`NormalizeSSEChunk`（choices:null → [] 规范化） |
| `sse_test.go` | 测试 |

---

## 13b. `internal/urlutil/` — URL 规范化工具

通用 URL 归一化与上游端点构造工具。从 `internal/proxy/upstream.go` 中提取，供 proxy 转发器与 API 探测/管理代码共同使用。无外部依赖（仅 stdlib）。

| 文件 | 职责 |
|---|---|
| `urlutil.go` | `BuildUpstreamURL`（统一端点 URL 拼接 + 启发式 A 版本段检测）、`normalizeBaseURL`（剥除已知 endpoint 后缀）、`isOllamaBaseURL`/`normalizeOllamaBaseURL`（Ollama 特例）、`isHostRoot`（路径检测） |
| `urlutil_test.go` | 测试 |

---


## 13c. `internal/procutil/` — 进程工具（跨平台进程组管理）

跨平台进程组管理工具，从 `internal/download/kill_unix.go` 和 `internal/monitor/manager_unix.go` 中提取的重复代码统一为共享包。Unix 实现：SIGTERM → 2s grace → SIGKILL 兜底；Windows 实现：`taskkill /T /F`。无外部依赖（仅 stdlib）。

| 文件 | build tag | 职责 |
|---|---|---|
| `procutil_unix.go` | `!windows` | `KillProcessGroup(pid)` 先 SIGTERM 再 2s 后 SIGKILL；`SetProcessGroup(cmd)` 设 `Setpgid=true` |
| `procutil_windows.go` | `windows` | `KillProcessGroup(pid)` 执行 `taskkill /PID /T /F`；`SetProcessGroup(cmd)` 设 `CREATE_NEW_PROCESS_GROUP\|createNoWindow` |

`internal/download/` 和 `internal/monitor/` 的平台文件均委托此包实现进程组管理。
---

## 14. `internal/terminal/` — 交互式终端

Debug Mode 下的完整交互式终端（xterm.js + WebSocket + ConPTY/PTY），支持 vim、Ctrl+C、Tab 补全，会话持久保持。架构基线见 [`docs/terminal-monitor-architecture.md`](docs/terminal-monitor-architecture.md)（与 Monitor 合著，含会话模型、调试门控、单会话守卫、平台进程生成、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `session.go` | — | PTY 会话（`go-pty` + `gorilla/websocket`）；`buildShellEnv()`（session.go:46）构建子进程 env |
| `path.go` | — | `buildShellEnv`/`buildShellEnvWith`/`withAugmentedPath`：基于 `os.Environ()` 构建 shell env，Windows 上若继承 PATH 缺失注册表条目则用注册表 PATH 补齐，末尾附加 `TERM=xterm-256color` |
| `path_windows.go` | `windows` | `mergedPathFromRegistry()`：读 HKLM 系统 PATH + HKCU 用户 PATH（REG_EXPAND_SZ 经 `os.ExpandEnv` 展开），合并返回；失败返回 "" 回落到继承 PATH |
| `path_other.go` | `!windows` | `mergedPathFromRegistry()` no-op（返回 ""）；非 Windows 以 `os.Environ()` 为唯一来源 |
| `path_test.go` | — | `withAugmentedPath`/`buildShellEnv` 合并逻辑测试（跨平台，单组件路径条目保证确定性） |
| `process_windows.go` | `windows` | ConPTY 进程生成（`killProcessGroup` taskkill /T /F） |
| `process_unix.go` | `!windows` | PTY 进程生成（`killProcessGroup` SIGKILL 进程组） |
| `session_test.go` | — | 测试 |
| `session_lifecycle_test.go` | — | Close 幂等、resize 解析、NewSession 失败清理、端到端 PTY 测试 |
---

## 15. `internal/monitor/` — Monitor 命令

实时流式运行白名单命令（如 `nvidia-smi -l 1`），输出内嵌 Console 页面。架构基线见 [`docs/terminal-monitor-architecture.md`](docs/terminal-monitor-architecture.md)（与 Terminal 合著，含 Manager、白名单、SSE 流、平台进程生成、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `manager.go` | — | 单条 monitor 命令调度 + 输出流 |
| `manager_windows.go` | `windows` | Windows 进程 spawn（委托 `internal/procutil`） |
| `manager_unix.go` | `!windows` | Unix 进程 spawn（委托 `internal/procutil`） |
| `manager_test.go` | — | 测试 |

---

## 16. `internal/download/` — 视频/音频下载

基于 yt-dlp + ffmpeg 的下载任务队列/执行器（VidBee 风格 Go 原生移植，无持久化）。架构基线见 [`docs/download-architecture.md`](docs/download-architecture.md)（含任务生命周期、yt-dlp 参数构造、API 端点、与归档计划的漂移、源码锚点）。

| 文件 | build tag | 职责 |
|---|---|---|
| `types.go` | — | 下载任务类型（Task/Progress/状态常量/VideoInfo/PlaylistInfo/CreateTaskInput） |
| `args.go` | — | yt-dlp 参数构造核心：RuntimeSettings、常量、BuildDownloadArgs/BuildVideoInfoArgs/BuildPlaylistInfoArgs/FormatYtDlpCommand/quoteArg |
| `formats.go` | — | 格式选择器与质量映射：resolveVideoFormatSelector/resolveAudioFormatSelector/qualityToVideoHeight/qualityToAudioAbr/dedupe |
| `network.go` | — | 网络参数与 URL 识别：appendNetworkArgs/isYouTubeURL/isBilibiliURL/hostOf/resolveFfmpegDir/isDir |
| `manager.go` | — | Manager 核心：结构体/任务存储与顺序、NewManager/UpdateSettings/Started/CreateTask/GetVideoInfo/GetPlaylistInfo/snapshot/isTerminal/generateID/fileSizeOf |
| `lifecycle.go` | — | 任务生命周期变更：CancelTask/RetryTask/ClearCompleted/RemoveTask |
| `worker.go` | — | worker 池与执行循环：Start/Stop/worker/processTask/finalizeTask/updateTaskProgress |
| `events.go` | — | SSE 事件总线：Event/Subscribe/Unsubscribe/publishEvent |
| `playlist.go` | — | 播放列表展开：CreatePlaylistTask |
| `executor.go` | — | Executor 核心：ErrCancelled/Executor/NewExecutor/Execute/ExecuteInfo/ExecutePlaylistInfo/runCapture |
| `progress.go` | — | 进度解析与尾部缓冲：progressRe/parseProgressLine/parseSize/parseSpeed/parseETA/processingPatterns/hasPostprocessSignal/tailBuffer |
| `binary.go` | — | yt-dlp/ffmpeg 路径解析与输出文件提取：resolveYtDlpPath/resolveFfmpegPath/extractSavedFilePath |
| `parse.go` | — | 错误分类与 JSON 解析：classifyExitError/wrapInfoError/parseVideoInfoJSON/parsePlaylistInfoJSON |
| `kill_windows.go` | `windows` | 进程终止（委托 `internal/procutil`） |
| `kill_unix.go` | `!windows` | 进程终止（委托 `internal/procutil`） |
| `download_test.go` | — | 测试 |

> 外部依赖：yt-dlp、ffmpeg 需用户自装（见 README.md）。

---

## 17. `internal/anysearch/` — AnySearch 搜索客户端

AnySearch JSON-RPC API 的 Go 客户端，供 Playground Search 模式使用。

| 文件 | 职责 |
|---|---|
| `client.go` | `Client` 结构体（`httpClient`+`apiKey`）；`New(apiKey)` 构造（30s 超时）；`Search`/`GetSubDomains`/`Extract` 方法调用 AnySearch JSON-RPC API（endpoint `https://api.anysearch.com/mcp`，method `tools/call`）；`callAPI` 私有方法发送 JSON-RPC 请求，提取 `result.content[].text` |

## 17a. `internal/textreview/` — AI 文本清理引擎（in-process session engine）

<a id="textreview"></a>AI 长文本清理的进程内会话引擎：一个 `Session` 持有待清理的章节列表与处理节点池，调度器跨节点派发 worker goroutine，经共享代理栈流式清理每章并把增量广播给 SSE 订阅者。支持 pause/resume/stop、单章重处理、以及节点 502-exhausted 时的自动并发 ramp-down（落盘到 `config.yaml`）。会话仅驻内存，**不持久化**（重启清零，已确认决策：无 `state.yaml`）。架构基线见 [`docs/playground-architecture.md`](docs/playground-architecture.md)（AI Text Review 一节）。

| 文件 | 职责 |
|---|---|
| `cleaner.go` | 包文档 + `CleanResult`（`OK`/`Exhausted`/`Passed4xx`/`ErrMsg` 故障分类）+ `Cleaner` 接口（`Clean(ctx, node, systemPrompt, content, onChunk)` 流式清理一章，`onChunk` 回调每个 delta） |
| `session.go` | `Session`/`Chapter`/`NodeRuntime`/`CreateSessionRequest` 类型 + 全局 `sessions sync.Map` + `CreateSession`/`GetSession`/`StoreSession`/`DeleteSession`/`Snapshot`（深拷贝供 JSON 序列化，持锁内取一致快照）+ 章节/会话状态常量 |
| `scheduler.go` | `Engine` 调度器：`Start`/`dispatch`（主循环：取下一 pending 章节 → 找 `Active<Target && Enabled` 节点 → spawn worker）/`runWorker`（清理 + 故障分类 + ramp-down 规则）/`acquireNode`/`nextPendingChapter`/`Pause`/`Resume`/`Stop`/`ReprocessChapter`；`maxRetries=3` per-chapter 重试上限；`NodePersister` 接口（ramp-down 落盘） |
| `proxy_call.go` | `ProxyCleaner`：`Cleaner` 生产实现——构造 OpenAI 兼容流式 chat 请求，经 `httptest` 提交共享 proxy handler，实时解析 SSE chunk 的 `choices[0].delta.content` 并经 `onChunk` 回传 |
| `streaming_writer.go` | `streamingResponseWriter`：自定义 `http.ResponseWriter`+`http.Flusher`，把 proxy 流式写入镜像到带背压的 channel（`Write` 阻塞至消费者读取或 ctx 取消），供 `ProxyCleaner` 并发消费 SSE；`sync.Once` 守护 `closeChunks` |
| `events.go` | SSE 事件类型常量（`EventChunk`/`EventStatus`/`EventNode`）+ `Event` payload（`Type`/`ChapterIdx`/`Delta`/`Status`/`NodeID`/`Error`/`Nodes`）+ `JSON()` |
| `scheduler_test.go` | 测试（调度/ramp-down/reprocess，经 fake Cleaner） |

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
| JS 模块 | `app.js`（TooltipSystem：hover+focus 委托统一主题 tooltip，消费 `data-tooltip` 属性，取代浏览器原生 `title=`；单共享节点 + 600ms 延迟 + 翻转/钳制定位；顺带键盘焦点路径恢复 sighted 键盘用户视觉 tooltip；输入框内键盘事件拦截防护：`!isInput` 防护避免方向键触发弹窗按钮切换，Tab 键全面覆盖弹窗内控件，`handleThemeModalKeyDown` 掌控外观弹窗 4 组键盘交互与 `closest()` 控件匹配）、`api.js`、`auth.js`、`i18n.js`、`theme.js`（ThemeSystem 双层主题注册表：Mode/Variant 管理 + localStorage + Settings API 持久化 + theme-card 原生 `<button>` 标签化重构 + `requestAnimationFrame` 焦点持久化）、`info_common.js`、`providers.js`（Batch Manage `Select All`/`Deselect All` 动态切换按键、`batchToggleModel`/`batchToggleSelectAll` 联动、Alias/Note/Quota 弹窗自动 focus 与 Quota 弹窗间距优化）、`combos.js`、`quickslots.js`、**Usage 模块拆为 6 文件**（`index.html`/`index-nopg.html` 加载顺序 state→io→quota→recent→modal→entry）：`usage.js`（Usage/Monitor 页入口 `renderUsage` + 刷新生命周期 `startUsageRefresh`/`stopUsageRefresh`/`ensureProcessingTimer`/`stopProcessingTimer`/`updateProcessingLatencyCells`/`resetQuotaTimers`/`refreshQuotaMonitor`/`clearUsage`）、`usage_state.js`（全局状态 + 常量 + 纯工具：`lastUsageEntries`/`inflightEntries`/`quotaBarItems`/`keyDetailCache`/`MAX_PROCESSING_MS`/`MAX_PRESERVED_TERMINAL` + `formatBody`/`sortEntriesByTimeDesc`/`sanitizeId`/`formatLatency`/`getModelColor`/趋势调色 `TREND_PALETTE`）、`usage_io.js`（REST/SSE 数据管线 + 条目合并 `mergeUsageEntries`/`refreshQuotaData`/`scheduleQuotaRefresh`/`applyUsageSSEHandlers`/`handleRequestStart`/`handleRequestDone`/`handleRequestChunk`/`handleRequestTTFT`/`handleRequestTokens`）、`usage_quota.js`（Quota Monitor 表格 `updateQuotaTable`/`patchQuotaRow`/`patchQuotaRowActiveMetrics`/`renderQuotaRow`/`renderQuotaKeyRows`/`renderQuotaKeyRowsInto`/`toggleQuotaRowExpand`/`fetchModelKeyDetail`/`refreshAllKeyDetails`/锁倒计时 `updateLockCountdowns`/`updateKeyTimers` + **2026-07-31：** `formatQuotaCell(bar)` 渲染 `success/capacity` + 可选 error badge；`renderQuotaKeyRows` 跳过 `modelRemaining===0` 的 exhausted key；`renderQuotaRow`/`patchQuotaRow` 以 innerHTML 消费 `formatQuotaCell`）、`usage_recent.js`（Recent Requests 列表 + 分页 + 按会话分组 + `renderUsageRow`/`updateRecentRequestsInline`/`renderRecentRows`/`renderRecentRowsGrouped`/`toggleSessionGroup`/`updateUsageSummary`）、`usage_modal.js`（Entry Info Modal + 流式 + Trace `showUsageEntryInfoById`/`showUsageEntryInfoWithData`/`loadTraceDetails`/`updateStreamingModalResponse`/`copyStreamingText`/`closeUsageEntry`）、`console.js`、`terminal.js`、`monitor.js`、`download.js`、`endpoint.js`（`openSettingsModal` 自动 focus 并选中首个可聚焦元素、`handleThemeModalKeyDown` 焦点选取与关闭) |
| 样式 | `style.css`（`.tip` 统一 tooltip 类：消费 `--modal-bg`/`--glass-blur`/`--glass-border`/`--radius-sm`/`--shadow-card-hover`/`--z-tooltip` 令牌，跟随所有 mode/variant/style 切换，取代浏览器原生 title tooltip；Modal 基础容器限制 `max-height: calc(100vh - 40px)` 与 `.modal-body` `overflow-x: hidden; overflow-y: auto` 防止 1080P/不同 DPI 缩放下出现 Cutoff 及水平滚动条遮挡；Theme Modal 760px 横版左右并排 + `.style-swatch` 6px 内垫防裁剪 + `.modal-footer .btn:focus` 高对比度双重 Focus Ring 光环） |
| 图标 | `logo.png`(1024 源)、`logo-sm.png`、`favicon.ico`(7 尺寸)、`favicon.png`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`、`site.webmanifest` |
| 终端模拟器 | `xterm/`：`xterm.js`、`xterm.css`、`xterm-addon-fit.js` |

### 18.3 `web/playground/` — Playground 模块（仅 `-tags playground` 内嵌）

  | 模块 JS | `pg-core`、`pg-state`、`pg-setup`、`pg-request`、`pg-stream`、`pg-render`、`pg-markdown`、`pg-modal`、`pg-ui`、`pg-lifecycle`、`pg-i18n`、`pg-director`、`pg-autochat`、`pg-search`、`gallery-state.js`、`gallery-io.js`、`gallery-layout.js`、`gallery-tree.js`、`gallery-review.js`、`gallery-video.js`、`gallery-fullscreen.js`、`gallery-edit.js`、`gallery-edit-operations.js`、`gallery-edit-batch.js`、`gallery.js`、`editor-state.js`、`editor.js`、`tr-split.js`、`tr-diff.js`、`tr-state.js`、`text-review.js`、`text-review-step1.js`、`text-re...

| 类别 | 内容 |
|---|---|
| 文档 | `README.md` |
  | 模块 JS | `pg-core`、`pg-state`、`pg-setup`、`pg-request`、`pg-stream`、`pg-render`、`pg-markdown`、`pg-modal`、`pg-ui`、`pg-lifecycle`、`pg-i18n`、`pg-director`、`pg-autochat`、`pg-search`、`gallery-state.js`、`gallery-io.js`、`gallery-layout.js`、`gallery-tree.js`、`gallery-review.js`、`gallery-video.js`、`gallery-fullscreen.js`、`gallery-edit.js`、`gallery.js`、`editor-state.js`、`editor.js`、`tr-split.js`、`tr-diff.js`、`tr-state.js`、`text-review.js`、`text-review-step1.js`、`text-re...
| vendor | `marked.min.js`、`marked-katex-extension`、`katex.min.js`/`.css`、`mermaid.min.js`、`highlight.min.js`、`purify.min.js`、`diff.min.js`、`pg-highlight-theme.css`、`fonts/`(KaTeX woff2) |

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
| Combo 批量测速排序 | combo、proxy | `api/combo_speedtest.go`（`speedTestCombo` SSE handler + `probeComboModel`，复用 `urlutil.BuildUpstreamURL`/`sse.SSELineBuffer`/`sse.SSEDataPayloads`、`util.ExtractTokens`、`probe_common.go::extractContentFromSSE`、`providers_validate.go::firstActiveKey`、`proxy/handler.go::ManagementClient`）、`registry/combos.go`（`GetComboByID`）、`api/router.go`（路由注册）、`web/static/combos.js`（`runComboSpeedTest` + 编辑弹窗按钮 + `renderComboModelsList` 行 `data-fullid`/状态 span）、`web/static/i18n.js`（`comboSpeedTest*` 键） |
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
| 修改重试/故障转移逻辑 | proxy、rotation | `proxy/retry.go`（`handleUpstreamError` 返回 `bool` + `ActionPassThrough` 分支原样转发 4xx + 中文后果 WARN）、`rotation/error_rules.go`（`ActionPassThrough` + 400/422 默认 + `upstream request failed` 文本规则）+`cooldown.go`（`SonestCooldown` + `CooldownInfo`）、`proxy/forward_retry.go`（`SelectKey` 失败冷却等待 + reqID/callerTag 贯穿）、`proxy/interfaces.go`（`CooldownManager.SonestCooldown`）、`proxy/forward.go`（`requestCallerTag`/`maskAuth`） |
| 新增/修改 Combo 策略 | combo、proxy | `combo/resolver.go`、`proxy/forward.go`（`handleCombo`）、`config/types.go`（`Combo`） |
| Combo 批量测速排序 | combo、proxy | `api/combo_speedtest.go`（`speedTestCombo` SSE handler + `probeComboModel`，复用 `proxy.BuildUpstreamURL/SSELineBuffer/SSEDataPayloads`、`util.ExtractTokens`、`probe_common.go::extractContentFromSSE`、`providers_validate.go::firstActiveKey`、`proxy/handler.go::ManagementClient`）、`registry/combos.go`（`GetComboByID`）、`api/router.go`（路由注册）、`web/static/combos.js`（`runComboSpeedTest` + 编辑弹窗按钮 + `renderComboModelsList` 行 `data-fullid`/状态 span）、`web/static/i18n.js`（`comboSpeedTest*` 键） |
| 修改 SSE 流式透传 | proxy | `proxy/stream.go`、`proxy/forward.go` |
| 修改非流式 keep-alive 刷新 / 图片长响应超时 | proxy | `proxy/forward_retry.go`（原 `forwardWithRetry` 内 keep-alive ticker 已于 H-8 修复中移除——见 §8.7；非流式不再提前提交 200，全 key 耗尽恢复 502）、`api/compress.go`（`/v1/images/*` 绕过列表，历史遗留，现 keep-alive 已无）、`proxy/stream.go`（`passThroughResponse` `headersFlushed` 参数已移除，恒写头 + `WriteHeader(resp.StatusCode)`）；前端 `pg-stream.js`（`pgSendImage` imgTimer）、`pg-render.js`（`pgTickWaiting` 安全网） |
| 修改上游 URL/body 改写 | proxy | `proxy/upstream.go`、`proxy/forward.go` |
| Provider 列表顺序调整与避让 | config-registry-state | `registry/providers.go`（`ReorderProvider`）、`api/providers.go`（`reorderProvider`）、`api/router.go`（`PUT /providers/{id}/reorder`）、`web/static/providers.js`（`renderProviderDetail` 顶栏排序输入框 + `changeProviderOrder`）、`web/static/style.css`（`.btn-order-input`）、`web/static/i18n.js`（`providerOrder*`/`invalidOrderRange` 翻译键） |
| 修改 Gemini thought_signature 回填 | proxy | `proxy/signature_cache.go`+`forward.go`+`stream.go`、`config/types.go`（`IsGeminiOpenAICompat`） |
| 新增管理 API 端点 | （对应模块文档）、config-registry-state | `api/router.go`（挂载+鉴权边界）、`api/<域>.go`、`registry/<域>.go` |
| 新增/修改配置字段 | config-registry-state | `config/types.go`（`ModelDef` 含 `Alias`/`Note`/`NIMOver`/`Kind`/`ImgProtocol`/`ImgSizes`；顶层 `Shortcuts ShortcutsConfig` 用户覆盖 + `QuickSlotOnly bool` 开关）+`defaults.go`（`finalizeConfig`，含 `Shortcuts` nil→空 map 归一）+`persistence.go`（严格解析）+`api/settings.go`（`getSettings` 返回 `shortcuts`/`quickSlotOnly`、PATCH 接收 `shortcuts`/`quickSlotOnly`）+`api/router.go`（`quickSlotOnly atomic.Bool`）+`proxy/handler.go`（`quickSlotOnlyProvider`）+`proxy/models.go`（`ListModels` 过滤门控）+`web/static/shortcuts.js`（前端系统预设与 `Shortcuts.matchEvent`）+`web/static/endpoint.js`（左侧边栏开关）+`web/static/i18n.js`（翻译键） |
| 修改全局快捷键/键映射 | PROJECT_MAP §18.2 | `web/static/shortcuts.js`（`SHORTCUT_PRESETS` 系统预设 + `Shortcuts` API）、`web/static/app.js`（全局 keydown 改 `Shortcuts.matchEvent`）、`web/playground/static-pg/pg-ui.js`+`pg-autochat.js`+`gallery-fullscreen.js`（按区域改 `matchEvent`）、`web/static/endpoint.js`（`openShortcutsModal` + `getShortcutSettingsSummary`/`updateShortcutSettingsSummary` 动态摘要 + `closeShortcutsModal` 取消恢复）、`internal/api/settings.go`（`shortcuts` 字段流转）、`internal/config/types.go`（`ShortcutsConfig`） |
| 修改 QuickSlot 头部交互 / Active 联动 | PROJECT_MAP §18.2 | `web/static/quickslots.js`（`openModelSelectorModal` 统一抽取全站模型选择模态框 + `openQuickSlotModalByOrder`/`openQuickSlotModalById`/`_qsModal*` modal 系统 + import... 尾项 + `+` 快捷键 + capture 阶段键盘处理 + 1s 自动关闭门限 + Del 删除 + `setupImportModalKeyboardAndFocus` + `attachModalFocusTrap` 导入 modal 焦点/Tab 锁/上下键/PgUpPgDn/Space/Enter 交互 + `_qsActiveId`/`qsSetActive`/`qsClearActive`/`qsGetActiveModel`/`_qsUpdateActiveClass` active 联动）、`web/static/combos.js`（`importModelsFromProvider` 复用 `openModelSelectorModal`）、`web/static/app.js`（1-9 改调 `openQuickSlotModalByOrder(n, true)`，移除旧 Alt/Ctrl+1-9）、`web/static/shortcuts.js`（移除旧 quickslot-import/delete 预设）、`web/static/style.css`（`.quickslot-header` 优先级高于 `.top-header-stats` + `.import-model-item.focused` 高亮 + `outline-offset: -1px` 修复焦点轮廓线截断）、`web/static/i18n.js`（`qsModalHint` + `import` 翻译键） |
| 修改运行时状态持久化 | config-registry-state | `state/manager.go`+`state.go`、`registry/state.go`（`KeySnapshot` 新增 `ExhaustedModelLimits map[string]int`，持久化 `ModelRemaining==0` 的 model→limit 子集；`snapshotKeyState`/`RestoreKeyState` 同步）、`app/app.go`（回调接线） |
| 修改本地密码/鉴权 | config-registry-state | `config/crypto.go`、`api/auth.go`+`settings.go`、`config/types.go`（`SecurityConfig`） |
| 修改 NIM 限速 | rotation | `rotation/nim.go`+`selector.go`（`IsNIMEnabled`）、`config/types.go`（`NIMSettings`+`ModelNIMOverride`）、`proxy/retry.go`（429 分发）、`proxy/interfaces.go`（`KeyProvider`）、`proxy/forward.go`（NIM 门控） |
| 修改配额锁/冷却退避 | rotation | `rotation/cooldown.go`、`config/defaults.go`（`BackoffMaxSec`） |
| 新增 Provider 限速头解析 | rotation | `rotation/ratelimit.go`（adapter）、`proxy/recorder.go` |
| 修改下载参数/任务生命周期 | download | `download/args.go`+`executor.go`+`manager.go`、`api/download.go`、`web/static/download.js` |
| 修改终端/监控 | terminal-monitor | `terminal/session.go`、`monitor/manager.go`、`api/terminal.go`+`monitor.go`、`web/static/terminal.js`+`monitor.js` |
| 修改用量统计/在途跟踪/兜底清理 | proxy、config-registry-state | `proxy/recorder.go`（source 分流 + `captureDetails` 恒为 true 始终捕获，2026-07-26 与 debugMode 解耦；新增 `sessionKey string` 参数写入 `Entry.SessionKey`）+`entry_tracker.go`（`SetTTFT`/`UpdateTokens`/`SweepStale`）+`inflight.go`+`broadcaster.go`、`proxy/forward.go`（`broadcastTTFT`/`broadcastTokens`，`processingEntry.InputTokens` 粗估，**`sessionKeyFromMessages`** 会话连续性指纹：system+首条 user 内容各截 4096 rune 后 FNV-1a 64→8 hex，空=单发/未分组；**`reqLogTag`** 把 `|sess:<key>` 拼进 `[reqID]` 控制台标签）、`proxy/forward_request.go`（`handleProxy` 计算 sessionKey 并下传 `forwardWithRetry`/`handleCombo`）、`proxy/forward_retry.go`+`forward_combo.go`+`retry.go`（`logRequest`/`handleNetworkError`/`handle429`/`handleUpstreamError`/`streamResponse`/`passThroughResponse` 新增 `sessionKey` 参数一路下传至所有 `recordUsage` 调用点 + `[reqID|sess:<key>]` 日志标签）、`proxy/stream.go`（`contentCharsTotal` 累积 + token 进度广播 + `clientDisconnected` 断开路径补 recordUsage + `parseAndBroadcastChunk` 仍由 `debugMode()` 门控）、`api/sse_events.go`、`api/usage/register.go`（`getQuotas` 2026-07-31 从 per-key `ModelQuotas` 重算 `TotalUsed`/`TotalCapacity`，覆盖 `QuotaTracker` 纯会话聚合；`getUsage` 调用 SweepStale + `getPlaygroundUsage`；`Entry.SessionKey` 经 `/usage` JSON 自动暴露，无字段过滤）、`usage/ring.go`（`Entry.SessionKey string` 字段）、`web/static/usage` 模块（2026-07-29 拆 6 文件，见 §18.2；`usage_quota.js` 2026-07-31 新增 `formatQuotaCell` + `renderQuotaKeyRows` 跳过 exhausted key + `renderQuotaRow`/`patchQuotaRow` 以 innerHTML 消费；`style.css` 新增 `.quota-success`/`.quota-capacity`/`.quota-error-badge` 类、列 4 宽度 110px；原 `usage.js` 含 `handleRequestTTFT`/`handleRequestTokens` + 筛选 Tag + stale 超时停止 + 去重 + 兜底清理 + 分页 + **按会话分组开关**：`recentGroupBySession` + `renderRecentRows`/`renderRecentRowsGrouped`/`renderSessionGroupHeader`/`toggleRecentGroupBySession`/`toggleSessionGroup`，分页先于分组——对当前页切片分组，空 key 入"未分组"伪组置顶） |
| 新增/修改 build tag | （AGENTS.md 构建变体）、PROJECT_MAP §1/§18 | `build.ps1`、`host_*.go`、`web/embed*.go`、`internal/app/browser_*.go` |
| 修改前端页面/资产 | PROJECT_MAP §18 | `web/static/<page>.js`、`web/static/index.html`、`web/playground/static-pg/` |
| 新增/修改 Gallery 图片查看器 / AI Review 审核 | playground | `web/playground/static-pg/gallery.js`+`gallery-tree.js`+`gallery-review.js`+`gallery-fullscreen.js`+`gallery-state.js`+`gallery-io.js`、`internal/api/gallery/review_handlers.go`+`review_engine.go`（`runReview` 120ms Stagger 错开步长 + `sendVisionRequest` 45s 超时 Context + 2 次静默重试退避 + `galleryCancelReview` 3s 超时防死锁）+ `internal/api/gallery/fs_handlers.go`（`galleryListDir` 400 校验）、`internal/gallery/{zip,tiff}.go`、`internal/api/router.go`、`web/static/{index.html,app.js,style.css,i18n.js}`。**多节点选择**：Header 三态模式（`SelectAll/DeSelect|Start|Cancel`）+ 节点 Shift 范围连选 + `buildReviewQueue` 顺序队列引擎；**双轴方向键导航与防冲刷**：左右方向键（`goReviewPrev`/`goReviewNext`）在已审核节点匹配项间流转，上下方向键（`goReviewPrevNode`/`goReviewNextNode`）跳转节点；`updateCurrentFolderItems` 增加 `reviewState.active` 护航防冲刷；**全宽视图按钮**：Cancel/Reset 下方…
| 新增/修改 Gallery 媒体编辑 | playground | `internal/mediaedit/`（types/binary/probe/args/executor/manager + 测试）、`internal/api/gallery/edit_handlers.go`（`h.media` + `resolveFfmpeg` + 9 个 edit handler：ffmpeg-status/probe/subtitle-upload/start/status/cancel/**extract-zip-entry/upload-temp/zip-outputs/zip-writeback**）、`internal/api/gallery/zip_handlers.go`（`galleryZipWriteback`）、`internal/api/router.go`（`pgJSFiles` 加 `gallery-edit.js`/`gallery-edit-operations.js`/`gallery-edit-batch.js` 三文件，加载顺序：gallery-edit.js → gallery-edit-operations.js → gallery-edit-batch.js）、`web/static/index.html`（script 标签加载顺序，同上三文件）、`docs/playground-architecture.md`（§4.2 表 + §16 小节）。**输出命名**：`StartRequest.OutputName`（可选，无扩展名 stem）+ `manager.go` OutputDir 非覆盖分支 + `buildArgs` 的 `ext`，避免临时输入名泄漏进保存文件/zip 内条目名；**原地替换（Replace Original File）**：`_getDestination` 读 `ge-dest` radio，Same Path=`overwrite:true`；`manager.go` 覆盖同格式→原文件 temp+rename、覆盖跨格式→`<dir>/<stem><newExt>` + `removeOnSuccess` 删原文件（ffmpe…
| 新增/修改 Embedding 模型支持 | proxy、config-registry-state | proxy/handler.go（Embeddings+handleProxy 传入 EntryFormatOpenAI）、api/router.go（r.Post(/v1/embeddings, proxyHandler.Embeddings)）、config/types.go（ProtocolOpenAIEmbedding 常量 + ModelDef.Kind 支持 "embedding"）、api/probe_common.go（probeOpenAIEmbedding + extractEmbeddingDim + ProbeResult.EmbeddingDim）、api/probe_model.go（testProviderModelProto 支持 openai-embedding + probeResultToMap 输出 embeddingDim）、api/providers_models_crud.go（updateModelKind 校验支持 "embedding"）、web/static/providers.js（testModelProtosSerial 按 kind 过滤协议：kind=text → O/R/A、kind=embedding → E；徽章 title/Info modal 显示 embeddingDim）、web/static/i18n.js（embeddingModel/protoOpenAIEmbedding 翻译键） |
| 修改多协议探测/单协议 Test / Responses 路由 / Provider 详情页 UI 与 Batch Manage（含 Select All / Deselect All 动态切换按钮及 Alias/Note/Quota 弹窗自动 focus 与键盘防穿透） | proxy、rotation | internal/proxy/forward.go+upstream.go+stream.go+handler.go、internal/api/probe_model.go+probe_common.go+probe_keys.go+providers_validate.go、internal/combo/resolver.go、internal/config/types.go+validate.go、internal/api/router.go、internal/registry/models.go+state.go、web/static/providers.js+endpoint.js+style.css+i18n.js+app.js+auth.js |
| 修改 Provider / Combo / QuickSlot 卡片外观与 2x2 按钮布局 | PROJECT_MAP §18 | `web/static/providers.js`、`web/static/combos.js`、`web/static/quickslots.js`、`web/static/endpoint.js`、`web/static/style.css` |
| 新增/修改 Gallery 图片查看器 / AI Review 审核 | playground | `web/playground/static-pg/gallery.js`+`gallery-tree.js`+`gallery-review.js`+`gallery-fullscreen.js`+`gallery-state.js`+`gallery-io.js`、`internal/api/gallery/register.go`（`runReview` 120ms Stagger 错开步长 + `sendVisionRequest` 45s 超时 Context + 2 次静默重试退避 + `galleryCancelReview` 3s 超时防死锁 + `galleryListDir` 400 校验）、`internal/gallery/{zip,tiff}.go`、`internal/api/router.go`、`web/static/{index.html,app.js,style.css,i18n.js}`。**多节点选择**：Header 三态模式（`SelectAll/DeSelect|Start|Cancel`）+ 节点 Shift 范围连选 + `buildReviewQueue` 顺序队列引擎；**双轴方向键导航与防冲刷**：左右方向键（`goReviewPrev`/`goReviewNext`）在已审核节点匹配项间流转，上下方向键（`goReviewPrevNode`/`goReviewNextNode`）跳转节点；`updateCurrentFolderItems` 增加 `reviewState.active` 护航防冲刷；**全宽视图按钮**：Cancel/Reset 下方 `100%` 全宽切换按钮（`Show All` / `Show Matched`），反向提示目标状态；**双端剪贴板**：`onPaste` 优先调用 `POST /api/gallery/paste-paths`，实现 Chrome 与 WebView2 独立窗口下文件/文件夹 Ctrl+V 瞬间加载。 |
| 新增/修改 Gallery 媒体编辑 | playground | `internal/mediaedit/`（types/binary/probe/args/executor/manager + 测试）、`internal/api/gallery/register.go`（`mediaJobs` + `resolveFfmpeg` + 9 个 edit handler：ffmpeg-status/probe/subtitle-upload/start/status/cancel/**extract-zip-entry/upload-temp/zip-outputs/zip-writeback**）、`internal/api/router.go`（`pgJSFiles` 加 `gallery-edit.js`）、`web/static/index.html`（script 标签加载顺序）、`docs/playground-architecture.md`（§4.2 表 + §16 小节）。**输出命名**：`StartRequest.OutputName`（可选，无扩展名 stem）+ `manager.go` OutputDir 非覆盖分支 + `buildArgs` 的 `ext`，避免临时输入名泄漏进保存文件/zip 内条目名；**原地替换（Replace Original File）**：`_getDestination` 读 `ge-dest` radio，Same Path=`overwrite:true`；`manager.go` 覆盖同格式→原文件 temp+rename、覆盖跨格式→`<dir>/<stem><newExt>` + `removeOnSuccess` 删原文件（ffmpeg 按输出扩展名选编码器）；`_startJob`/`_startBatch` 均前置 `canReplace` 守卫（拒绝 fs/plain/FSAA-drop-zip）；Same Path 与 sequential rename 互斥（`_refreshBatchUXVisibility` renorm 行 `!samePath` gate，dest radio onchange 联动刷新）；**压缩包名**：`galleryEditZipOutputs` 的 `zipName`（`filepath.Base` + `.zip` 强制）；**批量转换兄弟匹配**：`gallery-edit.js` `_getSiblingImages` 按 kind 分组（`plain` 返回 `[]`）+ `_resolveBatchInput` 逐条解析临时磁盘路径；**批量 UX 选项**：rename/normalise 开关 → `_padNum`（自动扩位）+ `_captureBatchCfg`/`_refreshBatchUXVisibility`；**视频 rename 对等**：共享 dest block 新增 `ge-dest-rename` 输入框（仅"另存到目录"显示），`_startJob` 读其值覆盖 `origStem` 作为 `OutputName`；**视频缩放滑块**：`ge-vid-scale` 改 `<input type="range">` + 实时 WxH 预览；**trim 跨片段约束**：`_startTrimDrag.onMove`/`_moveNearestHandle` 新增 prevEnd/nextStart 约束防组间重叠；**replace-original 守卫 + zip 原位回写**：`!canReplace` 拒绝 + `/edit/zip-writeback`（`zip_replace.go` `ReplaceZipEntries` + `fsutil.AtomicWrite`）；**打开目录**：`POST /api/gallery/open-folder` 复用 `fsutil.OpenInFileManager`，完成结果区仅保留 Open Folder（移除 Show in Gallery）；**批量非压缩完成区 Open Folder**：捕获 `outputPaths[0]` 避免 `_batchJobs=[]` 后闭包空转；**i18n**：`pg-i18n.js` `geBatchProgress`/`geBatchDone` `%s`→`{0}/{1}` + `geRename*`/`geRenorm*`/`geBatchOpenFolder`/`geBatchOpenError`/`geNoDiskPath`/`geBatchDoneAll`/`geBatchFiles`/`geExtracting` + `geReplaceOriginal` en "Replace Original File"/zh "原地替换原文件" |
| 新增/修改 Search 模式 | playground、config-registry-state | `web/playground/static-pg/pg-search.js`+`pg-ui.js`+`pg-render.js`+`pg-state.js`+`pg-i18n.js`、`internal/anysearch/client.go`、`internal/api/anysearch.go`+`settings.go`+`router.go`、`internal/config/types.go`（`AnySearchConfig`）+`defaults.go` |
| 新增/修改 Search 模式 | playground、config-registry-state | `web/playground/static-pg/pg-search.js`+`pg-ui.js`+`pg-render.js`+`pg-state.js`+`pg-i18n.js`, `internal/anysearch/client.go`, `internal/api/anysearch.go`+settings.go+router.go, `internal/config/types.go` (AnySearchConfig)+defaults.go |
| 修改 Image 模式端点/协议选择器/GPT 参数 | playground | `web/playground/static-pg/pg-core.js`（新增 `imgEndpoint`/`imgProtocolFilter`/`imgResponseFormat`/`imgOutputFormat`/`imgOutputCompression`/`imgUser` 默认值），`web/playground/static-pg/pg-ui.js`（`pgEffectiveProtocol` 辅助、协议+模型双原生 select、endpoint generations/edits 切换、参数区可见性、GPT 质量 Auto/Low/Medium/High、n 1..5、response_format、output_format、output_compression、user 控件），`web/playground/static-pg/pg-request.js`（`pgBuildImageBody` 构建 GPT 字段 + 保留 JSON image_url data URL 机制），`web/playground/static-pg/pg-stream.js`（`pgSendImage` 动态 endpoint），`web/playground/static-pg/pg-i18n.js`（新翻译键），`web/playground/static-pg/pg-modal.js`（`pgOpenModelPicker` 支持 protocolFilter） |
| 修改 Search 状态持久化 | playground | `web/playground/static-pg/pg-state.js`（`pgLoadSearchHistory()`/`pgSaveSearchHistory()`/`pgSearchEntryToJSON()`、`PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY`/`PG_SEARCH_MAX_ENTRIES`、`pgLoad()` search 分支）、`web/playground/static-pg/pg-lifecycle.js`（`cleanupPlayground()` search early return、`renderPlayground()` 恢复后渲染）、`web/playground/static-pg/pg-search.js`（`pgSearchSend()` 即时保存、DOM 存在检查） |
| 新增/修改主题变体与 Appearance Modal 键盘/布局自适应 | config-registry-state、PROJECT_MAP §18.2 | `web/static/theme.js`（ThemeSystem registry 扩展 9 暗 + 9 亮 Variant + 4 风格预设 Style Dimension，支持弹窗 3×3 Grid 卡片式 Theme Picker 渲染与双 Mode 对勾标记 + Style Picker 独立维度选择，data-group 属性与重新渲染焦点保持）、`web/static/style.css`（18 种 CSS 变量覆盖层 + 弹窗横版左右双栏与小屏响应式自适应 + `.theme-card` 键盘 Focus 高亮框）、`web/static/app.js`（`handleThemeModalKeyDown` 全局处理 Tab 轮询: dark→night→style→button、方向键组内移动、Space选择、Enter确认退出、Esc/右键退出）、`internal/config/types.go`、`internal/config/defaults.go`、`internal/api/settings.go`、`web/static/endpoint.js`（外观 Modal 打开与初始焦点聚焦）、`web/static/i18n.js` |
| 修改 tooltip 样式/行为 | PROJECT_MAP §18.2 | `web/static/app.js`（TooltipSystem 模块：委托 hover+focusin 监听 + 单共享 `.tip` 节点 + `showFor`/`hide`/`scheduleShow`/`position` 定位与翻转 + `SHOW_DELAY` 延迟）、`web/static/style.css`（`.tip` 类：消费 `--modal-bg`/`--glass-blur`/`--glass-border`/`--radius-sm`/`--shadow-card-hover`/`--z-tooltip` 令牌）、`web/static/<page>.js`（使用 `data-tooltip=\"` 属性的模板字符串，取代原生 `title=`；动态更新用 `el.setAttribute('data-tooltip', val)`）；icon-only 按钮需同步维护 `aria-label` |
| 新增/修改文本审核节点池/会话（Editor Clean模式、批处理调度） | playground、config-registry-state | `internal/textreview/`（engine：`session.go`+`scheduler.go`（`acquireAndClaim`+`runBatch`+`dequeueBatch` 批处理调度）+`cleaner.go`（`BatchCleaner` 接口）+`proxy_call.go`（`CleanBatch`+SSE 流式拆分）+`streaming_writer.go`+`events.go`；test：`dequeue_batch_test.go`+`batch_splitter_test.go`+`batch_run_test.go`）、`internal/api/textreview/`（handler：`register.go`+`sessions.go`+`nodepersister.go`）、`internal/registry/text_review.go`（CRUD）…
| 修改文本审核批处理/节点参数 | proxy、playground | `internal/config/types.go`（`TextReviewNode.IntervalSec/BatchChars`）、`internal/config/defaults.go`、`internal/textreview/scheduler.go`（`acquireAndClaim` IntervalSec 门控+`dequeueBatch` 算法+`runBatch` 批处理）、`internal/textreview/session.go`（`RangeStart/RangeEnd`）、`web/playground/static-pg/text-review-step3.js`（Settings modal 加 intervalSec/batchChars/篇章范围输入+StartClean 后隐藏配置区+紧凑卡片+右栏内容选中）、`web/playground/static-pg/editor.js`（`.ed-review-spacer`→`.ed-review-content`）、`web/playground/static-pg/tr-state.js`（`rangeStart/rangeEnd`）、`web/playground/static-pg/pg-i18n.js`（新键）、`web/playground/static-pg/playground.css`

| 新增/修改路径设置弹窗/浏览初始目录 | download、config-registry-state、fsutil | `web/static/download.js`（`openPathSettingsModal` 共享弹窗 + `Image Dir`/`Log Dir` 默认路径 Placeholder 提示 + `fasBrowsePicker` 初始目录 + `browsePickerOpen` 锁 + `trapHandler` 键盘陷阱）、`web/static/endpoint.js`（Settings 侧栏 Path 行 + `openPathModal`）、`web/static/i18n.js`（`pathSettings`/`imageDir`/`logDir`/`useProxyHint` 键）、`web/static/index-nopg.html`（补加载 `download.js`）、`web/playground/static-pg/gallery-edit.js`（齿轮按钮改调 `openPathSettingsModal`）、`web/playground/static-pg/pg-stream.js`（`pgAutoSaveImageArtifact` 自动回置 `savedPath`/`savedFilename` 并刷新 `pgRefreshImageModalMeta`）、`web/playground/static-pg/pg-modal.js`（`pgCopyImage` 经 `<canvas>` 转绘 PNG Blob 导出 `image/png` ClipboardItem + 跨域代理降级 `fallbackViaProxy`、`pgShowImageModal` Footer 支持展示 `📁 savedPath`）、`web/playground/static-pg/pg-render.js`（`pgShowImageModal` 调用透传 `savedPath`/`savedFilename`）、`internal/api/settings/register.go`（getSettings + `configDir` + `trace.logDir` + `imageSaveDir`）、`internal/api/download/register.go`（`browseSystemPath` + `initialPath` + `resolveBrowseInitialDir` `MkdirAll` 自动创建目录）、`internal/api/image/register.go`（`saveImage`/`imageProxy` 防御 `TestClient` nil 指针改用 `h.httpClient()` + 15s 超时 Context + `User-Agent`）、`internal/api/trace/register.go`（`getDates` 空目录优雅返回）、`internal/fsutil/open_windows.go`（`OpenFilePickerAt`/`OpenDirectoryPickerAt`）、`internal/fsutil/open_other.go`（macOS `osascript` `default location` stubs）、`internal/config/types.go`（`TraceConfig.LogDir`、`DownloadConfig.UseProxy`）、`internal/config/paths.go`（`ResolveDownloadProxy`/`ResolveTraceDir`/`ResolveImageSaveDir`）、`internal/config/persistence.go`（`decodeConfig` 自动迁移 `deprecatedFieldPaths`） |
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
