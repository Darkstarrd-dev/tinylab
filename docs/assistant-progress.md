# Assistant 功能进度文档

> 桌面小精灵助手（Assistant）功能的单一事实来源，供后续仅针对该功能迭代时快速定位。
> 窗口透明/点击穿透/DPI 等宿主级配方见 [`desktop-pet-progress.md`](desktop-pet-progress.md)，本文不重复。
> 最后核对：2026-08-28（新增 §8 F6 Demo 2D 测试台）。

## 1. 功能面总览

| 层 | 位置 | 职责 |
|---|---|---|
| 配置 | `internal/config/types.go` (`AssistantConfig`/`AssistantAction`)、`defaults.go`、`persistence.go`（legacy 迁移） | `model`（LLM 意图分类模型）、`actions[]`（多 action 精灵动画）、`enabled *bool`（功能开关，nil=开）、`debug`（宠物消息日志门控） |
| Settings API | `internal/api/settings/register.go`（`assistantPatch` presence-aware：`model`/`actions`/`enabled` 指针字段区分缺省与显式值）、`internal/petstate`（原子包打通 settings ↔ 宿主，避免 import cycle） | PATCH `/api/settings` → `applyAssistantUpdates`：enabled 变化经 `petstate.SetEnabled` 开/关宠物窗；actions 整表替换 |
| Settings UI | `web/static/settings/settings.js`（Assistant 区块：模型、开关、Debug、Actions 编辑器） | Action 编辑器经 `/api/browse`（native 选图）+ `POST /api/assistant/sheet-preview` 生成预览；保存发整表 `actions` |
| 精灵图服务 | `internal/api/assistant/sheet.go` | `GET /api/assistant/sheet-image/{name}`（按 action 名服务已配置 spritesheet，宠物页免文件系统访问）；`POST /api/assistant/sheet-preview` + `GET /api/assistant/sheet-preview/{id}`（编辑器预览，owner 绑定 + LRU + TTL） |
| 意图分发 | `internal/api/assistant/handler.go`（`dispatch`→`classifyIntent`：LLM 优先 `internal/assistant/llm_classifier.go`，无模型/失败回退关键词 `semantics.json`）、`schema.go`、`events.go`（SSE 广播） | `POST /api/assistant/dispatch` 返回命中的工具；`GET /api/assistant/events` SSE `notify` 事件驱动宠物气泡 |
| 宠物运行时 | `web/static/sprite-pet.html` + `sprite-pet.js`、`host_webview_windows.go::openPetWindow/petOnMessage` | 唯一助手表面（App 内 dock 已废弃，勿恢复）；petSM 状态机 + 页面驱动窗口尺寸 |
| 生命周期 | `internal/petstate`、托盘「释放」（`petWindowsOpen` 防重入）、菜单关闭回写 | 启动 enabled 即开；Settings 开关 OFF 即关 / ON 即开；宠物菜单关闭 = PATCH enabled=false（关闭联动） |
| Demo 测试台 | `web/static/assistant-demo.js`（ademoSM + 平台物理 + 输入 + 碰撞体 + 背景图）、`web/assistant-demo.test.js` | F6/导航第 6 格进入的 2D 游戏测试页；全部行为 demo 页局部（不写配置、不触宠物窗），详见 §8 |

## 2. Action 状态机（petSM，sprite-pet.js）

- **状态** = 配置的 `assistant.actions[]`：启动时 `loadPetActions()` 逐个经 `sheet-image/{name}` 加载，`petSM.register(name, {img, cols, rows, start, end, fps})` 入表（`register` 公开即 VM 测试缝，无需真实图片）。
- **事件解析**：`petSM.dispatch(event)` 按 `EVENT_ALIASES` 别名表取第一个已配置的 action：
  `idle→[idle,stand,default]`、`drag→[drag,grab,move,walk]`、`think→[think,loading,busy,working]`、`reply→[reply,happy,talk,success]`、`error→[error,confused,sad]`、`notify→[notify,alert,notice]`、`poke→[poke,click,wave,greet]`；别名全未配置则事件按精确 action 名匹配；仍未命中 = no-op。
- **默认态**：idle 别名命中者，否则首个注册的 action；默认态循环播放，其余为一次性态——帧区间播完（rAF 渲染循环 `_tick`）自动回默认态。
- **已接入事件**：avatar mousedown→`drag`、mouseup→`idle`；`sendPetIntent`→`think`→成功`reply`/未识别或失败`error`；SSE `notify`→`notify`；双击→`poke`（同时弹输入行）。
- **渲染**：单 rAF 循环 + 每态 fps 累积步进；canvas 背衬 = 单帧原生尺寸 1:1 drawImage。
- **陷阱**：rAF stub 在 VM 测试中同步调用 fn 会令自调度循环无限递归（stub 必须 no-op）；`lastTs` 哨兵用 `null` 不用 `0`（ts=0 撞哨兵）；JS 布局函数引用未定义全局会抛 ReferenceError 且宿主 Eval 静默空转（`setPetScale` 的 `pet` 前车之鉴）。

## 3. 窗口尺寸：页面驱动

- `postPetSize()`：按**当前 action** 帧宽高比把精灵框 contain 进 `300×f`（无 action 回退 `70×f` CSS 脸），窗口 CSS 宽 = 精灵框 + 224（气泡 200 + 间隙 8 + padding 16），高 = max(精灵框, 80) + 16；postMessage `{type:'size', w, h, dpr}`。
- 宿主 `petOnMessage` `"size"` 分支：物理 = CSS × `devicePixelRatio`（0.5..5 之外按 1），40..2000 钳制，`SetWindowPos` + `chromium.Resize()`。初始 300×300 物理仅兜底。
- **宿主不得从 scale f 推物理尺寸**：viewport = 物理/dpi 而非 物理/f——旧 `300×f` 算法在 DPI 缩放显示器上裁剪内容（气泡/输入框被窗口右缘切掉的根因）。缩放 f 纯 CSS：`applyPetScale` 只 Eval `setPetScale(f)`，页面重算后重新 post size。
- 切换 action 时帧宽高比不同 → `play()` 内 `postPetSize()` 自动重调窗口。

## 4. 布局锚定（sprite-pet.html/css + positionBubble）

- 整窗即宠物区（无交流列）；精灵靠屏幕外侧（`body.chat-left` 切 `#pet-area` justify-content），气泡朝屏幕中心。
- `positionBubble()`：按 avatar `getBoundingClientRect` 锚定——8px 间隙、垂直居中、区域内钳制、max-width 随区域收缩；输入行在气泡内部（双击显示、Enter 发送、Esc 隐藏），与回复气泡共享锚点。
- 换边 `updateSide()` 用 `screen.availLeft/availWidth`（当前显示器，多屏正确）；dragend 由宿主 Eval 触发。
- hit 矩形各边 8px 外扩（bounce transform 位移 ±6px 不触发 ResizeObserver + 阴影），防 `SetWindowRgn` 裁边。

## 5. 关闭联动

宠物菜单「关闭桌面宠物」= 关闭功能：页面先 `PATCH /api/settings {assistant:{enabled:false}}`（复用 `applyAssistantUpdates` 持久化 + `petstate.CloseAll`），再 postMessage `close`；Settings 页 Assistant 开关随下次进入页面 `renderEndpoint` 重拉自动 OFF。PATCH 失败（如未登录）也照常关窗。

## 6. 验证

- JS 回归：`node web/sprite-pet-drag.test.js`（VM DOM stub，8 项：拖拽协议 ×3、setPetScale+size 消息、hit 8px 外扩、帧宽高比→size、SM 一次性态回默认、外部脚本契约 ×2）。**注意：「帧宽高比→size」用例 2026-08-28 起在干净树上失败（历史遗留，未修）。**
- Demo 页回归：`node web/assistant-demo.test.js`（19 项，见 §8 验证行）。
- Go：`go build -tags "tray webview"`；`go test ./internal/api/assistant/ ./internal/api/settings/ ./internal/config/`。
- 宠物窗行为验证须在解锁桌面 + webview 变体运行时（headless 无法驱动原生宠物窗）；`PrintWindow` 对 DComp 内容无效，用屏幕截取。**App 内 SPA 页面（含 Demo 页）可用 headless Chrome CDP 验证**：隔离实例（复制 config 改端口）+ `chrome --headless=new --remote-debugging-port` 驱动，经 `window.__ademo` 测试缝断言。

## 7. 变更维护清单（改这些必须同步本文）

| 变更 | 同步位置 |
|---|---|
| `AssistantConfig`/`AssistantAction` 字段 | §1 配置行、`internal/config/persistence.go` legacy 迁移、`settings.js` 编辑器、PROJECT_MAP 对应条目 |
| petSM 别名表 / 事件接入 | §2、`sprite-pet.js` `EVENT_ALIASES`、`web/sprite-pet-drag.test.js` |
| 窗口尺寸协议（size 消息） | §3、`host_webview_windows.go::petOnMessage`、`desktop-pet-progress.md` |
| sheet 端点 / 预览机制 | §1 精灵图服务行、`sheet.go`、`sheet_test.go` |
| dispatch / 分类器 | §1 意图分发行、`internal/assistant/llm_classifier.go`、PROJECT_MAP「小精灵 LLM 分类器」条目 |
| Demo 页（接线/物理/输入/别名表） | §8、`web/static/assistant-demo.js`、`web/assistant-demo.test.js`、PROJECT_MAP 文首最后核对 |

## 8. F6 Demo 页：2D 游戏测试台（web/static/assistant-demo.js）

头部导航第 6 格（原 `nav-placeholder`，col3/row2）= `data-page="demo"` 按钮，F6 = `global.goto-demo`（shortcuts.js 预设；app.js keydown + `case 'demo'` + 切出 `cleanupAssistantDemo`）。双入口 HTML（index.html / index-nopg.html）均挂载。**全部行为 demo 页局部**：不触宠物窗、不写配置、不影响全局 assistant 行为。

- **状态机 `ademoSM`**：状态 = `assistant.actions[]`（经 `/api/assistant/sheet-image/{name}` 加载，与宠物页同数据源）。与 petSM 的差异：**所有态循环播放**（游戏语义，petSM 是一次性回默认）；`setEvent(idle/walk/run/jump/fall)` 别名解析（idle→[idle,stand,default]、walk→[walk,move,run]、run→[run,dash,walk,move]、jump→[jump,leap]、fall→[fall,jump,leap]），未配置事件回退默认态（idle 别名链 → 首个注册）。无动作时渲染占位色块（圆角矩形+眼睛，朝向跟随 facing）。
- **物理**：重力 2200 px/s²、跳跃初速 760、终端速度 1600；速度档 Shift 慢走 70 / 默认 160 / Ctrl 快跑 340 px/s（同时按 Shift 优先）；8ms 子步积分（防高速穿透薄碰撞体）；AABB 轴分离解算（X 撞墙/侧面、Y 落顶/碰头/楔入最小推出）；舞台四壁 + 底部地面。
- **输入**：方向键 ←→ 移动、↑/Space 跳跃（仅 grounded，keydown 沿触发，忽略 repeat）、↓ 空中快落（+1400 px/s²）；右键点舞台 = 走到该列（目标 x 居中，键盘输入即取消）；绘制模式 Escape 退出——**window 捕获阶段监听 + stopPropagation**，否则 app.js 全局 Escape 会弹关机确认。失焦（blur）清空按键态防卡键。
- **碰撞体**：Add Body 进入绘制模式（canvas crosshair），拖绘 ≥8×8 矩形提交；Undo/Clear 按整个列表操作；会话级内存持久（`ademoPersist.bodies`，切页再进保留，重启丢）。
- **背景图**：Set Background 经 `/api/browse` native 选图 + `POST /api/assistant/sheet-preview` 注册 → `GET /sheet-preview/{id}` 加载（复用 sheet.go 1h TTL 机制；路径存 `ademoPersist.bgPath`，每次渲染重新注册拿新 id，TTL 过期无感）；canvas cover 适配绘制；Clear 清除。
- **实体盒**：当前 action 帧尺寸 × scale 滑条（0.5–4，默认 1.5）；切 action/改 scale 保持脚底锚点；canvas 按容器 × devicePixelRatio 缩放（ResizeObserver）。
- **测试缝**：`window.__ademo = {sm, ent, keys, persist, stage, step, tryJump, motionEvent, syncSize, addBody, clearBodies}`。
- **HUD**：canvas 左上角常驻 state/event/ground/facing/x/y/vx/vy/bodies 调试读出（刻意英文原文）。
- **验证**：`node web/assistant-demo.test.js`（19 项：接线契约 ×4、SM ×3、物理 ×8、右键移动 ×3、运动事件 ×1）；浏览器实测（隔离实例 + CDP）：走/慢走/快跑速度、跳跃落地、右键移动到点、绘制碰撞体+站上、绘制模式 Escape 不触发关机、背景图加载与重进重注册、F6 往返导航、切页后键盘监听摘除。
