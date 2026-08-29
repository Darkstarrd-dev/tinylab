# Assistant 功能进度文档

> 桌面小精灵助手（Assistant）功能的单一事实来源，供后续仅针对该功能迭代时快速定位。
> 窗口透明/点击穿透/DPI 等宿主级配方见 [`desktop-pet-progress.md`](desktop-pet-progress.md)，本文不重复。
> 最后核对：2026-08-29（六项重整：8向显式直驱 + Preset持久化下拉 + Mirror纵向/持久化 + async死锁 + Demo右向修正；详情见 PROJECT_MAP 顶置本轮条目，`sprite-pet-drag.test.js` «wide» 1项仍为2026-08-28旧遗留见§6）。

## 1. 功能面总览

| 层 | 位置 | 职责 |
|---|---|---|
| 配置 | `internal/config/types.go` (`AssistantConfig`/`AssistantAction`)、`defaults.go`、`persistence.go`（legacy 迁移） | `model`（LLM 意图分类模型）、`actions[]`（多 action 精灵动画）、`enabled *bool`（功能开关，nil=开）、`debug`（宠物消息日志门控） |
| Settings API | `internal/api/settings/register.go`（`assistantPatch` presence-aware：`model`/`actions`/`presets`/`enabled` 指针字段区分缺省与显式值）、`internal/petstate`（原子包打通 settings ↔ 宿主，避免 import cycle） | PATCH `/api/settings` → `applyAssistantUpdates`：enabled 变化异步经 `petstate` 开/关宠物窗（不阻塞 HTTP handler）；actions/presets 整表替换 |
| Settings UI | `web/static/settings/settings.js`（Assistant 区块）、`settings_modal.js`（弹窗壳 + Preset 下拉/添加/应用/保存/移除 + Move/Pet/Platformer/Topdown 预设按钮）、`settings_assistant.js`（模型选择器、Actions 编辑器、**动作预设** `assistantAddPreset`：Move=`idle/move_*` 8 向 + idle（共享）、Pet=[drag,think,reply,error,notify,poke]、Platformer=[jump,fall]、Topdown=[attack]，仅补缺失名；Assistant Preset 持久化 `AssistantPreset[]`（`window.__assistantPresets` + `__assistantPresetSel`/`renderAssistantPresetBar`/`assistantApplyPresetBundle`/`assistantSaveCurrentAsPreset`/`assistantRemovePresetBundle` 存 `assistant.presets`）；**分组折叠**：Actions 列表按归属分 Move/Pet/Platformer/Topdown/Other 五桶（`assistantActionGroupOf`：Move 先判，空 Other 隐藏），状态机面板按 `__assistantSMGroups`：Move(9)/Pet(6)/Platformer(2)/Topdown(1)，统一 `assistantGroupHeader` + `assistantToggleGroup`（折叠态 `__assistantGroupCollapsed`）；**Trigger**：pet 域→宠物 dispatch，demo 域→`assistantTriggerDemoState`（驱动同上下文 `__ademo.sm.setEvent`，Demo 页未开时 toast 提示）；**Move 自动镜像**：`move_left`↔`move_right` 等 3 对，右侧镜像以首参带 `mirror:true` 自动补齐，已存在则可覆写不重复创建；编辑器 Mirror 改纵向（文字在上控件在下）并持久化 `mirror`） | Action 编辑器经 `/api/browse`（native 选图）+ `POST /api/assistant/sheet-preview`，网格分割（cols×rows）+ 0 起始帧范围（row-major）+ fps + `mirror`（纵向布局）；...
| 精灵图服务 | `internal/api/assistant/sheet.go` | `GET /api/assistant/sheet-image/{name}`（按 action 名服务已配置 spritesheet，宠物页免文件系统访问）；`POST /api/assistant/sheet-preview` + `GET /api/assistant/sheet-preview/{id}`（编辑器预览，owner 绑定 + LRU + TTL） |
| 意图分发 | `internal/api/assistant/handler.go`（`dispatch`→`classifyIntent`：LLM 优先 `internal/assistant/llm_classifier.go`，无模型/失败回退关键词 `semantics.json`）、`schema.go`、`events.go`（SSE 广播） | `POST /api/assistant/dispatch` 返回命中的工具；`GET /api/assistant/events` SSE `notify` 事件驱动宠物气泡 |
| 宠物运行时 | `web/static/sprite-pet.html` + `sprite-pet.js`、`host_webview_windows.go::openPetWindow/petOnMessage` | 唯一助手表面（App 内 dock 已废弃，勿恢复）；petSM 状态机 + 页面驱动窗口尺寸 |
| 生命周期 | `internal/petstate`、托盘「释放」（`petWindowsOpen` 防重入）、菜单关闭回写 | 启动 enabled 即开；Settings 开关 OFF 即关 / ON 即开；宠物菜单关闭 = PATCH enabled=false（关闭联动） |
| Demo 测试台 | `web/static/assistant-demo.js`（ademoSM + 平台物理 + 输入 + 碰撞体 + 背景图）、`web/assistant-demo.test.js` | F6/导航第 6 格进入的 2D 游戏测试页；全部行为 demo 页局部（不写配置、不触宠物窗），详见 §8。页面下方为游戏插件区（`web/static/demo-games.js`，架构见 gamedemo-progress.md），游戏运行时经 `__ademo.setPaused` 冻结本测试台 |

## 2. Action 状态机（petSM，sprite-pet.js）

- **状态** = 配置的 `assistant.actions[]`：启动时 `loadPetActions()` 逐个经 `sheet-image/{name}` 加载，`petSM.register(name, {img, cols, rows, start, end, fps, mirror})` 入表（`mirror` 持久为 `AssistantAction.Mirror`，编辑器内为按帧位移镜像的单帧翻转托管；`register` 公开即 VM 测试缝，无需真实图片）。
- **事件解析**：`petSM.dispatch(event)` 按 `EVENT_ALIASES` 别名表取第一个已配置的 action：
  `idle→[idle,stand,default]`、`drag→[drag,grab,move,walk]`、`think→[think,loading,busy,working]`、`reply→[reply,happy,talk,success]`、`error→[error,confused,sad]`、`notify→[notify,alert,notice]`、`poke→[poke,click,wave,greet]`；
  `move_*`（8 向 + idle 显式 8 方向，均直接以方向 action 名命中，无自动翻转回退；`move_right`/`move_up_right`/`move_down_right` 不再经 `_mirrorPending` 回退左像，必须显式配置或由编辑器自动镜像补齐）与 legacy `walk_*` 双轨别名（`move_*` 优先，`walk_*` 回退链含 `move_*`，兼容旧存量）；
  未命中则按精确 action 名匹配，仍未命中 = no-op。默认态为 idle 别名链，其余一次性态；编辑器预览走 `sheet-image`（杜绝 `file://` 禁载）且镜向为选中帧单帧翻转。
- **默认态**：idle 别名命中者，否则首个注册的 action；默认态循环播放，其余为一次性态——帧区间播完（rAF 渲染循环 `_tick`）自动回默认态。
- **已接入事件**：avatar mousedown→`drag`、mouseup→`idle`；`sendPetIntent`→`think`→成功`reply`/未识别或失败`error`；SSE `notify`→`notify`；双击→`poke`（同时弹输入行）。
- **渲染与镜像**：单 rAF 循环 + 每态 fps 累积；`states[].mirror === true` 时画布水平镜像（`scale(-1,1)`），否则原样（取消方向回退自动镜像，8 方向显式配置）。
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
- Demo 页回归：`node web/assistant-demo.test.js`（见 §8 验证行；含 Move 8 向 + walk 兼容、motionEvent/SCroller 回退、类型/缩放/i18n 键等）。
- Go：`go build -tags "tray webview"`；`go test ./internal/api/assistant/ ./internal/api/settings/ ./internal/config/`。
- 宠物窗行为验证须在解锁桌面 + webview 变体运行时（headless 无法驱动原生宠物窗）；`PrintWindow` 对 DComp 内容无效，用屏幕截取。**App 内 SPA 页面（含 Demo 页）可用 headless Chrome CDP 验证**：隔离实例（复制 config 改端口）+ `chrome --headless=new --remote-debugging-port` 驱动，经 `window.__ademo` 测试缝断言。

## 7. 变更维护清单（改这些必须同步本文）

| 变更 | 同步位置 |
|---|---|
| `AssistantConfig`/`AssistantAction.Mirror`/`AssistantPreset` 字段 | §1-§2 配置+状态机行、`internal/config/types.go`+`persistence.go` legacy 迁移、`settings.js`/`settings_assistant.js`/`settings_modal.js` 编辑器（Mirror 开关/按帧预览+Preset bar `__assistantPresets`/`__assistantPresetSel`）、`i18n.js`、`PROJECT_MAP` 对应条目 |
| petSM/ademoSM 别名表 / 事件接入 / Move 共享分组 | §2/§8、`sprite-pet.js`/`assistant-demo.js` `EVENT_ALIASES`（`move_*` 8 向显式 + `walk_*` 兼容，取消 `_mirrorPending` 自动回退）、`web/sprite-pet-drag.test.js` |
| Mirror 渲染与状态机回退镜像 | §2/§8、`sprite-pet.js`/`assistant-demo.js` 的 `states[].mirror` 直驱镜像（已取消 facing/_mirrorPending 自动翻转）、`settings_assistant.js` 的镜像预览（纵向布局）/自动配对 |
| Actions 分组/预设/状态机面板与自动镜像策略 | §1/§8、`settings_assistant.js`（`__assistantMoveActions`/`__assistantMoveMirrorPairs` + `assistantAddPreset`/`assistantSaveActionEditor` + Preset bar）与矩阵 `__assistantSMGroups` |
| 窗口尺寸协议（size 消息） | §3、`host_webview_windows.go::petOnMessage`、`desktop-pet-progress.md` |
| sheet 端点 / 预览机制 | §1 精灵图服务行、`sheet.go`、`sheet_test.go` |
| dispatch / 分类器 | §1 意图分发行、`internal/assistant/llm_classifier.go`、PROJECT_MAP「小精灵 LLM 分类器」条目 |
| Demo 页（接线/物理/输入/别名表/方向事件/8 向显式/暂停缝） | §8、`web/static/assistant-demo.js`（`ademoMotionEvent` 8 向 + platformer `move_right` 修正、`ademoDraw`/`ademoSM` 取消自动翻转）、`web/assistant-demo.test.js`、PROJECT_MAP 文首最后核对；游戏插件区侧见 `docs/gamedemo-progress.md` §9 |

## 8. F6 Demo 页：2D 游戏测试台（web/static/assistant-demo.js）

头部导航第 6 格（原 `nav-placeholder`，col3/row2）= `data-page="demo"` 按钮，F6 = `global.goto-demo`（shortcuts.js 预设；app.js keydown + `case 'demo'`（先 `renderAssistantDemo` 再 `renderDemoGames` 追加游戏区）+ 切出 `cleanupAssistantDemo`/`cleanupDemoGames`）。双入口 HTML（index.html / index-nopg.html）均挂载。**全部行为 demo 页局部**：不触宠物窗、不写配置、不影响全局 assistant 行为。

- **Demo 类型切换**：工具栏一级 `ADEMO_TYPES` 下拉（scroller/topdown/isometric，i18n `demoType*`）+ 二级子类型下拉（`demoSub*`：Scroller→Platformer、Topdown→Survivor、Isometric→Tactic）。`ademoSetType(t1,t2)` 清输入态/aim/攻击窗并按类型重生实体（scroller 左下角、topdown 居中）；选择持久于 `ademoPersist.type1/type2`。**Isometric/Tactic 为空白占位**：`ademoTypeImplemented()` 返回 false → `ademoLoop` 跳过物理/SM，`ademoDraw` 画居中 “coming soon” 文本与提示行（`demoHintTactic`）。
- **状态机 `ademoSM`**：状态 = `assistant.actions[]`（经 `/api/assistant/sheet-image/{name}` 加载，与宠物页同数据源）。与 petSM 的差异：**所有态循环播放**（游戏语义，petSM 是一次性回默认）；`setEvent` 别名解析（idle/walk/run/jump/fall/attack + **方向变体** `move_*` 8 向共享（`move_left/right/up/down/up_left/down_left/up_right/down_right`）与 `walk_*` 兼容，双轨回退链；未配置事件回退默认态（idle 别名链 → 首个注册）。**镜像语义**：`states[].mirror === true` 时水平翻转（不再有右向→左像自动回退，8 方向显式配置）；`currentIsLeftVariant()`/`isMirrorPending()` 仅保留为测试缝。无动作时渲染占位色块（圆角矩形+眼睛，朝向跟随 facing）。
- **物理（Scroller/Platformer）**：重力 2200 px/s²、跳跃初速 760、终端速度 1600；速度档 Shift 慢走 70 / 默认 160 / Ctrl 快跑 340 px/s（同时按 Shift 优先）；8ms 子步积分（防高速穿透薄碰撞体）；AABB 轴分离解算（X 撞墙/侧面、Y 落顶/碰头/楔入最小推出）；舞台四壁 + 底部地面。跳跃/快落仅 scroller（`ademoTryJump` 按 `type1` 门控）。
- **物理（Topdown/Survivor，`ademoSubstepTopdown`）**：无重力 8 向移动（WASD+方向键，对角 ×√½ 归一），同套三档速度；**鼠标瞄准**：光标在舞台上时 facing 跟随鼠标（`ademoAim`，mouseleave 失效后回退移动方向）；左键/空格 = 攻击（`ademoAttack` → `attackUntil=Date.now()+400ms`，`ademoMotionEvent` 窗口内返回 `attack`）；**右键 = 移动到点**（`moveTarget {x,y}` 2D 目标，实体居中钳制，直线 walk 速度前往，到达清除，任意键盘输入取消；scroller 下 `y=null` 仅用 x）；AABB 轴分离撞体 + 舞台四壁钳制；onGround 恒 true（HUD 一致）。**方向事件**：`moveDir` 记录归一意图向量，`ademoMotionEvent` 映射 `move_up/down/left/up_left/down_left/up_right/right/down_right`（共享 Move 显式 8 向；scroller：`move_left`/`run_left` vs `move_right`/`run`；Topdown 右侧为 `move_right`/`run`）；Ctrl 快跑对应 `run`/`run_left`。
- **碰撞体**：Add Body 进入绘制模式（canvas crosshair），拖绘 ≥8×8 矩形提交；Undo/Clear 按整个列表操作；会话级内存持久（`ademoPersist.bodies`，切页再进保留，重启丢）。
- **背景图**：**单按钮合并**（无 bgPath = Set Background… 选图，有 = Clear Background，标签/ghost 样式随 `ademoSyncToolbar` 切换）+ **模式下拉** `ademoPersist.bgMode`（fit-width 默认 / fit-height / pixel 1:1，`ademoBgScale(mode,iw,ih,W,H)` 纯函数，居中绘制）。选图经 `/api/browse` native + `POST /api/assistant/sheet-preview` 注册 → `GET /sheet-preview/{id}` 加载（复用 sheet.go 1h TTL 机制；路径存 `ademoPersist.bgPath`，每次渲染重新注册拿新 id，TTL 过期无感）。
- **实体盒 / 缩放**：当前 action 帧尺寸 × scale（滑条 **0.01–1.00**，步进 0.01，旧 0.5–4 会话值渲染时钳入）；**ScaleTo W/H 输入框**：输入任一像素尺寸，另一边按帧宽高比自动算（`scale = 目标 ÷ 帧尺寸`，同样钳 0.01–1.00）。滑条与 W/H 三控件经唯一入口 `ademoApplyScale` 联动（`ademoSyncEntitySize` 尾部 `ademoSyncScaleControls` 回写；聚焦中的输入框不回写防打字抖动；切 action 帧尺寸变化也刷新）。切 action/改 scale 保持脚底锚点；canvas 按容器 × devicePixelRatio 缩放（ResizeObserver）。
- **暂停缝（2026-08-29 新增）**：`__ademo.setPaused(bool)` 冻结物理/SM 步进（`ademoLoop` 跳过 step 与 SM tick，画面定格继续渲染），供同页运行的游戏插件独占键盘输入；`isPaused()` 查询。游戏插件区（`demo-games.js`）启动/停止/切页时调用。
- **测试缝**：`window.__ademo = {sm, ent, keys, aim, persist, stage, step, tryJump, attack, setType, spawn, bgScale, applyScale, frameRef, motionEvent, syncSize, addBody, clearBodies, setPaused, isPaused}`。
- **HUD**：canvas 左上角常驻 state/event/ground/facing/x/y/vx/vy/bodies 调试读出（刻意英文原文）。
- **验证**：`node web/assistant-demo.test.js`（34 项 + Move 3 项方向事件，i18n 断言含 `assistantPresetMove`/`assistantGroupMove`）：接线契约 ×4、SM ×4、平台物理 ×8、右键移动 ×3、运动事件 ×1、topdown ×8、方向事件 ×3、背景模式 ×1、类型/缩放/i18n 键 ×3；浏览器/VM 已覆盖 Move 共享与 Mirror 回退；实测（隔离实例 20199 + headless CDP，2026-08-29 二轮）：topdown 右键走到点击点并清除、背景按钮 Set↔Clear 随 bgPath 翻转 + 模式下拉持久、Actions/矩阵分组折叠与 Trigger 守卫、F6/类型切换/ScaleTo 钳制/WASD 对角/attack/瞄准/Isometric 占位均通过。
