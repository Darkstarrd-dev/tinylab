# 小精灵执行层研究

> 研究：在指令遵守（reactive dispatch）之上，小精灵的**执行层**——主动式/半自主行为：计划任务执行、todo 提醒、后台耗时任务完成提醒、路由模型持续不可用提醒、并有自主性切换为可用模型。
>
> 定位：前三层（契约系统=懂什么；交互层 L1/L2/L3=怎么呈现）已研究。本层=**主动感知 + 提醒 + 有界自主行动**。底部架构见 [`assistant_contract_research.md`](assistant_contract_research.md)、交互层见 [`assistant_interaction_research.md`](assistant_interaction_research.md)。

## 1. 五项要求梳理

| # | 要求 | 触发 | 主动性 | 输出 |
|---|---|---|---|---|
| R1 | 计划任务执行 | 时间（cron/interval） | 主动执行 | 跑项目能力（清 trace 等） |
| R2 | todo 提醒 | 时间 / 到期 | 主动提醒 | 提醒用户待办 |
| R3 | 后台耗时任务完成提醒 | 事件（任务 done） | 主动提醒 | 通知下载/批量生成/归档/转码完成 |
| R4 | 路由模型持续不可用提醒 | 状态（配额/锁） | 主动提醒 | 通知某模型一直不可用 |
| R5 | 自主切换为可用模型 | R4 触发 | 有界自主 | 建议或自动切到可用模型 |

共性：**事件/状态/时间驱动 → 评估规则 → 通知 + （有界）行动**。这是反应式 agent（reactor），不是指令分派（dispatch）。

## 2. 共同基础（已就绪信号，全部 grounded）

### 2.1 事件广播（R3、R4 信号源）
`internal/proxy/broadcaster.go::Broadcaster`（fan-out，`Broadcast(event)`/`Subscribe()`，buffered）。`proxy.Handler` 持三个（`handler.go:49-51,97-99`）：
- `RequestUpdates`（buffer 256）：事件 `request-start`/`request-ttft`/`request-tokens`/`request-done{status: ok|error}`/`request-chunk`（`forward_retry.go:245-282`、`recorder.go:124`、`stream.go:181`、`stream_debug.go:27`）。
- `UsageUpdates`（32）、`InflightUpdates`（32）。

→ **R3（后台任务完成）**：`request-done{status}` 即模型类任务（图片生成/聊天/向量）完成或失败；下载/批量/归档/转码各有独立 SSE/状态端点（见 2.3）。
→ **R4（模型不可用）**：`request-done{status:error}` 连续失败 + 配额/锁状态（见 2.2）。

### 2.2 模型可用性状态（R4、R5 信号源）
`internal/rotation/ratelimit.go`：`QuotaSnapshot{ModelLimit,ModelRemaining,GlobalLimit,GlobalRemaining}`，`ModelExhausted() bool`（`ModelLimit>0 && ModelRemaining==0`，line 26-28）。
`internal/rotation/cooldown.go`：per-model 锁——`MarkDailyQuotaLocked`/`MarkRateLimited`/`MarkBalanceLocked`（line 17-20）+ `SonestCooldown(model)`（同一 model 跨 key 的最早解锁时间）。
`internal/registry`：`KeySnapshot.ExhaustedModelLimits map[string]int`（`ModelRemaining==0` 的 model→limit 子集，持久化于 `state.yaml`）。
`internal/api/monitor/register.go`：`getQuotas`/`model-keys` 端点暴露 per-key 配额 + exhausted 标记。

→ **"某模型一直不可用" = 该模型在所有 key 上均 `ModelExhausted()` 或被锁（daily/rate/balance）且 `SonestCooldown` 在阈值之外**——可计算。

### 2.3 后台任务状态端点（R3 信号源）
- 下载：`/api/downloads/stream`（SSE 进度）+ `GET /api/downloads/{id}`（状态：completed/failed）。
- 图片批量：`/api/image-batches` + SSE 进度 + 项目状态。
- Gallery 转码：`/api/gallery/edit/status/{id}`（poll，`gallery-edit.js` 已用）。
- 归档：`/api/archive/status`。
- 文本审：`internal/textreview/events.go`（session chunk + status 事件，自有 broadcast）。
- Probe：`/api/providers/{id}/models/test-all`（异步）。

→ 每类后台任务都有**完成/失败可观测信号**。

### 2.4 调度器（R1、R2 时序基础）
`internal/assistant.Scheduler`（in-scope 优化目标）：`RegisterJob(Job{Name,IntervalSec})`、`Has(name)`、`Count()`。契约 `semantics.json.jobs` 已声明 `clean-traces`/`clean-traces-daily`。实施计划任务 B 把它物化为 goroutine（复用 `proxy.SweepTraces`）。

→ **R1（计划任务）= Scheduler 按间隔跑 job；R2（todo 提醒）= Scheduler 跑提醒 job 或按 todo 到期触发。**

## 3. 执行层架构：反应器（reactor）

新增 `internal/assistant/reactor.go`（in-scope，与 Scheduler 同包）：

```
事件/状态/时间 ──┐
                ├─→ Reactor.evaluate(signal) ──→ 反应契约(reactions.json)
                │        ├─→ notify: 推 /api/assistant/events (SSE) → 小精灵气泡/toast
                │        └─→ act(有界): 调 dispatch(契约 tool) 或 PATCH config
                │
Scheduler(tick)──┘
Broadcaster(RequestUpdates)──┘
rotation(QuotaSnapshot/锁)──┘
后台任务状态端点──┘
```

- **信号接入**：`Reactor` 在 `app.go::Run` 启动时 `proxyHandler.RequestUpdates.Subscribe()` + 定期查 `selector` 配额/锁 + 查后台任务状态 + `Scheduler` tick。
- **反应契约** `internal/assistant/reactions.json`（contract-driven，与 semantics.json 一致哲学）：
  ```jsonc
  {
    "reactions": [
      {"when":"task.done", "area":"download", "status":"completed", "then":"notify", "msg":"下载完成: {title}"},
      {"when":"task.done", "area":"image-batch", "status":"failed", "then":"notify"},
      {"when":"model.unavailable", "threshold":"5m", "then":"notify", "autoSwitch": "suggest"},
      {"when":"schedule", "job":"trace.clear", "intervalSec":86400, "then":"dispatch:trace.clear", "auto":true},
      {"when":"todo.due", "then":"notify", "msg":"待办提醒: {text}"}
    ],
    "todos":[]  // 或独立 store
  }
  ```
  反应引用的 `dispatch:<tool>` 必须是 semantics.json 已声明的工具（契约一致性；bench 可校验 reaction 引用的 tool ∈ 契约，类似 drift 检测）。
- **通知通道**：`/api/assistant/events`（SSE，复用 `internal/sse`），前端小精灵订阅 → 气泡/toast（交互层 L1/L2/L3 都接这个流）。
- **有界自主**：`auto` 字段分级——
  - `notify`：始终自动（安全）。
  - `dispatch:<tool>`（只读/幂等如 trace.clear）：`auto:true` 可自动执行（R1）。
  - `configChange`（disable key / 切 combo）：`auto:false` 默认，仅建议（给用户"应用"按钮）；`auto:true` 需用户在设置里显式授权"高自主模式"，且仅 reversible 操作。

## 4. 逐项研究

### R1 计划任务执行
- **信号**：时间（`Scheduler` tick）。
- **方案**：反应契约 `when:schedule` + `then:dispatch:<tool>`——到点 `assistant.Resolve(tool)`→分派真实路由（走 `/api/assistant/dispatch` 内部子请求或直调）。`clean-traces`→`SweepTraces`（任务 B）。通用化：任何契约工具都能被调度（如定时"打包归档"=dispatch archive.pack）。
- **自主边界**：只读/幂等工具 `auto:true`；有副作用工具（download/archive.pack 需参数）默认 `auto:false`（提醒用户确认）。
- **可行性**：高（Scheduler 已在，任务 B 物化；契约工具可分派）。

### R2 todo 提醒
- **信号**：时间 + todo 项到期。
- **方案**：todo store（**无 DB**——`state.yaml` 一节或内存 map + 可选 `config.yaml` 持久；守 `AGENTS.md`）。`POST /api/assistant/todos`（增）、`GET`（列）、`DELETE`。每项 `{text, dueAt, done}`。`Scheduler` 跑 `todo-remind` job：遍历到期未完成→`notify`。或 reactor 在 `when:todo.due` 规则触发。
- **自主边界**：纯提醒（auto）。
- **可行性**：中（新状态，但小；复用 Scheduler + 通知通道）。

### R3 后台任务完成提醒
- **信号**：`RequestUpdates.request-done`（模型类）+ 下载/批量/gallery/archive/textreview 各自状态/SSE。
- **方案**：reactor 订阅 `RequestUpdates`；对后台任务类，reactor 跟踪"用户启动的任务 id 集"（dispatch 时记录），收到对应 `done`/状态 completed→`notify`。下载完成→`GET /api/downloads/{id}` 确认 completed→通知。批量/gallery 同理 poll 状态。
- **自主边界**：纯提醒（auto）；可选"完成后自动跳转/执行下一步"=有副作用，`auto:false`。
- **可行性**：高（事件流已就绪；只需 reactor 订阅 + 跟踪 id）。
- **风险**：任务 id 跟踪需 dispatch 时记；多源状态轮询节流（避免频繁 poll）。

### R4 路由模型持续不可用提醒
- **信号**：`QuotaSnapshot.ModelExhausted()` + per-model 锁（`MarkDailyQuotaLocked`/`MarkRateLimited`/`MarkBalanceLocked`/`SonestCooldown`）+ `request-done{error}` 连续失败。
- **方案**：reactor 定期（如每 30s）扫 `selector` 状态：对每个已用 model，若所有 key 均 `ModelExhausted()` 或被锁 且 `SonestCooldown(model)` 超过阈值（如 5min 无解锁）→ `model.unavailable` 信号→`notify`（"模型 X 已 N 分钟不可用"）。阈值用 reaction 的 `threshold` 配。
- **自主边界**：提醒（auto）。
- **可行性**：高（rotation 状态已全；monitor API 也能查；reactor 聚合即可）。
- **关键**：需 selector 暴露"某 model 跨所有 key 的可用性"查询——若现无，加 `Selector.IsModelAvailable(model) bool`（聚合 ModelExhausted + 锁）。

### R5 自主切换为可用模型
- **信号**：R4 触发。
- **方案**：
  - **会话内**：rotation 已有 **failover 策略**（失败自动切下一 key）+ **combo greedy-squirrel**（按配额层级排序尝试替代模型）——**项目本身已自动切换**。小精灵增量价值=把这次切换**显式化**（通知"已自动从 X 切到 Y"）+ 记录决策。
  - **持久/配置层**：对持续不可用的 key/model，reactor 建议（或授权后自动）`PATCH /api/providers/{id}/keys/{kid}` 禁用坏 key、或建议切到某 combo。`autoSwitch:"suggest"`（默认，给"应用"按钮）/`"auto"`（高自主模式，仅 reversible：禁用可恢复，删除不可）。
- **自主边界**：会话内自动（已有）；配置变更默认 suggest，`auto` 需授权且仅 reversible。
- **可行性**：高（rotation 已自动切换；reactor 只是显式化 + 加配置层建议）。
- **风险**：自主配置变更有破坏性——严格 `auto:false` 默认 + 审计日志；不删数据。

## 5. 与 bench 的关系

执行层是**事件/时间驱动**，no-network bench（测静态分派）不直接覆盖。但可拓展（新段，需 `init_experiment new_segment:true`）：
- **反应就绪度指标**：bench 注入合成信号（`request-done{error}` 序列、`model-exhausted` 快照、`schedule tick`），断言 reactor 对每个发出正确通知/行动 → `reaction_f1`（precision=只该提醒的提醒、recall=该提醒的都提醒）+ 反应契约 health（reaction 引用的 tool ∈ semantics.json，drift 式校验）。
- 此为前向提案，非现段指标。当前仍用浏览器烟测 + 集成测试验证 reactor（注入 fake broadcaster 事件，断言 notify）。

## 6. 升级与顺序

1. **任务 B**（Scheduler 物化 + `clean-traces` goroutine）= R1 的基础，先行。
2. **reactor 骨架** + `reactions.json` 契约 + `/api/assistant/events` SSE 通知通道（R3/R4/R5 共用）。
3. **R3**（订阅 RequestUpdates + 后台任务状态 → notify）——事件流已就绪，最快见效。
4. **R4**（模型不可用聚合 + `Selector.IsModelAvailable`）→ **R5**（显式化切换 + 配置层建议）。
5. **R2**（todo store + 提醒 job）。
6. **交互层接线**：L1/L2/L3 的小精灵气泡订阅 `/api/assistant/events`，收到 notify 即冒泡/ toast。

每步：`go build` + `go test`（reactor 用 fake broadcaster 注入事件断言 notify）+ `bash autoresearch.sh`（保 bench 100%/0 drift）+ doc-sync（`PROJECT_MAP.md` §18/§24、`docs/proxy-architecture.md`/`rotation-architecture.md` 涉及 rotation/事件的部分）。

## 7. 不变量与诚实约束

- 反应契约 `reactions.json` 引用的 `dispatch:<tool>` 必须是 `semantics.json` 已声明工具（契约一致性，drift 式校验）。
- 有界自主：`notify`/只读 dispatch 可 auto；配置变更默认 suggest、`auto` 需授权且仅 reversible；不删数据。
- 不引 DB（todo 用 state.yaml/内存）；不破 judge（`cmd/assistant-bench`/`autoresearch.sh` off-limits）。
- rotation 会话内自动切换**已存在**——R5 不是新机制，是把既有自动路由显式化 + 加配置层建议，避免重复造轮。
- 执行层不入现段 bench 指标（事件/时间驱动，非静态分派）；用集成测试 + 浏览器烟测验证，反应就绪度指标列为前向新段提案。
