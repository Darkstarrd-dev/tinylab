# Web Hub 移植实施计划（universal-web-api → TinyLab）

> **文档性质：** 实施计划（**入口文档**）。执行从 P1 开始，逐阶段勾销；完成后本文归档，架构基线转 [`webhub-architecture.md`](../webhub-architecture.md)，周期性同步转 [`webhub-upstream-sync.md`](../webhub-upstream-sync.md)。
>
> **上游：** `ref/universal-web-api`（gitignored 只读副本，允许 `git fetch`/`git checkout`，**禁止手工编辑**），origin `https://github.com/lumingya/universal-web-api.git`。当前 pin `29d9685`（v3.0.0，2026-09-25）。
>
> **核心决策：** **仅移植逻辑与规则数据，不使用 Python 技术栈**。Go 侧以 chromedp 直连 CDP 重新实现——不引入 sidecar、不引入 Python/venv/pip、不破坏单二进制交付。
>
> **P0 已完成（2026-10-02）**：真机验证可行，见 §0。
>
> **关联：** 架构基线 [`webhub-architecture.md`](../webhub-architecture.md)；同步计划 [`webhub-upstream-sync.md`](../webhub-upstream-sync.md)；源码锚点 PROJECT_MAP §13o / §10.29 / §24。

> **状态（2026-10-02 归档）：** P1–P4 全部落地，P5 回归/哨兵单测/文档收口完成。**唯一开放项：12 站点真机逐个验证（需用户登录态）**，跟踪转 [`webhub-architecture.md`](../webhub-architecture.md) §6 矩阵；上游同步事项转 [`webhub-upstream-sync.md`](../webhub-upstream-sync.md) §6。

---

## 0. P0 可行性验证（已完成 ✅）

原型：`tmp/p0-webhub/`（gitignored，不纳入构建）。

| 项 | 结果 |
|---|---|
| CDP 连接 + 独立 profile | ✅ Chrome 141 |
| 登录态复用 | ✅ |
| `sites.json` 选择器直接生效 | ✅ 未修改 |
| prompt 完整送达（31/39 字符） | ✅ |
| 增量监听 → SSE | ✅ 首字 858ms / 5.71s |
| 真实回复提取 | ✅ `P0-PROBE-OK`、`1, 2, 3, 4, 5, 6, 7, 8` |
| 可复现 | ✅ 两次独立运行 |
| 依赖增量 | 直接 +1 / 传递 +6（编译进二进制 7 模块，纯 Go 无 cgo） |

**三个已修缺陷（实施必须继承修法）**：① React 受控输入用原生 setter + 写入后校验，不用 `SendKeys`；② 首字等待独立 `startTimeout`，不占 idle 预算；③ `optional` 步骤有界超时（5s）。见架构 §2.1。

**结论：可行，进入 P1。**

---

## 1. 目标形态（需求确认）

1. **并入 Free Hub 页面**：Settings 侧边栏 `Free Hub` 行打开的区域内，左侧 provider 列表加**分割线**——上方 jethub provider（13 个），下方 webhub 站点（本项目可用站点）。
2. **右侧保留 call prefix 模式**：每站点可设调用前缀，全局唯一，冲突 409。
3. **调用形态 `{prefix}/{modelID}`**：prefix 之后的 modelID 按 UWA 的模型 ID 机制设计（域名全名 / 短别名 / `<domain>/<preset>`），见架构 §3.3。

---

## 2. 阶段划分

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| **P1** | 核心包骨架 + 浏览器会话管理 | `internal/webhub/` 可连接/断开/打开站点 | 2–3 天 |
| **P2** | workflow 引擎 + 监听 | 站点规则执行 + 增量提取（**不含 UI**） | 3–4 天 |
| **P3** | 页面 UI（Free Hub 内分割线 + 前缀） | `web/static/webhub.js` | 2–3 天 |
| **P4** | registry 桥接 + `{prefix}/{modelID}` e2e | 可经 `/v1/chat/completions` 调用 | 2–3 天 |
| **P5** | 多站点扩展 + 回归 + 文档 | 站点矩阵铺开 | 3–5 天 |

---

## 3. P1：核心包骨架

### 3.1 目标

`internal/webhub/` 能发现 Chromium、启动/连接独立 profile、按域名精确管理 tab。**不含 workflow，不含 UI**。

### 3.2 落点

| 文件 | 内容 |
|---|---|
| `internal/webhub/browser.go` | `findChromium()`（Windows/mac/Linux 候选路径 + PATH 回退）+ `launch(bin, profileDir, port, headless)` |
| `internal/webhub/session.go` | `SessionManager`（RWMutex）：站点 → 会话；`Open(site)` / `Close(site)` / `Status(site)`；**按域名精确匹配 tab，绝不复用非目标 tab**（P0 事故） |
| `internal/webhub/profile.go` | profile 目录解析（`config.ResolveWebHubDir`，与 `ResolveJetHubDir` 同款） |
| `internal/webhub/manager.go` | `Manager`：`Sites()` 站点元数据（12 个）、就绪状态、`SetPrefix`/`ClearPrefix` |

### 3.3 关键约束

- **profile 目录独立且持久**：登录态必须跨进程存活 ⇒ 用固定目录（`{configDir}/webhub/profile`），**不能**用临时目录（P0 原型用的临时目录导致每次都要重新登录）。
- **不自动关闭用户浏览器**：只连接、不 kill（`launch` 仅在无可用实例时启动）。
- **端口避让**：调试端口默认 `9333`（UWA 用 9222，避免撞车）。

### 3.4 验收

- [x] 单测：`findChromium` 候选路径解析（mock 文件系统）；`SessionManager` 域名匹配（多 tab 场景不误选）
- [x] 真机：连接本机 Chrome（Chrome 141，CDP 9333），tab 匹配正确（DeepSeek tab 命中；无该站点 tab 时**拒绝复用** `chrome://newtab/`，非目标 tab 绝不复用），profile 持久

> **P1 真机结论（2026-10-02）**：`FindChromium` 命中 `C:\Program Files\Google\Chrome\Application\chrome.exe`；
> `Connect` 附着到已在监听的浏览器（`launched=false`）；`FindTab` 精确命中 `https://chat.deepseek.com/sign_in`
> 并对 `chrome://newtab/` 返回 nil（P0 事故的守卫生效）；未登录态下 optional `new_chat_btn`
> **5s 有界超时后跳过**（未吃掉预算），随后 `FILL_INPUT` 明确报 "no element matches textarea" ——
> 三个 P0 缺陷的修法在正式实现里全部生效。

---

## 4. P2：workflow 引擎 + 监听

### 4.1 目标

执行 `sites.json` 声明式规则，完成「填输入 → 发送 → 增量监听 → 提取文本」。

### 4.2 落点

| 文件 | 内容 |
|---|---|
| `internal/webhub/sites.go` | 站点规则表（**从 `sites.json` 转换的 Go 数据**）：selectors / stream_config / workflow / presets |
| `internal/webhub/workflow.go` | 动作解释器：`CLICK` / `FILL_INPUT` / `KEY_PRESS` / `STREAM_WAIT` / `GROUP`；**`optional` 走 5s 有界超时** |
| `internal/webhub/input.go` | 文本注入：**原生 value setter + input/change 事件 + 写入后长度校验**（P0 缺陷①） |
| `internal/webhub/stream.go` | 增量监听：**首字等待独立超时**（P0 缺陷②）+ 前缀 diff + **resync 守卫** |
| `internal/webhub/modelid.go` | 模型 ID 派生（域名全名 / 短别名 / `<domain>/<preset>`） |
| `internal/webhub/probe.go` | 就绪探针：发最小消息验证站点可用 |

### 4.3 站点数据转换

- **不运行时读 `sites.json`**：一次性转换为 Go 常量/嵌入式 JSON，避免依赖上游文件与 Python 生态。
- 转换脚本放 `tools/`（一次性，产物入 `internal/webhub/sites.go`）。
- **转换时必须保留语义**：`optional`、`stream_config.mode`、`listen_pattern`、`parser`。

### 4.4 验收

- [x] 单测：workflow 各动作（fake page，参考 P0 `fixture.html`/`fixture2.html` 语义）；**resync 守卫反向验证**（去掉守卫 → DOM 回退时产生 `"AB"` 这类乱码 delta）
- [x] 单测：模型 ID 派生（`chat.deepseek.com` → `chat.deepseek.com` / `www.` 变体 / `deepseek`；多预设站点展开 `<domain>/<preset>`）
- [x] 规则转换：`tools/gen-webhub-sites.go` 从 `ref/universal-web-api/config/sites.json` 生成 `internal/webhub/sites.go`（12 站点 / 28 预设，保留 `optional`、`mode`、`listen_pattern`、`parser`、`WAIT` 秒数）
- [x] 真机：DeepSeek 端到端（**P0 结果已复现**：tab 匹配 + workflow 执行 + 有界超时 + 明确报错；未登录态下停在 `FILL_INPUT`，非缺陷）
- [ ] 真机：至少一个非 DeepSeek 站点（建议 claude.ai 或 chatgpt.com）——**需登录态**

> ⚠️ 真机端到端的最后一公里需要用户在浏览器里登录目标站点（webhub 无编程式登录，架构 §1）。
> P1/P2 的单测 + 真机链路（连接/匹配/执行/报错）已全部跑通。

---

## 5. P3：页面 UI

### 5.1 目标

Free Hub 页面内加分割线与站点组，右侧保留 call prefix。

### 5.2 落点

| 文件 | 内容 |
|---|---|
| `web/static/webhub.js` | 站点组渲染 + 分割线 + 右侧 pane（前缀/状态/操作/模型 ID/通知） |
| `web/static/style-webhub.css` | `.free-hub-divider` + 复用 `.free-hub-*` tokens |
| `web/static/jethub.js` | **最小改动**：左侧列表渲染时插入 webhub 站点组（保持 `openFreeHub`/`closeFreeHub` 生命周期不变） |
| `internal/api/webhub/register.go` | `GET /api/webhub/sites`、`GET /api/webhub/{site}/status`、`POST /api/webhub/{site}/open`、`PUT/DELETE /api/webhub/{site}/prefix`、`POST /api/webhub/{site}/probe` |
| `internal/api/router.go` | 保护组内注册（与 jethub 同款注入模式） |
| `web/static/i18n.js` | `webHub*` 文案（en + cn） |

### 5.3 约束

- **不新增侧边栏行**：只在 Free Hub 区域内工作（需求 1）。
- 状态徽标用**站点语义**（未启用/未连接/已就绪/未登录），**不用** jethub 的账号数徽标。
- 无账号卡、无积分、无限流重测、无备份（架构 §3.2）。

### 5.4 验收

- [x] 前端守卫：`web/webhub.test.js` 静态比对 UI 路径与 Go 路由声明（**`/webhub/sites/{site}/...`，复用 jethub 缺陷 6/14 的守卫思路**）
- [x] 自动验证（`node web/webhub.test.js`，15 项全绿）：分割线位置（站点组在分割线**下方**）、与 jethub 共用单选态、徽标为站点语义（**不是账号数**）、前缀冲突 409、模型 ID 点击复制、多预设站点显示预设数、缺选择器站点在 UI 明示

---

## 6. P4：registry 桥接

### 6.1 目标

`{prefix}/{modelID}` 可经 `/v1/chat/completions` 调用。

### 6.2 落点

| 文件 | 内容 |
|---|---|
| `internal/webhub/bridge.go` | `Bridge`：`SetPrefix`（冲突 409）+ `SyncProvider`（注册 `config.Provider`：`ID=webhub-{site}`、`APIType="webhub"`、Models、单条合成 Key） |
| `internal/webhub/customize.go` | `RequestCustomizer.Customize`：**拦截出站，转为驱动浏览器**（架构 §4.2） |
| `internal/webhub/response.go` | OpenAI 响应体包装（非流式一次性 / 流式逐 delta） |
| `internal/app/app.go` | 装配：Manager/Bridge 构造 + augmenter 注入 |

### 6.3 关键决策点

- **无 BaseURL**：webhub 无 HTTP 端点 ⇒ `Customize` 必须拦截，不真正发 HTTP 请求。
- **并发**：每站点单会话 **FIFO 串行队列**（架构 §4.3）。
- **合成 Key**：无凭据语义，仅用于 rotation 计数与用量归属，**不参与鉴权**。
- **错误映射**：选择器失效/登录过期/超时 → 明确错误文案（页面可排障）。

### 6.4 验收

- [x] e2e（非流式）：`POST /v1/chat/completions {"model":"ds/deepseek"}` → 经 `handleProxy` 返回真实回复，且**全程未发出任何 HTTP**（webhub 无端点，由 `Customize`/`InterceptResponse` 拦截）
- [x] e2e（流式）：`stream:true` → 逐 delta 返回，末帧 `finish_reason=stop` + `[DONE]`
- [x] 单测：前缀冲突（跨 hub + 跨站点，409 `*ConflictError`）、模型 ID 路由、并发排队（同站点 5 个请求 `maxConcurrent==1`；不同站点互不阻塞；取消即离队）
- [x] 重启恢复：已存前缀的站点在启动后自动重新注册（`RestoreBridges`）

---

## 7. P5：多站点扩展与收口

- [x] 全量 `go test ./...` + `go vet ./...` + 前端 `node web/webhub.test.js`（15 项）+ `node web/jethub.test.js`（回归全绿）
- [x] 规则表哨兵单测：每个站点的默认预设都含 `input_box`/`result_container`/`hard_timeout`，且 workflow 含 `FILL_INPUT`+`STREAM_WAIT`（选择器腐烂的早期告警）
- [x] 文档同步：架构 §6 矩阵 + PROJECT_MAP（§13o / §10.29 / §24）
- [x] `webhub-upstream-sync.md` 建立 pin 与首轮待办（W1 分诊：可搬 5 项 / 不搬 8 类；W1-2 模型 ID 派生已随 P2 落地并回填记录）
- [ ] 逐个站点**真机**验证（架构 §6 矩阵 12 个）——需登录态，按通过率排序推进
- [x] 本文归档，架构文档转正式基线

---

## 8. 风险登记（实施期持续复核）

| 风险 | 缓解 |
|---|---|
| 选择器腐烂 | sync 文档周期性 SOP；就绪探针每次调用前校验 |
| 反自动化限流 | 限个人调试；页面明示用途限制 |
| 并发受限（单会话串行） | 文档明示；不做并发优化 |
| AGPL-3.0（移植逻辑数据） | 仅 gitignored ref 参考，不打包源码；**最终需法务确认** |
| 浏览器依赖 | 检测失败时页面明确提示（本机实测已有 Chrome/Edge） |

---

## 9. 执行日志

| 阶段 | 日期 | 范围 | 结论 |
|---|---|---|---|
| P0 | 2026-10-02 | 可行性验证（原型 `tmp/p0-webhub/`） | ✅ 可行：真机 DeepSeek 端到端跑通，两次可复现；依赖 +1 直接/+6 传递；暴露并修复 3 个真实缺陷 |
| P1 | 2026-10-02 | 核心包骨架：`browser.go` / `session.go` / `profile.go` / `manager.go` / `domain.go` | ✅ 真机：Chrome 141 附着成功、tab 域名精确匹配（拒绝复用 `chrome://newtab/`）、profile 持久；单测全绿 |
| P2 | 2026-10-02 | workflow 引擎 + 监听：`sites.go`（生成）/ `workflow.go` / `input.go` / `stream.go` / `modelid.go` / `probe.go` / `driver.go` | ✅ 单测全绿（含 resync 守卫反向验证）；真机链路跑通；规则转换工具落地 |
| P3 | 2026-10-02 | 页面 UI：`web/static/webhub.js` + `style-webhub.css` + `jethub.js` 最小改动 + `i18n.js` + `api/webhub/register.go` | ✅ `node web/webhub.test.js` 15 项全绿；jethub 回归全绿；路由形状守卫到位 |
| P4 | 2026-10-02 | registry 桥接：`bridge.go` / `customize.go` / `response.go` + `app.go` 装配 + `bridge_augmenter.go` 双 Hub 派发 | ✅ e2e 非流式/流式均通；`{prefix}/{modelID}` 可调用；全程零 HTTP 出站 |
| P5 | 2026-10-02 | 回归 + 哨兵单测 + 文档收口 + 归档（真机多站点验证待登录态） | 🟡 收口完成：回归全绿（go test/vet + `node web/webhub.test.js` 15 项 + jethub 回归）+ 同步计划建立（pin `29d9685`，W1-2/W1-3 回填实施记录）+ 本文归档、架构转正式基线。真机 12 站点逐个验证为唯一开放项，待用户登录后按架构 §6 矩阵推进 |
