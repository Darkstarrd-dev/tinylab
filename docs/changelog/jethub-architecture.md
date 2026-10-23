## 2026-10-23 — R8：Loomy 远端模型目录落地（用户报障驱动）

**用户报障**：上游 Loomy 渠道可用的模型在 Free Hub 里没有。根因：上游的 Loomy 模型列表是**远端实时**的
（`src/loomy-adapter.ts` 的 `parseLoomyRemoteModels` + `index.ts` 注入的 `fetchRemoteModels`），
2026-10-08 commit `02653ea` 起远端 chat 条目从 8 条涨到 9 条（新增 `DeepSeek-V4.1-Flash`）；
本端此前只搬了 `loomy-product.ts` 的静态兜底表 8 条，无任何远端目录拉取（§6 R1-8 登记的缺口）。

**实现**：
- 新增 `internal/jethub/loomy_models.go`：`loomyParseRemoteModels`（只留 `type===chat`；接受裸数组与
  `{data:[...]}`；`loomySplitRate`/`loomyDisplayName` 名称规范化，两种形态且幂等）+ `loomyContextWindow`/
  `loomySupportsImage` 覆盖表（spark-x 真实 262144、qwen-3.8-max 图片补报；查表归一、**不改对外 id**）+
  进程内缓存（成功 10min / 失败 30s / 并发去重 / **兜底不写缓存**）+ `loomyFetchModels`（token 头）+
  `LoomyModelsFor`（远端优先、离线回落静态兜底表）。
- `internal/jethub/products.go`：loomy 的 `Product` 加 `ModelsFor: LoomyModelsFor`（`SyncKeys` 与
  `GET /jethub/{provider}/models` 共用，与 accio 同型）。
- `internal/jethub/trae_model.go`：`loomyFallbackModels` 的 `spark-x` `ctx` 由 1048576 订正为覆盖表真实值
  **262144**（远端虚报 1M；ref IKJW31）。
- 新增 `internal/jethub/loomy_models_test.go`（12 例），四处反向验证：① 去掉上下文覆盖 ⇒ 两条变红；
  ② 去掉图片覆盖 ⇒ 两条变红；③ `LoomyModelsFor` 恒返回兜底表 ⇒ `TestLoomyModelsForRemoteFirst` 变红；
  ④ 摘掉 `ModelsFor` 接线 ⇒ `TestLoomyProductWiresModelsFor` 变红。

**验证**：`go vet ./...` 干净 + 全量 `go test ./...` 全绿 + `node --test web/jethub.test.js` 全绿 +
`go build` 正常。**无账号真机验证**（loomy 目录拉取需真实凭据；判据以单测 + 反向验证为准）。

## 2026-10-21 — R7：Free Hub 上游同步（pin `b0940ca`），新增 minimaxintl / modelscope / autoclaw（第 16/17/18 家）

**上游事实**（ref `b0940ca` @ origin/master）：
- **MiniMax 国际版（minimaxintl）**：与国内版共享 100% 协议族（Anthropic Messages API，mmoat_ 格式凭据，设备码授信），仅域名（account.minimax.io / agent.minimax.io）及 region（en）不同。
- **ModelScope 魔搭社区（modelscope）**：阿里达摩院社区通道，OpenAI 兼容推理，长期 API Key 凭据（ms-…）。魔粒余额端点位于独立主机 `https://www.modelscope.cn/openapi/v1/magicubes/balance`。上游真实事故：扁平工具参数被 400 校验拦截，必须包装成 `{type:"function", function:{...}}`。36 个兜底模型表。
- **AutoClaw 智谱清言（autoclaw）**：智谱清言桌面端加速网关直连，手机号短信验证码登录。动态 MD5 签名 `MD5(appId + '&' + timestamp + '&' + appKey)`。推理请求必须携带 `X-Version: 2.1.1` 硬校验头（缺之 500 空响应）。406 拦截硬绕过：首条 message 必须精确为 system 且包含 `You are AutoClaw. Answer the user directly and concisely`；max_tokens 钳制不低于 10000 官方门禁。积分钱包余额与每日签到。
- **WorkBuddy `reasoning_effort` 回退（`e261cd6`/`1361706`）**：此前剥离导致 DeepSeek 推理模型思考 token 清零（0/10），上游实测权衡「思考输出优先于工具调用前 preamble 散文」，故撤销剥离。
- **Rotation 错误规则增强**：11128 `ActionRotateOnly` (conversation id missing), 11140 `ActionCooldown 1800s` (request illegal), 14018 `ActionDailyQuota` (credits exhausted)。
- **模型表测定订正**：OfficeAce 上下文窗口按实测订正（glm-5.3 1048576, glm-5.2 1044480, deepseek-v4.1-flash 1048576 等）；Qoder 补入 `dfmodel` (Free x0) 与 `mmodel` (x0.1)。
- **AStudio 分诊**：讯飞 AstronStudio (AStudio) 依赖 Electron 桌面客户端微信扫码与本地 session 文件导入（astron-session.json），属桌面窗口/本地 session 专属，暂不移植为纯 HTTP API 代理，列入不搬清单。

**实现**：
- `internal/jethub/minimax.go` + `minimax_credits.go`：支持双站点配置、InferURL、设备码登录、静默续期、额度查询与每日签到。
- `internal/jethub/modelscope.go` + `internal/api/jethub/modelscope.go`：模型表、API Key 登录去重、augmenter 工具规范化、魔粒余额查询。
- `internal/jethub/autoclaw.go` + `internal/api/jethub/autoclaw.go`：模型表、短信验证码发送与兑换、动态 MD5 签名头注入、406 前缀绕过与 max_tokens 门禁、积分钱包余额与每日签到。
- `internal/jethub/manager.go`：`defaultProviders` 扩充至 18 家。
- `internal/jethub/products.go`：注册产品与 augmenter。
- `internal/jethub/balance_summary.go`：接入 `minimaxintl`, `modelscope`, `autoclaw` 余额汇总。
- `internal/jethub/buddy_augment.go`：撤销 workbuddy `reasoning_effort` 剥离。
- `internal/rotation/error_rules.go`：加入 11128, 11140, 14018 分类规则。
- `web/static/jethub.js`：apikey 模态框仅对 opencode 显示匿名通道入口。

**测试**：
`go test ./...` 全库通过，`node --test web/jethub.test.js` 全绿，`go build .` 编译成功。

## 2026-10-15 — R6：新增 Accio provider（第 15 家）

**上游事实**（ref `src/accio-*.ts` + `docs/agent-notes/providers-accio.md` @ origin/master）：阿里 Accio Work 通道，gateway 恒为 `https://phoenix-gw.alibaba.com`，region（cn/global）只是登录页域名。登录是标准 OAuth2 + PKCE 公开客户端 `accio-work`，推理是 Gemini 风格 SSE（token 放 body、顶层帧、`sg_k`/`message_id`/snake_case envelope），模型目录远端拉取（`modelCode` 非人类可读，对外用展示名 slug），积分是 credit 三只读端点。

**实现**：
- `internal/jethub/accio.go`（新）：端点常量、凭据结构（`expiresAt` 秒→ms 归一）、`accioToSnake`（`properties` 子树豁免、工具参数 JSON 串保真）、body 构造器与头族（无 Authorization）、15 条静态兜底表 + slug↔modelCode 映射。
- `internal/jethub/accio_login.go` + `accio_oauth.go`（新）：PKCE loopback 登录（state 原样比对 → token 兑换 → best-effort userinfo 回填）、公开客户端授权 URL 拼装、token 信封解析与终态判据。
- `internal/jethub/accio_models.go`（新）：远端目录 `POST /api/llm/config/v2`（token 键 body）+ 进程内缓存（成功 10min / 失败 30s + 并发去重）；无凭据/失败回落静态兜底表。
- `internal/jethub/accio_augment.go`（新）：OpenAI/Anthropic 进站 → Accio envelope；`accioCustomize` 产出带 `sg_k=md5(requestId)` 的完整出站 URL 并否决默认 Bearer 兜底。
- `internal/jethub/accio_response.go`（新）：顶层帧 SSE→OpenAI/Anthropic；thought→reasoning、tool shard 合并、终帧 usage/finish 保留、402→`BillingLockError`、非 event-stream 200 显式报错、截断流冲刷。
- `internal/jethub/accio_refresh.go`（新）：refresh_token 轮换 + codearts/officeace 同款串行/重读/终判前三规则。
- `internal/jethub/accio_credits.go`（新）：三只读端点（userinfo POST body；subscription/quota GET query）、信封判据（`success!==false`、数字/字符串 `401`/`NOT_LOGIN`）、桶存在性语义（0 留、缺席不产行、remaining 读不到跳过）。
- `internal/api/jethub/accio.go`（新）：login/status/refresh/balance 四个端点。
- 接线：manager defaultProviders/probe/refresh/products/qoder adapter/inference_url_test/web 守卫。

**测试**：`internal/jethub/accio_test.go` 25 个 + `internal/jethub/accio_response_test.go` 4 个；`go build ./...`、`go vet ./...`、全量 `go test ./internal/...` 与 `node --test web/jethub.test.js` 均通过（全量跑时未跳过任何用例）。

**已知限制**：Accio 全链路未经真实机器验证（无该账号）；远端目录只做进程内缓存，不落盘；`referral` 桶 `remaining` 读不到按数据不足跳过。

# jethub-architecture.md — 变更日志

## 2026-10-15 — R6：新增 OfficeAce provider（第 14 家）

**上游事实**（ref `src/officeace-{auth,product,adapter}.ts` + `docs/agent-notes/providers-officeace.md` @ e73cd2f，全部实测结论）：华为 ModelArts MaaS「果办」云直连通道，推理走 `POST {maasBaseUrl}/v2/chat/completions`（Basic `base64(model_app_key:secret)`，标准 OpenAI SSE）；管理面 V11-HMAC-SHA256 签名。

**实现**：
- `internal/jethub/officeace.go`（新）：凭据结构（camelCase 字段与 ref 1:1，备份双向兼容；`expiresAt` 是 ISO 字符串**不做** ms/s 归一化）、登录链五步（匿名 state 注册 → authui 授权页（service= 包裹 authorize URL）→ 匿名 code 轮询（202/404=未就绪）→ STS+DPoP 换发 → SDK-HMAC permission-validate 取 MaaS Basic 对 + `maasBaseUrl`）、`RunOfficeaceLogin` 后台泵入口、`CompleteOfficeaceLogin`（昵称 `OfficeAce ` + accountId 前 8 位）、桥接 Key 提取器（modelAppKey 优先，codearts 缺陷 15 同款防线）。
- `internal/jethub/officeace_sign.go`（新）：V11 签名器三条铁律（GET 不签 Content-Type / 派生 key 用 **hex 字符串**的 UTF-8 字节 / LF 分隔符 + canonical 头块**双 LF** + 路径强制尾斜杠 + RFC3986 编码集）+ SDK-HMAC 签名器（bare secret 作 key，无 scope 派生）。region/service 硬编码 `cn-southwest-2`/`apic`（ref 同款已知缺口）。
- `internal/jethub/officeace_refresh.go`（新）：one-time refresh_token 三铁律（per-credentialRef 串行 + lead-time 1h 跳过 + 判终态前重读）；STS 换新**立即落盘**；modelInfo 刷新失败不回滚 STS；`Refreshable` 镜像自愈；调度挂在既有 codearts 30min 调度器。
- `internal/jethub/officeace_credits.go`（新）：`GET /v1/subscription` 余额（套餐桶 `officeace_points` + bonus 桶 + 过期桶归 `ExpiredTotal`；trial 桶无固定到期不臆造；单位恒 `token`）+ `POST /v1/subscription/bonus/claim`（POST 必带 Content-Type；空桶=already-claimed）。⚠️ **有意的差异**：ref 在每次余额查询前自动签到 —— GET 触发 mutating POST 会被 Monitor 聚合每分钟隐式触发，故本端拆成**显式** `POST /api/jethub/officeace/claim`，代价是用户不点「领取」会错过当日积分（积分当日作废）。`/v1/model-token-rates` 未移植（可选增强，无 UI 需求）。
- `internal/jethub/officeace_augment.go`（新）：Basic 鉴权 + body 两条微调（`max_tokens` 低于 4096 直接丢弃——思考链烧小预算致空回复；剥 `reasoning_effort`——服务端白名单校验，绝不注入）+ 其余近透传，无 DSML、无协议转换器；`officeaceInferURL`（per-account `maasBaseUrl` 优先，凭据缺失回落声明值让 augmenter 报权威错误）；`officeaceCustomize`（Customize 分支，同 qoder 族按账号算 URL）；8 模型静态表（multimodal 只标实测通过的 deepseek-v4.1-flash / kimi-k2.6）。
- `internal/api/jethub/officeace.go`（新）：`POST /officeace/login`（`prepareLoginOpen` 建号前校验 → `StartOfficeaceLogin(context.Background())` → `OpenURLWithBrowser` → 后台 `RunOfficeaceLogin(context.Background())` 泵 → `SettleAndCleanup`）；`GET /officeace/status`（loginId 双语义）；`POST /officeace/refresh`；`GET /officeace/balance`；`POST /officeace/claim`。
- 接线：`manager.go`（defaultProviders 第 14 行 + `officeaceRefreshLocks`）、`products.go`（产品表 + augmenter 注册）、`qoder_adapter.go`（Customize officeace 分支）、`codearts_refresh.go`（调度器并跑）、`probe.go`（探针 body `stream:true`、不带 max_tokens）、`balance_summary.go`（分发 case）、`inference_url_test.go`（声明端点锁值）、`web/jethub.test.js`（context 纪律 + SettleAndCleanup + OpenURLWithBrowser 守卫列表；顺带补了此前缺失的 `zcode.go`）。

**测试**：`internal/jethub/officeace_test.go` 16 个（签名形状重放——时钟 pin 后逐字节重算 stringToSign 含双 LF/hex-key 反证、URI 编码集、登录链全 mock 端到端、code 轮询解析表、body 微调、Customize URL 三分支、续期三规则（含 invalid_grant 判终态前重读）、余额解析、claim 两分支、模型表、桥接提取器、探针 body）+ 既有结构守卫自动覆盖（`TestEveryProviderStatusHonorsLoginID` / `TestProviderBalanceCapabilitiesMatchImplementation`）。

**已知限制**：签名未经真机验证（无公开测试向量，锁的是 ref 算法结构）；region 硬编码 `cn-southwest-2`（账号若分到别的 region scope 与 Host 会一起错，ref §6 未守卫，本端如实保留）；探针流式路径未真机验证；每日领取依赖用户手动点击。

## 2026-10-07 — R5 上游同步第一步+载体页（原「最后核对」行归档）

> 以下为被 R6 替换的前两轮「最后核对」行内容（R5 第一步：Gemini 渠道删除；上轮：zcode 载体页开页固定；上轮：渠道级余额合计）。

**R5 上游同步第一步（dsh-codearts-auth `2e8bb86` → `e73cd2f`）**：① 整体移除 Gemini Code Assist 渠道（§6.8 空位）：Google OAuth client 常量被 GitHub Push Protection 判为密钥（GH013），阻塞 `git push`；用户决定直接删除该渠道及其全部实现，并**此后不再同步该渠道的相关上游数据**（同步文档 §5）。provider 数 14 → 13；同时删除的还有 `nonAggregatableProviders` 表、前端配额单位（`%`）渲染与「账号规格」行、`freeHubUnitQuota`/`freeHubAccountTier`/`freeHubCreditRemaining`/`freeHubCreditResetsAt` 四个 i18n 键。② zcode 领取载体页的开页浏览器固定 default+shared（§6.7）：`zcodeOpenURL` 从零值改为显式 `OpenOptions{Browser: BrowserDefault, Session: SessionShared}` —— 零值会被 `normalizeOpenOptions` 用「记住的 +新建账号 偏好」补齐（§3.9），载体页本不需要登录态却跟着用户的 Edge 登录选择走（2026-10-07 报障：载体页在 Edge 里无感验证失败，系统默认浏览器是 Chrome）；登录流（API 层 `zcodeLogin`）仍传用户当次选择，仅此后台路径固定功能上线前的旧行为。回归 `TestZcodeOpenURLPinsDefaultBrowser`（反向验证过）。③ 渠道级余额合计供 Monitor 页使用（§6.9）：新增 `internal/jethub/balance_summary.go::Manager.BalanceSummaryOf` —— 遍历**启用且有凭据**的账号，经 `balanceForAccount` 单点分发到 12 个渠道余额实现，按**归一单位**（`token` / 其余含 `credit`·`credits`·「积分」→`credit`）分组求和；读取失败的账号只记 `failedCount`、**不进合计也不画成 0**；`%`（gemini 配额窗口）与「通道」（opencode 可用性）不可累加故整体跳过。缓存成功 120s / **全失败** 15s，「一个能查的账号都没有」的空轮次**不入缓存**（登录是先落账号后落凭据，缓存它会让读数空白两分钟）；`InvalidateBalanceSummary` 由账号/凭据四类变更在**取状态锁之前**调用（`balanceMu` 与 `m.mu` 不得嵌套）。新端点 `GET /api/jethub/balances`（`internal/api/jethub/balances.go`；⚠️ 路径**不叫** `/balance` —— 那个形状被 `balance_capability_test.go` 当逐账号端点枚举）。Monitor 侧见 `web/static/monitor/monitor_quota.js` 的 Provider 列读数（小两号）。
（同轮 R5 其余子项——buddy 14003 分流、只换号不写冷却、失效模型剔除、codearts 输出上限、cline 兜底表——见下一条。）

## 2026-10-07 — R5 上游同步第五步：已失效模型的运行时实证剔除

**上游事实**（ref `f8748fa`）：用户选中 cline 的 `cline-free/deepseek-v4.1-flash`，每轮
`model not found HTTP_404`，而列表里它仍标着「免费」。根因是各 provider 的兜底模型表是
**编译期快照**，上游下架模型时它不会自己变。

**为什么不能改成「远端目录比对」**：那个判据只在远端**完整权威**时成立。本端三类情况：
cline 可用（本端用 R3-2/R5 的手工表同步代替）、buddy/workbuddy **已知残缺**（目录比对会删掉
可用模型）、qoder/qodercn 无端点。⇒ 唯一跨 provider 安全的判据是**阳性证据**。

**实现**：
- `internal/jethub/deadmodels.go`（新）：判据（6 条正例正则 + 13 条排除词）+ 独立文档
  `{jethubDir}/dead-models.json`（原子写）+ TTL 30 天（`TINYLAB_DEAD_MODEL_TTL_DAYS`
  覆盖，`0`=永不过期）+ 损坏文件退化为**空表**。
- `internal/proxy/interfaces.go`：`ModelGoneReporter` 可选钩子（proxy 不 import jethub）。
- `internal/proxy/retry.go`：`handleUpstreamError` 上报原始错误文案（判据由 owner 自己守）。
- `internal/proxy/forward_retry.go`：**成功路径清除**（模型答 2xx ⇒ 记录作废）。
- 两个出口过滤：`bridge.go::SyncKeys`（注册表模型表）+ `api/jethub/register.go::listModels`
  （面板列表）。⚠️ 过滤用**新建切片**而非 `models[:0]` —— 上游 ModelFilter 可能返回产品表
  子切片，原地写会污染产品表。

**判据为什么必须保守**（误判代价不对称：可用模型被藏且用户**无法自行恢复**）：反例组数
（21）多于正例组（12）；**刻意不收「不可用」**（账号类报错也这么说）；「模型」与「不存在」
之间的窗口放宽到 32 字符以容纳整个 model id。

**反向验证（三处，都实做）**：
1. `isModelGoneError` 强制 false ⇒ 3 条用例变红。
2. 上报钩子强制不命中 ⇒ `TestForwardWithRetry_ReportsModelGoneOn404` 变红。
3. 成功清除钩子强制不命中 ⇒ `TestForwardWithRetry_ForgetsModelGoneOnSuccess` 变红。

验收：`go build`/`go vet` 干净；全量 `go test ./internal/...` 通过。

## 2026-10-07 — R5 上游同步第三步：buddy 模型饱和 14003 与账号额度限流分流

**上游事实**（ref `29a42ea`，逐字来自 `git show`）：buddy 的模型饱和业务码 `14003` 也是
**HTTP 429**，报文自证是模型级 —— `actions: ["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]`，
**没有**换号选项。

**本端缺陷**（同型原样存在）：buddy 族原本没有响应判据层（`buddy_augment.go` 只改请求头），
于是 14003 落进代理的通用 429 分支 ⇒ 对**每个**账号写一条兜底冷却标记并换号 ⇒ 一个模型级
信号把整个账号池逐个锁死。上游实测：4 个互不相干的腾讯 uid 在 20 秒内全部被写 `space-bunny`
标记，解禁时刻全是「写入 + 兜底 1 小时」（服务端根本没给时刻）。

**实现**：
- `internal/jethub/buddy_response.go`（新文件）：`buddyIsModelSaturation`（业务码 `14003`
  数字/字符串两形态 + 四条**窄**文案；泛词不认、`status<400` 一律不认文案）
  + `buddyInterceptResponse`（只在 `status>=400` 时读正文；非饱和错误**把正文还回**
  `resp.Body` 交给通用分类，`6004` 行为不得回退）。
- `internal/upstreamerr/upstreamerr.go`：新增 `ModelSaturationError`（中性叶子包，
  与 `QueueRetryError`/`BillingLockError` 同款理由）。
- `internal/proxy/forward_retry.go`：新增同 Key 等待重试分支（`maxSaturationRetries=2`，
  2s→4s），**先于** `BillingLockError` 判 —— **不写锁、不换号、不进排除集**；用尽报 429
  且文案指向「换模型」。`internal/proxy/interfaces.go` 补别名与接口契约。
- `internal/jethub/qoder_adapter.go`：分派 buddy/workbuddy。

**反向验证（两条，都实做）**：
1. `buddyIsModelSaturation` 强制返回 false ⇒ 4 条用例变红。
2. `forward_retry.go` 的 `ModelSaturationError` 分支强制不命中 ⇒ 失败输出确凿打印
   `网络错误（模型 … 饱和）→ 退避后切换` + `no available keys … 502` —— 即修复前的
   整池锁死形态，不是同义反复。

验收：`go build`/`go vet` 干净；全量 `go test ./internal/...` 通过。

## 2026-10-07 — R5 上游同步第一步：qoder 心跳帧 + codearts 上限集合 + cline 兜底表

三处上游事实落地（同一轮 R5 分诊，逐条来自 `git show <sha>` 实测，非推测）：

1. **qoder 信封内层帧改 JSON 结构三态分类**（ref `1846449` / issue IKJOZ8）。
   本端 `internal/jethub/qoder_envelope.go` 与上游修复前**逐字同构**
   （`!strings.Contains(inner, "\"choices\"")` 即判业务错误），两个方向相反的缺陷都在：
   ① `body: null` 序列化成 `null` → 不含 choices → **心跳帧被当业务错误**
   （模型正常回完内容却报失败，且该类错误可重试 ⇒ 白重发整轮对话）；
   ② 错误文案里恰好含 `"choices"` 的帧被当正常帧**静默透传**。
   同型第三处是本端自己发现的：`usage`-only 帧（`stream_options.include_usage` 的末帧）
   也被误判成错误。
   - 新增 `qoderClassifyInner`（chunk / error / heartbeat 三态）替代两处字符串嗅探：
     `qoderTransformSSELine`（心跳**整帧丢弃**，不透传 `data: null`）、`qoderFlushSSELine`、
     以及 `qoder_adapter.go` 的 peek 首帧分类 —— **HTTP 层与 SSE 层现在共用同一处判据**。
   - 回归 `TestQoderHeartbeatFrameIsNotAnError` + `TestQoderHeartbeatFrameAtFlushIsDropped`。
     **反向验证已做**：判据改回子串嗅探后两条立刻变红，并复现出原始缺陷形态
     `data: {"message":"null","type":"model_error"}`。
2. **codearts 输出上限收敛集合扩展**（ref `5334547`，R1-4 的增量对齐）。
   `codeartsCappedModel` 由 `GLM-5.2`/`deepseek-v4-flash`/`deepseek-v4-pro` 扩至加入
   `glm-5.3-flash` 与 `deepseek-v4.1-flash`（cap 恒 65536）。`TestCodeartsClampMaxTokens`
   改为逐条锁定该集合（摘掉任一条目即变红）。
3. **cline 兜底表删除已下架的 `cline-free/deepseek-v4.1-flash`**（ref `b0352fc`）。
   上游 2026-10-05 复测 `free` 数组 4→3，该模型直连回 404 `model not found`；
   本端静态表留着它 = 面板上一个「看着免费、一点就 404」的条目，且**重启也不会自愈**
   （本端表是静态的）。与 R3-2 删 `gemini-3.8-flash` 同型。
   上游同提交还修了 `mergeClineModels` 的无条件兜底表并入 —— **该机制本端不存在**
   （模型列表纯静态、无远端合并层），其判据（用 `remote.entries.length > 0` 而非
   `freeIds.length > 0`）记入同步文档 R1-8 追加的四条远端目录纪律。

验收：`go build ./...` + `go vet ./...` 干净；全量 `go test ./internal/...` 通过；
`node web/jethub.test.js` 27 项全绿。

## 2026-10-07 — R5：整体移除 Gemini Code Assist 渠道（§6.8）

- **触发**：`git push` 被 GitHub Push Protection 拒绝（`GH013`）。报错点名两处，都是
  `internal/jethub/gemini_oauth.go` 的常量：第 33 行 `geminiDefaultClientID`、第 36 行
  `geminiDefaultClientSecret`。命中的提交是 `f2a6fee`（R3-3 引入该渠道）与 `e294d4e`
  （同文件再动）。
- **为什么不是「误报」**：这两个常量确实是 R3-3 从 ref 逐字移植的「上游 Cloud Code 客户端
  固有公开常量」（原生应用公开安装的 secret），注释里已写明。但 GitHub 的规则按模式匹配，
  不接受该解释，且**仓库规则不允许任何 secret 形状的字符串进入 main**。
- **决定（用户，2026-10-07）**：不走 unblock 流程、不改走环境变量，**直接删除整个渠道**；
  并要求**此后不再同步该渠道的上游数据**（同步文档 §5 新增永久排除条目）。
- **删除范围**（`git grep -i gemini` 已确认 Free Hub 面零残留）：
  - 源码：`internal/jethub/gemini{,_convert,_credits,_oauth,_test}.go`、`internal/api/jethub/gemini.go`。
  - 接线：`manager.go::defaultProviders`、`products.go`（product 表 + `SetAugmenter`）、
    `qoder_adapter.go::InterceptResponse` 分派、`register.go::RegisterGemini` 与
    `rateLimitExemptProviders` 条目。
  - 前端：配额单位（`%`）整条渲染链（`__jethubCreditLabel` 的 `%` 档、`__jethubFormatQuota`、
    `__jethubQuotaLine`、`__jethubQuotaDetail`）、账号规格行（`extra.accountTier` 的 DOM 与
    更新逻辑）、四个 i18n 键（`freeHubUnitQuota`/`freeHubAccountTier`/`freeHubCreditRemaining`/
    `freeHubCreditResetsAt`，en+cn 双字典）。
  - 后端聚合：`internal/api/jethub/balances.go` 的 `nonAggregatableProviders` 表（唯一用途是
    为该渠道的百分比窗口省一次必然被丢弃的请求）。
- **保留**：`balance_summary.go::normalizedBalanceUnit` 的 `%`/「通道」不可累加守卫（同时守着
  opencode 的「通道」，且是将来窗口制渠道的第一道防线）；代理核心的 Gemini
  `thought_signature` 回填（`internal/proxy/signature_cache.go` 等，服务用户**自建**的
  `generativelanguage.googleapis.com/v1beta/openai` Provider，与 Free Hub 渠道无关）。
- **provider 数 14 → 13**；`TestProvidersMetadata` 新增「gemini 必须不再是已知渠道」的反向断言。
- **验收**：`go build ./...` + `go vet ./...` + 全量 `go test ./internal/...` 全绿；
  `node web/jethub.test.js` 全绿（27 项）。

## 2026-10-07 — zcode 领取载体页不再继承登录浏览器偏好（§6.7）

- 报障：zcode 渠道领取积分不可用——弹出的浏览器窗口打开的是本地载体页
  （`/api/jethub/zcode/carrier?token=…`），页面停在阿里云无感验证报错；而 DSH
  插件里领取正常，且 DSH 领取后 tinylab 再点领取就不再弹窗。
- 排查结论（用户猜测「Edge 上没有 zcode 登录态」只对了一半）：
  - **对的一半**：`zcodeOpenURL`（`internal/jethub/zcode.go`）传的是零值
    `OpenOptions{}`，被 `normalizeOpenOptions`（login_open.go）用「记住的
    +新建账号 偏好」补齐。运行时实例 `C:\Tools\TinyLab` 的
    `jethub/login-open.json` 实测为 `{browser: edge, session: shared}`
    （2026-10-05 用户给某渠道登录时选了 Edge；系统默认浏览器是 Chrome）——
    载体页因此跟着落到 Edge。
  - **错的一半**：失败与登录态无关。载体页不含任何凭据（领取 JWT 在服务端），
    反证：DSH 内部载体用全新无 cookie 的内存 partition 也能产出 param。Edge 里
    卡住的是阿里云无感验证本身（浏览器差异：代理路由/风控指纹）——「DSH 领取后
    tinylab 不再报错」只是短路：`ZcodeClaimDaily` 先查可领活动，DSH 已把今天的
    领掉 ⇒ 0 个 plan ⇒ 直接返回、走不到开浏览器那步（按日结算，跨渠道共享）。
- 修复：`zcodeOpenURL` 显式固定 `OpenOptions{Browser: BrowserDefault,
  Session: SessionShared}`（= §3.9 功能上线前的旧行为：shell → 系统默认浏览器 +
  共享会话）。登录流（API 层 `zcodeLogin`）仍传用户当次选择，**仅此后台路径**
  脱离「登录浏览器偏好」。`login-open.json` 里的 Edge 偏好保留不动（它只影响
  登录弹窗的默认勾选）。
- 回归：`TestZcodeOpenURLPinsDefaultBrowser`（internal/jethub/zcode_test.go）——
  先 `SetLoginOpenPrefs({edge, shared})` 模拟报障现场，断言 `zcodeOpenURL` 到达
  opener 的选项恒为显式 default+shared。反向验证过：把实现临时改回零值 ⇒ 用例红
  （`got {Browser: Session:}`，偏好泄漏被当场抓住）。
- 顺带：`zcode_test.go` 两处改动前就存在的连续空行（gofmt 报警）清理。

## 2026-10-06 — 渠道级余额合计（Monitor 页 Provider 列读数，§6.9）

- 需求（用户）：对齐 DSH 插件输入区那枚用量徽标（`ZCode (智谱) • 94.54MToken`）——在 TinyLab
  Monitor 页 QuotaMonitor 的 **Provider 列**追加信息，**小两号字体**；积分渠道显示积分数量
  （`3000`），token 额度加 M（`30.09M`），**不显示「Token」字样**。四个口径经用户确认：每行都
  显示、gemini 的 `%` 跳过、混合单位不考虑、60s 前端 + 120s 后端。
- 新增 `internal/jethub/balance_summary.go`：`BalanceSummaryOf(ctx, provider)` → 遍历**启用且有
  凭据**的账号 → `balanceForAccount` **单点分发**（ref `qoderFamily` 注册表同思路：cline 多返
  raw、opencode 多返 notice、zcode 桶结果经新抽出的 `zcodeBalanceToCredit` 映射，签名差异全在
  这一处收敛）→ `normalizedBalanceUnit` 归一到 `token`/`credit` 两类分组求和；`%` 与「通道」
  返回 false（不可累加）；失败账号只记 `failedCount`。
- **TTL 两档 + 一条非显然规则**：成功 120s / **全失败** 15s（ref 徽标宿主侧同款）；但
  「一个能查的账号都没有」的空轮次**不入缓存** —— 登录流程是「先落账号、后落凭据」，缓存它
  会让刚登录成功的渠道在 Monitor 上空白两分钟。反向验证：把该早退改成 `&& false` ⇒
  `TestBalanceSummaryCredentialArrivalShowsImmediately` 变红（该用例**绕过 SetCredential**
  直接写 credentials map，专门排除「靠缓存失效兜住」这条旁路）。
- 缓存失效：`InvalidateBalanceSummary` 挂 `AddAccount`/`deleteAccountEntry`/`UpdateAccount`/
  `SetCredential`，**一律在取 `m.mu` 之前**调用（`balanceMu` 与 `m.mu` 不得嵌套；锁序写进
  函数的文档注释）。
- 新增 `internal/api/jethub/balances.go`：`GET /api/jethub/balances`。⚠️ 路径刻意**不叫
  `/balance`** —— `balance_capability_test.go` 的 `balanceRoutes()` 按 `/balance` 后缀枚举
  「逐账号额度端点」，混进去会让能力位守卫把合计端点误读成一个渠道。`nonAggregatableProviders`
  跳过 gemini（**不查**，省一次必然被丢弃的上游请求；聚合层的 `normalizedBalanceUnit` 是第二层
  防线）；`Groups` 为空的渠道整体不出现在响应里；30s 总超时（卡住的上游不会挂死浏览器请求，
  超时后本轮按失败缓存 15s）。
- 前端 `web/static/monitor/monitor_quota.js`：Provider 单元格加 `<span class="quota-provider-balance">`
  空槽（`:empty` 隐藏）；`jethubProviderIdOf` 经 `/api/providers` 的 `apiType === 'jethub'`
  判定并把 `jethub-zcode` 还原成短 id —— **绝不按名字猜**（用户手建的普通 provider 也可能叫
  「ZCode」，但它没有 Free Hub 账号池）；`providerBalanceTick` **搭既有 1s 计数节奏**（复用
  `lockCountdownInterval`，`stopUsageRefresh` 已负责清理），内部 60s 节流；失败**静默**并保留
  上一次读数（Free Hub 未接线时该路由 404，与服务器不可达同款处理）。
- 口径单一来源：读数格式化**复用** `jethub.js` 的 `__jethubFormatUnits`，不在 Monitor 里再写
  一份 M/K（否则 token 的两位小数必然漂移）。CSS 用 `--font-badge`（比 `--font-base` 小 2.5px，
  即用户说的「小两号」，且随全局字号档位缩放）+ `:empty{display:none}`。
- 回归：`internal/jethub/balance_summary_test.go`(10：聚合/失败不画 0/两档 TTL/空轮次不缓存/
  单位归一张量/zcode×1000/JSON 契约/失效重查/no-accounts) + `internal/api/jethub/balances_test.go`
  (2：路由与守门 + opencode「通道」与 gemini 必不出现) + `web/monitor-quota-balance.test.js`
  (11：把 jethub.js 的**真实**格式化函数按花括号配对抽进 VM 沙箱，端到端断言 `30.09M`/`94.54M`/
  `1.00M`/`3000`/`2066.84`，另含混合单位只显示首组而 title 带全部组、失败账号只在 tooltip、
  旧读数被清空，以及 CSS/i18n/脚本加载顺序静态守卫）。已做反向验证：单位映射改错 ⇒ 3 条红。
- 验证：`go vet ./...` 干净 + 全量 `go test ./...` 绿（含 `internal/jethub` 56s）+ `node
  web/monitor-quota-balance.test.js` 10/10 + `node web/jethub.test.js` 全绿。

## 2026-10-05 — F-05 桥接出站头空白基底（proxy §7.1a 契约变更）

- proxy 侧契约变更落点见 `docs/changelog/proxy-architecture.md` 同日条目；对 jethub 的影响：`Augment`/`Customize` 收到的 `r.Header` 为空白基底，写入即出站集合。
- 移除 12 处 augmenter `for k := range r.Header { Del(k) }` 全删循环（buddy/cline/codearts/gemini_convert/lobsterai/loomy/minimax/opencode/qoder_adapter/raccoon/trae/zcode）。
- 更新 5 处旧契约测试断言（buddy_test X-Leftover、cline_test X-Leftover、zcode_convert_test X-Junk、opencode_test evil-client、qoder_adapter_test X-Client-Noise）——wholesale-replacement 保证已上移 proxy 框架层，由 `proxy/bridge_headers_test.go` 承接。
- jethub 套件全绿（57s）。

> 本文件存放 `docs/jethub-architecture.md` 顶部「最后核对」行的历史流水与变更过程叙述（最新在上）。正文只保留当前态事实。

## 2026-10-05 · 账号卡片信息全量对齐（R4-0，P0–P2）+ 删除 ZCode 本机凭据路径（R4-1）

**背景（用户报障原文）**：「Zcode，DSH 里会显示限额重置的信息和准确时间，Tinylab 里不会显示」「Minimax, DSH 里会显示 credits 数字，Tinylab 里不会显示（不止这一个，还有不少也都不显示 credits 数字）」，并要求与 DSH 面板完成**完整的信息对齐**。逐项读完 ref 的 `plugin-src/client/{jet-hub,credits-format,credit-expiry,quota-format,credits-capabilities}.js` 与本端 `web/static/jethub.js` + `internal/jethub/*` 后，归因到**两条根因**，其余是它们的下游：

1. **`ProviderMeta.HasBalance` 与实现脱节**：minimax / raccoon / trae / cline 四家的余额后端（`MinimaxBalance`/`RaccoonBalance`/`TraeBalance`/`ClineBalance`）与 `/balance` 路由**早就存在**，但能力位是 false。该位是前端渲染额度行与「刷新积分」按钮的**唯一**门控，且漏登记**不会报错** —— 表现为「这几个渠道没有积分」。opencode 则是真的没有实现（Zen 没有公开余额 API）。
2. **全仓没有任何代码写账号级限流标记**：`Manager.UpdateModelRateLimit` 的唯一调用点是 trae 的内部记账键 `__trae_checkin_gen__`，而前端按 `__` 前缀主动过滤掉 ⇒ 卡片上的「限额重置」行**对所有渠道恒为空**。所有额度/限流错误都走 `BillingLockError` → rotation 层的 key 冷却，与 jethub 的账号标记是两套存储。这就是 ZCode 那条报障的真正根因（不是 zcode 特有的问题）。

**实现要点（按批次）：**

- **P0**：四家 `HasBalance` 补正 + `internal/api/jethub/balance_capability_test.go` 的**双向**守卫（路由有 ⇒ 标志必须有；标志有 ⇒ 路由必须有；新增 provider 自动纳入，因为它是 `chi.Walk` 枚举而不是手写表）。单位标签三态（`token`→Token / `%`→额度 / 其余→积分 —— ref `unitLabel`）—— 标签**随余额回填**，因为渲染卡片时还不知道单位。Gemini 主行改成**逐窗口百分比**（`total = 两窗口平均` 是上游根本不存在的数，ref 已因此报障并修掉；本端 `geminiBalanceOf` 的均值保留为兜底）。gemini 移入 `rateLimitExemptProviders`（配额窗口制，重测/重置只剩白烧配额与「放回池里再撞一次」两种副作用）。
- **额外项**：opencode「通道可用性」额度行 —— `OpencodeChannelBalance` 全部来自**本地状态**（`enabled` + `modelRateLimits`），**零网络请求**；`Total` = 可用通道数（单位「通道」），限额中的通道数放进 `ExpiredTotal`（面板显示「另有 N 已失效」，与其它渠道口径一致）；API 的 200 响应里额外带 `error`（「已停用」/「限额中，<时刻> 恢复」）——那是**状态**而不是失败，前端必须能同时显示。
- **P1（限额重置）**：`rotation.Selector.SetRateLimitObserver` 注入式观察者（rotation **不依赖** jethub，与 `SetStateHook` 同款分层），四条写锁路径（`MarkRateLimited`/`MarkDailyQuotaLocked`/`MarkBalanceLocked`/`MarkNIM429`）每次写 key×model 锁都通知；组合根 `internal/app/app.go` 把它映射到 `Manager.UpdateModelRateLimit`（非 Free Hub 的 key 会拿到 `ErrNotFound`，那是正常路径）。写入规则**只延长不缩短**（同一次限流会在多条路径上重复上报，后到的不能把解禁时刻往前提）；空模型名拒收（会落下一个 UI 上「没有模型名」的 chip）。另补：重测仍受限时把上游给的**新**解禁时刻写回（`parseRateLimitResetTime`，中英两种句式 + **捕获**时区，不写死 UTC+8）—— 限流是滚动窗口，不更新的话旧时刻一过期，卡片那一行就会凭空消失，出现「重测说仍受限、卡片却一条都不显示」的矛盾。
- **P1（额度行的其余信息）**：`CreditPackage` 新增 `deductionEndTime`/`expiresAt`/`cycleEndTime`，`CreditBalance` 新增 `expiredTotal`；各 provider 把原先**解析出来又丢掉**的字段填上（buddy 的 `DeductionEndTime`、lobsterai 的 `expiresAt`、qoder 专用包的 `expiresAt`、zcode 桶的 `expires_at`（**秒**→毫秒）、gemini 窗口的 `resetTime`）。trae 的余额**整条重写**：请求体必须是 `{"require_usage":true,"req_source":2}`、必须用**完整客户端头**（`traeCheckinHeaders`，此前是零调用的死代码）、余额在**顶层** `user_entitlement_pack_list`（旧版猜的 `data.totalCredits/creditRemain/remain` 三个键都不存在）、到期是**秒级** `expire_time`。raccoon 同样修正：字段是 `available_points`（旧版读的 `balance` 并不存在），四个池分开建包。前端补齐临时/长期分桶、池名分桶、资源包 hover 明细（只用还能用的包、最快到期在上、最多 12 行 + 汇总）、失效额度、账号规格行。
- **P2**：账号**拖拽排序 = 选号优先级** —— 池内顺序本来就是优先级，但 `SyncKeys` 里一句 `sort.Slice(keys, …ID < …ID)` 把它按 ID 字典序重排，于是「拖到第一位」对路由层**完全无效**；改为按池内位置分配 `Priority`（匿名通道恒殿后，与卡片上显示的 `rotationOrder` 用**同一套编号**），并新增 `Manager.ReorderAccounts`（**严格集合相等**校验）+ `PUT /providers/{provider}/accounts/order`（改完 SyncKeys）。opencode 指纹轮换（账号条目的代次为**权威**、凭据里的只是下限 —— ref 明确记的静默失效形态是「代次涨了 project id 却不变」）。loomy 的新手任务按钮（后端早有、前端零入口）、raccoon 的一次性奖励文案（`claimKind`）、opencode 匿名标记（判据用**凭据内容**而不是 id 前缀 —— 本端 id 形如 `{provider}-{8hex}`，ref 的 `opencode-anon-` 前缀判据在这里永不命中）、账号名/手机号派生显示、额度失败时把原因放进 title。
- **R4-1（用户决定：删除）**：整体删除「读本机官方客户端凭据」旁路（上游 `2e8bb86` 以安全理由删除同一条路）。删除范围：凭据文件解密（`enc:v1:` / 派生密钥 / `ZCODE_CREDENTIAL_SECRET`）、`user_info` 解析、`telemetry-state.json` 读取、**官方安装目录的版本清单探测**（同一条红线）、`ZcodeImportLocalAccount`、`POST /api/jethub/zcode/import`、以及两个**零调用的** coding-plan 死常量。守卫是 `zcode_local_read_test.go` 的**源码字面量扫描**（断言某个函数不存在，对新写的读取函数无效；判据串在测试里拼接，避免守卫自己命中自己；反向验证时只在注释里留一个文件名就变红）+ `TestZcodeImportRouteIsGone`（在路由层锁「不存在」）。
- **R4-2**：订正两条旧说法 —— 3012 的 HTTP 状态是 **405 不是 403**、日期块**不是**判据。本端的 zcode 分类只看响应体业务码，故**功能免疫**，仅改注释；`src/zcode-identity.ts` 本轮只改注释（逐行过滤非注释增删 = 空）⇒ 身份块文本与 sha256/长度无需重新提取。

**已知取舍与未做项：**

- **opencode per-account 出口代理已补做**（同日，用户要求全量对齐）：原先按 R1-7 记为「有意差异」（本端推理出站由 proxy 层按 **provider** 级 `UseProxy` 决定，没有 key 级出口的概念）。做法是把它做成**纯增量**：`config.Key.Proxy` 默认为空 ⇒ 未设代理的 provider/key 走原路径逐字节不变；`proxy.Handler.keyProxyClientsFor` 按代理串缓存独立 transport（连接池按出口隔离）；`upstreamClientFor`/`streamClientFor` 加 per-key 分支且**优先于 provider 级**；`bridge.SyncKeys` 把账号的 `opencodeProxy` 写进 key；探针也改走 `httpClientForAccount`（从别的出口探测会得到与真实流量不同源的结论）。判据见 §3.10 与 `perkey_proxy_test.go` 的两条断言 —— 其中「**没设的不绕**」才是这个能力的**安全边界**。
- ref 的「测试」按钮（无条件探活，仅 gemini）未搬：本端探针复用代理管线，没有对应的独立端点。
- **`windowDays` 目前只用于展示分桶**：「锁定永久积分」的**选号侧**语义（只消耗近期作废的积分）仍未移植（R1-9 记录在案），`PermanentLocks` 只落了 provider 级开关的持久化。

**验证：** `go vet ./...` 干净 + 全量 `go test ./...` 全绿 + `node web/jethub.test.js` 27 项全绿。关键项都做了**反向验证**（把修复改回去必须变红）：能力位守卫、观察者通知、重测写回时刻、指纹轮换、本机读取守卫。前方证据与逐项根因另见 [`../jethub-upstream-sync.md`](../jethub-upstream-sync.md) §6 R4-0/R4-1/R4-2。

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
