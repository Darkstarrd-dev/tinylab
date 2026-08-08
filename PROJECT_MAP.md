
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
> **最后核对（2026-08-08，Utility 编辑器工作区与 FileTransfer 上传路由）：** 当前管理 UI 将顶层 Download/GIF 收纳到 **Utility** 菜单；Utility active header label 显示当前工具，子工具为 `editor`、`logReader`、`review`、`gif`、`download`、`fileTransfer`；fresh init 只显示 Utility landing，不预选工具。Editor/Log Reader/Text Review 资产均位于 `web/static/utility/editor/`，仍属 `RootStatic`（`web/static`，所有构建嵌入），不再从 `web/playground/static-pg/editor` 提供。`index.html` 与 `index-nopg.html` 均加载 `/utility/editor/*` 入口脚本，其中 Editor 依次加载 `editor-state.js`、`editor_workspace.js`、`editor_commands.js`、`editor_markdown.js`、`editor_layout.js`、`editor.js`、`editor_shell.js`、`editor-logs.js`，随后加载 Text Review 模块。Editor 是 StackEdit-inspired 的本地编辑器：IndexedDB local workspace（不可用时 in-memory fallback）含 Welcome/Trash/Temp、文件 CRUD/move/restore/current/expanded metadata；Explorer、导航/格式控件、单一主 textarea + Markdown preview、TOC/status/control toggles、Markdown/HTML import/export 与 print。其 `/api/editor/open` 与 `/api/editor/save` 契约不变；不提供 cloud/sync/accounts/comments/PDF/Pandoc，数学公式未单独启用 KaTeX。
> **最后核对（2026-08-08，Monitor Recent Requests 详情弹窗）：** `web/static/monitor/monitor_modal.js` 固定六个 section：`Request Info`、`Request`、`Request Headers`、`Response Headers`、`Status`、`Response Body`；`Status` 为无折叠、无 Pretty/Raw/Copy 的静态状态行，其余五个 section 默认折叠并提供 section 级 Pretty/Raw/Copy，字段级仍提供 Pretty/Raw/Copy；section Raw 直接显示该 section 原始文本，字段 Raw 直接显示字段原文，只有 Pretty 执行 JSON/Markdown/SSE 解析；section header 与 field header 两级 sticky。共享 `web/static/info_common.js` 的 `renderInfoSection`/`buildInfoField` 是兼容边界，Monitor 扩展不改变其他 info modal 调用方默认语义。

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
| `app.go` | — | `New()` 装配全部运行时组件（`buildComponents`），owns 生命周期与 graceful shutdown；绑定 `a.proxyHandler.SetQuickSlotOnlyProvider(a.apiRouter.QuickSlotOnly)`、`a.proxyHandler.SetLogRequestsProvider(a.apiRouter.LogRequests)`、`a.proxyHandler.SetRequestLogDir(filepath.Join(a.configDir, "request-logs"))`；从 `cfg.Trace` 加载 `TraceConfig`（`Enabled`/`RetainDays`/`MaxDiskMB`）并注入 `apibase.Deps.Trace`；`app.go:191` 启动 `go a.proxyHandler.SweepTraces(a.shutdownCtx, cfg.Trace.RetainDays, cfg.Trace.MaxDiskMB)` 后台保留清理 goroutine。**2026-08-06：** `buildComponents` 创建归档 runner（`config.ResolveArchiveTempDir` + `archivetool.NewRunner`，workspace 失败只禁用归档能力并 `Warn`，7z/rar 缺失不阻塞启动）+ 启动 `Scavenge(time.Now())` 回收过期资产/崩溃遗留，经 `a.apiRouter.SetArchiveRunner` 注入 router，`Shutdown` 时 `archiveRunner.Close()` |
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
| `port_owner_stub.go` | `never` | `identifyPortOwner` 永不编译的签名占位桩（build tag `never` 恒不满足）；真实实现见 `port_owner_windows.go`（windows）/ `port_owner_unix.go`（!windows） |
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
| `types.go` | 配置结构体（`Config`/`Provider`/`Key`/`Combo`/`RotationConfig`/`SecurityConfig`/`AnySearchConfig`/`ThemeConfig` 等）+ YAML/JSON tag；`Config` 顶层新增 `QuickSlotOnly bool`（`yaml/json:"quickSlotOnly"`，控制 `/v1/models` 仅返回 QuickSlot 模型）；`AnySearchConfig` 含 `APIKey`/`MaxResults` 字段；`ThemeConfig` 含 `DarkVariant`/`LightVariant`/`Style` 字段（双层主题 Mode/Variant + 独立风格维度持久化）；`Provider` 新增 `AnthropicVersion`/`AnthropicBeta` 字段与 `IsAnthropic()` 方法（`APIType=="anthropic"`），可选 `UseCustomHeaders`/`CustomHeaders`（`useCustomHeaders`/`customHeaders`）用于 Provider 额外请求头；另含域名特例检测 `IsCline()`（BaseURL 含 `api.cline.bot`，驱动上游 `x-client-type` 请求头注入）；`ModelDef` 新增 `Protocols []string` 字段（yaml/json `protocols,omitempty`，记录多协议探测结果）+ `ProtocolOpenAICompat`/`ProtocolOpenAIResponses`/`ProtocolAnthropic`/`ProtocolOpenAIEmbedding` 常量；`ModelDef.Kind` 支持 `"text"`（默认）/`"image"`/`"embed…`
| `paths.go` | 共享路径解析函数：`ResolveDownloadProxy(cfg)` 由 `DownloadConfig.UseProxy` + 全局 `Proxy`（Host:Port）合成 yt-dlp `--proxy` URL；`ResolveTraceDir(logDir, configDir)` 解析 `TraceConfig.LogDir`（空→`{configDir}/traces`，相对拼 configDir，绝对原样）。被 `app.go` 装配与 `api/settings/register.go` 运行时更新共用，避免 `app`→`api` 循环导入。 |
| `types.go` 的 `Config.Archive` | **2026-08-06 新增** `ArchiveConfig{SevenZipPath,RarPath,TempDir}`（`yaml/json:"archive,omitempty"`）：全可选，空工具路径运行时回退 `SEVENZIP_PATH`/`RAR_PATH` env → PATH；缺失工具不阻塞启动，只禁用对应归档能力 |
| `paths.go` 的 `ResolveArchiveTempDir` | **2026-08-06 新增**：归档私有 workspace 解析（空→`{configDir}/archives`、相对拼 configDir、绝对原样）；创建 0700 workspace 由调用方负责，失败 fail-closed（归档能力关闭，核心功能照常） |
| `defaults.go` | 默认配置构造 + `Finalize*` 零值回填；`finalizeConfig` 为 anthropic provider 回填 `AnthropicVersion="2023-06-01"`；`finalizeConfig` 回填 `AnySearch.MaxResults` 默认值 5；`finalizeConfig` 回填 `Theme.DarkVariant`/`Theme.LightVariant`/`Theme.Style` 默认值 `"default"`；`finalizeConfig` 在 `TextReview.SplitPatterns == nil`（首次启动）时注入内置章节检测模式（移植自 novelhelper `split.ts::DEFAULT_SPLIT_PATTERNS`，nil 判断避免用户清空 `[]` 后重新注入）；`DefaultConfig()` 中 `Trace` 字段默认值：`Enabled=false`、`RetainDays=2`、`MaxDiskMB=500` |
| `persistence.go` | `Load`/`Save`：`.tmp` 崩溃恢复（path 缺失/损坏时**不比较 mtime** 优先恢复；成功加载后才清理）+ 原子写（委托 `fsutil.AtomicWrite`）；加密失败拒绝落盘（`encryptKeysCopy` 返回 error） |
| `validate.go` | 尽力校验（API 类型、重复 ID/prefix、ModelDef.Protocols 值合法性），仅告警；anthropic provider 的 BaseURL 未以 `/v1/messages` 或 `*` 结尾时告警 |

| `crypto.go` | AES-256-GCM：API Key 静态加密，`GenerateKey`/`encryptKeysCopy`（任一 key 加密失败 → Save 拒绝落盘，绝不静默写明文） |
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
| `models.go` | Provider 自定义模型列表（`ListModels`、`AddModel`、`DeleteModel`、`UpdateModelQuotaType`、`UpdateModelAlias` [含前缀自动剥离 `sanitizeAlias`]、`UpdateModelNote`、`UpdateModelNIMOverride`、`ResolveModelAlias` [含容错剥离；前缀查找内联于已持有 RLock 内，避免嵌套加锁]、`GetModelByAliasOrID`） |
| `combos.go` | Combo CRUD；新增 `GetComboByID`(id) 方法供 combo 测速排序 handler 使用 |
| `quickslots.go` | QuickSlot（预设模型切换槽）CRUD（含 `sanitizeQuickSlotModels` 自动化简 `prefix/prefix/model` 条目） |
| `state.go` | per-key 运行时状态**访问**：`GetKeyState`（返回 `*keystate.KeyRuntimeState`）、`SnapshotKeyStates`/`snapshotKeyState`/`RestoreKeyState`/`ResetAllCooldowns`、probe records（`UpdateProbeRecord`/`GetProbeRecord`/`SnapshotProbeRecords`/`RestoreProbeRecord`）。**类型定义已迁出**至 `internal/keystate`。**2026-07-31：** `KeySnapshot` 新增 `ExhaustedModelLimits map[string]int`（持久化 `ModelQuotas` 中 `ModelRemaining==0` 的 model→limit 子集），`snapshotKeyState`/`RestoreKeyState` 同步此字段。 |
| `crud_test.go` / `reload_merge_test.go` / `state_test.go` | 测试 |
| `models_protocols_test.go` / `probe_records_test.go` | 新增 ModelDef.Protocols CRUD 与 probeRecords 运行时状态测试 |
| `review_presets.go` | Gallery AI 审核预设 CRUD：`ListReviewPresets`/`AddReviewPreset`/`UpdateReviewPreset`/`DeleteReviewPreset`（线程安全，`cfgMu` 保护） |
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
| `cooldown.go` | 指数退避（1s→240s），429 日配额锁至次日 CST 00:05，per-model 锁；`IsDailyQuota429` 需 body 同时含 quota 关键字 + 日额度/耗尽标记（exceeded/daily/today/tomorrow）且无 `try again in` 时长提示才判定（普通 429 不再误锁到次日 00:05）；`CooldownManager` 接口新增 `SonestCooldown(providerID, model, excludeKeyIDs)` + `CooldownInfo`（最早 `ModelLocks[model]` 到期 + keyName/reason），供 proxy "无可用 key" 时等待最近冷却到期而非即时 502 |
| `ratelimit.go` | 每 key 请求速率记账 |
| `error_rules.go` | 上游错误分类（transient vs fatal，429/5xx 规则）；新增 `ActionPassThrough`（请求格式 4xx → 原样返回客户端，不重试/不锁/不排除，key 健康），400/422 默认 `ActionPassThrough`（文本规则优先可覆盖），并新增聚合器文本规则 `{BodyMatch:"upstream request failed", Action:ActionBackoff}`（聚合器自身上游瞬时失败 → 重试）；新增状态区间规则 `{StatusMin:500, StatusMax:599, Action:ActionBackoff}`（未映射 5xx → 短退避切 key，不再落 30s 瞬态冷却锁） |
| `nim.go` | NVIDIA NIM 限速：per-key 请求计数、min interval、429 冷却阶梯、自动检测、`getEffectiveNIMSettings`/`getModelNIMOverride`、per-model `ModelNIMOverride` 支持；三个 NIM 路径（`WaitNIMInterval`/`OnNIMRequestSuccess`/`MarkNIM429`）先读配置（cfgMu RLock 释放）再锁 key state（ks.mu），消除 cfgMu→stateMu→ks.mu→cfgMu 死锁环 |
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
| `forward_retry.go` | `(h *Handler) forwardWithRetry`：重试循环 + body 改写（替换 `model` 字段、注入 `stream_options`、调 `backfillThoughtSignatures`）；**入口对 `parsed` 做深度拷贝**（`forward.go::cloneJSONValue`）——combo fallback 各目标共享同一 map，逐目标改写（model/stream_options/tool_call id/Gemini 签名）不得泄漏到下个目标；`processingEntry.ReqHeaders` 经 `maskHeaderMap` 遮蔽 Authorization/X-Api-Key 后才广播；**reqID 提至循环顶部生成一次**（跨重试共享，关联 REQUEST/SEND/PROXY/错误行 + EntryTracker 条目）+ `callerTag`（`requestCallerTag(r)`）贯穿日志；**Part B 冷却等待**：`SelectKey` 失败时先调 `cooldown.SonestCooldown` 查最近 `ModelLock` 到期，有则 `select{Context|time.After(wait)}`（上限 30s）等待后重试一次 `SelectKey`，避免冷却窗口内并发请求即时 502 突发；仍返回 502 于真正耗尽；**非流式不再 keep-alive 刷新**（H-8，见前）；+ `broadcastRequestStart`/`broadcastTTFT`/`broadcastTokens` 三个事件广播辅助 |
| `upstream.go` | 委托 `internal/urlutil` 的 `BuildUpstreamURL`/`normalizeBaseURL`/`isOllamaBaseURL`/`normalizeOllamaBaseURL` 进行 URL 构造；`forwardUpstream` 按 `entryFormat` 三分支（OpenAI Chat / Anthropic / OpenAI Responses）；**统一上游请求构造器** `buildUpstreamRequest(ctx, sel, body, endpointPath, authBearer bool)`（upstream.go:84）：URL 由 `urlutil.BuildUpstreamURL` 统一构造；`authBearer=true` 时设 `Authorization: Bearer <key>`（OpenAI Chat / Responses 入口），`authBearer=false` 时调 `setAnthropicHeaders`（`x-api-key`+`anthropic-version`+可选 `anthropic-beta`，绝不设 `Authorization`，Anthropic 入口）；原 `buildAnthropicUpstreamRequest`/`buildResponsesUpstreamRequest` 两个独立函数已于 Phase 2 合并为单一 `buildUpstreamRequest` + `authBearer` 开关；`applyClineHeaders`（122-128，api.cline.bot 域名特例无条件注入 `x-client-type: cline-cli`）；body 用 `bytes.NewReader` 直传（不再 `string(body)` 拷贝）；客户端选择抽为 `upstreamClientFor`/`streamClientFor`（UseProxy+proxyURL 生效），`forwardGetUpstream` 同样按 UseProxy 选择代理/直连客户端；非流式客户端经 `handler.go::clientFor` 按原子超时（`upstreamTimeoutSec`）克隆（超时变更不再与 `http.Client.Do` 竞争写 `Timeout` 字段）i`，常量 `clineClientTypeHeaderValue` 117-120，调用点 forwardUpstream 57-60 / forwardGetUpstream 143） |
| `stream.go` | SSE 流式 / 非流式 I/O 透传循环：`(h *Handler) streamResponse`（`http.Flusher` 逐 chunk 转发 + 客户端断开保护）与 `(h *Handler) passThroughResponse`（非流式整段读取透传上游状态码，不再 `io.LimitReader` 64MB 截断——完整写客户端，仅 usage 捕获副本截 512KB）；流式捕获缓冲 `boundedSSEBuffer` 只保留末尾 512KB（H1b，长流不再撑爆内存）；委托 `internal/sse` 的 `SSELineBuffer`/`NormalizeSSEChunk` 行帧缓冲与 chunk 规范化；`entryFormat` 控制 anthropic 走 `parseAnthropicSSEUsage`、OpenAI Chat/Responses 走 `util.ExtractTokens`；客户端断开 → `clientDisconnected` 标志 → `break` → `recordUsage(status="error")` |
| `stream_usage.go` | OpenAI 格式 token/usage 解析：`sseContentLength`（content 字段字节扫描）、`parseSSEChunkDelta`+`chunkDelta`、`formatTokenDelta`/`itoa`（usage chunk 摘要格式化） |
| `stream_anthropic.go` | Anthropic 专用 usage 解析：`parseAnthropicSSEUsage`（读 `message_start`/`message_delta` 的 input/output tokens） |
| `stream_debug.go` | 调试态 SSE chunk 广播：`(h *Handler) parseAndBroadcastChunk`（`entryFormat == EntryFormatOpenAI` 时经 `RequestUpdates.Broadcast` 发 `request-chunk` 事件） |
| `retry.go` | 跨 key/combo 故障转移的重试状态机；`handleUpstreamError` 改返回 `bool`（true=4xx 请求格式错误已 `ActionPassThrough` 原样写客户端 + 停止重试，false=继续切 key），新增 pass-through 分支（不调 `OnKeyFailure`/`MarkRateLimited`/不排除 key，转发上游原始 body+状态码）；各动作新增中文后果 WARN（指数退避/冷却 Ns/锁至次日 CST 00:05）；`logRequest`/`handleNetworkError`/`handle429`/`handleUpstreamError` 新增 `sessionKey string` 参数贯穿 `[reqID|sess:<key>]` 控制台标签（`forward.go::reqLogTag`，空 key 退化为 `[reqID]`）+ callerTag + 网络错误 WARN，并下传至各 `recordUsage` 调用点 |
| `models.go` | 模型列表/解析辅助；`ListModels` 新增 `quickSlotOnly()` 门控——开启时仅返回 QuickSlot 模型，跳过 provider/combo |
| `recorder.go` | `recordUsage`：按 source 分流写入 Recent Requests ring 或 Playground ring；payload/headers 捕获门控为 `captureDetails := isPlayground || (h.debugMode() && !h.logRequests())`——playground 始终捕获，非 playground 仅 debug 开且追踪关时存 payload/headers（追踪开时完整 body 已落盘 JSONL，ring 退化为轻量表）；reqBody 截断 64KB、respBody 截断 512KB；内存开销由 ring 容量（`config.UsageRingSize`，默认 500）× 单条 body 大小封顶；新增 `decision string`、`provenance string` 参数写入 `usage.Entry`（会话连续性指纹由 `forward.go::sessionKeyFromMessages` 在 `handleProxy` 计算后经 `forwardWithRetry`/`handleCombo`/`retry.go` handlers/`stream.go` 一路下传至所有 `recordUsage` 调用点）；`writeRequestLog` hook 在 body 截断前调用（完整 body 写入追踪由 `request_log.go::boundTraceBody` 自行截断 64KB/512KB + 剥离 base64 图像，见 proxy-architecture.md 2026-08-03 更新），受 `h.logRequests()` 运行时原子开关（加载自持久化 `cfg.Trace.Enabled`）控制；
| `request_log.go` | 两层 JSONL 追踪日志系统（`traceLine` 结构体为 JSONL 行 schema）：`writeRequestLog` 写入 `traces/index-YYYYMMDD.jsonl`（每日轮转）+ `traces/req/<reqID>.jsonl`（追加，仅首次调用写 request 行，后续每次调用写 attempt 行）；body 落盘前经 `boundTraceBody` 截断（reqBody 64KB / respBody 512KB）并剥离 base64 图像；`TraceMgmtCall` 方法捕获 ManagementClient 路径（probe/combo-speedtest/providers-probe）的调用，attempt n=1，decision="management probe"；`SweepTraces(ctx, retainDays, maxDiskMB)` + `sweepTracesOnce` 后台保留清理（按 modifyTime 删除过期 index+req 文件，MaxDiskMB 上限覆盖整个 traces/ 目录含 index 文件，按最旧优先删除；删 req 文件时同步清理 `attemptCounter` 条目防泄漏），在 `app.go:191` 以 `go a.proxyHandler.SweepTraces(a.shutdownCtx, cfg.Trace.RetainDays, cfg.Trace.MaxDiskMB)` 启动，立即执行一次后每小时运行，shutdown ctx 停止；`TracesDir() string` getter 返回 `h.requestLogDir`；敏感请求头（`Authorization`/`X-Api-Key`）遮蔽为 `***`+末 4 字符（保留 scheme 前缀），base64 图像数据（data URLs、`b64_json`、Anthropic `{type:base64,data:}`）剥离；`maskSecret`/`maskToken`/`isSecretHeader`/`stripBase64Images`/`stripBase64InMap`/`boundTraceBody` 辅助函数（已测试） |
| `request_events.go` | 生成全局唯一 request ID（`r<base62-nanos>-<base62-counter>`：纳秒 base62 前缀 + 原子计数器后缀，同纳秒并发不再碰撞） |
| `entry_tracker.go` | `EntryTracker`：在途（processing）usage 条目并发 map；`Register`/`Remove`/`Get`/`All`/`Exists`/`SetTTFT`/`UpdateTokens`；`SweepStale(maxAge)` 兜底清理超时条目（返回并删除，由 caller 写 error 记录到 RingBuffer + 广播 request-done）；monitor `getUsage` 清扫时按 `KeyID` 同步 `DecInFlight`（正常完成路径的幂等对应） |
| `inflight.go` | `inflightEntry`：单条在途流式请求的实时输出 |
| `broadcaster.go` | `Broadcaster`：把事件扇出到所有 SSE 订阅 channel |
| `signature_cache.go` | `SignatureCacheProvider` 接口 + `SignatureCache`（TTL+LRU 惰性驱逐）：缓存 Gemini `thought_signature` 用于流式回填；**`extractThoughtSignature`**（扫描 OpenAI SSE payload 的 `delta.tool_calls[].extra_content.google.thought_signature`，流式中捕获签名 `sigCache.Put`）亦位于此文件，作为缓存的自然伴生提取器 |
| `*_test.go` | 测试（handler/retry/stream/e2e/signature 多套）；新增 `responses_test.go`（OpenAI Responses 路由）、`anthropic_test.go`（Anthropic 入口）、`anthropic_usage_test.go`（parseAnthropicSSEUsage） |

> Gemini `thought_signature` 自动回填：流式中提取签名并缓存，非流式响应自动补全，对 OpenAI 兼容端点透明（见 commit `c2f89c6`）。

---

## 8. `internal/usage/` — 内存统计 + 配额

| 文件 | 职责 |
|---|---|
| `ring.go` | `RingBuffer`：有界环形缓冲（默认 500 条）+ 摘要；`Entry` 结构体新增 `SessionKey string`（`json:"sessionKey,omitempty"`，会话连续性指纹，空=单发/未分组，由 proxy `sessionKeyFromMessages` 计算，经 monitor API JSON 自动暴露） |
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
<!-- last verified: 2026-08-05 -->

| 文件 | 职责 |
|---|---|
| `router.go` | `Router` 结构 + `New`（注入 `reg`/`cfg`/`configPath`/usage 双 ring/`quotaTracker`/`logger`/`proxyHandler`/`shutdown`/`selector`/`comboRes`/`downloadMgr`）+ `Routes(proxyHandler)` chi 路由装配：`/v1/*` 代理路由（chat/completions/models/images/embeddings/messages/responses/tasks）、`/api` 组（auth 中间件 + 1MB body 上限）、`/api/gallery`、`/api/editor`、`/api/text-review`（32MB body 例外组）、`POST /api/filetransfer/upload` 与 `POST /api/filetransfer/path-info`（认证保护，600MB body 上限；上传由 handler 打包 ZIP 后尝试临时服务，失败时返回错误，不保证外部服务成功；path-info 提供本机路径容量查询）、**2026-08-06：`/api/archive` 路由组**（`archiveapi.NewHandler(apiDeps, rt.archiveRunner)` + auth 中间件，绕过 1MiB 组级上限，逐路由 body cap 在 handler 内；`SetArchiveRunner` 注入；`apiDeps.ArchiveSettingsFn` 闭包推 `UpdateSettings`）`、playground 静态文件服务（`pgJSFiles` 清单 + `/playground.css`）、`serveUI` 兜底；`DebugMode`/`Qu…`
| `helpers.go` | 根包辅助：`saveConfig`/`saveConfigAndReload`（config.Save→Reload 收敛点）、`writeAPIError`（JSON 错误信封）、`checkPortAvailable`、`getIntQuery`、`generateID`/`SyncIDCounter`（委托 `apibase` 单一计数器）、`firstActiveKey` |

### 10.10 `internal/api/trace/` — 追踪读取 API

认证保护（`/api/traces` 路径下），提供追踪数据的只读查询接口。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + 三个 GET 路由：`GET /api/traces/dates` → `{"dates":[{"date","count","sizeBytes"}],"dir"}`（按日期降序）；`GET /api/traces/index?date=YYYYMMDD&limit=200&offset=0&status=&q=` → `{"lines":[...],"total":N}`（ newest-first， filtered+paginated）；`GET /api/traces/req/{reqID}` → `{"reqID","lines":[...]}`（ chronological: request line + attempt lines）。`sanitizePathParam` 路径穿越防护（拒绝 `/`、`\`、`..`、null 字节）。 |

### 10.20 `internal/api/settings/` — Settings / 生命周期

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `getSettings`/`updateSettings`。GET 返回 `trace` 字段：`{"trace":{"enabled":<live>,"retainDays":<cfg>,"maxDiskMB":<cfg>}}`；PATCH 接受 `{"trace":{"enabled?","retainDays?","maxDiskMB?"}}`（部分更新，持久化到 `cfg.Trace`），同时更新运行时原子镜像 `apibase.Deps.LogRequests`。**rotation 为 presence-aware 合并**（`rotationPatch` 指针字段：`strategy?/stickyLimit?/maxRetries?/retryDelaySec?/backoffMaxSec?`，经 `applyRotationUpdates` 逐字段合并）——前端只发 5 个管理字段，绝不触碰 `StatePersist`/`StatePath`（2026-08-03 审计修复）。**2026-08-06 archive 同为 presence-aware**：GET 返回 `archive:{sevenZipPath,rarPath,tempDir}`；PATCH 接受 `archivePatch` 全指针字段（未发送不覆盖、空串=显式清除回 env/PATH），经 `applyArchiveUpdates` 合并后调 `ArchiveSettingsFn(cfg.Archive)` 推给 runner（换配置 + 失效 probe 缓存） |
| `register_test.go` | 2026-08-03 新增：`TestRotationPatchPreservesStatePersist`/`TestRotationPatchPartialUpdate`（rotation PATCH 不抹掉 StatePersist/StatePath，Save/Load 往返验证） |

| `api_test.go` | API 集成测试 |
| `probe_test.go` / `probe_proto_test.go` | 探测协议测试（仍在根包，引用 `apibase` 构造 `*Deps`） |
| `bulk_keys_test.go` / `selector_hot_reload_test.go` | 批量 key / 选择器热重载测试 |

### 10.1 `internal/api/apibase/` — 共享依赖与辅助

为 `internal/api` 子包提供共享类型和辅助函数，避免父包与子包间的循环导入。

| 文件 | 职责 |
| `deps.go` | `Deps` 结构体（`Reg`/`ConfigPath`/`Usage`/`PgUsage`/`QuotaTracker`/`Logger`/`ProxyHandler`/`Selector`/`ComboRes`/`DownloadMgr`/`Shutdown`/`TestClient`/`DebugMode`/`QuickSlotOnly`/`LogRequests`/`RestartFn`/`ServerCfgFn`/`UpstreamTimeoutFn`/`StateSaveFn`/`Trace`（`TraceConfig`，含 `Enabled`/`RetainDays`/`MaxDiskMB`））+ `SaveConfig`/`SaveConfigAndReload` 方法 + `WriteAPIError`/`GenerateID`/`SyncIDCounter`/`CheckPortAvailable`/`ValidateBaseURL`/`IsBlockedSSRFHost` 函数（`IsBlockedSSRFHost` 现含 `IsLinkLocalMulticast`/`IsMulticast`，2026-08-03 审计修复）。**2026-08-06：** `ArchiveRunner` 接口（`Store`/`Status`/`List`/`ReadEntry`/`Pack`，由 `*archivetool.Runner` 实现，router 经接口注入免 import 工具包）+ `ArchiveSettingsFn func(config.ArchiveConfig)` 回调字段（可为 nil；settings handler 判空调用） |

### 10.2 `internal/api/auth/` — 鉴权

| 文件 | 职责 |
|---|---|
| `handler.go` | `Handler` 结构体 + `Register`/`AuthMiddleware`/`AuthStatusHandler`（返回 `authEnabled`/`passwordEnabled` 与 `loggedIn`/`authenticated` 归一字段）/`LoginHandler`/`LogoutHandler` + `SessionStore`/`GenerateToken`/`IsValidSession`/`SetSessionCookie`；`SessionStore` 有界（`maxSessions=1000`：惰性清扫过期 token + 超限逐出最旧，2026-08-03 审计修复） |
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
| `register.go` | `Handler` 结构体（字段 `d`/`sessions`/`reviews`/`media`/`proxy`）+ `NewHandler` + `Register` + 空白图片格式 decoder import + `proxyCaller` 接口。**2026-08-06：** 新增 `archiveBridge` 接口（`ResolveSource`/`List`/`ReadEntry`，由 `*api/archive.Handler` 实现）+ `SetArchive` 注入——nil 桥接时全部 Gallery 流程走 legacy 内存 zip 会话（兼容边界）；`galleryEditExtractZipEntry` 接受 `sourceId` 作为第三种输入（严格路径 + `DefaultBudget`） |
| `session_store.go` | 内存 zip 会话 LRU 存储（`gallerySessionStore`/`zipSession`/`newGallerySessionID`），Handler 字段 `h.sessions` |
| `fs_handlers.go` | Gallery 文件系统 handlers + 辅助（`isGalleryFile`/`isGalleryZip`/`galleryFsEntry`/`listGalleryFiles`/`galleryOpenDir`/`ListDir`/`ServeFile`/`DeleteFs`/`OpenFolder`/`PastePaths`） |
| `zip_handlers.go` | 内存 zip 会话 handlers（`galleryListZip`/`GetZipEntry`/`DeleteZipSession`/`TouchSession`/`ConvertTiff`/`DeleteZipEntry`/`ZipFromPath`/`ZipWriteback`）；`ZipFromPath` 解析并校验 JSON `{path}` 后读取磁盘 ZIP，空路径或 malformed JSON 返回 400 |
| `review_engine.go` | AI 审核引擎核心（`reviewTask`/`runReview`/`analyzeImage`/`sendVisionRequest`/`mimeTypeForEntry`/`resizeImage`/`selectReviewIndices`/`selectHeadTailIndices`） |
| `review_handlers.go` | AI 审核 HTTP handlers（`startReviewRequest`/`genPromptRequest`/`galleryStartReview`/`ReviewStatus`/`CancelReview`/`GeneratePrompt`） |
| `edit_handlers.go` | Gallery 媒体编辑（ffmpeg）handlers（`resolveFfmpeg`/`probeRequest`/`galleryEditFfmpegStatus`/`Probe`/`SubtitleUpload`/`Start`/`Status`/`Cancel`/`ExtractZipEntry`/`UploadTemp`/`ZipOutputs`/`ZipWriteback`）；Handler 字段 `h.media`（`*mediaedit.Manager`） |
| `register_test.go` | 测试：`gallerySessionStore` LRU 驱逐契约（容量 128，最早会话先驱逐）、`touch` MRU 提升、`remove` 幂等；HTTP 层 `DELETE /zip/{sessionId}`（204）与 `POST /zip/{sessionId}/touch`（204/404），`POST /zip-from-path` 成功/缺路径/malformed JSON，并验证 chi 区分 `DELETE /zip/{sessionId}`（会话删除）与 `DELETE /zip/{sessionId}/*`（条目删除） |


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

### 10.13 `internal/api/image/` — 图片保存与同源代理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `saveImage`（`POST /api/save-image`，下载图片到 `ImageSaveDir`）+ `imageProxy`（`GET /api/image-proxy`，同源代理避免 CORS）+ `saveImageRequest` 类型 + `extensionFromContentType` 辅助（SSRF 拦截经 `apibase.IsBlockedSSRFHost`，`ssrfGuardedClient` 每跳重检 + 5 跳上限；**`.svg` 已从 allowedImageExts 移除**——存储型 XSS 载体，2026-08-03 审计修复） |

### 10.13a `internal/api/comfyui/` — 本机 ComfyUI 协议代理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `POST /api/comfyui/proxy`；固定转发到 `127.0.0.1:{port}`，仅允许 GET/POST，校验端口/路径/查询、限制重定向留在请求端口，并透传 ComfyUI JSON/图片响应 |
| `register_test.go` | 代理请求校验与 JSON 响应转发测试 |
### 10.13b `internal/imagebatch/` — Durable Playground Image Batch engine

独立于 Manual Canvas 的后台图片项目引擎。`ProjectStore` 以 `config.ResolveImageSaveDir` 为根，按安全 slug 保存 `project.json` 与 `p####/v####.<ext>` 槽位；`.part` 临时文件 + rename 保证原子资产写入，`Reconcile` 只依据合法图片文件恢复成功槽位，不从无 Manifest 的旧目录猜测任务。`Manager`/`Scheduler` 固定单并发，提供 interval、retry/backoff、on-error、pause/resume、after-current/immediate stop、单 Variant retry、SSE 订阅和重启后的 snapshot/reconcile。`RemoteGenerator` 通过 proxy handler 的窄接口生成远程图片，`ComfyGenerator` 只访问本机 loopback ComfyUI 的 `/prompt`/`/history`/`/view`；Manifest 不写 API key、Authorization、Base64 或大响应。

| 文件 | 职责 |
|---|---|
| `types.go` | Project/Prompt/Variant/Asset/Stats schema、Natural/Tag/JSON、seed/status/event、边界校验与 generator contracts |
| `paths.go` | project slug、slot、asset ID 与相对路径安全校验 |
| `project_store.go` | project.json 原子读写、asset `.part` 写入、JSON/YAML import/export、safe asset path |
| `reconciler.go` | 文件系统扫描与 Manifest 槽位恢复 |
| `manager.go` | Manager 生命周期、runtime、snapshot、controls、retry、subscriptions |
| `scheduler.go` | 顺序调度、间隔、retry/backoff、seed、生成结果落盘、失败/中断状态 |
| `remote_generator.go` | GPT/xAI/ModelScope proxy invocation、URL/base64 image validation、SSRF-safe fetch |
| `comfy_generator.go` | loopback ComfyUI API workflow、history polling、image validation |
| `generator.go` | remote/ComfyUI protocol dispatch |
| `*_test.go` | schema, paths, storage, adapter contract tests |

### 10.13c `internal/api/imagebatch/` — Image Batch HTTP API

`/api/image-batches/*` 独立于 generic `/api` 组，沿用管理 session 鉴权并设置 32 MiB request limit。`register.go` 注册 plan/transform/create/list/import/snapshot/manifest/assets/events 与 pause/resume/stop/retry；planning/transform 通过既有 proxy handler 调 helper model 并要求严格 JSON；events 首先发送 snapshot，再发送 typed SSE events。

### 10.11 `internal/api/keys/` — Key 管理

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listKeys`/`createKey`/`bulkAddKeys`/`updateKey`/`deleteKey`/`getKeyState` |

### 10.12 `internal/api/models/` — 模型列表

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register` + `listModels`（`/api/models`，返回 `prefix/alias` 或 `prefix/model_id`） |


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
| `register.go` | `Handler` + `Register` + `streamUsageEvents`（`GET /api/monitor/events`） |


### 10.21 `internal/api/monitor/` — 用量 / 配额 / 模型 key 状态（Monitor 页面数据源；与 2026-07-31 已删除的 terminal 监控 `internal/api/monitor/` 同名异义）

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（7 路由：`GET /monitor`、`GET /monitor/playground`、`GET /monitor/summary`、`GET /monitor/quotas`、`GET /monitor/model-keys`、`DELETE /monitor`、`POST /monitor/reset-quota`）+ `getUsage`/`getPlaygroundUsage`/`getUsageSummary`/`getQuotas`/`getModelKeys`/`clearUsage`/`resetQuota` + `getIntQuery` 辅助。**2026-07-31：** `getQuotas` 现从 per-key `KeyRuntimeState.ModelQuotas`（经 `GetQuota` 锁安全读取）重算 `TotalUsed`/`TotalCapacity`，覆盖 `QuotaTracker` 纯会话聚合，使重启后 exhausted key 的配额贡献仍计入 provider 级总量。**2026-07-31（更名）：** 页面层 `usage`→`monitor` 语义对齐（页面标题为 Monitor），包/路由/前端文件同步更名，数据层 `internal/usage`（`RingBuffer`/`Entry`/`QuotaTracker`，OpenAI 协议 usage 概念）保留原名。 |

### 10.22 `internal/gallery/` — Gallery 图片查看器后端（库）

为前端 Gallery 分页（图片查看器，playground 构建变体）提供 zip 解析与 TIFF 转码能力。不持久化、不写盘；状态仅驻进程内存（zip 会话 LRU）。

| 文件 | 职责 |
|---|---|
| `zip.go` | `ListZipEntries(io.ReaderAt,size)` 列 zip 内图片条目（按名排序、过滤非图片）; `GetZipEntry(reader,size,name)` 取单个条目字节; `CleanZipPath`（导出，`\\`→`/`、trim 前导 `/`、`path.Clean`，带 doc comment）; `ErrEntryNotFound`; `contentTypeForExt`。所有调用方（`zip_delete.go`/`zip_replace.go`/测试）已更新为 `gallerylib.CleanZipPath` |
| `zip_replace.go` | `ReplaceZipEntries(data, replacements map[string][]byte) ([]byte, Manifest, error)`：zip 条目替换/原位回写核心——按已清洗 zipPath 替换命中条目内容、未命中条目字节级保留（含 Method/Modified/Extra/comment、归档注释），输出新归档字节 + 新 Manifest。被 `internal/api/gallery/zip_handlers.go` `galleryEditZipWriteback` 调用（replace-original convert-all/单图 zip 路径），支持 Store+Deflate（及任何 stdlib 支持的方法）。调用方负责 zipPath 清洗（handler 内调用 `gallerylib.CleanZipPath`，此前 `cleanZipPathNormalize` 重复函数已移除）。不依赖 `zip_delete.go` |
| `zip_replace_test.go` | 测试：`TestReplaceZipEntries_Store_ReplacesAndPreserves` / `_Deflate_ReplacesAndPreserves`（验证 deflate 实际压缩：结果尺寸<裸总和）/ `_MissingKey_NoOp`（空映射/未知键字节等价于原）/ `_CleanedKeyContract`（调用方提供已清洗键的契约） |
| `tiff.go` | `ConvertTIFFToJPEG(io.Reader,quality)` / `ConvertTIFFBlobToJPEG([]byte,quality)`：用 `golang.org/x/image/tiff` 解码后重编码为 JPEG（Chromium/WebView2 原生不支持 `<img>` 显示 TIFF） |
| `dimensions.go` | 解码前尺寸预检（防解压炸弹）：`ImageDimensions` 解析 PNG IHDR / GIF 逻辑屏幕 / TIFF IFD / JPEG SOF / WebP（VP8/VP8L/VP8X）头部取宽高（不解码像素）；`CheckImageSize` 对 >16384×16384 报 “image too large”。`tiff.go` 与 gallery AI review `analyzeImage` 在 `image.Decode`/`tiff.Decode` 前调用 |
| `gallery.go` | 包文档 + 支持扩展名集合：`SupportedExts`（webp/png/jpg/jpeg/bmp/tiff/tif）+ `IsSupportedExt`（“tif” 视同 “tiff”）+ `Entry`/`Manifest` 类型 |
| `charset.go` | 非 UTF-8 zip 条目文件名的 CJK 编码探测还原：`decodeZipName` 按 ShiftJIS→GBK→EUCJP→Big5→EUCKR→GB18030 优先级解码 + round-trip 编码验证过滤错误解码器（日/中 Windows zip 工具常见） |
| `review.go` | AI 审核共享类型：`ReviewStrategy`（all/head-tail）、`ReviewStatus`（running/completed/cancelled/error）、`ReviewResult`（index/path/isMatch/reason）、`ReviewResponse`、`ParseReviewResponse`（match 字段泛化）+ `PromptGenSystemPrompt`/`PromptGenUserPromptTemplate`/`DefaultUserPrompt` 常量 |
| `zip_test.go` / `tiff_test.go` | 测试 |

架构基线见 [`docs/playground-architecture.md`](docs/playground-architecture.md)（Gallery 一节）。

引入依赖：`golang.org/x/image`（webp/bmp/tiff/draw 子包），纯 Go 无 CGO。

### 10.23 `internal/api/textreview/` — AI 文本审核 HTTP handler

AI 文本审核（Text Review）4 步向导的 HTTP 路由层：处理节点池/切分模式/默认 prompt 的 CRUD 与会话调度端点（SSE 进度 + pause/resume/stop/reprocess）。会话引擎委托 [`internal/textreview`](#textreview)；`NodePersister`（ramp-down 落盘）实现在 `nodepersister.go`。`/api/text-review/*` 独立于 `/api` 组外以绕过 1MB body 上限（最大 32MB，与会话携带的 `rawText` 相称），仍经 `AuthMiddleware` 鉴权。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler` + `Register`（路由注册 + 文档注释列出全部端点）+ 配置 CRUD handler（`listReviewNodes`/`upsertReviewNode`/`deleteReviewNode`/`listSplitPatterns`/`upsertSplitPattern`/`deleteSplitPattern`/`getPromptDefault`）+ `engineOnce` 懒构造 `*tr.Engine`（默认 `ProxyCleaner`，测试可经 `SetCleanerForTest` 注入 fake）+ 内置默认清理 system prompt 常量 |
| `nodepersister.go` | `registryPersister`：`tr.NodePersister` 生产实现，ramp-down 决策（`UpdateNodeConcurrency`/`DisableNode`）经 `registry.UpdateTextReviewNodeFields` 做字段级合并（只改 Concurrency/Enabled，保留 ProviderID/ModelID/IntervalSec/BatchChars）+ `SaveConfig` 持久化到 `config.yaml` |
| `routes_test.go` / `sessions_test.go` | 测试：路由注册契约 + 会话端点（含 fake Cleaner） |


### 10.24 `internal/api/archive/` — 归档能力 HTTP 表面（P2）

共享归档能力（ZIP/7z/RAR）的 HTTP 层：能力状态、source 登记（上传 ZIP/7z/RAR）、单条 entry 读取、asset 登记/释放、pack。薄翻译层——source/asset 都存于 `archivetool.Runner` 的 TempStore（服务端路径不出进程），每条 entry 路径经 foundation `StrictArchivePath` 再校验。挂载于 `/api/archive`（auth 中间件 + 绕过 1MiB 组级上限，逐路由 body cap 在 handler 内）；runner 经 `Router.SetArchiveRunner` 注入，nil 时全部端点返回诊断性 503 `archive.unavailable`。架构基线：[`docs/archive-architecture.md`](docs/archive-architecture.md) §5。

| 文件 | 职责 |
|---|---|
| `register.go` | `Handler`/`NewHandler(d, runner)` + `Register`（9 路由：`GET /status`、`POST /sources`、`GET /sources/{id}/entries/*`、`DELETE /sources/{id}`、`POST /assets`、`GET /assets/{id}`、`POST /pack`、`POST /release/{id}`、**`POST /zip-replace`**（P3：已登记 ZIP source 原子写回——replacements+deletes、严格路径、非 ZIP/只读 403、并发写回 409 `archive.busy`））+ 错误映射 `writeRunError`（ToolMissing→503、ToolTimeout→504、ReadOnly→403、Encrypted/MultiVolume/Corrupt→422、其余→502，稳定机器码）+ `detectFormat`（扩展名→magic 兜底）+ `mimeForName`/`kindForName` |

## 11. `internal/state/` — `state.yaml` 运行时持久化

架构基线见 [`docs/config-registry-state-architecture.md`](docs/config-registry-state-architecture.md)（与 config/registry 合著，含 Snapshot 格式、500ms 去抖、回调模式破除循环依赖、源码锚点）。

| 文件 | 职责 |
|---|---|
| `state.go` | `Snapshot`/`KeySnapshot`/`ComboSnapshot`/`ProbeRecord`/`ProbeDetail` 类型 + YAML 序列化；`CurrentVersion=1`；`Snapshot.Probes map[string]*ProbeRecord`（精简明细，不含请求/响应 body）；`Save` 委托 `fsutil.AtomicWrite` 原子写入 |
| `manager.go` | `Manager`：500ms 去抖 + 定时器 + 原子写（经回调快照，避免 import cycle）；快照提取在 `writeMu` 内，防并发 FlushSync 让旧快照覆盖新快照 |
| `state_test.go` | 测试 |

---

## 12. `internal/fsutil/` — 统一文件系统工具

原子写入、系统文件管理器/浏览器打开、文件/目录选择对话框的统一抽象。被 `config`、`state`、`api`、`app` 包共同依赖。

| 文件 | build tag | 职责 |
|---|---|---|
| `atomic.go` | — | `AtomicWrite(path, data, perm)`：确定性 `.tmp` + `os.Rename` 原子写（`.tmp` 先 `f.Sync` 保证崩溃后副本完整），失败回退直写；**直写回退成功也保留 `.tmp`** 作崩溃恢复源（下次 Load 成功加载后清理） |
| `open.go` | — | `ErrUnsupportedPlatform` 共享错误变量 |
| `open_windows.go` | `windows` | `OpenInFileManager`（ShellExecute + `/select,`）、`OpenInBrowser`（rundll32）、`OpenFilePicker`/`OpenDirectoryPicker`（原生 COM IFileOpenDialog，现代 Windows 10/11 对话框，返回绝对路径）；2026-07-25 修正 `IFileDialog::GetResult` vtable 索引 26→20；2026-08-03 修正 `GetOptions` vtable 索引 8→10（8 为 Unadvise），并注释 IFileDialog 完整 vtable 顺序 |
| `open_other.go` | `!windows` | macOS（`open -R`/`osascript`）、Linux（`xdg-open`）实现；文件/目录选择器 Linux 返回 `ErrUnsupportedPlatform` |
| `clipboard_windows.go` | `windows` | `GetClipboardFilePaths()`：读取 Windows 剪贴板 CF_HDROP 格式文件路径（OpenClipboard + DragQueryFileW） |
| `clipboard_other.go` | `!windows` | `GetClipboardFilePaths()` 返回 nil（非 Windows 平台不支持） |
| `atomic_test.go` | — | 测试（`TestAtomicWrite_RenameFallbackKeepsTmp` 2026-08-03 新增：rename+直写双失败保留 `.tmp`） |
| `atomic_windows_test.go` | `windows` | 2026-08-03 新增：`TestAtomicWrite_RenameFailsDirectWriteSucceeds_KeepsTmp`（重命名被共享锁挡住、直写成功时 `.tmp` 仍保留） |

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


## 13c. `internal/customheaders/` — Provider 自定义请求头

Provider 级可选请求头配置与统一应用工具。配置为空或开关关闭时为 no-op；应用顺序保持现有认证、Content-Type、流式 Accept 与 Cline 硬编码头行为，其中 Cline 头最后覆盖同名自定义值。

| 文件 | 职责 |
|---|---|
| `customheaders.go` | `Config` 与 `Apply`：对正常代理、GET 任务轮询、Provider 管理请求、多协议探测和 Combo 测速应用自定义请求头；跳过空名称及 CR/LF 注入 |
| `customheaders_test.go` | 测试禁用/空配置 no-op、覆盖、CR/LF 拦截 |
## 13e. `internal/filetransfer/` — 临时文件中转

Settings FileTransfer 的后端：接收浏览器 multipart 文件与受信任的本机剪贴板路径，提供本机路径递归容量查询，使用 ZIP Deflate 打包后按服务顺序尝试匿名临时文件主机。

| 文件 | 职责 |
|---|---|
| `upload.go` | `Handler.Upload`（`POST /api/filetransfer/upload` 组装 ZIP 并按顺序尝试临时服务；外部服务失败时返回错误，不保证上传成功）、`Handler.PathInfo`、本地文件/目录收集与容量统计、ZIP 打包、文件名清理与冲突改名；单文件与归档均有大小/数量上限，符号链接拒绝 |
| `upload_test.go` | ZIP 名称清理/去重、目录相对路径、容量统计与服务顺序回退测试 |

---
## 13d. `internal/procutil/` — 进程工具（跨平台进程组管理）
跨平台进程组管理工具，从 `internal/download/kill_unix.go` 中提取的重复代码统一为共享包。Unix 实现：SIGTERM → 2s grace → SIGKILL 兜底；Windows 实现：`taskkill /T /F`。无外部依赖（仅 stdlib）。

| 文件 | build tag | 职责 |
|---|---|---|
| `procutil_unix.go` | `!windows` | `KillProcessGroup(pid)` 先 SIGTERM 再 2s 后 SIGKILL；`SetProcessGroup(cmd)` 设 `Setpgid=true` |
| `procutil_windows.go` | `windows` | `KillProcessGroup(pid)` 执行 `taskkill /PID /T /F`；`SetProcessGroup(cmd)` 设 `CREATE_NEW_PROCESS_GROUP\|createNoWindow` |

`internal/download/` 的平台文件均委托此包实现进程组管理。

## 13e. `internal/archive/` — ArchiveCore 归档基础能力（P0/P1）

按 `archive_compatibility_plan.md` §3/§4 落地的 leaf 包（不依赖 Gallery/GIF/Download/API）。合同：`Format`/`Source`/`SourceRef`/`AssetRef`/`MediaAsset`/`Entry`/`Manifest`/`Budget` + `Reader`/`Writer` 接口；严格路径校验 + 碰撞检测 + 预算计数 + 文件型 `TempStore` + 保留 Gallery ZIP 语义的 ZIP adapter。外部工具（7z/RAR）见 `internal/archivetool/`（§13f），HTTP 表面见 `internal/api/archive/`（§10.24）。架构基线：[`docs/archive-architecture.md`](docs/archive-architecture.md)。

| 文件 | 职责 |
|---|---|
| `types.go` | 合同类型 + `Format.Valid` + 哨兵错误（`ErrEntryNotFound`/`ErrUnsafePath`/`ErrPathCollision`/`ErrUnsupportedFormat`/`ErrUnsupportedWriteback`/`ErrClosed`）+ `BudgetError`/`IsBudgetExceeded` |
| `path.go` | `StrictArchivePath`（归一化前拒绝 NUL/C0、绝对路径、盘符、UNC/`\\?\`、`.`/`..` 段、ADS、尾随点/空格、Windows 保留设备名；仅验证通过后 `\`→`/`）+ `ValidateEntryPaths`（全条目碰撞 map：精确/Windows 等价/文件即目录前缀）+ `IsDirEntry` |
| `budget.go` | 计划 §4.3 默认预算常量 + `DefaultBudget` + `Tracker`（条目数/单条/总展开/压缩比）+ `CapReader`/`ReadCapped`（limit+1 探测，同 gallery）+ `CountingWriter`（输出上限） |
| `charset.go` | `decodeZipName` CJK 探测还原（与 `internal/gallery/charset.go` 同行为，P3 去重） |
| `zip_adapter.go` | `ZIP{}` 实现 `Reader`：`List`（全条目、自然排序、严格校验全部条目、预算）+ `ReadEntry`（索引或严格路径、100 MiB 单条、content-type）；核心 `Replace`（保留原 header/comment/attributes 的原子回写语义 + 严格键） |
| `zip_writer.go` | `NewZIPWriter(store)` 实现 `Writer`：`ReplaceZIP`（输出新 asset，源文件不动）+ `Pack`（仅 zip；7z/rar → `ErrUnsupportedWriteback`；≤2000 文件） |
| `tempstore.go` | 文件型 `TempStore`：`<root>/<owner>/<job>/<id>_<name>` 布局、crypto/rand ID、名称净化、TTL/`Scavenge`/`ReleaseOwner`/幂等 `Release`/`Close` 清根 |
| `*_test.go` | `path_test`（strict+collision 表驱动）、`budget_test`（各维度上限）、`zip_adapter_test`（List/Read/Replace 语义+安全+预算）、`zip_writer_test`（Writer 合同）、`tempstore_test`（生命周期/TTL/owner 隔离） |

## 13f. `internal/archivetool/` — 归档外部工具层（P2）

`internal/archive` 的兄弟包（只 import foundation 合同 + `config.ArchiveConfig`）：7z/7zz/unrar/rar 可执行文件解析、能力探测、机器输出 list/read、pack，以及把工具 + foundation TempStore 装配成 API 消费的 `Runner`（deadline、进程组取消、有界 stdout/stderr、并发信号量）。架构基线：[`docs/archive-architecture.md`](docs/archive-architecture.md) §4。

| 文件 | 职责 |
|---|---|
| `tool.go` | `Resolver`（配置→`SEVENZIP_PATH`/`RAR_PATH`→PATH，30s probe 缓存，`UpdateSettings` 失效）+ `ToolError` 稳定机器码（Missing/Timeout/ReadOnly/Encrypted/MultiVolume/Corrupt）+ `parseToolVersion` |
| `status.go` | `Status`/`ToolStatus`：`/api/archive/status` 响应形状 `{zip,sevenZip,rar}` |
| `builders.go` | 7z/rar argv 构造（`l -slt -sccUTF-8 -p- --` / `x -so` / `lb -p- -idq` / `p -inul`；pack `a -t7z -mx=5` / `a -idq`）+ list 64MiB/pack 1MiB 输出上限 + pack MIME |
| `exec.go` | `runTool`/`runToolDir`：`exec.CommandContext` 无 shell + `procutil` 进程组整树 kill + 有界 stdout（超限 kill 子进程并报 budget err）/stderr 16KiB tail + 退出码启发式分类 |
| `parse.go` | `parseSevenZipSLT`/`parseRarLB`（机器格式）+ `buildManifest`（对工具输出**再走** foundation 严格校验 + collision + 预算 + 自然排序） |
| `external.go` | `NewExternalReader`/`NewExternalWriter`（7z/RAR List/ReadEntry/Pack，并发信号量 2；`ReplaceZIP` 恒 `ErrUnsupportedWriteback`；通配符元字符拒绝；输入 staging 私有 job 目录防绝对路径泄漏） |
| `runner.go` | `Runner`：`NewRunner(root, cfg)`（0700 workspace，失败只禁用归档能力）、`Store`/`Status`/`UpdateSettings`/`List`/`ReadEntry`/`Pack`（按格式分派 ZIP→stdlib、7z/RAR→外部工具）、`Scavenge`/`sweepOrphans`（2×TTL 清崩溃遗留）、`Close`/`IsClosed`、`ErrNoRunner` |

## 13g. `internal/feature/` — 编译期功能清单（P5 第一阶段）

计划 [`archive_compatibility_plan.md`](archive_compatibility_plan.md) §11/P5 的 registrar/asset-manifest 拆分落地：leaf 包（零依赖，仅 stdlib）声明 TinyRouter 编译期功能面——`ID`（`core`/`playground`/`download`/`archive`/`archive_external`/`gallery`/`gif`/`editor`/`filetransfer`，镜像计划 §11.2）、`DependsOn`（如 `gallery`/`gif`/`archive_external` → `archive`）、`StaticRoot`（`static` 或 `playground/static-pg`）与 `StaticFiles` 资产清单；`Enabled(id)` 是路由/组件门控的唯一检查点（依赖传播：禁用 `archive` 连带禁用 `gallery`/`gif`/`archive_external`），`Assets(root)` 按 feature 注册序返回启用 feature 的资产列表。

接线（默认构建全启用，行为与改动前一致）：`internal/api/router.go::Routes` 顶部 `feature.SetCompiled(feature.Playground, web.PlaygroundCompiled())`（唯一真实编译信号），download/gallery/filetransfer/archive/editor(+text-review) 路由组经 `feature.Enabled(...)` 门控，`web/playground/static-pg` 按文件静态路由列表改由 `feature.Assets(feature.RootPlaygroundPG)` 派生（与旧硬编码 pgJSFiles 列表逐项同序，`internal/feature` 测试锁定）；`internal/app/app.go::buildComponents` 的 download manager 与 archive runner 构造经 `feature.Enabled(...)` 门控（禁用时 nil：router 不注册对应路由、`Router.Cleanup`/`Shutdown` 均判空）。

**诚实边界（不虚假声明裁剪）：** 除 playground 静态 embed 外**尚无 feature build tag**——上述包今天全部无条件编译，manifest 中 `Compiled` 恒 true；ComfyUI/Image Batch/AnySearch 是 Playground 附属后端但无条件编译，路由组刻意不门控（注释标明 P5 blocker）。真实裁剪的剩余阻塞（tag 化包本身、按 feature 拆 embed、index.html 脚本清单 manifest 化、build.ps1 `-Features`）见 [`docs/build-variants.md`](docs/build-variants.md)「编译裁剪边界」。

| 文件 | 职责 |
|---|---|
| `feature.go` | `Feature` 描述符 + `Register`/`SetCompiled`/`Enabled`/`Get`/`All`/`Assets` + 默认 manifest（sync.Once 注册） |
| `feature_test.go` | 默认全启用、ID 唯一、依赖闭包/传播、资产存在性与 pg 资产列表逐项同序合同、Register 替换 |
---


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
| 入口 | `index.html`、`index-nopg.html`（可访问 `nav[aria-label="Primary navigation"]`；顶层 Download/GIF 已收纳到 Utility 菜单，active header label 显示当前工具；Utility 子工具为 `editor`/`logReader`/`review`/`gif`/`download`/`fileTransfer`；fresh init 只显示 landing，不预选工具；F5 打开 Utility 菜单，F4 直达 Gallery，无旧 Gallery↔Editor toggle） |
| JS 模块 | `app.js`、`api.js`、`auth.js`、`i18n.js`、`theme.js`、`info_common.js`（共享 info modal 的 section/field Pretty/Raw/Copy、直接 Raw 文本与兼容边界）、`providers.js`、`combos.js`、`quickslots.js`、`headerStats.js`、Monitor 拆分模块（`web/static/monitor/`，其中 `monitor_modal.js` 固定六个 Recent Requests 详情 section，Status 为静态行，其余 section 默认折叠并提供 section/字段级 Pretty/Raw/Copy、两级 sticky header）、`console.js`、`download.js`、`filetransfer.js`（Utility FileTransfer：任意文件拖拽/粘贴、Clear、上传进度与确认上传）、Settings 拆分模块（`web/static/settings/`）、`utility/editor/`（File Editor、Log Reader、Text Review）与 `gif-editor/`（GIF 页面 state/import/timeline/playback/export/editor）`
| vendor | `vendor/gif.js/`、`vendor/gifuct-js/`（各含 LICENSE）；`vendor/utility-editor/`（`diff-match-patch`、`markdown-it`、`dompurify`、`turndown`、`prism`，各含 LICENSE）。Editor 的 Markdown preview 使用 `markdown-it` + sanitization；StackEdit-inspired shell 仅是本地能力边界，不是完整 StackEdit/cledit/PageDown，也未移植远程服务。 |
| 样式 | `style.css` |

> **当前入口与资产契约（2026-08-08）：** `internal/feature/feature.go` 的 Editor manifest 使用 `RootStatic`，路径为 `utility/editor/*`；同一资产根提供 Editor、Log Reader、Text Review 的脚本与 `review.js`。`feature.Assets(RootStatic)` 同时包含 Download、GIF、FileTransfer 与 Utility 资产，`web/embed.go`/`web/embed_playground.go` 均从 `web/static` 提供这些文件。`index.html` 与 `index-nopg.html` 的 Utility 相关脚本均按 `/utility/editor/*` 加载；Playground 专属 `web/playground/static-pg/` 不再承载 Editor/Log Reader/Text Review 资产。
>
> **当前 Utility Editor 工作区与页面边界：** Editor 是独立 Utility `editor` tool，默认与 `-tags playground` 构建均可用。`editor_workspace.js` 以 IndexedDB 持久化工作区，不可用时回退内存；内置 Welcome/Trash/Temp，并支持文件 CRUD、move、restore、current file、expanded metadata 与文件夹展开集合持久化。`editor_layout.js`/`editor_shell.js` 提供 StackEdit-inspired Explorer、导航/格式控件、单一主 textarea 与 preview、TOC/status/control toggles、查找/替换；`editor_commands.js` 提供本地编辑、撤销/重做与格式化命令，`editor_shell.js` 提供 Markdown import、Markdown/HTML export 与 print，`editor_markdown.js` 负责 Markdown preview 与 sanitization。Editor 与 Log Reader (`editor-logs.js`)、Text Review (`review.js` + `editor_textreview_*`) 仍是独立 Utility tools；不提供 cloud/sync/accounts/comments/PDF/Pandoc，数学公式未在 Editor 中单独启用 KaTeX。`suspendEditor`/`resumeEditor` 是 Editor Utility 切换生命周期边界。
>
> **后端路径不随 UI 重组改变：** Editor 仍使用 `/api/editor/*`，其中 `POST /api/editor/open` 与 `POST /api/editor/save` 保持原有契约；Text Review 仍使用 `/api/text-review/*`，FileTransfer 仍使用 `/api/filetransfer/*`。`app.js` 在 Utility 子工具切换时调用各工具的 suspend/resume hooks，离开时执行各自 cleanup。
> **历史说明：** 旧的两 pane raw/parsed、Clean/Review tab 与 Playground Editor 资产路径仅保留在历史迁移记录中，不代表当前 Editor shell。
### 18.3 `web/playground/` — Playground 模块（仅 `-tags playground` 内嵌）

| 类别 | 内容 |
|---|---|
| JS 加载顺序 | `playground/` 子目录：`pg-i18n.js` → `pg-core.js` → `pg-state.js` → `pg-markdown.js` → `pg-request.js` → `pg-stream.js` → `pg-comfyui.js` → `pg-image-model.js` → `pg-image-inspire.js` → `pg-image-batch.js` → `pg-autochat.js` → `pg-setup.js` → `pg-director.js` → `pg-search.js` → `pg-render.js` → `pg-ui.js` → `pg-modal.js` → `pg-lifecycle.js`，随后 `gallery/` 脚本；Utility 的 Editor/Log Reader/Text Review 不属于 Playground 静态路由 |
| 图片模块 | `playground/`：`pg-image-model.js`（Manual Canvas generation/asset history、remote/Comfy result normalization、regenerate/delete、generation-aware autosave）；`pg-image-inspire.js`（Natural/Tag/JSON helper modal）；`pg-image-batch.js`（three-step plan/transform/review、snapshot-first SSE、refresh/pause/resume/stop controls、Prompt × Variant viewer；多窗口 Image 模式禁用 Batch Project） |
| 其他模块 | `playground/`：`pg-core.js`、`pg-state.js`、`pg-request.js`、`pg-stream.js`、`pg-comfyui.js`（每窗口 Comfy runtime、协议回退、按名称去重 Tab Select）、`pg-render.js`、`pg-ui.js`（Image 多窗口独立设置与 pane 选择）、`pg-modal.js`、`pg-lifecycle.js`、`pg-autochat.js`、`pg-setup.js`、`pg-director.js`、`pg-search.js`；`gallery/` 子目录文件。Utility 的 Editor/Log Reader/Text Review 不在 `static-pg` |
| vendor | `marked.min.js`、`marked-katex-extension`、`katex.min.js`/`.css`、`mermaid.min.js`、`highlight.min.js`、`purify.min.js`、`diff.min.js`、`pg-highlight-theme.css`、`fonts/`(KaTeX woff2)；另有 `web/static/vendor/`（gif.js/gifuct-js）由 `/vendor/*` handler 的主静态回退提供（`internal/api/router.go` `vendorHandler` 先查 playground vendor 目录，未命中回退 `web.Static` 主静态） |
| 样式 | `playground.css`（Manual Canvas、Inspire、Batch 与既有 Playground/Gallery 样式）；Utility Editor/Log Reader/Review 样式由 `web/static/style.css` 与 Utility 资产自身 class 使用 |
| 静态路由 | `static-pg` 按文件路由由 `internal/feature/feature.go` 的 `StaticFiles` manifest 经 `feature.Assets(RootPlaygroundPG)` 派生（`internal/api/router.go`），当前仅承载 `playground/` 与 `gallery/` 子目录；无硬编码 `pgJSFiles` 列表；URL 路径 = 子目录相对路径（如 `/playground/pg-core.js`、`/gallery/gallery.js`），不提供 Utility Editor/Log Reader/Review 路径 |
---

## 19. `docs/` — 文档

| 路径 | 状态 | 内容 |
|---|---|---|
| `archive_compatibility_plan.md`（根目录） | **当前/实施计划** | ZIP/7z/RAR 统一归档能力、Gallery/GIF/Download MediaBridge 交接、路径与资源安全、feature build profiles 的实施前冻结方案 |
| `docs/archive-architecture.md` | **当前/权威** | 归档基础层（ArchiveCore）架构基线：`internal/archive`（P0/P1 合同/严格路径/预算/ZIP adapter/TempStore）、`internal/archivetool`（P2 外部工具层）、`internal/api/archive`（HTTP 表面）、`Config.Archive`/Settings、MediaBridge 交接契约、与冻结计划的偏差、P3-P6 未实施项 |
| `docs/playground-architecture.md` | **当前/权威** | Playground 前后端架构基线（共享时间线群聊模型、Director/Narrator、场景、源锚点） |
| `docs/proxy-architecture.md` | **当前/权威** | Proxy 代理核心架构基线（调用链、重试/故障转移状态机、SSE 透传、Gemini 签名回填、在途跟踪、源码锚点） |
| `docs/rotation-architecture.md` | **当前/权威** | Rotation Key 轮询架构基线（SelectKey 算法、三种策略、两套退避系统、配额锁 CST 00:05、NIM、错误分类、源码锚点） |
| `docs/download-architecture.md` | **当前/权威** | Download 下载架构基线（任务队列生命周期、yt-dlp 参数构造、SSE 进度、与归档计划漂移、源码锚点） |
| `docs/combo-architecture.md` | **当前/权威** | Combo 组合策略架构基线（Resolve 算法、三种策略目标排序、greedy-squirrel 配额层级、状态持久化、源码锚点） |
| `docs/config-registry-state-architecture.md` | **当前/权威** | Config/Registry/State 基础设施架构基线（三层归属边界、原子持久化、AES-GCM 加密、双锁模型、reload merge、回调去抖、源码锚点） |
| `docs/providerinfo.md` | 参考 | 各 Provider API 参考笔记（响应 schema、限速头、错误码） |
| `docs/research/` | 参考 | 调研笔记（`request.md`、`respond.md` 等） |
| `docs/archive/` | 归档 | 历史规划/审计/交接文档，**非当前事实来源** |

---

## 20. 脚本与构建产物

| 文件 | 职责 |
|---|---|
| `build.ps1` | Windows 构建脚本，产出 13 个变体（default/tray/webview/debug × playground/strip） |
| `build_mac.ps1` | Windows 交叉编译 macOS 双架构无签名、未压缩裸 Mach-O：`TinyRouter_Darwin_arm64` 与 `TinyRouter_Darwin_amd64`；不创建 `.app` Bundle |
| `build-minimal-webview-pg.ps1` | Windows/Linux 极限体积构建；默认不压缩 Windows PE（规避 `STATUS_INVALID_PAGE_PROTECTION (0xC0000045)`），仅传 `-Upx` 时使用 UPX（Darwin 目标由 `build_mac.ps1` 接管，避免 UPX 压缩 macOS 二进制） |
| `gen-icon.ps1` | 从 `web/static/logo.png` 经 `rsrc` 生成多尺寸 `favicon.ico` |
| `rsrc.manifest` | Windows exe 清单 |
| `rsrc.syso` | 图标资源（`go:generate` 自动同步，gitignored） |

构建变体与 build tag 矩阵详见 **README.md "构建变体"** 与 **AGENTS.md "构建变体"**；macOS 双架构说明见 [`docs/build-variants.md`](docs/build-variants.md)。

---

## 21. 运行时文件（gitignored，首次运行生成）

| 文件 | 生成方 | 内容 |
|---|---|---|
| `config.yaml` | `internal/config` | providers + combos + settings |
| `state.yaml` | `internal/state` | key/combo 运行时状态（冷却级别、模型锁、轮转索引） |

---

## 22. Gitignored 参考副本（非本项目模块）

> 当前无。原 `new-api/`（QuantumNous/new-api 克隆，约 31 MB）参考副本已于 2026-07-31 移除，Playground 模块不再参考该项目。9router 参考副本位于仓库外 `Z:\Playground\9router`（见 AGENTS.md「参考来源」）。

---

## 23. 规划中 / 暂未实现（占位）

> 以下为已冻结但尚未实施的功能计划。实施完成后，必须把对应模块、源码锚点和构建边界移入上文，并删除或更新本条目。

- `archive_compatibility_plan.md`：ZIP/7z/RAR 统一 ArchiveCore、Gallery/GIF/Download MediaBridge、严格路径与资源预算、feature build profiles。**P0/P1 已落地**（`internal/archive/` §13e）；**P2 已落地**（`internal/archivetool/` §13f + `internal/api/archive/` §10.24 + `Config.Archive`/Settings presence-aware PATCH + `web/static/media-bridge.js` 交接契约）；**P3 部分落地**：Gallery 后端桥接（`archiveBridge` + `zip-replace`）+ 前端 sourceId 双路径（读取/删除/审核/编辑），**旧 `/api/gallery/zip*` 与 `/edit/zip-outputs|zip-writeback|extract-zip-entry|upload-temp` 端点保留、前端 legacy 调用方未删**（FSAA/拖放/粘贴仍走 zip 会话；计划 §7.2"迁移完成后删除"未执行；**原生 picker `accept` 仍只含 `.zip`**——`gallery-layout.js:15`，.7z/.rar 用户文件导入无前端路径，`isArchiveName` 识别后仍走 zip-only 上传）；**P5 第一阶段已落地**（`internal/feature` §13g manifest + `feature.Enabled` 门控，feature_* tags 未实施）；**未实施：P4**（GIF 导出格式选择 + 帧 asset 化全量迁移）、**P5 tags/profiles**、**P6**（7z/RAR 原文件替换）。

---

## 24. 常见变更任务速查表

> 从**变更任务**出发的反向索引。先读"先读文档"列对应的架构基线，再按"涉及源码"列定位修改点。跨模块变更须同时读多份文档的"变更维护清单"。

| 变更任务 | 先读文档 | 涉及源码 |
|---|---|---|
| FileTransfer 临时文件中转 | config-registry-state | `internal/filetransfer/upload.go`（`POST /api/filetransfer/upload` multipart 文件/本机剪贴板路径收集、ZIP Deflate、tfLink → tmpfiles.org → temp.sh → Filebin 顺序回退；外部服务失败时返回错误，不保证上传成功）+ `internal/api/router.go`（`/api/filetransfer` 路由组：认证与 600MB body 上限，`POST /upload` 与 `POST /path-info`）+ `web/static/filetransfer.js`（Utility FileTransfer：任意文件拖拽/粘贴、确认、进度、Clear、`suspendFileTransfer`/`resumeFileTransfer` 生命周期）+ `web/static/index.html`/`index-nopg.html`（Utility 入口脚本） |
| 新增/修改 Provider API 类型 | config-registry-state、proxy、rotation | `config/types.go`（`APIType`/`IsNIM`/`IsGeminiOpenAICompat`/`IsCline`）、`config/validate.go`、`rotation/nim.go`、`proxy/forward.go`、`proxy/upstream.go`（`applyClineHeaders` 域名特例请求头注入） |
| 新增 Key 轮询策略 | rotation | `rotation/strategy.go`+`selector.go`、`config/types.go`（`RotationConfig`）、`proxy/forward.go`（`forwardWithRetry`） |
| 新增管理 API 端点 | （对应模块文档）、config-registry-state | `api/router.go`（挂载+鉴权边界）、`api/<域>.go`、`registry/<域>.go` |
| 新增/修改归档能力（ZIP/7z/RAR） | docs/archive-architecture.md、config-registry-state | `internal/archive/`（§13e：合同/严格路径/预算/ZIP adapter/TempStore）、`internal/archivetool/`（§13f：Resolver/Runner/exec/parse/builders）、`internal/api/archive/register.go`（§10.24 端点，含 **P3 `POST /zip-replace`**）、`internal/api/router.go`（`/api/archive` 路由组 + `SetArchiveRunner` + `ArchiveSettingsFn` 闭包 + **`galleryHandler.SetArchive(archiveHandler)`**）、`internal/app/app.go`（buildComponents 创建 runner + Scavenge + Shutdown Close）、`internal/config/types.go`（`ArchiveConfig`）+ `paths.go`（`ResolveArchiveTempDir`）、`internal/api/settings/register.go`（GET `archive` 对象 + `archivePatch` presence-aware PATCH）、`internal/api/apibase/deps.go`（`ArchiveRunner` 接口 + `ArchiveSettingsFn`）、`internal/api/gallery/register.go`（`archiveBridge` + `SetArchive`） |
 | 修改媒体交接（MediaBridge） | docs/archive-architecture.md §7/§8、playground | `web/static/media-bridge.js`（`register`/`openGallery`/`consume`/`deliverPendingImports`/`getAssetBlob`/`archiveStatus`）+ `web/media-bridge.test.js`（embed 目录之外的 Node 冒烟测试）；生产者：`web/static/download.js::playVideo`（MediaAsset 注册 + 受控 URL）、`web/static/gif-editor/gif-editor-export.js`（`openResultInGallery`/`lastResultAsset` + 「Open in Gallery」，导出结果统一登记 MediaAsset）；消费者：`web/playground/static-pg/gallery/gallery-io.js::galleryImportAssets`（唯一写 `galleryState` 入口）、`gallery.js::renderGallery`（`deliverPendingImports`）；加载顺序：`index.html`/`index-nopg.html` 最先加载；i18n：`mediaBridge*` 键 |
| 修改 Gallery 归档源条目（sourceId，P3 双路径） | docs/playground-architecture.md §16、docs/archive-architecture.md §5.1/§12 | 前端：`web/playground/static-pg/gallery/gallery-io.js`（`getZipEntryBlob` sourceId 分支读 `/api/archive/sources/{id}/entries/*`、`rehydrateZipSession` 双路径重登记、`_ARCHIVE_IMG_EXTS` 图片过滤）、`gallery-tree.js`（source 分组删除 `DELETE /api/archive/sources/{id}`）、`gallery-fullscreen.js`（`_zipReplaceDeleteEntries` 经 `/api/archive/zip-replace` + `/api/archive/assets/{id}`）、`gallery-review.js`（sourceId 审核启动/轮询）、`gallery-edit.js`/`gallery-edit-batch.js`（extract 送 `body.sourceId`）；后端：`internal/api/gallery/register.go`（`archiveBridge`/`SetArchive`）、`edit_handlers.go::galleryEditExtractZipEntry`（sourceId 分支）、`review_handlers.go`/`review_engine.go`（sourceId + `readEntry` 闭包）、`internal/api/archive/register.go::zipReplace`。**legacy 调用方保留**（`/api/gallery/zip/{sid}*`、`zip-from-path`、`/api/gallery/zip`、`/edit/extract-zip-entry|upload-temp|zip-outputs|zip-writeback`）；**.7z/.rar 用户导入缺口**：picker `accept` 仅 `.zip`（`gallery-layout.js:15`），`isArchiveName` 识别 .7z/.rar 后仍走 zip-only 上传 |
| 新增/修改 Combo 策略 | combo、proxy | `combo/resolver.go`、`proxy/forward.go`（`handleCombo`）、`config/types.go`（`Combo`） |
| Combo 批量测速排序 | combo、proxy | `internal/api/combos/register.go`（`speedTestCombo` SSE handler + `probeComboModel`，复用 `proxy.BuildUpstreamURL/SSELineBuffer/SSEDataPayloads`、`util.ExtractTokens`、`probe_common.go::extractContentFromSSE`、`providers_validate.go::firstActiveKey`、`proxy/handler.go::ManagementClient`）、`registry/combos.go`（`GetComboByID`）、`api/router.go`（路由注册）、`web/static/combos.js`（`runComboSpeedTest` + 编辑弹窗按钮 + `renderComboModelsList` 行 `data-fullid`/状态 span）、`web/static/i18n.js`（`comboSpeedTest*` 键） |
| 修改 SSE 流式透传 | proxy | `proxy/stream.go`、`proxy/forward.go` |
| 修改非流式 keep-alive 刷新 / 图片长响应超时 | proxy | `proxy/forward_retry.go`（原 `forwardWithRetry` 内 keep-alive ticker 已于 H-8 修复中移除——见 §8.7；非流式不再提前提交 200，全 key 耗尽恢复 502）、`internal/api/compress/compress.go`（`/v1/images/*` 绕过列表，历史遗留，现 keep-alive 已无）、`proxy/stream.go`（`passThroughResponse` `headersFlushed` 参数已移除，恒写头 + `WriteHeader(resp.StatusCode)`）；前端 `pg-stream.js`（`pgSendImage` imgTimer）、`pg-render.js`（`pgTickWaiting` 安全网） |
| 修改上游 URL/body 改写 | proxy | `proxy/upstream.go`、`proxy/forward.go` |
| 修改全局快捷键/键映射 | PROJECT_MAP §18.2 | `web/static/shortcuts.js`（`SHORTCUT_PRESETS` 系统预设 + `Shortcuts` API；当前 F5=`global.goto-download` 打开 Utility 菜单，F4=`global.goto-gallery` 直达 Gallery，无旧 Editor toggle）、`web/static/app.js`（全局 keydown、Utility 子工具生命周期与 cleanup）、`web/static/settings/settings_shortcuts.js`（快捷键设置摘要与覆盖）+ `internal/api/settings/register.go`/`internal/config/types.go`（用户覆盖持久化） |
| Provider 列表顺序调整与避让 | config-registry-state | `registry/providers.go`（`ReorderProvider`）、`internal/api/providers/register.go`（`reorderProvider`）、`api/router.go`（`PUT /providers/{id}/reorder`）、`web/static/providers.js`（`renderProviderDetail` 顶栏排序输入框 + `changeProviderOrder`）、`web/static/style.css`（`.btn-order-input`）、`web/static/i18n.js`（`providerOrder*`/`invalidOrderRange` 翻译键） |
| 修改 Gemini thought_signature 回填 | proxy | `proxy/signature_cache.go`+`forward.go`+`stream.go`、`config/types.go`（`IsGeminiOpenAICompat`） |
| 新增管理 API 端点 | （对应模块文档）、config-registry-state | `api/router.go`（挂载+鉴权边界）、`api/<域>.go`、`registry/<域>.go` |
| 新增/修改配置字段 | config-registry-state | `config/types.go`（`ModelDef` 含 `Alias`/`Note`/`NIMOver`/`Kind`/`ImgProtocol`/`ImgSizes`；顶层 `Shortcuts ShortcutsConfig` 用户覆盖 + `QuickSlotOnly bool` 开关）+`defaults.go`（`finalizeConfig`，含 `Shortcuts` nil→空 map 归一）+`persistence.go`（严格解析）+`internal/api/settings/register.go`（`getSettings` 返回 `shortcuts`/`quickSlotOnly`、PATCH 接收 `shortcuts`/`quickSlotOnly`）+`api/router.go`（`quickSlotOnly atomic.Bool`）+`proxy/handler.go`（`quickSlotOnlyProvider`）+`proxy/models.go`（`ListModels` 过滤门控）+`web/static/shortcuts.js`（前端系统预设与 `Shortcuts.matchEvent`）+`web/static/settings/settings.js`（左侧边栏开关）+`web/static/i18n.js`（翻译键） |
| 修改全局快捷键/键映射 | PROJECT_MAP §18.2 | `web/static/shortcuts.js`（`SHORTCUT_PRESETS` 系统预设 + `Shortcuts` API）、`web/static/app.js`（全局 keydown 改 `Shortcuts.matchEvent`）、`web/playground/static-pg/playground/pg-ui.js`+`pg-autochat.js`+`gallery-fullscreen.js`（按区域改 `matchEvent`）、`web/static/settings/settings_shortcuts.js`（`openShortcutsModal` + `getShortcutSettingsSummary`/`updateShortcutSettingsSummary` 动态摘要 + `closeShortcutsModal` 取消恢复）、`internal/api/settings/register.go`（`shortcuts` 字段流转）、`internal/config/types.go`（`ShortcutsConfig`） |
| 修改 QuickSlot 头部交互 / Active 联动 | PROJECT_MAP §18.2 | `web/static/quickslots.js`（`openModelSelectorModal` 统一抽取全站模型选择模态框 + `openQuickSlotModalByOrder`/`openQuickSlotModalById`/`_qsModal*` modal 系统 + import... 尾项 + `+` 快捷键 + capture 阶段键盘处理 + 1s 自动关闭门限 + Del 删除 + `setupImportModalKeyboardAndFocus` + `attachModalFocusTrap` 导入 modal 焦点/Tab 锁/上下键/PgUpPgDn/Space/Enter 交互 + `_qsActiveId`/`qsSetActive`/`qsClearActive`/`qsGetActiveModel`/`_qsUpdateActiveClass` active 联动）、`web/static/combos.js`（`importModelsFromProvider` 复用 `openModelSelectorModal`）、`web/static/app.js`（1-9 改调 `openQuickSlotModalByOrder(n, true)`，移除旧 Alt/Ctrl+1-9）、`web/static/shortcuts.js`（移除旧 quickslot-import/delete 预设）、`web/static/style.css`（`.quickslot-header` 优先级高于 `.top-header-stats` + `.import-model-item.focused` 高亮 + `outline-offset: -1px` 修复焦点轮廓线截断）、`web/static/i18n.js`（`qsModalHint` + `import` 翻译键） |
| 修改下载参数/任务生命周期 | download | `internal/download/args.go`+`executor.go`+`manager.go`、`internal/api/download/register.go`、`web/static/download.js`（Utility 的 Download 子工具；`suspendDownload`/`resumeDownload` 与导航切换生命周期） |
| 修改本地密码/鉴权 | config-registry-state | `config/defaults.go`（`finalizeConfig` Security 一致性归一化）、`config/crypto.go`、`internal/api/auth/handler.go`+`rate_limit.go`+`auth_test.go`（LoginHandler 移除防御性绕过）、`internal/api/settings/register.go`（`updateSettings` 拒绝无密码开启保护）、`config/types.go`（`SecurityConfig`）、`web/static/settings/settings.js`（`togglePasswordProtection` 打开 modal 而非直接 PATCH）、`web/static/auth.js`（登录失败允许重试而非退出）、`web/static/i18n.js`（`passwordChangeHint` 键） |
| 修改 NIM 限速 | rotation | `rotation/nim.go`+`selector.go`（`IsNIMEnabled`）、`config/types.go`（`NIMSettings`+`ModelNIMOverride`）、`proxy/retry.go`（429 分发）、`proxy/interfaces.go`（`KeyProvider`）、`proxy/forward.go`（NIM 门控） |
| 修改配额锁/冷却退避 | rotation | `rotation/cooldown.go`、`config/defaults.go`（`BackoffMaxSec`） |
| 新增 Provider 限速头解析 | rotation | `rotation/ratelimit.go`（adapter）、`proxy/recorder.go` |
| 修改下载参数/任务生命周期 | download | `download/args.go`+`executor.go`+`manager.go`、`internal/api/download/register.go`、`web/static/download.js` |
| 修改前端页面/资产 | PROJECT_MAP §18 | `web/static/<page>.js`、`web/static/utility/editor/*`（Editor：`editor-state.js`/`editor_workspace.js`/`editor_commands.js`/`editor_markdown.js`/`editor_layout.js`/`editor.js`/`editor_shell.js`/`editor-logs.js`；独立 Text Review wrapper 与 wizard）、`web/static/vendor/utility-editor/*`（各依赖许可证）、`web/static/index.html`、`web/static/index-nopg.html`、`internal/feature/feature.go` 的 RootStatic manifest |
| 修复 Quota Monitor latency/avg-speed 空白及首次加载空白 | proxy、config-registry-state | `web/static/monitor/monitor_quota.js::refreshAllKeyDetails` 为每个 quota bar 拉取 `monitor/model-keys` 以回填未展开主行指标；`internal/api/monitor/register.go::getQuotas` 把非 Playground `EntryTracker` 在途请求加入 provisional bar，避免请求完成前 quota 表为空；`docs/proxy-architecture.md` 记录两项修复 |
| 修复 Monitor Recent Requests 分页状态 | proxy、config-registry-state | `web/static/monitor/monitor_recent.js::updateRecentPagerState` 计算 `atFirst`/`atLast` 后同步上一页/下一页 `disabled` 与 `pager-disabled` class，修复 `atFirst is not defined` 导致 Monitor 首次渲染失败；`docs/proxy-architecture.md` 记录修复 |
| 修改 Monitor Recent Requests 详情弹窗 | proxy、playground | `web/static/monitor/monitor_modal.js`（六个固定 section：`Request Info`/`Request`/`Request Headers`/`Response Headers`/`Status`/`Response Body`；Status 静态行，其余 section 默认折叠并提供 section 级 Pretty/Raw/Copy + 字段级 Pretty/Raw/Copy；section/field Raw 直接显示原文；两级 sticky header）+ `web/static/info_common.js`（`renderInfoSection`/`buildInfoField` 共享兼容边界，直接 Raw 文本，其他调用方默认行为不变）+ `web/static/style.css` + `docs/proxy-architecture.md`/`docs/playground-architecture.md`
| 新增/修改 build tag 或平台构建 | （AGENTS.md 构建变体）、`docs/build-variants.md` | `build.ps1`、`build_mac.ps1`、`build-minimal-webview-pg.ps1`、`host_*.go`、`web/embed*.go`、`internal/app/browser_*.go` |
| 新增/修改 feature tag 或构建 profile（P5） | docs/build-variants.md「编译裁剪边界」、docs/archive-architecture.md §1/§12、archive_compatibility_plan.md §11、PROJECT_MAP §13g | **第一阶段已落地**：`internal/feature` manifest（`Register`/`SetCompiled`/`Enabled`/`Assets`）+ `internal/api/router.go` 路由门控（download/gallery/filetransfer/archive/editor/text-review；pg 静态路由经 `feature.Enabled(Playground)` + `feature.Assets(RootPlaygroundPG)` 派生）+ `internal/app/app.go::buildComponents` 组件门控（download manager / archive runner；默认构建全启用，行为不变）。**feature_* build tags 未实施**——真裁剪剩余阻塞：tag 化包本身（gallery/download/mediaedit/filetransfer/textreview/archive/archivetool/api/*）、按 feature 拆 go:embed、index.html/index-nopg.html 脚本清单 manifest 化、`build.ps1`/`build_mac.ps1` 增 `-Features`（minimal/media/portable/full）；`internal/feature/feature_test.go` 锁定默认全启用 + 资产列表同序合同 |
| 修改前端页面/资产 | PROJECT_MAP §18 | `web/static/<page>.js`、`web/static/index.html`、`web/playground/static-pg/` |
| 修改 Header 页面切换按钮样式与 Header Brand Logo | PROJECT_MAP §18.2、DESIGN.md | `web/static/index.html`/`index-nopg.html`（可访问 nav shell + Logo 保持比例自适应与 nav 按钮容器等高、Title 40px flex 居中与右侧 nav 按钮文字垂直对齐、.theme-switch 40px 等高底对齐日夜交替动画切换控件）、`web/static/style.css`（`h1` 40px 容器 `display:flex; align-items:center` 垂直居中对齐 nav 按钮文字；.theme-switch `--toggle-size: 16px` 保持 2.25 宽高比下 40px 高度；`.sidebar-brand-content` padding:0 与 `.header-controls` margin-bottom:0 实现底对齐）、`web/static/app.js`（`updateThemeButton` 同步 `#theme-switch-checkbox` 状态） |
| CSS/HTML 样式移植与验证 | css_implement_tips.md、PROJECT_MAP §18.2、DESIGN.md、css_upgrade_plan.md | `css_implement_tips.md`（参考代码拆解、TinyRouter shell/theme/embed 约束、结构→效果流程、视觉验证清单与失败模式）、`css_upgrade_plan.md`（CSS 优化计划：覆盖 CSS 基线、Token、cascade、共享控件、响应式/可访问性与条件式拆分）。2026-08-07 已完成四批高置信度语义 Token 清理 + Phase 2 两批证明安全重复删除/收窄 + 第五批 DESIGN token 层一致性核验（token 完全一致；reduced-motion 契约已按代码事实修正 DESIGN.md，并经浏览器 reduce 实测一致）+ 圆角 Token 化 10 行 + Phase 0 全部审计产物（selector/var/颜色 A/B/C 分类/JS 内联/页面矩阵/!important/HTTP 基线）+ 控件状态/模块归属表 + Phase 5/6 审计；累计 diff：style.css +24/−40、playground.css +9/−12；**HTTP/浏览器验证已执行**（§1.19：两 shell CSS/vendor 全 200、0 console/page error（唯一 request abort 为 /api/monitor/events SSE 导航中止，应用行为）、主题矩阵 9 组合、3 档宽度无溢出、modal/dropdown 无裁切；证据 tmp/css-verify/evidence/ gitignored）；完成度总览与剩余风险见 §1.20（截图与全 72 组合/完整交互矩阵仍为人工/部分）。 |
| 新增/修改 Gallery 图片查看器 / AI Review 审核 | playground | `web/playground/static-pg/gallery/gallery.js`+`gallery-tree.js`+`gallery-review.js`+`gallery-fullscreen.js`+`gallery-state.js`+`gallery-io.js`、`internal/api/gallery/review_handlers.go`+`review_engine.go`（`runReview` 120ms Stagger 错开步长 + `sendVisionRequest` 45s 超时 Context + 2 次静默重试退避 + `galleryCancelReview` 3s 超时防死锁）+ `internal/api/gallery/fs_handlers.go`（`galleryListDir` 400 校验）、`internal/api/gallery/zip_handlers.go`（`galleryZipFromPath` 解析/校验 `{path}`，粘贴 ZIP 路径导入）、`internal/gallery/{zip,tiff}.go`、`internal/api/router.go`、`web/static/{index.html,app.js,style.css,i18n.js}`。**多节点选择**：Header 三态模式（`SelectAll/DeSelect|Start|Cancel`）+ 节点 Shift 范围连选 + `buildReviewQueue` 顺序队列引擎；**双轴方向键导航与防冲刷**：左右方向键（`goReviewPrev`/`goReviewNext`）在已审核节点匹配项间流转，上下方向键（`goReviewPrevNode`/`goReviewNextNode`）跳转节点；`updateCurrentFolde…
| 新增/修改 GIF 编辑器页面与 Gallery 动画支持 | gif_implented.md（实施入口）、playground | `web/static/gif-editor/gif-editor-state.js`、`web/static/gif-editor/gif-editor-import.js`、`web/static/gif-editor/gif-editor-timeline.js`、`web/static/gif-editor/gif-editor-playback.js`、`web/static/gif-editor/gif-editor-export.js`、`web/static/gif-editor/gif-editor.js`（GIF 帧编辑器 SPA 页面模块与 5 个子模块，模块职责/导出函数见 §18.2；入口 `renderGifEditor(container)`/`cleanupGifEditor()`，第 6 导航按钮 `data-page="gif"`）、`web/static/vendor/gif.js/`（`gif.js`+`gif.worker.js`+LICENSE，MIT 编码器；`gif.worker.js` 为 gif.js 运行时 workerScript，非 `<script>` 标签）、`web/static/vendor/gifuct-js/`（`gifuct-js.js`+LICENSE，MIT 解码器 esbuild bundle）、`web/static/{index.html,index-nopg.html}`（第 6 按钮 + `gif.js`→`gifuct-js.js`→state→import→timeline→playback→export→`gif-editor.js` 脚本顺序）、`web/static/{app.js,i18n.js,style.css}`（switch `case 'gif'`+cleanup、`gif`/`gifEditor*`/`gifImport*`/`gifTimeline*` 键、`gif-*` 样式含 `.gif-timeline-item` 全套与 `.gif-result-overlay.active`）、`internal/feature/feature.go`（GIF feature `StaticFiles` 清单：6 模块 + 3 vendor 文件，`DependsOn: archive`）、`web/playground/static-pg/gallery/gallery-state.js`（`SUPPORTED_VIDEO_EXTS` 增 gif/webp + `ANIMATED_IMG_EXTS`/`isAnimatedImg`）、`gallery-layout.js`（video pane 增 `<img id="gallery-main-anim">`，`autoBalanceFullscreenSplitRatio` 测活动媒体）、`gallery-video.js`（`renderActiveVideo` 动画分支 + 竞态守卫 + `applyVideoPaneMode`/`replayAnim`/`stopAnim`）、`gallery-fullscreen.js`（动画短路 seek/音量、Space=重播）、`gallery-tree.js`（anim src 清理）、`internal/api/gallery/fs_handlers.go`（`galleryVidExts` 增 `.gif`/`.webp`）、`internal/gallery/gallery.go`（`SupportedExts` 增 gif）、`internal/gallery/zip.go`（`contentTypeForExt` `.gif`→`image/gif`）、`internal/api/router.go`（`/vendor/*` 主静态回退）、`web/static/media-bridge.js`（导出结果登记/「Open in Gallery」生产者，见 :736）、`docs/playground-architecture.md`。**2026-08-06 重构升级**：模块拆分为六个文件；统一 Import Modal（双手柄起止/比例/FPS/实际帧数与时长统计）；虚拟化时间线（50%–200% 倍率）；底栏播放控制 + 键盘；旧页面 1:1 编辑功能（色键透明/网格切片/全局裁剪/图层/批量删帧/输出缩放质量/拼图参数）已还原并接线；导出三条路径（GIF gif.js worker / ZIP Archive `assets→pack` 主路线 + upload-temp/zip-outputs 回退 / PNG 精灵图）统一经 MediaBridge 登记 + `.active` 结果弹窗；GIF delay 按 ms 直用；`focusFrame` 每 render 重注册；`[data-i18n]` 每 render 应用。**仍开放（勿标完成）**：P4 浏览器全流程冒烟（含 1280×736×63 高帧用例）未跑；低优先级遗留见 `gif_implented.md` §10.2（Firefox 拖拽 setData、delay 上界钳制、末帧停止、放大轨道高度、移动端高度）。验证：`node --check` 六模块、`go build ./...`、`go test ./...` 全量 37 包、`go test ./internal/feature/` 均通过。 |
| 新增/修改 Gallery 媒体编辑 | playground | `internal/mediaedit/`（types/binary/probe/args/executor/manager + 测试）、`internal/api/gallery/edit_handlers.go`（`h.media` + `resolveFfmpeg` + 9 个 edit handler：ffmpeg-status/probe/subtitle-upload/start/status/cancel/**extract-zip-entry/upload-temp/zip-outputs/zip-writeback**）、`internal/api/gallery/zip_handlers.go`（`galleryZipWriteback`）、`internal/api/router.go`（`feature.go StaticFiles manifest` 加 `gallery-edit.js`/`gallery-edit-operations.js`/`gallery-edit-batch.js` 三文件，加载顺序：gallery-edit.js → gallery-edit-operations.js → gallery-edit-batch.js）、`web/static/index.html`（script 标签加载顺序，同上三文件）、`docs/playground-architecture.md`（§4.2 表 + §16 小节）。**输出命名**：`StartRequest.OutputName`（可选，无扩展名 stem）+ `manager.go` OutputDir 非覆盖分支 + `buildArgs` 的 `ext`，避免临时输入名泄漏进保存文件/zip 内条目名；**原地替换（Replace Original File）**：`_getDestination` 读 `ge-dest` radio，Same Path=`overwrite:true`；`manager.go` 覆盖同格式→原文件 temp+rename、覆盖跨格式→`<dir>/<stem><newExt>` + `removeOnSuccess` 删原文件（ffmpe **GIF/WebP 动画输出**：`video_to_gif`/`video_to_webp`/`video_anim_trim` 三 operation（`internal/mediaedit/args.go` `BuildVideoToGifArgs`/`BuildVideoToWebpArgs`/`BuildVideoAnimTrimArgs` + `normalizeAnimParams`/`parseSeconds`/`buildAnimTimeInputOptions`/`buildAnimVideoFilterChain`/`animDithers`）+ `internal/mediaedit/types.go` `VideoAnimParams`/`VideoAnimTrimParams` + `internal/mediaedit/binary.go` `ProbeFfmpegCaps`（`FfmpegCaps`{gif,webpAnim,webpAnimDecode}，按绝对路径缓存 `ffmpegCapsCache`）+ `ffmpeg-status` 6 字段 `{available,path,error,gif,webpAnim,webpAnimDecode}`（`edit_handlers.go` `galleryEditFfmpegStatus`/`checkAnimCapability` 启动前复核） |
| 新增/修改 Embedding 模型支持 | proxy、config-registry-state | proxy/handler.go（Embeddings+handleProxy 传入 EntryFormatOpenAI）、api/router.go（r.Post(/v1/embeddings, proxyHandler.Embeddings)）、config/types.go（ProtocolOpenAIEmbedding 常量 + ModelDef.Kind 支持 "embedding"）、api/probe_common.go（probeOpenAIEmbedding + extractEmbeddingDim + ProbeResult.EmbeddingDim）、api/probe_model.go（testProviderModelProto 支持 openai-embedding + probeResultToMap 输出 embeddingDim）、api/providers_models_crud.go（updateModelKind 校验支持 "embedding"）、web/static/providers.js（testModelProtosSerial 按 kind 过滤协议：kind=text → O/R/A、kind=embedding → E；徽章 title/Info modal 显示 embeddingDim）、web/static/i18n.js（embeddingModel/protoOpenAIEmbedding 翻译键） |
| 修改多协议探测/单协议 Test / Responses 路由 / Provider 详情页 UI 与 Batch Manage（含 Select All / Deselect All 动态切换按钮及 Alias/Note/Quota 弹窗自动 focus 与键盘防穿透） | proxy、rotation | internal/proxy/forward.go+upstream.go+stream.go+handler.go、internal/api/probe_model.go+probe_common.go+probe_keys.go+providers_validate.go、internal/combo/resolver.go、internal/config/types.go+validate.go、internal/api/router.go、internal/registry/models.go+state.go、web/static/providers\.js+settings\.js+style.css+i18n.js+app.js+auth.js |
| 修改 Image 模式端点/协议选择器/GPT 参数 | playground | `web/playground/static-pg/playground/pg-core.js`（图片参数 + `imgComfyPort`/`imgComfyTemplateId`/`imgComfyWorkflow` 默认值），`pg-ui.js`（GPT/xAI/ModelScope/comfyui 协议、ComfyUI 回退按钮、Image 多窗口 pane 选择、Batch 多窗口门控与动态控件），`pg-request.js`（OpenAI 图片 body），`pg-stream.js`（现有 OpenAI 图片发送），`pg-comfyui.js`（ComfyUI `/system_stats`/`models`/`object_info`/`prompt`/`history`/`view` 调用与历史轮询；每窗口 runtime；Tab Select 按规范化名称去重），`pg-state.js`（Tab 候选运行态结构），`pg-i18n.js`（Tab Select/Current Tab/回退文案）、`playground.css`、`web/static/index.html`、`internal/api/comfyui/register.go`/`active_windows.go`/`register_test.go`/`active_windows_test.go`。`pg-image-batch.js` 导出并实现 refresh/pause/resume/stop/retry 控制；retry 调用 `/image-batches/{projectID}/retry/{promptID}/{variantID}`；多窗口 Image 时禁用 Batch Project。`
| 新增/修改 Gallery 图片查看器 / AI Review 审核 | playground | `web/playground/static-pg/gallery/gallery.js`+`gallery-tree.js`+`gallery-review.js`+`gallery-fullscreen.js`+`gallery-state.js`+`gallery-io.js`、`internal/api/gallery/register.go`（`runReview` 120ms Stagger 错开步长 + `sendVisionRequest` 45s 超时 Context + 2 次静默重试退避 + `galleryCancelReview` 3s 超时防死锁 + `galleryListDir` 400 校验）、`internal/gallery/{zip,tiff}.go`、`internal/api/router.go`、`web/static/{index.html,app.js,style.css,i18n.js}`。**多节点选择**：Header 三态模式（`SelectAll/DeSelect|Start|Cancel`）+ 节点 Shift 范围连选 + `buildReviewQueue` 顺序队列引擎；**双轴方向键导航与防冲刷**：左右方向键（`goReviewPrev`/`goReviewNext`）在已审核节点匹配项间流转，上下方向键（`goReviewPrevNode`/`goReviewNextNode`）跳转节点；`updateCurrentFolderItems` 增加 `reviewState.active` 护航防冲刷；**全宽视图按钮**：Cancel/Reset 下方 `100%` 全宽切换按钮（`Show All` / `Show Matched`），反向提示目标状态；**双端剪贴板**：`onPaste` 优先调用 `POST /api/gallery/paste-paths`，实现 Chrome 与 WebView2 独立窗口下文件/文件夹 Ctrl+V 瞬间加载。 |
| 新增/修改 Gallery 媒体编辑 | playground | `internal/mediaedit/`（types/binary/probe/args/executor/manager + 测试）、`internal/api/gallery/register.go`（`mediaJobs` + `resolveFfmpeg` + 9 个 edit handler：ffmpeg-status/probe/subtitle-upload/start/status/cancel/**extract-zip-entry/upload-temp/zip-outputs/zip-writeback**）、`internal/api/router.go`（`feature.go StaticFiles manifest` 加 `gallery-edit.js`）、`web/static/index.html`（script 标签加载顺序）、`docs/playground-architecture.md`（§4.2 表 + §16 小节）。**输出命名**：`StartRequest.OutputName`（可选，无扩展名 stem）+ `manager.go` OutputDir 非覆盖分支 + `buildArgs` 的 `ext`，避免临时输入名泄漏进保存文件/zip 内条目名；**原地替换（Replace Original File）**：`_getDestination` 读 `ge-dest` radio，Same Path=`overwrite:true`；`manager.go` 覆盖同格式→原文件 temp+rename、覆盖跨格式→`<dir>/<stem><newExt>` + `removeOnSuccess` 删原文件（ffmpeg 按输出扩展名选编码器）；`_startJob`/`_startBatch` 均前置 `canReplace` 守卫（拒绝 fs/plain/FSAA-drop-zip）；Same Path 与 sequential rename 互斥（`_refreshBatchUXVisibility` renorm 行 `!samePath` gate，dest radio onchange 联动刷新）；**压缩包名**：`galleryEditZipOutputs` 的 `zipName`（`filepath.Base` + `.zip` 强制）；**批量转换兄弟匹配**：`gallery-edit.js` `_getSiblingImages` 按 kind 分组（`plain` 返回 `[]`）+ `_resolveBatchInput` 逐条解析临时磁盘路径；**批量 UX 选项**：rename/normalise 开关 → `_padNum`（自动扩位）+ `_captureBatchCfg`/`_refreshBatchUXVisibility`；**视频 rename 对等**：共享 dest block 新增 `ge-dest-rename` 输入框（仅"另存到目录"显示），`_startJob` 读其值覆盖 `origStem` 作为 `OutputName`；**视频缩放滑块**：`ge-vid-scale` 改 `<input type="range">` + 实时 WxH 预览；**trim 跨片段约束**：`_startTrimDrag.onMove`/`_moveNearestHandle` 新增 prevEnd/nextStart 约束防组间重叠；**replace-original 守卫 + zip 原位回写**：`!canReplace` 拒绝 + `/edit/zip-writeback`（`zip_replace.go` `ReplaceZipEntries` + `fsutil.AtomicWrite`）；**打开目录**：`POST /api/gallery/open-folder` 复用 `fsutil.OpenInFileManager`，完成结果区仅保留 Open Folder（移除 Show in Gallery）；**批量非压缩完成区 Open Folder**：捕获 `outputPaths[0]` 避免 `_batchJobs=[]` 后闭包空转；**i18n**：`pg-i18n.js` `geBatchProgress`/`geBatchDone` `%s`→`{0}/{1}` + `geRename*`/`geRenorm*`/`geBatchOpenFolder`/`geBatchOpenError`/`geNoDiskPath`/`geBatchDoneAll`/`geBatchFiles`/`geExtracting` + `geReplaceOriginal` en "Replace Original File"/zh "原地替换原文件" **GIF/WebP 动画输出**：`video_to_gif`/`video_to_webp`/`video_anim_trim`（`mediaedit/args.go` `BuildVideoToGifArgs`/`BuildVideoToWebpArgs`/`BuildVideoAnimTrimArgs`）+ `ProbeFfmpegCaps` 能力探测（`mediaedit/binary.go`，按路径缓存）+ `ffmpeg-status` 6 字段（`galleryEditFfmpegStatus`/`checkAnimCapability`） |
| 新增/修改 Search 模式 | playground、config-registry-state | `web/playground/static-pg/playground/pg-search.js`+`pg-ui.js`+`pg-render.js`+`pg-state.js`+`pg-i18n.js`、`internal/anysearch/client.go`、`internal/api/anysearch/register.go`+`settings.go`+`router.go`、`internal/config/types.go`（`AnySearchConfig`）+`defaults.go` |
| 新增/修改 Search 模式 | playground、config-registry-state | `web/playground/static-pg/playground/pg-search.js`+`pg-ui.js`+`pg-render.js`+`pg-state.js`+`pg-i18n.js`, `internal/anysearch/client.go`, `internal/api/anysearch/register.go`+settings.go+router.go, `internal/config/types.go` (AnySearchConfig)+defaults.go |
| 修改 Image 模式端点/协议选择器/GPT 参数 | playground | `web/playground/static-pg/playground/pg-core.js`（新增 `imgEndpoint`/`imgProtocolFilter`/`imgResponseFormat`/`imgOutputFormat`/`imgOutputCompression`/`imgUser` 默认值），`web/playground/static-pg/playground/pg-ui.js`（`pgEffectiveProtocol` 辅助、协议+模型双原生 select、endpoint generations/edits 切换、参数区可见性、GPT 质量 Auto/Low/Medium/High、n 1..5、response_format、output_format、output_compression、user 控件），`web/playground/static-pg/playground/pg-request.js`（`pgBuildImageBody` 构建 GPT 字段 + 保留 JSON image_url data URL 机制），`web/playground/static-pg/playground/pg-stream.js`（`pgSendImage` 动态 endpoint），`web/playground/static-pg/playground/pg-i18n.js`（新翻译键），`web/playground/static-pg/playground/pg-modal.js`（`pgOpenModelPicker` 支持 protocolFilter） |
| 修改 Playground 模式选择器样式 | playground、PROJECT_MAP §18.3、DESIGN.md | `web/playground/static-pg/playground/pg-ui.js`（`pgState.mode`/`pgSetMode()` 业务状态不变，为 `.pg-mode-btn` 追加 `data-mode` 属性）、`web/playground/static-pg/playground.css`（`.pg-mode-toggle` 与 `.pg-winbar-header` 统一与 `div.pg-pane-head` 精准 38px 等高、active 专属色彩与亮色重置）、`web/static/style.css`（`--pg-mode-*` 动态 `color-mix` dark/light Tokens、4 模式专属颜色分配）、`docs/playground-architecture.md` |
| 修改 Search 状态持久化 | playground | `web/playground/static-pg/playground/pg-state.js`（`pgLoadSearchHistory()`/`pgSaveSearchHistory()`/`pgSearchEntryToJSON()`、`PG_SEARCH_HISTORY_KEY`/`PG_SEARCH_ACTIVE_KEY`/`PG_SEARCH_MAX_ENTRIES`、`pgLoad()` search 分支）、`web/playground/static-pg/playground/pg-lifecycle.js`（`cleanupPlayground()` search early return、`renderPlayground()` 恢复后渲染）、`web/playground/static-pg/playground/pg-search.js`（`pgSearchSend()` 即时保存、DOM 存在检查） |
| 新增/修改主题变体与 Appearance Modal 键盘/布局自适应 | config-registry-state、PROJECT_MAP §18.2 | `web/static/theme.js`（ThemeSystem registry 扩展 9 暗 + 9 亮 Variant + 4 风格预设 Style Dimension，支持弹窗 3×3 Grid 卡片式 Theme Picker 渲染与双 Mode 对勾标记 + Style Picker 独立维度选择，data-group 属性与重新渲染焦点保持）、`web/static/style.css`（18 种 CSS 变量覆盖层 + 弹窗横版左右双栏与小屏响应式自适应 + `.theme-card` 键盘 Focus 高亮框）、`web/static/app.js`（`handleThemeModalKeyDown` 全局处理 Tab 轮询: dark→night→style→button、方向键组内移动、Space选择、Enter确认退出、Esc/右键退出）、`internal/config/types.go`、`internal/config/defaults.go`、`internal/api/settings/register.go`、`web/static/settings/settings_modal.js`（外观 Modal 打开与初始焦点聚焦）、`web/static/i18n.js` |
> **2026-08-04 主题/样式维护基线：** Settings PATCH 通过 `internal/api/settings/register.go::applyThemeUpdates` 持久化 `DarkVariant`/`LightVariant`/`Style`；`style.css` 的语义 Token 层覆盖核心状态/表面/代码/全屏与认证区域；动态状态由模块 class 驱动，新增模块遵循 `DESIGN.md` 的命名空间与 preview-overrides 验证契约。
| 修改 tooltip 样式/行为 | PROJECT_MAP §18.2 | `web/static/app.js`（`disableGlobalAutofill` IIFE：全局劫持/ MutationObserver / focusin 自动对全站静态与动态 `<input>` / `<form>` 注入 `autocomplete="off"` / `autocorrect="off"` / `autocapitalize="off"` / `spellcheck="false"`，彻底禁用浏览器“保存的信息”弹窗妨碍操作；TooltipSystem 模块：委托 hover+focusin 监听 + 单共享 `.tip` 节点 + `showFor`（`remove('visible')` → `position` → 双重 `requestAnimationFrame` 保证 GPU 合成器帧捕获 → `add('visible')`）/`hide`/`scheduleShow`/`position` 定位与上下/左右翻转 + `data-placement` 上下判定 + `--arrow-offset` 偏移 + `SHOW_DELAY` 600ms 延迟）、`web/static/style.css`（移除全局 `@media (prefers-reduced-motion)` 的强制 0.01ms 动画禁用规则，恢复 Header 主题切换、齿轮旋转、Tooltip 及全站动画；`.download-toolbar` 追加 `overflow: visible !important` 与 `.custom-select-wrapper.open` `z-index: 1000` 解决下拉菜单被横向滚动条容器裁剪与点击打不开异常；`.tip` 类独立 `scale: 0` + `visibility: hidden` 退场，`.tip.visible` 入场 `scale: 1` + `animation: tipShake 0.5s` `rotate` 独立轨道晃动，全程 `cubic-bezier(0.23, 1, 0.32, 1)` 0.4s 过渡；8px 气泡圆角 + 居中自适应小三角 `::before` 伪元素；完整消费 `--modal-bg`/`--glass-blur`/`--glass-border`/`--z-tooltip` 主题令牌）；icon-only 按钮需同步维护 `aria-label` |
| 新增/修改文本审核节点池/会话（独立 Utility Review） | playground、config-registry-state | `internal/textreview/`（engine：`session.go`+`scheduler.go`+`cleaner.go`+`proxy_call.go`+`streaming_writer.go`+`events.go`；test：`dequeue_batch_test.go`+`batch_splitter_test.go`+`batch_run_test.go`）、`internal/api/textreview/`（handler：`register.go`+`sessions.go`+`nodepersister.go`）、`internal/registry/text_review.go`、`web/static/utility/editor/review.js` + `editor_textreview_*`（独立 Utility Review，不是 Editor tab） |
| 修改文本审核批处理/节点参数 | proxy、playground | `internal/config/types.go`（`TextReviewNode.IntervalSec/BatchChars`）、`internal/config/defaults.go`、`internal/textreview/scheduler.go`、`internal/textreview/session.go`、`web/static/utility/editor/editor_textreview_step3.js`（独立 Review wizard 配置） |

| 新增/修改路径设置弹窗/浏览初始目录 | download、config-registry-state、fsutil | `web/static/download.js`（`openPathSettingsModal` 共享弹窗 + `Image Dir`/`Log Dir` 默认路径 Placeholder 提示 + `fasBrowsePicker` 初始目录 + `browsePickerOpen` 锁 + `trapHandler` 键盘陷阱）、`web/static/settings/settings.js`（Settings 侧栏 Path 行）+`settings_modal.js`（`openPathModal`）、`web/static/i18n.js`（`pathSettings`/`imageDir`/`logDir`/`useProxyHint` 键）、`web/static/index-nopg.html`（补加载 `download.js`）、`web/playground/static-pg/gallery/gallery-edit.js`（齿轮按钮改调 `openPathSettingsModal`）、`web/playground/static-pg/playground/pg-stream.js`（`pgAutoSaveImageArtifact` 自动回置 `savedPath`/`savedFilename` 并刷新 `pgRefreshImageModalMeta`）、`web/playground/static-pg/playground/pg-modal.js`（`pgCopyImage` 经 `<canvas>` 转绘 PNG Blob 导出 `image/png` ClipboardItem + 跨域代理降级 `fallbackViaProxy`、`pgShowImageModal` Footer 支持展示 `📁 savedPath`）、`web/playground/static-pg/playground/pg-render.js`（`pgShowImageModal` 调用透传 `savedPath`/`savedFilename`）、`internal/api/settings/register.go`（getSettings + `configDir` + `trace.logDir` + `imageSaveDir`）、`internal/api/download/register.go`（`browseSystemPath` + `initialPath` + `resolveBrowseInitialDir` `MkdirAll` 自动创建目录）、`internal/api/image/register.go`（`saveImage`/`imageProxy` 防御 `TestClient` nil 指针改用 `h.httpClient()` + 15s 超时 Context + `User-Agent`）、`internal/api/trace/register.go`（`getDates` 空目录优雅返回）、`internal/fsutil/open_windows.go`（`OpenFilePickerAt`/`OpenDirectoryPickerAt`）、`internal/fsutil/open_other.go`（macOS `osascript` `default location` stubs）、`internal/config/types.go`（`TraceConfig.LogDir`、`DownloadConfig.UseProxy`）、`internal/config/paths.go`（`ResolveDownloadProxy`/`ResolveTraceDir`/`ResolveImageSaveDir`）、`internal/config/persistence.go`（`decodeConfig` 自动迁移 `deprecatedFieldPaths`） |
| Provider 自定义请求头 | config-registry-state、proxy | `config/types.go`（`Provider.UseCustomHeaders`/`CustomHeaders`）+ `registry/providers.go`（UpdateProvider）+ `internal/customheaders/customheaders.go`（统一应用）+ `proxy/upstream.go`（正常转发/GET 任务轮询，Cline 硬编码头保持最后覆盖）+ `api/providers/register.go`（管理探测/模型拉取）+ `api/probe/register.go`（多协议/多 Key 探测）+ `api/combos/register.go`（测速）+ `web/static/providers.js`/`i18n.js`（Provider Detail Edit UI）`
| 调整 Settings 侧边栏布局与 Toggle 开关样式 | config-registry-state | `web/static/settings/settings.js`（移除操作按钮，点击标题文本打开 modal，Shortcut 置顶，toggle 开关行底层排列）、`web/static/style.css`（`.toggle-switch` 统一 3D 翻转点样式与主题 gradient 背景，修复 `.dl-settings-row > label:not(.toggle-switch)` 避免 Download 模态框拉长，`.settings-panel-left` 移除顶部 padding、`.settings-row` 保持上下 12px padding、`.settings-row-title` cursor:pointer 与 hover primary 色、`.settings-row-toggle`/`.settings-row-endpoint` 右对齐） |
| 整改 Settings 侧边栏弹窗控件与 Theme Stepper 数字输入框 | config-registry-state | `web/static/settings/settings_modal.js`（`changeStepper` + `renderStepperHtml` + `renderCustomSelectHtml` 控件生成器，`openPortModal`/`openProxyModal`/`openRotationModal`/`openServerTimeoutModal`/`openPasswordModal` 全量使用 class `input` 统一面板文本框、`custom-select-wrapper` 带动画展开与 hover 滑块的 Theme 下拉菜单及 Stepper 数字输入框）、`web/static/settings/settings_trace.js`（`openTraceModal` 引入 Stepper + `settings-form-grid` 双列布局）、`web/static/style.css`（`.number-stepper` 36px 居中数字 `[-] [ N ] [+]` 控件与 `:focus-within` 轮廓光圈，`.input` 与全部 `.modal`/`.dl-settings-modal` 文本框全量应用圆角/阴影/主题 Tokens，`.custom-select-wrapper` 表单重置）、`docs/config-registry-state-architecture.md` |
| 修改/新增 Editor 功能 | `editor-state.js`、`editor_workspace.js`、`editor_commands.js`、`editor_markdown.js`、`editor_layout.js`、`editor.js`、`editor_shell.js`、`editor-logs.js`、`web/static/style.css`（Editor shell/workspace 样式）、`web/static/vendor/utility-editor/*`、`web/static/app.js`（Utility `suspendEditor`/`resumeEditor` 生命周期与 cleanup）、`web/static/auth.js`（Utility menu）、`web/static/i18n.js`、`web/static/index.html`/`index-nopg.html`、`internal/api/editor`（保持 `/api/editor/open|save`）`
| 规范化 Provider/Combo/QuickSlot 弹窗与 Form 控件 | config-registry-state | `web/static/providers.js`+`combos.js`+`quickslots.js`（Edit Provider/New Provider/QuickSlot 弹窗与 Model 列表行全量引入 Download 页面同款 `renderCustomSelectHtml` 0.48s 动画下拉菜单，所有 Sticky Limit/Order/Priority 等数字输入框全量换为 Settings 左侧弹窗同款 `renderStepperHtml` `[-] [ N ] [+]` Stepper 控件，重构 `Edit Provider` 表单采用 `form-row-grid` 与 `form-group-inline` 弹性布局，消除了元素贴连杂乱）、`web/static/app.js`（全站挂载 `renderCustomSelectHtml`/`toggleCustomSelect`/`selectCustomOption` 及 `renderStepperHtml`/`changeStepper` 全局组件交互句柄）、`web/static/style.css`（全局 `.form-group input` / `.detail-block input` 显式排除 `checkbox`/`radio` 避免覆盖 Toggle 开关 slider 尺寸，修复 `.model-row .custom-select-wrapper` 避免在 Flex 行中过度撑宽拉伸溢出边框，设置 `.provider-keys-section-title` 为 `display:flex` 使 `+ Add Key` 与 `Bulk Add` 按钮和 `► Keys (N)` 标题并排同行显示，补充 `.form-row-grid`、`.form-group-inline` 与 `.form-footer-actions` 间距样式） |
| 按钮主题系统全量解耦与颜色控制整改 | config-registry-state | `web/static/style.css`（在 `:root` 与 `[data-theme="light"]` 中建立统一的主题按钮设计 Token，如 `--btn-primary-*`、`--btn-secondary-*`、`--btn-danger-*`、`--btn-ghost-*`、`--btn-accent-*`；全量消除散落在 `.btn-primary` 和 `.gif-btn-*` 中的硬编码紫色渐变/硬编码颜色；把全站页面/弹窗（Providers, Combos, QuickSlots, Download, FileTransfer, GIF Frame Editor, Monitor, Settings Modal）中的按钮统一步调接入共用按钮样式与 Theme 颜色控制） |
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
