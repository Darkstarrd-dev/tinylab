# Web Hub（webhub）架构

> **模块定位：** 把「用户在浏览器里已登录的 AI 网页端」桥接为本项目可调用的 OpenAI 兼容 Provider。
> 与 Free Hub（jethub）**并列但机制不同**：jethub 是 **HTTP 协议桥**（有上游 API 端点，凭据可落盘）；webhub 是**浏览器页面驱动**（无 API 端点，靠 CDP 操作真实页面）。
>
> **上游参考：** `ref/universal-web-api`（UWA，AGPL-3.0，Python/FastAPI/DrissionPage，v3.0.0 @ `29d9685`）。**仅移植逻辑与规则数据，不使用 Python 技术栈**——Go 侧以 chromedp 直连 CDP 重新实现。
> 同步流程与待办见 [`webhub-upstream-sync.md`](webhub-upstream-sync.md)；执行历史（已归档）见 [`archive/webhub-migration-plan.md`](archive/webhub-migration-plan.md)。
>
> **P0 结论（2026-10-02，真机验证）：** 可行。真实 DeepSeek 站点端到端跑通（导航 → 登录态复用 → 输入 → 发送 → 增量监听 → 提取），两次独立运行可复现。
>
> **P1–P5 已收口（2026-10-02）：** `internal/webhub/` 核心包 + workflow 引擎 + Free Hub 内嵌 UI + registry 桥接全部实现，`{prefix}/{modelID}` 可经 `/v1/chat/completions` 调用（非流式 + 流式 e2e 均通），全程零 HTTP 出站。回归（go test/vet + webhub/jethub 前端套件）与文档收口完成，实施计划已归档、本文为正式基线。**唯一开放项：12 站点逐个真机验证（需登录态，§6 矩阵）**。
>
> **边界纪律：** `internal/proxy` **不 import webhub**，与 jethub 同款（AGENTS.md 红线）。桥接走窄接口注入，`APIType=="webhub"` 标记识别。
>
> **最后核对：** 2026-10-03（P1–P5 收口：核心包/workflow/UI/桥接落地 + 回归全绿 + 实施计划归档转正式基线；12 站点真机验证待登录态。10-02 回归修复：站点组幂等渲染、懒连接自愈 + Open Site 改 webhub 浏览器内开页 + `browserError` 透出——§2.2；10-03 缺陷 21 相对 `--user-data-dir` 静默失败 ⇒ 目录解析 absolutize + 启动诊断——§2.3；缺陷 22 流式回合 context 提前取消 ⇒ cancel 归属分流——§2.4；缺陷 23 FILL_INPUT 用错 PropertyDescriptor ⇒ 取 `.set` 再 call、缺陷 24 浏览器只由「打开站点」拉起（status/probe 纯报告）——§2.5）

---

## 1. 模块组成与边界

| 部分 | 位置 | 说明 |
|---|---|---|
| 核心 | `internal/webhub/` | 站点规则表（`sites.go` 生成）、workflow 引擎、浏览器会话管理、CDP 驱动、增量监听、模型 ID 映射、registry 桥接 |
| 规则生成 | `tools/gen-webhub-sites.go` | 一次性代码生成器：`ref/.../sites.json` → `internal/webhub/sites.go`（**禁止手工改产物**） |
| API | `internal/api/webhub/` | `/api/webhub/*` RPC：站点列表/状态/打开站点/前缀设置/就绪探针 |
| 前端 | `web/static/webhub.js` + `style-webhub.css` | **嵌在 Free Hub 页面内**（左侧分割线下方 + 右侧 pane），与 Free Hub 同入口（§3） |
| 装配 | `internal/app/app.go` + `bridge_augmenter.go` | Manager/Bridge 构造、浏览器连接生命周期、**双 Hub augmenter 派发**（§4.4） |

**与 jethub 的关键差异（决定全部设计）：**

| 维度 | jethub（HTTP 协议桥） | webhub（浏览器页面驱动） |
|---|---|---|
| 鉴权 | OAuth/设备码/扫码/API Key，凭据**可落盘** | **无编程式登录**——用户手动在浏览器登录，会话存于浏览器 profile |
| 出站 | 真实 HTTP 请求到上游端点 | **无端点**——CDP 操作页面，监听页面 DOM/网络 |
| 凭据存储 | `credentials.json`（AES-GCM） | **零凭据落盘**（登录态在浏览器 profile 目录） |
| 协议转换 | 逐 provider 协议桥（minimax Anthropic 等） | 无上游协议——页面侧只产出文本增量 |
| 并发 | 多账号轮询（rotation 复用） | **每站点单会话**（一个浏览器登录态），串行队列 |
| 失效模式 | 401/额度/限流 | **选择器腐烂**（站点改版）+ 登录过期 + 反自动化拦截 |

---

## 2. Why Go：P0 验证结论

P0 原型（`tmp/p0-webhub/`，gitignored）实测：

| 验证项 | 结果 |
|---|---|
| Chromium 发现 + 独立 profile 启动 + CDP 连接 | ✅ Chrome 141 |
| 登录态复用（复用 profile 目录） | ✅ 无需重新登录 |
| 站点选择器直接生效（`textarea` / `div.ds-markdown`） | ✅ 取自 `sites.json` 未修改 |
| 输入 prompt（31/39 字符） | ✅ 完整送达 |
| 增量监听 → SSE 增量输出 | ✅ 首字 858ms / 5.71s |
| 真实回复提取 | ✅ `P0-PROBE-OK`、`1, 2, 3, 4, 5, 6, 7, 8` |
| DOM 重写/回退 resync 守卫 | ✅ 对抗 fixture 验证 |

**依赖增量（实测）：** 直接 `github.com/chromedp/chromedp v0.16.0` +1；传递 `cdproto` / `sysutil` / `gobwas/ws`+`httphead`+`pool` / `go-json-experiment/json` / `golang.org/x/sys`(已有)。**实际编译进二进制 7 个模块**，纯 Go 无 cgo。

> ⚠️ `ledongthuc/pdf`、`orisano/pixelmatch` 在 go.sum 但**未被编译**（chromedp 的截图/PDF 子功能未用），实施时可裁剪。

### 2.1 P0 暴露的三个真实缺陷（实施必须规避）

1. **文本输入被吞**：`chromedp.SendKeys` 逐字符派发 key event，在 React 受控组件上丢失——31 字符只剩 `\n` 进框。
   **修法**：原生 value setter + `input`/`change` 事件 + **写入后校验**（`len(got) >= len(want)`，否则报错）。
2. **首字等待误判超时**：回复元素在模型开始回答前不存在，idle 倒计时提前起算 ⇒ 捕获 0 字符。
   **修法**：拆出独立的「等待首个内容」阶段（独立 `startTimeout`，不占 idle 预算）。实测第二次运行首字 5.71s（深度思考），**旧逻辑必然失败**。
3. **可选步骤耗尽全局超时**：`new_chat_btn` 点击失败吃掉整个 90s 预算。
   **修法**：所有 `optional:true` 步骤走**有界超时**（5s），失败仅 log 不返回错误。

> **P0 附带教训**：原型曾把非目标 tab（DSH GUI 的 `127.0.0.1:20199`）导航到 DeepSeek。**正式实现必须按域名精确匹配 tab，绝不复用非目标标签页**（§4.3）。

### 2.2 上线后用户实测回归（2026-10-02，两例 webhub 侧）

1. **站点组重复渲染**：保存前缀触发 `webhubRefresh` → `webhubRenderSiteGroup` 直接 `insertAdjacentHTML` 追加，而 `__jethubRenderProviders` 末尾也会调它 → 同一份站点组出现两份且状态同步。
   **修法**：渲染幂等化——插入前先移除旧 `[data-webhub-row]` 节点（分割线 + 行都带标记）；删除 `webhubSelect`/`webhubRefresh` 里对它的直接调用（jethub 渲染器已含）。回归守卫：`web/webhub.test.js`（连续渲染/选择/刷新后分割线必须恰一份）。
2. **Site Status 永不 connected/attached**：启动时一次性 `Connect` 失败后**永不重试**（端点永远为空），且「打开站点」开在**系统浏览器**——既无 CDP 端点、profile 也不同，登录态落不进 webhub profile。
   **修法**：① 懒连接自愈 `Manager.EnsureBrowser`（单飞 + 3s 节流；status/open/probe 都先调）；② `Manager.ResolveSite` 在 status 时 rescan：端点失效即清空重连、发现站点 tab 即附着（绝不复用非目标 tab）；③ `SessionManager.OpenTab`——「打开站点」改为在 **webhub 浏览器**内开站点标签页（持久 profile，登录一次跨进程存活）；④ status 响应新增 `browserError`，页面把「浏览器起不来」的原因直接写出来（页面可排障）。
   真机复验：状态首查失败 → 恢复浏览器后 status 返回 `connected:true`；open 后 status 返回 `attached:true` + 站点 tab URL。

> 关联（jethub 侧同日回归）：`SyncKeys` 的 DeleteProvider+AddProvider 刷新窗口触发 registry sweep，把 combo/quickslot 里的 `{prefix}/{model}` 引用清掉（用户实测：combo 里 FreeHub 模型重启后消失）。修法见 [`jethub-architecture.md`](jethub-architecture.md) 缺陷 17 与 `Registry.UpsertProvider`。

### 2.3 缺陷 21（2026-10-03 用户实测）：相对 `--user-data-dir` ⇒ Chrome 静默失败

- **现象**：Web Sites 点击后右侧详情不渲染、每次点击弹一个空浏览器窗口、多击卡顿，日志恒为 `browser unavailable: webhub: devtools not ready on port 9333 after 20s`。
- **根因**：app 以**相对 configDir** 启动时（双击启动、config 发现基于进程 CWD 的部署形态），`ResolveWebHubDir`/`ResolveProfileDir` 把 `webhub\webhub\profile` 这样的**相对路径**原样拼进 Chrome 命令行。Chrome 141 对相对 `--user-data-dir` **静默失败**：stub 进程 ~60ms 退出码 0、零 stderr、profile 不创建、调试端口不绑定——外部表现就是 20s 超时，且每次 status/open 重试再弹一次窗口。
- **修法**：① `config.ResolveWebHubDir` 与 `webhub.ResolveProfileDir` 结果一律 `filepath.Abs`（回归守卫 `TestResolveProfileDirAlwaysAbsolute`）；② `Launch` 增加诊断：启动即失败的 browser 进程会捕获 pid/退出码/**stderr 尾行**（`--enable-logging=stderr`），失败错误从「not ready after 20s」变成能直接看到 Chrome 自述原因的一行；隔离实例带凭据复现 → 修复后启动 1s 内 `browser launched on :9333`，status `connected:true` → open → `attached:true`。

### 2.4 缺陷 22（2026-10-03 用户实测）：流式回合的 context 被提前 cancel

- **现象**：站点已 `connected/attached`，但一次调用只吐出首帧 role chunk，紧接着 `{"error":{"message":"context canceled"}}`（**0.2s 内失败**，根本没碰到页面）。
- **根因**：`Bridge.InterceptResponse` 用 `defer cancel()`，而流式路径启动 `streamTurn` goroutine 后**立即返回** pipe reader——cancel 在返回瞬间生效，goroutine 里 driver 的第一次页面/CDP 读取就命中已取消的 ctx（`Chat` → `sessions.Open` → `FindTab` 首帧即死）。客户端看到的正是「role 帧 + error 帧」。
- **修法**：**cancel 归属分流**——非流式 `Chat` 是同步调用，保持 `defer cancel()`；流式把 cancel 交给 goroutine（`go func(){ defer cancel(); b.streamTurn(...) }()`），回合结束才取消。客户端断连仍由父 ctx 传播，不会泄漏。
- **回归守卫**：`internal/webhub/customize_cancel_test.go` 2 个（流式回合的 ctx 必须活过 `InterceptResponse` 返回 / 非流式必须在返回时取消不泄漏）。**已反向验证**：回退修复后第一条立刻报 `turn context already dead … context canceled`。
- **A/B 真机复验**（同一 scratch 目录 + 同一份登录 profile，只换二进制）：修复前 `list targets: … dial tcp 127.0.0.1:9333: operation was canceled`；修复后进入真实页面流程，报 `FILL_INPUT: no element matches "textarea"`（该副本 profile 停在 `/sign_in`，属预期）——即回合已真正进入驱动阶段。

### 2.5 缺陷 23 + 24（2026-10-03 用户实测）：value setter 误用 + 启动即弹浏览器

1. **FILL_INPUT 全站崩溃（缺陷 23）**：注入脚本把 `Object.getOwnPropertyDescriptor` 返回的 **PropertyDescriptor** 当函数调（`setter.call(el, text)`）——真实页面抛 `TypeError: setter.call is not a function`，deepseek/arena.ai 等**所有** textarea/input 站点在第一步就死。修法：取描述符的 `.set` 再 call（`setter.set.call(el, text)`）。守卫：`TestFillInputVerifiesWrite` 静态断言脚本形状 + fakePage **按脚本形状拒绝**旧写法（回归立刻红，而非假装写入成功）；真机复验：在验证实例打开的真实 React 页（`/sign_in` 的 input）上 `FILL-OK`。
2. **启动即弹浏览器（缺陷 24，用户要求的行为契约）**：app 启动路径调了 `EnsureBrowser` ⇒ Chrome（连空白页）自动弹出；status 的惰性重连也会「看一眼状态」就拉起浏览器。修正：**浏览器实例只由用户点「打开站点」（`POST /api/webhub/sites/{site}/open`）触发**——① 删除启动路径的 `EnsureBrowser`；② `ResolveSite`（status 用）改为**纯报告**：端点为空/失效 ⇒ 清空并报 `connected=false`，绝不重连；③ probe 同样不启动，浏览器未连接时直接 503（UI 提示先打开站点）。守卫：`TestResolveSiteNeverLaunchesBrowser` + `TestResolveSiteAttachesOwnTabOnly`（webhub 层）+ `TestStatusAndProbeNeverLaunchBrowser`（HTTP 层，反向验证过）。`EnsureBrowser` 现在只有 `openSite` 一个调用点。

---

## 3. Free Hub 页面内的 UI（Settings 内嵌，与 jethub 同入口）

### 3.1 入口与挂载

- **入口**：Settings 侧边栏 `Free Hub` 行（`settings.js` `#free-hub-entry`）→ `openFreeHub()` 打开的区域**内部**，不新增侧边栏行。
- **左侧 provider 列表加分割线**：
  ```
  ┌─ Free Hub 左侧 pane ─────────┐
  │ ● codearts      (账号桥接)   │   ← jethub provider 组（13 个）
  │ ● qoder                      │
  │ ● minimax                    │
  │ ──────────────────────────── │   ← 分割线（.free-hub-divider）
  │ ○ chat.deepseek.com          │   ← webhub 站点组（可用站点）
  │ ○ chatgpt.com                │
  │ ○ claude.ai                  │
  └─────────────────────────────┘
  ```
  - 分割线上方 = **jethub provider**（HTTP 协议桥，凭据可落盘）
  - 分割线下方 = **webhub 站点**（本项目可用、浏览器驱动的站点）
  - 两组共用同一单选态与选中样式；徽标显示状态而非账号数（webhub 无"账号"概念）：`未启用` / `未连接` / `已就绪` / `未登录`
- `closeFreeHub()`、`navigateTo` 切页清理、陈旧 active 重入兜底：**完全复用 jethub 现有机制**（`jethub.js:24/60`）。

### 3.2 右侧 pane（保留 call prefix 模式）

| 区 | 内容 |
|---|---|
| ① **调用前缀** | 与 jethub 同款 `PUT/DELETE /api/webhub/{site}/prefix`，`[a-z0-9-]{1,32}`，冲突 409 |
| ② **站点状态** | 浏览器连接（懒连接自愈：status 时 `EnsureBrowser`/`ResolveSite` 重连 + rescan 附着）· 登录态 · 就绪标记 · 上次成功时间 · 起不来时直接显示 `browserError` |
| ③ **操作按钮行** | 打开站点（**webhub 浏览器内**开站点标签页，供用户在持久 profile 里登录）/ 检测就绪 / 停用 / 移除前缀 |
| ④ **模型 ID 列表** | 该站点暴露的 `{prefix}/{modelID}` 串，点击复制 |
| ⑤ **通知区** | tone + 逐条 details（复用 jethub 通知区） |

**不做**：账号卡（无账号概念）、积分/签到（无 API）、限流重测/重置（不适用）、备份导出（零凭据）。

### 3.3 模型 ID 设计（prefix 之后的内容）

UWA 的模型 ID 机制（`app/utils/model_routing.py`）：**站点域名即 ID**，并派生别名。

```
chat.deepseek.com  →  chat.deepseek.com, deepseek
gemini.google.com  →  gemini.google.com, gemini.com, gemini
```

本项目的 `{prefix}/{modelID}` 形态：

| modelID | 语义 |
|---|---|
| `<domain>` 全名 | 显式路由，如 `chat.deepseek.com` |
| `<短别名>` | 域名派生的别名，如 `deepseek`（UWA `_build_model_id_candidates` 同款派生） |
| `<domain>/<preset>` | 指定预设（多预设站点：gemini 4 个、qwen 3 个、doubao 2 个、arena 12 个） |

⚠️ arena.ai 有 12 个预设，模型 ID 空间需按预设展开——实施时按 UWA `collect_route_domain_models` 的 `route_type=preset` 语义对齐。

---

## 4. 调用桥接

### 4.1 注册形态

`Bridge.SetPrefix` 复用 jethub 机制，注册 `config.Provider`：

- `ID = webhub-{site}`（如 `webhub-chat.deepseek.com`）
- `Prefix` = 用户前缀
- `APIType = "webhub"`
- `Models` = 该站点的模型 ID 列表
- `Keys` = **单条合成 Key**（无凭据语义，仅用于 rotation 计数与用量归属；Key 值恒定，不参与任何出站鉴权）

⚠️ **BaseURL 不适用**：webhub 无 HTTP 端点。出站由 `RequestCustomizer.Customize` 拦截——请求不发出，转为**驱动浏览器页面**并等待结果，再把文本包装成 OpenAI 响应体返回。这是与 jethub 最本质的差异。

### 4.2 请求流程

```
POST /v1/chat/completions  model={prefix}/{modelID}
  → handleProxy → GetProviderByPrefix → forwardWithRetry
  → Customize（webhub）：识别 APIType=webhub
      ├─ 取 messages → 拼 prompt（UWA prompt_padding/context 规则）
      ├─ 串行队列取该站点会话（单会话，§4.3）
      ├─ workflow 引擎执行（FILL_INPUT → KEY_PRESS → STREAM_WAIT）
      └─ 增量监听 → 文本累积
  → 包装为 OpenAI 响应体（非流式：一次性；流式：逐 delta 刷 SSE）
```

### 4.3 会话与并发（关键约束）

- **每站点单会话**：一个浏览器登录态只能同时服务一个对话 ⇒ 该站点的请求进**串行队列**（FIFO），并发请求排队。
- **tab 精确匹配**：按域名匹配已打开的 tab；**绝不复用/导航非目标 tab**（P0 事故）。
- **就绪判据**：UWA 无「已登录」探针 ⇒ 以「该域名 tab 存在 + 输入框可见 + 探针消息成功」近似。
- **失效表现**：登录过期/选择器失效表现为**推理报错或空回复** ⇒ 页面须给出明确排障指引（§3.2 状态区）。

---

## 5. 站点规则与 workflow 引擎

### 5.1 规则是数据，不是代码

`config/sites.json`（271KB）里 12 个站点的行为全是**声明式 JSON**：

```json
{"action":"GROUP","label":"发送并读取回复","value":{"steps":[
  {"action":"FILL_INPUT","target":"input_box"},
  {"action":"KEY_PRESS","target":"Enter"},
  {"action":"STREAM_WAIT","target":"result_container"}]}}
```

⇒ 移植 = **搬数据 + 重写解释器**。每站点 3.8–63KB（gemini 30KB、arena 63KB）。

### 5.2 动作集（UWA 全集 → P0 已验证子集）

| 动作 | P0 | 说明 |
|---|---|---|
| `CLICK` | ✅ | 点击（`optional:true` 走有界超时） |
| `FILL_INPUT` | ✅ | 填输入框（**原生 setter + 事件，非 SendKeys**，§2.1-1） |
| `KEY_PRESS` | ✅ | 按键（Enter） |
| `STREAM_WAIT` | ✅ | 增量监听（DOM 模式） |
| `GROUP` | 部分 | 步骤分组 |
| 其余（上传/脚本/条件/等待元素等） | ❌ | 实施期按需 |

### 5.3 双通道监听模式

| 模式 | 机制 | 适用 |
|---|---|---|
| **DOM**（P0 已验证） | 轮询结果容器 + 前缀 diff + resync 守卫 | **所有站点通用兜底** |
| **network** | CDP `Network` 域拦截 + 逐站点 SSE 解析器 | 优化项：更低延迟 + 分离 thinking 流 |

DeepSeek 预设 `stream_config.mode = "network"`（`listen_pattern: api/v0/chat/completion`，parser `deepseek`）。**P0 用 DOM 模式即跑通** ⇒ DOM 是可行基线，network 留作 P1+ 优化。

---

## 6. 站点矩阵

| 站点 | 预设数 | P0 | 备注 |
|---|---|---|---|
| chat.deepseek.com | 1 | ✅ 真机验证 | network 模式 + DOM 兜底 |
| chatgpt.com | 1 | 待验 | |
| claude.ai | 1 | 待验 | |
| gemini.google.com | 4 | 待验 | 多预设 |
| www.doubao.com | 2 | 待验 | 多预设 |
| chat.qwen.ai | 3 | 待验 | 多预设 |
| www.kimi.com | 1 | 待验 | |
| grok.com | 1 | 待验 | |
| aistudio.google.com | 1 | 待验 | |
| aistudio.xiaomimimo.com | 1 | 待验 | |
| chatglm.cn | 1 | 待验 | |
| arena.ai | 12 | 待验 | 盲测对比，模型 ID 空间最大 |

---

## 7. 风险与边界

1. **选择器腐烂**：站点改版即失效 ⇒ 周期性同步（见 sync 文档 SOP）。
2. **反自动化**：页面驱动比 API 更易被检测/限流；限个人调试用途，高频不可用。
3. **浏览器依赖**：需系统 Chromium（P0 实测本机已有 Chrome 141 + Edge 154，无需下载）。
4. **AGPL-3.0**：移植**逻辑与规则数据**（非复用代码），且 UWA 作为 gitignored ref 不纳入构建 ⇒ 风险显著低于打包源码。**最终需法务确认**（本项目无法自决）。
5. **并发受限**：每站点单会话串行，吞吐远低于 jethub 的多 Key 轮询。

---

## 8. 变更维护清单

改动本模块时**同一次改动内**同步：

| 改动 | 同步 |
|---|---|
| 新增/修改站点规则 | 本文 §6 矩阵 + `internal/webhub/sites*.go` |
| 修改 workflow 动作 | 本文 §5.2 + `internal/webhub/workflow.go` |
| 修改监听模式 | 本文 §5.3 + `internal/webhub/stream*.go` |
| 修改 UI（分割线/前缀/状态） | 本文 §3 + `web/static/webhub.js` + `jethub.js`（入口耦合） |
| 修改模型 ID 派生 | 本文 §3.3 + `internal/webhub/modelid.go` |
| 依赖版本变动 | 本文 §2 + `go.mod` |
| 站点可用性/规则变化 | `webhub-upstream-sync.md` §6/§7 |
| 任何结构变化 | PROJECT_MAP（§13o / §10.29 / §24） |
