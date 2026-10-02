# Web Hub 上游同步计划（universal-web-api → TinyLab，周期性）

> **文档性质：** 常驻流程文档（不是一次性实施计划，**不归档、不置「已完成」**）。每轮同步在 §7 追加一行日志；待办在 §6 逐条勾销。
>
> **上游：** `ref/universal-web-api`（gitignored 只读副本，允许 `git fetch`/`git checkout` 同步操作，**禁止手工编辑**），origin `https://github.com/lumingya/universal-web-api.git`。
>
> **当前 pin：** `29d9685`（v3.0.0，2026-09-25，P0 验证基线）。**pin 语义 = 已分诊完毕**；已移植实现的语义不随 pin 移动。
>
> **同步性质（与 jethub 同步的关键差异）：** 上游是 **Python**，本项目是 **Go 重实现** ⇒ 同步的不是代码，而是**站点规则事实**（选择器 / workflow 步骤 / 模型 ID 派生 / 端点与协议判据）。上游代码只作为**规格说明书**阅读。
>
> **关联：** 架构基线 [`webhub-architecture.md`](webhub-architecture.md)；实施计划 [`archive/webhub-migration-plan.md`](archive/webhub-migration-plan.md)；源码锚点 PROJECT_MAP §13o / §10.29 / §24。

---

## 1. 目的与触发

把上游**普遍有价值**的站点规则更新带入本项目——选择器修正、新增站点/预设、workflow 动作语义、模型 ID 派生、监听模式判据——同时挡掉只对 UWA 自身架构有意义的内容（FastAPI 路由、面板、Python 生态件）。

**触发条件（满足其一即执行一轮）：**

1. **例行：每月一次**（站点改版节奏慢于 API 变更，月度足够）。
2. **报障先行：** 某站点出现「选择器失效 / 空回复 / 提取不完整」时，先查上游是否已修（`git log --oneline <pin>..origin/main -- config/sites.json`），避免重复造轮子。
3. **上游新 tag：** UWA 发版（`VERSION` 文件或 release tag）通常伴随站点规则批量更新。
4. **实施期受阻：** 移植某站点时该站点规则在上游已变更 ⇒ 就地取新规则并记入 §6。

---

## 2. 判定原则（搬什么 / 不搬什么）

### 2.1 搬（站点事实，普遍价值）

| 类别 | 说明 |
|---|---|
| `config/sites.json` 站点规则 | 选择器、workflow 步骤、stream_config（**核心同步对象**） |
| 新增站点 / 预设 | 新增 AI 站点、既有站点新增预设 |
| 模型 ID 派生规则 | `app/utils/model_routing.py` 的 candidates 派生逻辑 |
| 监听模式判据 | `network` vs `dom` 的适用判据、`listen_pattern`、parser 语义 |
| 站点级实测坑 | 上游注释标「实测」的抗检测/时序/选择器陷阱 |

### 2.2 不搬（UWA 自身架构 / Python 生态）

| 类别 | 例子 |
|---|---|
| FastAPI 路由 / 服务框架 | `app/api/*`、lifespan、uvicorn 配置 |
| Python 依赖与运行时 | `requirements.txt`、`start.py`、venv、DrissionPage 封装 |
| 面板 / 前端 | `static/index.html`、控制台 UI |
| 外挂 Chromium 管理 | UWA 自带的浏览器启动/profile 管理（本项目自管，架构 §4.3） |
| 标签池调度 | `app/core/tab_pool_parts/*`（本项目每站点单会话，架构 §4.3） |
| 命令引擎 / AI 自动分析 DOM | `app/services/command_engine*`、`site_discovery`（本项目不做） |
| Arena/CF 求解器 | `arena_cf_solver`、`cf_turnstile_solver`（反自动化破解，不搬） |

### 2.3 三条硬判据（全否 ⇒ 不搬，记入 §5）

1. **是站点事实吗**：属于目标 AI 网站的页面结构/协议，还是 UWA 自己的实现选择？
2. **Go 侧可等价实现吗**：依赖的 CDP 能力 chromedp 是否覆盖？（P0 已验证核心域：`Target`/`Page`/`Runtime`/`Input`/`Network`）
3. **用户可见损失**：不搬会不会造成空回复、提取不完整、站点不可用？

---

## 3. 每轮 SOP（命令级）

### S1 拉取与盘点

```powershell
cd ref/universal-web-api
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --tags
git log --date=short --pretty='%h %ad %s' <pin>..origin/main   # 提交清单
git diff --stat <pin>..origin/main                             # 规模
git diff --name-status <pin>..origin/main -- config/           # 站点规则面（重点）
git diff --name-status <pin>..origin/main -- app/core/parsers/ # 解析器面
Get-Content VERSION                                            # 版本
```

### S2 分诊（逐 commit 三分类：搬 / 不搬 / 待定）

- **重点文件族**：`config/sites.json`（**首要**）、`app/core/parsers/*`（SSE 解析语义）、`app/utils/model_routing.py`（模型 ID）、`app/core/extractors/*`（提取器）、`app/core/workflow/*`（动作语义）。
- **`config/sites.json` 用结构化 diff**：按站点 key 对比（`_global` 的 selector_definitions 变化影响所有站点）。
- 上游注释标「实测」的判据优先采信；推测标「待验证」。
- 每条结论落 §6（可搬）或 §5（不搬，附理由）。

### S3 待办

可搬项写入 §6，每条含：**上游 commit / ref 文件 → 本项目落点 → 判据与验收**（单测 + 真机）。

### S4 实施与验证

沿既有纪律：单测（含**反向验证**——把修复改回去必须变红）+ 有登录态真机验证；同一次改动更新 `webhub-architecture.md`（§6 矩阵、变更维护清单、最后核对行）与 PROJECT_MAP（§13o / §10.29 / §24）。

### S5 收口

1. **推进 pin**：`git checkout <新 pin>` + §7 记录 + PROJECT_MAP §22 同步。
2. §6 未完成项保留（带 commit 锚点，下一轮不重复分诊）。
3. §7 追加日志行。

---

## 4. 同步纪律

- **ref 目录**：允许 `git fetch` / `git checkout`；**禁止手工编辑其文件**。
- **规则转换**：`sites.json` 变化后**必须重跑转换脚本**（`tools/`）更新 `internal/webhub/sites.go`，**不得手工改 Go 侧规则**（否则下轮转换被覆盖）。
- **新增站点落地清单**：站点规则转换 → 模型 ID 派生（`modelid.go`）→ 就绪探针（`probe.go`）→ 站点元数据（`manager.go` `Sites()`）→ 前端站点组（`webhub.js`，分割线下方自动纳入）→ 文档（架构 §6 矩阵 + PROJECT_MAP §13o）。
- **不要照抄上游的宿主假设**：UWA 的标签池/预设路由/并发模型是为它自己的多 tab 架构设计的（架构 §4.3 已记本项目不同），只取**站点事实**。
- **反自动化功能一律不搬**（CF 求解、验证码处理）——合规红线，且本项目定位为个人调试。
- **AGPL-3.0**：同步的是**规则事实**，不是代码复制；上游仅作 gitignored ref，不纳入构建。

---

## 5. 不搬清单（已判定，避免重复评估）

| 主题 | 上游证据 | 不搬理由 |
|---|---|---|
| FastAPI 路由与服务框架 | `app/api/*`、`main.py` | 本项目已有 chi 路由与自身服务架构 |
| Python 依赖与启动器 | `requirements.txt`、`start.py`、`check_deps.py` | **不使用 Python 技术栈**（核心决策） |
| 外挂浏览器/profile 管理 | `app/core/browser/*`、`clean_profile.py` | 本项目自管会话（架构 §4.3），且需持久 profile |
| 标签池与预设路由 | `app/core/tab_pool_parts/*` | 本项目每站点单会话串行（架构 §4.3） |
| 命令引擎 / AI 分析 DOM | `app/services/command_engine*`、`app/utils/site_discovery.py` | 本项目不做自动适配 |
| Arena / CF 求解器 | `app/services/arena_cf_solver.py`、`cf_turnstile_solver.py` | 反自动化破解，合规红线 |
| 面板与前端 | `static/index.html`、`app/api/browser_routes.py` | 本项目 UI 在 Free Hub 页面内（架构 §3） |
| 媒体/附件/工具调用链路 | `app/utils/attachments.py`、`app/services/tool_calling*` | P1–P5 范围外（见 §6 W1） |

---

## 6. 待办与实施记录（W1：pin `29d9685` 首轮分诊）

> 分诊记录（2026-10-02，P0 期间完成）：上游 v3.0.0 @ `29d9685` 全量盘点，判定可搬/不搬。**P1–P5 实施期间的同步项在此追加**。
>
> 状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。

### W1-1 站点规则基线（12 站点）✅

- [x] 上游：`config/sites.json`（271KB，12 站点 + `_global.selector_definitions`）。
- [x] 本项目现状：P0 已用 DeepSeek 的 `input_box: textarea` / `result_container: css:div.ds-markdown` 验证选择器**直接生效**（未修改）。
- [x] 落点：`internal/webhub/sites.go`（转换脚本 `tools/` → Go 数据）。
- [x] 验收：DeepSeek 端到端复现 P0 结果（`P0-PROBE-OK`）。
  > **实施记录（2026-10-02 P0）**：选择器未修改即生效；workflow 三步（CLICK new_chat → FILL_INPUT → KEY_PRESS Enter → STREAM_WAIT）解析正确。**真机**：两次独立运行成功。

### W1-2 模型 ID 派生规则

- [x] 上游：`app/utils/model_routing.py:39` `_build_model_id_candidates`——域名 → `[全名, 短别名...]`（`chat.deepseek.com` → `chat.deepseek.com`, `deepseek`）；`collect_route_domain_models` 处理多预设。
- [x] 本项目决策点（P2 已定）：短别名派生规则**全量移植**——`ignoredSiteIDParts` 与 `route_aliases` 别名组一并转植（`domain.go`）；多预设站点按 `<domain>/<preset>` 展开（短别名**不**逐预设展开，防跨站点歧义）。
- [x] 落点：`internal/webhub/modelid.go`（派生 + `ResolveModelID` 最长前缀消歧）+ `domain.go`（别名表）。
- [x] 验收：`modelid_test.go` 单测（域名→别名→短 ID 派生、`gemini.google.com` → `gemini.com`/`gemini` 别名链、多预设展开、`deepseek-chat` 式别名前缀匹配、冲突消歧）。
  > **实施记录（2026-10-02 P2）**：全量移植 + 单测全绿；`{prefix}/{modelID}` 经 `/v1/chat/completions` e2e 验证（P4）。

### W1-3 监听模式判据（dom vs network）

- [ ] 上游：`stream_config.mode`（`network` / `dom`）+ `listen_pattern` + parser id；DeepSeek 用 `network`（`api/v0/chat/completion`，parser `deepseek`）。
- [ ] 本项目现状：P0 用 **DOM 模式**跑通 ⇒ DOM 是可行的通用基线。
- [x] 本轮动作：**P1–P5 用 DOM 落地**（`stream.go` 前缀 diff + resync 守卫，首字等待独立超时）；network 模式**未实施**，保留为后续优化项（更低延迟 + 分离 thinking 流）。
- [ ] 验收：DOM 模式全站点可用后再评估 network（依赖真机 12 站点验证）。

### W1-4 站点实测坑（实施期持续回填）

- [ ] 上游：各站点注释中的「实测」判据（抗检测、时序、选择器陷阱）。
- [ ] 本项目动作：P2/P5 实施每站点时，先读该站点规则注释，把实测坑写进架构 §6 或代码注释（标注来源 commit）。

### W1-5（可选参考）多模态 / 附件 / 工具调用

- [ ] 上游：`app/utils/attachments.py`、`app/services/tool_calling*`、`app/core/extractors/image_extractor.py`。
- [ ] 本轮动作：**不实施**。P1–P5 只做文本收发；多模态与工具调用待文本链路稳定后再评估。

---

## 7. 轮次日志

| 轮次 | 日期 | pin 前 → 后 | 范围 | 结论 |
|---|---|---|---|---|
| W1 | 2026-10-02 | — → `29d9685` | 首轮分诊（P0 期间）：上游 v3.0.0 全量盘点；**P0 真机验证 DeepSeek** | 可搬 5 项：站点规则基线（✅ 已验证生效）、模型 ID 派生、监听模式判据、站点实测坑、多模态（不实施）。不搬 8 类入 §5（Python 栈/框架/面板/标签池/命令引擎/CF 求解/媒体链路）。**核心结论：仅移植逻辑与规则数据，Go + chromedp 重实现可行，依赖 +1 直接/+6 传递** |
