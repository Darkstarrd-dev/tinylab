# config-registry-state-architecture.md — 变更日志

> 本文件存放 `docs/config-registry-state-architecture.md` 顶部「最后核对」行的历史流水与变更过程叙述（最新在上）。正文只保留当前态事实。

## 2026-10-05 · F-08 状态持久化分级（Manager 双去抖通道）

**背景：** `docs/ProjectAnalysis.md` F-08——每次成功选 key 都触发 `ScheduleWrite`（500ms 去抖全量快照写），高 QPS 下 state.yaml 每 500ms 重写一次。修复方向：把"必须持久化"（锁、配额）与"尽力持久化"（统计数据）分级。

**Manager 侧实现（`internal/state/manager.go`）：**

- 新增 `DefaultStatsDebounce = 30 * time.Second` 常量与 `statsDebounce` 字段（`NewManager` 初始化为 30s）。
- 新增 `statsPending`/`statsTimer` 与 `ScheduleStatsWrite`/`flushStats`——与关键态 `ScheduleWrite`/`flushNow` 完全同构的独立通道。
- **双通道互不取消**：关键态 timer 不因统计态写入而重置/推迟（500ms 契约不变），反之亦然；任一 timer 触发都调 `flushNowLocked()` 写同一份全量快照，`writeMu` 串行化防止交叉撕裂。
- `FlushSync`（进程关闭）同时停关键态与统计态 pending timer 并同步写全量——统计态丢失窗口上限 30s，而非"永不落盘"。
- 快照格式（`Snapshot`/`KeySnapshot`/`ComboSnapshot`）与 `Restore` 语义零变更；不新增用户可见配置。

**触发点分级（详见 docs/changelog/rotation-architecture.md 同日条目）：** 关键态（500ms）= 六个锁/退避/配额锁写入点；统计态（30s）= SelectKey 成功、RotateToBack、OnNIMRequestSuccess、combo rotateTargets。接线在 `app.go` 组合根（`StatePersist` 分支内）。

**回归测试（`internal/state/manager_stats_test.go`）：** `TestManagerStatsDebounceClass`（统计态 300ms 内不落盘、关键态 500ms 落盘、纯统计态不触发关键去抖）、`TestManagerStatsWriteEventuallyFlushes`（statsDebounce 测试内压缩为 100ms，纯统计态最终落盘）、`TestManagerFlushSyncCancelsStatsTimer`（关闭取消统计态 timer、快照抽取恰 1 次）。全量 `go test ./...` 绿（55 包 ok）。

**同步范围：** 本文核对行 + §13/§14（Manager 结构与双通道）/§15（写流分流 + 关闭路径）/§20.2（风险 #2 统计态丢失面）/§21.4（测试清单）/§22（锚点）/§23（去抖维护行）；`docs/rotation-architecture.md`、`docs/ProjectAnalysis.md`、`PROJECT_MAP.md`。
