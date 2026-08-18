# 小精灵研究收口与实施入口

> 收口结论：当前研究任务**可视为收口**，可据此通过文档进入实际实施。本文件是四份研究文档的导航与实施 kickoff。

## 1. 收口结论：可进入实施

- **底部架构已建成并验证**（非仅研究）：契约系统（`internal/assistant/`）+ 裁决 bench（`cmd/assistant-bench/`）已落地，`assistant_readiness=100%`、drift 实证（脱节→95.65%、恢复→100%）、单元测试通过、`go build ./...` 全绿。
- **交互层/执行层已研究、grounded**：三级交互（L1/L2/L3）与五项执行（R1-R5）均落地到真实代码，残留未知已核验可解（见 §4）。
- **架构自洽**：契约 `semantics.json` 是唯一真相源；`/api/assistant/dispatch`（分派）+ `/api/assistant/events`（通知 SSE）为交互层与执行层共用通道；rotation failover/combo greedy-squirrel 已提供会话内自动切换（R5 不造新轮）。
- **autoresearch 循环指标已饱和**：no-network bench 测的是静态分派大脑+契约健康度，已诚实触顶 100%；交互层/执行层是事件/时间驱动，不入现段指标——**实施走产品工程路径（烟测+集成测试），不再走指标迭代**。

## 2. 四份文档导航

| 文档 | 层 | 状态 |
|---|---|---|
| [`assistant_contract_research.md`](assistant_contract_research.md) | 底部架构（契约系统：懂什么/怎么路由） | **已建成+验证** |
| [`assistant_implementation_plan.md`](assistant_implementation_plan.md) | 实施计划（任务 A-E：端点/物化/gap/前端/LLM 分类器） | 可实施 |
| [`assistant_interaction_research.md`](assistant_interaction_research.md) | 交互层 L1/L2/L3（dock→形象→桌面宠物） | 已研究 |
| [`assistant_execution_layer_research.md`](assistant_execution_layer_research.md) | 执行层 R1-R5（主动提醒+有界自主） | 已研究 |
| 本文件 | 收口与实施 kickoff | — |

四层互补：契约系统=懂、实施计划=接、交互层=呈现、执行层=主动。

## 3. 已建成 vs 已研究

| 项 | 状态 |
|---|---|
| `internal/assistant/`（契约大脑：`LoadContract`/`BuildAssistant`/`Assistant`/`Scheduler`） | ✅ 建成、bench 100% |
| `internal/assistant/semantics.json`（24 rules/22 tools/2 jobs） | ✅ 建成 |
| `cmd/assistant-bench/` + `autoresearch.sh`（裁决 judge，off-limits） | ✅ 建成 |
| 任务 A：真实 `/api/assistant` 端点（dispatch + events SSE） | ⏳ 计划，未建（**实施入口**） |
| 任务 B：Scheduler 物化（goroutine 复用 `SweepTraces`） | ⏳ 计划 |
| 任务 C：gap 检测（bench 增强，需新段） | ⏳ 计划 |
| 交互层 L1/L2/L3 | ⏳ 已研究 |
| 执行层 reactor + `reactions.json` + R1-R5 | ⏳ 已研究 |
| 任务 E：LLM tool-calling 分类器 | ⏳ 计划（产品层，依赖真实 provider/key） |

## 4. 残留未知（已核验可解）

| 未知 | 核验结果 | 实施动作 |
|---|---|---|
| R4 模型可用性查询是否存在 | `Selector.isKeyAvailable(state, model)`（私有）+ `SonestCooldown`/`MarkUnavailable` **已存在** | 加薄 public `IsModelAvailable(providerID, model) bool`（遍历 key 复用 `isKeyAvailable`），非新逻辑 |
| L3 WebView2 透明背景是否支持 | `PutDefaultBackgroundColor` + `COREWEBVIEW2_COLOR` **已在 `go-webview2` dep 暴露**（`ICoreWebView2Controller2.go`） | host 取 controller 调 `PutDefaultBackgroundColor(transparent)`；host 已有 HWND+Win32 无边框先例 |
| L3 异形抗锯齿 | `SetWindowRgn` 无半透明边 | MVP 圆角矩形；后续 layered per-pixel alpha 优化 |
| 任务 A dispatch 执行方式 | 内部子请求（走完整中间件/owner-grant/配额记账）vs 直调 handler | 选内部子请求（推荐） |
| LLM 分类器（E）泛化 | bench 无网络不能测 | 产品层，真实 provider 验证 |

## 5. 实施入口与顺序

依赖链驱动顺序（每步 `go build` + `go test` + `node --check` + 烟测 + `bash autoresearch.sh` 保 100%/0 drift + doc-sync）：

1. **任务 A**（`/api/assistant/dispatch` + `/api/assistant/events` SSE）——核心，交互层与执行层都依赖它。先 catalog→schema 暴露 + intent→dispatch，再 SSE 流式。
2. **任务 B**（Scheduler 物化）= R1 基础，可并行。
3. **交互层 L1**（dock+modal，纯前端，立即可用客服式）→ 接 A 的端点 + events SSE。
4. **reactor 骨架** + `reactions.json` 契约 + `/api/assistant/events` 通知（R3/R4/R5 共用）。
5. **R3**（订阅 `RequestUpdates` + 后台任务状态 → notify）——事件流已就绪，最快见效。
6. **R4**（加 `IsModelAvailable` 聚合 + 阈值）→ **R5**（显式化既有切换 + 配置层 suggest）。
7. **R2**（todo store + 提醒 job）。
8. **交互层 L2**（spritesheet 形象+移动+气泡）→ **L3**（桌面宠物，最高复杂度，Windows 原生）。
9. **任务 E**（LLM 分类器）——产品泛化层，最后；**任务 C**（gap 检测）——bench 增强，需 `init_experiment new_segment:true`，随时可做。

## 6. 验证与不变量纪律

- **每步**：`go build ./...` + `go test ./...` + `node --check <改动的 js>` + 浏览器/tray 烟测（`tinyrouter-frontend-smoke-test` skill）+ `bash autoresearch.sh`（确认 bench 仍 100%/0 drift，契约未被破坏）。
- **doc-sync**（`AGENTS.md` 强制）：改 `web/static` 同步 `PROJECT_MAP.md` §18.2/§24 + 相关 `docs/*-architecture.md`；改 host/build variant 同步 `docs/build-variants.md`；改 rotation/事件 同步 `docs/rotation-architecture.md`/`proxy-architecture.md`。
- **不变量**：`cmd/assistant-bench`/`autoresearch.sh` off-limits；`catalog.go` 零手维护（新能力只改 `semantics.json`）；不引 DB/前端框架/对外鉴权；有界自主（notify/只读 auto，配置变更默认 suggest、auto 需授权且仅 reversible）；L3 限 Windows。
- **新增能力**：加 `semantics.json` rule → bench 校验 `(method,path)`∈真实 chi 路由集（drift 强制同步）。

## 7. autoresearch 循环终态

- seg1（18 意图）69.44→100；seg2（30 意图拓宽）66.67→100；seg3（契约驱动+drift）66.67→100，drift 实证。
- 指标 `assistant_readiness = dispatch_f1 × contract_health` 已诚实触顶；产品实施（交互/执行层）不通过指标迭代验证，改用烟测+集成测试。
- 前向（可选新段）：反应就绪度 `reaction_f1`（bench 注入合成事件断言 reactor 通知/行动）+ gap 检测——列为后续，非实施前置依赖。
