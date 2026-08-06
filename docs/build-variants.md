# 构建变体 (Build Variants)

> 最后核对：2026-08-06（新增 P5 feature manifest 边界，见下文"编译裁剪边界"）

TinyRouter 通过 build tag + 链接器 flag 组合，提供 Windows、Linux 与 macOS 构建产物。Windows 下用 `build.ps1` 一键产出变体；macOS 双架构用 `build_mac.ps1` 交叉编译。

## 编译裁剪边界（P5 feature manifest，2026-08-06 落地）

计划 [`archive_compatibility_plan.md`](../archive_compatibility_plan.md) §11/P5 的**第一阶段**已落地：`internal/feature`（leaf 包，零依赖）是编译期功能面的唯一 honest manifest——每个 feature 声明 ID、依赖、归属静态资产与 `Compiled` 状态；`internal/api/router.go` 的路由注册与 `internal/app/app.go` 的组件构造都通过 `feature.Enabled(...)` 门控，`web/playground/static-pg` 的按文件静态路由列表改由 `feature.Assets(feature.RootPlaygroundPG)` 派生（取代硬编码 pgJSFiles 列表，顺序与旧列表完全一致）。

**当前事实（不虚假声明裁剪）：**

- 除 `playground` 静态 embed 外，**没有任何 feature build tag**。Gallery/Download/MediaEdit/FileTransfer/TextReview/Archive/Archivetool 及其 API 包今天仍无条件编译；manifest 中这些 feature 的 `Compiled` 恒为 true，默认构建全部启用，路由与组件行为与改动前逐字节一致（`go build ./...` + 全量测试验证）。
- 唯一真实编译信号是 `playground` tag：`internal/api/router.go::Routes` 顶部 `feature.SetCompiled(feature.Playground, web.PlaygroundCompiled())`，`feature.Enabled(feature.Playground)` 取代原 `web.PlaygroundCompiled()` 检查，语义等价。
- ComfyUI / Image Batch / AnySearch 是 Playground 附属后端，但**今天无条件编译**，其路由组故意不挂在 `feature.Playground` 门控下（挂上会在无 playground 的默认构建中丢失路由）；代码注释已标明 P5 blocker。

**尚未实施（精确阻塞清单，做到这些之前不得宣称可裁剪）：**

1. `feature_*` build tag + 每包 stub 文件（`archive_compatibility_plan.md` §11.2 表）。
2. 给包本身打 tag（`internal/gallery`、`internal/download`、`internal/mediaedit`、`internal/filetransfer`、`internal/textreview`、`internal/archive`、`internal/archivetool`、`internal/api/*`），使 router.go/app.go 的 import 与注册真正条件化。
3. 按 feature 拆分 `go:embed`（当前 `web/embed.go` 嵌入 `all:static`）+ `index.html`/`index-nopg.html` 脚本列表改由 manifest 生成（页面目前无条件加载全部脚本）。
4. `build.ps1`/`build_mac.ps1` 增加 `-Features` 参数——**在 tag 落地前加此参数是虚假声明**，故本阶段刻意不改脚本。

切到真实裁剪时的翻转点：`internal/feature` manifest 的 `Compiled` 字段 + router/app 的 `feature.Enabled(...)` 门控；`internal/feature` 测试（`internal/feature/feature_test.go`）在默认构建下锁定"全部启用 + 资产列表与旧路由一致"合同。

## build.ps1 参数

```powershell
./build.ps1 [-Variant default|tray|webview|debug] [-Playground] [-Strip] [-All] [-OutputDir dist]
```

- 不加参数 = 仅产出 default 变体一个 exe
- `-All` = 一次性产出全部 13 个变体（忽略 `-Variant` / `-Playground` / `-Strip`）

## Variant 含义

| Variant | 行为 | tags | ldflags | CGO |
|---|---|---|---|---|
| `default` | console 窗口 + 自动打开浏览器(当前行为) | — | — | 无 |
| `tray` | 系统托盘常驻,无 console 窗口,右键菜单"打开控制台/退出" | `tray` | `-H windowsgui` | 无 |
| `webview` | tray + WebView2 原生窗口右键菜单多一项"打开独立窗口"(Win10/11 自带 Runtime,纯 Go) | `tray,webview` | `-H windowsgui` | 无 |
| `debug` | 全 DWARF/console 窗口,供 `dlv` 调试;Playground/Strip 被忽略 | — | — | 无 |

## 关键开关

- **-Playground**: 启用 `playground` build tag,内嵌 `web/playground/static-pg` 资产(无此 tag 用 `web/embed_playground_stub.go` 空 FS)
- **-Strip**: 加 `-ldflags "-s -w"` 剥离符号表 + DWARF,减约 3.6 MB;失去 `dlv` 调试能力,运行不感知

## 默认构建 vs 标签构建

- **无 tag** = 当前行为(console 窗口 + 浏览器),`go build -o tinyrouter .` 与 `./build.ps1` 等价
- **`-tags tray`** = 切换到 `host_tray_windows.go`,引入 `fyne.io/systray`;无此 tag 用 `host_console.go`
- **`-tags "tray,webview"`** = tray 基础上引入 `host_webview_windows.go` + `jchv/go-webview2`;托盘菜单多一项"打开独立窗口",在 Win10/11 上用 WebView2 Runtime 弹出原生窗口加载 admin UI;关闭窗口不退出进程,仍可再次打开
- **`-tags playground`** = 切换到 `web/embed_playground.go`,内嵌 Playground 资产;无此 tag 用 `web/embed_playground_stub.go`


## Windows/Linux 极限体积脚本

`build-minimal-webview-pg.ps1` 仍使用 `CGO_ENABLED=0`、`-s -w -buildid=`、`-gcflags="all=-l"` 与 `-trimpath`，生成 `dist/TinyRouter_Win11.exe` 和 `dist/TinyRouter_Linux`。默认**不使用 UPX**：Windows 对部分 UPX 压缩 PE 的加载会返回 `STATUS_INVALID_PAGE_PROTECTION (0xC0000045)`，导致“应用程序无法正常启动”。

如确实需要压缩，可显式执行 `./build-minimal-webview-pg.ps1 -Upx`；发布给 Windows 用户的产物应使用默认未压缩版本。
## macOS 双架构构建

Windows 开发机可直接运行：

```powershell
./build_mac.ps1 -OutputDir dist
```

脚本固定使用 `CGO_ENABLED=0`、`playground` build tag、`-trimpath` 与 `-s -w -buildid=`，不使用 UPX、不签名、不创建 `.app` Bundle，生成两个可直接由 macOS 终端执行的裸 Mach-O 文件：

| 文件 | macOS 架构 | 适用设备 |
|---|---|---|
| `dist/TinyRouter_Darwin_arm64` | arm64 | Apple Silicon |
| `dist/TinyRouter_Darwin_amd64` | x86_64 | Intel Mac |

下载后在 macOS 终端执行 `chmod +x TinyRouter_Darwin_*`。Finder 需要 `.app` 时，必须在 macOS 上另行创建 Bundle；不要仅修改文件扩展名。

## 13 产物矩阵 (实际体积,基于 1024×1024 logo.png 多尺寸 ICO)

| Variant | Playground | Strip | 输出文件 | 体积 |
|---|---|---|---|---|
| default | 否 | 否 | `tinyrouter.exe` | 15.15 MB |
| default | 否 | 是 | `tinyrouter-stripped.exe` | 11.51 MB |
| default | 是 | 否 | `tinyrouter-pg.exe` | 19.17 MB |
| default | 是 | 是 | `tinyrouter-pg-stripped.exe` | 15.53 MB |
| tray | 否 | 否 | `tinyrouter-tray.exe` | 15.62 MB |
| tray | 否 | 是 | `tinyrouter-tray-stripped.exe` | 11.77 MB |
| tray | 是 | 否 | `tinyrouter-tray-pg.exe` | 19.64 MB |
| tray | 是 | 是 | `tinyrouter-tray-pg-stripped.exe` | 15.79 MB |
| webview | 否 | 否 | `tinyrouter-webview.exe` | 16.02 MB |
| webview | 否 | 是 | `tinyrouter-webview-stripped.exe` | 12.09 MB |
| webview | 是 | 否 | `tinyrouter-webview-pg.exe` | 20.04 MB |
| webview | 是 | 是 | `tinyrouter-webview-pg-stripped.exe` | 16.11 MB |
| debug | — | — | `tinyrouter-debug.exe` | 15.15 MB |

Playground 模块增量约 +4.0 MB;Strip 减约 3.6 MB;Tray 仅增约 +0.3 MB(纯 Go,无 CGO);WebView 在 tray 基础再增约 +0.4 MB(`jchv/go-webview2` 纯 Go + 内嵌 WebView2Loader 字节)。

## 图标资源

`web/static/favicon.ico` 通过 `gen-icon.ps1` 从 `web/static/logo.png` (1024×1024) 生成,内嵌 7 个尺寸(16/24/32/48/64/128/256),覆盖托盘、资源管理器、任务栏、Alt+Tab、jumplist 全部 DPI 场景。`rsrc.syso` 自动同步,无需手动维护;改 logo 后跑 `./gen-icon.ps1` 再 `go generate ./...`。
