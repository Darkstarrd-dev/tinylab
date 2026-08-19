# 小精灵助手契约系统研究

> 研究报告：TinyRouter 能否用一套"契约系统"承载小精灵助手（而非硬编码当前项目现状），使项目增删改功能时小精灵自动保持可用。
>
> 关联文件：`internal/assistant/`（契约大脑）、`cmd/assistant-bench/`（裁决 bench）、`autoresearch.sh`（入口）。实施计划见 [`docs/assistant_implementation_plan.md`](docs/assistant_implementation_plan.md)。

## 1. 研究问题

TinyRouter 本身带模型路由功能（`/v1/*` 代理 + Key 轮询 + Combo 解析）和一大片本地能力 REST 面（`/api/*`：图片生成/编辑、文档编辑保存、下载、网页搜索、归档、文本审、trace 清理、provider/监控/配额/文件上传/gallery/probe…）。研究问题：

1. 能否在这套架构上实现一个"小精灵"式 AI 助手——按用户自然语言意图，路由到项目**自身已实现**的能力来完成请求（生成图片后写文档保存、定时清理日志等），并能在前端跳页或直接调用？
2. 能否用一套**规范与系统**（契约）承载它，使得项目内容变更（增删改功能）后，开发者只需同步更新契约，小精灵就能继续理解并使用——而非靠硬编码当前现状、一改就脱节？

## 2. 研究对象：现有架构

| 组成 | 位置 | 与助手的关系 |
|---|---|---|
| 模型路由层 | `internal/proxy`（`Handler.ChatCompletions/ImagesGenerations/ImagesEdits/Embeddings/TaskGet` 等）+ `internal/rotation`（Key 轮询/冷却）+ `internal/combo`（模型组合解析） | 模型相关意图（生成图片、聊天、向量）的执行后端；`/v1/chat/completions` 已**透明透传 `tool_calls`** |
| 能力 REST 面 | `internal/api/router.go::Routes`（`chi.Walk` 得 179 条真实路由） | 助手可调用的能力清单（grounded 真相） |
| 定时维护 | `internal/proxy/request_log.go::SweepTraces(ctx, retainDays, maxDiskMB)`（每小时 sweep）+ `archive.TempStore.scavengeLoop` | 维护类意图（清 trace）的物化原型 |
| SSE | `internal/sse` + `proxy/stream.go` | 助手流式回传进度的基础设施 |
| 配置/状态 | `internal/config` + `internal/registry` + `internal/state` | 契约与运行态持久化基础 |

## 3. 契约系统设计（核心成果）

**原则**：助手的能力知识 SOLELY 来自一份契约（source of truth），不硬编码任何 Go 工具表/规则表。bench 用真实路由集合与契约交叉校验，自动检测脱节。

### 3.1 契约 = `internal/assistant/semantics.json`

```jsonc
{
  "rules": [
    // 一条 rule = (tool, 真实路由, 意图关键词组)
    {"tool":"image.generate","method":"POST","path":"/v1/images/generations",
     "needsModel":true,
     "keywords":["生成","画","绘图","出图","文生图","做"],  // OR：命中任一
     "all":["图"],                                            // AND：全部出现
     "none":["批量","向量","embedding","vector","编辑","修"], // NOT：均不出现
     "desc":"生成图片"},
    // 同一 tool 可有多条 rule（如中文+英文、不同名词）——实现 OR 名词
    {"tool":"image.generate","method":"POST","path":"/v1/images/generations",
     "needsModel":true,"keywords":["generate","draw","create"],
     "all":["image"],"none":["batch","vector","embedding","edit","modify"],"desc":"generate image (EN)"}
    // …22 distinct tools / 24 rules
  ],
  "jobs":[{"name":"clean-traces","intervalSec":3600},
          {"name":"clean-traces-daily","intervalSec":86400}]
}
```

- `keywords`=OR、`all`=AND、`none`=NOT——三段式语义消歧（如"生成"+"图"→生图，除非出现"批量/向量/编辑"改路到 batch/embeddings/edit）。
- 多 rule 共享同一 tool：实现"OR 名词"（`image` 与 `picture` 各一条 rule，因 `all` 是 AND）。
- `jobs`：定时任务声明（复用项目既有 `SweepTraces` 语义）。

### 3.2 助手大脑 = `internal/assistant`（零手维护）

`catalog.go` 删除了所有手写工具表/规则表，仅保留两个函数：

- `LoadContract() (*Contract, error)`——`//go:embed semantics.json` 解析契约。
- `(c *Contract) BuildAssistant(routeSet map[string]bool, hasModelRoute bool) (*Assistant, []string)`——**契约规则只在 `(method,path) ∈ routeSet` 时注册工具并加分类规则**；引用不存在路由的规则被收集为 `drift`（返回的第二返回值）。

`Assistant`（`assistant.go`）提供：`Classify(intent) []string`（关键词分类，去重）、`Resolve(name) (ToolSpec,bool)`、`Scheduler() *Scheduler`（`Has(job)`）、`HasModelRoute() bool`、`Registry() *ToolRegistry`。`ToolSpec.MethodPath()` 产出规范键 `"POST /v1/images/generations"` 用于与 chi.Walk 路由集匹配。`NormalizePath` 折叠尾斜杠（`/api/image-batches/` ≡ `/api/image-batches`）。

### 3.3 裁决 bench = `cmd/assistant-bench`（off-limits judge）

确定性、无网络、无时间依赖：
1. 进程内构造真实 `*api.Router`（`PasswordEnabled=false` 开放管理路由，复用 `setupTestServer` 模式），`chi.Walk` 收集 179 条真实路由 → `routeSet`。
2. `LoadContract()` + `BuildAssistant(routeSet, true)` → 助手 + drift 列表。
3. 跑 30 个固定意图：对每个 `assistant.Classify→Resolve→校验路由存在→F1`（precision×recall 调和均值）。模型相关意图 gate `HasModelRoute`；维护类意图 gate `Scheduler.Has(job)`（缺 job ×0.5）；out-of-scope 意图（`required=nil`）仅当分类为空才得 1.0（精度守卫）。
4. 指标：

   **`assistant_readiness = mean(dispatch_f1) × 100 × contract_health`**
   `contract_health = 1 − drift/distinct_tools`

   drift>0 必然拉低 readiness——契约脱节即系统不可靠。

反 gaming：judge 固定且不向助手暴露答案；"返回所有工具"会因 precision 暴跌低分；out-of-scope 守卫防 over-fire。

## 4. drift 实证（live demo）

临时在 `semantics.json` 加一条引用已删路由 `POST /api/this-route-was-removed` 的契约规则（模拟"项目删了功能但契约没更新"），bench 抓到：

| 状态 | dispatch_f1 | contract_drift | contract_health | readiness | 输出 |
|---|---|---|---|---|---|
| 契约脱节 | 100.00% | **1** | 0.9565 | **95.65%** | `# DRIFT: contract references routes the project no longer serves: demo.removed` |
| 移除该规则 | 100.00% | 0 | 1.0000 | 100.00% | 30/30 exact |

即便 30 意图分派满分，系统仍被判不可靠——开发者必须删掉陈旧契约条目才恢复 100%。单元测试 `TestBuildAssistantDetectsDrift`（空路由集→全工具 drift、零注册、零分类）与 `TestBuildAssistantDropsOnlyDriftedTool`（仅移除单条路由只丢对应工具、其余照常）亦证明机制正确。

## 5. 迭代历史（autoresearch）

| 段 | judge | baseline → 优化后 | 关键手段 |
|---|---|---|---|
| 1 | 18 意图 | 69.44% → 100% | AND/none 语义消歧 + `clean-traces-daily` 定时任务 |
| 2 | 30 意图（拓宽压测泛化） | 66.67% → 96.67% → 100% | catalog +6 真实能力 + 双语 CN/EN + 同义词；修复 EN image rule 的 `all:[image,picture]` AND 误用（拆两条 per-noun 规则恢复 OR） |
| 3 | 30 意图（**契约驱动 + drift 检测**） | 66.67% → 100% | 重构为契约系统：`semantics.json` 唯一真相源，`catalog.go` 零手维护，bench `chi.Walk` 交叉校验 + drift 自动检测 |

关键缺陷教训：`AddRuleCond` 的 `all` 是 AND（全部须出现），OR 名词须拆多条规则。

## 6. 研究结论（可行：YES）

TinyRouter 能用一套契约系统承载小精灵：

- **薄分发大脑**的能力知识 SOLELY 来自 `semantics.json` 契约；bench 用 `chi.Walk` 真实路由集合交叉校验；drift（契约引用已删路由）自动检测并拉低 `contract_health`→`readiness`——故**项目增删改功能时，开发者只需更新契约（增能力=加 rule，删能力=删 rule），bench 强制同步，契约不可能静默脱节**。
- 30 意图（单步/多步 CN+EN、定时维护、out-of-scope）100% 精确映射到 22 真实能力；模型意图 gate 路由层、维护意图 gate 定时任务。
- **诚实边界**：关键词分类器在固定 proxy 上达 100%（领域词汇可泛化），但任意开放词表意图超出关键词启发式——泛化路径是项目自身的 `/v1/chat/completions`（已透明透传 `tool_calls`），LLM tool-calling 分类器可**零架构改动**替换关键词大脑（见实施计划任务 E）。

## 7. 文件清单（当前已建成）

| 文件 | 职责 |
|---|---|
| `internal/assistant/assistant.go` | `ToolSpec`/`ToolRegistry`/`Job`/`Scheduler`/`Assistant`（`AddRuleCond`/`Classify`/`Resolve`）+ `NormalizePath` |
| `internal/assistant/catalog.go` | `SemRule`/`SemJob`/`Contract`/`LoadContract`（`//go:embed semantics.json`）/`BuildAssistant(routeSet)`（drift 检测） |
| `internal/assistant/semantics.json` | 契约（24 rules / 22 tools / 2 jobs），唯一真相源 |
| `internal/assistant/assistant_test.go` | 契约加载、路由交叉 wiring、drift 检测的单元测试 |
| `cmd/assistant-bench/main.go` | 裁决 bench：`chi.Walk` 真实路由 + 契约交叉 + F1 + drift 指标 |
| `autoresearch.sh` | `go run ./cmd/assistant-bench` |

`go build ./...` + `go test ./internal/assistant/` 全绿；bench 确定性（同输入同输出）。

## 8. 剩余（bench 外）工作

见 [`docs/assistant_implementation_plan.md`](docs/assistant_implementation_plan.md)：接真实 `/api/assistant` 端点、Scheduler 物化、gap 检测（bench 增强）、前端跳页/直接执行、LLM tool-calling 分类器。
