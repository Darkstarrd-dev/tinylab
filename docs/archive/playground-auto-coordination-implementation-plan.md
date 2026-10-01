# Playground Auto Chat 协调防御层实施执行方案

> 本文档是自包含的实施入口。阅读本文档后可直接开始编码，无需其他上下文。
> 配套研究报告：`docs/playground-auto-coordination-research.md`
> 参考来源：`github.com/yetone/cumora` `docs/COORDINATION.md` §5-7
> Go 模拟引擎（已完成验证）：`internal/autochat/engine.go`

## 0. 背景

TinyLab Playground 的「Auto Chat」（群聊）模式（`pg-autochat.js`）是一个多窗口独立迭代的对话循环。当前实现缺少协调机制，导致三类缺陷：

| 缺陷类 | 现象 | 根因 |
|---|---|---|
| 竞态碰撞 | 两个代理同时计算相同内容，都写入时间线 | 无新鲜度预检（§5） |
| 传递级联 | 每条 `<pass/>` 创建未读 → 其他代理 fire → 更多 pass → 循环到 maxTicks | 无分类门控（§6） |
| 对话停滞 | 代理无内容时对话挂起，未完成目标 | 无停滞管线（§5c） |

Go 模拟引擎已验证：4 个 cumora 防御层 + 5 个启发式改进将协调缺陷从 6,154 降至 0（100% 改善），覆盖 10 个场景，11 个回归测试全部通过。

## 1. 涉及文件

| 文件 | 角色 | 修改内容 |
|---|---|---|
| `web/playground/static-pg/playground/pg-autochat.js` | 编排核心 | FreshnessGate、VerbatimDupHOLD、TriageGate、StallPipeline 的 4 个函数修改 |
| `web/playground/static-pg/playground/pg-state.js` | 状态管理 | autoChat 配置新增 4 个布尔开关 + 辅助函数 |
| `web/playground/static-pg/playground/pg-director.js` | Director/Narrator | 可选：主动探针模式减少不必要的大模型调用 |
| `web/playground/static-pg/playground/pg-ui.js` | UI | 可选：侧栏新增 4 个开关的 checkbox |

## 2. 当前 JS 函数签名（修改前）

```
pgAutoChatDoSend(winIdx)          — 渲染 perspective + 发送（无延迟）
pgAutoChatOnFinish(winIdx)        — 回复完成钩子（pass 检测 + 时间线追加 + 广播）
pgAutoChatProcessWindowInbox(winIdx) — 检查未读 + 调度回复（含延迟）
pgAutoChatCheckAllDone()          — 检查所有窗口是否完成/停滞
pgAutoChatAppendTimeline(sender, senderType, winIdx, content, status)
pgAutoChatRenderPerspective(winIdx) — 从共享时间线构建每窗口消息视图
pgAutoChatCanReply(winIdx)        — 窗口是否可回复
pgAutoChatGetAgentName(winIdx)    — 获取代理显示名
```

关键状态（`pg-state.js`）：
```js
// 每窗口（makeWin）
w.lastReadTimelineId  // 已读时间线游标
w.replyCount          // 回复计数
w.autoChatDone        // 是否完成
w.autoChatPending     // 是否有待回复
w.streaming           // 是否正在流式传输

// 全局（pgState.autoChat）
pgState.autoChat.timeline      // 共享时间线（append-only）
pgState.autoChat.timelineId    // 时间线条目 ID 计数器
pgState.autoChat.isRunning     // 循环是否活跃
pgState.autoChat.session       // epoch（start/stop 时递增）
```

## 3. 实施步骤

### 步骤 1：pg-state.js — 新增防御层开关

在 `pgState.autoChat` 对象中（`pg-state.js` 第 66 行附近）新增：

```js
autoChat: {
  // ... 现有字段 ...
  // Cumora 协调防御层（全部默认 true，可由 UI 关闭以对比效果）
  freshnessGate: true,       // §5: 过期回复 HOLD 并重算
  verbatimDupHOLD: true,     // §5b: 字面相同回复抑制
  triageGate: true,          // §6: 代理间闲聊抑制 + ▸YOU @mention 路由
  stallPipeline: true,       // §5c: 停滞时注入 nudge + 主动探针
},
```

在 `pgSaveAutoChat`（保存到 localStorage 的函数）中新增这 4 个字段的持久化。

### 步骤 2：pg-autochat.js — 新增辅助函数

在 `pg-autochat.js` 顶部辅助函数区（`pgAutoChatGetAgentName` 附近）新增：

```js
// ----- Cumora 防御层辅助函数 -----------------------------------------

// 词边界 @mention 检查：防止 "@Agent1" 匹配 "@Agent10"。
// @name 后的字符必须是非字母数字或字符串结尾。
function pgIsMentioned(content, name) {
  var mention = '@' + name;
  var idx = content.indexOf(mention);
  if (idx < 0) return false;
  var end = idx + mention.length;
  if (end >= content.length) return true;
  var c = content.charAt(end);
  return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'));
}

// 检查消息内容中是否 @mention 了任何代理。
function pgAnyAgentMentioned(content) {
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w || !w.config.model) continue;
    var name = pgAutoChatGetAgentName(i);
    if (name && pgIsMentioned(content, name)) return true;
  }
  return false;
}

// 获取最新的非自身代理完整帖内容（用于字面重复检查）。
function pgLatestPeerContent(winIdx) {
  var timeline = pgState.autoChat.timeline;
  for (var i = timeline.length - 1; i >= 0; i--) {
    var e = timeline[i];
    if (e.senderType === 'agent' && e.winIdx !== winIdx && e.status === 'complete') {
      return e.content;
    }
  }
  return null;
}

// 字面重复检查：回复是否与最新对等帖字面相同。
function pgIsVerbatimDup(content, winIdx) {
  var peer = pgLatestPeerContent(winIdx);
  if (!peer || !peer.trim()) return false;
  return content.trim() === peer.trim();
}

// 停滞管线 nudge 文案（与 Go 引擎常量一致）。
var PG_STALL_NUDGE = 'The discussion seems to stalled. Please share your next thought or build on what others said.';
var PG_MAX_STALL_NUDGES = 6;
```

### 步骤 3：pg-autochat.js — FreshnessGate（§5）+ VerbatimDupHOLD（§5b）

修改 `pgAutoChatOnFinish`（第 308 行），在**追加回复到时间线之前**插入两个检查：

```js
function pgAutoChatOnFinish(winIdx) {
  // ... 现有的 pass 检测和处理不变（第 309-351 行）...

  // ===== 以下为正常回复的处理（第 354 行开始）=====

  // Normal reply: count this reply toward the iteration limit.
  w.replyCount++;

  // Check iteration limit.
  var iters = pgState.autoChat.iterations;
  if (iters > 0 && w.replyCount >= iters) {
    w.autoChatDone = true;
  }

  // ----- [新增] VerbatimDupHOLD (§5b) -----
  // 在追加到时间线前，检查回复是否与最新对等帖字面相同。
  // 如果相同，不追加（抑制重复内容），标记已读。
  var sender = pgAutoChatGetAgentName(winIdx);
  var replyContent = (content && content.trim()) ? content : pgT('(no response)');

  if (pgState.autoChat.verbatimDupHOLD && pgIsVerbatimDup(replyContent, winIdx)) {
    // 字面重复：不追加到时间线，标记已读，继续处理其他窗口。
    w.lastReadTimelineId = pgState.autoChat.timelineId;
    if (typeof pgUpdateAutoChatUI === 'function') pgUpdateAutoChatUI();
    // 仍然触发其他窗口处理（它们可能有其他未读）。
    for (var k = 0; k < pgState.splitCount; k++) {
      if (k === winIdx) continue;
      pgAutoChatProcessWindowInbox(k);
    }
    pgAutoChatCheckAllDone();
    if (typeof pgDirectorOnAgentReply === 'function' && pgState.autoChat.isRunning) pgDirectorOnAgentReply(winIdx);
    return;
  }

  // 追加到时间线（原有逻辑）。
  pgAutoChatAppendTimeline(sender, 'agent', winIdx, replyContent, 'complete');

  // ... 后续广播、summarization、director hook、checkAllDone 不变 ...
}
```

**注意**：FreshnessGate（§5）在 JS 中不同于 Go 模拟。JS 的 `pgAutoChatDoSend` 已经在发送前重建 perspective（`pgAutoChatRenderPerspective`），相当于每次发送都读取最新状态。真正的竞态发生在多个窗口的 `fetch()` 同时在途时。

要在 JS 中实现 FreshnessGate，需要在 `pgAutoChatOnFinish` 中检查：回复完成时，时间线是否在代理计算后推进了（有新的非自身帖）。如果是，代理的回复可能基于过期状态——追加前检查是否为字面重复（由 VerbatimDupHOLD 处理）。

实际上，`pgAutoChatDoSend` 已经在发送前检查 `hasUnread` 并重建 perspective。FreshnessGate 在 JS 中的等价物是：**在 `pgAutoChatOnFinish` 追加回复前，检查时间线是否有新的非自身帖在计算后到达**。如果有，可以追加一个 system nudge 让代理重新评估，或者简单地依赖 VerbatimDupHOLD 阻止重复。

**推荐实现**：在 `pgAutoChatOnFinish` 中记录发送时的时间线 ID，完成时比较：

```js
// 在 pgAutoChatDoSend 中（发送前）记录基线：
w._freshnessBaseline = pgState.autoChat.timelineId;
// 在 pgAutoChatOnFinish 中（完成后）检查：
if (pgState.autoChat.freshnessGate && pgState.autoChat.timelineId > w._freshnessBaseline) {
  // 时间线在计算后推进了 → 可能基于过期状态
  // 依赖 VerbatimDupHOLD 阻止字面重复
  // 如果内容不是重复 → 正常追加（代理看到了最新状态并做出了不同决策）
}
```

### 步骤 4：pg-autochat.js — TriageGate（§6）+ ▸YOU 路由 + 每代理探针

修改 `pgAutoChatProcessWindowInbox`（第 221 行），在发送前加入分类门控：

```js
function pgAutoChatProcessWindowInbox(winIdx) {
  if (!pgAutoChatCanReply(winIdx)) return;
  var w = pgWinAt(winIdx);

  // Unread check against the shared timeline.
  var hasUnread = pgState.autoChat.timeline.some(function(e) {
    return e.id > w.lastReadTimelineId;
  });
  if (!hasUnread) return;

  // ----- [新增] TriageGate (§6) -----
  if (pgState.autoChat.triageGate) {
    var myName = pgAutoChatGetAgentName(winIdx);
    var actionable = false;

    // 扫描未读条目，判断是否有可操作内容。
    for (var i = 0; i < pgState.autoChat.timeline.length; i++) {
      var entry = pgState.autoChat.timeline[i];
      if (entry.id <= w.lastReadTimelineId) continue;

      if (entry.senderType === 'user') {
        // ▸YOU 路由：如果用户 @mention 了任何代理，
        // 只有被 mention 的代理可操作；否则所有代理可操作。
        if (pgAnyAgentMentioned(entry.content)) {
          if (pgIsMentioned(entry.content, myName)) {
            actionable = true;
          } else {
            // 不是被 mention 的代理 → 不操作
            pgAutoChatSuppressFire(winIdx);
            return;
          }
        } else {
          actionable = true; // 无 @mention → 所有人可操作
        }
      }

      // @mention 在任何消息中 → 可操作
      if (pgIsMentioned(entry.content, myName)) {
        actionable = true;
      }

      // 系统 nudge → 可操作
      if (entry.senderType === 'system' &&
          entry.content.indexOf(PG_STALL_NUDGE) >= 0) {
        actionable = true;
      }
    }

    if (!actionable) {
      pgAutoChatSuppressFire(winIdx);
      return;
    }

    // 每代理内容探针：在 JS 中，这意味着在发送前先检查代理是否会 pass。
    // 由于 JS 使用真实 LLM（无法预判），这里的探针只能检查：
    // 1. 代理是否已经回复过（perspective 中已有 assistant 消息）
    // 2. 代理是否被 @mention 但已回复
    // 这些检查在代理行为中（系统 prompt）处理，不在引擎层。
    // 引擎层的探针主要针对模拟中的确定性代理。
    // 在 JS 中，等价的是：不重复触发已回复的代理。
    // 这已由 pgAutoChatCanReply 的 autoChatDone 检查覆盖。
  }

  // ... 后续延迟调度 + pgAutoChatDoSend 不变 ...
}
```

新增辅助函数：
```js
// 抑制 fire：推进游标使该窗口不再因当前未读触发。
function pgAutoChatSuppressFire(winIdx) {
  var w = pgWinAt(winIdx);
  if (!w) return;
  var lastEntry = pgState.autoChat.timeline[pgState.autoChat.timeline.length - 1];
  w.lastReadTimelineId = lastEntry ? lastEntry.id : w.lastReadTimelineId;
}
```

### 步骤 5：pg-autochat.js — StallPipeline（§5c）+ 主动探针

修改 `pgAutoChatCheckAllDone`（第 393 行），替换现有的停滞恢复逻辑：

```js
function pgAutoChatCheckAllDone() {
  if (!pgState.autoChat.isRunning) return;
  if (typeof pgDirectorEvalInFlight === 'function' &&
      (pgDirectorEvalInFlight() ||
       (typeof pgDirectorNarratorPending === 'function' && pgDirectorNarratorPending()))) return;

  var modelWins = pgAutoChatModelWindows();
  var anyActive = false;
  var allHitLimit = true;
  var stalled = [];

  modelWins.forEach(function(i) {
    var w = pgWinAt(i);
    if (w.streaming || w.autoChatPending) { anyActive = true; allHitLimit = false; return; }
    if (w.autoChatDone) return;
    allHitLimit = false;
    var hasUnread = pgState.autoChat.timeline.some(function(e) {
      return e.id > w.lastReadTimelineId;
    });
    if (hasUnread) { anyActive = true; return; }
    stalled.push(i);
  });

  if (anyActive) return;
  if (allHitLimit) {
    if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
    pgAutoChatFinish();
    return;
  }

  // ----- [修改] StallPipeline (§5c) -----
  if (pgState.autoChat.stallPipeline && stalled.length > 0) {
    // 初始化停滞 nudge 计数器（如果不存在）
    if (pgState.autoChat.stallNudgeCount === undefined) {
      pgState.autoChat.stallNudgeCount = 0;
    }
    if (pgState.autoChat.stallNudgeProducedContent === undefined) {
      pgState.autoChat.stallNudgeProducedContent = false;
    }

    // 衰退上限：如果上次 nudge 未产生内容，停止推送。
    if (pgState.autoChat.stallNudgeCount > 0 && !pgState.autoChat.stallNudgeProducedContent) {
      if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
      pgAutoChatFinish();
      return;
    }

    // nudge 上限。
    if (pgState.autoChat.stallNudgeCount >= PG_MAX_STALL_NUDGES) {
      if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
      pgAutoChatFinish();
      return;
    }

    // 注入系统 nudge。
    pgAutoChatAppendTimeline('System', 'system', -1, PG_STALL_NUDGE, 'complete');
    pgState.autoChat.stallNudgeCount++;
    pgState.autoChat.stallNudgeProducedContent = false;

    // 触发所有停滞窗口处理新 nudge。
    stalled.forEach(function(i) { pgAutoChatProcessWindowInbox(i); });
    return;
  }

  // 现有逻辑：迭代限制时的停滞恢复（保留作为无 stallPipeline 时的回退）。
  var iters = pgState.autoChat.iterations;
  if (iters > 0 && stalled.length > 0) {
    stalled.sort(function(a, b) { return pgWinAt(a).replyCount - pgWinAt(b).replyCount; });
    var w = pgWinAt(stalled[0]);
    w.lastReadTimelineId = 0;
    pgAutoChatProcessWindowInbox(stalled[0]);
    return;
  }

  if (typeof pgDirectorOnBeforeFinish === 'function' && pgDirectorOnBeforeFinish()) return;
  pgAutoChatFinish();
}
```

在 `pgAutoChatOnFinish` 中（正常回复追加后），重置 nudge 状态：
```js
// 正常回复追加到时间线后：
pgState.autoChat.stallNudgeProducedContent = true;
```

在 `pgAutoChatStart` 中（开始时）重置 nudge 计数器：
```js
pgState.autoChat.stallNudgeCount = 0;
pgState.autoChat.stallNudgeProducedContent = false;
```

**关于主动探针**：在 JS 中，代理是真实 LLM，无法在发送前预判是否会 pass。主动探针在 JS 中的等价物是：**不推送已经回复过的代理**（由 `autoChatDone` 和 `replyCount >= iterations` 检查覆盖），以及**不推送没有未读的代理**（由 `hasUnread` 检查覆盖）。衰退上限是 JS 中可实现的主动探针的被动等价物。

### 步骤 6：pg-autochat.js — heldPass 正确性

在 `pgAutoChatOnFinish` 中，pass 的处理已经正确——pass 追加到时间线（可见在 modal 中），但 `replyCount` 不递增。这与 Go 引擎一致。

如果后续实现 FreshnessGate 的 HELD 重算，HELD 代理重算为 pass 时**不追加到时间线**（不创建噪声未读）。但在当前 JS 实现中（无 HELD 重算），所有 pass 都追加到时间线——这是正确的，因为 pass 是代理的初始计算结果（不是重算结果）。

### 步骤 7（可选）：pg-ui.js — 防御层开关 UI

在 autochat 侧栏面板中新增 4 个 checkbox：

```html
<div class="pg-param-row">
  <label>协调防御层</label>
</div>
<div class="pg-param-row" style="flex-wrap:wrap;gap:8px">
  <label><input type="checkbox" id="pg-freshness-gate" onchange="pgSetAutoChatLayer('freshnessGate', this.checked)" checked> 新鲜度</label>
  <label><input type="checkbox" id="pg-verbatim-dup-hold" onchange="pgSetAutoChatLayer('verbatimDupHOLD', this.checked)" checked> 去重</label>
  <label><input type="checkbox" id="pg-triage-gate" onchange="pgSetAutoChatLayer('triageGate', this.checked)" checked> 分类</label>
  <label><input type="checkbox" id="pg-stall-pipeline" onchange="pgSetAutoChatLayer('stallPipeline', this.checked)" checked> 停滞</label>
</div>
```

```js
function pgSetAutoChatLayer(layer, enabled) {
  pgState.autoChat[layer] = enabled;
  pgSaveAutoChat();
}
```

## 4. 实施顺序

| 步骤 | 优先级 | 改动文件 | 风险 | 验证方式 |
|---|---|---|---|---|
| 1 | P0 | pg-state.js | 低（新增字段） | 刷新后默认全开 |
| 2 | P0 | pg-autochat.js | 低（新增函数） | 无行为变化 |
| 4 | P0 | pg-autochat.js | 中（修改 ProcessWindowInbox） | 手动测试：非 mentioned 代理不 fire |
| 3 | P1 | pg-autochat.js | 中（修改 OnFinish） | 手动测试：重复回复被抑制 |
| 5 | P1 | pg-autochat.js | 中（修改 CheckAllDone） | 手动测试：停滞后 nudge 注入 |
| 6 | 无改动 | — | — | — |
| 7 | P2 | pg-ui.js | 低（新增 UI） | checkbox 切换可对比效果 |

建议按 P0 → P1 → P2 顺序实施，每步手动验证后再进入下一步。

## 5. 验证策略

### 5.1 手动验证（浏览器）

1. **竞态碰撞**：2+ 窗口，发送「从 1 数到 8」，观察无重复数字
2. **传递级联**：2+ 窗口，发送消息后观察 pass 不无限级联
3. **停滞恢复**：2+ 窗口，代理无内容时观察 system nudge 注入
4. **@mention 路由**：发送「@Agent2 你觉得呢」，观察只有 Agent2 回复
5. **多 @mention**：发送「@Agent1 @Agent2 你们觉得呢」，观察两个都回复
6. **缺席适应**：一个窗口不设模型，观察其他代理填补
7. **UI 开关**：关闭各防御层，观察对应缺陷重现

### 5.2 Go 模拟回归

```bash
cd /path/to/tinylab
go test ./internal/autochat/ -v   # 11 个回归测试
go run ./cmd/autochat-bench       # 10 场景 + 指标
```

### 5.3 验收标准

| 验收项 | 标准 |
|---|---|
| VerbatimDupHOLD | 两个代理不会先后发布字面相同内容 |
| TriageGate ▸YOU | 用户 @mention 一个代理，只有该代理回复 |
| TriageGate 多 mention | 用户 @mention 多个代理，所有被 mention 的代理回复 |
| TriageGate 传递抑制 | `<pass/>` 条目不触发其他代理 fire（除非有新用户消息或 nudge） |
| StallPipeline | 对话停滞后注入 system nudge，代理恢复 |
| StallPipeline 衰退上限 | nudge 不产生内容后停止，不无限推送 |
| 防御层可切换 | UI checkbox 可关闭各层，关闭后对应缺陷重现 |
| 向后兼容 | 默认全开，现有群聊体验不退化 |

## 6. Go 引擎到 JS 的映射对照

| Go 引擎 (`engine.go`) | JS (`pg-autochat.js`) | 说明 |
|---|---|---|
| `FreshnessGate` 字段 | `pgState.autoChat.freshnessGate` | JS 中由 `pgAutoChatDoSend` 的 perspective 重建 + `pgAutoChatOnFinish` 的重复检查覆盖 |
| `VerbatimDupHOLD` 字段 | `pgState.autoChat.verbatimDupHOLD` | `pgAutoChatOnFinish` 中追加前检查 `pgIsVerbatimDup` |
| `TriageGate` 字段 | `pgState.autoChat.triageGate` | `pgAutoChatProcessWindowInbox` 中 `shouldTriage` 检查 |
| `StallPipeline` 字段 | `pgState.autoChat.stallPipeline` | `pgAutoChatCheckAllDone` 中 nudge 注入 |
| `isMentioned()` | `pgIsMentioned()` | 词边界 @mention 匹配 |
| `anyAgentMentioned()` | `pgAnyAgentMentioned()` | 检查是否有任何代理被 @mention |
| `shouldTriage()` | `pgAutoChatProcessWindowInbox` 中的内联逻辑 | ▸YOU 路由 + actionability 检查 |
| `anyStalledAgentHasContent()` | JS 中不可实现（真实 LLM 无法预判） | 用衰退上限（被动等价物）替代 |
| `heldPasses` 不追加时间线 | 不适用（JS 无 HELD 重算） | — |
| `RunMultiTurn()` | `pgAutoChatUserSend()` 已支持多轮 | 用户发送消息时追加到时间线 |
| `maxStallNudges = 6` | `PG_MAX_STALL_NUDGES = 6` | 同一常量 |
| `stallNudge` 常量 | `PG_STALL_NUDGE` 常量 | 同一文案 |

## 7. 注意事项

1. **JS 无竞态模拟**：Go 引擎的批处理模型（所有代理同时计算）在 JS 中是真实异步（多个 `fetch()` 同时在途）。FreshnessGate 在 JS 中的等价物是 perspective 重建（已由 `pgAutoChatDoSend` 处理）+ VerbatimDupHOLD（阻止字面重复）。

2. **JS 无主动探针**：Go 引擎的 `anyStalledAgentHasContent`（探测代理是否会产生内容）在 JS 中不可实现（真实 LLM 无法预判）。用衰退上限（nudge 后无内容则停止）作为被动等价物。

3. **每代理探针的 JS 等价物**：Go 引擎在 `shouldTriage` 中调用 `Agent.Reply` 预判。JS 中，代理是真实 LLM，无法预判。等价物是：不重复触发已回复的代理（由 `autoChatDone` + `replyCount >= iterations` 覆盖）和不触发无未读的代理（由 `hasUnread` 覆盖）。

4. **向后兼容**：所有防御层默认 `true`。关闭后行为回退到当前实现。不破坏现有群聊体验。

5. **Director 集成**：停滞管线的 nudge 与 Director 的 `pgDirectorOnAgentReply` 不冲突。Director 评估是否需要旁白介入（叙事层面），停滞管线评估是否需要唤醒代理（协调层面）。两者可共存：Director 先评估（如果 in-flight 则等待），然后停滞管线检查。
