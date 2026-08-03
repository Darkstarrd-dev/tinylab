# AGENTS.md

> Codex 项目指令文件。Codex 在此项目中工作时会自动读取此文件。

> **开始任何代码任务前，先读 [`PROJECT_MAP.md`](PROJECT_MAP.md) §24（常见变更任务速查表）定位涉及的文档与文件。** 下文清单为本文件内嵌的零跳摘要。

### 架构文档清单（均位于 `docs/`，含源码锚点+变更维护清单）

| 文档 | 覆盖 |
|---|---|
| `proxy-architecture.md` | `/v1/*` 代理核心：调用链、重试/故障转移状态机、SSE 透传、Gemini 签名回填、在途跟踪 |
| `rotation-architecture.md` | Key 轮询：SelectKey 算法、三种策略、两套退避系统、配额锁 CST 00:05、NIM、错误分类 |
| `download-architecture.md` | yt-dlp 下载：任务队列生命周期、参数构造、SSE 进度、与归档计划漂移 |
| `combo-architecture.md` | Combo 解析：Resolve 算法、三种策略目标排序、greedy-squirrel 配额层级 |
| `config-registry-state-architecture.md` | 基础设施：三层归属边界、原子持久化、AES-GCM 加密、双锁模型、reload merge |
| `playground-architecture.md` | Playground 前后端：多模型测试、群聊、Director/Narrator |

### 高频变更速查（完整 19 条见 PROJECT_MAP.md §24）

| 变更任务 | 先读文档 | 涉及源码 |
|---|---|---|
| 修改重试/故障转移 | proxy、rotation | `proxy/retry.go`、`rotation/error_rules.go`+`cooldown.go`、`proxy/forward.go` |
| 新增 Key 轮询策略 | rotation | `rotation/strategy.go`+`selector.go`、`config/types.go` |
| 修改 SSE 流式透传 | proxy | `proxy/stream.go`、`proxy/forward.go` |
| 修改上游 URL/body 改写 | proxy | `proxy/upstream.go`、`proxy/forward.go` |
| 新增/修改 Combo 策略 | combo、proxy | `combo/resolver.go`、`proxy/forward.go`（`handleCombo`） |
| 修改 Gemini 签名回填 | proxy | `proxy/signature_cache.go`+`forward.go`+`stream.go` |
| 新增/修改配置字段 | config-registry-state | `config/types.go`+`defaults.go`+`persistence.go` |
| 新增/修改路径设置弹窗/浏览初始目录 | download、config-registry-state、fsutil | `web/static/download.js`（`openPathSettingsModal` 共享弹窗 + 键盘陷阱 + 浏览锁）+ `internal/api/settings/register.go`（`getSettings` + `configDir` + `trace.logDir` + 指针字段按需合并）+ `internal/fsutil/open_windows.go`（`OpenFilePickerAt`+`SetFolder`） |
| 修改运行时状态持久化 | config-registry-state | `state/manager.go`+`state.go`、`registry/state.go`（`KeySnapshot` 新增 `ExhaustedModelLimits map[string]int`，持久化 `ModelRemaining==0` 的 model→limit 子集） |
| 修改用量统计/配额监控显示 | proxy、config-registry-state | `proxy/recorder.go`+`entry_tracker.go`、`api/monitor/register.go`（`getQuotas` 从 per-key `ModelQuotas` 重算 `TotalUsed`/`TotalCapacity`）、`web/static/monitor_quota.js`（`formatQuotaCell` 显示 `success/capacity`+error badge；`renderQuotaKeyRows` 跳过 exhausted key）、`web/static/style.css`（`.quota-success`/`.quota-error-badge` 类） |

> 模块文件清单与 build tag 矩阵详见 PROJECT_MAP.md §1–§21；涉及结构变更时须同步更新该文件。

> **文档同步指令（强制）：** 每一轮代码变更完成后，**必须**在同一次改动中更新受影响文档：(1) 改动触及 `PROJECT_MAP.md` §1–§24 列举的文件/包时，更新对应条目；(2) 改动触及某 `docs/*-architecture.md` 覆盖的模块时，更新该文档的“最后核对”行、相关章节与“变更维护清单”涉及的锚点。**代码与文档不得脱节。**

## 项目概述

TinyRouter 是一个轻量级 LLM API 代理与本地工具集，单二进制交付，内置 Web 管理界面，纯本地运行无需鉴权。

### 功能模块

| 模块 | 简介 |
|---|---|
| **Proxy** | OpenAI 兼容透传代理，支持多 Provider、多 Key 轮询、重试/故障转移、SSE 流式透传、上游请求改写、Gemini 签名回填 |
| **Rotation** | Key 轮询引擎，三种策略（fill-first / round-robin / failover），指数退避冷却 + 429 日配额锁定，per-model 独立锁，NIM 限速适配 |
| **Combo** | 模型组合解析，三种策略（fallback / round-robin / greedy-squirrel），按配额层级排序尝试 |
| **Download** | 基于 yt-dlp 的视频/音频下载，任务队列、SSE 进度、播放列表、画质选择、代理、缩略图 |
| **Playground** | 多模型同时请求测试 + 多模型群聊对比，Director/Narrator 模式 |
| **Config/Registry/State** | 三层配置基础设施：YAML 持久化 + AES-GCM 加密 + 原子写入 + 双锁模型 + reload merge |

### 参考来源

| 来源 | 用途 | 仓库 |
|---|---|---|
| 9router | 代理核心业务逻辑参考（Key 选择、冷却退避、Combo、日志格式） | https://github.com/decolua/9router |
| VidBee | Download 模块参考（yt-dlp 任务管理与 SSE 进度） | https://github.com/nexmoe/VidBee |

> 本地参考副本位于 `Z:\Playground\9router`，实施过程中作为业务逻辑参考。不要修改该目录。

## 技术栈

- **语言:** Go 1.25+
- **HTTP 路由:** `github.com/go-chi/chi/v5`
- **配置:** `gopkg.in/yaml.v3` → `config.yaml`
- **前端:** 原生 HTML + vanilla JS + CSS (通过 `embed.FS` 内嵌)
- **无数据库、无 ORM、无前端框架**

## 构建与运行

```bash
# 构建
go build -o tinyrouter .

# 运行 (首次自动生成 config.yaml)
./tinyrouter

# 运行测试
go test ./...

# 交叉编译
GOOS=linux GOARCH=amd64 go build -o tinyrouter-linux-amd64 .
GOOS=windows GOARCH=amd64 go build -o tinyrouter-windows-amd64.exe .
GOOS=darwin GOARCH=arm64 go build -o tinyrouter-darwin-arm64 .
```

## 构建变体

TinyRouter 通过 build tag + 链接器 flag 提供 default / tray / webview / debug 四类变体，可组合 `-Playground`（内嵌 Playground 资产）和 `-Strip`（剥离符号表）开关，共 13 个产物。完整矩阵、参数说明与图标资源见 [`docs/build-variants.md`](docs/build-variants.md)。

### Windows 推荐

```powershell
# webview + playground + stripped：托盘常驻 + WebView2 独立窗口 + 最小体积
./build.ps1 -Variant webview -Playground -Strip
# 产出 dist/tinyrouter-webview-pg-stripped.exe (~16 MB)
```

### mac/Linux

```bash
# 直接构建（无 tag = console + 自动打开浏览器）
go build -o tinyrouter .

# 交叉编译
GOOS=linux GOARCH=amd64 go build -o tinyrouter-linux-amd64 .
GOOS=darwin GOARCH=arm64 go build -o tinyrouter-darwin-arm64 .
```

## 代码结构

模块分布与文件归属详见 [`PROJECT_MAP.md`](PROJECT_MAP.md)（入口文档，含全部 `internal/` 包、`web/` 资产、build tag 矩阵、运行时文件、占位区与同步约束）。

## 关键设计决策

### 1. 纯本地，无对外鉴权
HTTP server 仅监听 localhost。任意 API Key 或无 Key 均可访问 `/v1/*`（上游代理不走应用层鉴权）。

允许实现可选的本地密码保护（`Security.PasswordEnabled`，见 commit `b99c245`）：用于防止本地 `config.yaml` 中的明文 API Key 被直接读取，进入管理 UI 需输入密码登录；初始未设置密码时仍可直接打开应用，不强制登录。密码经 AES-256-GCM 加密存储于 `config.yaml`，登录态用内存 session token + HttpOnly cookie，进程退出即失效。

### 2. 配置持久化用 YAML，不用数据库
- `config.yaml` 存储 providers + combos + settings
- `state.yaml` 存储 key/combo 运行时状态（冷却级别、模型锁、轮转索引、exhausted key 配额上限），重启恢复
- `state.yaml` 写入使用 500ms 去抖 + 临时文件 rename 保证原子性
- Usage 和 console logs 仅存内存，重启清零
- 所有文件写入均用临时文件 + rename 保证原子性

### 3. OpenAI 兼容透传
不做任何格式转换。客户端发什么 body，直接转发给上游（仅替换 model 字段）。上游响应原样回传。
例外: 当 provider.injectStreamOptions 为 true 且请求为流式时，自动注入 stream_options.include_usage。

### 4. SSE 流式透传
使用 `http.Flusher` 逐 chunk 转发上游 SSE 响应。不解析、不修改 SSE 内容。

### 5. Key 轮询策略 (移植自 9router `src/sse/services/auth.js`)
- **fill-first:** 按 priority ASC 排序，取第一个可用 key
- **round-robin:** 粘性轮询，连续使用同一 key N 次 (stickyLimit) 后切换到最久未用的 key
- **failover:** 使用当前 key 直到失败（重试耗尽），失败后该 key 排到队尾，切下一个 key；成功则继续用当前 key
- **冷却:** 指数退避 (1s→2s→4s→...→240s max)，429 日配额锁定至次日 CST 00:05，per-model 独立锁

### 6. Combo 策略 (移植自 9router `open-sse/services/combo.js`)
- **fallback:** 按顺序尝试模型，失败则下一个
- **round-robin:** 轮转选择模型
- **greedy-squirrel:** 按配额层级排序(unlimited→limited→paid)，按序 fallback 尝试

### 7. NIM (NVIDIA) 支持
支持 NVIDIA NIM API 的特殊限速机制：
- per-key 请求计数，达到阈值后自动轮转 key
- 最小请求间隔 (min_interval) 控制
- 429 冷却阶梯
- 自动检测：APIType=="nim" 或 BaseURL 含 "nvidia"

## 9router 参考

业务逻辑来源、文件映射与日志格式见 [`docs/9router-reference.md`](docs/9router-reference.md)。本地参考副本位于 `Z:\Playground\9router`，不要修改。

## 编码规范

- Go 标准格式 (`gofmt` / `goimports`)
- 错误处理: 错误必须显式处理，不使用 panic
- 并发: 共享状态用 `sync.RWMutex` 保护
- 日志: 使用 `internal/console.Logger`，不直接用 `log` 标准库（仅在 main.go 启动/关闭阶段 Logger 不可用时允许 `log.Fatalf` 回退）
- 注释: 导出函数需有文档注释
- 测试: 核心逻辑 (rotation, combo, usage) 需有单元测试

## 不要做的事

- 不要引入数据库 (SQLite, BoltDB, 等)
- 不要引入前端框架 (React, Vue, 等)
- 不要实现对外暴露的鉴权 (JWT, OAuth 等面向多用户的认证体系)
- 允许实现本地密码保护：用于防止本地 `config.yaml` 中的明文 API Key 被直接读取，登录应用需输入密码。初始状态未设置密码时仍可直接打开应用（`Security.PasswordEnabled=false` 时跳过登录页，参考 commit `b99c245`）
- 不要实现格式转换 (OpenAI ↔ Anthropic)
- 不要实现 Token Saver (RTK, Headroom, Caveman, Ponytail)
- 不要修改 `Z:\Playground\9router` 目录中的任何文件
