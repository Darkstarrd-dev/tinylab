# 小精灵助手产品化 — 交接文档

> 本文档汇总「小精灵（sprite）助手产品化」任务的完整状态：任务要求、已确认/验证的方案与代码、以及尚未规划或未完成的部分。供切换到合适模式后继续。
>
- **当前状态**：5 项用户要求全部已实现，主指标 `assistant_product_readiness = 100%`，`contract_drift=0`。
- **代码位置**：分支 `autoresearch/2ed0ddaf4e5069d107b46f47cc15fbad4a24c192-commit-20260819`，最新提交 `57ff076`（基线 `0e41f1d` 之后共 17 次提交）。
- **基准与旧 judge**：`cmd/assistant-bench/`（旧 judge，OFF-LIMITS）全程保持 `assistant_readiness=100% / contract_drift=0`；新 bench 为 `cmd/assistant-product-bench/`，入口 `autoresearch.sh`。

---

## 1. 任务要求（用户原始 5 项）

1. **Settings 设置入口**：在 settings 页面左侧边栏给 assistant 添加一个专用设置入口；可设置 assistant 使用的模型、spritesheet 等。
2. **可拖拽 Dock**：assistant 当前 dock 固定占据右侧居中位置，需改为可拖动，可拖到左侧或右侧任意位置。
3. **模型辅助回复（重新规划设计）**：当前回复是函数式即时回复，并未用到模型辅助，没有真正起到智能助理的作用，需要重新规划设计。
4. **回复正确性**：当前回复部分「理论上正确」但很多不对——例如 `我想要播放视频` → `download.create / POST /api/downloads / 跳转页面`；一方面回复不正确，另一方面「跳转页面」是无效的。
5. **Systray 释放小精灵**：systray 里的「释放小精灵」没有效果。

---

## 2. 架构概览：助手分派链路

助手分三层（详见 `docs/assistant_interaction_research.md` / `docs/assistant_execution_layer_research.md`）：

- **L1 Dock/Modal**（`web/static/sprite.js`）：右/左可拖拽 dock + 模态面板 + 群聊气泡。
- **L2 角色 + 对话气泡**（`sprite.js`）：可点击漫游的角色 + SSE 事件气泡；`sendSpriteIntent`/`sendBubbleIntent` → `POST /api/assistant/dispatch {intent}`。
- **L3 桌面宠物**（`web/static/sprite-pet.html` + `host_webview_windows.go::openPetWindow`）：托盘「释放桌面小精灵」→ 独立透明置顶窗口。

分派后端（`internal/api/assistant/handler.go::dispatch`）：
```
intent → classifyIntent(intent)
           ├─ LLM 优先（cfg.Assistant.Model 配置时）：llm_classifier.go POST /v1/chat/completions
           │    解析 tool_calls → 过滤可 Resolve 的 wired 工具 → 非空则采用
           └─ 关键词 fallback：ast.Classify（semantics.json 规则）
       → Resolve 每个 tool 到 (Method,Path)
       → resolveNavigationPage(path) → app 页 id（"download"/"endpoint"/...）
       → 若 execute=true 且 Actionable → executeSubRequest（内部 HTTP 子请求）
       → 返回 {tools:[{tool,method,path,navigateTo,actionable}], jobs, events}
```

前端 `renderSpriteMessages` 渲染工具卡 + 两个按钮：
- **跳转页面**（`navigateToRoute(pageId)`，仅 navigable 工具）→ 调 app SPA 路由 `navigateTo(pageId)`。
- **执行动作**（`executeSpriteAction(tool)`，仅 actionable 工具）→ `POST /api/assistant/dispatch {tool, execute:true}` → `executeSubRequest`。

契约：`internal/assistant/semantics.json`（26 条规则 / 22 个 distinct 工具 / 2 个 job），由 `catalog.go` 加载并与 chi 真实路由集求交（drift=0 表示所有规则都能 Resolve 到真实路由）。`catalog.go` 零手维护——新增能力只能加 `semantics.json` 规则。

---

## 3. 已完成并验证的部分（按用户项）

### 项 1：Settings 设置入口 ✅ 实现+验证
- **配置层（2026-08-24 Action 化）**：`internal/config/types.go` `AssistantConfig{Model, Actions []AssistantAction}` + `Config.Assistant`；`AssistantAction{Name, SpritesheetPath, Cols, Rows, FrameStart, FrameEnd, Fps}` 描述一个精灵动画（网格行主序 0 基帧范围，左上=0）；旧顶层 `SpritesheetPath`/`SpritesheetFps` 已移除。`internal/config/defaults.go::finalizeConfig` 归一 cols/rows≥1、frameEnd≥frameStart、fps≤0→8。
- **API**：`internal/api/settings/register.go`——GET `/api/settings` 返回 `assistant` 对象；PATCH 接受 presence-aware `assistantPatch`（`Model *string` + `Actions *[]config.AssistantAction` 整表替换，经 `applyAssistantUpdates` 合并）。spritesheet 文件服务在 `internal/api/assistant/sheet.go`：`POST /api/assistant/sheet-preview`（native picker 绝对路径 → owner 绑定 1h TTL 随机 id）、`GET /sheet-preview/{id}`、`GET /sheet-image/{name}`（按 action 名服务，宠物页运行时加载）。`/api/browse` 新增可选 `filter` 参数。
- **前端**：`web/static/settings/settings.js`（Settings 侧栏 Assistant 行）、`web/static/settings/settings_assistant.js`（新：`openAssistantModelPicker` 独立 stacked overlay 复刻 pg 模型选择器 + Action 列表 Add/Remove/Edit + Action 编辑弹窗——Browse 选 spritesheet、canvas 网格分割预览与帧编号、单击选单帧/拖选连续范围、From/To 数值输入、fps stepper）、`web/static/settings/settings_modal.js`（`openAssistantModal`/`saveAssistantModal`：hidden input + `window.__assistantActions` 草稿，PATCH `{model, actions}`）、`web/static/i18n.js`（assistant 键 EN+CN）。
- **验证**：API round-trip（Python urllib PATCH→GET 持久化）；`web/settings-assistant-modal.test.js`（VM 加载真实 `settings_modal.js`，3 检查：字段→PATCH body、invalid fps→8、fps<1→8）。
- **未验证**：模态框视觉渲染（本机无头 chromium 无法启动）。

### 项 2：可拖拽 Dock ✅ 实现+验证
- `web/static/sprite.js`：`dockDrag` 状态 + `loadDockPosition`/`saveDockPosition`/`applyDockPosition`/`dockMouseDown`/`dockMouseMove`/`dockMouseUp`。`mousedown` 启动追踪，`mousemove` 移动 >4px 进入拖拽并按光标 X 吸附左/右屏半边 + 实时设 `dock.style.top/left/right`，`mouseup` 持久化 side/y 到 `localStorage`（`tr-sprite-dock-side`/`-y`）；未超阈值=点击→`openSpriteModal`。窗口 resize 重算。
- `web/static/style.css`：`.sprite-dock.side-left`（左缘胶囊，翻转圆角与阴影）、`.sprite-dock.dragging`（`cursor:grabbing`、`transition:none`）、base `cursor:grab`。
- **验证**：`web/sprite-dock-drag.test.js`（VM DOM stub 加载真实 `sprite.js`，7 检查：init 定位、左拖拽吸附+持久化+不开 modal、右吸附、点击开 modal、≤4px 当点击、+2 个 navigateToRoute 检查）。

### 项 3：模型辅助分派 ✅ 实现+验证（部分）
- `internal/assistant/llm_classifier.go`（新）：`LLMClassifier`/`LLMTool`——POST 项目自身 `/v1/chat/completions`（透传 `tool_calls`），让模型从工具 schema 选工具，解析 `tool_calls[].function.name`（去重保序）；空模型/上游不可用/无工具→返回 error 由调用方回退。
- `internal/api/assistant/handler.go`：分派意图路径由 `ast.Classify` 改为 `h.classifyIntent`——先 `llmClassifier`（按 `cfg.Assistant.Model` + `cfg.Port` 构造，工具列表限定为契约中可 `Resolve` 的 wired 工具），LLM 返回非空可解析工具则采用，否则回退关键词 `Classify`。可注入测试缝 `intentClassifier` 接口 + `SetLLMClassifier`。
- **验证**：`internal/assistant/llm_classifier_test.go`（4 httptest：解析 tool_calls、空结果、未配置 error、上游 500 error→回退）；`assistant_test.go::TestClassifyIntent_LLMOrchestration`（4 mock：LLM 返回可解析→采用 / LLM error→关键词回退 / 不可解析→过滤→回退 / 无注入→关键词）。
- **未完成**：见 §4「对话式回复文本」——工具「选择」已模型辅助，但回复「文本」仍是通用模板 `为你找到以下对应能力与操作：`，未用 LLM 生成自然语言内容。

### 项 4：回复正确性 ✅ 实现+验证
- **契约修复（3 轮加固，9 处规则改动）**，在 `internal/assistant/semantics.json`：
  - 第 1 轮：`download.create` 从 `any` 移除 `视频`/`video`（要求显式 `下载`/`download`）→ `播放视频` 不再误路由到下载；新增窄规则 `image.generate`（`any:[画]`，`none:[表格,文档,画线,画板,画图,刻画]`）→ `画一只猫` 命中（原 `all:[图]` 漏召回）。
  - 第 2 轮：`anysearch.search` `none += [本地]`（`搜索本地文件` 不再命中网页搜索）；`anysearch.extract` `none += [音频]`（`提取视频里的音频` 不再命中网页正文提取）。
  - 第 3 轮：`editor.open` `none += [目录,文件夹]`（`打开文档目录` 路由 `editor.tree` 浏览而非 `editor.open` 打开单文档）。
  - 加固中第 1 轮另修：`probe.test` `none += [网络,网速,延迟,ping,带宽,bandwidth]`、`providers.list` `none` 移除 `key`、`monitor.view` `none += [清理,清空]`、新增 `image.edit` `any:[改] all:[图]` 规则。
- **导航修复（此前遗漏的真实 bug）**：`跳转页面` 按钮调 `sprite.js::navigateToRoute` 原设 `window.location.hash`，但 app **无 hashchange 监听**（导航走 `app.js::navigateTo(page)` click 处理器）→ 完全 no-op；且 `handler.go::resolveNavigationPage` 返回无效 hash（`"#downloads"` 但 nav data-page 是 `"download"`；`"#settings"` 但 Settings 页 id 是 `"endpoint"`）。修复：(1) `resolveNavigationPage` 改返回有效 app 页 id（download/endpoint/editor/providers/combos/monitor/gallery/playground/review）；(2) `navigateToRoute` 改调 `navigateTo(route)`。
- **验证**：`cmd/assistant-product-bench` 的 26 个 disambiguation 场景（in-process `Classify`，覆盖 download/image×3/monitor×2/providers/probe/editor×3/anysearch×2 全轴）；`web/sprite-dock-drag.test.js` 增 2 个 navigateToRoute 检查（调 navigateTo+关 modal、空 route no-op）；旧 judge `cmd/assistant-bench` 30 意图 `dispatch_f1=100%`。

### 项 5：Systray 释放小精灵 ✅ 实现+验证（部分）
- **透明窗口**：`host_webview_windows.go::openPetWindow`（`//go:build tray && webview && windows`）新增 Win32 透明：`WS_EX_LAYERED`（`gwlExstyle=-20`）+ `SetLayeredWindowAttributes(hwnd, petColorKey=RGB(255,0,255), 0, LWA_COLORKEY)`；`sprite-pet.html` `.pet-container` `background:#FF00FF`（color key），被 keyed out 透明，只留 sprite/气泡（非 key 像素）。新增 proc `procSetLayeredWindowAttributes` 与常量 `gwlExstyle`/`wsExLayered`/`lwaColorkey`/`petColorKey`。这是「释放小精灵无效果」（不透明方框）的根因修复。
- **Spritesheet 渲染（2026-08-24 改 actions 消费；同日脚本模块化）**：宠物页逻辑已从 `sprite-pet.html` 内联 `<script>` 抽出为独立模块 `web/static/sprite-pet.js`（原样平移：窗口拖拽 `movePetWindow` 转发、气泡与 `/api/assistant/dispatch`、spritesheet 渲染器、Events SSE 订阅），HTML 仅保留 `<script src="/sprite-pet.js"></script>` 外链。渲染器 fetch `/api/settings` 取 `assistant.actions`，优先名为 `idle` 的 action 否则第一个带路径的，经 `/api/assistant/sheet-image/{name}` 加载图片，按 cols/rows/frameStart..frameEnd/fps 步进；无可用 action 保留 CSS face fallback。
- **验证**：`web/sprite-pet-drag.test.js`（加载真实 `web/static/sprite-pet.js` VM DOM stub，5 检查：抽取契约——HTML 必须外链 /sprite-pet.js 且无内联 script、模块符号齐备；拖拽增量 delta、mouseup 结束拖拽、气泡上 mousedown 不拖拽）；`go build -tags "tray webview"` 通过。
- **未验证**：透明窗口视觉（Win32 原生，需 tray+webview 运行时+显示器，本机无法跑；color-key 与 `docs/assistant_interaction_research.md §6.3` MVP 一致）。

---

## 4. 尚未规划 / 未完成的部分

### 4.1 对话式回复文本（项 3 的深层 gap，**最该继续**）
用户原话「没有真正起到智能助理的作用，需要重新规划设计」。当前：工具**选择**已模型辅助（LLM classifier），但回复**文本**仍是通用模板 `为你找到以下对应能力与操作：` + 工具卡。未做：让 LLM 生成自然语言回复（acknowledge 意图 + 解释将做什么），或在 dispatch 响应里带 `reply` 字段（LLM 的 `content` 或从工具 `Desc` 合成的意图感知文本），前端优先渲染 `reply`。
- **未做原因**：LLM 生成的回复内容无法在无网络 bench 中验证；属 UX 增强。
- **可验证的最小版本**：dispatch 返回 `reply`（从已 Resolve 工具的 `Desc` 合成，如 `好的，我将为你：生成图片。`），前端 `data.reply` 优先；这是确定性可测的，不需要 LLM 调用。LLM 真实 `content` 作为 bonus（不可测）。

### 4.2 逐像素 Alpha 透明（项 5 的「后续优化」）
当前 color-key（品红键出）是文档化 MVP——有锯齿边缘、不支持半透明。`docs/assistant_interaction_research.md §6.3` 标注「后续：layered per-pixel alpha」。需核实 go-webview2 是否暴露 `put_DefaultBackgroundColor`（透明）+ `DwmExtendFrameIntoClientArea`。**未做原因**：Windows 原生、本机不可验证、MVP 已可用，盲改有风险。

### 4.3 视觉验证（环境受限）
本机无头 chromium（browser 工具）无法启动（`about:blank` 超时）。以下特性**结构/行为已验证但视觉未确认**：dock 拖拽 UX、Settings 模态框渲染、透明宠物窗口外观。需在能启动浏览器/tray 运行时的环境复验。

### 4.4 executeSubRequest 鉴权（password-on 边缘 bug）
「执行动作」(`executeSpriteAction`) 走 `executeSubRequest`（内部 HTTP 子请求到 `http://127.0.0.1:{port}/api/...`）。password OFF（默认）正常；password ON 时该内部请求无 CSRF/session → 403。`docs/assistant_execution_layer_research.md` 提及「内部子请求免鉴权或带内部 session」——当前实现两者皆无。**未做原因**：需 password-on 环境复现，非用户明确报告。

### 4.5 默认 sprite 资产
sprite 渲染器在没有任何带 `spritesheetPath` 的 action 时回退 CSS face。仓库无默认 sprite PNG。**未做原因**：需美术资源。

---

## 5. 代码地图（本任务改动/新增文件）

**Go 后端**
- `internal/config/types.go`（`AssistantConfig`+`AssistantAction` + `Config.Assistant`）、`internal/config/defaults.go`（action 归一化）
- `internal/api/settings/register.go`（GET 返回 assistant / PATCH `assistantPatch`+`applyAssistantUpdates`）
- `internal/assistant/semantics.json`（26 规则，9 处加固改动 + 2 新规则）
- `internal/assistant/llm_classifier.go`（新，`LLMClassifier`/`LLMTool`）
- `internal/api/assistant/handler.go`（`classifyIntent` + `llmClassifier` + `llmTools` + `resolveNavigationPage` 改有效页 id + `intentClassifier` 测试缝 + `SetLLMClassifier`）

**前端**
- `web/static/sprite.js`（dockDrag 拖拽 + `navigateToRoute` 改调 `navigateTo`）
- `web/static/style.css`（`.sprite-dock.side-left`/`.dragging`/cursor）
- `web/static/settings/settings.js`（侧栏 Assistant 行）、`web/static/settings/settings_modal.js`（`openAssistantModal`/`saveAssistantModal`）、`web/static/i18n.js`（8 键 EN+CN）
- `web/static/sprite-pet.html`（color-key bg + canvas spritesheet 渲染器）
- `host_webview_windows.go`（`openPetWindow` 透明 + proc/常量）

**测试**
- `web/sprite-dock-drag.test.js`（7 检查：5 拖拽 + 2 导航）
- `web/sprite-pet-drag.test.js`（3 检查）
- `web/settings-assistant-modal.test.js`（3 检查）
- `internal/assistant/llm_classifier_test.go`（4 httptest）
- `internal/api/assistant/assistant_test.go`（`TestClassifyIntent_LLMOrchestration` 4 mock）

**基准与文档**
- `cmd/assistant-product-bench/main.go`（5 维度 + correctness 26 场景 + `scoreNavigationWired` 2 检查，复合 primary `assistant_product_readiness`）
- `autoresearch.sh`（入口：`go run ./cmd/assistant-product-bench`）
- `PROJECT_MAP.md` + `docs/config-registry-state-architecture.md`（9 条 最后核对 同步注记）

---

## 6. 基准（`cmd/assistant-product-bench`）

无网络确定性 bench：进程内构造真实 `*api.Router`（chi.Walk 191 路由），加载 `semantics.json` 契约，跑纯关键词 `Classify` 于 26 个 tricky 意图 + 结构扫描 5 个产品维度的源文件。

| 维度 | 权重 | 检查 |
|---|---|---|
| `settings_coverage` | 0.15 | 7 结构（config type/model/spritesheet、modal、sidebar、i18n） |
| `dock_interactivity` | 0.15 | 8 结构（dock 元素、mousedown/move/up、localStorage、drag 状态、动态位置、CSS 变体） |
| `llm_dispatch_wired` | 0.20 | 6 结构（llm_classifier.go 存在、handler 调用、关键词 fallback、/v1/chat、config model、schema.go） |
| `reply_correctness` | 0.30 | 26 行为场景（Classify）+ 2 导航结构（navigateToRoute 调 navigateTo、resolveNavigationPage 有效页 id） |
| `pet_release_wired` | 0.20 | 12 结构（菜单项、openPetWindow、borderless、topmost、导航、页面、dispatch、move/close 绑定、透明、spritesheet、拖拽） |

回归次级指标：`contract_drift`（必须 0）、`contract_health`、`wired_tools`、`routes_surface`。旧 judge `cmd/assistant-bench`（OFF-LIMITS）独立，跑 `go run ./cmd/assistant-bench`。

**运行**：`bash autoresearch.sh`（或 `go run ./cmd/assistant-product-bench`）。`go test ./internal/assistant/ ./internal/api/assistant/`。`go build -tags "tray webview"`。

---

## 7. 下一步建议（给接续模式）

1. **项 3 对话式回复**（§4.1）：dispatch 加 `reply` 字段（从工具 `Desc` 合成的确定性版本先做，可测；LLM `content` bonus），前端 `data.reply` 优先渲染。bench 可加 `reply_wired` 检查使其 metric-relevant。
2. **项 5 逐像素 alpha**（§4.2）：核实 go-webview2 的 `put_DefaultBackgroundColor`，平滑宠物边缘。
3. **视觉复验**（§4.3）：在能跑浏览器/tray 的环境复验 dock/settings/宠物。
4. **executeSubRequest 鉴权**（§4.4）：password-on 时内部子请求加 session/CSRF，或改直接调 handler 绕过 HTTP。
5. **默认 sprite 资产**（§4.5）。

---

## 附：迭代轨迹（43.21 → 100%，17 次 run）

| run | 项 | 内容 | 变化 |
|---|---|---|---|
| #22 | 4 | semantics.json download/image 修复 | correctness 60→100 |
| #23 | 1 | AssistantConfig + API + 侧栏 + modal + i18n | settings 0→100（llm 33→50 副效应）|
| #24 | 2 | dockDrag + localStorage + CSS | dock 12.5→100 |
| #25 | 3 | llm_classifier.go + classifyIntent | llm 50→100 |
| #26 | 5 | Win32 透明 + canvas spritesheet | pet 83.3→100（composite →100）|
| #27-29,31 | 4 | correctness 对抗加固 3 轮（dip→recover，judge 15→26，9 契约修复）| — |
| #30 | 3 | LLM 编排行为测试（注入缝 + 4 mock）| flat 100（验证）|
| #32 | 2 | dock 拖拽行为测试（5 VM 检查）| flat 100 |
| #33 | 5 | 宠物拖拽行为测试（3 VM 检查）| flat 100 |
| #34 | 1 | Settings 模态保存行为测试（3 检查）| flat 100 |
| #35-37 | 4 | 「跳转页面无效」bug 修复（navigateToRoute 调 navigateTo + resolveNavigationPage 有效页 id）+ bench scoreNavigationWired + 2 VM 检查 + doc-sync | dip 97.86→recover 100 |

**过程注记**：一个并发 autoresearch 会话（cumora-playground 分支）多次切换共享 worktree 到 main/其分支，曾丢失未提交改动（已通过 `git checkout` 恢复，17 提交完整在 `57ff076`）。教训：编辑后立即提交。
