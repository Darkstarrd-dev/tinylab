# 小精灵交互层研究

> 研究：在已建成的契约系统（底部架构，见 [`docs/assistant_contract_research.md`](docs/assistant_contract_research.md)）之上，实现小精灵的**交互层**。用户提出三级递增复杂度：①侧边 dock 客服式悬浮窗 → ②可在 App 内移动的 spritesheet 形象 + 漫画气泡 → ③可在系统桌面行动的桌面宠物。
>
> 本文档梳理三级要求并逐级研究可行性、落地依据（TinyRouter 真实前端/原生代码）、实现方案、风险与升级路径。

## 1. 定位：交互层 vs 底部架构

底部架构（已完成）：`semantics.json` 契约 → `assistant.Classify/Resolve` → `cmd/assistant-bench` 裁决（`assistant_readiness = dispatch_f1 × contract_health`，100%）。它解决"小精灵懂什么、怎么路由到项目能力"。

交互层（本文）：解决"用户怎么与小精灵对话、小精灵怎么呈现"。三级仅改变**呈现层**，后端契约/分派（`/api/assistant/*`，见 [`docs/assistant_implementation_plan.md`](docs/assistant_implementation_plan.md) 任务 A）三级共用。后端未落地前，交互层可先用 mock/桩端点开发，落地后接线。

## 2. 三级复杂度总览

| 级 | 形态 | 运行域 | 技术域 | 复杂度 | 是否跨页面持久 |
|---|---|---|---|---|---|
| L1 | 侧边 dock（收起/悬停展开/点击开 modal） | App 网页内 | 纯前端（vanilla JS+CSS） | 低 | 必须（body 级单例，非 `#page-content`） |
| L2 | spritesheet 可移动形象 + 漫画气泡输入 | App 网页内 | 纯前端 + 动画/资产 | 中 | 天然持久（body 级 absolute 元素） |
| L3 | 桌面宠物（透明/置顶/异形/无边框独立窗口） | 系统桌面 | 原生（WebView2 host 扩展 + Win32） | 高 | 独立 HWND 窗口，与 App 解耦 |

## 3. 共同基础（三级都依赖，已就绪）

- **SPA shell 单例结构**（`web/static/index.html` / `index-nopg.html`）：`.app > .top-header > .main > #page-content` + body 级单例 `#modal-overlay`、`#toast-container`、`#info-modal-overlay`。**`app.js` 在导航时 `innerHTML` 清空 `#page-content`**——故小精灵 DOM **必须挂在 `<body>` 或 `.app`（与 `#modal-overlay` 同级），不可放 `#page-content`**，否则切页被抹掉。这正是用户"切换页面不受影响"的要求。
- **属性驱动主题**（`<html data-theme/variant/style/font-size/lang>`，`theme.js`）：所有新组件用 `var(--token)` 消费主题令牌，不硬编码颜色。令牌层见 `style.css:9-79`（`:root`）+ light/variant/style 层。
- **z-index 层级**（`style.css:54-58`）：`--z-dropdown:10`、`--z-sticky:20`、`--z-modal:50`、`--z-toast:60`、`--z-tooltip:10005`。已有高值先例：`#dl-settings-overlay:10001`、`.gif-spinner-overlay:20000`、`.gallery-layout-fullscreen:9999`。小精灵需新令牌（如 `--z-sprite-dock:70`、`--z-sprite-modal:10010`，高于 tooltip/dropdown 以确保层级）。
- **全局 JS + embed + 双 shell**：`//go:embed all:static`（`web/embed.go`）自动收录新 `web/static` 文件，`http.FileServer` 服务任意文件——**加 JS 无需改 Go/router，只在 `index.html` 与 `index-nopg.html` 两处加 `<script>`**。脚本须全局声明（`var`/`function`，不 IIFE），因 inline `onclick="fn()"` 约定。
- **modal/popup 范式**（`style.css:1447-1450`）：`.modal-overlay{position:fixed;inset:0;z-index:var(--z-modal);background:rgba(0,0,0,0.5);backdrop-filter:blur(...)}` + `.modal{background:var(--modal-bg);...transform:scale(.96) translateY(8px)→1}`。可复用。
- **hover 渐显范式**（`style.css:3413-3423` `.gallery-vol-popover` opacity/visibility on `:hover`/`:focus-within`）：dock 悬停展开可仿此。
- **后端分派**（任务 A，未落地）：`POST /api/assistant/dispatch {"intent"|"tool_calls"}` → 返回 `{tool, route, status, result}`，SSE 流式。交互层调用它。

---

## 4. Level 1：侧边 dock + 悬浮 modal（客服式）

### 4.1 交互规格
- 平时：dock 贴右侧边（或可配置侧），细条/最小化，不挡内容。
- 鼠标移近：dock 稍展开（露图标+短标签）。
- 点击：展开为较大 modal 悬浮窗，内含对话区（输入框 + 消息流 + 工具调用结果展示）。
- 收回：modal 内/外按钮点击收回为 dock。
- **跨页面持久 + 层级足够高**（见 §3）。

### 4.2 落地依据
- DOM 挂 `<body>`（单例 `#sprite-dock` + `#sprite-modal`），init 时创建一次，`app.js` 导航不动它。
- z-index 用新令牌 `--z-sprite-dock`（`> --z-toast` 但 `< tooltip`，如 70）、`--z-sprite-modal`（高于 tooltip，如 10010，确保压在自定义下拉/全屏之上）。
- modal 复用 `.modal-overlay` 范式（fixed/inset:0/blur）；dock 用 hover 渐显范式。
- 主题令牌消费：`var(--modal-bg)`、`var(--glass-border)`、`var(--accent)`、`var(--text)` 等。

### 4.3 实现方案
- **新文件**：`web/static/sprite.js`（全局：`openSpriteModal()`/`closeSpriteModal()`/`sendSpriteIntent(text)`/`appendSpriteMessage()`）；CSS 入 `web/static/style.css`（`.sprite-dock`、`.sprite-modal`、`.sprite-msg` 等一块）。
- **HTML**：`index.html` + `index-nopg.html` 各加 `<div id="sprite-dock"></div>` 单例 + `<script src="/sprite.js" defer></script>`（script 在依赖之后）。
- dock：`position:fixed;right:0;top:50%;transform:translateY(-50%);width:36px` → `:hover{width:64px}`（过渡），点击触发 `openSpriteModal()`。
- modal：复用 `.modal-overlay.show` 切换；内部对话区调 `sendSpriteIntent`→`fetch('/api/assistant/dispatch',{method:POST,body:JSON.stringify({intent})})`→SSE 订阅进度→`appendSpriteMessage` 渲染 `{tool, route, result}`；对可跳页能力给"跳转"按钮（`location.hash=route` 对应页），对动作能力给"执行"按钮（`fetch(route,{method,body})` + toast）。
- **后端依赖**：任务 A 的 `/api/assistant/dispatch`；落地前可用 mock handler 返回固定 `{tool, route}` 验证 UI。

### 4.4 验证
- `node --check web/static/sprite.js`；`go build`（重 embed）；按 `tinyrouter-frontend-smoke-test` skill 起真实 binary（temp dir + `port:` only config），headless 浏览器：切页（Monitor→Settings）后 dock/modal **仍在**（`document.getElementById('sprite-dock')` 非空）；点 dock 开 modal；发送意图→消息渲染；console 无 error；暗/亮主题切换颜色跟随。
- i18n：键进 `i18n.js`。

### 4.5 风险
- z-index 与 playground/gallery 全屏（9999/20000）冲突——`--z-sprite-modal` 取 10010 可压过；但 gallery 全屏视频控件 25-26 不受影响。
- `index-nopg.html` 脚本集更小——`sprite.js` 须在两 shell 都加且顶层无可执行 DOM 代码（仅声明 + init 钩子）。

---

## 5. Level 2：可移动 in-app 形象 + spritesheet + 漫画气泡

### 5.1 交互规格
- 侧栏一个按钮"释放小精灵"→在 App 视口内生成形象。
- 形象用 **spritesheet**（预定义帧）做动画（idle/breathe、walk、talk）。
- 点击视口某处→形象移动/停在该处（click-to-move，CSS transition 或 JS 插值）。
- 停下后→在形象旁弹出**漫画语言气泡**输入框（带尖角）→输入意图→与小精灵交互（同 L1 的 dispatch）。

### 5.2 落地依据
- 形象 = body 级 `position:absolute` 元素（`#sprite-char`），与 dock/modal 同级，导航不抹。移动 = 改 `left/top` + `transition`；或 canvas 帧绘制。
- spritesheet 动画：项目有图片/GIF 基础（`internal/image`、GIF 编辑器），spritesheet 帧步进用 `background-position` 步进或 canvas `drawImage` 切片——纯前端，无新依赖。
- 漫画气泡：CSS `::after` 三角 + 圆角矩形（仿 `.tip` tooltip `style.css:1150-1155` 但更大、带输入）。

### 5.3 实现方案
- **资产**：`web/static/sprite/sprite.png`（spritesheet，如 4×4 帧，每帧 96×96）+ `web/static/sprite/sprite.json`（帧表：`{idle:[0,1,2,3], walk:[4..7], talk:[8..11], fps}`）。
- **新文件**：`web/static/sprite-char.js`（`releaseSprite()`/`moveSpriteTo(x,y)`/`openSpriteBubble()`/`spriteAnimLoop()`）；CSS `.sprite-char`、`.sprite-bubble` 入 `style.css`。
- 动画循环：`requestAnimationFrame` 按 `sprite.json` 帧表步进 `background-position`；状态机 `state=idle|walk|talk`，移动时切 `walk`，停则 `idle`，气泡打开切 `talk`。
- click-to-move：监听 `.main` 点击→`moveSpriteTo(e.clientX,e.clientY)`（限定在 `.main` 视口内）；移动用 `transition:left .4s,top .4s` 或 JS 缓动。
- 气泡：`#sprite-bubble` 绝对定位在形象附近，`::after` 尖角指向形象；内含 `<input>` + 发送按钮→`sendSpriteIntent`（复用 L1）。
- 侧栏释放按钮：`.top-header-nav` 或 utility 菜单加按钮 `onclick="releaseSprite()"`（参考 `tinyrouter-header-nav-reference-control` 的 nav 装配约束）。

### 5.4 验证
- 浏览器 smoke：释放后形象出现并 idle 动画；点击移动→walk 动画→停 idle；气泡打开→输入→消息流；切页形象仍在（body 级）；暗/亮主题气泡配色跟随。
- 帧动画用 `getComputedStyle` 验 `background-position` 在变。

### 5.5 风险
- 形象移动到 `#page-content` 子元素上方时可能被其 `overflow:hidden`/stacking context 截断——故形象挂 `<body>`（视口级 `position:fixed`/`absolute` to body），不受 `.main` overflow 影响。
- spritesheet 资产体积/版权——自绘或开源素材。
- 移动时与页面内容交互冲突（点击移动 vs 点击页面按钮）——区分：点击空白区移动、点形象开气泡、点页面控件照常。

---

## 6. Level 3：桌面宠物（系统桌面，原生窗口）

### 6.1 交互规格
- 小精灵成为独立**原生窗口**，可在系统桌面任意位置行动（不限于 App）。
- 窗口：**透明背景 + 置顶 + 异形（region，按角色轮廓）+ 无边框/无标题**，只显示角色像素。
- 角色在桌面漫游（自主/点击移动）；点击角色→漫画气泡（同 L2）交互。
- 与 App 解耦：独立 HWND，关闭 App 主窗口/托盘仍可独立存在（或随托盘退出）。

### 6.2 落地依据（关键：host 已具备全部原语）
`host_webview_windows.go`（`//go:build tray && webview && windows`）已证明所需一切：
- **HWND 可得**：`hwnd := uintptr(w.Window())`（line 298）。
- **Win32 syscall 已大量使用**：`procGetWindowLongPtrW/SetWindowLongPtrW/SetWindowPos/GetWindowPlacement/MonitorFromWindow/GetMonitorInfoW/ShowWindow/SetClassLongPtrW/RedrawWindow/LoadIconW`（line 185-337）。
- **无边框 popup 先例已存在**：`newStyle := (fsSavedStyle &^ (wsCaption|wsThickFrame|wsSysMenu)) | wsPopup` + `SetWindowLongPtrW` + `SetWindowPos`（line 196-209，`toggleNativeFullscreen`）——这正是桌面宠物所需的无边框窗口套路。
- **JS↔Go 桥已存在**：`w.Bind("toggleNativeFullscreen", func(enable bool) error{...})`、`w.Bind("openExternalURL", ...)`（line 179, 228）+ `w.Init(js)` 注入。故宠物页 JS 可 `window.movePet(x,y)`、`window.setTopmost(true)`、`window.setRegion(...)` 调原生。
- **多并发窗口已支持**：`runWebviewClickLoop` 每次 tray 点击开一个窗口（line 71-78），`webviews map[uintptr]webview2.WebView` 注册（line 91, 161-163）。

### 6.3 实现方案
- **新函数** `openPetWindow(hctx *app.HostContext)`（仿 `openWebviewWindow`，build tag `tray && webview && windows`）：
  - `webview2.NewWithOptions` 小窗（如 96×96，`Title:""`）。
  - 取 HWND 后 Win32：
    - **无边框**：`(style &^ (wsCaption|wsThickFrame|wsSysMenu|wsMinimizeBox|wsMaximizeBox)) | wsPopup`（复用 line 196 套路）。
    - **置顶**：`SetWindowPos(hwnd, HWND_TOPMOST=HWND(-1), x, y, w, h, swpNoActivate|swpShowWindow)`。
    - **透明**：`WS_EX_LAYERED`（`GetWindowLong(hwnd,GWL_EXSTYLE)|wsExLayered`）+ `SetLayeredWindowAttributes(hwnd, colorKey, alpha, LWA_COLORKEY|LWA_ALPHA)`（color-key 抠掉背景色）；或 `DwmExtendFrameIntoClientArea` + WebView2 `put_DefaultBackgroundColor`(transparent)。**注意**：go-webview2 是否暴露 `put_DefaultBackgroundColor` 需核实——若不暴露，用 color-key（页面 body 背景设固定色 = color-key，被抠透明）兜底。
    - **异形**：`SetWindowRgn(hwnd, hRgn, true)`，`hRgn` 由角色轮廓多边形 `CreatePolygonRgn`/`CombineRgn` 构造（或简化为圆角矩形 `CreateRoundRectRgn`，先做矩形/圆角，异形后续）。
    - **点击穿透**（可选）：`WS_EX_TRANSPARENT`（仅角色像素可点，空白穿透到桌面）——但会挡气泡交互，故仅 idle 穿透、hover/点击时取消穿透。
  - `w.Bind("movePet", func(x,y int) error{ SetWindowPos(hwnd,0,x,y,0,0,swpNoSize|swpNoZOrder|swpNoActivate); return nil })`。
  - `w.Bind("setTopmost"/"setRegion"/"getDesktopSize", ...)`。
  - `w.Navigate(hctx.ConsoleURL + "/sprite-pet.html")`。
- **宠物页** `web/static/sprite-pet.html`（静态，`http.FileServer` 直服务）：透明 body（color-key 背景色）、只渲染 `#sprite-char` + `#sprite-bubble`，复用 L2 的 `sprite-char.js`（或精简版）；漫游 = `requestAnimationFrame` + `window.movePet(x,y)` 移 HWND；气泡同 L2；dispatch 走 `/api/assistant/*`（同源 localhost）。
- **触发**：tray 菜单加"释放桌面小精灵"项（仿 `addWebviewMenuItem`，line 19-44）→ `openPetWindow`。
- **build variant**：复用 `tray && webview && windows`（宠物是 webview host 的扩展，非新 tag）；或加 `pet` tag 隔离。doc-sync：`docs/build-variants.md` + `PROJECT_MAP.md`。

### 6.4 验证
- `go build -tags "tray webview" -o pet.exe .`（Windows）。
- 手动：tray→释放→桌面出现透明置顶异形小精灵；点击桌面移动；点击角色开气泡输入→dispatch；切 App 页面/关 App 主窗不影响宠物窗口。
- 单元/集成：Win32 调用包成可测函数（`setBorderless(hwnd)`、`setTopmost(hwnd)`、`applyPetRegion(hwnd, ...)`）+ 测试断言 style/region 变化（用 mock 或 `GetWindowLong` 回读）。

### 6.5 风险
- **WebView2 透明背景**：go-webview2 (`jchv/go-webview2`) 是否暴露 `put_DefaultBackgroundColor`（COREWEBVIEW2_COLOR_TRANSSPARENT）需核实；不暴露则 color-key 兜底（有锯齿/抗锯齿边缘问题）。
- **异形 region 抗锯齿**：`SetWindowRgn` 无半透明边，角色边缘可能毛糙——可接受 MVP，后续用 layered window per-pixel alpha 优化。
- **平台限定**：仅 Windows（webview2 + Win32）；mac/Linux 需各自原生（webview2 无；mac 用 WKWebView + NSWindow `isOpaque=false` + `setHasShadow`，Linux GTK）——跨平台是后续大工程。
- **多显示器/DPI**：`SetWindowPos` 坐标须按 DPI 缩放（`GetDpiForWindow`）。
- **go-webview2 API 边界**：region/topmost/layered 都走 HWND 的 Win32（已验证可行），不依赖 webview2 高级 API。

---

## 7. 升级路径与建议顺序

1. **L1 先行**（纯前端、低风险、立即可用客服式交互）：建 `sprite.js` + dock/modal + 接任务 A 端点。这是三级的共同交互内核（对话/dispatch/跳转/执行），L2/L3 复用之。
2. **L2 形象化**（纯前端 + 资产）：spritesheet + 移动 + 气泡；把 L1 的 modal 换成气泡式对话，形象作为入口。`sprite-char.js` 与 `sprite.js` 共享 dispatch 逻辑。
3. **L3 桌面化**（原生）：`openPetWindow` + Win32 + `/sprite-pet.html`，把 L2 的形象/气泡跑在独立透明置顶窗口里。依赖 L2 的角色资产与动画。

每级：`go build` + `node --check` + 浏览器/tray 烟测 + `bash autoresearch.sh`（确保 bench 仍 100%/0 drift，契约未被破坏）。doc-sync：改 `web/static` 同步 `PROJECT_MAP.md` §18.2/§24 + 相关 `docs/*-architecture.md`；改 host/build variant 同步 `docs/build-variants.md`。

## 8. 不变量与诚实约束

- 三级**不改** `cmd/assistant-bench`/`autoresearch.sh`（judge off-limits）；交互层不入 bench 指标（无网络 bench 测的是分派大脑，非 UI）——UI 用浏览器烟测验证。
- 后端分派仍走契约系统（`/api/assistant/*`），新增能力只改 `semantics.json`。
- 主题令牌消费、z-index 用新令牌、新 JS 双 shell 都加且全局声明、不引前端框架/数据库（守 `AGENTS.md`）。
- L3 原生部分限于 Windows（webview2 + Win32），跨平台列为后续。
- 不为交互层"提分"——交互层是产品层，bench 已诚实触顶。
