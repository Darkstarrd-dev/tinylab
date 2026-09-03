# TinyLab 4 Bugs + 2 Settings 调研与实施蓝图（v2，经评审修订）— 2026-08-31

> 第一版经两路 reviewer 交叉审核：6 项机制方向全部成立，但发现 **3 处硬伤 + 7 处系统性偏差 + 7 处遗漏**。本版已全量修正（H1-H3 硬伤、D1-D7 锚点、+1-+7 遗漏），作为实施蓝图。
>
> 关键修订：§3 QuickSlot 的 AutoChat 行为实为「零窗更新」而非「单窗更新」；§2 的 5s 盲区不造成「恒 0」——D（include_usage）才是主修复；§5 改 `Provider.MaxRetriesOverride` 指针方案并对齐 `effective*` 覆盖模式；§1 采用「version 驱动 SSE 单时钟」轻量方案，不新增快照端点。
>
> 来源：`web/static` / `internal/{proxy,rotation,registry,config,console}` / `internal/api/*` / `docs/*-architecture.md`。4 路 scout 并行 + QuickSlot 直连核验 + 2 路 reviewer 交叉审核。

---

## 0. 总览与实施优先级

| # | 问题 | 严重度 | 根因（评审确认） | 实施顺序 | 工作量 |
|---|------|--------|------------------|----------|--------|
| 2 | Recent 流式 `output` 恒 0 | P0 数据 | 上游从不发 `usage` + 覆盖赋值 + 节流触发盲区 + 终态无 fallback | **1st**（后端度量侧，改动收敛） | S-M (0.5-1d) |
| 3 | QuickSlot 切模型旧模型残留 | P1 正确性 | AutoChat 零窗更新 + 单窗更新 + 在途不抢占 + PUT 竞态 | **2nd**（纯前端，~10 行核心） | S (0.5d) |
| 1 | Monitor 三栏不同步 | P1 体验 | 前端三时钟 + N+1 + 非原子快照（次要）+ 丢弃 | **3rd**（前后端合流，最重） | M (1-2d) |
| 4 | Console 可读性 | P2 体验 | 8 项痛点（见 §4） | **4th**（P0 先行） | S (0.5d P0) |
| 5 | HardLimit even-retry + cooldown 新开关 | Feature | — | **5th**（牵动 config/registry/proxy/rotation 4 域） | M (1-2d 含迁移) |

**实施顺序理由：** 2/3 均单点且回归面收敛，优先修正确性；1 牵动前端合流 + 后端 SSE 契约需联调；4 独立纯前端；5 最后避免与 1-3 交叉（注意 2 与 5 在 `forward_retry.go` 有交叉点——2 的 `include_usage` 渐进与 5 的 `HardLimiter` 调用点同在 `forwardWithRetry`，实施时先落 2 再落 5 或用 `git` 分步提交隔离）。

---

## 1. Monitor：console / recent request / monitor 三栏不同步

### 1.1 现状

**前端布局：** `web/static/monitor/monitor.js:renderUsage`（本体 2-62 行，1-183 为整个页面脚本含后续函数）并发拉取 `summary` + `monitor?limit=500` + `quotas` + `settings` + `providers`，左上 Quota、左下 Recent、右栏 Console（经 `buildConsoleInto(col)` 嵌入）。`app-router.js:navigateTo('monitor')` 触发，离开 `stopUsageRefresh()+closeConsoleStream()` 清理。

| 面板 | 数据源/接口 | 刷新机制 | 触发时钟 | 渲染入口 | 订阅点 |
|------|-------------|----------|----------|----------|--------|
| **Console** | `internal/console/logger.go` 环形缓冲 → `GET /api/console-logs/stream` (`internal/api/console_logs/register.go`) | 纯 SSE，无轮询 | `startConsoleStream` 首推 `AllLines()` backlog，后 `Subscribe(100)` 逐行；`keepalive 30s`；重连指数退避 `1s*2 capped 30s jitter` | `web/static/console.js:buildConsoleInto()` → `appendLogLine()` DOM 8000 截断 | 订阅 `console.Logger` 多播（每订阅者 100 缓冲） |
| **Recent** | `GET /api/monitor` (`internal/api/monitor/register.go:getUsage 83 起`) = `Ring.All()` + `EntryTracker.All()` 非 playground 过滤 + `SweepStale(10m)`；轻量 `MarshalEntryJSONLight` 剥离 payload | SSE 增量 + 5s 轮询兜底 | `monitor_io.js:mergeUsageEntries` 去重(保留 inflight 排序)；`request-start/done` 直接 `unshift/patch` DOM 延迟 <100ms；`request-tokens/chunk/ttft` 单元格直写；`startUsageRefresh` 建 `EventSource('/api/monitor/events')` + `setInterval(5000)`；`visibilitychange` 重连 | `web/static/monitor/monitor_recent.js:renderRecentRequestsInline/updateRecentRequestsInline` 分页 30/过滤/搜索/按 `sessionKey` 分组 | 订阅 `RequestUpdates` (256 缓冲) |
| **Monitor(Quota)** | `GET /api/monitor/quotas` (`getQuotas 350 起`) = `QuotaTracker` + `ModelStats` + `EntryTracker` 临时 bar + 每 key `GetQuota` 重算 `TotalUsed/Capacity`；`GET /api/monitor/model-keys` (`getModelKeys`) per-key 排序 + `inUseKey` | SSE 去抖 + 3s TTL 缓存 + 按需 N+1 拉详情 | `monitor_io.js:scheduleQuotaRefresh 300ms` 去抖；`refreshAllKeyDetails cap=6` 并发拉全量 `/monitor/model-keys`，`keyDetailCache TTL=3000` + `expandedModels` 门控 | `web/static/monitor/monitor_quota.js:updateQuotaTable/patchQuotaRowActiveMetrics` 主行 + 子行 | 订阅 `UsageUpdates(32)` + `InflightUpdates(32)` + `RequestUpdates` 去抖后全刷 |

**聚合 SSE：** `internal/api/sse/register.go:GET /monitor/events` 同时订阅 `UsageUpdates(32)` / `InflightUpdates(32)` / `RequestUpdates(256)`（`handler.go:98-100` 确认容量差 8 倍），首推存量 `EntryTracker.All()` 为 `request-start`，循环转发 `usage-updated/key-inflight/request-start/done/chunk/ttft/tokens` + 30s keepalive。

### 1.2 根因（评审确认：三重错位，非原子快照为次要）

**R1 — 前端多时钟错开（主因，评审确认）：** `0ms`(direct patch) / `200ms`(processing latency `ensureProcessingTimer`) / `300ms`(Quota 去抖 `scheduleQuotaRefresh`) / `3s`(keyDetail TTL 子行滞后) / `5s`(usage 轮询 `setInterval 5000`) / `30s`(SSE keepalive)。Recent 直写 <100ms，Quota 去抖 300ms 后 `Promise.all` 重算，`refreshAllKeyDetails` 再追加 N+1 × RTT + 3s 缓存，实测 Quota 滞后 Recent `0.3-3s + RTT` 常态化。

**R2 — 三接口非原子快照（次要，评审降级）：** `getUsage` 与 `getQuotas` 各自独立 `All()+SweepStale`，无共同事务。但单进程 Go 内竞态窗口为微秒级，用户可见的滞后主因是 R1 的时钟与 N+1，非快照原子性。

**R3 — 过滤分歧 + 队列溢出丢弃（评审确认）：** `getUsage` 排除 `Source==playground` 而 `getQuotas` 的 `QuotaTracker` 不分 source；`monitor_quota.js:91` 跳过 `hasQuota && modelRemaining===0` 的 exhausted key，Recent 仍显示 `failure`；`proxy/broadcaster.go:Signal/Broadcast select default` 非阻塞丢弃，`RequestUpdates 256` vs `Usage/Inflight 32` 容量差 8 倍，`usage-updated` 满缓冲时被静默丢弃（Recent direct 事件仍到）→ Quota 漏刷一拍。

**证据锚点（D 系修正）：** `monitor.js:renderUsage 2-62`；`monitor_io.js:scheduleQuotaRefresh 300ms`；`monitor_quota.js:refreshAllKeyDetails cap=6 + KEY_DETAIL_TTL=3000`；`internal/api/monitor/register.go:getUsage 83 起 / getQuotas 350 起 / getModelKeys` 三次独立 `All()`；`internal/proxy/broadcaster.go:Signal default` 丢弃；`internal/proxy/handler.go:98-100` 三 broadcaster 容量。

### 1.3 修复方案（评审修订：轻量版，不新增快照端点）

**U1 修订 — version 驱动 SSE 单时钟 + 合并 N+1（推荐）：**
1. 复用现有聚合 SSE `GET /api/monitor/events`：每类推送（`request-start/done/tokens/usage-updated/key-inflight`）在 payload 中附 `version uint64`（后端 `atomic.Uint64` 于 `recordUsage`/`EntryTracker` 写操作时 `Add(1)`）。
2. 前端单 handler 按 `version` 去重/合并，`setInterval(5000)` 降级为 **version 落后补偿拉取**（检测到已收到 event 的 version 落后即 `GET /monitor` 一次补拉），彻底淘汰三时钟（200ms/300ms/3s TTL），统一为 `requestAnimationFrame` 合批重绘。
3. **合并 N+1**：`getQuotas` 响应直接内联每 key 的 `latency/avgSpeed`（`getModelKeys` 现逻辑并入 `quotas`），`keyDetailCache` 删除。此消 N+1 是 0.3-3s 滞后的主贡献，优先做。
4. `Broadcaster` 三队列容量统一（或 `usage-updated` 改 `RequestUpdates` 同容量），消除漏刷；若仍满，靠 version 补偿拉取兜底。

**不做：** 不新增 `GET /api/monitor/snapshot` 端点（评审：单进程 Go 快照竞态微秒级，性价比低）；快照原子化留作未来多实例扩展点。

**影响面：**
- FE：`web/static/monitor/{monitor,monitor_io,monitor_state,monitor_quota,monitor_recent}.js`、`web/static/app-router.js`。
- BE：`internal/api/monitor/register.go`（quotas 内联 model-keys）、`internal/api/sse/register.go`（version 附载）、`internal/proxy/{broadcaster,entry_tracker,recorder}`（version 计数）。
- 契约：`events` payload 增 `version` 字段（向后兼容，前端旧逻辑忽略即可）。

---

## 2. Recent Request 流式 `output` 恒 0

### 2.1 字段来源与两条计费路径

**结构体：** `internal/usage/ring.go:11-38 type Entry { InputTokens/OutputTokens ... }`

**前端：** `web/static/monitor/monitor_recent.js:renderUsageRow(e)` `tokensDisplay = e.inputTokens + '/' + e.outputTokens`；`e` 来自 `GET /api/monitor` (`register.go:getUsage`) 合并 `ring.All() + EntryTracker.All()`（`MarshalEntryJSONLight`）与 `GET /api/monitor/events` `request-tokens` 增量。

| 场景 | 入口 | Token 提取 | 写入 Ring/Tracker |
|------|------|------------|-------------------|
| 非流式 | `proxy/stream.go:passThroughResponse`（预算读入后 `recordUsage`） | `util.ExtractTokens(bodyBytes)` (`internal/util/util.go:20-40`) | 直接 `recordUsage` (`recorder.go:40-80`) |
| 流式 | `proxy/stream.go:streamResponse` → `forward_retry.go:150-170` 预创建 `processingEntry{ InputTokens: len(bodyBytes)/4 }` + `EntryTracker.Register()` + `broadcastRequestStart` | 逐 `data:`：`util.ExtractTokens`(OpenAI) / `parseAnthropicSSEUsage`(`stream_anthropic.go:9-35` message_start/message_delta) → **覆盖赋值** `inputTokens=in; outputTokens=out`；`sseContentLength` 计 `"content":"` 字符数 → `contentCharsTotal` | ① 每 read-batch 后检查 `>1500ms` 则 `UpdateTokens(reqID,-1,effectiveOutput)+broadcastTokens`（`stream.go:268`），`effectiveOutput = outputTokens>0 ? outputTokens : contentCharsTotal/4`；② 流结束 `recordUsage` 终态入库 |

`entry_tracker.go:87-101 UpdateTokens(id,input,output)` 锁覆盖 (`-1` 跳过)；`forward_retry.go:310-345 broadcastTokens` 经 `RequestUpdates.Broadcaster` 推 `request-tokens`；`sse/register.go:streamUsageEvents` 复用到 `GET /api/monitor/events`；`monitor_io.js:280-310 handleRequestTokens` 同步 `inflightEntries/lastUsageEntries` 与 DOM `td.tokens-cell`。

### 2.2 根因（评审修订）

**主因 A0（评审确认最简版）：上游从不发 `usage`。** `forward_retry.go:46-50` 仅对 `InjectStreamOpts` 为真的 provider 注入 `stream_options:{include_usage:true}`；多数网关（聚合转发/剥离）不发终包 `usage` → 全程 0 → 终态也 0。**这是唯一造成「终态恒 0」的根因。**

**辅因 A1 — 覆盖赋值 + 节流触发盲区：**
- `stream.go` 覆盖赋值 `inputTokens=in; outputTokens=out`；且守卫 `if in>0||out>0` —— `usage` 仅含 `output_tokens`（Anthropic 转 OpenAI 兼容中间包）时会把 `inputTokens` 覆盖为 0。
- 节流 `stream.go:268` 在 **read-batch 返回后**检查时间：上游静默期（如长 reasoning 首包后无数据）连 tick 都不触发，比「1.5s 窗口」更严。
- `stream_usage.go:7-30 sseContentLength` 仅计 `"content":"`，`tool_calls/reasoning_content/thinking` 不计；Anthropic delta 无 `"content":"` 标记 → Anthropic 流 fallback 恒 0（报告 2.2A 第三条已确认）。
- `stream.go:271` **已存在** 流中 fallback `if effectiveOutput==0 && contentCharsTotal>0 → /4`（报告修复建议 A 中「流中 fallback」为重复项，不需新增）。

**辅因 A2 — 终态无 fallback：** `recordUsage`（`stream.go:407`）直传最后 `outputTokens`，上游不发 `usage` 则终态 0（无 `contentCharsTotal/4` fallback）。

**C 层「5s 轮询盲区」——评审降级：** 终态 `recordUsage` 广播 `request-done` 携带完整 Entry 终值（`recorder.go:121-131` 确认），前端 `handleRequestDone` 立即替换行数据——SSE 连着时终态立即正确，SSE 断开时 5s 轮询兜底。**C 只造成「流中不实时」，不造成「恒 0」。** 原报告把它列为「恒 0」三层之一为夸大，本版降级为「流中实时性」问题。

**调用链：**
```
handleProxy → forwardWithRetry(forward_retry.go:30-200)
  ├─ processingEntry{ InputTokens≈len/4 } → Register → broadcastRequestStart
  └─ forwardUpstream → 2xx → streamResponse(stream.go:15-400)
       ├─ read-batch: ExtractTokens/parseAnthropicSSEUsage → 覆盖赋值 → sseContentLength
       ├─ 每批检查 >1500ms → UpdateTokens+broadcastTokens(stream.go:268)
       └─ end: recordUsage(stream.go:407) → Ring.Add → request-done + usage-updated
              └─ GET /monitor + SSE events → handleRequestTokens/handleRequestDone → DOM
```

### 2.3 修复方案（评审修订：D 为主，A 为辅）

**D（主修复）— `include_usage` 渐进推广：** 不强制注入（避免老旧网关 400），改为：`InjectStreamOpts` 默认值 `true`（`config/defaults.go` 调整，用户可关）；现有 provider 显式关闭的保持。对 `entryFormat==OpenAI` 且 `isStream` 且未显式 `stream_options` 的请求，按默认注入。Anthropic 分支已有 `message_start/delta` usage 事件不受影响。

**A（辅修复）— 后端度量侧：**
1. 节流改**时间驱动**：`streamResponse` 内起 `time.Ticker(250ms)` 或 `time.AfterFunc` 定期检查并推送，独立于 read-batch（消除静默期盲区）；推送频率 `1.5s→250ms`。
2. 覆盖赋值改**条件赋值**：`if out>0 { outputTokens=out }`、`if in>0 { inputTokens=in }`（消除反向坑 +5）。
3. **终态 fallback（必做）**：`recordUsage` 前 `if outputTokens==0 && contentCharsTotal>0 { outputTokens=contentCharsTotal/4 }`。
4. `sseContentLength` 扩展 `reasoning_content/tool_calls` 字段。

**C（兜底）— 前端：** `handleRequestTokens` 去抖合并（rAF 合批）；`EventSource` 断线即触发一次 `refreshQuotaData` 补偿，不等 5s；5s 轮询在有 `processing` 时降为 1s（复用 `hasProcessingEntries()`）。

**风险：** A 高频推送增 `Broadcaster(256)` 压力（250ms 在 60fps 安全区，需压测 100 并发）；D 默认注入对不支持 `stream_options` 的网关需失败回退（400 时重发去掉该字段，仅一次）。

**回归：** 新建 `internal/proxy/stream_usage_test.go` 覆盖（原报告引用的 `stream_e2e_test.go` 等 **不存在**——D5 修正）：(a) 无 `usage` 网关终态 fallback；(b) 条件赋值反向坑；(c) 时间驱动节流在静默期仍推送；`entry_tracker_test.go` 已存在可补。

---

## 3. QuickSlot 切模型后旧模型残留

### 3.1 链路

**配置/持久化：** `internal/config/types.go:219-229 QuickSlot{ Name, Models, SelectedIndex, DisabledModels, Disabled, Order }`（原报告 266-281 错位 40 行，已修正）；`internal/registry/quickslots.go:7-86` CRUD + `sanitizeQuickSlotModels`；`internal/api/quickslots/register.go:PUT /quickslots/{id}` 经 `Registry.UpdateQuickSlot → SaveConfigAndReload → convergeRuntime`。

**前端：** `web/static/quickslots.js` `_qsActiveId`（session-only）、`qsSetActive(id,qs)` 高亮 + 若 `currentPage==='playground'` 调 `pgApplyActiveQuickSlot(model)`、`qsGetActiveModel()` 现取；`_qsModalSelectFocused`（1047-1050 附近）`apiGet('/quickslots') → 改 selectedIndex → apiPut('/quickslots/'+id, qs) → renderHeaderQuickSlots()`，若 `_qsActiveId===qsId && playground` 调 `pgApplyActiveQuickSlot(modelName)`。

**Playground：** `pg-ui-events.js:8-18 pgApplyActiveQuickSlot(model)` **首行守卫 `if (pgState.mode !== 'normal' && pgState.mode !== 'search') return;`**（H1 修正点）→ `var w = pgWin(); w.config.model = model; pgSave(); ...`（单窗）；`pg-lifecycle.js:renderPlayground` 首屏 `qsGetActiveModel().then(a => pgWin().config.model=a.model)` 同样带 mode 守卫；`pg-stream.js:pgSend(i)` 按窗 `w.config.model` 发；`forward_request.go:handleProxy` 按 `IsComboName → GetQuickSlotByName → SplitModel+GetProviderByPrefix+ResolveModelAlias` per-request 现取 registry，**后端无缓存**。

### 3.2 根因（评审修订：R1 拆两档）

**R1a — AutoChat/Image 模式「零窗更新」（H1 硬伤修正，最严重）：** `pgApplyActiveQuickSlot` 首行守卫在 `autochat`（`pg-autochat.js:30 pgState.mode='autochat'`，且 AutoChat 强制 `splitCount>=2`）与 `image` 模式下**直接 return，一窗都不更新**。用户切槽后群聊所有窗口继续用旧模型。报告原「单窗更新 + 多窗残留」描述与代码不符——**单窗更新仅发生在 normal/search 模式**。

**R1b — normal/search 单窗更新（评审确认）：** 多窗（`splitCount>=2`）时仅 `pgWin()`（active window）更新，其他窗 `w.config.model` 仍旧 → 下一轮 `pgSend(otherWinIdx)` 发旧。`pgAutochatSendWithPerspective(winIdx)` 按窗独立取 model，群聊批量必然复现。

**R2 — 在途请求不可抢占（评审确认）：** 已 `fetch()` 的流式请求不受 `w.config.model` 变更影响（signal 仅 abort，不自动重发新 model）；Console 按 `request-start` 记录，旧模型尾包与新模型首包时间线交错，表现为「延迟才切」。

**R3 — 异步 PUT 竞态（评审确认）：** `_qsModalSelectFocused` 为 `await apiGet → 改 selectedIndex → await apiPut` 无锁，快速连切可后写覆盖先写或 `SelectedIndex` 越界回退 0；`renderHeaderQuickSlots` 异步使 header 与 registry 瞬时不一致。

**第三方客户端 — 评审补充（+1）：** 第三方客户端（Claude Code/Cline 等）直接以模型名请求，经 `forward_request.go:55-67` QuickSlot 分支 **per-request 现取 registry——切槽后立即生效，无残留**。**残留仅发生在 Playground 前端状态（`w.config.model`），后端无缓存。**

**Combo 视图 — 评审补充（+2）：** `handleCombo` 与 `/v1/models` 用 registry 现值，但 Playground `w.config.model` 仍显示旧模型名 → UI 与上游不一致。

### 3.3 修复方案（评审修订：必须放开 mode 守卫）

**P0（必做）：**
1. `pgApplyActiveQuickSlot(model)` **放开 mode 守卫**：删除 `mode!=='normal'&&mode!=='search'` 直接 return，改为「normal/search/autochat 均应用；image 模式由图片协议自行处理」。语义：QuickSlot 是全局模型预设，AutoChat 群聊窗口也应跟随。
2. 提供 `pgApplyActiveQuickSlotToAll(model)`：遍历 `pgState.windows` 全量 `w.config.model = model` + `pgSave()`；QuickSlot 切换默认调全量版。normal/search 也全窗（多窗一致），符合「槽是预设」语义。
3. 切槽时 **abort 在途流**：`for (w of pgState.windows) if (w.streaming && w.abortCtrl) { w.abortCtrl.abort(); w.streaming=false; }`，避免 Console 长尾旧条目（仅对同源 playground 请求）。
4. `_qsModalSelectFocused` 加 **版本守卫**：`apiPut` 前携带 `If-Match: <selectedIndex>` 或失败 `toast` 回滚 header；`pgApply` 以 PUT 成功返回体为准回填。
5. `pg-lifecycle.js:renderPlayground` 首屏应用同样放开 mode 守卫（AutoChat 刷新后 QuickSlot 模型生效）。

**P1（健壮化）：**
- 新增 `PATCH /quickslots/{id}/selectedIndex` 原子接口（避免全量 PUT 竞态），或 `registry.UpdateQuickSlot` 返回 `UpdatedAt` 供乐观回填。
- Console/Recent 详情展示 `sessionKey`，帮助用户区分多窗来源，减少「旧模型残留」误判。

**影响面：** `web/static/quickslots.js`、`web/playground/static-pg/playground/{pg-ui-events,pg-lifecycle,pg-stream,pg-autochat}.js`、`internal/api/quickslots/register.go`、`internal/registry/quickslots.go`、`docs/playground-architecture.md` §QuickSlot 联动。

---

## 4. Console 可读性

### 4.1 现状

**链路：** `internal/console/logger.go:Ring(200) + Subscribe(100) + sanitize(C0 转义) + write(锁) + emit`（`timestamp()` 为 `2006-01-02 15:04:05` 本地秒级，**非 ISO**——D6 修正）→ `internal/api/console_logs/register.go:GET /console-logs + /stream(SSE backlog+keepalive 30s)` → `web/static/console.js:buildConsoleInto()` toolbar（4 级过滤 + search）+ `startConsoleStream()` 首包 backlog 后 `onmessage line→appendLogLine(逐行 appendChild, 8000 DOM 截断 console.js:212)`、重连指数退避 `1s*2 capped 30s`、无轮询。

**日志格式：** `REQUEST/PROXY/📊[stream]/🌊[STREAM]` 四行模板（`docs/9router-reference.md`）+ 中文 Warn 链 + `requestCallerTag` `src=/auth=/ua=/from=` ~80 字节 + `MaskString ******` 脱敏。

### 4.2 痛点清单（评审确认 8 项）

1. 等级色弱（四色对比度不足，`info/debug` 与 `error` 色阶接近）
2. 时间戳本地秒级但直显无相对时间/秒级对齐，批量刷屏时序难读（「机器 ISO」措辞已修正）
3. 长行截断 `clipStr` 仍超 400 字符，无折行/复制
4. `requestCallerTag` 压缩一行，`provider/model/key` 无结构化徽章
5. 批量刷屏丢上下文：逐行 `appendChild` 无批量 flush（对标 9router `consoleLogBuffer.js FLUSH 100ms/MAX_BATCH 50`），8000 DOM 无虚拟化
6. 搜索与过滤割裂：无高亮、无「仅看当前 session/仅看失败」
7. 无 reqID 折叠/分组
8. 字段级复制缺失

### 4.3 分级修复

**P0 — 零依赖可先行（本次实施范围）：**
- 等级色阶重校：`style-monitor.css .log-error→--danger/.log-warn→--warning/.log-info→--text-primary/.log-debug→--text-muted`，`error` 加左侧 3px `border-left`。
- 时间列分离：`console.js:appendLogLine` 解析行首时间渲染固定宽等宽列 + `title` 完整时间 + 相对时间小字。
- 批量节流：引入 `pendingLines[] + 100ms flush + 50 batch` + `DocumentFragment`，滚动仅用户未上滚时跟随。
- 行尾 `Copy` 微按钮 + `model/reqID` 点击复制（复用 `info_common.js:copyToClipboard`）。

**P1（后续）：** reqID 折叠组 + `provider/model/sessionKey` 徽章列 + `仅失败/仅流式/仅重试` 预设 + `<mark>` 高亮。
**P2（后续）：** 虚拟化 + `Pretty/Raw` + 导出。

**涉及：** `web/static/console.js`、`web/static/style-monitor.css`、`web/static/info_common.js`；后端不改（时间戳格式 `logger.go` 保持 `2006-01-02 15:04:05`，前端展示增强）。

---

## 5. HardLimit 新增两开关

### 5.1 现状（评审确认）

**配置：** `types.go:9-18 RotationConfig{ Strategy, StickyLimit, MaxRetries, RetryDelaySec, BackoffMaxSec, StatePersist, StatePath }` 全局；`types.go:101-144 Provider{ RotationStrategy, StickyLimit, NIMConfig, HardLimit *HardLimitSettings, UseProxy ... }`；`types.go:198-206 HardLimitSettings{ RPMEnabled,RPM,TPMEnabled,TPM }` 仅 RPM/TPM 滑动 60s 节流（`proxy/hardlimit.go:HardLimiter{ window=1min }` `WaitAndReserve` RPM 与 TPM 取 max，context 可取消）。`defaults.go:44-52 DefaultConfig` Rotation `fill-first/3/MaxRetries 5/RetryDelaySec 5/BackoffMaxSec 300`；`persistence.go` 严格 YAML (`KnownFields`) + `deprecatedFieldPaths` 迁移；`registry/providers.go:84-104 UpdateProvider` **逐字段显式合并**（`HardLimit=updates.HardLimit` 整体指针替换）。

**重试/冷却参数来源链：**

| 参数 | 全局 | Provider 覆盖 | 读取点 | 覆盖优先级 |
|------|------|---------------|--------|------------|
| `MaxRetries` | `RotationConfig.MaxRetries` 默认 5 | **无**（本次新增位） | `proxy/retry.go:33-39 maxRetries()` 读 global ≤0→5；`retryState{excludeKeyIDs,...,maxRetries}` `retry.go:14-22` | 拟增 provider 优先 |
| 重试间隔 | `RetryDelaySec 5`（**死字段**，`internal/proxy` 无消费）；实际间隔由 `rotation/cooldown.go:117-136 BackoffSequence[0,1,2,4,8,10,15]` + `handle429` 6 段决定 | 无 | `retry.go:handle429` 6 段：NIM ladder→quota 头 ModelExhausted 每日锁→HasQuota BackoffSequence 10 次→SenseNova entitlement 300m→senseNova rpm/tpm 60s/15s→ClassifyError 兜底+IsDailyQuota429；`handleUpstreamError` PassThrough + 500-5000ms 退避 | 拟增 provider 均匀间隔替换通用段 |
| `cooldown` | `BackoffMaxSec 300` 封顶 | 无 | `rotation/cooldown.go:MarkUnavailable pow2(BackoffLevel) capped 300` 写 `ModelLocks`；`MarkRateLimited/MarkDailyQuotaLocked/MarkBalanceLocked/nextCSTMidnight05`；`SonestCooldown` 供 proxy 等待 | 拟增 provider 覆盖 `MarkUnavailable` 计算 |

**关键侵入点：** `proxy/retry.go:maxRetries/handle429 6段/handleUpstreamError`、`proxy/forward_retry.go`（`HardLimiter.WaitAndReserve` 在 `SelectKey` 后、NIM 前）、`rotation/cooldown.go:MarkUnavailable/isKeyAvailable/SonestCooldown`、`rotation/selector.go:effectiveStrategy/effectiveStickyLimit`（**provider 优先范式已成熟**）、`rotation/error_rules.go:ErrorAction PassThrough/Backoff/DefaultTransientCooldownSec30`。

### 5.2 新增开关设计（评审修订：Provider 顶层指针 + effective* 模式）

**信息架构：** `Settings → Provider Detail → Edit` 的 **Hard Limit 卡片**内新增两行（不进全局 Rotation 弹窗）：
1. **Even Retry（共用开关，override Rotation）**：1 toggle + 2 stepper（`Count` 1-20，`IntervalSec` 0-60s，0→无等待）；Enabled=false 时 stepper disabled 且持久化清理为 `null`。
2. **Cooldown Timer（单独开关）**：1 toggle + 1 stepper（`Sec` 1-3600s）。

**配置结构体（评审修订：对齐 effective* 同名覆盖模式，落 `Provider` 顶层指针）：**
```go
// internal/config/types.go — Provider 内新增
MaxRetriesOverride     *int `yaml:"maxRetriesOverride,omitempty" json:"maxRetriesOverride"`       // 1..20，覆盖全局 MaxRetries
RetryIntervalOverrideSec *int `yaml:"retryIntervalOverrideSec,omitempty" json:"retryIntervalOverrideSec"` // 0..60，0=连续重试，覆盖 BackoffSequence 通用段
CooldownOverrideSec    *int `yaml:"cooldownOverrideSec,omitempty" json:"cooldownOverrideSec"`    // 1..3600，覆盖 MarkUnavailable 指数退避
```
*理由（评审 +）：* 现有覆盖模式为 `effectiveStrategy/effectiveStickyLimit`（`Provider.RotationStrategy/StickyLimit` 覆盖全局 `Rotation.Strategy/StickyLimit`），命名为「同名覆盖」。`MaxRetriesOverride` 语义即覆盖 `MaxRetries`，`CooldownOverrideSec` 覆盖 `BackoffMaxSec`/`BackoffSequence` 计算，与 `RotationStrategy` 对齐；避免把重试语义塞进 `HardLimitSettings`（该卡片语义是 RPM/TPM 限流）造成信息架构混淆。三个指针 `nil→disabled` 零值兼容，`omitempty` 免迁移。

**读取优先级（`effective*` 模式，proxy/rotation 各一处）：**
```go
// internal/proxy/retry.go — maxRetries 增加 provider 维度
func (h *Handler) maxRetriesFor(providerID string) int {
    if p := h.providers.GetProviderByID(providerID); p != nil && p.MaxRetriesOverride != nil {
        return clampInt(*p.MaxRetriesOverride, 1, 20)
    }
    return h.rotSet.Settings().MaxRetries // ≤0→5 原逻辑
}
```
- `handle429` 通用段（HasQuota BackoffSequence + ClassifyError 兜底）与 `handleUpstreamError` 5xx 退避：若 `p.RetryIntervalOverrideSec != nil` 且 `MaxRetriesOverride != nil`，以 `*RetryIntervalOverrideSec * time.Second` 均匀间隔替换指数序列；**NIM ladder / quota 头 ModelExhausted 每日锁 / SenseNova entitlement 300m / rpm 60s+tpm 15s 固定段保持优先，不被覆盖**。
- `rotation/cooldown.go:MarkUnavailable` 增加 `overrideSec` 分支：`if overrideSec != nil { ttl=*overrideSec } else { ttl=min(pow2,BackoffMaxSec) }`；`selector.go` 在 `SelectKey`/`OnKeyFailure` 时读取 `Provider.CooldownOverrideSec` 传入。
- `isKeyAvailable`/`SonestCooldown` 同步读覆盖，保证重试耗尽后锁时长一致。

**前端联动：** `web/static/providers-detail.js:showEditProvider` HardLimit 卡片两行 + `saveEditProvider` 拼 `maxRetriesOverride/retryIntervalOverrideSec/cooldownOverrideSec`（null 省略）；`web/static/i18n.js` 文案 + `style.css` stepper 复用。

**冲突处理：**
- 均匀间隔仅替换通用段；每日锁/余额锁/NIM 固定段不覆盖，避免 429 网关放大风暴。
- `CooldownOverrideSec` 仅作用于 `MarkUnavailable`（重试耗尽路径），不影响 `MarkRateLimited`（60s）等短期限速。
- **`SonestCooldown` 30s 截断（+6 评审补充）**：`forward_retry.go` 等待被 `wait>30s→30s` 硬截断——`CooldownOverrideSec>30s` 时 `SelectKey` 等 30s 后仍 502。设计约束：文档说明 `CooldownOverrideSec` 上限建议 ≤30s，或同步调整 `SonestCooldown` 截断值（本次不调，仅文档声明）。
- **`RetryDelaySec` 死字段处理（+7 评审补充）**：`RetryDelaySec` 全局死字段，建议复用为 `RetryIntervalOverrideSec` 未设时的全局默认间隔（读 `RotationConfig.RetryDelaySec` 作 fallback），或本次仅文档标记 deprecated。**本版采用**：`RetryIntervalOverrideSec` 为 provider 显式覆盖；全局 `RetryDelaySec` 作为未覆盖时的默认均匀间隔（消除死字段）。

### 5.3 影响面（评审修订：修正 providers.go 内部矛盾）

| 域 | 文件 | 改动 |
|----|------|------|
| BE 配置 | `internal/config/types.go`、`defaults.go`、`persistence.go`、`validate.go` | 3 指针字段 + 默认值 + 严格解析 + clamp 校验 |
| BE 注册 | `internal/registry/providers.go:84-104` | `UpdateProvider` **追加 3 个指针字段合并项**（因用 Provider 顶层方案，需显式追加） |
| BE 轮询 | `internal/rotation/cooldown.go`、`selector.go` | `MarkUnavailable` override 分支 + `SelectKey/OnKeyFailure` 读覆盖 |
| BE 代理 | `internal/proxy/{retry,forward_retry,interfaces,handler}.go` | `maxRetriesFor`/`getProviderRetryOverride`、6 段分支均匀间隔 |
| API | `internal/api/providers/register.go`、`internal/api/settings/register.go` | `ProviderDTO` 镜像 3 字段；`PUT /providers/{id}` 透传（provider 级不经 settings PATCH） |
| FE | `web/static/providers-detail.js`、`providers.js`、`settings/settings_modal.js`、`i18n.js`、`style.css` | HardLimit 卡片两行 + stepper disabled + 文案 |
| 文档 | `docs/{rotation,proxy,config-registry-state}-architecture.md`、`PROJECT_MAP.md §24` | 新字段锚点 + 变更清单 |

**兼容/迁移：** `omitempty` + 指针 `nil→disabled` → 旧盘无迁移；`Save` 全量落盘自动回填；`validate.go` 沿用现有 HardLimit 校验模式（`Enabled && RPM/TPM<1` 告警 78-82）加 `MaxRetriesOverride<1 / RetryIntervalOverrideSec<0 / CooldownOverrideSec<1` clamp + Warn。

**文案：** `Even Retry (override Rotation) — Count/Interval(s)`（提示覆盖全局 MaxRetries/Backoff，0s=连续重试）；`Cooldown Timer (override retry-exhausted) — Sec`（提示覆盖指数退避，建议 ≤30s 因 SonestCooldown 截断）。

**风险与缓解：**
- **重试风暴：** `Count>10 + Interval 0s` 并发 429 放大 → 前端 Count 上限 10-20 + Interval 0 时 Warn；后端 `handle429` quota 头 `ModelExhausted` 仍强制每日锁。
- **冷却过短：** `CooldownOverrideSec<5s` 对 429 网关无效 → 后端 clamp ≥5s；监控页 Quota 侧过短冷却 Warn badge。
- **NIM 互斥：** 保持 `HardLimiter → NIM → 均匀间隔` 顺序，NIM 段不被覆盖。

---

## 6. 验证与文档同步（评审修订：D5 测试文件修正）

**测试覆盖（实际存在的文件）：**
- 后端：`internal/proxy/retry_test.go`、`hardlimit_test.go`（存在）；**新建** `stream_usage_test.go`（§2.3 回归：终态 fallback/条件赋值/时间驱动节流）；`internal/rotation/cooldown_test.go`、`selector_test.go`（补 override 分支）；`internal/registry/quickslots_test.go`（存在，补 selectedIndex 原子接口）；`internal/console/logger_test.go`（存在）。
- 原报告引用的 `stream_e2e_test.go`/`stream_usage_test.go`/`anthropic_usage_test.go` **不存在**（D5），已修正为新建计划。

**回归路径：**
- `go build ./... && go test ./...`。
- `node --check` 全部改动前端 JS。
- 前端手工冒烟：Monitor `renderUsage` 三栏版本合批 + SSE 断开补偿；QuickSlot **多窗/AutoChat 切槽后全窗换模型** + 在途 abort；Console P0 色阶/时间列/批量刷新；Provider Detail HardLimit 卡片 toggle→stepper disabled→PUT 持久化→`config.yaml` 校验。
- `go vet` 校验 `yaml omitempty` 新字段与 `KnownFields` 严格解析（新字段须先入 `types.go` 否则 Load 报 unknown field）。

**文档同步（强制）：** 每轮代码变更同批更新 `PROJECT_MAP.md §1-24` 文件清单 + `docs/*-architecture.md`「最后核对」行与相关章节/变更维护清单锚点。

---

## 7. 附：关键文件索引（证据集，D 系已校准）

**Monitor 三栏：** `web/static/monitor/monitor.js`(renderUsage 2-62) / `monitor_io.js`(scheduleQuotaRefresh 300ms, handleRequestTokens 280-310) / `monitor_state.js`(KEY_DETAIL_TTL 3000) / `monitor_quota.js`(skip exhausted 91, refreshAllKeyDetails cap=6) / `monitor_recent.js` / `console.js` / `app-router.js` / `internal/api/monitor/register.go`(getUsage 83 起, getQuotas 350 起) / `internal/api/console_logs/register.go` / `internal/api/sse/register.go` / `internal/proxy/{broadcaster,entry_tracker 87-101,recorder 121-131,handler 98-100}` / `internal/console/logger.go` / `internal/usage/ring.go:11-38`

**流式计数：** `internal/usage/ring.go:11-38` / `internal/proxy/entry_tracker.go:87-101` / `internal/proxy/stream.go:131 守卫, 268 节流, 271 流中fallback, 407 终态` / `stream_usage.go:7-30` / `stream_anthropic.go:9-35` / `recorder.go:40-80,121-131` / `forward_retry.go:46-50 include_usage, 150-170, 310-345` / `util.go:20-40` / `sse/sse.go:40-85` / `monitor/register.go:getUsage` / `sse/register.go` / `web/static/monitor/{monitor,monitor_io,monitor_recent}.js`

**QuickSlot：** `internal/config/types.go:219-229` / `internal/registry/quickslots.go:7-86` / `internal/api/quickslots/register.go` / `web/static/quickslots.js(_qsModalSelectFocused 1047-1050)` / `pg-ui-events.js:8-18` / `pg-lifecycle.js` / `pg-stream.js:pgSend` / `pg-autochat.js:30` / `forward_request.go:55-67`

**HardLimit：** `internal/config/types.go:9-18,101-144,198-206` / `defaults.go:44-52` / `persistence.go` / `validate.go:78-82` / `registry/providers.go:84-104` / `rotation/{selector,cooldown 117-136,error_rules,nim}.go` / `proxy/{retry 14-22,33-39,forward_retry,hardlimit,interfaces}.go` / `api/providers/register.go` / `web/static/providers-detail.js` / `docs/{rotation,proxy}-architecture.md`
