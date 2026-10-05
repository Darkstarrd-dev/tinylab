# jethub-architecture.md — 变更日志

> 本文件存放 `docs/jethub-architecture.md` 顶部「最后核对」行的历史流水与变更过程叙述（最新在上）。正文只保留当前态事实。

## 2026-10-05 · 登录浏览器与会话模式（+新建账号 先选后开）

**背景：** Free Hub 的 `+ 新建账号` 一直把授权页交给系统 shell（`fsutil.OpenInBrowser` → `rundll32 url.dll,FileProtocolHandler`），即**默认浏览器 + 共享登录态**。本模块的主用途是同一 provider 多账号，而浏览器通常已登录账号 A ⇒ 新建出的账号静默复用 A 的身份；账号池只按 `Account.ID` 去重（`manager.go::AddAccount`），**没有按 provider 身份的去重**，重复凭据不会被任何机制拦住。用户提出的三个待定方向（隐私模式 / 指定非默认浏览器 / 指定浏览器 + 其隐私模式）需要在真机上先做可行性判定，再落到 `+新建账号` 弹窗里让用户选。

**评估结论（本机真机实测：Chrome 141 / Edge 154 / WebView2 Runtime 154，默认浏览器 Chrome，chrome.exe 与 msedge.exe 均存在）：**

1. 隐私模式可开、可登录：**Windows 没有任何「用默认浏览器打开隐私窗口」的 shell/`ShellExecute` 接口**，必须自己解析 exe 并拼 flag。
2. **flag 名按内核族不同，写错静默退化**：实测 Edge 154 不识别 `--incognito`，无报错、无退出码，直接开了一个**普通窗口**（窗口标题显示「用户配置 1」而非 `[InPrivate]`）；Edge 的正确 flag 是 `--inprivate`。⇒ 单一 `--incognito` 的写法是错的，未知内核必须**拒绝**而不是猜。
3. flag **能穿过「转发给已运行实例」**：Chrome 已开着时第二次 `--incognito` 仍落在 off-the-record 存储（用 localStorage 持久性对照判定：不带 flag 的对照读到 `prev=set`，带 flag 读到 `prev=none`），所以用户开着浏览器不影响行为。Edge 同结论（第二个窗口标题带 `[InPrivate]`，启动器立刻退出说明发生了转发）。
4. 鉴权链路与浏览器无关：隐私窗口里能加载本地 `http://127.0.0.1` 登录页并回连本服务（扫描页/回环回调/设备码三种形态都成立）。
5. ⚠️ **Chrome 141 的隐私窗口标题已不含 "Incognito"**，外部无法确认是否真进了隐私模式 ⇒ 不能靠标题做校验，只能靠「内核已知」+「flag 表」+「拒绝未知」。
6. 已评估并**否决**：内嵌 WebView2 的 `IsInPrivateModeEnabled`（当前 pin 的 `jchv/go-webview2` 未暴露 ControllerOptions/InPrivate，需自写裸 COM；只在 webview 变体存在；且 Google 拒绝内嵌 WebView 登录 `disallowed_useragent`，会打死 gemini 及任何 Google SSO 渠道）。

**实现要点：**

- 新增 `internal/browserlaunch/`（不含 jethub 概念）：`Detect()`（Windows/mac/Linux 候选路径 + PATH 回退 + 去重）、`FamilyOf`/`PrivateArgs` 家族表（chrome/chromium/brave/vivaldi=`--incognito`、edge=`--inprivate`、opera=`--private`、firefox=`-private-window`）、`DefaultBrowser()`（Windows 注册表 `UserChoice→ProgId→shell\open\command`，含不带引号且路径含空格的解析；mac/Linux 无零依赖查询 ⇒ 返回空由调用方拒绝）、`BuildArgs`/`Open`（相对 `--user-data-dir` 一律 absolutize，同 webhub 缺陷 21 的教训；`Release()` 不 Wait、从不杀浏览器）。
- 新增 `internal/jethub/login_open.go`：`OpenOptions`（Browser/BrowserPath/Session/AccountID）、归一化（请求 → 记住的偏好 → 旧默认）、`ValidateOpenOptions`（**不启动进程**的同步校验，复用 `BuildArgs` 判定 flag 可用性）、`ResolveOpenBrowser`、`OpenLoginURL`、`IsolatedProfileDir`（id 净化为单一路径段）、偏好文件 `{dir}/login-open.json`、账号删除后**异步尽力**清理独立配置目录。
- `Manager.browserOpener` 签名改为 `func(url string, opt OpenOptions)`；**flow 内部不再自行开页**（cline/buddy/lobsterai/trae 复用既有 `openURL` 形参接收 mode-bound 闭包，gemini/codearts 新增选择参数，qoder/minimax/raccoon/loomy/zcode 由 handler 直接 `OpenURLWithBrowser(url, opt)`）——顺带修掉「管理器先开一次 + 回调再开一次」的潜在双开。
- 新增端点 `GET /api/jethub/login-browsers`、`POST /api/jethub/open-login-url`（后者同步开页并回报错误）。每个 login handler 在**建号之前**做 `prepareLoginOpen`（校验 + 记住选择），不可用选择返回 400。
- 前端拆成三步：选择步 `__jethubLoginModal`（两轴 + 自定义路径行 + 内核未知禁用隐私项；此步无占位账号，取消即关闭）→ `jethubLoginConfirm`（带 `{browser,browserPath,session}`）→ 等待步 `__jethubLoginWaitingModal`（原三态轮询 + 取消删占位 + 「重新打开登录页」走服务端）。
- **UI 返工（同日）**：选择步首版用的是 `<select class="input">`，在弹窗里仍是被浏览器原生样式渲染的下拉（用户实测指出「还是原生的，不是项目自定义的样式」）。改为项目自定义组件 `renderCustomSelectHtml`（`app.js`）：wrapper/trigger/menu/隐藏原生 `select` 四件套，基础样式来自 `style-download.css`（由 `style.css` `@import` 全局引入），弹窗内尺寸/宽度由 `style.css` 的 `.modal .custom-select-*` 覆盖 —— 因此**无需新增 CSS**。连带处理组件不支持 per-option disabled 的问题：`__jethubSetOptionDisabled` 把禁用态写在隐藏的原生 `<option>` 上（`toggleCustomSelect` 每次展开按原生 option 重新同步自定义行），并立即镜像到自定义行，`selectCustomOption` 会拒绝被禁用的项。用户改选浏览器时经隐藏 select 的 `onchange`（`__jethubSyncLoginForm()`）同步禁用态/路径行/提示。回归新增静态守卫：选择步必须包含 `renderCustomSelectHtml('free-hub-login-browser-wrap'`/`'free-hub-login-session-wrap'`、不得出现真实 `<select\s` 标记、`style.css` 必须保留 `@import url("style-download.css")` 与 `.modal .custom-select-trigger`。
- i18n：新增 12 个 `freeHubLogin*` 键（en/cn 各一份）。

**语义边界：**

- **默认浏览器 + 共享登录态仍然走旧的 shell 路径**（`ResolveOpenBrowser` 对 default+shared 返回空 bin ⇒ `fsutil.OpenInBrowser`）：不碰弹窗的用户行为**逐字节不变**，关联不是普通 exe（launcher/商店应用）时也照旧由 shell 激活。
- `private` 的语义就是未登录：便利性（浏览器已登录 ⇒ 一点即授权）消失，换来账号隔离；企业策略可静默禁用无痕（本端无法检测）；隐私窗口内扩展被禁用，企业 SSO/设备信任类扩展会失效。
- `isolated`（每账号持久 `--user-data-dir`）是多账号首选：隔离且重启后仍在，不受无痕策略影响；代价是每账号一份浏览器配置（约百 MB 级），仅在主动选择时产生。
- 偏好落在 jethub 自己的目录而**不是 `config.yaml`**：与 `ProxyEnabled` 同一先例（jethub UI 状态归 manager 自持），且备份导入不会重置本地偏好、`accounts.json` 的备份兼容形态不受影响。

**回归测试：** `internal/browserlaunch/browserlaunch_test.go`（家族表/参数构造与拒绝矩阵/探测表/命令解析/启动 seam）、`internal/jethub/login_open_test.go`（归一化/校验/偏好往返与损坏容错/目录净化与越界保护/删除清理）、`internal/api/jethub/login_open_test.go`（端点形状/**建号前拒绝**/`open-login-url` 拒绝矩阵）、`web/jethub.test.js` 新增选择步用例（确认前零 POST + 选择随 RPC + 服务端重开 + 隐私项判定）、`web/loomy-login.test.js` 的 Go 断言改为新调用形状。

**同步范围：** 本文 §3.9（新增）+ §3.2 缺陷 4（opener 签名指向 §3.9）+ §9 测试清单 + 顶部「最后核对」；`PROJECT_MAP.md` §13q（新包）+ §13n/§10.28/§18.2/§19/§24；[`docs/jethub-upstream-sync.md`](jethub-upstream-sync.md) §5（上游无此机制 ⇒ 判定不搬，本端自研）。

## 2026-10-02 · 上一轮「最后核对」行（原文归档）

> **最后核对：** 2026-10-02（P1–P4 + UI 对齐原版插件重做 + **登录流生命周期修复 + per-provider 走代理开关 + Cline 轮询判据/诊断 + MiniMax 推理协议桥 + 本地扫码登录页 + 推理端点整族修复 + 前端路由形状二修 + codearts Key 提取 + 模型倍率对齐 + CodeArts 流内错误判据**：main 区内嵌布局 / 详情页按钮行+账号卡 / 模型列表纵向批量 / 限流重测重置 / 永久锁存储+备份 / 后台登录轮询脱离请求上下文 + 占位账号单赢家结算 + 出站代理跟随 + Use Proxy toggle + WorkOS 轮询按 error 字段判据 + minimax 出站 URL/请求体/响应流三处协议转换 + raccoon 扫码改由本地页面承载 + buddy/workbuddy/lobsterai/trae/cline/raccoon/minimax 推理端点显式声明（§6.2）+ codearts 签名路径修正 + trace 记录真实出站 URL + 前端 jethub 路径全方法守卫（§3.2 缺陷 14）+ codearts 无 access_token 的 Key 提取（§3.2 缺陷 15）+ qoder/qodercn 促销倍率与 trae 展示名（§6.3）+ codearts 200/400 流内 error_code 的排队与失败判据（§6.4）+ loomy 微信扫码登录（§3.5）+ **面板登录弹窗的 status 轮询契约**（§3.6 缺陷 19：loomy 的 `/status` 漏了 `loginId` 分支 ⇒ 弹窗永挂；前端 404 静默空转一并收尾）+ **模型列表展示形态规范化**（§6.3：一条 `名称 · 倍率` 紧跟裸 id、逐 provider 静态展示名与插件逐条对齐（buddy/workbuddy 补名 + 同名变体标记、cline 补 ` · 免费`、trae 剔除 4 条隐藏项）、点 id 复制 `{prefix}/{id}`、展示名同 provider 内唯一）；⚠️ 日期按实际提交时间校正，此前文档误记为 10-02）
