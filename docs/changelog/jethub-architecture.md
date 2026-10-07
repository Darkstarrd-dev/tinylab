# jethub-architecture.md — 变更日志

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
