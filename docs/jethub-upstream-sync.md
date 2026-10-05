# Free Hub 上游同步计划（dsh-codearts-auth → TinyLab，周期性）

> **文档性质：** 常驻流程文档（不是一次性实施计划，**不归档、不置「已完成」**）。每轮同步在 §7 追加一行日志；待办在 §6 逐条勾销。
>
> **上游：** `ref/deepseek-harness-codearts`（gitignored 只读副本，允许 `git fetch`/`git checkout` 同步操作，**禁止手工编辑**），origin `https://gitee.com/iJetLi/deepseek-harness-codearts.git`。
>
> **当前 pin：** `ff5e37d`（2026-10-04，R3 分诊基线；前序 pin：R1/R2 `e06283c`、初版 `cecf376`——**pin 只影响后续同步的判据来源，已移植实现的语义不随 pin 移动**）。
>
> **本轮侦察（2026-10-04，R3）：** master `e06283c` → `ff5e37d`：**85 commits / 150 文件 / +31,751 −1,453**（44 个提交触 `src/`）。R1 时的未合并分支 `feat/opencode-provider` 已合入 master（`1ee3f7e`），其后有 5 个 opencode 修复（思考档位/能力表/contextWindow，触 UI 与远端能力链，架构无关不搬，见 §5）。master 新增 **Gemini Code Assist provider**（`e061b21`，第 14 家，~4,600 行 TS + 172 例单测）与 **zcode 双通道 + zai 渠道**。新 tag `0.2.0-rc.2`（= `530c747`，R3 范围内）。→ 本轮待办见 §6 R3。
>
> **关联：** 架构基线与变更维护清单 [`jethub-architecture.md`](jethub-architecture.md)；源码锚点 PROJECT_MAP §13n / §10.28 / §18.2 / §22 / §24。

---

## 1. 目的与触发

把上游**普遍有价值**的更新带入本项目——鉴权/登录/续期/凭据语义、新增 provider、协议与错误判据、模型目录事实、积分/签到语义——同时明确挡掉只对 DSH 宿主/插件面板有意义的内容（避免每轮重复评估）。

**触发条件（满足其一即执行一轮）：**

1. **例行：每两周一次**（上游提交集中在工作日，两周可覆盖一次发布节奏）。
2. **报障先行：** 本项目出现 provider 相关故障（401 / 空回复 / 额度不涨 / 模型列表缺项）时，先查上游是否已有修复提交（`git log --oneline <pin>..origin/master --grep=关键词`），避免重复造轮子；上游已修则把该提交直接升为本轮最高优先级待办。
3. **新分支 / 新 tag：** `git ls-remote` 出现 `feat/*`（provider 新增常先在分支出现）或 `0.x.y-rc.*` / `nightly-*` tag。
4. **上游合并 provider 分支后**（把分支待办转成 master 待办）。

---

## 2. 判定原则（搬什么 / 不搬什么）

### 2.1 搬（普遍价值）

| 类别 | 本轮证据（示例） |
|---|---|
| 鉴权 / 登录 / 续期 / 凭据语义 | codearts 续期终态判据修正（`cf5edab`：InvalidDPoPHeader 移出终态；refreshable 单向门） |
| 新增 provider（可脱离 DSH 运行） | OpenCode Zen（分支 `feat/opencode-provider`） |
| 协议 / 错误判据修复 | codearts 4004.200 去头重试（`3bf2be7`）；minimax tool 配对（`c74e0c2`） |
| 模型目录事实 | codearts max_tokens 上限（`916c647`/`da0a2ad`）；cline models.dev 并表（`caf675e`） |
| 积分 / 签到语义 | qoder 跨日界记账（`1b65a5c` B1） |
| 参考设计（未来实现的正确形态） | 远端目录 gate（`0ca8256` `remote-catalog-gate.ts`） |

### 2.2 不搬（DSH 宿主 / 插件面板专属）

| 类别 | 例子 |
|---|---|
| cordis / dsh-llm / dsh-credentials / schemastery 接线 | 各 `register*` 兼容层 |
| React / 客户端面板 | 用量徽标、供应商开关、模型分组、订阅额度弹窗、请求记录、自动签到 UI |
| 插件本机出口 | `src/openai-gateway/*`（TinyLab 本体即 OpenAI 出口） |
| 桌面窗口 / 浏览器自动化 | zcode captcha 载体、外挂 Chromium 管理 |
| DSH 模型选择器声明 | 设置页 provider 注册（`aac128d`/`753b9e0`） |

### 2.3 三条硬判据（全否 ⇒ 不搬，记入 §5）

1. **可独立运行**：脱离 DSH 宿主（无 Electron / 桌面窗口 / cordis）能否在 Go 侧跑通？
2. **事实 vs 宿主行为**：是协议 / 服务端事实，还是宿主（DSH / 面板）行为？
3. **用户可见损失**：不做会不会造成空回复、额度漏领、账号被误标死等用户可见问题？

---

## 3. 每轮 SOP（命令级）

### S1 拉取与盘点

```powershell
cd ref/deepseek-harness-codearts
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --tags
git log --date=short --pretty='%h %ad %s' <pin>..origin/master   # 提交清单
git diff --stat <pin>..origin/master                             # 规模
git diff --name-status <pin>..origin/master -- src/              # 源码面
git ls-remote origin refs/heads/*                                # 新分支（provider 新增常在分支）
git log --oneline <pin>..origin/<branch>                         # 分支单独盘点
```

### S2 分诊（逐 commit 三分类：搬 / 不搬 / 待定）

- **重点文件族**：`src/*-adapter.ts`（推理与协议）、`*-auth.ts` / `*-product.ts` / `oauth.ts` / `service.ts`（登录/续期/凭据）、`*-credits.ts` / `credits.ts`（积分）、`models*.ts` / `remote-catalog-gate.ts`（模型目录）、**`AGENTS.md`（实测坑，优先于代码本身）**。
- **上游 `tests/unit/*.spec.ts` 是行为规格**：先读测试再读实现；移植时把用例翻成我们的验收清单。
- merge 提交（`4ce4a6e`/`4a62e84` 等）要按 `git diff <merge>^1 <merge>` 展开，不能只看标题。
- 每条结论落 §6（可搬）或 §5（不搬，附理由）。
- 判据只采信上游注释标「实测」的；推测标「待验证」。

### S3 待办

可搬项写入 §6，每条包含：**上游 commit / ref 文件 → 本项目落点 → 判据与验收**（单测 + 真机或可达性）。

### S4 实施与验证

沿既有纪律：单测（含**反向验证**——把修复改回去必须变红）+ 有账号真机 e2e / 无账号可达性；同一次改动更新 `jethub-architecture.md`（§6 矩阵、变更维护清单、最后核对行）与 PROJECT_MAP（§13n / §10.28 / §24）。

### S5 收口

1. **推进 pin**：`git checkout <新 pin>` + §7 记录 + PROJECT_MAP §22 同步（**pin 语义 = 已分诊完毕**；未实施项以 commit 锚点留在 §6，不阻塞 pin 推进）。
2. §6 未完成项保留（带 commit 锚点，下一轮不重复分诊）。
3. §7 追加日志行；PROJECT_MAP §19/§24 如有结构变化同步。

---

## 4. 同步纪律

- **ref 目录**：允许 `git fetch` / `git checkout`（同步操作）；**禁止手工编辑其文件**。
- **凭据形状变化**（credentials JSON 字段）→ 先评估备份双向兼容（架构 §7）与 `bridge_keys_test.go` 的 Key 提取器；字段名 1:1 是对外契约（原版备份可互导）。
- **新增 provider 落地清单**（对齐现有模式）：product 表（含 `InferURL`，唯一真相源）→ auth/refresh → augment/customize/intercept → credits → 模型表（展示名/倍率）→ API 端点（**每个 `<provider>/status` 必须带 `loginId` 分支**）→ bridge / SyncKeys / Key 提取器 → 路由守卫（`status_login_test.go` 的 `chi.Walk` 枚举自动纳入）→ 前端 `loginModes` / 模型列表 → 文档（架构 §6 矩阵 + PROJECT_MAP §13n/§10.28/§24）。
- 上游的「位置参数陷阱」（新增 provider 破坏 RPC 位置占位，已复发 6 次）对本项目**结构性免疫**：`internal/api/jethub/status_login_test.go` 用 `chi.Walk` 枚举、`web/jethub.test.js` 从 Go 路由声明反推形状——新增 provider 无需补位置占位，但必须补上一行的端点与守卫。
- **不要照抄上游的宿主假设**：上游代码注释里凡涉及 DSH 输入形状（如「一等 tool 消息」）的归一化，先判断我们的进站线协议是否真的会产出该形状，再决定搬不搬（`c74e0c2` 的①形状归一化属 DSH 专属，②配对不变量才是普遍事实）。

---

## 5. 不搬清单（已判定，避免重复评估）

| 主题 | 上游证据 | 不搬理由 |
|---|---|---|
| `src/openai-gateway/*` | `6f352ca` / `e06283c` / `c0b57b6` / `d4ac661` / `916c647` / `da0a2ad` | 插件把 provider 池暴露为 OpenAI 端点供其它客户端调用；TinyLab 本体即代理，无此需求（其中的 provider 事实已拆出为 R1-4） |
| 面板 / 客户端 JS | `badge-*`、`usage-badge`、`jet-hub.js`、`zcode-card.js` 等 | 本项目已有 vanilla Free Hub 面板与等价能力（余额/签到/模型列表/限流标记） |
| 供应商级开关 / 模型分组 / 设置页注册 | `cd12de0` / `5b579ef` / `aac128d` / `753b9e0` / `778b862` | DSH 模型选择器与插件设置页专属 |
| zcode provider 整体 | `19226ca` / `f9a297a` / `d17e813` | ~~不搬~~ **R2 已重估并移植（2026-10-02）**：初版排除的前提（captcha 依赖桌面窗口）已被上游 `19226ca` 推翻 —— **推理不再校验 captcha**（3.14.4 起实测 6/6、8/8 不带验证头 200），只有**领取**强制索要；而领取的载体页在**本地 origin 也可用**（ref 探针记录 127.0.0.1 上 4/4），本端据此用「用户浏览器 + 本地页」实现（§6 R2）。**仍不搬**的只剩：外挂 Chromium 管理、DSH 桌面窗口载体、`plugin-src/client/zcode-card.js` 面板 |
| 自动签到（每日首启 / 状态灯 / 结果常驻） | `f10408c` / `68caef3` / `38ec411` | 保留手动「一键签到」；自动签到属面板行为（其中跨日界记账判据已拆出为 R1-3，排除表模式见 R1-9） |
| 位置参数陷阱修补 | `AGENTS.md`（6 次复发） | 本项目守卫为枚举式，结构性免疫（§4） |
| 备份格式扩展 / RPC 面板类型 | `types.ts` 的 RPC 与面板类型 | 备份兼容已锁定（架构 §7）；RPC 类型不参与本项目 |
| R3：OpenAI Responses 出口（`/v1/responses`）+ 用量口径 + 状态码穿透 + 错误帧门禁 + 腾讯系 system 指纹改写 + reasoning-efforts 对照表 | `c19917a` / `ab80924` / `b7bd789` / `9920f56` / `ff5e37d` / `6507462`（`src/openai-gateway/`） | 上游网关出口行为；TinyLab 本体即代理（`/v1/*` 直通），无网关出口层。其中 9920f56 的教训（流式错误帧 status 必须带状态码门禁，否则 200 被读成成功）已在 R3-1 的判据对齐中吸收 |
| R3：opencode 思考档位 / 远端能力表（models.dev 拉取+缓存）/ contextWindow / 档位 UI | `0774492` / `530c747` / `1960870` / `8b1283a` | R1-7 移植决策已定：档位/能力表价值在 DSH 模型选择器 UI（efforts 下拉、准入校验），TinyLab 无该 UI；图片能力代理本就透传（R1-6 记录）。models.dev 5MB 拉取+磁盘缓存的成本不成比例 |
| R3：loop-guard 思考循环自动续跑 | `afcaafe` / `601a056`（`src/loop-recovery.ts`） | DSH 宿主回合引擎行为；TinyLab 代理不驱动会话回合 |
| R3：gemini 面板族（测试按钮/配额行/昵称/账号卡片） | `0969ce2` / `c2c94db` / `5544417` 等 | 面板 UI；实现 Gemini provider 时（R3-3）再按需取材 |
| R3：zcode 面板/浏览器族（登录渠道弹窗、浏览器探测 darwin 候选链、spawn 守卫、provider-card 槽冲突） | `6b7548b` / `15ccae5`③ / `dc58525` / `b64a9c8` / `e99e30a` | 面板与桌面窗口载体行为 |
| 登录浏览器/会话模式（隐私窗口 / 指定非默认浏览器 / 独立配置目录，2026-10-05） | 无 —— 上游把登录页一律交给宿主（外挂 Chromium + DSH 桌面窗口，即上一行） | **本端自研的本地增强，不是移植对象**：TinyLab 面向同 provider 多账号，而系统默认浏览器的共享登录态会让「新建账号」静默复用已登录账号（账号池只按 `Account.ID` 去重）。判定：上游无等价机制 ⇒ 不搬其实现（外挂 Chromium/桌面载体），只按本端需求实现；将来上游若出现等价机制，按本行锚点重估。落点与真机结论见架构 §3.9 + [`docs/changelog/jethub-architecture.md`](changelog/jethub-architecture.md) |
| R3：zcode 双通道（start-plan/coding-plan）+ zai 渠道（2026-10-04 用户决定不搬） | `0fcd929` / `15ccae5`①② / `6b7548b`（`src/zcode-transport.ts`） | 协议事实但本端无需求方：当前账号均为 start-plan/bigmodel 通道；coding-plan 的 api-key 换取链与 zai 渠道在无订阅账号时不可验证。将来出现 coding-plan/zai 账号时按本行锚点重估 |
| R3：buddy 限流误报「未登录」 | `d77e716`（`src/account-pool.ts`） | 修的是 DSH `resolveCredential` 兜底链的报错语义（空候选→MISSING_CREDENTIAL 误报）；TinyLab 选号在 rotation，空候选语义不同（无此兜底链） |
| R3：AGENTS.md 增补 1,650 行 | `e06283c..ff5e37d` 多个提交 | 宿主实测坑记录；相关事实已随各 R3 条目落入本项目文档 |

---

## 6. 待办与实施记录（R1：pin `cecf376` → `e06283c`；R2：ZCode 重估）

> 分诊记录（2026-10-02）：31 个触 `src/` 的提交逐条归类；merge 提交 `4ce4a6e`（= `0ca8256` 族）/`4a62e84`（= cline 面板族）已展开核对。未深读的提交均为面板 / 测试 / 文档 / zcode 类，归 §5。每条 R1 在实施时先读对应 ref 文件与上游测试，再动手。
>
> 状态：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。**R1-1..R1-7 已于 2026-10-02 实施完毕**（完成项的「上游/现状/落点」行保留为资料行，不再逐条勾选；完成状态以标题 ✅ 与 §7 日志为准）。

### R1-1 codearts：benefit 4004.200 → 去掉 `maas_type` 重试一次 ✅

- [ ] 上游：`3bf2be7` + `284fc33`（`src/llm-adapter.ts`）——积分制账号（无 benefit 包）带 `maas_type: benefit` 会以 **HTTP 200 + SSE `InferHub.4004.200 benefit not found`** 被拒，**同一个模型不带该头可正常出流**；修法：命中该码后去掉头**只重试一次**（`benefitHeaderDropped` 标志）。
- [ ] 本项目现状：`internal/jethub/codearts_response.go:120` 对 4004.200 **显式失败**（换号）——积分制账号对该模型直接不可用，白换号。
- [ ] 落点：`codearts_response.go`（分类新增「去头重试」信号）+ `codearts_augment.go`（maas_type 注入开关）+ 代理重试链（**同 Key、一次性**；机制二选一：① `internal/upstreamerr` 新增类型化信号（与 `QueueRetryError` 同款）② context 标志由 augmenter 读取。实施时定，倾向 ①）。
- [x] 验收：单测（首次带 maas_type → 4004.200 → 去头重发成功，断言第二次请求头无 maas_type；第二次仍 4004.200 → 显式失败带码/文案；非 benefit 模型不受影响）；真机（如有积分制账号）。
  > **实施记录（2026-10-02）**：机制取方案①——`upstreamerr.SameKeyRetryError{Header}` + 回环标记 `RetryDropHeaderMarker`（proxy 重试循环写标记 → codearts augmenter 跳过该头并保留标记 → 拦截器据标记判定「已经试过」）；proxy 侧新 `maxSameKeyRetries=4` 安全上限 + 出站头拷贝跳过标记（永不泄漏上游）。回归：`codearts_response_test.go`（去头重试一次/第二次显式失败/非 benefit 不触发）、`codearts_refresh_test.go`（augmenter 去头 + 标记存活）、`internal/proxy/augmenter_test.go::TestForwardWithRetry_SameKeyRetryDropsHeader`（同 Key 重发/标记可见/不泄漏）。真机待积分制账号。

### R1-2 codearts：续期终态判据 + refreshable 单向门 ✅

- [ ] 上游：`cf5edab`（`src/service.ts` + `src/oauth.ts` + `src/index.ts`）四条——① 终态**只留** `invalid_grant` / `ExpiredRefreshToken`（**`InvalidDPoPHeader` 移出**：它只说明「这一次 DPoP proof 不合格」，与 refresh_token 能否使用无关）；② 调度判据读**凭据材料**（refresh_token + code_verifier + DPoP JWK），池里的 `refreshable` 降级为每轮对账出的**镜像**；③ per-credential **串行队列 + 判终态前重读**（并发消费同一 refresh_token 会「1 成功 N invalid_grant」）；④ 调度器武装门不依赖 `refreshable`（拿可能被误标的布尔决定「要不要启动修误标的机制」是循环依赖）。
- [ ] 本项目现状：`codearts_oauth.go:219-221` 把 `InvalidDPoPHeader` 当终态；`codearts_test.go:89` 反向锁定该行为（需一并改）；`RefreshAllCodeArts`（`codearts_refresh.go:205`）循环内 `if !acc.Refreshable { continue }`——**同款单向门**（当前无 ticker 调用者，缺陷潜伏；API 手动刷新不经此路故未暴露）；无 per-credential 串行（将来调度器 + 手动刷新并发即复现竞态）。
- [ ] 落点：`codearts_oauth.go`、`codearts_refresh.go`、`codearts_test.go`。
- [x] 验收：单测（InvalidDPoPHeader **不**终态且不写 refreshable=false；材料齐全时即使 refreshable=false 也进入续期并自愈；同一凭据并发只发一次请求；真终态不损坏凭据）；反向验证（任一条改回去必须变红）。
  > **实施记录（2026-10-02）**：四条全落（终态集合只留 invalid_grant/ExpiredRefreshToken；`RefreshAllCodeArts` 判据读凭据 + `refreshable` 镜像对账（值变化才写）；`codeartsRefreshLocks`（sync.Map）per-credentialRef 串行 + 锁内重读（在有效期内直接跳过）；判终态前重读——refresh_token 被他处换新则视为已续成功不作废）。**调度器**：`StartRefreshScheduler`（启动首轮 + 30min ticker，`app.go` 以 `shutdownCtx` 启动），窗口 = 到期前 1 小时（ref `REFRESH_LEAD_MS`），到期不可解析 ⇒ 立即。回归 `codearts_refresh_test.go`（9 个）+ `codearts_test.go` 终态判据更新。手动「续期」按钮现在也遵守到期窗口（有效期内点击 = 不烧 token，对齐 ref）。

### R1-3 qoder：跨日界记账（每日活动 10:00 UTC+8 刷新）✅

- [ ] 上游：`1b65a5c` B1（`src/qoder-credits.ts` + `src/credits.ts`）——活动每日 **10:00（UTC+8）** 刷新，**刷新前看到的 CLAIMED 属于昨天**；判 `todayCheckedIn:true` 会让当天额度整天漏领（真实损失 100 Credits/天且用户不可见）。修法：`hasQoderCampaignRefreshedToday`（**算术平移 UTC+8**，不取本机时区）+ 刷新前 CLAIMED 改判 inactive + 文案「今天的每日活动尚未刷新」+ 补领标 `coversToday:false`；状态查询刷新前不谎报已领。
- [ ] 本项目现状：`internal/jethub/qoder_credits.go` **无任何刷新时刻判据**（grep `Utc8|10:00` 零命中）——同一缺陷原样存在。
- [ ] 落点：`qoder_credits.go`（+ `internal/api/jethub/qoder.go` 状态字段 + `web/static/jethub.js` 文案三分：已领 / 未刷新（稍后重试）/ 未开通（去官方客户端））。
- [x] 验收：单测（UTC+8 09:59 vs 10:00 判据、刷新前 CLAIMED 不判已领、补领 coversToday=false、文案不混用）；真机（如有账号，10:00 前后各一次）。
  > **实施记录（2026-10-02）**：`hasQoderCampaignRefreshedToday`（算术平移 UTC+8，复用 `QoderBillingUTCOffsetMS`）+ `ClaimOutcome.CoversToday`（tri-state）+ `NotRefreshedYetHint`；刷新前 CLAIMED ⇒ `inactive` + 「尚未刷新」（**不是**「今天已领取」）；刷新前领取 ⇒ `claimed` + coversToday=false + 「昨日额度」文案。前端 `jethubClaim` 优先显示 `outcome.message`（否则这条判据到不了用户眼前）。回归 `qoder_window_test.go`（3 个）+ 既有 `TestClaimQoderEmptyListIsInactive` 固定时钟到 12:00 UTC+8（否则 00:00–10:00 会假失败）。真机待账号。

### R1-4 codearts：max_tokens 收敛（实测上限）✅

- [ ] 上游：`916c647` + `da0a2ad`（`src/openai-gateway/messages.ts` `normalizeMaxTokens`）——`deepseek-v4-flash|pro` 与 `GLM-5.2` 实测**拒绝 128000，65536 可用**（`min(value, 65536)`）；其它模型不动。
- [ ] 本项目现状：codearts augmenter 不改 body，`max_tokens` 原样透传——用户填 128000 会被上游拒。
- [ ] 落点：`codearts_augment.go`（body 改写，`minimax_convert.go` 有先例）；产品表 `Note` 记录上限事实。
- [x] 验收：单测（128000→65536；65536/32768 不变；其它模型不变；非 codearts provider 不受影响）。⚠️ 该事实来自上游实测，移植注释须标注来源；有账号时补真机复测。
  > **实施记录（2026-10-02）**：`codeartsClampMaxTokens`（两个字段都收敛、无变化时返回原 slice 保持字节级透传）+ augmenter 接入；注释标注 ref 916c647/da0a2ad 来源。回归 `codearts_refresh_test.go`（纯函数 + augmenter 端到端）。真机待账号。

### R1-5 minimax：tool 配对不变量核对（Anthropic 服务端要求）✅

- [ ] 上游：`c74e0c2`（`src/minimax-messages.ts` + `message-shape.ts` + `sse.ts` 的 `resolveToolPairing`）两部分——① 「一等 tool 消息」形状归一化：**DSH 专属输入形状，本项目进站是 OpenAI/Anthropic 线协议，不适用**；② **孤儿剔除 + assistant(tool_use) 与 tool_result 成对提交**：Anthropic 拒绝孤儿 tool_use / tool_result 与错序结果（连续 user、跨 assistant 边界累积、空 assistant 丢锚点三种形态都会 400/2013）——**普遍适用**。
- [ ] 本项目现状：`minimax_convert.go` 有同角色合并（`minimaxAppendMessage`）与 `tool_calls → tool_use` 保留，但**无孤儿剔除**（`tool_use_id` 不存在的 tool_result、无结果的 tool_use 仍会下发）。
- [ ] 落点：`minimax_convert.go` + `minimax_convert_test.go`。
- [x] 验收：单测（孤儿 tool_result / 孤儿 tool_use 剔除；assistant 与其结果成对且结果紧跟其 tool_use 所在 assistant 之后；空 assistant 不丢锚点）；真机（M3.1-Flash-Preview 带工具一轮，如有账号）。
  > **实施记录（2026-10-02）**：`minimaxConvertMessages` 重写为三阶段（解析收集 id → 按 id 配对 → 宿主 assistant 与结果成对装配）；孤儿两侧剔除、同批结果合并进同一条 user、不跨 assistant 边界；保留既有契约（缺 `tool_call_id` 仍显式报错、`call_%d` 合成 id、空名 tool_call 不产出 tool_use）。⚠️ **与 ref 的差异（有意）**：按 id 逐个配对（ref 是「一批里有一个没结果就整批剔除」的批次语义）——Anthropic 的协议判据本就是每个 tool_use 各自要有紧跟的 tool_result，逐个剔除多保留可用上下文；畸形历史（结果早于调用）下移结果到宿主之后而非丢弃整轮。回归 `minimax_convert_test.go`（新增 11 个用例 + 配对不变量断言）。真机待账号。

### R1-6 cline：模型目录增强（models.dev 并表）✅

- [ ] 上游：`caf675e`（`src/cline-models-dev.ts`）——models.dev 并表：补齐 `cline-pass` 缺的 4 条（`kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`）+ 可读名 + **图片能力**（只认 `modalities.input` 含 `image`；cline 两个目录端点都不下发能力字段，只看本地兜底表会把支持图片的模型播报成纯文本）。
- [ ] 本项目现状：cline 只有 5 条免费兜底模型（裸 id、无能力字段）——表在 `internal/jethub/trae_model.go` 的 `clineFallbackModels()`，经 `products.go:93` 注册。
- [ ] 落点：`clineFallbackModels()` 静态表扩充（名字 / 上下文 / 图片能力）。
- [x] 验收：单测（条数与名称对账、图片能力字段、免费判据）。⚠️ models.dev 是第三方目录（非 cline 官方），上游口径「只认 `image` 模态」保持一致；是否需要运行时时拉另议（见 R1-8）。
  > **实施记录（2026-10-02）**：静态表 5 → **23 条**（5 免费 + 18 条 `cline-pass`，快照日期 2026-10-02，逐条与 models.dev `cline-pass` 块 id→(name, limit.context) 对账）；不引入图片能力字段（ModelDef 无该字段，代理本就透传图片——记录在注释里）；`TestModelDisplayNamesMatchReference` 的 cline 期望与不变量同步更新。远端目录仍未实现（R1-8 模式）。

### R1-7 新 provider：OpenCode Zen（分支 `feat/opencode-provider`）✅

- [ ] 上游：分支 tip `7dd3422`（**未合并 master**，且基于较早 master；与 master 差 34 文件 / +4,779）——`src/opencode-*.ts` 7 文件。
- [ ] 上游事实：**API key 粘贴登录**（该插件首家不跳浏览器）；**匿名槽**（字面量 `public`，官方 CLI 同款）+ 账号槽**平权混合池**（免费模型全槽轮换，收费模型只走账号槽）；OpenAI 兼容 `https://opencode.ai/zen/v1/chat/completions` + `/v1/models`；错误按**响应体错误类型名**分类（`FreeUsageLimitError` / `GoUsageLimitError` + `retry-after`，额度错误可能带 400/401/403/429 任一状态码）；指纹头 `x-opencode-project/session/request/client` + UA（project = 40hex sha1 形状、session = `ses_`+12hex+26base62 形状门禁，形状不对 = 403）；per-account proxy（身份 = key + 出口 IP）。
- [ ] 本项目决策点（实施前先定）：① 新增 loginMode `apikey`（前端 modal 粘贴 key，无浏览器/轮询）；② 匿名槽（无凭据）如何进桥接（合成 Key、不进账号池条目）；③ 模型表 14 条（7 条匿名免费 + 7 条付费）。
- [ ] 前置：实施前复查分支是否已合并 master（合并则以 master 为基准并重跑一次 `pin..master` 分诊）。
- [ ] 落点：`internal/jethub/opencode*.go`、`products.go`、`bridge.go`（合成槽）、`internal/api/jethub/opencode.go`、`web/static/jethub.js`、文档（架构 §6 矩阵 + PROJECT_MAP）。
- [x] 验收：单测（槽序列 / 免费模型门禁 / 错误分类 / 指纹形状 / 凭据结构）+ 真机（匿名免费模型一条；付费 key 一条如有）。
  > **实施记录（2026-10-02）**：`internal/jethub/opencode.go` + `opencode_augment.go`（凭据/指纹/门禁/错误分类/SSE 聚合/账号添加）+ `products.go`（`Product.AnonymousKey`/`ModelFilter` 两个可选钩子）+ `bridge.go`（匿名 Key `Priority=100` 殿后 + 可见性过滤）+ API `POST /api/jethub/opencode/login` + 前端 apikey 弹窗（`__jethubApiKeyModal`，含「添加匿名通道」按钮）+ i18n en/cn。**真机验证**：匿名通道 `Bearer public` + 门禁形状对 `big-pickle` 实发 HTTP 200 SSE（curl 与**本端 augmenter 产出**各一次）。⚠️ **与 ref 的有意差异**：① 匿名槽改为**显式按钮**添加（ref 在首次启用自动补；TinyLab 无 per-provider enable 事件，自动写入会在未使用 opencode 的安装制造噪音）② 无 per-account 代理（用 provider 级 Use Proxy）③ 指纹固定 generation=0（无代次轮换 UI）④ session id 按账号稳定（ref 按会话缓存；形状门禁一致）⑤ 付费可见性已实现（无 keyed 账号只列 7 条免费）。回归 `opencode_test.go`（10 个）+ `internal/api/jethub/opencode_test.go`（1 个）+ 前端路由形状守卫自动覆盖新路径。

### R1-8 参考设计：远端模型目录 gate（未来实现用）

- [ ] 上游：`0ca8256`（`src/remote-catalog-gate.ts` + 10 个消费点）——并发去重 + 失败/空结果冷却 + **兜底表不写缓存**（原缺陷：一次瞬时失败让 provider 整个进程生命周期只剩兜底模型）。
- [ ] 本项目现状：模型列表纯静态（架构 §6.3「远端目录未实现」是已知缺口，trae/lobsterai/buddy/cline 四家的倍率只有远端才有）。
- [ ] 本轮动作：**不实施**；作为将来实现远端目录时的正确形态参考（实施时在架构 §6.3 引用本行）。

### R1-9（可选参考）自动签到排除表 / 永久锁选号语义

- [ ] 上游：`f10408c` / `1b65a5c` B2（有代价的 provider 须在**调用前**排除，事后来不及）/ `71ecbdd`（免费模型不被「锁定永久积分」拦下）。
- [ ] 本项目现状：无自动签到；永久锁未移植选号侧语义（架构 §3.1 已记）。
- [ ] 本轮动作：**不实施**；将来做自动签到 / 永久锁选号时的设计参考。

---

### R2（ZCode provider 重估与移植，2026-10-02）

**触发**：用户报障「缺失了一个 provider：ZCode」—— 初版移植把它整体排除（§5 的原条目）。重估后发现排除前提已失效。

**为什么可以搬（三条硬判据全过）**：

1. **可独立运行**：推理不再需要 captcha（上游 `19226ca`：ZCode 3.14.4 起模型请求不校验，实测 6/6、8/8 不带验证头 200；官方更新说明同口径）；登录是**纯 HTTP** 的 CLI 设备授权流（`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`）；凭据可直接解密官方客户端的 `~/.zcode/v2/credentials.json`。
2. **事实 vs 宿主行为**：3012 身份块/日期块、`output_config.effort`、`X-Device-Mid`、业务码分类（3007/3009/3012/1005/1113/1002）都是**服务端事实**；只有 captcha 产出（外挂 Chromium / DSH 桌面载体）是宿主行为。
3. **用户可见损失**：不搬则整条免费额度通道（GLM-5.3 / GLM-5.3-Flash）不可用。

**移植范围与差异**：

| 面 | 实现 | 与 ref 的差异 |
|---|---|---|
| 推理 | Anthropic Messages 请求构造 + 3012 身份块（`cliPrefix` 42 字符 + stable 2856 UTF-16 码元，逐字内置、sha256 锁死）+ 首轮日期块 + `output_config.effort` 门禁 + tools 末位缓存断点；响应侧复用共享 Anthropic↔OpenAI 桥 | 无（身份块文本按 ref 逐字提取） |
| 登录 | CLI 设备授权流（init/poll，复用既有 loginId 会话机制）；`device_mid` 自生成 UUIDv4 并持久化进凭据 | 无 |
| 凭据 | 官方客户端凭据导入（AES-256-GCM，`enc:v1:iv.tag.data`，base64url） | 无（但补了 ref 未记录的 **Node↔Go 两处映射**：platform `win32`、username 取 SAM 名 —— 见下） |
| 领取 | 本地载体页（用户浏览器打开，阿里云 SDK 无感验证 → param 回传），每 plan 现产新 param | ref 用 DSH 桌面内部载体/外挂 Chromium；本端用系统浏览器 + 本地页（ref 自己的探针记录本地 origin 可用） |
| 未实现 | 推理侧 captcha 产出（撞 3007 只报错）；`serializeUpstream`/`modelGapMs` 并发门；远端目录缓存/冷却门 | 见架构 §6.7 |

**同步时新学到的事实（写进架构 §6.7，未来同步必须复核）**：

- **`builtinModels` 有对象与数组两种形状**：ref 记录为「键为序号的对象」，2026-10-02 真机抓到的是**数组** ⇒ 两种都接受（只认一种会得到「0 个模型」的假阴性）。**这是"ref 注释与真机不一致"的又一实例，判据以真机为准。**
- **凭据解密密钥的两个 Node↔Go 陷阱**：Node 的 `process.platform` 是 `win32`（Go 的 `runtime.GOOS` 是 `windows`）；Node 的 `os.userInfo().username` 是 SAM 名（Go 的 `user.Current().Username` 带域前缀 `HOST\user`）。两者任一写错 ⇒ GCM 认证失败（实测）。
- **身份块文本强耦合上游策略**：官方客户端升级若改身份块结构，3012 会回归，而 3012 有账号冷却惩罚（30min → 24h → 停用）。⇒ **每轮同步必须检查 `src/zcode-identity.ts` 是否变化**（变化则重新提取 `zcode_identity_text.go` 并更新测试里的 sha256/长度）。
- 目录实测数值（1,000,000 ctx / 128,000 max、vision 仅 Flash、levels low/high/max、default max）与 ref 记录逐项一致 ⇒ 静态兜底表可信。

**真机验证（2026-10-02，本机官方客户端凭据）**：`/oauth/cli/init` 真实返回 `bigmodel.cn` 授权 URL + 2s 间隔（首轮 poll = pending）；凭据解密成功（jwt 231 字符）；`billing/balance` 200；`client/configs` 目录两条与 ref 数值一致；推理请求 **200**（无 3012/3001）；该账号无 plan ⇒ 空流被正确判为「无权益」并标记切号。

**未覆盖**：有内容的正向流（需带 plan 的账号）；领取载体页真机（同上）；推理侧 captcha 产出。

---

### R3（pin `e06283c` → `ff5e37d`，2026-10-04 分诊）

> 分诊记录（2026-10-04）：85 commits（44 触 `src/`）逐条归类；merge 提交（`1ee3f7e` opencode 分支、`6c02081` trae 闸门、`afcaafe` loop-guard、`9184cd8`/`3906736` 面板族）已按 `git diff <merge>^1 <merge>` 展开。openai-gateway 出口族 / 面板 UI / 桌面载体 / 宿主回合引擎归 §5。本轮实施 R3-1 + R3-2；R3-3 记录待办（R3-4 当日由用户决定移入 §5 不搬）。

#### R3-1 codearts：`InferHub.4291.200` 额度用尽判据（**不可重试**）+ `429` 边界锚定 ✅

- 上游：`784210d`/`ae0c9b0`（`src/llm-adapter.ts`）——两层缺陷：① `isSseQueueErrorCode` 的 `429` 是**无边界子串**，额度耗尽码 `InferHub.4291.200` 的 `4291` 命中 `429` 前缀，被误判成「可重试的排队限流」→ 每 10s 重试、上限 180 次（30 分钟）静默重试、界面零输出（真实报障实测 25s 内 4 次 chat + 3 次排队探测、0 chunk）；② 额度用尽与排队/限流是**本质不同**的两件事（额度按 UTC+8 自然日结算，重试无意义），必须有独立判据 `isSseQuotaExhaustedErrorCode`（子串 `4291` + 文案兜底 `insufficient quota`）+ 独立处理（标记模型级限流到 UTC+8 当日 24:00 + 换号 + 都耗尽则如实报错带预计解禁时间）。
- 本项目现状（分诊时核实）：`codearts_response.go:67` 的 `codeartsSSEQueueCodeRe` 含裸 `429`——**同型缺陷原样存在**（`InferHub.4291.200` 会命中排队分支，进入 10s×180 次静默重试）；4xx 通道同理（上游在非 SSE 通道也补了判据，两条通道都接）。
- 落点：`internal/jethub/codearts_response.go`（429 边界锚定为独立数字 + `isCodeArtsSSEQuotaExhausted` 判据 + 优先于排队判定；命中 ⇒ `upstreamerr.BillingLockError{Until: NextUtc8DayStartMs}`，与 qoder `110`/opencode 额度同款——proxy 重试链据此锁 key+model 并换号）；HTTP 400 通道的 `insufficient quota` 文案兜底一并接入。
- 验收：单测（`InferHub.4291.200` 判额度不判排队；`81114.429` 仍判排队；`4291` 不再命中排队正则（反向验证：改回裸 429 必须变红）；额度命中产出 BillingLockError 且 Until=UTC+8 24:00；400 + `insufficient quota` 同判）。

#### R3-2 cline：删除已下线的 `cline-free/gemini-3.8-flash` 兜底条目 ✅

- 上游：`51d6093`（`src/cline-product.ts`）——直连复测（2026-10-03）：recommended-models 的 free 数组只剩 4 条，`POST /api/v1/chat/completions model=cline-free/gemini-3.8-flash` 回 404 `model not found`。兜底表留着它 = 模型列表里一个**永远 404** 的免费条目。
- 本项目现状：`trae_model.go:108` 的 `clineFallbackModels()` 仍含该条（R1-6 并表时快照）。
- 落点：删 `internal/jethub/trae_model.go` 条目 + 同步 `internal/api/jethub/register_test.go` 的 display-name 期望（23 → 22 条）。
- 验收：`go test ./internal/jethub/ ./internal/api/jethub/` 全绿；表内不再含该 id。

#### R3-3 新 provider：Gemini Code Assist（第 14 家）✅

- 上游：`e061b21` + 其后 14 个 gemini 修复提交（`src/gemini-*.ts` 7 文件 ~4,600 行 + 172 例单测）。Google Cloud Code Assist 上游，OAuth 授权码（本地回调，无 PKCE）+ refresh 续期 + `cloudcode-pa.googleapis.com` 双层信封（`{model, project, request:{…}, requestId, userAgent}`，**map 键必须字母序**——Go `encoding/json` 天然满足，移植反而免疫）+ 5 个身份头逐字写死 + 模型名带档位后缀（`gemini-3.8-flash-high`，裸名 404）+ 思考档位/预算自由旋钮 + `includeThoughts:false` 是假关（不提供 none 档）+ thoughtSignature 跨轮回填（独立缓存，**不放 state.yaml**——整文件替换语义会覆盖丢失）+ 签名被拒去签重试一次（不换号）+ 403/404/429 先翻端点再换号、401 先续期（只一次）+ 配额百分比口径（`remainingFraction`，total 恒 100）+ 5 小时窗口限流切账号 + lite 模型恒 404 不暴露。
> **实施记录（2026-10-04）**：落地清单逐项对齐——product 表（`gemini.go`，InferURL=daily+`streamGenerateContent`，`inference_url_test.go` 锁定）→ OAuth 浏览器回调登录（`gemini_oauth.go`：先监听后拼 URL/state 校验/client_secret 必带）+ refresh 续期（per-credential 串行，R1-2 同款锁）→ augmenter（`gemini_convert.go`：身份五头 + 信封构造，OpenAI→双层信封，工具 schema 白名单清洗）→ 响应 InterceptResponse（Cloud Code SSE→OpenAI chunk / 聚合，签名缓存进程内收集回填）→ credits（`gemini_credits.go`：`retrieveUserQuotaSummary` **sandbox** 端点 + body 带 `project` + bucketId 判据 + 百分比窗口）→ API（`/gemini/login|status|refresh|cancel|balance`，loginId 分支被 chi.Walk 守卫覆盖）→ 前端 `'%'` 单位显示。
> **与 ref 的有意差异**：① 签名缓存**进程内不落盘**（ref 落盘是因 DSH 每请求重建适配器；本端 Manager 常驻）② 无端点轮换/换号层（proxy 重试链 + rotation 已承担；ref 的 `includeThoughts` 恒真/假名 404 判据全保留）③ 档位经**带档位的模型名**（`gemini-3.8-flash-<tier>`）选择而非 DSH efforts 下拉（等价机制）④ 金标准字节断言取**前缀+后缀+字段序**（requestId 随机段无法逐字节，判据强度等价）。
> 回归 `gemini_test.go`（14 个：金标准信封/档位预算/未知 id 拒绝/角色与工具配对/图片 data-URL 门禁/schema 清洗/凭据过期/签名键/请求 id 形状/SSE 转换/thought→reasoning/错误帧/聚合/嵌套字母序）。

#### R3-4 zcode：双通道（start-plan/coding-plan）+ zai 渠道——不搬（2026-10-04 用户决定）

> 已移入 §5（判定锚点见该表）。上游事实存档：`0fcd929`（zai 渠道：ready 解析接 `data.zai` 分支）+ `15ccae5`（双通道传输层：start-plan=积分走 `zcode.z.ai`，coding-plan=订阅走 `api.z.ai` + OAuth token 换 api-key 四步 GET 流；选路按模型归属、start-plan 优先）。触发重估的条件：用户出现 coding-plan 订阅或 z.ai 国际版账号。

## 7. 轮次日志

| 轮次 | 日期 | pin 前 → 后 | 范围 | 结论 |
|---|---|---|---|---|
| R1 | 2026-10-02 | `cecf376` → `e06283c` | master 58 commits / 146 文件（31 触 src/）+ 分支 `feat/opencode-provider` 盘点；**R1-1..R1-7 全部实施** | 可搬 7 项全部落地（codearts 去头重试/续期判据+调度器/输出上限、qoder 刷新窗口、minimax 配对、cline 目录 23 条、opencode provider）；参考 2 项（R1-8/R1-9）留待未来；不搬 7 类入 §5；pin `e06283c`（分支未合并，不推进）。验证：`go vet ./...` 干净 + 全量 `go test ./...` 通过 + 前端 `node web/jethub.test.js` 全绿 + opencode 匿名通道真机 200（curl 与端内 augmenter 各一次） |
| R2 | 2026-10-02 | `e06283c`（不变） | **用户报障触发的重估**：ZCode provider 从 §5 不搬清单移出并整条移植（§6.1） | 新增 13 号 provider（Anthropic Messages 桥 + 3012 身份块/日期块 + CLI 设备授权登录 + 官方凭据解密导入 + token 桶余额 + 本地载体页 captcha 领取）；真机验证：登录 init / 凭据解密 / 余额 200 / 目录数值与 ref 一致 / 推理 200（无 3012）；未覆盖：有内容的正向流与领取载体页（需带 plan 账号）。新事实（目录两种形状、Node↔Go 密钥映射、身份块文本须随上游复核）已写入架构 §6.7（本节 §6 R2） |
| R3 | 2026-10-04 | `e06283c` → `ff5e37d` | master 85 commits / 150 文件（44 触 src/）；R1 的 opencode 分支已合入（其后 5 个修复归 UI 链不搬）；**R3-1 + R3-2 + R3-3 实施**（同日用户追加），R3-4 移入 §5 不搬，不搬 8 类 | R3-1 codearts 4291 额度判据（BillingLockError 至 UTC+8 24:00 + 换 key）+ 429 独立数字锚定（反向验证必红）；R3-2 cline 删已下线 `cline-free/gemini-3.8-flash`（免费 5→4）；**R3-3 新增 Gemini Code Assist provider（第 14 家）**：OAuth 浏览器回调登录 + 双层信封桥（身份五头/字母序/金标准前缀断言）+ SSE→OpenAI 响应桥 + 签名回填 + sandbox 配额窗口（百分比）+ API/前端接线。`zcode-identity.ts` 未变（已核实）。验证：`go build ./...` + 全量 `go test ./internal/...` 全绿（gemini_test.go 14 例；providers 计数 13→14；chi.Walk 守卫含 gemini） |
