# CLAUDE.md

> Claude Code 项目指令文件。Claude Code 在此项目中工作时会自动读取此文件。

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
| 修改下载参数/任务 | download | `download/args.go`+`executor.go`+`manager.go` |

> 模块文件清单与 build tag 矩阵详见 PROJECT_MAP.md §1–§21；涉及结构变更时须同步更新该文件。

> **文档同步指令（强制）：** 每一轮代码变更完成后，**必须**在同一次改动中更新受影响文档：(1) 改动触及 `PROJECT_MAP.md` §1–§24 列举的文件/包时，更新对应条目；(2) 改动触及某 `docs/*-architecture.md` 覆盖的模块时，更新该文档的“最后核对”行、相关章节与“变更维护清单”涉及的锚点。**代码与文档不得脱节。**

> 完整项目指令（项目概述、技术栈、构建变体、工作流约定、关键设计决策、编码规范与约束清单）见 [`AGENTS.md`](AGENTS.md)。
