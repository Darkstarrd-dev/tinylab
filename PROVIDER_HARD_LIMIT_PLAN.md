# 执行文档：Provider Hard Limit（RPM/TPM 自动节流）

> 本文档为自足执行规格：执行者无需对话上下文，按顺序自上而下执行即可完成。
> 工作目录：`C:/opencode/tinyrouter`。文档内所有行号来自本次勘察时的 read 快照标签（如 `#55DC`），执行前必须重新 read 对应文件确认。

---

## 1. 背景与目标

在 settings → provider card → provider detail → **Edit Provider** 表单中新增 Hard Limit 设置：

- **RPM**（每分钟请求数）与 **TPM**（每分钟 token 数）两个维度，各自独立启用/关闭开关。
- 启用后，代理在该 provider 的上游请求发出前自动插入等待，避免触发站点限流（例：站点限 5 req/min 时，连发的请求被自动错开约 12s 发送）。
- **自适应而非固定间隔**：采用滑动 60s 窗口。零散使用时窗口内计数不足 → 零等待；只有窗口饱和（短时间连发）才产生延迟。
- **两限制协调**：同时启用时取二者所需等待的最大值，单条事件同时计入两个窗口维度，一次等待即满足两个约束。

### 设计核心：滑动窗口 + 发送前预留 + 完成后对账

- 每次真正发往上游的尝试（含重试 attempt）向该 provider 的窗口写入一条事件：`{reqID, 发送时刻 at, token 预留估值}`。
- 新请求到达时：若窗口内请求数 ≥ RPM → 等到最旧事件过期；若 token 总和 + 本次估值 > TPM → 从最旧事件起累加至溢出点，等到该事件过期。取两者 max。
- 请求完成时，用上游回报的实际 token 数（input+output）替换该请求的预留估值（对账）。失败响应通常报 0 token → 对账为 0 即释放窗口空间，行为正确。

### 已确认的关键事实（本会话勘察所得）

| 事实 | 来源 |
|---|---|
| NIM min_interval 是 per-key 固定间隔节流，语义不同，不复用；但其在 forward 循环中的插入位置正是本功能的插入点 | `internal/proxy/forward_retry.go` #55DC line 101–112 |
| `recordUsage(id, provider, model, sel *rotation.SelectedKey, ...)` 是流式/非流式共用的完成提交点，携带实际 inputTokens/outputTokens 与 `sel.Provider.ID` | `internal/proxy/recorder.go` #6ABD line 64 |
| 输入 token 粗估先例：`len(bodyBytes) / 4`（processingEntry.InputTokens 同款） | #55DC line 167 |
| `UpdateProvider` 是**显式字段逐个合并**——漏加字段 = 前端保存静默丢失 | `internal/registry/providers.go` #98C5 line 79–91 |
| 前端编辑表单整卡重建于 `showEditProvider`，保存走 `apiPut('/providers/'+id, p)` 全量 DTO 回传 | `web/static/providers.js` #9243 line 1725–1832 |
| ProviderDTO 也是显式映射；详情接口回传什么决定表单能回显什么 | `internal/api/providers/register.go` #3604 line 51–84 |
| Handler 既有 concrete 字段先例（`EntryTracker *EntryTracker`），limiter 不读配置（调用侧已持 cfgProvider），无需新 interface | `internal/proxy/handler.go` #BE84 line 19–69 |
| 浏览器工具在本机不可用，UI 行为验证走 API 往返 + JS 语法检查 | 会话环境约束 |

---

## 2. 实施步骤

按顺序执行；步骤 1→2→3→4 为后端依赖链（每步后可编译），步骤 5 前端独立，步骤 6 测试收尾。

### 步骤 1：配置类型与校验（`internal/config/types.go`、`validate.go`）

1.1 在 `types.go` 的 `NIMSettings` 类型定义附近新增类型：

```go
// HardLimitSettings enables provider-level outbound rate limiting over a
// sliding one-minute window. RPM caps upstream send count per window; TPM caps
// estimated+actual tokens per window. Each axis toggles independently; when
// both are active the longer computed wait wins.
type HardLimitSettings struct {
	RPMEnabled bool `yaml:"rpmEnabled" json:"rpmEnabled"`
	RPM        int  `yaml:"rpm,omitempty" json:"rpm,omitempty"`
	TPMEnabled bool `yaml:"tpmEnabled" json:"tpmEnabled"`
	TPM        int  `yaml:"tpm,omitempty" json:"tpm,omitempty"`
}
```

1.2 `Provider` struct 中 `NIMConfig *NIMSettings` 字段（#F247 line 129）之后追加：

```go
	HardLimit *HardLimitSettings `yaml:"hardLimit,omitempty" json:"hardLimit,omitempty"`
```

指针 + omitempty ⇒ 旧 config.yaml 无需迁移代码。

1.3 `validate.go` 的 `validateProviders`（#D9ED line 52 起）循环体内追加告警（与现有 warning 打印风格一致）：

```go
if p.HardLimit != nil {
	if (p.HardLimit.RPMEnabled && p.HardLimit.RPM < 1) || (p.HardLimit.TPMEnabled && p.HardLimit.TPM < 1) {
		fmt.Fprintf(os.Stderr, "[config] warning: provider %q hard limit enabled but rpm/tpm invalid (<1), engine will ignore it\n", p.Name)
	}
}
```

### 步骤 2：节流引擎（新建 `internal/proxy/hardlimit.go`）

无等价现成实现，新建。完整签名契约：

```go
package proxy

const defaultHLWindow = time.Minute

type hlEvent struct {
	reqID  string
	at     time.Time // 计划/实际发送时刻（now+wait）
	tokens int       // 预留估值；完成后 Reconcile 替换为实际值
}

type HardLimiter struct {
	mu      sync.Mutex
	windows map[string]*hlWindow // key: provider ID
	window  time.Duration        // 默认 defaultHLWindow；测试注入短窗口
}

// WaitAndReserve computes the wait required so that this send keeps both limits
// (send count in window < rpm when rpm > 0; token sum in window + estTokens <= tpm
// when tpm > 0), sleeps that duration honouring ctx, then inserts ONE reservation
// event at now+wait. Returns true on success; false if ctx was canceled while
// waiting — in that case no reservation is inserted.
func (l *HardLimiter) WaitAndReserve(ctx context.Context, providerID, reqID string, rpm, tpm, estTokens int) bool

// Reconcile replaces the token estimate of the most recent unexpired event
// matching reqID with actualTokens, adjusting the window sum by the delta.
// No-op if no matching unexpired event exists.
func (l *HardLimiter) Reconcile(providerID, reqID string, actualTokens int)

func NewHardLimiter() *HardLimiter // window: defaultHLWindow, windows: make(map...)
```

实现规则（全部锁内完成）：

- 每次操作先淘汰 `at <= now-window` 的事件并同步扣减 sum（events 按 at 升序存储，从头淘汰）。
- RPM 等待：`rpm > 0 && len(events) >= rpm` → `events[0].at.Add(window).Sub(now)`。
- TPM 等待：`overflow := sum + estTokens - tpm`；`overflow > 0` 时从最旧事件起逐条累加 tokens 直到累计 ≥ overflow，等待时刻 = 该事件 `.at.Add(window)`。
- 最终 `wait = max(rpmWait, tpmWait)`；插入 `hlEvent{reqID, now.Add(wait), max(estTokens, 0)}` 保持升序（锁内串行保证）；sum 加上估值。estTokens ≤ 0 也照常插入（tokens 记 0，仍计请求数）。
- ctx 取消：select `<-ctx.Done()` 返回 false，不插入事件。
- 内存态，不持久化（与 Usage 统一同策略，重启清零）。

### 步骤 3：Handler 接线（`internal/proxy/handler.go`）

3.1 `Handler` struct 增加 concrete 字段（放在 `EntryTracker` 旁）：`hardLimit *HardLimiter`。

3.2 `New(...)` 初始化块中加 `hardLimit: NewHardLimiter(),`。

### 步骤 4：发送路径集成与对账钩子

4.1 `internal/proxy/forward_retry.go`：在 NIM min_interval 块（重新 read 定位，勘察时为 #55DC line 101–112）**之前**插入同级块（同一位置语义：重试循环内、SelectKey 成功后、构造 upstream body 前 —— 只有真正发往上游的尝试才计数，重试每个 attempt 各计一次，符合上游限流真实语义）：

```go
		// Provider hard limit: sliding-window RPM/TPM throttling before send.
		if cfgProvider != nil && cfgProvider.HardLimit != nil {
			hl := cfgProvider.HardLimit
			var rpm, tpm int
			if hl.RPMEnabled && hl.RPM > 0 {
				rpm = hl.RPM
			}
			if hl.TPMEnabled && hl.TPM > 0 {
				tpm = hl.TPM
			}
			if rpm > 0 || tpm > 0 {
				est := len(bodyBytes) / 4 // same rough estimate as processingEntry.InputTokens
				if !h.hardLimit.WaitAndReserve(r.Context(), providerID, reqID, rpm, tpm, est) {
					h.logger.Debug("[%s] client canceled during hard-limit wait", logTag)
					return false, ""
				}
			}
		}
```

作用域核对：`reqID`、`bodyBytes`、`cfgProvider`、`logTag` 在该点均已在用（processingEntry 构造处同用 reqID 与 `len(bodyBytes)/4`）。bodyBytes 可能为 nil（测试程序化调用）→ len(nil)=0 安全。

4.2 `internal/proxy/recorder.go` `recordUsage`（#6ABD line 64 起）函数体末尾追加：

```go
	h.hardLimit.Reconcile(sel.Provider.ID, id, inputTokens+outputTokens)
```

多 attempt 请求只更新最后一条匹配 reqID 的事件（Reconcile 规则如此），先前 attempt 维持输入估值直至过期。

### 步骤 5：API/DTO/前端

5.1 `internal/api/providers/register.go`：
- `ProviderDTO` 增加字段（`NIMConfig` 之后）：`HardLimit *config.HardLimitSettings \`json:"hardLimit,omitempty"\``
- `toProviderDTO` 映射加：`HardLimit: p.HardLimit,`
- `updateProvider` 无需改动（解码进 config.Provider）。

5.2 `internal/registry/providers.go` `UpdateProvider` 显式合并清单（#98C5 line 91 `CustomHeaders` 之后）追加一行：

```go
			r.config.Providers[i].HardLimit = updates.HardLimit
```

**漏加此行 = 前端保存静默丢失，必查。**

5.3 `web/static/providers.js` `showEditProvider`（#9243 line 1725–1792）：函数开头 `var sticky = ...` 后加 `var hl = p.hardLimit || {};`；在 useCustomHeaders 组（line 1774–1786）之后、`form-footer-actions`（line 1787）之前插入：

```js
      '<div class="form-group mb-16">\
        <div class="form-group-label-wrap">\
          <label style="margin:0">' + t('hardLimit') + '</label>\
          <span class="form-hint" style="margin:0">' + t('hardLimitDesc') + '</span>\
        </div>\
        <div class="form-group-inline" style="margin-top:8px;margin-bottom:8px">\
          <label style="margin:0;min-width:180px">' + t('hardLimitRPM') + '</label>\
          ' + renderStepperHtml('ep-hl-rpm', hl.rpm || 0, 0, 1000000, 1, 'max-width:140px;') + '\
          <label class="toggle-switch" for="ep-hl-rpm-enabled" style="flex-shrink:0;margin-left:12px">\
            <input type="checkbox" id="ep-hl-rpm-enabled" ' + (hl.rpmEnabled ? 'checked' : '') + '>\
            <span class="toggle-slider"></span>\
          </label>\
        </div>\
        <div class="form-group-inline" style="margin-bottom:0">\
          <label style="margin:0;min-width:180px">' + t('hardLimitTPM') + '</label>\
          ' + renderStepperHtml('ep-hl-tpm', hl.tpm || 0, 0, 100000000, 100, 'max-width:140px;') + '\
          <label class="toggle-switch" for="ep-hl-tpm-enabled" style="flex-shrink:0;margin-left:12px">\
            <input type="checkbox" id="ep-hl-tpm-enabled" ' + (hl.tpmEnabled ? 'checked' : '') + '>\
            <span class="toggle-slider"></span>\
          </label>\
        </div>\
      </div>' + \
```

（拼接进现有大字符串字面量，注意续行反斜杠风格与上下文一致；stepper/toggle 复用本表单已有模式：stepper 先例 line 1772 `r-sticky`，toggle 先例 line 1746–1749 `ep-useproxy`。若 renderStepperHtml 不接受步长参数形式，read 其定义后按真实签名调整。）

5.4 `saveEditProvider`（line 1794–1810）：在 `p.stickyLimit = ...` 之后、required 校验之前追加：

```js
  var rpmOn = document.getElementById('ep-hl-rpm-enabled').checked;
  var tpmOn = document.getElementById('ep-hl-tpm-enabled').checked;
  p.hardLimit = {
    rpmEnabled: rpmOn,
    rpm: parseInt(document.getElementById('ep-hl-rpm').value) || 0,
    tpmEnabled: tpmOn,
    tpm: parseInt(document.getElementById('ep-hl-tpm').value) || 0
  };
  if (!rpmOn && !tpmOn) p.hardLimit = null;
```

双开关全关置 null → 后端存 nil → config.yaml 不落该字段。

5.5 `web/static/i18n.js`：en 区（勘察时 ~line 73）与 zh 区（~line 880）各加 4 个 key：

| key | en | zh |
|---|---|---|
| `hardLimit` | `'Hard Limit'` | `'硬性限流'` |
| `hardLimitDesc` | `'Provider-level sliding-window rate limiting. Requests are only delayed when the last-minute window is saturated; sporadic use is never delayed. When both RPM and TPM are enabled, the longer wait applies.'` | `'站点级滑动窗口限流：仅当最近一分钟窗口饱和时才延迟发送请求，零散使用零延迟。RPM 与 TPM 同时启用时取等待较长者。'` |
| `hardLimitRPM` | `'RPM (requests/min)'` | `'RPM（次/分钟）'` |
| `hardLimitTPM` | `'TPM (tokens/min)'` | `'TPM（token/分钟）'` |

### 步骤 6：单元测试（新建 `internal/proxy/hardlimit_test.go`）

全部用注入的短 `window`（如 200ms）避免慢测试。用例清单：

1. **零散使用零等待**：rpm=5，两次 Reserve 间隔 > window → 均 wait==0（返回 true 且未阻塞）。
2. **连发节流**：rpm=2，连续 3 次 Reserve → 第 3 次 wait>0 且 ≈ window 减去已耗时间（容差断言）。
3. **TPM 单独生效**：tpm=100，est=60 连发两次 → 第 2 次 wait>0；Reconcile 小实际值（如 10）后第 3 次 est=60 wait 归零。
4. **双限制协调取 max**：构造 rpm 等待 < tpm 等待的用例，断言 wait == tpm 等待值；再反转验证。
5. **取消**：预填满窗口使 wait 长，ctx 提前 cancel → 返回 false，且后续 Reserve 的 wait 未因被取消请求变长（事件未入窗）。
6. **并发安全**：8 goroutine 并发 Reserve 同一 providerID，断言窗口事件数 == 8 且无 panic；`go test -race` 下通过。

---

## 3. 文档同步（AGENTS.md 强制，随代码同轮完成）

1. `PROJECT_MAP.md`：internal/proxy 包文件清单加入 `hardlimit.go`（一句话职责：provider 级滑动窗口 RPM/TPM 发送前节流引擎）。
2. `docs/proxy-architecture.md`：调用链章节补“发送前 hard-limit 节流”步骤（锚定 forward_retry.go 插入块与 recorder.go 对账钩子）；“变更维护清单”加一行。
3. `docs/config-registry-state-architecture.md`：Provider 字段归属清单记入 `hardLimit`（YAML 键 `hardLimit`，指针可选，内存态窗口不持久化）。

---

## 4. 验证步骤（命令级）

前置：仓库根 `C:/opencode/tinyrouter`；Go 1.25+；node 可用。

1. 编译与静态检查：
   ```
   go build ./...
   go vet ./internal/proxy/
   ```
2. 单测（含 race）：
   ```
   go test ./internal/proxy/ ./internal/config/ ./internal/registry/ -race
   ```
3. API 往返冒烟（浏览器不可用，勿用 curl 发 JSON——Git Bash 会损坏 body，用 python urllib）：
   - hub 启动服务进程（`go run .` 或已构建二进制）；
   - python urllib `PUT /providers/{id}`，body 含 `"hardLimit":{"rpmEnabled":true,"rpm":5,"tpmEnabled":false,"tpm":0}` → 断言响应 JSON 回读 `hardLimit.rpmEnabled==true`；
   - 打开 `config.yaml` 确认对应 provider 下持久化 `hardLimit:` 节点；
   - 再 PUT 双开关关闭（hardLimit 为 null 或 `{rpmEnabled:false,...}`）→ config.yaml 中该 provider 的 hardLimit 字段消失。
4. 前端语法：`node --check web/static/providers.js && node --check web/static/i18n.js`
5. 节流行为证明（机制级，由单测承担）：步骤 6 用例 2/3/4 通过即为行为证据；如本地有可用 provider+key，可另配 rpm=5 后快速连发 6 条 `/v1/chat/completions`，观察 console 日志 SEND 时间戳呈约 12s 间隔（可选，不作门槛）。

---

## 5. 审核通过条件（全部满足方可交付）

| # | 条件 | 证明物 |
|---|---|---|
| A1 | Edit Provider 表单显示 Hard Limit 区块，RPM/TPM 各有独立开关与数值输入，保存后重开表单数值与开关状态正确回显 | providers.js 代码 + API 回读 DTO 含 hardLimit |
| A2 | 双开关全关保存后，config.yaml 中该 provider 无 hardLimit 字段；开启任一开关保存后字段持久化且值正确 | config.yaml diff |
| A3 | rpm=5 配置下，模拟连发第 3+ 请求被延迟（单测用例 2 通过）；间隔超过窗口的请求零延迟（用例 1 通过） | `go test -race ./internal/proxy/` 全绿 |
| A4 | TPM 单独启用生效（用例 3）；RPM+TPM 同时启用取更长等待（用例 4） | 同上 |
| A5 | 请求完成后实际 token 数替换估值并影响后续等待（用例 3 Reconcile 断言）；客户端取消等待不残留窗口事件（用例 5） | 同上 |
| A6 | 并发安全：`-race` 下并发 Reserve 用例通过 | 测试输出 |
| A7 | 重试 attempt 计数语义正确：每次实际上游发送各占一个窗口名额，失败 attempt 的预留自然过期或对账为 0 | forward_retry.go 插入块位于发送前循环内 + 用例覆盖 |
| A8 | 旧 config.yaml（无 hardLimit 字段）加载不受影响；`go build ./...` 通过 | 构建输出 + 加载日志无告警 |
| A9 | 三份文档（PROJECT_MAP.md、proxy-architecture.md、config-registry-state-architecture.md）已同步更新锚点 | 文档 diff |
| A10 | 无遗留死代码/兼容别名；`go vet ./internal/proxy/` 干净 | vet 输出 |

## Assumptions（用户可推翻的默认决策）

- **作用域 = provider 级**（该站点所有 key、所有模型共享窗口）——“某个站点要求 5 request/min” 按站点整体理解。若实为 per-key，后续可在 `WaitAndReserve` 增加 key 维度扩展，本次不做。
- **TPM 预发估值只算输入侧**（`len(body)/4`，沿用现有粗估先例），完成后以实际 input+output 对账；突发大量输出可能在完成前短暂低估，属可接受误差。
- 窗口运行态不持久化，重启清零（与 Usage 统一同策略）。
