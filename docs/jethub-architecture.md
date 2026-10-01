# Free Hub (jethub) 架构

> **最后核对：** 2026-10-02（P1–P4 + UI 对齐原版插件重做 + **登录流生命周期修复**：main 区内嵌布局 / 详情页按钮行+账号卡 / 模型列表纵向批量 / 限流重测重置 / 永久锁存储+备份 / 后台登录轮询脱离请求上下文 + 占位账号单赢家结算）
>
> Free Hub 是 DeepSeek Harness 插件 `dsh-codearts-auth`（11 个第三方 LLM provider 的账号池 + Web 管理面板，TS/React）的 TinyLab 原生移植：产品名 **Free Hub**，内部包前缀沿用 `jethub`。只读参考副本位于 `ref/deepseek-harness-codearts`（**禁止修改**；每份移植实现的语义权威）。
>
> **变更维护清单（改动时必须同步本文）：**
> - 新增/修改 provider 适配（登录/续期/签名头族/模型表）→ §6 矩阵 + `internal/jethub/` 对应文件；**登录流必须走 §3.2 的独立 context + SettleAndCleanup 约束**
> - 修改代理桥接接口（RequestAugmenter/RequestCustomizer/ResponseInterceptor）或重试语义 → §4 + `internal/proxy/interfaces.go`/`forward_retry.go`/`upstream.go`
> - 修改 Qoder WASM 桥（导入表/导出封装/对象堆）→ §5 + `internal/jethub/qoderwasm_bridge.go`
> - 修改备份格式 → §7 + `internal/jethub/backup.go`（与原版格式**双向兼容**，改动即破坏兼容，须先读 ref types.ts）
> - 修改 Free Hub UI 布局/入口/详情页/模型列表 → §3 + `web/static/jethub.js`/`settings.js`/`i18n.js`/`style-jethub.css`/`app-router.js`
> - 修改限流重测/重置探针或永久锁 → §3.1 + `internal/jethub/probe.go`/`ratelimits.go`/`manager.go` + `internal/api/jethub/register.go`

## 1. 模块组成与边界

| 部分 | 位置 | 说明 |
|---|---|---|
| 核心 | `internal/jethub/` | 账号/凭据存储、账号池、registry 桥接、11 provider 适配、WASM 桥、备份 |
| API | `internal/api/jethub/` | `/api/jethub/*` RPC（§10.28 PROJECT_MAP）：providers（含能力位）/prefix/accounts/models（单/批量/恢复默认）+ ratelimits retest/reset + permanent-lock + 每 provider login/status/refresh/claim/balance + backup export/import |
| 前端 | `web/static/jethub.js` + `style-jethub.css` | Free Hub 管理界面（vanilla JS，无框架），入口嵌在 Settings 页、main 区内嵌布局（§3）；行为测试 `web/jethub.test.js`（17 项） |
| 跨边界错误 | `internal/upstreamerr/` | `QueueRetryError`/`BillingLockError`（proxy 与 jethub 各自 import 的中性叶子包） |
| 装配 | `internal/app/app.go` | Manager/Bridge 构造、`RestoreBridges` 启动重桥、augmenter 注入 proxy Handler |

**边界纪律：`internal/proxy` 不 import jethub**（AGENTS.md 红线）。proxy 只认识 `APIType=="jethub"` 标记与三个窄接口；jethub 结构化实现、装配时注入（`Handler.SetRequestAugmenter`）。

## 2. 存储层（`{configDir}/jethub/`，`config.ResolveJetHubDir`）

- `credentials.json`：`{provider → credentialRef → 凭据 JSON}` 整体 AES-GCM 加密信封（`{"enc":"..."}`），密钥与 config 加密同源；**凭据字段按 ref `src/types.ts` 1:1**（备份兼容的前提）。
- `accounts.json`：账号索引 + 模型黑名单 + 前缀映射（`accountsFile`，与原版 JetHubConfig 同构——§1.5 备份兼容前提）。
- 两者均 `fsutil.AtomicWrite` 原子写；`Manager` RWMutex 双锁。
- `machine_id` 类设备标识是**插件生成并随凭据持久化的随机 UUID**（qoder）或确定性派生（trae），非硬件指纹。

## 3. Free Hub UI（Settings 内嵌）

- **入口**：Settings 侧边栏 `Free Hub` 行——Path Settings 行后、Assistant 行前（`settings.js` `#free-hub-entry`，契约测试锁位置）；i18n `freeHub*` en+cn。
- **main 区内嵌（不整页替换）**：`openFreeHub()` **保留 `.settings-panel-left`（Settings 侧边栏）**，仅隐藏 `.settings-panel-right` 并在 `.settings-layout` 内其后面挂 `#free-hub-root.free-hub-main`（占 main 位）；`closeFreeHub()` 反向恢复（轮询定时器一并清理）。若 layout 不存在（页面被换走后重进）会先 `renderEndpoint` 重渲染再挂载。
- **切页生命周期**：`navigateTo`（`app-router.js`）调用 `closeFreeHub()`——页面切换会整体清空 `#page-content`，不清标志会导致再次进入 Free Hub 被陈旧 `__jethubActive` 守卫挡住（修复过的真实缺陷：必须重启 App/Ctrl+F5 才能恢复）；`openFreeHub` 侧另有兜底——active 时先执行一次 close 再重挂。
- **布局三段式**：header（一键签到 / 备份 / 恢复 / 关闭，**四按钮一列左对齐**，无右推 spacer）+ left pane（11 provider 列表，账号数徽标单选）+ right pane 五区（调用前缀 / **操作按钮行** / 通知区 / 账号卡 / 模型列表）。
- **详情页操作按钮行**（能力门控与原版 dim-jh-headerActions 一致）：刷新积分（`hasBalance`）· 一键领取积分（`hasCredits`）· 重测所有 + 重置所有（`supportsRateLimit`，loomy 不渲染——它不限流，重测只会白烧额度）· 解锁|锁定永久积分（`canLockPermanent` = {loomy, buddy, workbuddy}）· + 新建账号。结果在通知区显示（tone + 逐条 details 列表）。
- **账号卡**：状态点 + 名称 + 徽标（启用/key/refresh）；元信息行 = 凭据 ref（code）· 有效期（`X 分钟后/小时后`/日期，过期红字 + `· 自动续期`）· 积分（**逐账号**余额，挂载/刷新积分时并发逐个查询，错误显示「查询失败」不阻塞其它卡）；「限额重置」芯片行（仅未到期标记显示，任一标记存在即启用重测/重置）；按钮行 = 重测 / 重置（单账号，仅有标记时可用）· 领取积分 · 续期 · 改名 · 停用|启用 · 删除。
- **模型列表**（与本项目 Provider 详情的 Model list 同形态）：纵向行列表（名称 + **倍率徽标**（服务端 `rate` 字段：`x0.75`/`免费`/`x0.2→x0.1`，从 alias/note 解析、**无信息不编造**） + 可复制的模型 id + 删除/恢复单钮）；批量管理 → 筛选 / 全选|取消全选 / **删除所选**（批量进黑名单，一次写盘 + 一次 SyncKeys）/ 取消；**恢复默认** = 清空黑名单（黑名单语义：删除=隐藏，恢复默认全部找回，被删项灰显带「已隐藏」徽标保持可逆）。
- 登录流按 provider `loginModes` 分派：`url`/`qr` → 登录 URL 弹窗 + 2s 轮询（`{done,success}` 契约）；`sms` → **先创建占位账号**（POST `/accounts` 拿 `accountId`）再弹发码/验码两步弹窗（提交时按 `accountId` 绑定凭据；**取消 = 删除占位**）。URL 弹窗的取消同样删除占位。无凭据的占位账号在账号卡上显示「登录未完成 · 无凭据」灰徽标（`freeHubNoCredential`），领取/推理账号集都会过滤掉它们。
- 样式只用 theme tokens（`var(--…)`），控件复用全局 `.btn`/`.badge`/`.modal`/`.input` 体系。

### 3.1 限流标记重测/重置 + 永久积分锁（后端）

- **标记数据**：`accountEntry.ModelRateLimits`（model id → 重置时刻 ms）。本端推理链路写入的是 rotation 的 per-model 锁；该表当前主要来自**原版备份导入**（携带原插件的限流状态），重测/重置即是对这份数据的操作。内部记账键（`__` 前缀，如 trae 的签到代次）不参与重测/计数/渲染。
- **重测** `POST /api/jethub/{provider}/ratelimits/retest` `{accountId?}`（`Bridge.RetestRateLimits`）：对每个标记的 (账号, 模型) 经 `Bridge.ProbeAccountModel`（`probe.go`）**真实发送一条最小消息**（OpenAI 体；minimax 走 `/v1/messages` + Anthropic 体；max_tokens=16）。探针**复用代理的 augmenter/customizer 管线**（`Manager.Customize`——codearts HMAC、qoder WASM、trae SOLO 都由各自 augmenter 完成，探针零协议实现）；URL 用 `urlutil.BuildUpstreamURL(base, entryPath)`，qoder 族由 Customizer 返回完整加密端点覆盖。HTTP 200 → 清除该标记；非 200 → 保留并在响应 `accounts[].stillLimited[]` 带原因（含状态码 + 截断报文）。会消耗少量额度——前端「重测所有」先确认。
- **重置** `POST /api/jethub/{provider}/ratelimits/reset` `{accountId?}`：直接清除（跳过 `__` 键），不发任何请求。
- **永久积分锁** `PUT /api/jethub/{provider}/permanent-lock` `{locked}`：provider 级开关（`accounts.json` 的 `permanentLocks` 表，仅 true 值有意义），能力白名单 {loomy, buddy, workbuddy}（原版 `PERMANENT_LOCK_PROVIDERS`）；`GET /providers` 每项带 `supportsRateLimit`/`canLockPermanent`/`permanentLocked`。⚠️ **选号侧的「锁定后只消耗临时积分」策略未移植**（需要对选号注入积分池感知）——开关持久化 + 随备份迁移已可用，语义见 §7。

### 3.2 登录流生命周期（+新建账号 的真实缺陷与修复）

登录是**两步式**：login handler 立即返回 `loginUrl` + `loginId`，后台轮询/回调等用户在浏览器完成授权（数十秒到数分钟）。这条结构曾引出四个真实缺陷（用户实测复现：占位账号立即出现、浏览器不自动打开、弹窗永远停在等待、凭据永不落盘/prefix 检索不到）：

1. **请求上下文绑定**：`Start*Login(r.Context(), …)` / 后台 `Poll*(r.Context(), …)` —— handler 写完响应后 `net/http` 立即取消请求 context，后台轮询当场夭折。修复：**所有登录流一律 `context.Background()`**（raccoon/cline/trae/lobsterai/buddy/minimax/qoder；codearts 流自身已是 Background）。qoder 最早注释了这个坑但其余 provider 全部中招。`web/jethub.test.js` 有静态守卫（逐文件断言 `context.Background()` + 禁止 `Start*Login(r.Context())`）。
2. **双消费者竞争**：status 轮询（`pollLogin`）与 API 层 pump goroutine 都直接读 `LoginSession.Started.Result`（容量 1 的缓冲 channel），先到者独占 outcome，另一方永久挂起。修复（`internal/jethub/sessions.go`）：**单赢家纪律** —— 只有 pump（`SettleAndCleanup`）读 channel 并记录结果（`settled` 状态 + `SessionStatus` 只读快照）；status 轮询改读记录态。
3. **结算即 reap（弹窗永远停在等待）**：pump 结算后立即 reap session 的话，2s 轮询的下一次请求必然 404 —— `done:true` 转换永远不会被前端观察到，即使后端已成功。修复：结算后保留 `loginSessionGracePeriod`（30s，若干轮询间隔）再 reap。
4. **凭据落盘后桥接 Key 不刷新（prefix 检索不到）**：`SetCredential` 的 `onAccountCredentialed` hook 在 app 装配层**从未接线**（git 历史确认：hook 定义了但无人调用）——登录成功后桥接 provider 的 Keys 永远不更新，新账号对 `{prefix}/{model}` 路由不可见；备份导入能工作只是因为 `backupImport` 显式重同步。修复：`app.go` 装配 `SetAccountCredentialedHook(→ Bridge.SyncKeys)`。同时接线 `SetBrowserOpener(→ fsutil.OpenInBrowser)`：+新建账号自动打开默认浏览器授权页（对齐原插件；弹窗内链接保留为手动兜底）。

> 占位账号语义：`POST /accounts` 或 login handler 创建的占位（无凭据）在完成前**可见但明确标注**（灰徽标），且从不进入推理/领取账号集；登录失败或用户取消都会将其删除。

## 4. 调用桥接（核心机制，零特殊调用路径）

1. 用户为 provider 设**调用前缀**（全局唯一，`[a-z0-9-]{1,32}`）→ `Bridge.SetPrefix` 校验冲突（409）+ 持久化。
2. `Bridge.SyncKeys` 在 registry **动态注册** `config.Provider`：`ID=jethub-{provider}`、`Prefix=用户前缀`、`BaseURL=product 推理端点`、`Keys=启用账号×1`（`Key.Key`=access token，凭据刷新时同步）、`Models=静态模型表`（黑名单过滤）、`APIType="jethub"`。
3. 调用侧无感知：`model={前缀}/{modelID}` 走 `handleProxy` → `GetProviderByPrefix` → `forwardWithRetry` 标准链路；**多账号轮询直接复用 rotation 三策略/冷却/配额锁**，不另造轮子。
4. **请求增强 hook（依赖倒置）**——三个窄接口，全部可选、结构性注入：
   - `RequestAugmenter.Augment(r, body, providerID, keyID, upstreamModel)`：改写出站头基与 body（十协议族中 9 个用这一层）。
   - `RequestCustomizer.Customize(...)`（可选，qoder 族）：返回 **WASM 决定的完整出站 URL** + 加密体；空 URL 回退默认构造。
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

| provider | 协议族/推理端点 | 登录 | 出站签名/头族要点 | 续期 | 积分 |
|---|---|---|---|---|---|
| codearts | OpenAI 兼容 `snap-access…/api/v2` | 两步 OAuth（随机端口回调 + PKCE/DPoP） | `SDK-HMAC-SHA256`（maas_type 参与签名）+ benefit 兜底 | refresh_token | 签到五步流 + 余额 |
| buddy / workbuddy | OpenAI 兼容（CN/国际双产品，endpoint 不同） | 轮询登录流（11217 继续/12151 账号） | Bearer + X-Domain/X-Product/X-Agent-* 头族 + 按模型族 UA | refresh（终态判定） | 签到（10001 幂等）+ 双层嵌套余额 |
| lobsterai | OpenAI 兼容 | 本地回调两步 | Bearer 四头 + Client-Capabilities（kimi-k3 准入前提） | 匿名 POST + keyfrom | 三步签到 + profile-summary 余额 |
| trae | **SOLO 私有协议**（agent host） | 回调双流程（token 直传 + PKCE 并行） | `Cloud-IDE-JWT` + X-* 头族 + OpenAI→SOLO body 转换 | ExchangeToken 轮换 | 签到（9074 设备级限流→代次派生绕开） |
| cline | OpenAI 兼容 `api.cline.bot` | WorkOS 设备码 | `Bearer workos:<jwt>` 前缀必须保留 | 驼峰 `{refreshToken,grantType}` | 余额（`usr-` id） |
| raccoon | OpenAI 兼容 + extra_body.thinking | 微信 QR + 短信 | AES-128-CFB 手机加密 + Bearer | 200003 终态 | 登录奖励 + 新手礼包 |
| loomy | OpenAI 兼容 | **短信验证码**（不可静默续期，诚实 `refreshable:false`） | CAccount HMAC-SHA1 双头 | —（无） | 双积分池 + 新手任务 |
| minimax | **Anthropic Messages 原生透传** | 设备码（scope 硬校验 agent.default） | `mmoat_` 非 JWT + Authorization Bearer（无 anthropic-version） | refresh 回退上一个 | 签到（timezone_id 必填）+ Σ remaining_amount |
| qoder / qodercn | **加密端点**（WASM 签名体，§5；同协议族双产品） | PKCE 设备码轮询（404=未就绪继续） | COSY 签名头原样透传 + `/sash/` 四头 | refresh_token + machine_id | 余额三包 + 每日领取（replayed 幂等） |

模型表全部为**静态兜底表**（`*_model.go`/`products.go`），收录 ref 实测可用的目录 key；qoder 双站表**不能互相套用**（CN 独有/缺失条目 + per-model is_reasoning/is_vl 差异）。

## 7. 备份/恢复（与原版 Jet Hub 双向兼容）

- 载荷 `BackupPayload`（`internal/jethub/backup.go`）与 ref `types.ts` **逐字段同构**：`{format:"dsh-codearts-auth/backup", version:1, exportedAt, credentials: ref→JSON 原文字符串, accounts: ProviderAccountEntry[], disabledModels, permanentLocks?}`。
- **加密壳在浏览器**（`crypto.subtle`，与原版 backup-crypto.js 同参数：PBKDF2 310000 / SHA-256 / AES-256-GCM / salt 16B / iv 12B，`format: dsh-codearts-auth/backup.encrypted`）；明文载荷由 Go 组装/导入（`GET /api/jethub/backup/export`、`POST /api/jethub/backup/import`）。
- 导入语义：账号按**原 id upsert**（幂等）、凭据 JSON **原文直存不重新序列化**、黑名单整体替换、格式/版本硬校验拒绝；导入后全桥接 provider SyncKeys。
- **permanentLocks（锁定永久积分）已实现双向迁移**：导出写 sanitize 后的表（只留 true，恒有该键）；导入按原版 `locksFromPayload` 三分支——有表→整体替换（过滤脏值）、仅有旧版 `loomyPermanentLocked`→只落 loomy、两者皆无→保持当前值。
- 实测兼容性：原插件导出的备份已由用户**实际导入成功**（2026-10-02）；反向（本端导出→原插件导入）为源码级逐字段推证。

## 8. 错误语义（两条通道共用一套判据，`qoder_queue.go`）

| 形态 | 判据 | 处理 |
|---|---|---|
| 排队 10605 | `ParseQueueError` BFS 穿透 data/result/message/body（外层整体与内层消息两种入参；瞬时排队 `isQueued:false` 不要求 true） | 同 Key 按服务端延迟等待重发（<10s 遵其值，≥10s 封顶 10s，180 次上限） |
| 计费 110 | 业务码 + **窄文案兜底**（`billing daily count exceeded`/`billing_error`；泛词会误伤正文） | per-model 锁至 UTC+8 当日 24:00（纯算术，不取本机时区）+ 切号 |
| 认证 105/401 | 业务码/状态码 | 续期凭据后报错换路（唯一走 refresh 的情形） |
| 重复请求 | `duplicate_request` | 直接重发，不续期 |

## 9. 测试与已知限制

- `internal/jethub/sessions_test.go`：SettleAndCleanup 三路径（失败删占位 / 成功保留 / complete 失败删占位）+ `SessionStatus` 未结算快照。
- `web/jethub.test.js`（17 项）：登录流 context 纪律静态守卫（§3.2）+ SMS 占位账号创建/取消清理 + 其余 UI 行为。
- **已知限制**：SMS 弹窗流程（loomy/raccoon 短信）无服务端 login session——占位账号由**前端**创建，若用户直接关页（非点取消）会留下无凭据占位（灰徽标可见，可手动删除；不影响推理/领取）。
