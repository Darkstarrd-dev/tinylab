# Free Hub (jethub) 架构

> **最后核对：** 2026-10-01（P1–P4 + UI 对齐原版插件重做 + **登录流生命周期修复 + per-provider 走代理开关 + Cline 轮询判据/诊断 + MiniMax 推理协议桥 + 本地扫码登录页 + 推理端点整族修复 + 前端路由形状二修 + codearts Key 提取 + 模型倍率对齐 + CodeArts 流内错误判据**：main 区内嵌布局 / 详情页按钮行+账号卡 / 模型列表纵向批量 / 限流重测重置 / 永久锁存储+备份 / 后台登录轮询脱离请求上下文 + 占位账号单赢家结算 + 出站代理跟随 + Use Proxy toggle + WorkOS 轮询按 error 字段判据 + minimax 出站 URL/请求体/响应流三处协议转换 + raccoon 扫码改由本地页面承载 + buddy/workbuddy/lobsterai/trae/cline/raccoon/minimax 推理端点显式声明（§6.2）+ codearts 签名路径修正 + trace 记录真实出站 URL + 前端 jethub 路径全方法守卫（§3.2 缺陷 14）+ codearts 无 access_token 的 Key 提取（§3.2 缺陷 15）+ qoder/qodercn 促销倍率与 trae 展示名（§6.3）+ codearts 200/400 流内 error_code 的排队与失败判据（§6.4）；⚠️ 日期按实际提交时间校正，此前文档误记为 10-02）
>
> Free Hub 是 DeepSeek Harness 插件 `dsh-codearts-auth`（11 个第三方 LLM provider 的账号池 + Web 管理面板，TS/React）的 TinyLab 原生移植：产品名 **Free Hub**，内部包前缀沿用 `jethub`。只读参考副本位于 `ref/deepseek-harness-codearts`（**禁止修改**；每份移植实现的语义权威）。
>
> **变更维护清单（改动时必须同步本文）：**
> - 新增/修改 provider 适配（登录/续期/签名头族/模型表）→ §6 矩阵 + `internal/jethub/` 对应文件；**登录流必须走 §3.2 的独立 context + SettleAndCleanup 约束 + `httpClient(provider)` 代理分派**
> - 修改代理桥接接口（RequestAugmenter/RequestCustomizer/ResponseInterceptor）或重试语义 → §4 + `internal/proxy/interfaces.go`/`forward_retry.go`/`upstream.go`
> - 修改 Qoder WASM 桥（导入表/导出封装/对象堆）→ §5 + `internal/jethub/qoderwasm_bridge.go`
> - 修改备份格式 → §7 + `internal/jethub/backup.go`（与原版格式**双向兼容**，改动即破坏兼容，须先读 ref types.ts）
> - 修改 Free Hub UI 布局/入口/详情页/模型列表/Use Proxy 开关 → §3 + `web/static/jethub.js`/`settings.js`/`i18n.js`/`style-jethub.css`/`app-router.js`
> - 修改限流重测/重置探针或永久锁 → §3.1 + `internal/jethub/probe.go`/`ratelimits.go`/`manager.go` + `internal/api/jethub/register.go`
> - 修改 jethub 出站代理分派（`SetProxyURL`/`SetPackageProxyURL`/`ProxyEnabled`）→ §3.2 + `internal/jethub/sessions.go`/`codearts_login.go`/`bridge.go` + `internal/app/app.go`
> - 修改 MiniMax 推理协议（端点 / OpenAI⇄Anthropic 转换 / 思考档位判据 / SSE 映射）→ §6.1 + `internal/jethub/minimax_convert.go`/`minimax_stream.go`/`minimax_credits.go`（augmenter）+ `qoder_adapter.go`（Customize/InterceptResponse 分派）+ `probe.go`
> - 修改扫码登录页（页面/二维码/公开端点）→ §3.4 + `web/static/free-hub-login.html`/`raccoon-qr.js` + `internal/api/jethub/login_page.go` + `internal/api/router.go`（**公开挂载点**）+ `internal/jethub/raccoon_provider.go`
> - 修改/新增 provider 的**推理端点**（出站 URL）→ §6.2 + `internal/jethub/products.go` 的 `Product.InferURL`（**唯一真相源**）+ `bridge.go`（登记即发布）+ `qoder_adapter.go`（Customize 覆盖 + 签名用 URL 改写）+ `probe.go`（探针共用同一管线）；qoder 族例外（URL 由 WASM 算出）
> - 修改**模型展示名/倍率**（别名、倍率段、促销窗口）→ §6.3 + `internal/jethub/*_model.go`/`buddy_product.go` 的静态表 + `internal/api/jethub/register.go` 的 `modelDisplayParts`（受支持段：`xN` / `FREE (xN)` / `promo HH:MM-HH:MM xN`）+ `register_test.go`
> - 修改 **jethub 前端 RPC 路径** → §3.2 缺陷 14 + `web/static/jethub.js` + `web/jethub.test.js` 的**全方法路由形状守卫**（从 `internal/api/jethub/*.go` 反推合法形状，改路径必跑）
> - 修改 **CodeArts 响应判据**（200 + 流内 error_code / 排队重试）→ §6.4 + `internal/jethub/codearts_response.go` + `qoder_adapter.go`（InterceptResponse 分派）+ `internal/proxy/forward_retry.go`（QueueRetryError 的等待与 180 次上限）

## 1. 模块组成与边界

| 部分 | 位置 | 说明 |
|---|---|---|
| 核心 | `internal/jethub/` | 账号/凭据存储、账号池、registry 桥接、11 provider 适配、WASM 桥、备份 |
| API | `internal/api/jethub/` | `/api/jethub/*` RPC（§10.28 PROJECT_MAP）：providers（含能力位）/prefix/accounts/models（单/批量/恢复默认）+ ratelimits retest/reset + permanent-lock + 每 provider login/status/refresh/claim/balance + backup export/import；**另有两条挂在鉴权组之外的公开端点**（`GET /api/jethub/login-page`[`/status`]，扫码登录页的数据源，§3.4） |
| 前端 | `web/static/jethub.js` + `style-jethub.css` | Free Hub 管理界面（vanilla JS，无框架），入口嵌在 Settings 页、main 区内嵌布局（§3）；行为测试 `web/jethub.test.js`（19 项）；扫码登录页 `free-hub-login.html` + `raccoon-qr.js`（测试 `web/raccoon-qr.test.js`，§3.4） |
| 跨边界错误 | `internal/upstreamerr/` | `QueueRetryError`/`BillingLockError`（proxy 与 jethub 各自 import 的中性叶子包） |
| 装配 | `internal/app/app.go` | Manager/Bridge 构造、`RestoreBridges` 启动重桥、augmenter 注入 proxy Handler |

**边界纪律：`internal/proxy` 不 import jethub**（AGENTS.md 红线）。proxy 只认识 `APIType=="jethub"` 标记与三个窄接口；jethub 结构化实现、装配时注入（`Handler.SetRequestAugmenter`）。

## 2. 存储层（`{configDir}/jethub/`，`config.ResolveJetHubDir`）

- `credentials.json`：`{provider → credentialRef → 凭据 JSON}` 整体 AES-GCM 加密信封（`{"enc":"..."}`）；**加密密钥是 Free Hub 自持的 `{dir}/key`（0600，首次使用时生成）**。
- ⚠️ **密钥归属（真实缺陷，2026-10-01）**：早期实现直接用 `config.Security.EncryptionKey`，而那把钥匙的生命周期属于**密码保护**——关闭密码保护会**清空**它（`api/settings/register.go`），设置密码又会**轮换**它。于是**任何未开密码保护的安装（默认状态）都无法保存凭据**：登录走到落盘一步必然报 `jethub: no encryption key available for credentials storage`（用户实测 minimax 报障）。现在密钥由 Free Hub 自持，与密码保护彻底解耦；传入的 config 密钥仅作**一次性迁移**用（若旧文件能用 config 密钥解开则采纳并改用自持密钥重加密，之后即使密码保护被关闭/轮换也不受影响）。
- `accounts.json`：账号索引 + 模型黑名单 + 前缀映射 + `permanentLocks` + `proxyEnabled`（`accountsFile`，与原版 JetHubConfig 同构——§1.5 备份兼容前提）。**账号索引不需要密钥**（这也是为什么本缺陷下"账号能建、凭据存不下"的表现具有高度辨识度）。
- 两者均 `fsutil.AtomicWrite` 原子写；`Manager` RWMutex 双锁。
- `machine_id` 类设备标识是**插件生成并随凭据持久化的随机 UUID**（qoder）或确定性派生（trae），非硬件指纹。

## 3. Free Hub UI（Settings 内嵌）

- **入口**：Settings 侧边栏 `Free Hub` 行——Path Settings 行后、Assistant 行前（`settings.js` `#free-hub-entry`，契约测试锁位置）；i18n `freeHub*` en+cn。
- **main 区内嵌（不整页替换）**：`openFreeHub()` **保留 `.settings-panel-left`（Settings 侧边栏）**，仅隐藏 `.settings-panel-right` 并在 `.settings-layout` 内其后面挂 `#free-hub-root.free-hub-main`（占 main 位）；`closeFreeHub()` 反向恢复（轮询定时器一并清理）。若 layout 不存在（页面被换走后重进）会先 `renderEndpoint` 重渲染再挂载。
- **切页生命周期**：`navigateTo`（`app-router.js`）调用 `closeFreeHub()`——页面切换会整体清空 `#page-content`，不清标志会导致再次进入 Free Hub 被陈旧 `__jethubActive` 守卫挡住（修复过的真实缺陷：必须重启 App/Ctrl+F5 才能恢复）；`openFreeHub` 侧另有兜底——active 时先执行一次 close 再重挂。
- **布局三段式**：header（一键签到 / 备份 / 恢复 / 关闭，**四按钮一列左对齐**，无右推 spacer）+ left pane（11 provider 列表，账号数徽标单选）+ right pane 五区（调用前缀 / **操作按钮行** / 通知区 / 账号卡 / 模型列表）。
- **详情页操作按钮行**（能力门控与原版 dim-jh-headerActions 一致）：刷新积分（`hasBalance`）· 一键领取积分（`hasCredits`）· 重测所有 + 重置所有（`supportsRateLimit`，loomy 不渲染——它不限流，重测只会白烧额度）· 解锁|锁定永久积分（`canLockPermanent` = {loomy, buddy, workbuddy}）· + 新建账号 · **Use Proxy 开关**（`+ 新建账号` 右侧：`free-hub-proxy-wrap` 标签 + 全局 `.toggle-switch`（同 Upstream Proxy/Provider 详情 useProxy，复用 style-settings.css 不动堆叠规则）；`jethubToggleProxy` PUT `/api/jethub/providers/{provider}/proxy` {enabled}，失败回滚勾选态；per-provider 语义见 §3.2）。结果在通知区显示（tone + 逐条 details 列表）。
- **账号卡**：状态点 + 名称 + 徽标（启用/key/refresh）；元信息行 = 凭据 ref（code）· 有效期（`X 分钟后/小时后`/日期，过期红字 + `· 自动续期`）· 积分（**逐账号**余额，挂载/刷新积分时并发逐个查询，错误显示「查询失败」不阻塞其它卡）；「限额重置」芯片行（仅未到期标记显示，任一标记存在即启用重测/重置）；按钮行 = 重测 / 重置（单账号，仅有标记时可用）· 领取积分 · 续期 · 改名 · 停用|启用 · 删除。
- **模型列表**（与本项目 Provider 详情的 Model list 同形态）：纵向行列表（名称 + **倍率徽标**（服务端 `rate` 字段：`x0.75`/`免费`/`x0.2→x0.1`，从 alias/note 解析、**无信息不编造**） + 可复制的模型 id + 删除/恢复单钮）；批量管理 → 筛选 / 全选|取消全选 / **删除所选**（批量进黑名单，一次写盘 + 一次 SyncKeys）/ 取消；**恢复默认** = 清空黑名单（黑名单语义：删除=隐藏，恢复默认全部找回，被删项灰显带「已隐藏」徽标保持可逆）。
- 登录流按 provider `loginModes` 分派：`url`/`qr` → 登录 URL 弹窗 + 2s 轮询（`{done,success}` 契约）；`sms` → **先创建占位账号**（POST `/accounts` 拿 `accountId`）再弹发码/验码两步弹窗（提交时按 `accountId` 绑定凭据；**取消 = 删除占位**）。URL 弹窗的取消同样删除占位。无凭据的占位账号在账号卡上显示「登录未完成 · 无凭据」灰徽标（`freeHubNoCredential`），领取/推理账号集都会过滤掉它们。
- ⚠️ **扫码类 provider（raccoon）的 `loginUrl` 是本地页面**（`/free-hub-login.html?loginId=…`），**不是**二维码内容——后者要被微信扫码打开，用浏览器直接打开只是普通网页、无法鉴权（真实缺陷 11，§3.4）。
- 样式只用 theme tokens（`var(--…)`），控件复用全局 `.btn`/`.badge`/`.modal`/`.input` 体系。

### 3.1 限流标记重测/重置 + 永久积分锁（后端）

- **标记数据**：`accountEntry.ModelRateLimits`（model id → 重置时刻 ms）。本端推理链路写入的是 rotation 的 per-model 锁；该表当前主要来自**原版备份导入**（携带原插件的限流状态），重测/重置即是对这份数据的操作。内部记账键（`__` 前缀，如 trae 的签到代次）不参与重测/计数/渲染。
- **重测** `POST /api/jethub/{provider}/ratelimits/retest` `{accountId?}`（`Bridge.RetestRateLimits`）：对每个标记的 (账号, 模型) 经 `Bridge.ProbeAccountModel`（`probe.go`）**真实发送一条最小消息**（OpenAI 体；minimax 走 `/v1/messages` + Anthropic 体，且由 Customizer 覆盖为完整推理端点，§6.1；max_tokens=16）。探针**复用代理的 augmenter/customizer 管线**（`Manager.Customize`——codearts HMAC、qoder WASM、trae SOLO、minimax 协议桥都由各自 augmenter 完成，探针零协议实现）；URL 用 `urlutil.BuildUpstreamURL(base, entryPath)`，qoder 族与 minimax 由 Customizer 返回完整端点覆盖。HTTP 200 → 清除该标记；非 200 → 保留并在响应 `accounts[].stillLimited[]` 带原因（含状态码 + 截断报文）。会消耗少量额度——前端「重测所有」先确认。
- **重置** `POST /api/jethub/{provider}/ratelimits/reset` `{accountId?}`：直接清除（跳过 `__` 键），不发任何请求。
- **永久积分锁** `PUT /api/jethub/{provider}/permanent-lock` `{locked}`：provider 级开关（`accounts.json` 的 `permanentLocks` 表，仅 true 值有意义），能力白名单 {loomy, buddy, workbuddy}（原版 `PERMANENT_LOCK_PROVIDERS`）；`GET /providers` 每项带 `supportsRateLimit`/`canLockPermanent`/`permanentLocked`。⚠️ **选号侧的「锁定后只消耗临时积分」策略未移植**（需要对选号注入积分池感知）——开关持久化 + 随备份迁移已可用，语义见 §7。

### 3.2 登录流生命周期（+新建账号 的真实缺陷与修复）

登录是**两步式**：login handler 立即返回 `loginUrl` + `loginId`，后台轮询/回调等用户在浏览器完成授权（数十秒到数分钟）。这条结构曾引出五个真实缺陷（用户实测复现：占位账号立即出现、浏览器不自动打开、弹窗永远停在等待、凭据永不落盘、`TLS handshake timeout`/prefix 检索不到）：

1. **请求上下文绑定**：`Start*Login(r.Context(), …)` / 后台 `Poll*(r.Context(), …)` —— handler 写完响应后 `net/http` 立即取消请求 context，后台轮询当场夭折。修复：**所有登录流一律 `context.Background()`**（raccoon/cline/trae/lobsterai/buddy/minimax/qoder；codearts 流自身已是 Background）。qoder 最早注释了这个坑但其余 provider 全部中招。`web/jethub.test.js` 有静态守卫（逐文件断言 `context.Background()` + 禁止 `Start*Login(r.Context())`）。
2. **双消费者竞争**：status 轮询（`pollLogin`）与 API 层 pump goroutine 都直接读 `LoginSession.Started.Result`（容量 1 的缓冲 channel），先到者独占 outcome，另一方永久挂起。修复（`internal/jethub/sessions.go`）：**单赢家纪律** —— 只有 pump（`SettleAndCleanup`）读 channel 并记录结果（`settled` 状态 + `SessionStatus` 只读快照）；status 轮询改读记录态。
3. **结算即 reap（弹窗永远停在等待）**：pump 结算后立即 reap session 的话，2s 轮询的下一次请求必然 404 —— `done:true` 转换永远不会被前端观察到，即使后端已成功。修复：结算后保留 `loginSessionGracePeriod`（30s，若干轮询间隔）再 reap。
4. **凭据落盘后桥接 Key 不刷新（prefix 检索不到）**：`SetCredential` 的 `onAccountCredentialed` hook 在 app 装配层**从未接线**（git 历史确认：hook 定义了但无人调用）——登录成功后桥接 provider 的 Keys 永远不更新，新账号对 `{prefix}/{model}` 路由不可见；备份导入能工作只是因为 `backupImport` 显式重同步。修复：`app.go` 装配 `SetAccountCredentialedHook(→ Bridge.SyncKeys)`。同时接线 `SetBrowserOpener(→ fsutil.OpenInBrowser)`：+新建账号自动打开默认浏览器授权页（对齐原插件；弹窗内链接保留为手动兜底）。
5. **出站调用不走全局代理（`TLS handshake timeout`）**：jethub 的出站 client 默认 `ProxyFromEnvironment`，而 app 进程的 `HTTP(S)_PROXY` 是空的 —— 在「上游必须经本地路由代理」的机器上（Windows 系统代理 `127.0.0.1:2080`，镜像进 `config.yaml` `proxy.enabled`），Go 直连被 TLS 干扰掐死，而浏览器/DSH（undici 认系统代理）都正常。修复：`app.go` 把 `config.Proxy` 换算成 `http://host:port` 接线 `Manager.SetProxyURL`（重建共享 client）+ `SetPackageProxyURL`（codearts 回调 token 交换的包级 client 一并重定向）。

**per-provider Use Proxy 开关（2026-10-01 新增）**：

- **状态**：`accounts.json` 的 `ProxyEnabled` 表（provider → bool，缺席 = 直连；随重启/备份同文件持久化）。`PUT /api/jethub/providers/{provider}/proxy` `{enabled}` 持久化并重同步桥接。
- **三条出站路径都跟随该开关**：
  1. **登录/积分/续期/余额出站**（jethub 自发请求）：`Manager.httpClient(provider)` 在 direct/proxy 两个懒建 client 间按 `ProxyEnabled` 分派 —— 全部 provider 适配器的 ~30 个调用点已逐个传入 provider id（probe 探针克隆 client 时保留同 Transport）；
  2. **桥接后的 `/v1/*` 推理**：`Bridge.SyncKeys` 写 `config.Provider.UseProxy = ProxyEnabled(provider)`（**不再保留 registry 旧值**——开关是唯一事实源），proxy 管线 `clientFor` 按其分派；
  3. **codearts 回调 token 交换**：包级 `callbackClient` 经 `SetPackageProxyURL` 重定向 transport，开关状态由 `codeartsProxyEnabled` 在发起登录时按该 provider 的 toggle 设置。
- ⚠️ **开关打开但全局代理未配置（`config.Proxy.enabled=false` 或 host/port 空）= 直连降级**（`proxyClientLocked` 回退 direct）——没有可路由的代理时开关不生效。
- ⚠️ **`SetProxyURL` 必须在首次出站调用前接线**（app 装配序）；client 对在开关切换后懒重建，无需进程重启。
- ⚠️ **前端路径必须与后端路由同形**（真实缺陷 6，用户报障「Use Proxy 开关不可用：`Failed: HTTP 404 (non-JSON body)`」）：首版前端 PUT `/jethub/{provider}/proxy`，而后端注册在 `/jethub/providers/{provider}/proxy` —— chi 找不到路由直接回 `404 page not found` **纯文本**（故前端 `r.json()` 失败，显示的就是 non-JSON 提示）。聚合路由族统一形状：`/jethub/providers/{provider}/{prefix|proxy|accounts|models|ratelimits/*|permanent-lock}` 与 `/jethub/accounts/{accountID}`。**双端回归**：`internal/api/jethub/register_route_test.go`（真 chi 路由级：正确形状 200+JSON，旧错误形状必须 404；缺字段 400；未知 provider 404 带 JSON error）+ `web/jethub.test.js` 静态守卫。
- ⚠️ **同一类形状错误的第二次复发（真实缺陷 14，loomy 实测「添加账号报 `Failed: HTTP 404 (non-JSON body)`」）**：前端还有三处漏带 `providers/` 段 ——
  1. **SMS 占位账号创建** `POST /jethub/{provider}/accounts`（真值 `/jethub/providers/{provider}/accounts`）。loomy 是**唯一** `sms` 登录模式的 provider，所以只有它踩到（raccoon 走 url/qr，不进这个分支）；
  2. **限流重测** `POST /jethub/{provider}/ratelimits/retest`（「重测所有」按钮）；
  3. **限流重置** `POST /jethub/{provider}/ratelimits/reset`。
  根因是**旧守卫只扫 `apiPut` 字面量**，而这三处都是 `apiPost`（且旧测试还把错误形状当成期望值锁住了 —— 与缺陷 6 那次同一个坑）。修复：三处路径补齐；守卫重写为**全方法**（`apiGet/Post/Put/Patch/Delete`）且**从 Go 侧路由声明反推**合法形状（解析 `internal/api/jethub/*.go` 的 `r.(Get|Post|Put|Patch|Delete)("/…")`，把 `{param}` 与已知 provider 名都归一成 `*`），逐条比对前端调用；缺一条就列出全部不匹配项。已做反向验证（把任一路径改回错误形状 → 守卫立即报出该 (方法, 形状)）。

### 3.3 Cline WorkOS 轮询的判据与诊断（2026-10-01）

- **pending 的真实形态（本机实测）**：`POST https://api.workos.com/user_management/authenticate` 在用户未授权时返回 **400** + `{"error":"authorization_pending","error_description":"…"}`；用 `urn%3A…` 转义与未转义体实测结果一致（故编码不是变量）。成功为 `200 {access_token, refresh_token, …}`。
- ⚠️ **判据只看响应体的 `error` 字段，不看状态码**（修复）：原先写成「2xx ⇒ 成功，否则按 error 分派」，一旦服务端/中间层给出 **2xx + `error`**（pending/slow_down）就会被误判为成功分支并报出误导性的「WorkOS token 响应缺少必要字段」——用户实测报障即此文案。现在先判 `error`（pending/slow_down 继续轮询、denied/expired/invalid_grant 终态、其余报错），再判 2xx 成功。
- ⚠️ **错误信息必须携带真实响应**（修复）：`json.Unmarshal` 失败原先被静默忽略，于是「非 JSON / 空体」（例如本地代理或网关回 200 + HTML）统统呈现为「缺少必要字段」，把病因藏起来。现在 `clineBodySnippet` 会带上 `HTTP 状态码 + 响应体截断`（非 JSON 前缀、空体标注「空响应体」）并在 JSON 可解析时**列出顶层键名**（`clineJSONKeys`），同时写 `logger.Warn`。设备码授权与 token 注册两处同样补上了响应体。
- token 字段兼容 snake_case 与 camelCase（`access_token`/`accessToken`）——WorkOS 各端点命名并不统一。
- 回归用例（`internal/jethub/cline_test.go`）：`TestPollClinePendingOnHTTP200`（2xx+pending 继续轮询，反向验证原实现会误报）、`TestPollClineNonJSONBodySurfacesPayload`（HTML 体必须点名）、`TestPollClineEmptyBodySurfacesPayload`、`TestPollClineUnexpectedJSONShapeNamesKeys`（列出键名）、`TestPollClineUnknownErrorCodeNamesCodeAndEgress`（未识别 error 码必须报出码+描述+出站）、`TestPollClinePlainBody400NamesEgressAndBody`（无 error 字段的 400 必须报出响应体+出站）、`TestPollClineInvalidClientExplained`、`TestPollClineCamelCaseTokens`。
- **实测的 WorkOS 400 形态（只读探针，2026-10-01）**：未授权 = `authorization_pending`（400）；device code 无效/过期/**已用过** = `invalid_grant`；client_id 不对 = `invalid_client`「Invalid client id.」；grant_type 不对 = `invalid_client`「Invalid client secret.」。⚠️ **`errorDetailOf` 不读 `error_description`**——default 分支曾因此只输出「轮询失败（HTTP 400）」而丢掉全部线索；现已改为显式带出 `error` 码 + 描述。
- ⚠️ **错误信息一律附带「出站路径」**（`clineEgressNote`：直连 / 代理 `<url>` / 开关已开但代理未配置而降级直连）：响应体被中间层改写是首要嫌疑，出站模式一眼可辨，用户据此切换 Use Proxy 即可对照验证。
- ⚠️ **出站 transport 强制 HTTP/1.1**（`newJethubTransport`：`ForceAttemptHTTP2:false` + 非 nil 空 `TLSNextProto`）：参考实现（Node undici 的 fetch = DSH 插件）默认只讲 HTTP/1.1，而 Go 会经 ALPN 协商 h2。用户环境对同一对端出现**间歇性三种异常**（TLS handshake timeout → 2xx 空体 → 400 无 error 码）而 Node/浏览器全正常，中间层对 h2 的处理是首要嫌疑；管理类调用负载极小，退回 1.1 无损失且与已验证可用的参考实现在协议层对齐（`TestJethubTransportIsHTTP11` 锁定该决定）。同时给 WorkOS 两个请求补 `Accept: application/json`（部分中间层据此决定返回 JSON 还是 HTML 错误页）。

> 占位账号语义：`POST /accounts` 或 login handler 创建的占位（无凭据）在完成前**可见但明确标注**（灰徽标），且从不进入推理/领取账号集；登录失败或用户取消都会将其删除。

**缺陷 15（codearts 无 `access_token` ⇒ 桥接 provider 被静默摘除）**：用户实测「codearts agent 可添加，但按 prefix 取不到模型、无法调用」。根因：`Bridge.SyncKeys` 对每个启用账号取 `accessTokenOf(provider, cred)`，取不到就跳过；可用 Key 数为 0 时**桥接 provider 被整个移除**（前缀还在，但 registry 里没有 provider ⇒ 模型列表看不到、`{prefix}/{model}` 无从路由）。而 codearts 的凭据是 SDK-HMAC 的 `access_key_id`/`secret_access_key`/`security_token`，**没有 `access_token` 字段**，通用提取器恒返回空串 —— 其余 10 个 provider 都自带 `access_token` 或已注册专属提取器，只有它是「无令牌」签名型凭据。修复：注册 codearts 专属提取器（`security_token` 优先、退一步 `access_key_id`；再兜底 `access_token` 以让手写/旧夹具凭据仍被桥接，由 augmenter 报「凭据不完整」这种明确错误）。⚠️ 该 Key **不参与出站鉴权**：codearts 的 augmenter 用 ak/sk 重签并覆盖全部出站头，`Key.Key` 只用于轮询选号/用量归属/日志遮蔽。回归 `internal/jethub/bridge_keys_test.go`：**用真实凭据结构体**逐 provider 断言能取出非空 Key（此前的测试夹具用通用 `{"access_token":…}`，恰好能过通用提取器 —— 这正是缺陷逃过测试的原因）。

### 3.4 本地扫码登录页（raccoon，真实缺陷 11 + 修复）

- **真实缺陷 11（用户实测报障）**：「raccoon 渠道新建账号打开的网页不对，和插件里同渠道打开的不是一个页面，无法进行鉴权」。根因：首版把**二维码内容**当成页面打开了 —— `BuildRaccoonQrURL` 产出的是 `https://xiaohuanxiong.com/login/mp?code=<32位hex>&appname=商汤小浣熊官网`，它是**要被微信扫一扫打开的地址**；浏览器打开它只是官网的一个普通页面，与本次登录会话无关（该 code 永远不会回到 `success`）。参考插件从不打开它：它起本地 HTTP 服务承载弹窗页，页内渲染同一个 URL 的二维码（`ref/src/raccoon-login-page.ts`、`raccoon-qr.ts`）。
- **本端实现**：不另起监听端口，改用本进程已有的 HTTP 服务 ——
  - `web/static/free-hub-login.html`：**静态页**（公开资源，无需 cookie）；从查询串取 `loginId`，向公开端点取二维码内容，用 `raccoon-qr.js` 在浏览器端画二维码，每 2s 轮询状态，成功后显示「登录成功，可以关闭此窗口」并尝试 `window.close()`。
  - `web/static/raccoon-qr.js`：**零依赖二维码编码器**（byte 模式 / 纠错等级 M / 版本 1–10，逐行移植自 ref `raccoon-qr.ts`；见「为什么在浏览器端」）。`web/raccoon-qr.test.js` 用**参考实现产出的黄金指纹**（SHA-256 of the module matrix）锁死移植保真度 —— 画错的二维码只能靠手机复现，代价极高，故不能只测「有输出」。
  - `internal/api/jethub/login_page.go`：`GET /api/jethub/login-page?loginId=` → `{ok,provider,title,hint,qr}`；`GET …/login-page/status?loginId=` → `{done,success,error}`。**两条都挂在鉴权中间件之外**（`internal/api/router.go` 紧跟 `authHandler.Register(r)`）——页面是在**系统默认浏览器**里打开的，那里面没有管理 UI 的 cookie；开了密码保护的安装若把它挂进保护组，页面直接 401/跳登录页，「无法鉴权」会以另一种形式复发。访问控制交给 `loginId`（128 位随机、一次性、随会话 30s 宽限期一起回收），响应**不含** token/凭据/账号 id。
- **协议分工**：`StartedLogin.LoginURL` = 本地页面（浏览器打开的东西）；新增 `StartedLogin.QRContent` = 二维码内容（页面画的东西）。`StartRaccoonQRLogin(ctx, accountID, pageURL)` 同时产出两者，**不再自己开浏览器** —— API handler 在**注册完会话之后**才 `OpenURLWithBrowser(pageURL)`（顺序即契约：先开页面会让页面抢在登记前请求数据端点而拿到 404）。
- **安全边界**（与参考插件一致）：宿主侧/服务端持有全部敏感状态（`qrcode_code`、凭据），页面只做展示与轮询；页面文本里**没有**任何凭据字样。
- ⚠️ **未移植**：`canceled` 时参考实现会**换一个新 code 并刷新页面上的二维码**，本端仍按「扫码已取消」终止本次登录（用户重开一次即可）；页面也**没有**参考实现的短信 Tab（本端短信走独立弹窗，需要阿里云滑块参数，尚未打通）。

## 4. 调用桥接（核心机制，零特殊调用路径）

1. 用户为 provider 设**调用前缀**（全局唯一，`[a-z0-9-]{1,32}`）→ `Bridge.SetPrefix` 校验冲突（409）+ 持久化。
2. `Bridge.SyncKeys` 在 registry **动态注册** `config.Provider`：`ID=jethub-{provider}`、`Prefix=用户前缀`、`BaseURL=product 展示/兜底基址`、`Keys=启用账号×1`（`Key.Key`=access token，凭据刷新时同步）、`Models=静态模型表`（黑名单过滤）、`APIType="jethub"`。⚠️ **真实出站 URL 不是 BaseURL 拼出来的**：由 `Product.InferURL` 显式声明、`Customize` 覆盖（见 §6.2 —— BaseURL 只是 registry 展示与 urlutil 兜底）。
3. 调用侧无感知：`model={前缀}/{modelID}` 走 `handleProxy` → `GetProviderByPrefix` → `forwardWithRetry` 标准链路；**多账号轮询直接复用 rotation 三策略/冷却/配额锁**，不另造轮子。
4. **请求增强 hook（依赖倒置）**——三个窄接口，全部可选、结构性注入：
   - `RequestAugmenter.Augment(r, body, providerID, keyID, upstreamModel)`：改写出站头基与 body（十协议族中 9 个用这一层）。
   - `RequestCustomizer.Customize(...)`（可选，所有已声明 `InferURL` 的 provider + qoder 族）：返回**完整出站 URL** + 改写后的 body；空 URL 回退默认构造。⚠️ 调用 augmenter 时它把请求对象的 URL 换成上游地址（浅拷贝）并保留原始进站路径于 context（§6.2 缺陷 13）。
   - `ResponseInterceptor.InterceptResponse(clientReq, resp, ...)`（可选，qoder 族）：响应到达客户端前 peek 首帧分类 + 信封剥离 reader 替换 `resp.Body`。
   - 跨边界信号：`upstreamerr.QueueRetryError{RetryAfter}`（排队——**同 Key** 等待重发，10s 封顶 × 180 次，不排除不冷却）、`upstreamerr.BillingLockError{Until}`（per-model 配额耗尽——`MarkRateLimited` 锁到业务时间点后切号；Qoder=UTC+8 当日 24:00）。
5. 认证失败（401/业务码 105）在适配层**先续期凭据**再报错换路——这是唯一该走 refresh 的情形。

## 5. Qoder WASM 桥（P3.4，最复杂件）

`internal/jethub/qoderwasm.go`（`//go:embed qoder_auth_wasm.wasm`，298,606B，取自 Qoder 0.3.4 客户端）+ `qoderwasm_bridge.go`（wasm-bindgen glue 1:1，wazero 运行时）。

- **31 个 `__wbg_*` 导入**全签名经二进制探针核对；对象堆 = 1024 undefined + 4 哨兵（**null 独立哨兵**——探测链按 JS 严格相等比较 null !== undefined）。
- **返回值双布局**：字符串类 `ptr/len/valIdx/isErr`；`qodercontext_new`/`prepareInferRequest` 类 `ptr/errIdx/isErr`。混用 = `null pointer passed to rust`。
- **`requestresult_url|body(stack, ptr)` 栈指针在前**（与直觉相反）。
- **实测首要坑（排障必读）**：getrandom 源探测链 `globalThis.crypto → msCrypto → process/Node` 三路全空时 Rust panic，panic=abort 下直落**裸 `unreachable`**、完全不经过 `__wbindgen_throw`——修法是 `__wbg_crypto_*` 必须返回非 undefined 的 crypto stand-in 强制走浏览器分支（随机填充落 d493 内存导入）。
- 每账号一个 WASM 上下文（token 指纹失效重建）；加密推理链：`generate_runtime_auth_fields`（uid+security_oauth_token → encrypt_user_info+key）→ `qodercontext_new(sp, machine, ver, userInfo, meta)` → `qodercontext_prepareInferRequest(sp, ctx, host, body, modelKey, source)` → `requestresult_headers/url/body`。
- 出站 URL = WASM 给出的 `https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`（⚠️ 与公开端点 host `api2-v2` **不同**，混用 404）。
- 响应解包（`qoder_envelope.go`）：每帧信封 `{headers,body,statusCodeValue,statusCode}` 剥壳；错误帧**保真转发** `{code,message,type:'model_error'}`（code 独立、message 不拼后缀——否则排队二次解析拿不到延迟）。

## 6. 11 provider 矩阵（端点/协议族/签名/积分）

| provider | 协议族/推理端点（真实出站 URL，§6.2） | 登录 | 出站签名/头族要点 | 续期 | 积分 |
|---|---|---|---|---|---|
| codearts | OpenAI 兼容 `snap-access…/api/v2/chat/completions` | 两步 OAuth（随机端口回调 + PKCE/DPoP） | `SDK-HMAC-SHA256`（maas_type 参与签名；**签的是上游 URL**，§6.2）+ benefit 兜底 | refresh_token | 签到五步流 + 余额 |
| buddy / workbuddy | OpenAI 兼容 `{endpoint}/v2/chat/completions`（CN `copilot.tencent.com` / 国际 `www.workbuddy.ai`） | 轮询登录流（11217 继续/12151 账号） | Bearer + X-Domain/X-Product/X-Agent-* 头族 + 按模型族 UA | refresh（终态判定） | 签到（10001 幂等）+ 双层嵌套余额 |
| lobsterai | OpenAI 兼容 `{apiBase}/api/proxy/v1/chat/completions` | 本地回调两步 | Bearer 四头 + Client-Capabilities（kimi-k3 准入前提） | 匿名 POST + keyfrom | 三步签到 + profile-summary 余额 |
| trae | **SOLO 私有协议** `{agentHost}/api/agent/v3/llm_utils_chat`（⚠️ 响应仍是 SOLO SSE，转换未实现，§6.2） | 回调双流程（token 直传 + PKCE 并行） | `Cloud-IDE-JWT` + X-* 头族 + OpenAI→SOLO body 转换 | ExchangeToken 轮换 | 签到（9074 设备级限流→代次派生绕开） |
| cline | OpenAI 兼容 `{apiBase}/api/v1/chat/completions` | WorkOS 设备码 | `Bearer workos:<jwt>` 前缀必须保留 | 驼峰 `{refreshToken,grantType}` | 余额（`usr-` id） |
| raccoon | OpenAI 兼容 `{base}/api/web/llm/v2/chat/completions` + extra_body.thinking | 微信 QR + 短信 | AES-128-CFB 手机加密 + Bearer | 200003 终态 | 登录奖励 + 新手礼包 |
| loomy | OpenAI 兼容 `{apiBase}/chat/completions` | **短信验证码**（不可静默续期，诚实 `refreshable:false`） | CAccount HMAC-SHA1 双头 | —（无） | 双积分池 + 新手任务 |
| minimax | **Anthropic Messages** `POST /mavis/api/v1/llm/v1/messages`（§6.1：进站 OpenAI 时双向转换；进站 `/v1/messages` 时原生透传） | 设备码（scope 硬校验 agent.default） | `mmoat_` 非 JWT + Authorization Bearer（无 anthropic-version、无 x-api-key） | refresh 回退上一个 | 签到（timezone_id 必填）+ Σ remaining_amount |
| qoder / qodercn | **加密端点**（WASM 签名体，§5；同协议族双产品） | PKCE 设备码轮询（404=未就绪继续） | COSY 签名头原样透传 + `/sash/` 四头 | refresh_token + machine_id | 余额三包 + 每日领取（replayed 幂等） |

模型表全部为**静态兜底表**（`*_model.go`/`products.go`），收录 ref 实测可用的目录 key；qoder 双站表**不能互相套用**（CN 独有/缺失条目 + per-model is_reasoning/is_vl 差异）。

### 6.1 MiniMax 推理协议桥（Anthropic Messages；真实缺陷 10 + 修复）

- **真实缺陷 10（用户实测报障，trace `r28I4T2cXFlA-1`）**：`provider=MiniMax Code` 的请求打到 `https://agent.minimax.cn/v1/chat/completions`，上游回 **404 + Next.js HTML**（`__next_error__` / `NEXT_NOT_FOUND`）。两处根因：
  1. **端点路径错**：MiniMax 推理端点是 `POST {apiHost}/mavis/api/v1/llm/v1/messages`（Anthropic Messages，ref `minimax-product.ts` 的 `MINIMAX_INFER_PATH`，2026-09-29 真机实测），而产品表把 `BaseURL` 填成了 host 根 —— jethub 的 URL 由 `urlutil.BuildUpstreamURL(BaseURL, 进站路径)` 构造，于是变成 `{host}/v1/chat/completions`。⚠️ 也**不能**靠带路径的 BaseURL 解决：`urlutil` 会把结尾的 `/v1/messages` 当已知端点后缀**剥掉**再拼进站路径。故改由 `Manager.Customize` 显式返回完整 URL（与 qoder 族同一机制、不同来源）。
  2. **没有协议转换**：上游只讲 Anthropic Messages，而进站是 OpenAI chat-completions（本项目不做格式转换的红线**只约束代理核心**；桥接 provider 的差异一律收敛在各自的 augmenter/自定义钩子里，trae 的 SOLO、qoder 的 WASM 加密体同例）。
- **四条路径（按进站协议 × 是否流式）**：

  | 进站 | 是否流式 | 出站 | 响应 |
  |---|---|---|---|
  | `/v1/messages`（Anthropic 客户端） | 是 | 原样透传（只补 `stream:true`） | **字节级透传**（「Anthropic Messages 原生透传」） |
  | `/v1/messages` | 否 | 同上 | 聚合成 Anthropic `message` 对象（⚠️ 不含 thinking 块，见下） |
  | `/v1/chat/completions` 家族 | 是 | OpenAI → Anthropic 请求体（`minimax_convert.go`） | Anthropic SSE → OpenAI `chat.completion.chunk`（`minimax_stream.go`） |
  | `/v1/chat/completions` 家族 | 否 | 同上 | 聚合成 OpenAI `chat.completion` |

  上游**只有流式分支**（ref 恒发 `stream: true`），故出站一律 `stream:true`，再由上表决定对客户端呈现什么。
- **请求体转换要点**（判据源自 ref `minimax-messages.ts`，2026-09-29 实测）：`system`/`developer` 消息提到顶层 `system` 字符串（多条按序以空行拼接；**绝不**下发 system 角色消息）；`role:"tool"` → user 消息内的 `tool_result` 块（Anthropic 没有 `role:"tool"`）；assistant `tool_calls` → `tool_use` 块（`arguments` 解析失败/空 → `{}` 但**块必须保留**，否则后续 `tool_result` 变孤儿块被拒）；`tools[].function.parameters` → `tools[].input_schema`；图片只接受 `data:` URL → `{type:"image",source:{type:"base64",…}}`（上游明确拒绝 `image_url`，远程 URL **显式报错**不静默丢图）；历史 `reasoning_content` **不回传**（无签名 thinking 会被拒）；`max_tokens` 是 Anthropic 必填 —— 进站缺省时按模型上限补（四个模型均 128000，未知模型 8192）；相邻同角色消息**合并**（Anthropic 要求角色交替，而 OpenAI 历史常不满足）。
- **思考档位三态**（`minimaxThinkingPlan`，与 ref 同序判定）：`none` → `{type:"disabled"}`；`on` → `{type:"adaptive"}`；`M3.1*` 前缀 ⇒ **强制 adaptive**（传 disabled 会被服务端硬拒 400/2013）；其余有档位值 ⇒ adaptive + `output_config.effort`；**无档位 ⇒ 整个 `thinking` 键都不发**（安全默认，实测 200）。档位必须先过**声明侧门禁**（`minimaxDeclaredEfforts`）：M3.1 = 6 档 `default/low/medium/high/xhigh/max`；M3 = 仅 `on`/`none`（远端无 `effort_options`，不要凭空补档位）；M2.7 系 = **不声明**（forced_on，传 disabled 会被静默忽略）；未知模型 = 不声明 ⇒ 客户端给的档位一律丢弃。⚠️ 两端判据必须同源，否则「UI 给了选项、请求却丢掉」。
- **响应转换要点**：`message_start` → 首帧带 `role:"assistant"` + 收 `usage.input_tokens`/`cache_*`；`content_block_delta` 的 `text_delta`→`content`、`thinking_delta`→`reasoning_content`、`input_json_delta`→`tool_calls[].function.arguments` 片段；**`signature_delta` 必须丢弃**（否则回答里出现一串十六进制）；`message_delta` → `stop_reason`（`tool_use`→`tool_calls`、`max_tokens`→`length`、`refusal`/未知/缺失→`stop`，**不编成 error**）+ `usage.output_tokens`/`thinking_tokens`（`thinking_tokens` 是 output 的**子集**，只映射 `reasoning_tokens` 不累加）；收尾发 finish 帧 + `choices:[]` 的 usage 帧（本项目用量统计读它）+ `[DONE]`。**流结束必须冲刷 buffer 余量** —— 截断流里携带 `stop_reason`/`usage` 的收尾帧就在最后一行（ref 修过的真实缺陷：症状是 `max_tokens` 被误报成 stop、usage 恒 0）。prompt_tokens 口径 = `input_tokens + cache_read + cache_creation`（OpenAI 无缓存列，分开存会让用量被低估）。
- **错误通道**：非 2xx 的 Anthropic 错误体改写成 OpenAI 形状，但**保留原始 `type` 字符串**（402 的 `insufficient_balance_error` 是 `rotation.IsBalanceExhausted` 的判据，丢了就不会锁 key），状态码不变（分类仍由 rotation 按状态码做）。**错误帧恒在第一帧** ⇒ 拦截器 peek 首个 `data:` 行（⚠️ Anthropic 的错误帧是 `event: error` + `data:` 两行，不能只 peek 第一行，否则重演 Qoder「干净地停止、无任何报错」）并让本次尝试失败以触发重试；200 但**没有任何内容块** ⇒ 显式报错（静默空回复比报错更糟）。
- **探针（重测按钮）同路**：`probeEntryPath("minimax")` 给 `/v1/messages` + Anthropic 体，`Customize` 把 URL 覆盖为完整端点，augmenter 补 `stream:true` —— 与真实推理共用同一条管线。
- ⚠️ **未实测/未移植**：M3 的 `on`/`none` 之外无档位；非流式聚合的**响应**形状未经真机验证（参考实现从未发过非流式请求，上游只有流式分支）；思考块在 Anthropic 非流式聚合里被丢弃（无签名，回传会被拒）；`tool_choice:"none"` 不下发（Anthropic 无对应形态）。

### 6.2 推理端点必须逐 provider 显式声明（真实缺陷 12/13 + 修复）

**缺陷 12（整族，用户实测 raccoon 405 触发排查）**：桥接 provider 的出站 URL 原由
`urlutil.BuildUpstreamURL(BaseURL, 进站路径)` 构造，而多数产品的 `BaseURL` **只能**填
host 根（登录/签到/积分端点共用它）—— 于是真实推理路径永远拼不出来：

| provider | 拼出来的（错） | 真实端点（ref 依据） |
|---|---|---|
| buddy / workbuddy | `{endpoint}/v1/chat/completions` | `{endpoint}/v2/chat/completions`（buddy-adapter.ts:1621） |
| lobsterai | `{host}/v1/chat/completions` | `{apiBase}/api/proxy/v1/chat/completions`（lobsterai-adapter.ts:11） |
| trae | `{host}/v1/chat/completions` | `{agentHost}/api/agent/v3/llm_utils_chat`（trae.ts:44） |
| cline | `{host}/v1/chat/completions` | `{apiBase}/api/v1/chat/completions`（cline-product.ts:301） |
| raccoon | `{host}/v1/chat/completions`（nginx **405**） | `{base}/api/web/llm/v2/chat/completions`（raccoon-adapter.ts:431） |
| minimax | `{host}/v1/chat/completions`（Next.js **404**） | `{host}/mavis/api/v1/llm/v1/messages`（minimax-product.ts:192） |

**指纹**：`buddyChatPath`/`lobsteraiChatPath`/`traeChatPath`/`clineChatPath` 四个常量在 Go 里
**定义了但零调用** —— 路径从未进入出站链路。`BaseURL` 也救不了这些情况：`urlutil`
会先把结尾的已知端点后缀（`/v1/chat/completions`、`/v1/messages`…）**剥掉**再拼进站
路径，所以 minimax 那种「填完整端点」反而变成 `…/llm/chat/completions`。

**修复（唯一真相源）**：

1. `Product.InferURL`（`bridge.go`）声明该 provider 的**完整**推理端点；
   `RegisterProduct` 登记即发布给 `Manager`（`SetInferURL`），**产品表是端点真相的
   单一来源**。qoder/qodercn 不声明（完整 URL 含查询串，由内嵌 WASM 算出）。
2. `Manager.Customize` 对已声明的 provider 原样返回该 URL（`Config` 之外的路径不再
   依赖 urlutil 启发式）；`probe.go` 的探针共用同一条管线，故「重测」与真实推理的
   端点天然一致（缺陷修复前两者**都**是错的）。
3. **`/v1/messages` 进站**：只有 minimax 是 Anthropic 原生；其它 provider 无 Anthropic
   端点，修完 chat 入口也**不要**指望该入口。

**缺陷 13（codearts 签名路径，同一轮审计发现）**：`codearts_augment.go` 用
`r.URL.String()` 做 SDK-HMAC 签名，而代理交给 augmenter 的是**客户端**请求对象
（进站路径 `/v1/chat/completions`），参考实现签的是**上游 URL**（`/api/v2/chat/completions`）
—— canonical URI 不一致 ⇒ 真机应当验签失败；而探针因为自建上游 URL 反而签对，
症状是「**重测通过、正常调用失败**」（很好的诊断指纹）。修复：`Customize` 在调用
augmenter 前把 URL 换成完整上游地址 —— 用 `r.WithContext(...)` 的**浅拷贝**（Header map
共享，augmenter 的头改写仍然落到代理读的 `clientReq.Header`）并只改拷贝的 URL，
原请求对象不被污染；**原始进站路径随 context 传给 augmenter**（`clientEntryPathOf`），
因为 URL 被改写后它就不再是进站协议的线索 —— minimax 靠它区分 OpenAI/Anthropic
两条转换路径（不改写 context 的话 OpenAI 进站会被误判成 Anthropic 原生透传，
协议转换被静默跳过）。

**顺带的诊断改进**：`forward_retry.go` 现在用 `resp.Request.URL`（net/http 记录的真实
出站请求）覆盖 trace/用量里的 URL。此前记录的是 Customize **之前**的猜测值 ——
raccoon/minimax 两次报障的 trace 里那个 URL 其实**从未被请求过**，白费了一轮排查。

**回归**：`internal/jethub/inference_url_test.go` —— 逐 provider 与参考实现端点比对
（`TestInferenceEndpoints`，改产品表即红）+ 每个 provider 的 `Customize` 返回值 +
qoder 族必须**不**声明 + codearts 签名看到的是上游路径且原请求未被污染 +
`RegisterProduct` 的发布/撤销语义。

**⚠️ trae 的剩余缺口（未修）**：trae 的响应是 SOLO 自定义 SSE（`output`/`token_usage`/
`done`/`error`），本端**只有** `trae_solo.go` 的解析/聚合工具（`parseTraeSSELine`/
`aggregateTraeSSE`，目前仅被测试使用），**没有**接到 `InterceptResponse` —— 即 URL 修好后
trae 仍不能用于 OpenAI 客户端（会收到无法解析的事件流）。补齐需要一条 SOLO→OpenAI
的流式转换 reader（参考 `minimax_stream.go` 的形状）。

### 6.3 模型列表与倍率：静态表 vs 插件的远端目录（真实缺陷 16 + 部分修复）

**插件的模型列表从哪来**（本轮逐条核对 ref）：

- 面板调 `model.list` RPC（`jet-hub-rpc.ts`），**优先取适配器 `listAllModels()`**；
  面板只渲染 `name` —— **倍率是各适配器拼进 `name` 的文本**，不是独立字段
  （`trae-adapter.ts` / `qoder-adapter.ts` / `lobsterai-adapter.ts` 三家同款）。
- **trae / lobsterai = 远端目录优先 + 静态兜底**；**qoder / qodercn = 纯静态表**
  （ref 明说模型列表端点需 WASM 签名，故不发请求，表即采集时刻快照）。
- 倍率字段：trae = `display_contact_config`（JSON 字符串）→ `consumption_rate.data.rate`；
  lobsterai = `costMultiplier`（裸数字）；qoder = `priceFactor` + `promotion{before, discount, window}`。
  免费只在倍率**恰为 0** 时成立。

**本端现状**：模型列表**只有静态表**，没有任何远端目录拉取 ——
`traeBatchModelsPath`/`lobsteraiModelsPath`/`DecryptQoderModelCatalog`/`raccoonModelCatalog`
四个常量/函数**零调用**（是「打算做但没接」的痕迹）。故：

| provider | 与插件的差距 | 本轮处理 |
|---|---|---|
| qoder / qodercn | 3 条促销倍率错（`qmodel_38max` 被显示成「免费」、`qmodel_latest`/`qmodel` 拿采集时刻折后价当唯一价） | **已修**：† |
| trae | 静态表丢弃了 ref 的 display name（面板显示裸 id）；远端独有的模型（含 0 费档）不在表里；无倍率 | 展示名**已修**；远端目录**未实现** |
| lobsterai | 缺远端已确认存在的 `kimi-k3`（需 capability 头才下发）/`deepseek-flash`/`glm-5.3-flash`；无倍率 | 三条**已补**；倍率需远端目录（**未实现**） |

† **qoder 倍率的修法**（判定与 ref `qoderDisplayName`/`promotionActiveNow` 同源）：

- 免费判据收紧：**只有倍率恰为 0** 才显示「免费」（`FREE (x0)`）。裸 `FREE` 段只表示
  「有免费额度」，显示上必须看倍率 —— 此前无条件当免费，把 `Qwen3.8-Max`
  （实为 `x0.5→x0.2`）显示成「免费」（用户实测报障）。倍率非 0 的 `FREE (x1.5)`
  现在会显示 `x1.5` 而不是丢信息。
- 促销窗口：Note 新增受支持段 `promo HH:MM-HH:MM xN`（基础倍率仍是同条目的 `xM` 段）：
  窗口内展示 `xM→xN`，窗口外只展示 `xM`；窗口按 **UTC+8 墙上时间**判定、支持跨零点
  （22:00–08:00），与机器时区无关。这样与插件在**两个半天里都一致**（静态写死折后价
  会让用户在窗口外按折扣价预期、实际按原价计费 —— 这正是 ref 的注释所警告的）。
- 回归：`internal/api/jethub/register_test.go` 的
  `TestModelDisplayPartsPromotionWindow`（窗口内/外/边界 × 两个时区表达）+
  `TestQoderModelRatesMatchPlugin`（qoder 与 qodercn 逐条对账，期望值取自 ref
  `qoder-product.ts`）+ `TestTraeModelsCarryDisplayNames`。

**未实现的正确修法（下一步）**：trae 与 lobsterai 的**远端目录拉取**（含解析与失败回退）。
远端 ID 集合会随服务端变化（ref 明确警告不要把某一刻的远端条目写死），故「把静态表抄长」
追不上，必须拉远端：trae `POST {agentHost}/api/ide/v1/batch_get_detail_param`（22 个通道 +
`traeSOLOHeaders`，解析 `function_configs[].config_info_list[]`，倍率在
`display_contact_config → consumption_rate.data.rate`）、lobsterai
`GET {apiBase}/api/models/available`（**必须带** `X-LobsterAI-Client-Capabilities:
kimi-k3-agentic-v1,thinking-level-control-v1`，否则少 `kimi-k3`）。qoder/qodercn 无需远端。

### 6.4 CodeArts 的「HTTP 200 + 流内 `error_code`」（真实缺陷 17 + 修复）

**用户实测（trace `r28I5xUHpjJs-2` / `r28I5xdd3XRo-3` / `r28I5xoCTGFY-4`）**：codearts 请求
返回 `respStatus=200`、`decision=success`，而响应体是流内错误帧 —— 客户端于是**只看到空回复**
（正文空、连 finish 帧都没有），真正的错误被静默吞掉。与 Qoder 那次「干净地停止、无任何
报错」同型。

| trace | 模型 | 上游 | 真实原因 |
|---|---|---|---|
| `…-2` | `deepseek-v4-flash` | **200** + `{"text":"[DONE]","error_code":"InferHub.ModelArts.81114.429","error_msg":"Too many requests, the rate limit is 500000 tokens per minute."}` | TPM 限流（200 表达） |
| `…-3` | `deepseek-v4.1-flash` | **200** + `{"error_code":"InferHub.4004.200","error_msg":"benefit not found", …}` | 该账号没有这个模型的 benefit 权益 |
| `…-4` | `glm-5.3-flash` | **400** + `{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。"}` | 并发会话上限（**每个账号 3 个**） |

**修复**（`codearts_response.go`，判据/延迟/上限 1:1 对齐 ref `llm-adapter.ts`）：

- **200 也要判流内 `error_code`**：peek 首个 `data:` 帧（非 SSE 体则整体当 JSON 看）；
  `error_code` **非空**才算错误帧（正常帧只有 `text`，终止帧 `{"text":"[DONE]"}` 没有
  `error_code`）。命中的处理分两类：
  - **排队/限流**（`TM.00001041`，或码里含 `81111|81114|TPM|429|rate limit|too many
    requests|排队|限流`）⇒ 与 ref 一致：**等 10s 后用同一个 Key 重发整个请求**（不冷却、
    不换号），上限由代理的 `maxQueueAttempts`（180 次 ≈ 30 分钟）兜底。这正是 ref 对
    `TM.00001041` 的处理方式。
  - **其它**（如 `benefit not found`）⇒ **让本次尝试显式失败**并带上上游 `error_code` +
    `error_msg`，由代理按分类换号/重试/把真实原因报给客户端 —— 而不是返回一个空回复。
- **400 的排队文案兜底**（ref `isQueueError` 的非 `TM.00001041` 分支）：`peak usage` /
  `try again after` / `peak hours` / `high demand` / `too many requests` 同样按排队处理。
- 其它错误**原样透传**（代理统一分类），且 peek/读取过的 body 会**完整还回** `resp.Body`；
  正常 SSE 流经 peek 后**逐字节不变**（两条都有回归锁）。
- ⚠️ **未移植**：ref 对「未命中文案的 400」还会探测 `api/v1/queue/status`
  （`CodeArtsQueueStatusBase` 在本端仍是零调用常量）来判断会话是否在排队；本端对这类响应
  直接透传（用户看到的是真实错误，不会被静默吞掉）。
- ⚠️ **流中途**出现的错误帧无法再变成 HTTP 错误（响应头已发出），只能原样转发；实测这类
  错误恒在首帧，故 peek 覆盖了实际情形。
- ⚠️ `Chat-Id`/`Session-Id` 本端是**每账号稳定值**（`chatSessionID(keyID)`，为让
  `prompt_cache_key` 跨调用生效），而 ref 是**每次适配器实例随机 UUID**（会话级）。这是
  有意的差异，与本缺陷无关（并发上限是账号维度的）。
- 回归：`internal/jethub/codearts_response_test.go`（8 个，其中 4 个直接用上表的真实响应体）。

## 7. 备份/恢复（与原版 Jet Hub 双向兼容）

- 载荷 `BackupPayload`（`internal/jethub/backup.go`）与 ref `types.ts` **逐字段同构**：`{format:"dsh-codearts-auth/backup", version:1, exportedAt, credentials: ref→JSON 原文字符串, accounts: ProviderAccountEntry[], disabledModels, permanentLocks?}`。
- **加密壳在浏览器**（`crypto.subtle`，与原版 backup-crypto.js 同参数：PBKDF2 310000 / SHA-256 / AES-256-GCM / salt 16B / iv 12B，`format: dsh-codearts-auth/backup.encrypted`）；明文载荷由 Go 组装/导入（`GET /api/jethub/backup/export`、`POST /api/jethub/backup/import`）。
- 导入语义：账号按**原 id upsert**（幂等）、凭据 JSON **原文直存不重新序列化**、黑名单整体替换、格式/版本硬校验拒绝；导入后全桥接 provider SyncKeys。
- **permanentLocks（锁定永久积分）已实现双向迁移**：导出写 sanitize 后的表（只留 true，恒有该键）；导入按原版 `locksFromPayload` 三分支——有表→整体替换（过滤脏值）、仅有旧版 `loomyPermanentLocked`→只落 loomy、两者皆无→保持当前值。
- 实测兼容性：原插件导出的备份已由用户**实际导入成功**（2026-10-01）；反向（本端导出→原插件导入）为源码级逐字段推证。

## 8. 错误语义（两条通道共用一套判据，`qoder_queue.go`）

| 形态 | 判据 | 处理 |
|---|---|---|
| 排队 10605 | `ParseQueueError` BFS 穿透 data/result/message/body（外层整体与内层消息两种入参；瞬时排队 `isQueued:false` 不要求 true） | 同 Key 按服务端延迟等待重发（<10s 遵其值，≥10s 封顶 10s，180 次上限） |
| 计费 110 | 业务码 + **窄文案兜底**（`billing daily count exceeded`/`billing_error`；泛词会误伤正文） | per-model 锁至 UTC+8 当日 24:00（纯算术，不取本机时区）+ 切号 |
| 认证 105/401 | 业务码/状态码 | 续期凭据后报错换路（唯一走 refresh 的情形） |
| 重复请求 | `duplicate_request` | 直接重发，不续期 |

## 9. 测试与已知限制

- `internal/jethub/sessions_test.go`（6 个）：SettleAndCleanup 三路径（失败删占位 / 成功保留 / complete 失败删占位）+ `SessionStatus` 未结算快照 + 宽限期 reap + `SetProxyURL` 代理分派（httptest 伪代理端点验证请求确实走代理）+ `ProxyEnabled` 开关分派 client 并跨 reload 持久化。
- `internal/jethub/credentials_key_test.go`（5 个）：**空 config 密钥下凭据可存**（本次报错的直接回归）+ 自持密钥稳定且不等于 config 密钥 + config 密钥旧文件迁移（迁移后无 config 密钥也能读）+ 无法解密时必须显式报错 + 浏览器 opener 被调用。
- `internal/jethub/cline_test.go`：轮询状态机（400 pending/slow_down 继续、denied 终态）+ **8 个诊断用例**（2xx+pending 不被误判、非 JSON 体点名、空体点名、意外 JSON 形状列出键名、未知 error 码带出码+描述+出站、纯文本 400 带出响应体+出站、invalid_client 专门文案、camelCase token）——§3.3。
- `internal/jethub/minimax_convert_test.go`（14 个）：出站 URL 必须由 Customize 覆盖为完整推理端点 + 其他 provider 不受影响 + Anthropic 进站原样透传（只补 stream）+ OpenAI→Anthropic 富体（system 折叠/图片 base64/tool_use+tool_result/tools+tool_choice/max_tokens 默认/相邻同角色合并/远程图片显式报错）+ **思考三态判据表**（12 例：M3.1 拒 disabled、M3 只能 on|none、M2.7 不声明、未知模型不声明）+ 流式转换（reasoning/content/tool_calls/usage/finish）+ **截断流冲刷**（stop_reason=length、usage 不丢）+ 非流式两种聚合 + 首帧错误拦截 + 错误体改写保留 `insufficient_balance`（§6.1）。
- `internal/api/jethub/login_page_test.go`（6 个）+ `internal/api/jethub_login_page_public_test.go`（2 个）：公开登录页端点（二维码内容/404/状态生命周期/不泄露账号 id）+ **在开启密码保护的真实路由器下**断言 `/api/jethub/login-page` 未被鉴权拦截（404 来自 handler）而 `/api/jethub/providers` 仍 401，静态页与 `raccoon-qr.js` 公开可取（§3.4）。
- `internal/jethub/inference_url_test.go`（5 个）：**逐 provider 推理端点与参考实现比对**（buddy/workbuddy/lobsterai/trae/cline/raccoon/minimax/codearts/loomy 九条，改产品表即红）+ `Customize` 返回值一致 + qoder 族必须不声明 InferURL + **codearts 签名看到上游路径且原请求未被污染** + `RegisterProduct` 的发布/撤销语义（§6.2）。
- `internal/jethub/bridge_keys_test.go`（3 个）：**用真实凭据结构体**逐 provider 断言 `accessTokenOf` 非空（缺陷 15 的直接回归 —— 通用假体凭据曾让这个缺陷逃过全部测试）+ codearts Key 取值优先级 + 未注册提取器的 provider 仍走通用 `access_token`。
- `internal/api/jethub/register_test.go`：`modelDisplayParts` 形态表（12 条，含「裸 FREE ≠ 免费」「FREE (x0.5) 显示 x0.5」）+ **促销窗口**（窗口内/外/边界 × 两个时区表达，锁「与机器时区无关」）+ **qoder/qodercn 倍率逐条对账**（期望值取自 ref `qoder-product.ts`）+ trae 展示名（§6.3）。
- `internal/jethub/codearts_response_test.go`（8 个）：**直接用用户 trace 的真实响应体** —— 200 + `81114.429` 限流按排队重试（10s 同 Key）、200 + `4004.200 benefit not found` 显式失败并带出码/文案、400 + `TM.00001041` 并发上限按排队重试、文案兜底三种、其它错误原样透传（body 完整还回）、正常 SSE 流逐字节不变、`error_code` 判据表（§6.4）。
- `web/raccoon-qr.test.js`（6 项）：二维码矩阵**黄金指纹**（由 ref TS 实现产出）+ 结构（finder/确定性/8 掩码互异/容量与参数报错）+ 页面只依赖公开端点且不含凭据字样 + feature 清单登记 + **路由挂载位置守卫**（`RegisterPublicLoginPage(` 必须出现在 `r.Use(authMW)` 之前）——§3.4。
- `internal/api/jethub/register_route_test.go`（3 个）：真 chi 路由级 —— proxy 开关路径形状（正确 200+JSON / 旧错误形状 404）+ 参数校验（缺字段 400、未知 provider 404 带 JSON error）+ `GET /providers` 携带 `proxyEnabled`。
- `web/jethub.test.js`（19 项）：登录流 context 纪律静态守卫（§3.2）+ app.go 必须接线 SyncKeys/browser/proxy 三 hook + SMS 占位账号创建/取消清理 + Use Proxy 开关（渲染/PUT 体/失败回滚）+ **前端 jethub 路径与后端路由表形状守卫** + 其余 UI 行为。
- **已知限制**：SMS 弹窗流程（loomy/raccoon 短信）无服务端 login session——占位账号由**前端**创建，若用户直接关页（非点取消）会留下无凭据占位（灰徽标可见，可手动删除；不影响推理/领取）。扫码登录页未移植「取消后换码刷新」，也没有短信 Tab（§3.4）；minimax 非流式聚合的响应形状未经真机验证（§6.1）；**trae 缺 SOLO→OpenAI 响应转换**（§6.2）；**trae/lobsterai 缺远端模型目录拉取**（模型列表只是静态子集、无倍率，§6.3）；buddy/workbuddy/lobsterai/trae/cline/raccoon 的推理链路**已修 URL 但尚无真机验证**（每个 provider 发一条 `{前缀}/{模型}` 即可确认）。
