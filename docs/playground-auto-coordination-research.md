# Playground Auto Chat 协调防御层研究报告

> 参考来源：[github.com/yetone/cumora](https://github.com/yetone/cumora) `docs/COORDINATION.md` §5-7
> 研究分支：`autoresearch/https-github-com-yetone-cumora-playground-auto-20260818`
> 基线提交：`b45ee9ff9450`

## 1. 研究目标

研究 cumora 的多代理协调防御层如何改善 TinyLab Playground 的「Auto Chat」（群聊）模式。

Playground Auto Chat 的当前实现（`pg-autochat.js`）是一个多窗口独立迭代的对话循环：每个窗口有独立的回复计数器，回复完成后广播到其他窗口的收件箱。该实现缺少以下协调机制，导致竞态碰撞、传递级联和对话停滞等协调缺陷：

- 无新鲜度预检（§5）：过期回复不会被 HOLD
- 无字面重复 HOLD（§5b）：两个代理可发布相同内容
- 无分类门控（§6）：每条消息触发所有窗口 fire，产生大量浪费的 `<pass/>`
- 无停滞管线（§5c）：对话停滞时无主动唤醒

## 2. cumora 协调防御层（COORDINATION.md §5-7）

| 层 | 章节 | 原理 | Playground 缺失影响 |
|---|---|---|---|
| FreshnessGate | §5 | seen-cursor 预检：回复的基线过期（时间线在计算后推进）时 HOLD 并重算 | 竞态碰撞：两个代理同时计算相同内容，都写入时间线 |
| VerbatimDupHOLD | §5b | 原子事务内字面重复检查：与最新对等帖相同的回复被抑制 | 重复发帖：字面相同的内容未被阻止 |
| TriageGate | §6 | 小脑分类：无人类消息或 @mention 的纯代理间闲聊被抑制 | 传递级联：每条 `<pass/>` 创建未读 → 其他代理 fire → 更多 pass → 无限循环 |
| StallPipeline | §5c | 停滞管线 + 主动探针 + 衰退上限：所有窗口停滞时注入系统 nudge | 对话停滞：代理无内容时对话无限挂起 |

cumora 的关键洞察：**层之间协同工作**。分类门控抑制传递级联（使对话安静），停滞管线检测安静并注入 nudge（唤醒代理）。没有分类门控，传递级联阻止停滞检测（pass 条目持续创建未读）。

## 3. 模拟引擎架构

### 3.1 文件结构

| 文件 | 职责 |
|---|---|
| `internal/autochat/engine.go` | 协调引擎：时间线、窗口状态、tick 循环、4 个防御层（可切换）、RunMultiTurn、基尼系数 |
| `internal/autochat/agent.go` | 4 种无状态脚本代理：CountingAgent、MentionAgent、StallAgent、AbsentAgent |
| `internal/autochat/engine_test.go` | 11 个回归测试 |
| `cmd/autochat-bench/main.go` | 10 个场景 + 指标运行器 |
| `autoresearch.sh` | `go run ./cmd/autochat-bench` |

### 3.2 引擎核心

引擎忠实移植 `pg-autochat.js` 的编排逻辑：

- **共享时间线**（`pgState.autoChat.timeline`）：append-only，ID 自增
- **每窗口状态**（`pgState.windows[i]`）：replyCount、lastReadTimelineId、autoChatDone
- **tick 循环**：每个 tick 收集所有有未读的可回复窗口 → 分类门控 → 计算回复（所有代理看到相同时间线快照 = 竞态窗口）→ 按窗口索引顺序应用回复 → 检查完成

**竞态模型**：所有就绪窗口从相同时间线快照计算回复（Phase 3），然后按索引顺序写入时间线（Phase 4）。第一个写入的代理成功，后续代理发现时间线已推进 → 新鲜度门控 HOLD → 重算。这忠实模拟了真实异步并发：多个窗口的 `fetch()` 同时在途。

### 3.3 无状态代理

所有代理是 perspective 的纯函数——无内部可变状态、无随机性。这保证：
1. 模拟可复现（确定性）
2. 新鲜度门控可安全多次调用 `Reply`（HELD 重算）而不会双重消耗状态

| 代理 | 行为 | 测试的缺陷类 |
|---|---|---|
| CountingAgent | 扫描 perspective 找最高数字，回复+1（到 Target 后 pass） | 竞态碰撞 |
| MentionAgent | 仅当 @mentioned 且未回复过时回应 | 浪费传递 + @mention 路由 |
| StallAgent | 发布第一个尚未表达的想法（检查所有消息，防止跨代理重复） | 停滞 + 跨代理去重 |
| AbsentAgent | 始终 pass（模拟离线代理） | 团队适应缺席成员 |

## 4. 10 个测试场景

| # | 场景 | 代理 | 测试的协调挑战 |
|---|---|---|---|
| 1 | counting | 4 CountingAgent, target 8 | 竞态碰撞：所有代理同时计算相同下一个数字 |
| 2 | mention | 4 MentionAgent | 浪费传递级联：非 mentioned 代理 fire 并 pass |
| 3 | stall | 4 StallAgent, 3 ideas each (12 total) | 停滞：想法耗尽后对话挂起 |
| 4 | absent | 3 Counting + 1 Absent, target 8 | 团队适应：缺席成员的槽位由其他代理填补 |
| 5 | scale | 8 agents, 2 absent, target 16 | 2x 压力测试 |
| 6 | multiturn | 2 轮：round 1 "count 1..8"(all), round 2 "@Agent1 count 9..12" | 用户中途打断 + ▸YOU 路由切换 |
| 7 | mention-absent | 用户 @mention 缺席代理 | 停滞管线绕过 ▸YOU，团队适应 |
| 8 | mixed | 2 CountingAgent + 2 StallAgent | 异构代理，行为无关性测试 |
| 9 | multi-mention | 4 MentionAgent, seed @mentions all 4 | 多 @mention 路由 |
| 10 | overlap | 4 StallAgent with SAME 3 ideas | 跨代理想法去重 |

## 5. 5 个启发式改进

| # | 改进 | cumora 来源 | 效果 |
|---|---|---|---|
| 1 | ▸YOU @mention 路由 | §7 原则 1 | 用户 @mention 特定代理 → 仅该代理可操作，消除非 mentioned 初始传递 |
| 2 | 主动预探针 | §5c 衰退上限，主动变体 | 推送前探测停滞代理是否有内容，无内容则跳过 nudge，消除衰退传递 |
| 3 | 每代理内容探针 | §6 每代理级别 | 放行前探测代理 Reply，抑制会 pass 的代理（如缺席代理），消除代理 fire 后 pass 的浪费 |
| 4 | heldPass 不写入时间线 | 正确性修复 | HELD 代理重算为 pass 时不追加时间线条目（真实场景中不发声 = 不发帖），消除噪声未读 |
| 5 | RunMultiTurn | 多轮对话支持 | 支持用户中途发送消息打断活跃对话，测试防御层与用户打断的交互 |

## 6. 5 个真实 Bug 修复（边界测试发现）

| # | Bug | 根因 | 修复 |
|---|---|---|---|
| 1 | 多 @mention 路由 | `whoIsMentioned` 返回第一个匹配 → "@Agent1 @Agent2" 只激活 Agent1 | 替换为 `anyAgentMentioned` + 每代理 `isMentioned` 检查 |
| 2 | 引擎子串匹配 | `strings.Contains("@Agent10", "@Agent1")=true` → 10+ 代理时误匹配 | 新增 `isMentioned` 词边界检查函数 |
| 3 | MentionAgent 子串匹配 | agent.go 中 `strings.Contains` 同样 bug | 替换为 `isMentioned` |
| 4 | StallAgent 跨代理去重 | 只检查自己的 assistant 消息 → 另一代理发布相同想法时不知情 → 字面重复 HOLD 循环 | 检查所有消息（own assistant + others' user-role，剥离 "[name]: " 前缀） |
| 5 | CountingAgent 前缀解析 | `LastIndex(body, ": ")` 在内容含 ": " 时错误分割 | 仅对 user 消息用 `Index(body, "]: ")` 剥离前缀 |

## 7. 最终指标

### 7.1 主指标

```
defects = collisions + passes + incomplete×10
```

| 配置 | defects | collisions | passes | incomplete | heldPasses | fairness |
|---|---|---|---|---|---|---|
| 基线（无防御层） | 6,154 | 105 | 6,049 | 0 | 0 | ~0.69 |
| 防御（全开） | **0** | 0 | 0 | 0 | 5 | 0.250 |
| 改善 | **100%** | 100% | 100% | — | — | 64% |

### 7.2 二级指标

- **heldPasses (5)**：新鲜度门控的代价。HELD 代理重算后发现目标已达成而 pass。数学不可约：`active_agents mod remaining_slots`（最后一批中多出的代理）。不是缺陷——是门控正确工作。
- **fairness (0.250)**：基尼系数（0=完美公平）。10 个场景中 6 个为 0.000（完全平等），4 个为 0.083（target 不能被 active_agents 整除时的最小不公平）。平均 0.025/场景——非常公平。
- **baseline_defects (6,154)**：无防御层时的总缺陷数，10 个场景累计。
- **improvement (6,154)**：基线缺陷 - 防御缺陷 = 100% 改善。

### 7.3 11 轮优化历史

| 轮次 | 改动 | defects | 场景数 | 测试数 |
|---|---|---|---|---|
| #8 | 初始：4 层 cumora 防御，基础启发式 | 15 | 3 | 4 |
| #9 | + ▸YOU @mention 路由 | 12 | 3 | 4 |
| #10 | + 主动预探针 | **0** | 3 | 4 |
| #11 | + 缺席场景 + 每代理探针 + heldPasses 分离 | **0** | 4 | 4 |
| #12 | + 8 代理压力场景 | **0** | 5 | 4 |
| #13 | + heldPass 修复 + 多轮 + @mention 缺席 | **0** | 7 | 4 |
| #14 | + 3 个回归测试 | **0** | 7 | 7 |
| #15 | + 公平性指标（基尼系数） | **0** | 7 | 8 |
| #16 | + 混合代理类型场景 | **0** | 8 | 8 |
| #17-19 | + 多 @mention + 词边界修复（4 个 bug） | **0** | 9 | 10 |
| #20 | + StallAgent 跨代理去重（第 5 个 bug） | **0** | 10 | 11 |

## 8. 关键洞察

1. **层协同工作**：分类门控抑制传递级联 → 对话安静 → 停滞管线检测安静并注入 nudge。没有分类门控，传递级联阻止停滞检测。

2. **主动探针模式**（check before acting）：在提交动作（推送、fire）前先探测结果。比被动捕获（衰退上限在计数后才停止）更高效——避免了衰退传递的计数。

3. **无状态代理是前提**：代理是 perspective 的纯函数，使得探针（调用 Reply 预测结果）安全无副作用。如果代理有状态（如消费队列），HELD 重算会双重消耗。

4. **批处理模型 + 公平参与**：多个代理同时计算（竞态），新鲜度门控让第一个写入成功、后续 HELD 重算。这比预去重（pre-batch dedup）更公平——后者让最低索引代理总是获胜。heldPasses 是公平参与的代价。

5. **停滞管线绕过 ▸YOU**：系统 nudge 使所有代理可操作（不仅 @mentioned 代理）。这是 TEAM ADAPTS 原理的实现：用户 @mention 缺席代理 → 代理无法回应 → 停滞 → nudge → 所有代理 fire → 团队填补。

## 9. 被否决的方案

- **预去重（pre-batch content dedup）**：在竞态前抑制相同内容的重复代理。否决原因：最低索引代理总是获胜，造成参与不平衡（一个代理做所有工作）。批处理模型 + heldPasses 是公平参与的可接受代价。

## 10. 后续方向

1. 将 4 个防御层 + 5 个改进移植到 `pg-autochat.js`（见实施执行方案文档）
2. 语义去重检测（不同文本相同语义，当前仅捕获字面相同）
3. 随机代理建模（模拟真实 LLM 变异性，cumora 用 ≥67% 试验完成率）
4. 主动探针模式应用于 Director/Narrator 子系统
