# Free Hub (jethub) 架构

> **最后核对：** 2026-10-05（**F-05 桥接出站头空白基底（proxy 侧 §7.1a 契约变更）**：`RequestAugmenter.Augment`/`Customize` 收到的 `r.Header` 从『客户端头全量拷贝』改为**代理新建空白基底**（仅回播 loopback 标记），augmenter 写入即出站集合——§4.4 已更新；各 provider augmenter 的 `for k := range r.Header { Del(k) }` 全删循环**已移除**（12 处：buddy/cline/codearts/gemini/lobsterai/loomy/minimax/opencode/qoder/raccoon/trae/zcode），新增 augmenter **不得也不再**手工清头；客户端凭据结构性进不了桥接上游（ProjectAnalysis F-05 结案，回归 `proxy/bridge_headers_test.go`）。上轮：账号卡片信息全量对齐（R4-0，P0–P2）+ 删除 ZCode 本机凭据路径（R4-1）：额度行门控 `ProviderMeta.HasBalance` 补正四家（minimax/raccoon/trae/cline）+ opencode「通道可用性」额度行；单位标签三态、Gemini 逐窗口百分比、`CreditPackage` 到期字段、前端临时/长期分桶等，见 changelog。
>
> **R1 上游同步落地（2026-10-02，dsh-codearts-auth @ `e06283c` / 分支 `7dd3422`）：** codearts 4004.200 去 `maas_type` 同 Key 重试一次（§6.4，ref 3bf2be7）+ 输出上限收敛 65536（§6.4，ref 916c647/da0a2ad）+ 续期终态判据/refreshable 镜像/per-credential 串行/30min 调度器（§3.7，ref cf5edab）；qoder 每日活动 10:00（UTC+8）刷新窗口（§6.6，ref 1b65a5c）；minimax tool 孤儿剔除与 assistant/结果配对不变量（§6.1，ref c74e0c2）；cline 静态表并入 models.dev 18 条（§6.3，ref caf675e）；**新增 OpenCode Zen provider**（apikey 登录模式 §3.8 + 协议要点 §6.5，ref 分支 7dd3422；匿名通道已真机验证 200）。上游同步流程与 R1 待办勾销见 [`jethub-upstream-sync.md`](jethub-upstream-sync.md)。
>
> **R2 落地（2026-10-02）：新增 ZCode provider（智谱 z.ai 免费额度通道）** —— 13 个 provider。Anthropic Messages 协议桥 + 3012 准入身份块/日期块（逐字内置、sha256 锁死）+ 官方 CLI 设备授权登录 + token 桶余额 + 本地载体页 captcha 的每日领取；真机验证：登录 init / 余额 / 目录 / 推理 200（无 3012）见 §6.7。⚠️ **R4-1（2026-10-05）删除了「导入官方客户端凭据」旁路**（安全/正确性/一致性三条理由见 §6.7）。上游同步中该 provider 原判「不搬」（captcha 依赖桌面窗口）—— R2 重估的依据与差异记录见 [`jethub-upstream-sync.md`](jethub-upstream-sync.md) §6 R2。
>
> **R3 上游同步落地（2026-10-04，dsh-codearts-auth @ `ff5e37d`）：** ① codearts `InferHub.4291.200` 额度用尽判据（**不可重试**，`BillingLockError` 锁 key+model 至 UTC+8 当日 24:00）+ `429` 排队判据锚定为独立数字（裸子串会把 `4291` 误判成排队 → 30 分钟静默重试零输出，§6.4，ref 784210d/ae0c9b0）；② cline 删除已下线的 `cline-free/gemini-3.8-flash`（免费清单 5→4，ref 51d6093）；③ **新增 Gemini Code Assist provider（第 14 家，§6.8）**——OAuth 浏览器回调登录 + 双层信封协议桥 + sandbox 配额窗口（ref e061b21 族）。zcode 双通道+zai 渠道经用户决定**不搬**（同步文档 §5）；`zcode-identity.ts` 未变（已核实）。分诊明细见 [`jethub-upstream-sync.md`](jethub-upstream-sync.md) §6 R3。
>
> Free Hub 是 DeepSeek Harness 插件 `dsh-codearts-auth`（14 个第三方 LLM provider 的账号池 + Web 管理面板，TS/React）的 TinyLab 原生移植：产品名 **Free Hub**，内部包前缀沿用 `jethub`。只读参考副本位于 `ref/deepseek-harness-codearts`（**禁止手工编辑**；每份移植实现的语义权威）。
>
> **变更维护清单（改动时必须同步本文）：**
> - 新增/修改 provider 适配（登录/续期/签名头族/模型表）→ §6 矩阵 + `internal/jethub/` 对应文件；**登录流必须走 §3.2 的独立 context + SettleAndCleanup 约束 + `httpClient(provider)` 代理分派**
> - **修改账号卡片显示的信息（额度行门控/单位标签/分桶/hover 明细/账号规格/序号/按钮/匿名标记）→ §3 + `internal/jethub/manager.go`（`ProviderMeta.HasBalance` 是前端渲染额度行的**唯一**门控）+ `codearts_credits.go`（`CreditBalance`/`CreditPackage` DTO）+ 各 `*_credits.go`/`*_provider.go`（填充到期字段与池）+ `credit_window.go` + `web/static/jethub.js`/`i18n.js`/`style-jethub.css` + **`internal/api/jethub/balance_capability_test.go`（能力位↔路由双向守卫、领取语义位）+ `internal/jethub/credit_fields_test.go` + `web/jethub.test.js` 三组用例**
> - **修改账号顺序/选号优先级（拖拽排序）→ §3 + `Manager.ReorderAccounts` + `PUT /providers/{provider}/accounts/order` + `bridge.go::SyncKeys`（key `Priority` 按池内位置；**不得**再按 ID 重排）+ 前端拖拽与序号徽标 + `internal/jethub/order_test.go`**
> - **修改 per-key 出口代理（opencode per-account proxy）→ §3.10 + `internal/config/types.go`（`Key.Proxy`）+ `internal/proxy/handler.go`（`keyProxyClientsFor`）+ `internal/proxy/upstream.go`（`upstreamClientFor`/`streamClientFor` 的 per-key 分支，**优先级高于 provider 级**）+ `internal/jethub/bridge.go`（`SyncKeys` 写 `Proxy`）+ `internal/jethub/sessions.go`（`SetAccountProxy`/`httpClientForAccount`）+ `internal/api/jethub/opencode.go`（`PUT /opencode/proxy`）+ `internal/jethub/probe.go`（探针同源）+ 前端「代理」按钮 + **`internal/proxy/perkey_proxy_test.go`（设了会绕 + **没设的不绕**）与 `internal/jethub/account_proxy_test.go`**
> - **修改限额重置标记的写入链路 → §3.1 + `internal/rotation/selector.go`（`SetRateLimitObserver`）+ `cooldown.go`/`nim.go`（四条写锁路径）+ `internal/app/app.go`（组合根注入）+ `manager.go::UpdateModelRateLimit`（只延长不缩短）+ `ratelimits.go::parseRateLimitResetTime` + `internal/rotation/ratelimit_observer_test.go`**
> - **执行上游同步（拉取/分诊/推进 pin/新增 provider 评估）→ [`docs/jethub-upstream-sync.md`](jethub-upstream-sync.md)**（判定原则 + 每轮 SOP + 不搬清单 + 待办 R1-*~R4-* + 轮次日志；pin 与当前待办见该文 §6/§7）
> - 新增/修改 **OpenCode Zen** 适配（指纹形状/门禁工具/错误分类/匿名通道/模型可见性/非流式聚合）→ §3.8 + §6.5 + `internal/jethub/opencode.go`/`opencode_augment.go` + `products.go`（`Product.AnonymousKey`/`ModelFilter`）+ `bridge.go`（匿名 Key 优先级/可见性过滤）
> - 修改 **codearts 续期**（终态判据/镜像对账/per-credential 串行/30min 调度器）→ §3.7 + `internal/jethub/codearts_refresh.go`/`codearts_oauth.go`
> - 修改 **codearts 响应判据**（4004.200 去头重试 / 输出上限收敛 / 4291 额度用尽 + 429 独立数字锚定）→ §6.4 + `internal/jethub/codearts_response.go`/`codearts_augment.go` + `internal/upstreamerr`（`SameKeyRetryError`/`RetryDropHeaderMarker`/`BillingLockError`）+ `internal/proxy/forward_retry.go`
> - 修改 **qoder 每日活动窗口**（10:00 UTC+8 刷新前不判已领）→ §6.6 + `internal/jethub/qoder_credits.go`
> - 新增/修改 **ZCode** 适配（3012 身份块/日期块、设备授权登录、token 桶余额、captcha 载体页领取、错误码分类）→ §6.7 + `internal/jethub/zcode*.go`（`zcode_identity_text.go` 是**生成文件**：上游改身份块文本时必须按 ref `src/zcode-identity.ts` 重新提取并更新测试里的 sha256）+ `internal/api/jethub/zcode.go`（含公开载体路由）+ `web/static/jethub.js`（token 量级渲染）。⚠️ **不得重新引入任何「读本机官方客户端数据」的能力**（凭据文件/遥测状态/安装清单）：`zcode_local_read_test.go` 扫源码字面量守着，理由见 §6.7
> - 新增/修改 **Gemini Code Assist** 适配（双层信封/身份五头/档位后缀/schema 白名单/签名回填/OAuth 回调/配额窗口）→ §6.8 + `internal/jethub/gemini*.go`（信封字母序与金标准字节断言不可放松；`gemini_test.go` 金标准用例是唯一防线）+ `internal/api/jethub/gemini.go` + `web/static/jethub.js`（`%` 单位显示）
> - 修改代理桥接接口（RequestAugmenter/RequestCustomizer/ResponseInterceptor）或重试语义 → §4 + `internal/proxy/interfaces.go`/`forward_retry.go`/`upstream.go`
> - 修改 Qoder WASM 桥（导入表/导出封装/对象堆）→ §5 + `internal/jethub/qoderwasm_bridge.go`
> - 修改备份格式 → §7 + `internal/jethub/backup.go`（与原版格式**双向兼容**，改动即破坏兼容，须先读 ref types.ts）
> - 修改 Free Hub UI 布局/入口/详情页/模型列表/Use Proxy 开关 → §3 + `web/static/jethub.js`/`settings.js`/`i18n.js`/`style-jethub.css`/`app-router.js`
> - 修改限流重测/重置探针或永久锁 → §3.1 + `internal/jethub/probe.go`/`ratelimits.go`/`manager.go` + `internal/api/jethub/register.go`
> - 修改 jethub 出站代理分派（`SetProxyURL`/`SetPackageProxyURL`/`ProxyEnabled`）→ §3.2 + `internal/jethub/sessions.go`/`codearts_login.go`/`bridge.go` + `internal/app/app.go`
> - 修改 MiniMax 推理协议（端点 / OpenAI⇄Anthropic 转换 / 思考档位判据 / SSE 映射）→ §6.1 + `internal/jethub/minimax_convert.go`/`minimax_stream.go`/`minimax_credits.go`（augmenter）+ `qoder_adapter.go`（Customize/InterceptResponse 分派）+ `probe.go`
> - 修改 Loomy 微信扫码登录（协议/流程/页面/公开端点）→ §3.5 + `internal/jethub/loomy_wechat.go`/`loomy_wechat_flow.go` + `internal/api/jethub/loomy.go`（`POST /loomy/login`）+ `web/static/free-hub-loomy-login.html` + `manager.go` 的 `loginModes`
> - 修改扫码登录页（页面/二维码/公开端点）→ §3.4 + `web/static/free-hub-login.html`/`raccoon-qr.js` + `internal/api/jethub/login_page.go` + `internal/api/router.go`（**公开挂载点**）+ `internal/jethub/raccoon_provider.go`
> - 修改/新增 provider 的**推理端点**（出站 URL）→ §6.2 + `internal/jethub/products.go` 的 `Product.InferURL`（**唯一真相源**）+ `bridge.go`（登记即发布）+ `qoder_adapter.go`（Customize 覆盖 + 签名用 URL 改写）+ `probe.go`（探针共用同一管线）；qoder 族例外（URL 由 WASM 算出）
> - 修改**模型展示名/倍率**（别名、倍率段、促销窗口、同名变体标记）→ §6.3 + `internal/jethub/*_model.go`/`buddy_product.go` 的静态表 + `internal/api/jethub/register.go` 的 `modelDisplayParts`（受支持段：`xN` / `FREE (xN)` / `promo HH:MM-HH:MM xN`）+ `register_test.go` 的 `TestModelDisplayNamesMatchReference`（展示名非空 / 同 provider 内唯一 / 兜底不编造倍率 / 自带倍率不得丢）+ `web/static/jethub.js` 的模型行渲染与 `{prefix}/{id}` 复制
> - 修改 **jethub 前端 RPC 路径** → §3.2 缺陷 14 + `web/static/jethub.js` + `web/jethub.test.js` 的**全方法路由形状守卫**（从 `internal/api/jethub/*.go` 反推合法形状，改路径必跑）
> - 修改 **CodeArts 响应判据**（200 + 流内 error_code / 排队重试）→ §6.4 + `internal/jethub/codearts_response.go` + `qoder_adapter.go`（InterceptResponse 分派）+ `internal/proxy/forward_retry.go`（QueueRetryError 的等待与 180 次上限）
> - 新增/修改 provider 的 **`/status` 端点或面板登录弹窗轮询** → §3.6 + `internal/api/jethub/<provider>.go`（**`loginId` 分支必须有**，否则弹窗永挂）+ `web/static/jethub.js`（`__jethubLoginWaitingModal` 的三态判据）+ **`internal/api/jethub/status_login_test.go` 的结构性守卫（逐条 `/status` 路由）+ `web/jethub.test.js` 的弹窗状态机用例**
> - 修改**登录浏览器/会话模式**（浏览器轴 / 会话轴 / 隐私窗口 flag 表 / 独立配置目录 / +新建账号 先选后开 / `login-browsers`+`open-login-url` 端点）→ §3.9 + `internal/browserlaunch/`（家族表 + 候选路径 + 默认浏览器解析）+ `internal/jethub/login_open.go`（偏好/校验/开页/目录清理）+ `internal/jethub/codearts_refresh.go`（`SetBrowserOpener`/`OpenURLWithBrowser` 签名）+ `internal/api/jethub/login_open.go` + **各 provider login handler（选择校验必须先于建号）** + `web/static/jethub.js`（`__jethubLoginModal` 选择步 / `jethubLoginConfirm` / `__jethubLoginWaitingModal` 等待步）+ `internal/app/app.go`（`SetBrowserOpener` 接线）

## 1. 模块组成与边界

| 部分 | 位置 | 说明 |
|---|---|---|
| 核心 | `internal/jethub/` | 账号/凭据存储、账号池、registry 桥接、13 provider 适配、WASM 桥、备份 |
| API | `internal/api/jethub/` | `/api/jethub/*` RPC（§10.28 PROJECT_MAP）：providers（含能力位）/prefix/accounts/models（单/批量/恢复默认）+ ratelimits retest/reset + permanent-lock + 每 provider login/status/refresh/claim/balance + backup export/import；**每个 `<provider>/status` 都必须同时服务两种语义**（带 `loginId`=登录流轮询 `{done,success,error}`，不带=账号快照，§3.6）；**另有两条挂在鉴权组之外的公开端点**（`GET /api/jethub/login-page`[`/status`]，扫码登录页的数据源，§3.4） |
| 前端 | `web/static/jethub.js` + `style-jethub.css` | Free Hub 管理界面（vanilla JS，无框架），入口嵌在 Settings 页、main 区内嵌布局（§3）；行为测试 `web/jethub.test.js`（20 项）；扫码登录页 `free-hub-login.html` + `raccoon-qr.js`（测试 `web/raccoon-qr.test.js`，§3.4） |
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
- **布局三段式**：header（一键签到 / 备份 / 恢复 / 关闭，**四按钮一列左对齐**，无右推 spacer）+ left pane（13 provider 列表，账号数徽标单选）+ right pane 五区（调用前缀 / **操作按钮行** / 通知区 / 账号卡 / 模型列表）。
- **详情页操作按钮行**（能力门控与原版 dim-jh-headerActions 一致）：刷新积分（`hasBalance`）· 一键领取积分（`hasCredits`）· 重测所有 + 重置所有（`supportsRateLimit`，loomy 不渲染——它不限流，重测只会白烧额度）· 解锁|锁定永久积分（`canLockPermanent` = {loomy, buddy, workbuddy}）· + 新建账号 · **Use Proxy 开关**（`+ 新建账号` 右侧：`free-hub-proxy-wrap` 标签 + 全局 `.toggle-switch`（同 Upstream Proxy/Provider 详情 useProxy，复用 style-settings.css 不动堆叠规则）；`jethubToggleProxy` PUT `/api/jethub/providers/{provider}/proxy` {enabled}，失败回滚勾选态；per-provider 语义见 §3.2）。结果在通知区显示（tone + 逐条 details 列表）。
- **账号卡**：状态点 + **选号序号**（两个以上账号时显示；值为服务端 `rotationOrder`，**不是列表下标** —— 匿名通道恒殿后，两者会不一致）+ 名称（有派生账号名时挂 tooltip）+ **手机号**（仅 zcode，由 17 位 user_id 前 11 位派生）+ 徽标（启用/key/refresh/**匿名**（opencode 匿名通道，tooltip 解释「额度按出口 IP 计」，判据见下））；元信息行 = 凭据 ref（code）· 有效期（`X 分钟后/小时后`/日期，过期红字 + `· 自动续期`）· **账号规格**（仅 Gemini 有 Pro/Free/Ultra，取不到时**整行不渲染**）· **额度行**（**逐账号**余额，挂载/刷新积分时并发逐个查询；失败时显示**原因**且不阻塞其它卡）；「限额重置」芯片行（仅未到期标记显示，任一标记存在即启用重测/重置；数据来源见 §3.1）；按钮行 = 重测 / 重置（单账号，仅有标记时可用）· 领取（文案随 `claimKind` 走：一次性奖励渠道写作「领取奖励」）· **新手任务**（`supportsOnboardingTasks`，仅 loomy：与每日签到是**两件事**，故独立按钮）· **代理 + 指纹**（仅 opencode，见下）· 续期 · 改名 · 停用|启用 · 删除。整卡可**拖拽排序**（顺序 = 选号优先级，见下）。
- **opencode 的两种「账号分离」手段（两个独立按钮，文案不得混为一谈）**：
  - **出口代理**（`PUT /api/jethub/opencode/proxy`）：匿名通道的额度按**出口 IP** 计 ⇒ 只有给各账号各配一条出口，才会各自拿到独立额度。**不设 = 与其它未设代理的账号共享本机出口（共用同一份额度）** —— tooltip 必须说明这一点（否则「代理」看起来像锦上添花）。空串是**合法值**（显式清除），`promptModal` 返回 `null` 才是取消 —— 把空串当取消会让「清除代理」点了没反应。非法值**当场报错**（静默不生效比报错更糟）。
  - **指纹轮换**（`POST /api/jethub/opencode/fingerprint/rotate`）：账号条目的**代次 +1**，project id 由 `(identity, 代次)` 重新派生。⚠️ **指纹分离不增加配额**（只有换出口才会）。代次以**账号条目**为权威、凭据里的只是下限（ref 记的静默失效形态正是「代次涨了 project id 却不变」）。
  - 端到端链路：账号条目（`opencodeProxy` / `opencodeFingerprintGeneration`，均落 `accounts.json` 且随备份迁移）→ `bridge.SyncKeys` 把代理写进 `config.Key.Proxy` → 代理主干按 `sel.Key.Proxy` 选 per-key transport（见 §3.10）；指纹在 augmenter 里派生。探针也走**该账号自己的**出口（`httpClientForAccount`）—— 从别的出口探测会得到与真实流量不同的结论。
- **额度行的显示规则**（R4-0，与 ref `credits-format.js`/`credit-expiry.js` 对齐）：
  - **门控**：`provider.hasBalance` 是渲染整行与「刷新积分」按钮的**唯一**开关，它来自后端 `ProviderMeta.HasBalance`。⚠️ 漏登记**不会报错**，只会让该渠道**永远不显示额度数字**（本端真实缺陷：minimax/raccoon/trae/cline 四家的余额后端与路由早已存在，能力位却是 false）。`internal/api/jethub/balance_capability_test.go` 做**双向**守卫（路由有 ⇒ 标志必须有；标志有 ⇒ 路由必须有）。
  - **单位三态**：标签与数字都按 `packages[].unit` 走 —— `token` → 「Token」+ `94.54M` 量级；`%` → 「额度」+ 整数百分比；其余（含空串）→ 「积分」。写死「积分」会把 token 余额说成积分（上游用户报障原话：「智谱 plan 给的不是积分是 tokens」）。
  - **配额窗口（Gemini）**：主行显示**逐窗口百分比**（「5 小时窗口 90% · 周窗口 99%」），**不显示两窗口均值** —— 均值是上游根本不存在的数，且在「额度」标签下会被读成 94.5 个积分（上游用户报障原文）。hover 明细用「重置于 …」而不是「本周期至」（配额是滚动重置）。配额单位下**不渲染**「N/M 个资源包有效」。
  - **分桶**（两种互斥）：有当日刷新池的渠道（loomy `每日赠送` / raccoon `每日积分`）走**池名分桶** →「长期 X · 每日 Y」（loomy 的另一个池标签是「永久」）；其余走到期时间分桶 →「长期 Y · 临时 X」（judged by `deductionEndTime` 距今天数是否小于 `windowDays`）。⚠️ 分桶是**渲染时现算**（宿主长期开着、时间只向前流，缓存会让越线的包继续被当成长期）；窗口天数由后端回传（`windowDays`，可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖），前端**不得**写死。
  - **资源包 hover 明细**（账号名/状态标签）：只列**还能用**的包（剩余 > 0、未过期、未失效），按**最快到期在上**排序，最多 12 行，其余汇总成「…另有 N 个包，合计剩余 X」。
  - **失效额度**：`balance.expiredTotal > 0` 时单独一行「另有 N 已失效」——**不并进总额**（那部分服务端仍下发但扣不到）。
  - **账号规格**：`extra.accountTier`（目前只有 Gemini 走这里）；缺席 ⇒ 整行不渲染（不显示「未知」也不报错）。
- **拖拽排序 = 选号优先级**（R4-0）：池内顺序**就是**优先级，桥接时按位置分配 key 的 `Priority`（fill-first 取最小者），故拖动会真实改变下一条请求走哪个账号。⚠️ `SyncKeys` 里曾有一句 `sort.Slice(keys, …ID < …ID)` 把它按 ID 字典序重排 ⇒「拖到第一位」对路由层**完全无效**（已删除，`TestReorderAccountsIsTheRotationPriority` 守着）。提交的是**完整顺序表**（`PUT /providers/{provider}/accounts/order`），服务端做**集合相等**校验（不重不漏）—— 宽松处理会让一次不完整的拖拽把用户排好的顺序**部分**打乱且无法察觉。
- **匿名通道恒殿后**：非匿名账号按池内顺序拿 `0..n-1`，匿名通道从 100 起（`anonymousKeyPriorityBase`）—— fill-first 会取第一个可用 key，匿名槽排前面会让收费模型先撞一次必然 401 的匿名尝试。这是**位置**而非特权降级：匿名账号仍可被拖动/停用/删除。账号 DTO 的 `anonymous` 由**凭据内容**判定（`api_key == "public"`），不用 id 前缀 —— 本端 id 形如 `{provider}-{8hex}`，ref 的 `opencode-anon-` 前缀判据在这里**永远不命中**。
- 登录流按 provider `loginModes` 分派：`url`/`qr` → 登录 URL 弹窗 + 2s 轮询（`{done,success}` 契约）；`sms` → **先创建占位账号**（POST `/accounts` 拿 `accountId`）再弹发码/验码两步弹窗（提交时按 `accountId` 绑定凭据；**取消 = 删除占位**）。URL 弹窗的取消同样删除占位。无凭据的占位账号在账号卡上显示「登录未完成 · 无凭据」灰徽标（`freeHubNoCredential`），领取/推理账号集都会过滤掉它们。
- **模型列表**（展示形态与插件的 `ModelToggle` **逐字对齐**，2026-10-01 规范化）：纵向行 = **一条展示串 `模型名称 · 倍率`**（服务端 `name`+`rate` 两个字段合成一条；无倍率时**不补** ` · `）紧跟着**裸的模型 id** + 删除/恢复单钮 —— 插件渲染的就是 `<strong>{model.name}</strong><code>{model.id}</code>`，且 `model.name` 里已含倍率。倍率**无信息不编造**（解析规则与逐 provider 对账见 §6.3）；**点模型 id 复制的是 `{prefix}/{id}`**（与 Settings provider detail 点模型 id 同形，可直接外部调用；未设前缀时退回裸 id）。批量管理 → 筛选 / 全选|取消全选 / **删除所选**（批量进黑名单，一次写盘 + 一次 SyncKeys）/ 取消；**恢复默认** = 清空黑名单（黑名单语义：删除=隐藏，恢复默认全部找回，被删项灰显带「已隐藏」徽标保持可逆）。
- ⚠️ **扫码类 provider（raccoon）的 `loginUrl` 是本地页面**（`/free-hub-login.html?loginId=…`），**不是**二维码内容——后者要被微信扫码打开，用浏览器直接打开只是普通网页、无法鉴权（真实缺陷 11，§3.4）。
- 样式只用 theme tokens（`var(--…)`），控件复用全局 `.btn`/`.badge`/`.modal`/`.input` 体系。

### 3.1 限流标记重测/重置 + 永久积分锁（后端）

- **标记数据**：`accountEntry.ModelRateLimits`（model id → 重置时刻 ms）。**R4-0 起本端推理链路会真正写入它**：`rotation.Selector.SetRateLimitObserver` 是注入式观察者（rotation **不依赖** jethub，与 `SetStateHook` 同款分层），四条写锁路径（`MarkRateLimited` / `MarkDailyQuotaLocked` / `MarkBalanceLocked` / `MarkNIM429`）每次写 key×model 锁都通知它，组合根（`internal/app`）把它映射到 `Manager.UpdateModelRateLimit`。**写入规则：只延长不缩短**（同一次限流会在多条路径上重复上报，后到的那条不能把解禁时刻往前提），空模型名拒收（会落下一个 UI 上「没有模型名」的 chip）。该表另可由**原版备份导入**携带（原插件的限流状态）；重测/重置即是对这份数据的操作。内部记账键（`__` 前缀，如 trae 的签到代次）不参与重测/计数/渲染。
- **重测** `POST /api/jethub/{provider}/ratelimits/retest` `{accountId?}`（`Bridge.RetestRateLimits`）：对每个标记的 (账号, 模型) 经 `Bridge.ProbeAccountModel`（`probe.go`）**真实发送一条最小消息**（OpenAI 体；minimax 走 `/v1/messages` + Anthropic 体，且由 Customizer 覆盖为完整推理端点，§6.1；max_tokens=16）。探针**复用代理的 augmenter/customizer 管线**（`Manager.Customize`——codearts HMAC、qoder WASM、trae SOLO、minimax 协议桥都由各自 augmenter 完成，探针零协议实现）；URL 用 `urlutil.BuildUpstreamURL(base, entryPath)`，qoder 族与 minimax 由 Customizer 返回完整端点覆盖。HTTP 200 → 清除该标记；非 200 → 保留并在响应 `accounts[].stillLimited[]` 带原因（含状态码 + 截断报文）。⚠️ **仍然受限时会把上游给的「新」解禁时刻写回**（`parseRateLimitResetTime`：中英两种句式 + **捕获**时区；解析不出来则保持原值不动）—— 限流是滚动窗口，只报结果不更新的话旧时刻一过期，卡片上那一行就会凭空消失，出现「重测说仍受限、卡片却一条都不显示」的矛盾（ref `ProbeModelResult.resetTimeMs` 的同因）。会消耗少量额度——前端「重测所有」先确认。
- **重置** `POST /api/jethub/{provider}/ratelimits/reset` `{accountId?}`：直接清除（跳过 `__` 键），不发任何请求。
- **永久积分锁** `PUT /api/jethub/{provider}/permanent-lock` `{locked}`：provider 级开关（`accounts.json` 的 `permanentLocks` 表，仅 true 值有意义），能力白名单 {loomy, buddy, workbuddy}（原版 `PERMANENT_LOCK_PROVIDERS`）；`GET /providers` 每项带 `supportsRateLimit`/`canLockPermanent`/`permanentLocked`。⚠️ **选号侧的「锁定后只消耗临时积分」策略未移植**（需要对选号注入积分池感知）——开关持久化 + 随备份迁移已可用，语义见 §7。

### 3.2 登录流生命周期（+新建账号 的真实缺陷与修复）

登录是**两步式**：login handler 立即返回 `loginUrl` + `loginId`，后台轮询/回调等用户在浏览器完成授权（数十秒到数分钟）。这条结构曾引出五个真实缺陷（用户实测复现：占位账号立即出现、浏览器不自动打开、弹窗永远停在等待、凭据永不落盘、`TLS handshake timeout`/prefix 检索不到）：

1. **请求上下文绑定**：`Start*Login(r.Context(), …)` / 后台 `Poll*(r.Context(), …)` —— handler 写完响应后 `net/http` 立即取消请求 context，后台轮询当场夭折。修复：**所有登录流一律 `context.Background()`**（raccoon/cline/trae/lobsterai/buddy/minimax/qoder；codearts 流自身已是 Background）。qoder 最早注释了这个坑但其余 provider 全部中招。`web/jethub.test.js` 有静态守卫（逐文件断言 `context.Background()` + 禁止 `Start*Login(r.Context())`）。
2. **双消费者竞争**：status 轮询（`pollLogin`）与 API 层 pump goroutine 都直接读 `LoginSession.Started.Result`（容量 1 的缓冲 channel），先到者独占 outcome，另一方永久挂起。修复（`internal/jethub/sessions.go`）：**单赢家纪律** —— 只有 pump（`SettleAndCleanup`）读 channel 并记录结果（`settled` 状态 + `SessionStatus` 只读快照）；status 轮询改读记录态。
3. **结算即 reap（弹窗永远停在等待）**：pump 结算后立即 reap session 的话，2s 轮询的下一次请求必然 404 —— `done:true` 转换永远不会被前端观察到，即使后端已成功。修复：结算后保留 `loginSessionGracePeriod`（30s，若干轮询间隔）再 reap。
4. **凭据落盘后桥接 Key 不刷新（prefix 检索不到）**：`SetCredential` 的 `onAccountCredentialed` hook 在 app 装配层**从未接线**（git 历史确认：hook 定义了但无人调用）——登录成功后桥接 provider 的 Keys 永远不更新，新账号对 `{prefix}/{model}` 路由不可见；备份导入能工作只是因为 `backupImport` 显式重同步。修复：`app.go` 装配 `SetAccountCredentialedHook(→ Bridge.SyncKeys)`。同时接线 `SetBrowserOpener`：+新建账号自动打开授权页（对齐原插件；弹窗内链接保留为手动兜底）。⚠️ 2026-10-05 起 opener 改为**按请求携带浏览器/会话选择**（签名 `func(url string, opt OpenOptions)`，app 接到 `Manager.OpenLoginURL`），见 §3.9。
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

### 3.5 Loomy 微信扫码登录页（真实缺陷 18 —— 行为与插件不符）

**用户实测报障**：「loomy 渠道的添加不是弹窗打开浏览器，而变成了直接在项目内的 modal
弹窗中要求输入电话号码和验证码，与插件中的行为不符」。

**插件的真实行为**（ref：`jet-hub-rpc.ts` 的 loomy 分支 + `loomy-wechat-login.ts`）：
`+新建账号` → 写占位账号 → `startWechatLogin()`（起本地服务器）→ 返回**本地页 URL** →
`window.open`；页面是**单卡片、无 Tab**：微信二维码 + 状态，**手机号表单只在「微信已扫码
但讯飞侧未绑手机号」时**才出现。⚠️ 插件面板**从不**渲染短信表单 —— `login.sendSms` /
`login.submitSms` 是**无 UI 的休眠备用 RPC**（早期那个短信表单分支因**顺序死锁**已被删除）。

**本端实现**（复用 §3.4 的公开页机制，但**独立页面**：loomy 的二维码是微信下发的 **JPEG
图片**，不能用文本→SVG 那条路，混用会把 raccoon 拖进回归）：

| 件 | 位置 | 要点 |
|---|---|---|
| 协议层 | `internal/jethub/loomy_wechat.go` | 授权页 URL（appid `wx18d60be432287cf8` + **官方白名单 redirect_uri** + `#wechat_redirect`）、uuid 正则提取（img 主路径 + 长轮询兜底）、二维码图片（**按魔数**认 jpeg/png/gif）、长轮询 `long.open.weixin.qq.com/connect/l/qrconnect`（**405=已确认带 code / 404=已扫码待确认** —— 参考实现曾读反，导致扫码后永远等不到 code）、`bind/auth`·`bind/skip`·`bind/sendMsg`·`bind/checkCode` 四步 |
| 流程 | `internal/jethub/loomy_wechat_flow.go` | 宿主侧状态机（uuid/rcode/bind/nickname/msgid **只在此**）+ **页面驱动**：页面每轮调一次公开 poll 端点 → 宿主执行一次微信长轮询并推进；`need_phone` 中间态；5 分钟总超时；cancelled/expired **立即结算**（比参考更紧一档：参考要等总超时才 reject，占位账号会多挂 5 分钟） |
| API | `internal/api/jethub/loomy.go` | `POST /loomy/login`（占位账号 → 起流程 → 注册会话 → **开浏览器** → 返回页面 URL）；`/loomy/status` 复用 `pollLogin`（⚠️ 缺陷 19 前**只是文档里的意图**：代码漏了 `loginId` 分支，见 §3.6） |
| 公开页端点 | `internal/api/jethub/login_page.go` | `GET /jethub/login-page`（`qrImage` 指向下一条）、`GET …/qr-image`（**宿主代理微信图片**：uuid 不外泄、浏览器不必直连微信）、`GET …/poll`、`POST …/complete`（`send_sms`/`verify_sms`，契约 `{ok}`/`{ok:false,message}`/`{ok:true,done:true}`）。⚠️ 响应里**不得**出现 rcode/msgid/session/userid/accountId |
| 页面 | `web/static/free-hub-loomy-login.html` | 图片二维码 + 隐藏的绑手机表单 + 轮询中间态；失败就地提示、**允许重试**（不终止流程，字段与 `verify_sms` 返回的 phone 优先） |
| 面板 | `internal/jethub/manager.go` | loomy 的 `loginModes` 从 `["sms","qr"]` 改为 **`["url"]`** —— 否则前端仍先命中 `sms` 分支弹旧 modal（`web/static/jethub.js` 的分派是「先 sms 后 url」）。`/loomy/login/sms/*` 保留为休眠备用路径 |

**回归**：`internal/jethub/loomy_wechat_test.go`（12 个：URL 构造、uuid 两条正则与严格
字符集、图片魔数、**errcode→状态全表（含 405 无 code 的异常形态与网络降级）**、取不到 uuid
必须报错、非图片必须报错、绑手机全流程（凭据+昵称「Loomy 尾4」）、`bind=1` 走 skip 且昵称
优先微信昵称、**验证码输错可重试**、cancelled/expired 立即结算、5 分钟超时）+
`internal/api/jethub/login_page_test.go`（loomy 页面 URL、标签、仅 loomy 的端点必须拒绝
其他会话）+ `web/loomy-login.test.js`（8 项：页面只用公开端点且不含秘密、结构对齐插件、
Go 侧接线与顺序契约、协议判据存在的静态守卫、`loginModes` 守卫、manifest 登记）。

**⚠️ 未移植/已知边界**：① 插件的「二维码失效自动换码刷新」本端也没有（只提示重开）；
② 短信备用路径的 msgid 仍由调用方在请求体里回传（插件存宿主 Map；`/loomy/login/sms/*`
是无 UI 的备用面，前端 modal 已无 provider 使用它）；③ 微信链路**主流程已由用户真机验证
通过**（2026-10-01：扫码 → 授权 → 凭据落盘、账号卡带微信昵称，见 §3.6 的现场数据），
bind 四步里实际被走到的分支（`bind/skip` 或 `sendMsg`+`checkCode`）随之被覆盖 ——
现场数据无法区分二者（两条路都以同一句 `complete` 收尾），未被走到的那个分支仍只有
mock 单测。

### 3.6 面板登录弹窗的 status 轮询契约（真实缺陷 19 + 修复）

**用户实测报障**：「Loomy 现在弹窗正常，但是网页验证通过后，项目内的 Provider Login
Modal 窗长时间没有任何反应，没有成功添加账户」。

**现场数据（本机 `{configDir}/jethub/`）**：`accounts.json` 里已经躺着
`loomy-882245cc`，`nickname` 是**微信昵称**、`expiresAt` 是登录时刻 +14 天，且
`credentials.json` 与 `accounts.json` 同一秒被写入 —— 也就是说**整条微信链路
（扫码 → 授权页取 uuid → 图片二维码 → 长轮询 → bind/auth → bind/skip 或
bind/checkCode → 落盘）全部成功**，唯一没发生的是「面板被告知登录结束了」。

**根因（两处，一处服务端一处前端）**：

1. **服务端：`/loomy/status` 漏了 `loginId` 分支**（其余 9 个 provider 都有）。面板的
   弹窗只轮 `GET /jethub/{provider}/status?loginId=…`，并且**只认响应里的 `done`
   字段**；loomy 的 handler 恒回账号快照 `{"accounts":[…]}` ⇒ `st.done` 恒为
   `undefined` ⇒ 弹窗永远停在「等待授权中…」，账号列表也永不刷新（用户感知即
   「没有任何反应、没有成功添加账户」）。30s 宽限期后会话被回收，下一次轮询变 404，
   前端当时只是把错误文案写进状态行继续空转，第二道症状同样静默。
   ⚠️ 文档在缺陷 18 那轮已经写了「`/loomy/status` 复用 `pollLogin`」，但代码里没有 ——
   这正是**只有结构性守卫才拦得住**的那类漂移。
2. **前端：404（会话已回收）不会收尾**。会话没了就再也读不到结果，必须停轮询 +
   关弹窗 + 刷新列表 + 明确提示（`freeHubLoginGone`），而不是把 `unknown or settled
   loginId` 写进状态行后每 2s 空转到天荒地老。

**判据顺序即契约**（`web/static/jethub.js` 的 `__jethubLoginModal`）：先认
`done === true`（成功/失败两种收尾）、再认 `done === false`（进行中，继续轮询）、
**最后**才把 `error` 当「会话已消失」。`error` 字段在两种语义里长相相同 ——
已结算的失败是 `{done:true,success:false,error}`（必须带原因收尾），会话已回收是
`{error:"unknown or settled loginId"}` 且**没有** `done`；先判 `error` 会把一次
正常失败误报成「会话已结束」（本轮写测试时当场踩到）。

**回归**：

- `internal/api/jethub/status_login_test.go`（2 个）：
  `TestEveryProviderStatusHonorsLoginID` 是**结构性守卫** —— `chi.Walk` 枚举**每一条**
  `GET …/status` 路由（不手写 provider 表，新增 provider 自动纳入，少于 8 条即判定
  枚举本身坏掉），对每条发一个不存在的 `loginId`，响应必须落在 pollLogin 语义里
  （200 且带 `done`，或 404 且带 JSON `error`）；回账号快照的一律报红并点名
  「the panel's login modal will wait forever (defect 19)」。
  `TestLoomyStatusAcceptsLoginID` 直接回归 loomy：无 `loginId` 仍是账号快照、
  有 `loginId` 时未结算 → `done:false`（且**不得**夹带 `accounts`）、结算后 →
  `success:true`、回收后 → 404+error。已做反向验证（把 `loomyStatus` 改回快照版
  ⇒ 两条用例立刻报红）。
- `web/jethub.test.js`「③ login modal (URL flow)」：VM 里抓 `setInterval` 的回调，驱动
  四种响应 —— 进行中（保持打开）/ 成功（关弹窗 + `freeHubLoginOk` + 停表 + 刷新列表）/
  失败（`freeHubLoginFailed`）/ 会话已回收（关弹窗 + `freeHubLoginGone` + 停表）。

### 3.6.1 缺陷 20（2026-10-02）：SyncKeys 刷新窗口触发 registry sweep ⇒ combo/quickslot 模型引用被清

- **现象（用户实测）**：Combo 加入 FreeHub 模型，退出 app 重新进入后模型消失（「状态不会被保存」）。
- **根因**：`SyncKeys` 刷新桥接 provider 走 `DeleteProvider(id)` + `AddProvider(p)`，而 `DeleteProvider` 内联 `sweepStaleRefsLocked()`——删除窗口内该前缀在 registry 缺席，combo/quickslot 里所有 `{prefix}/{model}` 引用（含别名形态，如 `lom/GLM 5.3 Flash · x0.8`）被当成失效引用清掉；provider 随后重新注册也救不回来。启动时 `RestoreBridges` 对每个账号跑一遍 `SyncKeys` ⇒ **每次重启必触发**（config.yaml 里已持久化的 jethub provider 让 `GetProvider` 命中、走删除分支）。隔离实例复现：带凭据启动后 `combo.models == []`。
- **修复**：registry 新增 `UpsertProvider`（原地替换 Keys/Models + keystate 对账：幸存 key 保留冷却/锁状态、新 key 初始化、消失 key 清理，**不触发 sweep**——刷新语义上 provider 从未离开）；jethub `SyncKeys` 与 webhub `SyncProvider` 两处刷新路径全部改走它。回归：`internal/registry/providers_upsert_test.go` 3 个（原地替换不 sweep / 缺席即插入 / 幸存 key 运行时状态保留）+ `providers_test.go` 假 registry 补 `UpsertProvider`。真机复验：同配置重启后 combo 模型存活（`lom/GLM 5.3 Flash · x0.8` 保留）。
- **波及**：webhub 桥同构（`SyncProvider` 同为 delete+add）——同批修复；webhub 侧用户尚未建 combo 引用，未受实害。

### 3.7 codearts 自动续期（R1-2，ref cf5edab）

- **调度器**：`Manager.StartRefreshScheduler`（app 装配时以 `a.shutdownCtx` 启动）——启动首轮 + 每 30 分钟一轮（ref index.ts）；目前只对 **codearts** 生效（其它 provider 只有面板「续期」按钮）。
- **判据读凭据，不读 `refreshable`**：`codeartsRefreshable`（refresh_token + code_verifier + DPoP JWK 三件套）+ `codeartsShouldRefreshNow`（到期前 1 小时窗口，ref `REFRESH_LEAD_MS`；到期不可解析 ⇒ 立即刷新）。`refreshable` 只是**镜像**：每轮按凭据对账、值变化才写盘（被误标下一轮自愈）——拿它当调度判据会让被误标的账号**永不进入续期循环**（真实缺陷：重启也没用）。
- **per-credentialRef 串行 + 锁内重读**：`codeartsRefreshLocks`（sync.Map）让调度器与手动「续期」不会并发消费同一份 refresh_token（华为 STS 换新即作废旧的那一份 ⇒ 并发必然「1 成功 N invalid_grant」）；锁内重读后仍在有效期内 ⇒ 直接跳过（少烧一次 token）。
- **终态只留 `invalid_grant` / `ExpiredRefreshToken`**：`InvalidDPoPHeader` 移出（它只说明「这一次 DPoP proof 不合格」，与 refresh_token 能否使用无关）；判终态前先重读凭据——若 refresh_token 已被他处换新，视为「别人已经续成功」，不作废账号。真终态才写 `refreshable=false`（且只在值变化时写）。

### 3.8 apikey 登录模式与匿名通道（opencode，R1-7）

- **登录模式 `apikey`**（`ProviderMeta.LoginModes`）：前端 `jethubAddAccount` 命中后弹粘贴框（`__jethubApiKeyModal`），提交 `POST /api/jethub/opencode/login`（`{apiKey,nickname?}` 或 `{anonymous:true}`）；**没有 loginId/轮询**，因此 opencode **没有 `/status` 端点**（`status_login_test.go` 的枚举守卫自动跳过它）。
- **匿名通道 = 池里的一条普通账号**（凭据 `{"api_key":"public"}`，昵称「匿名通道」，`refreshable=false` 诚实标记）——排序/停用/删除全部复用既有机制；`AddOpencodeAccount` 幂等（重复添加返回 `reused:true`，同 key 不重复建条目）。
- **模型可见性**（`Product.ModelFilter` → `opencodeVisibleModels`）：没有 keyed 账号时只暴露 7 条免费模型（匿名通道送付费模型必然 401/403）；加任一 keyed 账号后恢复全表 14 条。**匿名 Key 殿后**：`SyncKeys` 给 `Product.AnonymousKey` 的 Key 置 `Priority=100`，fill-first 先试账号槽。
- ⚠️ **与 ref 的差异（有意）**：ref 在「首次启用」自动补一条匿名槽，本端改为**显式按钮**（TinyLab 没有 per-provider 的 enable 事件，自动写入用户账号池会在从未使用 opencode 的安装里制造噪音）；ref 的 per-account 代理与指纹代次轮换未移植（本端用 provider 级 Use Proxy；指纹固定 generation=0）。

### 3.9 登录浏览器与会话模式（+新建账号 先选后开，2026-10-05）

**动因（真实用途，不是洁癖）**：此前所有登录页都交给系统 shell（`fsutil.OpenInBrowser` → `rundll32 url.dll,FileProtocolHandler`），等于**默认浏览器的共享登录态**。本模块的主用途是**同一 provider 多账号**，而浏览器通常已登录账号 A ⇒ 新建出来的账号静默复用 A 的身份；账号池只按 `Account.ID` 去重（`manager.go` 的 `AddAccount`），**没有任何按 provider 身份的去重**，重复凭据不会被拦。

**两个正交维度**（弹窗里同时给选，记住上次选择为下次默认）：

| 轴 | 取值 | 行为 |
|---|---|---|
| 浏览器 | `default` | 系统默认浏览器（注册表 `UserChoice→ProgId→shell\open\command` 解析 exe） |
| | 已探测 id（`chrome`/`edge`/`brave`/`vivaldi`/`opera`/`chromium`/`firefox`） | 直接执行该 exe（`browserlaunch.Detect` 候选路径 + PATH 回退） |
| | `custom` + `browserPath` | 用户指定的任意 exe |
| 会话 | `shared`（默认） | 复用该浏览器已有登录态；**默认浏览器 + shared 仍走旧的 shell 路径**（零行为变化） |
| | `private` | 隐私窗口（`--incognito` / `--inprivate` / `--private` / `-private-window`） |
| | `isolated` | 每账号一个持久 `--user-data-dir={dir}/browser-profiles/<accountID>`（隔离**且**重启后仍在） |

**三问的评估结论（本机真机实测：Chrome 141 / Edge 154 / WebView2 Runtime 154，默认浏览器 Chrome）**

1. **可否在隐私模式下登录鉴权**：✅ 可行。鉴权链路与浏览器无关 —— 回环回调（`http://127.0.0.1:<port>`）、设备码轮询、本地扫码页三种形态都能在隐私窗口里完成（实测：Edge `--inprivate` 窗口成功加载本地 `127.0.0.1` 页面并回连本服务）。代价是**每次都要手输账号 + 2FA**（隐私窗口不读已保存的密码），且**扩展在隐私窗口被禁用**（企业 SSO / 设备信任类扩展会失效）；无痕会话随最后一个隐私窗口关闭而消失。
2. **可否指定非默认浏览器**：✅ 可行，且最省事。`exe <url>` 即可；那个浏览器自己的登录态决定是否需要手动登录。
3. **可否指定浏览器 + 它的隐私模式**：✅ 可行，唯一新增的是**按内核族给 flag**。
4. **Windows 没有「用默认浏览器打开隐私窗口」的接口**：shell/`ShellExecute` 都不支持带参数，所以隐私模式必须自己解析 exe 并拼参数。**flag 名不统一，写错会静默退化成普通窗口**（实测：Edge 154 不认识 `--incognito`，无报错、无退出码，直接开了一个普通窗口）。flag 能穿过「转发给已运行实例」（实测：Chrome 已开着时第二次 `--incognito` 仍落在 off-the-record 存储里），所以用户开着浏览器不影响。⚠️ Chrome 141 的隐私窗口**标题已不含 "Incognito"**，外部无法确认是否真进了隐私模式 ⇒ 未知内核一律**拒绝**，绝不假装成功。
5. **已评估并否决**：内嵌 WebView2 的 `IsInPrivateModeEnabled`（当前 pin 的 `jchv/go-webview2` 完全未暴露 ControllerOptions/InPrivate，需自写裸 COM；只在 webview 变体存在；且 **Google 拒绝内嵌 WebView 登录**（`disallowed_useragent`），会直接打死 gemini 及任何 Google SSO 渠道）。

**实现落点**

- `internal/browserlaunch/`（新包，无 jethub 概念）：`Detect()` 候选路径 + PATH 回退、`FamilyOf/PrivateArgs` 家族表、`DefaultBrowser()`（Windows 注册表；mac/Linux 无零依赖查询 ⇒ 返回空，由调用方明确拒绝而不是静默开普通窗口）、`BuildArgs/Open`（相对 `--user-data-dir` 一律 absolutize —— 相对路径会让 Chrome 静默失败，同 webhub 缺陷 21）。`prepare()` 按平台隐藏控制台窗口；**从不 Wait、从不杀浏览器**。
- `internal/jethub/login_open.go`：`OpenOptions{Browser,BrowserPath,Session,AccountID}`、`normalizeOpenOptions`（请求 → 偏好 → 旧默认）、`ValidateOpenOptions`（**不启动进程**的同步校验，复用 `BuildArgs` 做 flag 判定）、`ResolveOpenBrowser`、`OpenLoginURL`、`IsolatedProfileDir`（id 净化成单一路径段，杜绝 `..`）、偏好文件 `{dir}/login-open.json`（独立文件：备份导入不得重置本地偏好，`accounts.json` 的备份兼容形态也不受影响）、`DeleteAccount` 后**异步尽力**清理该账号的独立配置目录（浏览器在跑 ⇒ 删不掉是预期，绝不为此杀进程）。
- 管理器 opener 签名改为 `func(url string, opt OpenOptions)`；**flow 内部不再自行开页**，改为 API 层传入的 mode-bound 闭包（`StartClineLogin`/`StartBuddyLogin`/`StartLobsteraiLogin`/`StartTraeLogin` 复用既有 `openURL` 形参，`StartGeminiLogin`/`StartCodeArtsLoginWithBrowser` 新增选择参数，qoder/minimax/raccoon/loomy/zcode 仍在 handler 里直接 `OpenURLWithBrowser(url, opt)`）——同时修掉「管理器先开一次 + 回调再开一次」的潜在双开。
- API：`GET /api/jethub/login-browsers`（已装浏览器 + 系统默认 + 三种会话 + 记住的选择）、`POST /api/jethub/open-login-url`（**同步**开页并回报错误：用户点了「重新打开登录页」就该知道结果）。每个 login handler 建号**之前**做 `prepareLoginOpen`（校验 + 记住选择），失败 400 —— 否则用户看到的是「弹窗一直等待、浏览器什么都没开」。
- 前端：`jethubAddAccount` → **选择步**（`__jethubLoginModal`：浏览器轴 + 会话轴 + 自定义路径行。两个下拉都走**项目自定义组件** `renderCustomSelectHtml`（`app.js`；基础样式在 `style-download.css`，经 `style.css` `@import` 全局可用，`style.css` 另有 `.modal .custom-select-*` 覆盖）——原生 `<select>` 只作为组件内部的隐藏取值载体，**不得**直接渲染原生 `<select>`（真实返工：首版用了 `<select class="input">`，弹窗里是被浏览器原生样式渲染的）。内核未知时隐私项禁用并给出提示；此步**还没有占位账号**，取消即关闭）→ `jethubLoginConfirm`（带 `{browser,browserPath,session}` POST `/jethub/{provider}/login`）→ **等待步**（`__jethubLoginWaitingModal`：原三态轮询 + 取消删占位 + 「重新打开登录页」走服务端 `open-login-url`）。⚠️ 等待步不能只留 `<a target="_blank">`：那是 UI 宿主（console = 默认浏览器 / webview = 被 `openExternalURL` 拦到默认浏览器）决定用哪个浏览器，选定模式会失效；链接保留为手动兜底。

**语义边界与已知限制**

- `private` 的语义就是「未登录」：便利性（浏览器已登录 ⇒ 一点即授权）必然消失，换来的是账号隔离。**多账号首选 `isolated`**：既隔离又持久，且不受无痕策略影响。
- 企业策略可以把无痕模式禁掉（`IncognitoModeAvailability`/`InPrivateModeAvailability`），此时浏览器会**静默**按普通窗口打开 —— 本端无法检测，界面上无法承诺隐私性（已在文档与提示文案中如实说明；本机策略位为空，无痕可用）。
- 未知内核的 fork（如各类国产 Chromium 换壳）**拒绝**隐私模式（无法确认 flag），但 `shared`/`isolated` 仍可用（不依赖 flag 名）。
- macOS 上 `open -a … --args` 对**已运行**实例不传参数：必须直接执行 `.app/Contents/MacOS/<bin>`（`browserlaunch` 的候选路径即为此形态）；本机无法实测，属待真机验证项。
- `isolated` 会在 `{dir}/browser-profiles/<accountID>` 落一份完整浏览器配置（Chrome 一份配置约百 MB 级）：只有主动选择该模式的账号才会产生，账号删除时尽力回收。

### 3.10 per-key 出口代理（opencode per-account proxy，R4-0）

**为什么需要 key 级出口**：有些上游按**出口 IP** 限额（opencode 的匿名通道即如此），同一个 provider 的多个账号要各自拿到独立额度，就只能各自走一条出口 —— **provider 级的 `Use Proxy` 开关做不到这件事**（它让整个 provider 共用一条出口）。

- **`config.Key.Proxy`**（`http://host:port`；空 = 跟随 provider 级开关，再退到直连）。⚠️ **安全边界：默认为空 ⇒ 默认路径与加这个能力之前逐字节相同**（只有显式设过代理的 key 才会走独立 transport）—— 这一点由 `internal/proxy/perkey_proxy_test.go` 的两条断言分别锁定（「设了的会绕」与「**没设的不绕**」）。
- **`proxy.Handler.keyProxyClientsFor(raw)`**：按**代理串**缓存一对 client（`plain` 带当前超时 / `stream` 无超时）。每个代理串一份**独立 Transport** —— 复用直连 transport 会把两种出口的连接混进同一个池，等于没换出口。非法值**解析失败即忽略并回落直连**（用户手输的值不该让 key 变成不可用），且不缓存（下次仍会重试解析）。
- **优先级**：per-key 代理 > provider 级 `UseProxy` > 直连。账号自己的出口是更具体的意图；两者同时存在时以账号为准。
- **接线**：`bridge.SyncKeys` 把 `accountEntry.OpencodeProxy` 写进 `config.Key.Proxy`；`Manager.SetAccountProxy`（空串=清除；非法值**当场报错**，因为静默不生效比报错更糟）负责持久化，并清空 client 缓存让下一次出站立刻按新出口走；API 改完必须 `SyncKeys`，否则「面板改了、流量还走旧出口」。
- **探针同源**：`ProbeAccountModel` 用 `httpClientForAccount(provider, accountID)` —— 从别的出口探测会得到与真实流量不同的结论（例如匿名通道按出口 IP 计额度，用错出口会误判「仍受限 / 已恢复」）。
- **与指纹轮换的分工**：**指纹分离不增加配额，只有换出口才会**。两个按钮并列，文案不得混为一谈。

## 4. 调用桥接（核心机制，零特殊调用路径）

1. 用户为 provider 设**调用前缀**（全局唯一，`[a-z0-9-]{1,32}`）→ `Bridge.SetPrefix` 校验冲突（409）+ 持久化。
2. `Bridge.SyncKeys` 在 registry **动态注册** `config.Provider`：`ID=jethub-{provider}`、`Prefix=用户前缀`、`BaseURL=product 展示/兜底基址`、`Keys=启用账号×1`（`Key.Key`=access token，凭据刷新时同步）、`Models=静态模型表`（黑名单过滤）、`APIType="jethub"`。⚠️ **真实出站 URL 不是 BaseURL 拼出来的**：由 `Product.InferURL` 显式声明、`Customize` 覆盖（见 §6.2 —— BaseURL 只是 registry 展示与 urlutil 兜底）。
3. 调用侧无感知：`model={前缀}/{modelID}` 走 `handleProxy` → `GetProviderByPrefix` → `forwardWithRetry` 标准链路；**多账号轮询直接复用 rotation 三策略/冷却/配额锁**，不另造轮子。
4. **请求增强 hook（依赖倒置）**——三个窄接口，全部可选、结构性注入：
   - `RequestAugmenter.Augment(r, body, providerID, keyID, upstreamModel)`：改写出站头与 body（十协议族中 9 个用这一层）。⚠️ F-05（2026-10-05）起 `r` 的头表是代理新建的**空白基底**（仅回播 loopback 标记），augmenter 的写入就是出站头集合——**不再需要也不应该手工全删客户端头**（客户端头结构性进不了桥接上游；各 augmenter 的 `Header.Del` 全删循环已移除）。
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

## 6. 14 provider 矩阵（端点/协议族/签名/积分）

| provider | 协议族/推理端点（真实出站 URL，§6.2） | 登录 | 出站签名/头族要点 | 续期 | 积分 |
|---|---|---|---|---|---|
| codearts | OpenAI 兼容 `snap-access…/api/v2/chat/completions` | 两步 OAuth（随机端口回调 + PKCE/DPoP） | `SDK-HMAC-SHA256`（maas_type 参与签名；**签的是上游 URL**，§6.2）+ benefit 兜底 | refresh_token | 签到五步流 + 余额 |
| buddy / workbuddy | OpenAI 兼容 `{endpoint}/v2/chat/completions`（CN `copilot.tencent.com` / 国际 `www.workbuddy.ai`） | 轮询登录流（11217 继续/12151 账号） | Bearer + X-Domain/X-Product/X-Agent-* 头族 + 按模型族 UA | refresh（终态判定） | 签到（10001 幂等）+ 双层嵌套余额 |
| lobsterai | OpenAI 兼容 `{apiBase}/api/proxy/v1/chat/completions` | 本地回调两步 | Bearer 四头 + Client-Capabilities（kimi-k3 准入前提） | 匿名 POST + keyfrom | 三步签到 + profile-summary 余额 |
| trae | **SOLO 私有协议** `{agentHost}/api/agent/v3/llm_utils_chat`（⚠️ 响应仍是 SOLO SSE，转换未实现，§6.2） | 回调双流程（token 直传 + PKCE 并行） | `Cloud-IDE-JWT` + X-* 头族 + OpenAI→SOLO body 转换 | ExchangeToken 轮换 | 签到（9074 设备级限流→代次派生绕开） |
| cline | OpenAI 兼容 `{apiBase}/api/v1/chat/completions` | WorkOS 设备码 | `Bearer workos:<jwt>` 前缀必须保留 | 驼峰 `{refreshToken,grantType}` | 余额（`usr-` id） |
| raccoon | OpenAI 兼容 `{base}/api/web/llm/v2/chat/completions` + extra_body.thinking | 微信 QR + 短信 | AES-128-CFB 手机加密 + Bearer | 200003 终态 | 登录奖励 + 新手礼包 |
| loomy | OpenAI 兼容 `{apiBase}/chat/completions` | **微信扫码**（本地弹窗页 + 长轮询；首次登录绑手机号，§3.5）；短信为**无 UI 备用** | CAccount HMAC-SHA1 双头 | —（无） | 双积分池 + 新手任务 |
| minimax | **Anthropic Messages** `POST /mavis/api/v1/llm/v1/messages`（§6.1：进站 OpenAI 时双向转换；进站 `/v1/messages` 时原生透传） | 设备码（scope 硬校验 agent.default） | `mmoat_` 非 JWT + Authorization Bearer（无 anthropic-version、无 x-api-key） | refresh 回退上一个 | 签到（timezone_id 必填）+ Σ remaining_amount |
| qoder / qodercn | **加密端点**（WASM 签名体，§5；同协议族双产品） | PKCE 设备码轮询（404=未就绪继续） | COSY 签名头原样透传 + `/sash/` 四头 | refresh_token + machine_id | 余额三包 + 每日领取（replayed 幂等） |
| opencode | OpenAI 兼容 `https://opencode.ai/zen/v1/chat/completions`（§6.5） | **API Key 粘贴**（唯一非浏览器登录，§3.8）；匿名通道 = 字面量 `public` | Bearer `<api_key>` + `x-opencode-project/session/request/client` 指纹头 + UA；**免费通道形状门禁**（stream + `bash`/`read` 工具，augmenter 注入） | —（粘贴的 key 无续期；匿名槽 refreshable=false） | —（无积分面；额度错误按响应体类型名分类 → per-model 锁/换号，§6.5） |
| zcode | **Anthropic Messages** `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（§6.7） | 官方 **CLI 设备授权流**（`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`，纯 HTTP）—— ⚠️ **R4-1 起这是唯一来源**（原先的「导入官方客户端凭据」已删除，理由见 §6.7） | 官方客户端头族（`X-Device-Mid` 硬需求 + `X-ZCode-App-Version`/`X-Release-Channel`/`X-Client-*`/`anthropic-version`）+ **请求体官方身份块 + 首轮日期块**（3012 准入） | —（**不可续期**：JWT 无 exp；401/1002 → 提示重新登录） | 余额 = **token 桶**（`billing/balance`，逐模型 `show_name`）；每日领取（`billing/claim`，**必带 captcha**，§6.7） |
| gemini | **Cloud Code 双层信封**（非 OpenAI 非 Anthropic）`POST {daily}/v1internal:streamGenerateContent?alt=sse`（§6.8；配额/档位走 sandbox） | **Google OAuth** authorization_code（本地 loopback 回调 + id_token 解身份；client_secret 必带，§6.8） | 身份五头逐字（`antigravity/4.3.0 (cmdc-pak)` 族）+ 信封逐层**字母序** + `requestId=agent/<ms>/<8hex>`；流式不带 `Accept` | refresh_token（Google 偶尔轮换须回写；per-credential 串行） | **配额窗口**（`gemini-5h`/`gemini-weekly` 百分比，非积分；§6.8） |

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

- **tool 配对不变量（R1-5，ref c74e0c2）**：孤儿 `tool_use`/`tool_result` 一律剔除；assistant(tool_use) 与它的 tool_result **成对提交**（结果紧跟宿主 assistant 之后的 user 消息，同批合并进同一条，不跨 assistant 边界累积）。Anthropic 三种 400/2013 形态（连续 user、结果错位、空 assistant 丢锚点）由此消除。⚠️ ref 同提交的「一等 tool 消息」形状归一化属 DSH 宿主专属（我们的进站是 OpenAI/Anthropic 线协议），**不移植**。

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
四个常量/函数**零调用**（是「打算做但没接」的痕迹）。

**展示名契约（本端，2026-10-01 规范化）**：`GET /jethub/providers/{p}/models` 出
`{id, name, rate, disabled}`，面板渲染**一条** `name · rate` 再渲染裸 `id` —— 与插件
`ModelToggle` 的 `<strong>{model.name}</strong><code>{model.id}</code>` 同形同序
（插件把倍率拼进 `name`，本端拆成两个字段但合成一条串显示；无倍率时**不补** ` · `）。
`name`/`rate` 的解析优先级：`Alias` 的 `· 尾巴`（是倍率文本才算）→ `Note` 的受支持段
（`xN` / `FREE (xN)` / `promo HH:MM-HH:MM xN`）。**同 provider 内展示名必须互不相同**
（这是 ref `variantLabelFor` 存在的唯一理由，已由
`TestModelDisplayNamesMatchReference` 不变量锁死）。

**模型 id 复制 = `{prefix}/{id}`**（2026-10-01 修正，用户实测要求）：与 Settings 的
provider detail 点模型 id 得到的结果同形（`web/static/providers-models.js:38/100` 复制
`prefix/alias||id`），可直接粘进外部客户端调用；该 id 经 `ResolveModelAlias` 解析回
真实目录 key，故 `{prefix}/{id}` 与 `{prefix}/{alias}` 都可用。未设前缀（未桥接）时
退回裸 id —— 那种情况下本来也无从调用。

**逐 provider 静态展示名对账（2026-10-01，逐条比对 ref 兜底表与 displayName 函数）**：

| provider | 插件展示名的来源 | 本轮处理 |
|---|---|---|
| qoder / qodercn | **纯静态表**（`qoder-product.ts`，插件自身也不拉远端） | 上一轮已修倍率；本轮复查 17+14 条**逐条一致**（含错峰形态） |
| raccoon | 静态表 `name` 已含倍率（`raccoon-product.ts:218-263`） | 6/6 一致 |
| loomy | 静态表 `name` 已含 ` · x{n}`（`loomy-product.ts:104-113`） | 8/8 一致 |
| minimax | 兜底表 `name`（无倍率概念） | 4/4 一致 |
| cline | `isFree ⇒ name · 免费`（`cline-models.ts:107-109`，免费条目全 free；2026-10-03 起免费清单 **5→4**——`cline-free/gemini-3.8-flash` 已被上游下线，ref 51d6093） | **已修**：此前 Note 里只写了裸 `free`（不是受支持段）⇒ 面板少了 ` · 免费` |
| trae | 兜底表 `name`，且**先过滤 `isHidden`**（`trae-adapter.ts:765-769`） | **已修**：剔除 4 条隐藏模型（`browser_use_subagent`/`explore_sub_agent_v13`/`explore_sub_agent_v2`/`summary`，32→28 条 —— 此前面板比插件多 4 条） |
| buddy / workbuddy | 兜底表 `name`（`product.ts:180-266`/`295-367`）+ 同名撞车变体标记 | **已修**：Alias 补全（此前名字只塞进 Note、Alias 为空 ⇒ 面板显示裸 id）+ 三处变体标记按 ref 算法（公共 id 前缀）固化为 `Hy3 · X`、`Hy4 preview · F`、`Deepseek-V4.1-Flash · SG`。⚠️ **变体前的 ` · ` 不可省**：`displayNameFor` 把整条 suffix 用 ` · ` 接到 name 上，兜底路径后缀就是变体本身 |
| lobsterai | 兜底表 `name` **逐条等于 id**（`lobsterai-product.ts:184-202`） | 一致（裸 id，**不是**缺陷）；比兜底表多 3 条远端已确认的模型（保留） |
| codearts | 兜底 `name` 恒为裸 id（`llm-adapter.ts:794`） | 一致（裸 id，无计费字段） |

| provider | 与插件的**剩余**差距 | 处理 |
|---|---|---|
| qoder / qodercn | 3 条促销倍率曾错（`qmodel_38max` 被显示成「免费」、`qmodel_latest`/`qmodel` 拿采集时刻折后价当唯一价） | **已修**：†（本轮复查无残留） |
| trae | 远端独有模型（`solo_agent` 约 66 条）与**倍率**不在表里 | 展示名/隐藏项**已修**；远端目录**未实现** |
| lobsterai | 远端 26 条与 `costMultiplier` 倍率 | 三条**已补**；其余倍率需远端目录（**未实现**） |
| buddy / workbuddy | 远端 `credits`/`discountedCredits` 倍率与远端独有模型 | 展示名**已修**；远端目录**未实现** |
| cline | 远端约 478 条（我们只有静态表） | 静态表已并入 models.dev 快照（4 免费 + 18 条 `cline-pass`；R1-6 ref caf675e 并入 5 免费，R3-2 ref 51d6093 删已下线的 gemini-3.8-flash）；远端目录**未实现** |
| codearts | 远端 `model_name`（我们只有 9 条裸 id） | 远端目录**未实现** |

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
  `TestModelDisplayParts`（形态表）+ `TestModelDisplayPartsPromotionWindow`
  （窗口内/外/边界 × 两个时区表达）+ `TestQoderModelRatesMatchPlugin`（qoder 与
  qodercn 逐条对账，期望值取自 ref `qoder-product.ts`）+
  **`TestModelDisplayNamesMatchReference`**（2026-10-01 新增：逐 provider 代表条目
  核对 `名称 · 倍率`，并锁四条不变量 —— 展示名非空 / **同 provider 内展示名互不相同**
  （ref `variantLabelFor` 的存在理由）/ 兜底路径**不编造倍率** / 自带倍率的 provider
  **不得缺倍率**；trae 的 4 条隐藏模型必须缺席且恰好 28 条。已反向验证：把
  `Hy4 preview · F` 改回 `Hy4 preview` ⇒ 两条断言立刻报红）+ `TestTraeModelsCarryDisplayNames`。

**未实现的正确修法（下一步）**：**远端目录拉取**（含解析与失败回退）。远端 ID 集合与
倍率都会随服务端变化（ref 明确警告不要把某一刻的远端条目写死），故「把静态表抄长」
追不上。逐 provider 端点（本轮逐条核对 ref 的结果）：

| provider | 远端目录 | 关键字段/前置条件 |
|---|---|---|
| trae | `POST {agentHost}/api/ide/v1/batch_get_detail_param` | 22 个通道 + `traeSOLOHeaders`，解析 `function_configs[].config_info_list[]`；倍率在 `display_contact_config → consumption_rate.data.rate`（**JSON 字符串，需二次 parse**）；远端约 66 条 |
| lobsterai | `GET {apiBase}/api/models/available` | **必须带** `X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`，否则少 `kimi-k3`；倍率 `data[].costMultiplier`（裸数字）；远端约 26 条 |
| buddy / workbuddy | `GET {endpoint}/v3/config`（企业端点 `/console/enterprises/{scope}/models` 亦下发） | 倍率 `data.models[].credits`（**字符串 `"x0.29"`**）+ `modelPromotions[].discount.discountedCredits`（**`"0.50x"`，x 在后**）；远端 22–30 条 |
| codearts | `gateway/config` + `/v1/model/builtin` 合并 | 名字取 `model_name`（**无计费字段** —— 永远没有倍率） |
| cline | `GET /api/v1/models` + `/api/v1/ai/cline/recommended-models` | 免费集来自 `recommended-models` 的 `free` 数组；远端约 478 条 |
| minimax | `GET {apiHost}/mavis/api/v1/models?region=cn&buildEnv=prod` | 远端快照与我们 4 条一致（无缺口） |
| raccoon | `GET {apiBase}/api/web/llm/v2/model_catalog` | 远端快照与我们 6 条一致；倍率已在静态表 |
| loomy | `GET {apiBase}/api/v1/models` | 远端快照与我们 8 条一致；倍率已在静态表 |
| qoder / qodercn | **不需要** | 插件自身也不拉远端（纯静态表 + WASM 签名端点） |

⚠️ 四家「倍率只有远端才有」= buddy/workbuddy、lobsterai、trae、codearts；cline 的
` · 免费`、raccoon/loomy 的倍率都在静态表里，离线也显示。

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
  - **`InferHub.4004.200 benefit not found`（R1-1，ref 3bf2be7）**：积分制账号（无
    benefit 包）带 `maas_type: benefit` 必被拒，而**同一模型不带该头可正常出流** ⇒
    去掉该头**同 Key 重试一次**（`upstreamerr.SameKeyRetryError` + 回环标记
    `RetryDropHeaderMarker`：重试循环写标记 → augmenter 跳过该头 → 拦截器据标记判定
    「已经试过」，第二次仍是该码才按真实失败处理）。**其它**错误 ⇒ **让本次尝试显式失败**
    并带上上游 `error_code` + `error_msg`，由代理按分类换号/重试/把真实原因报给客户端
    —— 而不是返回一个空回复。
- **400 的排队文案兜底**（ref `isQueueError` 的非 `TM.00001041` 分支）：`peak usage` /
  `try again after` / `peak hours` / `high demand` / `too many requests` 同样按排队处理。
- **输出上限收敛（R1-4，ref 916c647/da0a2ad）**：`deepseek-v4-flash|pro` 与 `GLM-5.2`
  实测拒绝 128000 ⇒ augmenter 把 `max_tokens`/`max_completion_tokens` 收敛到 65536
  （`min` 语义；其它模型与未超限值**字节级不变**）。
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
- **额度用尽与 `429` 边界（R3-1，ref 784210d/ae0c9b0，2026-10-04 同步）**：两层。
  ① `InferHub.4291.200`（`insufficient quota`，benefit 免费额度按 **UTC+8 自然日**
  结算）是**确定性失败**，绝不可当排队重试——旧正则的裸 `429` 子串命中 `4291` 前缀，
  会把它送进 10s×180 次静默重试、界面零输出（上游真实报障）。现 `429` 锚定为独立数字
  `(^|[^0-9])429([^0-9]|$)`（`…81114.429` 结尾与 `429 ` 带空格仍命中，`4291`/`1429`
  不命中），且额度判据 `isCodeArtsSSEQuotaExhausted`（code 子串 `4291`，刻意非全等，
  + 文案兜底 `insufficient[\s_-]+quota`）在**每个调用点先于**排队判据。命中 ⇒
  `upstreamerr.BillingLockError{Until: NextUtc8DayStartMs}`：proxy 重试链锁 key+model
  至 UTC+8 当日 24:00 并换 key（与 qoder `110`/opencode 额度同款），错误文案含模型与
  预计重置时刻。SSE（HTTP 200）与 4xx 两条通道都接（上游可能改用 4xx 形态下发）。
  ② 400 通道同样先判额度再判排队（`insufficient quota` 文案被限流判据先接走 = 把
  确定性失败当可自愈）。
- 回归：`internal/jethub/codearts_response_test.go`（12 个，其中 4 个直接用上表的
  真实响应体；R3-1 新增 4 个，含**反向验证**——`429` 改回裸子串 `TestCodearts429BoundaryAnchoring`
  必须变红）。

### 6.5 OpenCode Zen 协议要点（R1-7，ref 分支 `feat/opencode-provider` @ 7dd3422）

- **形状即门禁**：匿名通道（`Bearer public`）要求 body 带 `stream:true` 且 `tools` 含 `bash`/`read`（描述固定「Reserved for the host runtime; do not call it.」）——augmenter 对**所有**通道注入（认证通道多注入无害，官方 CLI 本就带全套工具）；`tool_choice:"none"` **只在原本一个工具都没有时**补（覆盖真实工具的 tool_choice 会让模型无法调用工具）。
- **指纹头**：`x-opencode-project`（40hex = sha1("git-remote:opencode/"+sha256(identity+generation))）、`x-opencode-session`（**`ses_` + 12 位小写 hex + 14 位 base62** —— 尾段 26 写成随机段会让匿名通道一律 403 FreeTierError）、`x-opencode-request`（`req_`+32hex，每请求随机）、`x-opencode-client: cli`、UA `opencode/1.18.22`。出站头集**整体替换**客户端头（客户端自带的 Authorization 不得泄漏）。
- **错误分类以响应体类型名为准，状态码只作辅助**（额度错误常带 401/403）：`FreeUsageLimitError`/`GoUsageLimitError`/402 `Insufficient account funds` ⇒ `upstreamerr.BillingLockError`（锁 key+model 后换号；无 `retry-after` 时按 24h，有则用服务端值、封顶 30min、**0 合法**）；`FreeTierError` ⇒ 显式报错（形状门禁，换 key/换出口无效）；其余交回代理按状态码分类（429 走既有 Retry-After 路径）。
- **上游只有流式**（stream:true 是门禁的一半）：非流式客户端由拦截器把 SSE 聚合为 `chat.completion`（content/reasoning_content/tool_calls 拼接/usage/finish_reason；清 Content-Length）。流式客户端字节级透传。
- ⚠️ **R4-0 已补齐**：per-account 出口代理与指纹代次轮换**都已实现**（此前本条记为「未移植」）—— 见 §3.10 与 §3 的「opencode 的两种账号分离手段」（代理 → `config.Key.Proxy` → per-key transport；代次由账号条目持权威值）。
- ⚠️ **仍未移植**：ref 的远端目录拉取（5 分钟 TTL + 按实测可达性过滤）。本端模型表 = ref 兜底表 14 条（`ling-3.0-flash-fin-free` 两条通道都不可达，ref 已移除）。

### 6.6 Qoder 每日活动刷新窗口（R1-3，ref 1b65a5c B1）

- 活动每日 **10:00（UTC+8）** 刷新（服务端原文）。**刷新前**看到的 `CLAIMED` 属于**昨天**那一轮 ⇒ `ClaimQoderDailyCheckin` 返回 `inactive` + 「今天的每日活动尚未刷新…」提示（`CoversToday=false`），而不是「今天已领取」；刷新前领到的是**昨日补领** ⇒ 如实报 `claimed` 但标 `CoversToday=false`。
- 判据用**算术平移 UTC+8**（复用 `QoderBillingUTCOffsetMS`），不取本机时区（出差/改时区会一天判两次或漏判）。
- 前端「领取积分」toast 优先显示 `outcome.message`（服务端文案是判据所在：「未刷新」与「已领取」不能混）。

### 6.7 ZCode（智谱 z.ai 免费额度通道）协议要点（R2，ref `src/zcode*.ts` @ e06283c）

- **3012 准入是请求体内容检查，不是头检查**：`system` 必须是**块数组**且前两块为官方身份块
  （`cliPrefix` 42 字符 + stable 2856 UTF-16 码元；文本逐字内置在 `zcode_identity_text.go`，
  以字符数 + sha256 双锁，见 `zcode_identity_test.go`），首轮 user 消息的 content 数组最前面
  必须插 `<system-reminder>` 日期块（本地时区 ISO 日期）。缺任一项 ⇒ 上游回
  `{code:3012,"request has been blocked due to unusual activity."}`，且**有账号冷却惩罚**
  （30 分钟 → 24h 内第 3 次起 24h → 5 次停用）。故 3012 走代理的 **pass-through** 通道
  （拦截器把状态归一化为 400）：不重试、不冷却 key、不切号 —— 否则同一个请求体会把整池账号的
  惩罚次数一起推高。
- **captcha 只与领取有关**：3.14.4 起推理不再校验（ref 实测 6/6、8/8 不带验证头 200），
  本端推理侧**不产出 captcha**（撞 3007 时显式报错并给出人话提示）。`billing/claim` **始终
  强制索要** ⇒ 本端用**本地载体页**：`/api/jethub/zcode/carrier`（公开路由，一次性 128 位
  token、页面不含任何凭据）在用户浏览器里跑阿里云 SDK 的**无感验证**，param 回传
  `/carrier/contribute`；param 门槛 ≥200 字符 / base64 JSON / `certifyId` 非空 /
  `securityToken` ≥50（不满足必得 3007，宁可不发）。每个 plan 现产一个新 param（一次性）。
- **错误分类全按正文业务码**（只看状态码会把语义混掉）：`3009` 并发限流 → 同号退避 1.5s×n
  （预算 2 次，**不切号、不标记**；用尽后原样透传）；`1005`/`1113` 额度用尽 →
  `BillingLockError` 锁 账号×模型 至 UTC+8 次日 24:00 并切号；`3007`/`3012` → 显式报错
  （pass-through，见上）；`1002`/401 → 提示重新登录（401 交回代理按既有规则冷却+切号）。
- **空流 = 无权益**：上游对「该账号在该模型上无权益」的形态是 **HTTP 200 + 空流**
  （实测 150–200ms 返回；链路卡住的空流是超时级耗时）。拦截器按「入口 → EOF 的墙钟」区分：
  快空 ⇒ 标记 账号×模型 并切号；慢空 ⇒ 可重试错误；只有 ping 帧的流同样算空。
- **凭据静态**：JWT 无 `exp`、无续期端点 ⇒ `refreshable=false`；「刷新」只做**逐账号对账**
  （读自己的 ref、写自己的 ref）—— ref 踩过「A 的凭据被写进 B 的 ref」把整池串掉的真实缺陷
  （症状是面板显示 0 额度而官方客户端正常），本端在 `ZcodeRefreshAccount` 显式复刻该纪律。
- ⚠️ **不读本机官方客户端的数据**（R4-1，2026-10-05，用户决定，对齐上游 `2e8bb86`）：
  原先还有一条「装了官方客户端并登录过 ⇒ 解密其凭据文件零操作可用」的旁路（`enc:v1:` 三段
  base64url / AES-256-GCM / 密钥 = `sha256(ZCODE_CREDENTIAL_SECRET)` 或
  `sha256("zcode-credential-fallback:" + node平台 + ":" + homedir + ":" + 用户名)` / `device_mid`
  取自 `telemetry-state.json` / 官方安装目录的版本清单探测），**已整体删除**。凭据只有一条来源：
  本端自己的 CLI 设备授权流。三条理由（与上游一致）：① **安全** —— 那个派生密钥算法公开可复现，
  等价于「任何本地进程都能解密用户的 ZCode 登录态」；② **正确性** —— 它在 zai 渠道下双重失效
  （两个渠道的 `user_info` **结构**不同，导入结果 `user_id` 恒缺、标签退化成「设备xxxxxxxx」）；
  ③ **一致性** —— 本端本就有完整可用的 OAuth 流程。守卫：`zcode_local_read_test.go`
  **扫源码字面量**（断言某个函数不存在对新写的读取函数无效）。
  ⚠️ 用户可见影响：「零操作可用」没有了，需在面板点一次「登录」；**存量凭据不受影响**。
- **历史实现细节（存档，仅供排查老备份/老日志）**：上面那条旁路的两处 Node↔Go 映射差异曾各踩过一次
  —— Node 的 platform 是 **`win32`**（Go 的 `windows` 会算出不同密钥）、Node 的 username 是
  **SAM 名**（Go 的 `user.Current().Username` 带域前缀 `HOST\user`，带前缀 ⇒ GCM 认证失败）。
  该代码已删除，此处保留是因为**老备份里的 `source: "ide"` 凭据**仍可能带着由它写入的字段。
- **模型目录**：`data.builtinModels` 有**两种实测形状**（ref 记录为「键为序号的对象」，
  2026-10-02 真机抓到的是**数组**）⇒ 两种都接受（只认一种会得到「0 个模型」的假阴性）。
  静态兜底表只列 `GLM-5.3-Flash` / `GLM-5.3`（`GLM-5-Turbo`/`GLM-5.2` 在 Start Plan 下实测
  空响应）；档位 `low/high/max` 只经 `output_config.effort` 下发（**不是** `reasoning_effort`），
  且只发模型声明过的档位；tools 的 prompt-cache 断点只打在**最后一个**工具上。
- **已真机验证（2026-10-02）**：`/oauth/cli/init` 返回真实 `bigmodel.cn`
  授权 URL + 2s 轮询间隔（首轮 poll = pending）；凭据文件解密成功（jwt 231 字符）；
  `billing/balance` 200；`client/configs` 的目录两条与 ref 数值逐项一致（1,000,000 / 128,000、
  vision 仅 Flash、levels low/high/max、default max）；推理请求 **200**（无 3012/3001 —— 身份块
  与头族通过上游检查），该账号无 plan ⇒ 空流被正确判为「无权益」并标记切号。
- ⚠️ **未实现**：推理侧 captcha 产出（撞 3007 只报错）；ref 的 `serializeUpstream` +
  `modelGapMs` 并发门（本端靠 3009 退避重试兜底，不做跨请求串行）；远端目录的进程内缓存与
  30s 冷却门（目录拉取只在被调用时发生）。

### 6.8 Gemini Code Assist（Google Cloud Code Assist 免费线）协议要点（R3-3，ref `src/gemini*.ts` @ ff5e37d）

**文件**：`internal/jethub/gemini.go`（常量/凭据/字母序/模型表/schema 清洗/签名键）、
`gemini_oauth.go`（OAuth 流 + 令牌端点）、`gemini_convert.go`（请求信封 + 响应桥 + 续期）、
`gemini_credits.go`（配额窗口）；API `internal/api/jethub/gemini.go`。

- **端点与身份**：推理 `POST {daily}/v1internal:streamGenerateContent?alt=sse`（InferURL 显式
  声明——路径含方法名与查询串）；配额与档位走 **sandbox** 端点（ref `baseFor` 的路由，不
  "顺手统一"）。身份五头逐字写死（`User-Agent: antigravity/4.3.0 (cmdc-pak)` /
  `x-client-name: antigravity` / `x-client-version: 4.3.0` / `x-machine-id: cmdc-pak` /
  `x-vscode-sessionid: proxy`），**不带** `x-goog-api-key`/`x-goog-api-client`；流式请求
  **刻意不带 `Accept`**（抓包一致）。伪装 UA 只用于 Cloud Code 端点；令牌端点是标准 Google
  OAuth，不设伪装。
- **双层信封**：`{model, project, request:{contents, generationConfig, sessionId, …},
  requestId, userAgent}`，**逐层字母序序列化**（`geminiMarshalAlphabetical`；
  `requestId` 形如 `agent/<ms>/<8hex>` 每请求随机；`sessionId` 恒预置常量
  `3124275334370613369`）。`project` 恒 `aicode-consumers`（凭据的
  `cloudaicompanionProject` 优先）。
- **模型与档位**：静态表只 1 条 `gemini-3.8-flash`（lite 恒 404 不暴露）；档位
  `low/medium/high/tiered`（默认 medium）经**带档位的模型名**选择（`gemini-3.8-flash-<tier>`
  即上游准入钥匙——裸名 404）；未知 id 直接拒绝（上游对假名 200 静默跑 3.8 的实测教训）。
  `includeThoughts` **恒 true**（「关思考」是假关）；tiered 不发 `thinkingBudget`；
  预算 low=1000 / medium=4000 / high=10000（实测是自由旋钮，名字只是标签）。
- **消息映射**：role 只有 `user`/`model`；system → `systemInstruction`；历史 reasoning 不回传；
  `functionResponse` 以 **name** 配对（先扫全消息建 id→name 表；空 name 整块丢弃）；
  图片仅接受 `data:` URL（进站 http URL 显式报错，防 SSRF 的既有口径）；工具 schema 走
  白名单清洗（白名单外的键上游**硬 400**；type 数组收敛 + nullable；enum 含非字符串整删）。
- **thoughtSignature**：functionCall 上的签名按「工具名 + 规范化参数」进程内缓存并回填
  （键 = `sha256("tool:"+name + NUL + args[:512])` 前 16 hex，与 ref 逐字一致）。⚠️ **与 ref
  的差异**：不落盘（ref 落盘是因 DSH 每请求重建适配器；本端 Manager 常驻）。
- **登录**：Google OAuth authorization_code（本地 loopback 回调，动态端口 + RFC 8252）。三条
  硬约束：① 先监听再拼 URL（端口回退会 redirect_uri_mismatch）② 回调 state 必须校验
  ③ exchange/refresh 必须带 `client_secret`（漏了报 `client_secret is missing`，症状是
  「浏览器授权成功但账号不出现」）。身份从 `id_token` 解（不验签，仅展示）；Google 偶尔
  轮换 refresh_token，响应给了新值必须回写。续期 per-credentialRef 串行（R1-2 同款锁 +
  锁内重读）。
- **配额**：`retrieveUserQuotaSummary`（sandbox），请求体**必须带 `project`**（`{}` 对第二个
  账号 403 SUBSCRIPTION_REQUIRED；字段名是 `project` 不是 `cloudaicompanionProject`）。
  只认 `gemini-5h` / `gemini-weekly` 两个 bucketId（**不按 displayName**）；`resetTime`
  不可解析 ⇒ 整条丢弃（不编造永不过期的窗口）。单位是**百分比**（前端 `%` 显示），
  total 取两窗口平均——这不是积分。60s 缓存按 access_token 键。
- **接线**：`/api/jethub/gemini/login|status|refresh|cancel|balance`（loginId 分支被
  `status_login_test.go` 的 chi.Walk 守卫覆盖）；`InterceptResponse` 分派 gemini →
  Cloud Code SSE→OpenAI chunk（流式）/ 聚合 chat.completion（非流式）；错误帧恒在首帧
  peek 判定。
- **回归**：`gemini_test.go`（14 个）+ `inference_url_test.go`（gemini InferURL 锁定）+
  `status_login_test.go`（chi.Walk 含 gemini）+ `register_test.go`（display-name 表）。
  ⚠️ **未真机验证**：OAuth 流与推理 200 需要真实 Google 账号（实施判据全部来自 ref
  实测记录）；金标准信封按 ref 353 字节用例的前缀+字段序断言（requestId 随机段不逐字节）。

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
- `internal/jethub/credentials_key_test.go`（5 个）：**空 config 密钥下凭据可存**（本次报错的直接回归）+ 自持密钥稳定且不等于 config 密钥 + config 密钥旧文件迁移（迁移后无 config 密钥也能读）+ 无法解密时必须显式报错 + 浏览器 opener 被调用**且拿到请求里的浏览器/会话选择**（§3.9）。
- `internal/jethub/cline_test.go`：轮询状态机（400 pending/slow_down 继续、denied 终态）+ **8 个诊断用例**（2xx+pending 不被误判、非 JSON 体点名、空体点名、意外 JSON 形状列出键名、未知 error 码带出码+描述+出站、纯文本 400 带出响应体+出站、invalid_client 专门文案、camelCase token）——§3.3。
- `internal/jethub/minimax_convert_test.go`（14 个）：出站 URL 必须由 Customize 覆盖为完整推理端点 + 其他 provider 不受影响 + Anthropic 进站原样透传（只补 stream）+ OpenAI→Anthropic 富体（system 折叠/图片 base64/tool_use+tool_result/tools+tool_choice/max_tokens 默认/相邻同角色合并/远程图片显式报错）+ **思考三态判据表**（12 例：M3.1 拒 disabled、M3 只能 on|none、M2.7 不声明、未知模型不声明）+ 流式转换（reasoning/content/tool_calls/usage/finish）+ **截断流冲刷**（stop_reason=length、usage 不丢）+ 非流式两种聚合 + 首帧错误拦截 + 错误体改写保留 `insufficient_balance`（§6.1）。
- `internal/api/jethub/login_page_test.go`（6 个）+ `internal/api/jethub_login_page_public_test.go`（2 个）：公开登录页端点（二维码内容/404/状态生命周期/不泄露账号 id）+ **在开启密码保护的真实路由器下**断言 `/api/jethub/login-page` 未被鉴权拦截（404 来自 handler）而 `/api/jethub/providers` 仍 401，静态页与 `raccoon-qr.js` 公开可取（§3.4）。
- `internal/jethub/inference_url_test.go`（5 个）：**逐 provider 推理端点与参考实现比对**（buddy/workbuddy/lobsterai/trae/cline/raccoon/minimax/codearts/loomy 九条，改产品表即红）+ `Customize` 返回值一致 + qoder 族必须不声明 InferURL + **codearts 签名看到上游路径且原请求未被污染** + `RegisterProduct` 的发布/撤销语义（§6.2）。
- `internal/jethub/bridge_keys_test.go`（3 个）：**用真实凭据结构体**逐 provider 断言 `accessTokenOf` 非空（缺陷 15 的直接回归 —— 通用假体凭据曾让这个缺陷逃过全部测试）+ codearts Key 取值优先级 + 未注册提取器的 provider 仍走通用 `access_token`。
- `internal/api/jethub/register_test.go`：`modelDisplayParts` 形态表（12 条，含「裸 FREE ≠ 免费」「FREE (x0.5) 显示 x0.5」）+ **促销窗口**（窗口内/外/边界 × 两个时区表达，锁「与机器时区无关」）+ **qoder/qodercn 倍率逐条对账**（期望值取自 ref `qoder-product.ts`）+ trae 展示名 + **`TestModelDisplayNamesMatchReference`**（逐 provider 代表条目核对 `名称 · 倍率` + 四条不变量 + trae 隐藏项/条数；已反向验证）——§6.3。
- `internal/jethub/codearts_response_test.go`（8 个）：**直接用用户 trace 的真实响应体** —— 200 + `81114.429` 限流按排队重试（10s 同 Key）、200 + `4004.200 benefit not found` 显式失败并带出码/文案、400 + `TM.00001041` 并发上限按排队重试、文案兜底三种、其它错误原样透传（body 完整还回）、正常 SSE 流逐字节不变、`error_code` 判据表（§6.4）。
- `web/raccoon-qr.test.js`（6 项）：二维码矩阵**黄金指纹**（由 ref TS 实现产出）+ 结构（finder/确定性/8 掩码互异/容量与参数报错）+ 页面只依赖公开端点且不含凭据字样 + feature 清单登记 + **路由挂载位置守卫**（`RegisterPublicLoginPage(` 必须出现在 `r.Use(authMW)` 之前）——§3.4。
- `internal/api/jethub/register_route_test.go`（3 个）：真 chi 路由级 —— proxy 开关路径形状（正确 200+JSON / 旧错误形状 404）+ 参数校验（缺字段 400、未知 provider 404 带 JSON error）+ `GET /providers` 携带 `proxyEnabled`。
- `internal/api/jethub/status_login_test.go`（2 个）：**每条 `/status` 路由的 `loginId` 契约**（chi.Walk 枚举 + 200 必带 `done` / 404 必带 JSON error）+ loomy 的完整三态与回收后 404（§3.6 缺陷 19）。
- `web/jethub.test.js`（27 项）：登录流 context 纪律静态守卫（§3.2）+ app.go 必须接线 SyncKeys/browser/proxy 三 hook + SMS 占位账号创建/取消清理 + **URL 流登录弹窗状态机**（进行中/成功/失败/会话已回收，§3.6）+ **+新建账号 的浏览器/会话选择步（§3.9）** + Use Proxy 开关（渲染/PUT 体/失败回滚）+ **模型行展示形态 `名称 · 倍率` + 紧邻裸 id + 点 id 复制 `{prefix}/{id}`（无前缀退回裸 id）**（§6.3）+ **前端 jethub 路径与后端路由表形状守卫** + **账号卡三组新用例（R4-0，§3）**：①额度行（单位标签三态 / 配额逐窗口且不得出现均值 / 临时·长期分桶 / 无 `windowDays` 时不造分类行 / 失效额度不并进总额 / 账号规格行有值才显示）；②拖拽排序（提交**完整**顺序表 / 用服务端 `rotationOrder` 渲染序号 / 落到自己位置不发请求）；③provider 专属卡片（匿名标记与出口 IP 提示 / 一次性奖励文案 / loomy 两个独立按钮 / opencode 有指纹无代理）+ 其余 UI 行为。
- `internal/jethub/codearts_refresh_test.go`（9 个）：`shouldRefreshNow` 窗口（未知到期/1h 内/远期）、误标 `refreshable=false` 自愈、远期跳过、材料缺失对账 false、同凭据并发只发一次请求、`InvalidDPoPHeader` 非终态、真终态不损坏凭据、augment 去头标记跨头部重写存活、`max_tokens` 收敛（§3.7/§6.4）。
- `internal/jethub/qoder_window_test.go`（3 个）：10:00（UTC+8）窗口判据、刷新前 `CLAIMED` ≠ 今天已领、刷新前领取 `coversToday=false`（§6.6）。
- `internal/jethub/opencode_test.go`（10 个）：指纹/会话/请求 id 形状、门禁注入（stream + bash/read + tool_choice 规则）、错误分类与 retry-after 策略（0 合法/封顶/默认值）、模型表 14 条与免费集合、账号添加去重与 Key 提取器、augment 头整体替换、拦截器映射（BillingLock/FreeTier/透传 + body 还原）、非流式 SSE 聚合（content/tool_calls 拼接/usage/finish）、匿名槽殿后 + 付费可见性（bridge）（§3.8/§6.5）。
- `internal/proxy/augmenter_test.go::TestForwardWithRetry_SameKeyRetryDropsHeader`：bridge 发起的同 Key 重发 —— 重发一次、回环标记对 augmenter 可见、标记不泄漏上游（§6.4）。
- `internal/api/jethub/opencode_test.go`：apikey/匿名登录端点（200/去重 reused/空 key 400/账号列表）。
- `internal/api/jethub/balance_capability_test.go`（3 个）：**能力位 ↔ 路由双向守卫**（路由有 ⇒ `HasBalance` 必须有，反向亦然；并锚定 minimax/raccoon/trae/cline/opencode 五家必须登记 —— 已反向验证：临时摘掉 cline 的标志立刻变红）+ Gemini/loomy 的 `supportsRateLimit` 例外 + **领取语义位**（raccoon = `onboarding` 且不再渲染独立新手任务按钮；loomy = `daily` + 独立新手任务；workbuddy 无签到）。
- `internal/jethub/credit_fields_test.go`（7 个）：buddy 到期字段与 `expiredTotal`、trae 顶层 `user_entitlement_pack_list`（名字取 `display_desc`、`expire_time` **秒**→毫秒、越界 clamp、信封兼容）、raccoon 四池（`available_points` 缺失必须报错而不是显示 0）、Gemini 档位解析（`paidTier` 优先 / Ultra→Pro→Free 顺序 / 取不到返回 nil）、Gemini 窗口重置时刻进明细、`windowDays` 环境变量（`0` 是合法值）、qoder 专用包到期。
- `internal/jethub/ratelimits_test.go`（3 个）：解禁时刻文案解析（中英两种句式 + 负偏移 + 半时区 + 无时区不猜）、**重测把上游新的解禁时刻写回**（已反向验证）、`UpdateModelRateLimit` 只延长不缩短 + 空模型名拒收 + 未知账号 `ErrNotFound`。
- `internal/rotation/ratelimit_observer_test.go`：四条写锁路径都通知观察者、观察者拿到的时刻与写入的一致、未安装观察者时安全 no-op、未知 key 不产生通知。
- `internal/jethub/order_test.go`（3 个）：池内顺序＝选号优先级（含重启后仍生效 + 桥接 key `Priority` 跟随位置；已反向验证：把 ID 重排加回去立刻变红）、顺序表集合相等校验（少/多/重复/陌生人一律拒绝且不改动现状）、匿名通道恒殿后但仍可拖动。
- `internal/jethub/opencode_test.go::TestOpencodeChannelBalanceIsLocalState` + `::TestOpencodeFingerprintRotation`：通道可用性的四种形态（干净/限额中/标记已过期/已停用 + 未知账号报错）与指纹轮换（同代次稳定、换代次必变、**凭据里的 projectID 绝不直接透传**、代次落盘、凭据代次是下限）。
- `internal/jethub/zcode_local_read_test.go`：**R4-1 的源码字面量守卫** —— 官方凭据文件/遥测状态/安装清单/密钥前缀一律不得出现在非测试源码里（已反向验证：注释里留一个文件名都会变红；另有「扫了 0 个文件 ⇒ 守卫失效」的自检）。
- `internal/proxy/perkey_proxy_test.go`（1 个大用例，5 条断言）：per-key 代理**设了的会绕**（上游一次都不被打到）/**没设的不绕**（真直连，一个字节都不绕）/ **优先于 provider 级开关** / 非法串回落直连 / 同一代理串复用同一 client 对（含流式）—— §3.10。**第二条断言是安全边界**：只证明「设了的会绕」等于放任一次全局路由回归。
- `internal/jethub/account_proxy_test.go`：账号代理落到**桥接的 key** 上（已反向验证：删掉 `SyncKeys` 里的 `Proxy` 赋值立刻变红）+ 默认时出站 client 与 provider 级是**同一个实例**（默认路径不变）+ 落盘与重启保持 + 空串是合法清除 + 非法值当场拒绝且不改动现状 + 未知账号报错。
- `internal/browserlaunch/browserlaunch_test.go`（13 个）+ `internal/jethub/login_open_test.go`（11 个）+ `internal/api/jethub/login_open_test.go`（6 个）：**家族 flag 表**（Edge 必须 `--inprivate`、**不得** `--incognito`；未知家族不得声称支持隐私模式）+ `BuildArgs` 的拒绝矩阵（无 exe 却要隐私/独立配置、隐私与独立配置互斥、Firefox 无 `--user-data-dir`）+ 相对 `--user-data-dir` absolutize + 探测表（候选路径/PATH 回退/去重/顺序）+ 默认浏览器命令解析（带引号/不带引号含空格/空命令）+ 选择归一化（请求→偏好→旧默认）+ `ValidateOpenOptions`（未知浏览器/目录/未知会话/未知内核+隐私 拒绝；**不建目录**）+ 偏好往返与损坏文件不致命 + 独立配置目录净化（`../` 不得逃逸）与**越界路径不清理** + 账号删除后目录尽力清理 + API 端点形状（三条会话模式/浏览器行）+ **建号前拒绝**（不可用浏览器 ⇒ 400 且账号池仍为空）+ `open-login-url` 的全部拒绝分支（§3.9）。
- `web/jethub.test.js` 新增「login dialog: browser/session axes ride the login RPC」用例：选择步渲染两轴与记住的偏好 + **确认前不得有任何 POST**（服务端在建号时开页）+ 选择步取消不删账号 + 确认携带 `{browser,browserPath,session}` + 等待步轮询 + 「重新打开登录页」走服务端端点 + 内核未知时隐私项判定（§3.9）。
- **已知限制**：SMS 弹窗流程（loomy/raccoon 短信）无服务端 login session——占位账号由**前端**创建，若用户直接关页（非点取消）会留下无凭据占位（灰徽标可见，可手动删除；不影响推理/领取）。扫码登录页未移植「取消后换码刷新」，也没有短信 Tab（§3.4）；loomy 的微信链路**主流程已真机验证通过**（2026-10-01，§3.5/§3.6）、未移植「失效自动换码」；minimax 非流式聚合的响应形状未经真机验证（§6.1）；**trae 缺 SOLO→OpenAI 响应转换**（§6.2）；**trae/lobsterai 缺远端模型目录拉取**（模型列表只是静态子集、无倍率，§6.3）；buddy/workbuddy/lobsterai/trae/cline/raccoon 的推理链路**已修 URL 但尚无真机验证**（每个 provider 发一条 `{前缀}/{模型}` 即可确认）；**zcode 的推理链路已验证到「请求被上游接受（200、无 3012/3001）+ 无权益空流被正确判定」**，但**有内容的正向流**与**每日领取的载体页**需要带 plan 的账号才能真机走通（§6.7）；zcode 推理侧 captcha 产出与并发门未实现（§6.7）。**登录浏览器/会话模式（§3.9）**：隐私窗口必然是「未登录」状态（每次手输账号 + 2FA、扩展被禁用 ⇒ 企业 SSO 可能不可用），企业策略禁用无痕时浏览器**静默**按普通窗口打开（本端无法检测）；内核未知的 fork 拒绝隐私模式；macOS 的 `open -a … --args` 对已运行实例不传参数（实现上直接执行 bundle 内二进制，待真机验证）。
