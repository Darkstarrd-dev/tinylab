# Assistant 功能进度文档

> 桌面小精灵助手（Assistant）功能的单一事实来源，供后续仅针对该功能迭代时快速定位。
> 窗口透明/点击穿透/DPI 等宿主级配方见 [`desktop-pet-progress.md`](desktop-pet-progress.md)，本文不重复。
> 最后核对：2026-08-29（Topdown 右键移动、背景模式+合并按钮、方向变体 action/翻转抑制、预设补全 pet、分组折叠、游戏组 Trigger）。

## 1. 功能面总览

| 层 | 位置 | 职责 |
|---|---|---|
| 配置 | `internal/config/types.go` (`AssistantConfig`/`AssistantAction`)、`defaults.go`、`persistence.go`（legacy 迁移） | `model`（LLM 意图分类模型）、`actions[]`（多 action 精灵动画）、`enabled *bool`（功能开关，nil=开）、`debug`（宠物消息日志门控） |
| Settings API | `internal/api/settings/register.go`（`assistantPatch` presence-aware：`model`/`actions`/`enabled` 指针字段区分缺省与显式值）、`internal/petstate`（原子包打通 settings ↔ 宿主，避免 import cycle） | PATCH `/api/settings` → `applyAssistantUpdates`：enabled 变化经 `petstate.SetEnabled` 开/关宠物窗；actions 整表替换 |
| Settings UI | `web/static/settings/settings.js`（Assistant 区块）、`settings_modal.js`（弹窗壳 + 三个预设按钮）、`settings_assistant.js`（模型选择器、Actions 编辑器、**动作预设** `assistantAddPreset`：pet=[idle,drag,think,reply,error,notify,poke] / platformer=[idle,walk,walk_left,run,run_left,jump,fall] / topdown=[idle,walk_up,walk_down,walk_left,walk_up_left,walk_down_left,attack]，仅补缺失名；**分组折叠**：Actions 列表按预设归属分 Pet/Platformer/Topdown/Other 四桶（`assistantActionGroupOf`，空 Other 隐藏），状态机面板按 `__assistantSMGroups` 三组，统一 `assistantGroupHeader` + `assistantToggleGroup`（折叠态 `__assistantGroupCollapsed`，两面板键名大小写不同互相独立）；**Trigger**：pet 域→宠物 dispatch，demo 域→`assistantTriggerDemoState`（驱动同上下文 `__ademo.sm.setEvent`，Demo 页未开时 toast 提示）；别名表含全部方向变体及回退链） | Action 编辑器经 `/api/browse`（native 选图）+ `POST /api/assistant/sheet-preview` 生成预览；保存发整表 `actions` |
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

- **Demo 类型切换**：工具栏一级 `ADEMO_TYPES` 下拉（scroller/topdown/isometric，i18n `demoType*`）+ 二级子类型下拉（`demoSub*`：Scroller→Platformer、Topdown→Survivor、Isometric→Tactic）。`ademoSetType(t1,t2)` 清输入态/aim/攻击窗并按类型重生实体（scroller 左下角、topdown 居中）；选择持久于 `ademoPersist.type1/type2`。**Isometric/Tactic 为空白占位**：`ademoTypeImplemented()` 返回 false → `ademoLoop` 跳过物理/SM，`ademoDraw` 画居中 “coming soon” 文本与提示行（`demoHintTactic`）。
- **状态机 `ademoSM`**：状态 = `assistant.actions[]`（经 `/api/assistant/sheet-image/{name}` 加载，与宠物页同数据源）。与 petSM 的差异：**所有态循环播放**（游戏语义，petSM 是一次性回默认）；`setEvent` 别名解析（idle/walk/run/jump/fall/attack + **方向变体** walk_left/run_left/walk_up/walk_down/walk_up_left/walk_down_left，变体链回退到基础动画）；未配置事件回退默认态（idle 别名链 → 首个注册）。**左向变体抑制镜像**：`currentIsLeftVariant()`（action 名含 `_left`）为 true 时渲染不再水平翻转（帧本身已朝左）。无动作时渲染占位色块（圆角矩形+眼睛，朝向跟随 facing）。
- **物理（Scroller/Platformer）**：重力 2200 px/s²、跳跃初速 760、终端速度 1600；速度档 Shift 慢走 70 / 默认 160 / Ctrl 快跑 340 px/s（同时按 Shift 优先）；8ms 子步积分（防高速穿透薄碰撞体）；AABB 轴分离解算（X 撞墙/侧面、Y 落顶/碰头/楔入最小推出）；舞台四壁 + 底部地面。跳跃/快落仅 scroller（`ademoTryJump` 按 `type1` 门控）。
- **物理（Topdown/Survivor，`ademoSubstepTopdown`）**：无重力 8 向移动（WASD+方向键，对角 ×√½ 归一），同套三档速度；**鼠标瞄准**：光标在舞台上时 facing 跟随鼠标（`ademoAim`，mouseleave 失效后回退移动方向）；左键/空格 = 攻击（`ademoAttack` → `attackUntil=Date.now()+400ms`，`ademoMotionEvent` 窗口内返回 `attack`）；**右键 = 移动到点**（`moveTarget {x,y}` 2D 目标，实体居中钳制，直线 walk 速度前往，到达清除，任意键盘输入取消；scroller 下 `y=null` 仅用 x）；AABB 轴分离撞体 + 舞台四壁钳制；onGround 恒 true（HUD 一致）。**方向事件**：`moveDir` 记录当前子步归一意图向量，`ademoMotionEvent` 映射 walk_up/walk_down/walk_left/walk_up_left/walk_down_left（右/右上/右下用基础 walk + 翻转）；scroller 左移映射 walk_left/run_left；Ctrl 快跑恒为 run/run_left。
- **碰撞体**：Add Body 进入绘制模式（canvas crosshair），拖绘 ≥8×8 矩形提交；Undo/Clear 按整个列表操作；会话级内存持久（`ademoPersist.bodies`，切页再进保留，重启丢）。
- **背景图**：**单按钮合并**（无 bgPath = Set Background… 选图，有 = Clear Background，标签/ghost 样式随 `ademoSyncToolbar` 切换）+ **模式下拉** `ademoPersist.bgMode`（fit-width 默认 / fit-height / pixel 1:1，`ademoBgScale(mode,iw,ih,W,H)` 纯函数，居中绘制）。选图经 `/api/browse` native + `POST /api/assistant/sheet-preview` 注册 → `GET /sheet-preview/{id}` 加载（复用 sheet.go 1h TTL 机制；路径存 `ademoPersist.bgPath`，每次渲染重新注册拿新 id，TTL 过期无感）。
- **实体盒 / 缩放**：当前 action 帧尺寸 × scale（滑条 **0.01–1.00**，步进 0.01，旧 0.5–4 会话值渲染时钳入）；**ScaleTo W/H 输入框**：输入任一像素尺寸，另一边按帧宽高比自动算（`scale = 目标 ÷ 帧尺寸`，同样钳 0.01–1.00）。滑条与 W/H 三控件经唯一入口 `ademoApplyScale` 联动（`ademoSyncEntitySize` 尾部 `ademoSyncScaleControls` 回写；聚焦中的输入框不回写防打字抖动；切 action 帧尺寸变化也刷新）。切 action/改 scale 保持脚底锚点；canvas 按容器 × devicePixelRatio 缩放（ResizeObserver）。
- **测试缝**：`window.__ademo = {sm, ent, keys, aim, persist, stage, step, tryJump, attack, setType, spawn, bgScale, applyScale, frameRef, motionEvent, syncSize, addBody, clearBodies}`。
- **HUD**：canvas 左上角常驻 state/event/ground/facing/x/y/vx/vy/bodies 调试读出（刻意英文原文）。
- **验证**：`node web/assistant-demo.test.js`（34 项：接线契约 ×4、SM ×4、平台物理 ×8、右键移动 ×3、运动事件 ×1、topdown ×8、方向事件 ×3、背景模式 ×1、类型/缩放/i18n 键 ×3）；浏览器实测（隔离实例 20199 + headless CDP，2026-08-29 二轮）：topdown 右键走到点击点并清除、背景按钮 Set↔Clear 随 bgPath 翻转 + 模式下拉持久、预设三组 18 动作（仅补缺失）、Actions/矩阵分组折叠互不干扰、demo 域 Trigger 无 Demo 页时 toast 守卫；一轮实测：类型下拉三级切换、ScaleTo 联动与钳制、WASD 对角移动、左键/空格 attack、鼠标瞄准朝向、Isometric 占位渲染、scroller 跳跃回归；旧实测：碰撞体绘制/站上、绘制模式 Escape 不触发关机、背景图重注册、F6 往返导航、切页监听摘除。
