# 桌面宠物（桌面小精灵）最小验证进度文档

> 日期：2026-08-25
> 位置：`C:/opencode/webview-pet-test/`（独立于 tinyrouter 项目的最小验证工程）
> 目标：脱离项目验证「WebView2 + 透明 PNG 桌宠」的完整交互配方，稳定后移植进
> `host_webview_windows.go` 的 `openPetWindow`。

## 1. 已验证成立的核心配方（透明）

前几轮在项目中失败（`127edd4`、`2f5a754`）的根因：

- `DefaultBackgroundColor=透明` 只让 WebView 内容透出**宿主窗口**，不透出桌面。
- 项目里用的 `DwmExtendFrameIntoClientArea(-1)` 是错误 API，不启用逐像素 alpha 合成。
- `WS_EX_LAYERED` / `LWA_COLORKEY`（品红方案）与 WebView2 的 DirectComposition 渲染冲突，
  colorkey 只作用于父窗口表面，看不见 WebView2 子 HWND 的内容。

社区已验证配方（来源 jeweg/win32-window-transparency `05_perpixel_alpha.cpp`、
WebView2Feedback #2419/#5269、GLFW `GLFW_TRANSPARENT_FRAMEBUFFER` 同机制），已实测通过：

1. 窗口类 `hbrBackground = GetStockObject(BLACK_BRUSH)` → 重定向表面 alpha=0
2. `DwmEnableBlurBehindWindow` + 空区域 `CreateRectRgn(0,0,-1,-1)`，
   flags `DWM_BB_ENABLE|DWM_BB_BLURREGION` → DWM 按 alpha 通道逐像素合成（无模糊）
3. **禁止** `WS_EX_LAYERED` / colorkey
4. `WEBVIEW2_DEFAULT_BACKGROUND_COLOR=00000000` 必须在 WebView2 环境创建**之前**设置
5. Controller 就绪后 `ICoreWebView2Controller2.PutDefaultBackgroundColor({A:0,R:0,G:0,B:0})`
6. HTML `html/body` 不得设不透明背景

像素级验证：隐藏窗口前后同区域截屏对比，仅 logo 光晕范围内像素不同（半透明混合），
四角边缘完全一致；截图中可直接读出背后窗口文字。透明确认成立。

## 2. 工程结构

```
webview-pet-test/
├── go.mod          # 依赖 jchv/go-webview2（与项目同版本）+ golang.org/x/sys
├── main.go         # 纯 syscall 自建 HWND + edge.Chromium.Embed，无 CGO
├── pet.html        # 宠物 UI（透明背景 + 交互）
└── pet-test.exe
```

关键实现点（main.go）：

- `edge.NewChromium()` + `chromium.Embed(hwnd)`：库支持嵌入自建窗口（无需用库的
  `webview.New()`，那会自建窗口类，拿不到 BLACK_BRUSH）。
- `chromium.MessageCallback`：接收 `window.chrome.webview.postMessage` 的字符串消息。
- `chromium.Resize()`：WM_SIZE 时同步 webview 边界（内部自取客户区）。
- Controller 异步就绪：Embed 后 pump 消息直到 `GetController() != nil`。

## 3. 交互实现状态（按用户需求迭代中）

| 功能 | 状态 | 实现 |
|---|---|---|
| 拖拽移动 | ✅ 已验证可用 | JS 左键 mousedown/mousemove → postMessage → 宿主 `GetCursorPos` 差值 + `SetWindowPos`（纯物理像素，DPI 安全；JS 侧 ≥2px 节流）。用户实测拖动成功。 |
| 缩放比 | ✅ 已验证 | 菜单项 50%–150% → `applyScale`：窗口宽 = 300×f + 260（聊天列固定物理宽），高恒 300；JS `setScale` 只缩放宠物区（petwrap 宽 300×f、图 220×f），气泡/输入框不缩放。50% 实测：窗口 410×300，宠物半尺寸，气泡原尺寸可读。 |
| 右键菜单 | ⚠️ 调试中 | JS mousedown(button=2) → postMessage → 宿主。消息链路已通（日志确认 `webmsg: menu`），但 `TrackPopupMenu` 在 COM 回调上下文内立即返回 0（菜单不显示）。**已改为**：回调内仅 `PostMessageW(WM_APP+1)`，在主消息循环 wndProc 顶层弹菜单——此修复刚编译，待验证。另已加 `SetForegroundWindow` 前置调用。默认网页菜单已用 `PutAreDefaultContextMenusEnabled(false)` 禁用。 |
| 精灵气泡 | ✅ 布局定稿 | 单条气泡（`rgba(255,255,255,0.92)` 半透明，内容像素自带 alpha），位于宠物侧面，内容原位更新（非堆叠流）。 |
| 用户输入 | ✅ 布局定稿 | 底部常驻输入框，Enter 发送 → 气泡先显示 `…` 再更新为回执（测试用回显；正式版由宿主/模型回复）。 |
| 气泡换边 | ✅ 代码就绪 | `updateSide()`：宠物在屏幕右半 → 列在左（flex row-reverse）；dragend 时宿主 Eval 触发。 |
| 自适应气泡 | ✅ | 无 max-height/滚动条，`width:fit-content` 自适应。 |
| 右键菜单 | ✅ 已验证（HTML 方案） | Win32 `TrackPopupMenu` 路线废弃：WebView2 子窗口（Chromium）持有鼠标捕获，与菜单捕获冲突，即使窗口前台仍立即返回 0（日志多次实证 `fg_owned=true, track cmd=0`）。最终方案：HTML 自定义菜单（页面内绝对定位面板），菜单项 postMessage（`close`/`scale`）给宿主执行原生动作。用户实测生效。 |
窗口布局：默认 `560×300`，左 300px 宠物区 + 右 260px 交流列。
缩放只作用于宠物区：窗口宽 = 300×f + 260，高恒 300，聊天列物理尺寸不变。
注意：不要用 `body zoom`（曾试过，`100vw/vh` 视口单位不随 zoom 缩放导致裁剪）。

## 4. 已知问题 / 待办

1. **右键菜单显示**：`WM_APP+1` 延迟弹出方案待验证（刚编译）。
2. 调试残留：main.go 有 fmt.Println 日志——移植前清理（pet.html 的 dbg 监听已清）。
3. 未做：点击穿透（透明区域点击落到窗口）、开机自启、多显示器边界、DPI aware 声明
   （当前进程 DPI unaware，100% 缩放下正常；高 DPI 需 `SetProcessDpiAwarenessContext` +
   物理像素尺寸换算）。
4. 移植注意：项目现有 `openPetWindow` 用 `webview.New()`（库自建窗口类），必须改为
   自建窗口类（BLACK_BRUSH）+ `edge.Chromium.Embed`，才能满足配方第 1 条。

## 5. 验证手段（本机浏览器工具不可用）

- PowerShell `CopyFromScreen` 截窗口区域 → `read` 查看图片（视觉确认）。
- 隐藏窗口前后像素 diff（严格透明验证）。
- `user32 WindowFromPoint` 确认点击命中。
- 宿主进程 stdout 日志（hub logs）确认 JS→宿主消息链路。
- `mouse_event` 合成点击（注意：用户正在拖动窗口时合成点击会脱靶）。


## 6. Norma（github.com/skye-z/Norma）借鉴结论

Norma = Wails v2.11 框架（`Frameless + AlwaysOnTop + WindowIsTranslucent + BackdropType:None`），
其透明能力全部来自 Wails 内部实现（已读 v2.11.0 源码验证）：

1. **`WS_EX_NOREDIRECTIONBITMAP`**（`WindowIsTranslucent` 时加在窗口扩展样式上）——
   直接去掉 GDI 重定向表面，WebView2 的 DComp 视觉直通 DWM 合成。这是与本项目
   当前配方的核心差异；我们的 BLACK_BRUSH + DwmEnableBlurBehindWindow 是等效的
   另一条路，两者都已实证透明。移植时可二选一，Norma/Wails 路线更"生产"。
2. Win11 22H2+（build 22621+）：`DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, None)`。
   Win10 降级路径：`SetWindowCompositionAttribute(ACCENT_ENABLE_BLURBEHIND)`（空 policy）。
3. WebView2 透明：同样依赖 `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` env（与我们一致）。

Norma 自身的应用层实现可直接借鉴：

| 功能 | Norma 实现 | 借鉴点 |
|---|---|---|
| 点击穿透 | 80ms 轮询：光标在宠物交互矩形内→关 `WS_EX_TRANSPARENT`，否则开（`GWL_EXSTYLE` 直改） | 自动穿透模式，比手动开关好 |
| 隐藏任务栏项 | `WS_EX_TOOLWINDOW`，去掉 `WS_EX_APPWINDOW` | 我们已用 TOOLWINDOW |
| 置顶维持 | 轮询 `SetWindowPos(HWND_TOPMOST)` 兜底 | 可选 |
| 眼睛跟随鼠标 | 轮询光标归一化坐标 + 0.35 插值平滑 → 发给前端 | 宠物动效可后期加 |
| 拖拽 | Wails `--wails-draggable` CSS（框架内置） | 不可直接借鉴，我们的 postMessage 拖拽已可用 |
| 右键 | 仅 JS `preventDefault`（无原生菜单） | 我们的 TrackPopupMenu 方案更符合需求 |

参考副本：`C:/opencode/tinyrouter/reference/norma-ref/`（浅克隆，只读，已加入 .gitignore）。
关键文件：`backend/core/desktop/app.go`、`backend/core/desktop/window_clickthrough_windows.go`。

---

## 7. 项目移植（2026-08-25 完成）

最小验证通过后移植进项目本体，改动：

- `host_webview_windows.go::openPetWindow` 整体重写：
  - 自建窗口类 `TinyRouterPetWnd`（BLACK_BRUSH 类画刷）+ `DwmEnableBlurBehindWindow` 空区域
  - `edge.Chromium.Embed` 直嵌自建 HWND（`webview2.New` 的自建窗口类不透明，不可用）
  - 交互 postMessage 协议（`petOnMessage`）：拖拽（宿主光标差值）、close、scale
  - 布局：宠物区 300*f + 交流列固定 260，窗口宽 = 300*f + 260、高恒 300
- `web/static/sprite-pet.html`：宠物区 + 交流列布局（气泡上/输入框下，不叠加宠物本体），
  HTML 右键菜单（关闭 + 缩放），`html/body` 弃用 vw/vh
- `web/static/sprite-pet.js`：Bind 宿主对象迁移到 postMessage；`setPetScale`/`updateSide`
  由宿主 Eval 触发；换边用 `screen.availLeft/availWidth`（多显示器正确）

### 移植期踩坑（重要）

1. **`webviewWindowMu` 死锁**：`openWebviewWindow` 以 `defer` 持有该锁直至主窗口关闭；
   宠物路径取同一把锁会永久阻塞——"单独测试成功、项目里无反应"的根因。
   宠物已不用 `webview2.New`（该锁的保护目标），不再取锁。
2. **隐藏父窗口 → DComp 不渲染**：controller 在隐藏窗口上创建后，事后 ShowWindow
   不会触发帧提交，窗口永久透明不可见。必须创建即可见（本配方空窗口本就全透明，无白闪）。
3. **诊断手段**：临时 `TINYROUTER_AUTO_PET=1` 环境变量 + 入口日志定位（已移除）；
   `FindWindowW` 探测须 `CharSet=CharSet.Unicode`；DPI unaware 进程的
   GetWindowRect 返回虚拟化坐标，合成点击/截屏须用同一坐标系。
4. `PrintWindow` 对 DComp 内容无效（全黑），不能用于透明窗口内容验证，用屏幕截取。

---

## 8. 透明区域点击穿透（2026-08-25 完成，用户实测通过）

需求：宠物窗口的透明区域不能吃掉点击，需透到下层内容。

**最终方案：`SetWindowRgn` 区域裁剪**
- 页面上报交互矩形（`#pet-avatar`、`.pet-close-btn`、`#pet-bubble`、`.pet-input-row`
  的 `getBoundingClientRect`，viewport 相对坐标）；ResizeObserver 跟踪气泡尺寸变化 +
  300ms 周期重报兜底（RO 首次回调可能早于布局稳定，捕获过期矩形后因尺寸不再变化
  永不刷新——实测踩坑）
- 宿主按 `winW/vpW` 比例换算成物理像素后，`CreateRectRgn`+`CombineRgn(RGN_OR)`
  取并集，`SetWindowRgn` 裁剪窗口：区域外不渲染（本来就全透明）且点击自然落到下层
- 无轮询、无窗口样式切换、无渲染副作用；拖拽时矩形为窗口相对坐标，随窗口移动自动生效

**弃用方案：`WS_EX_LAYERED|WS_EX_TRANSPARENT` 80ms 光标轮询切换（Norma 同款）**
在带重定向表面的窗口上，LAYERED 样式会使 WebView2 DComp 输出消失（渲染被劫持到
layered 路径）；该技巧只在 `WS_EX_NOREDIRECTIONBITMAP` 无表面窗口（Wails/Norma 路线）
上安全。若未来迁移到 NOREDIRECTIONBITMAP 配方，可重新考虑轮询方案。

**DPI 坐标系（重要踩坑）**：go-webview2 初始化使进程 DPI-aware——宿主 Win32 坐标
全部是物理像素（GetWindowRect 560×300）；而 WebView2 内容按虚拟化 96 DPI 渲染，
JS 视口是 374×200 CSS px。两套坐标相差 DPI 比例（winW/vpW），矩形必须换算。
另：合成点击/截屏的 PowerShell 是 DPI-unaware（又是第三套坐标），跨进程探测时
三方坐标各不相同，须逐一实测换算。

**验证手段**：`WindowFromPoint` 判定各点命中归属 + GetWindowLong 检查样式 +
截屏；注意锁屏期间 LockScreenBackstopFrame 会接管一切命中且截图截到锁屏背景，
验证须在解锁状态下进行。
