# rotation-architecture.md — 变更日志

> 本文件存放 `docs/rotation-architecture.md` 顶部「最后核对」行的历史流水与变更过程叙述（最新在上）。正文只保留当前态事实。

## 2026-10-05 · F-08 状态持久化分级

**背景：** `docs/ProjectAnalysis.md` F-08——每次 `SelectKey` 成功都触发 `onStateChange` → `ScheduleWrite`（500ms 去抖全量快照写），高 QPS 下 state.yaml 持续重写，写放大与 key 数、probe 记录数成正比。

**实现要点：**

- `rotation/selector.go`：`Selector` 新增 `onStatsChange` 字段 + `SetStatsHook`（nil-safe：传 nil 保留旧值）；`SelectKey` 成功路径与 `RotateToBack` 改调 stats 钩子（两处均为无锁写入：旋转计数 / 队列顺序 + 信息性错误文本）。`OnKeyFailure` 分发逻辑不变——failover 策略失败仍走 `RotateToBack`（现在是统计态）。
- `rotation/nim.go`：`OnNIMRequestSuccess` 改调 stats 钩子；`MarkNIM429` 仍为关键态（写 `ModelLocks` 阶梯冷却）。
- 关键态六触发点不动：`MarkUnavailableWithOverride`、`ClearError`、`MarkDailyQuotaLocked`、`MarkBalanceLocked`、`MarkRateLimited`、`MarkNIM429`。
- `internal/combo/resolver.go`：`Resolver` 同样新增 `onStatsChange` + `SetStatsHook`；`rotateTargets`（粘性轮转索引）改调 stats 钩子。
- `internal/state/manager.go`：`DefaultStatsDebounce = 30s` 常量；`Manager` 新增 `statsPending`/`statsTimer`/`statsDebounce` + `ScheduleStatsWrite`/`flushStats`；`FlushSync` 同时停双定时器并同步写全量。
- `internal/app/app.go`：组合根在 `cfg.Rotation.StatePersist` 分支内接线 `selector.SetStatsHook(stateManager.ScheduleStatsWrite)` + `comboRes.SetStatsHook(...)`。

**语义边界：**

- 两通道定时器互不取消：统计态去抖不推迟关键态 500ms 契约；任一 timer 触发都写同一份全量快照（`writeMu` 串行化），快照格式与恢复语义零变更。
- 统计态崩溃丢失窗口 ≤30s，丢失后果仅调度启发式重置（sticky 回 index 0、NIM 计数提前重置、failover 队列顺序回退），无正确性影响。
- 不新增用户可见配置（两级窗口均为常量）。

**回归测试：**

- `internal/rotation/stateclass_test.go`：`TestStateChangeHookClasses`（逐方法断言 critical/stats 分类：MarkUnavailable/ClearError/MarkRateLimited/MarkBalanceLocked/MarkDailyQuotaLocked→critical；SelectKey/RotateToBack→stats）+ `TestSelectKeyNoCriticalWriteUnderLoad`（100 次连续选 key 零 critical 触发）。
- `internal/state/manager_stats_test.go`：`TestManagerStatsDebounceClass`（统计态 300ms 内不落盘 + 关键态 500ms 落盘 + 纯统计态不触发关键去抖）、`TestManagerStatsWriteEventuallyFlushes`（statsDebounce 压缩为 100ms 后纯统计态最终落盘）、`TestManagerFlushSyncCancelsStatsTimer`（关闭取消统计态 timer，快照抽取恰 1 次）。
- `internal/combo/resolver_test.go`：`TestRotateTargets_StatsHookNotCriticalHook`（轮转变更只达 stats 钩子）。
- 全量 `go test ./...` 绿（55 包 ok）。

**同步范围：** `docs/ProjectAnalysis.md`（F-08 条目 + §3.5 + 头部轮次 + §6）、本文核对行 + §2/§3.2/§4/§6.2/§15/§16/§17/§18、`docs/config-registry-state-architecture.md` 核对行 + §14/§15/§20.2/§21.4/§22/§23、`PROJECT_MAP.md` 核对行 + §4 rotation/state 条目 + §24。
