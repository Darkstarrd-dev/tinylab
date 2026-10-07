# Free Hub 上游同步计划（dsh-codearts-auth → TinyLab，周期性）

> **文档性质：** 常驻流程文档（不是一次性实施计划，**不归档、不置「已完成」**）。每轮同步在 §7 追加一行日志；待办在 §6 逐条勾销。
>
> **上游：** `ref/deepseek-harness-codearts`（gitignored 只读副本，允许 `git fetch`/`git checkout` 同步操作，**禁止手工编辑**），origin `https://gitee.com/iJetLi/deepseek-harness-codearts.git`。
>
> **当前 pin：** `e73cd2f`（2026-10-07，R5 分诊基线；前序 pin：R3 `ff5e37d`、R1/R2 `e06283c`、初版 `cecf376`——**pin 只影响后续同步的判据来源，已移植实现的语义不随 pin 移动**）。
>
> **本轮侦察（2026-10-07，R5）：** master `2e8bb86` → `e73cd2f`：**105 commits / 167 文件（69 触 `src/`）**，横跨记账（token-ledger 四期）、buddy 成长中心、失效模型剔除、auto 选型、永久积分锁定、限流判据收窄、zcode 判据与超时、openai-gateway 出口族、面板族与大量测试。**本轮首件事是渠道移除**：`git push` 被 GitHub Push Protection 拒绝（GH013），命中 gemini 渠道的 Google OAuth client 常量 ⇒ 用户决定**整体删除该渠道**并把 gemini 上游数据**永久移出同步范围**（§5 新条目 + §6 R5-1）。分诊结论（R5-2 起逐条勾销）见 §6；不搬项入 §5。
>
> **本轮侦察（2026-10-05，R4）：** master `ff5e37d` → `2e8bb86`：**6 commits / 26 文件**，全部集中在 zcode + 文档。三条实质结论：① `2e8bb86` **BREAKING** —— 上游以**安全理由整体删除**「读本机 ZCode 客户端凭据」的旁路（本端有同一条路，用户同日决定**删除**）；② `c94e659` 复测修正两条旧说法：3012 的 HTTP 状态是 **405 不是 403**、日期块**不是**判据；③ `77fbf6c` captcha region 必须与产 param 的配置同源（本端结构上免疫）。`src/zcode-identity.ts` 本轮**只改注释**（逐行过滤非注释增删 = 空）⇒ 身份块文本与 sha256/长度**无需重新提取**。→ 本轮待办见 §6 R4。
>
> **本轮同时完成的卡片信息对齐（P0–P2）：** 用户报障「Zcode 在 DSH 里显示限额重置与准确时间、Tinylab 里不显示」「Minimax 在 DSH 里显示 credits 数字、Tinylab 里不显示（不止这一个）」。根因两条：① `ProviderMeta.HasBalance` 与实现脱节（minimax/raccoon/trae/cline 的余额后端早已实现且路由已挂，能力位却是 false）；② **全仓没有任何代码写账号级限流标记**（唯一写入方是内部记账键 + 备份导入），故「限额重置」那一行恒为空。逐项清单与判据见 §6 R4。
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
| R4：zcode 3012 可观测诊断模块 `src/zcode-diagnostics.ts` | `c94e659` | 它把「账号序号 / 进程内成败计数 / 最近成功时间 / 距上条 / **实测**身份块字符数 / 日期块有无 / HTTP 状态」打进错误文案，服务于 **DSH 侧多账号并发**的现场取证。**事实部分已吸收**（405 不是 403、日期块非判据、身份块 2898 字符 = 42+2856 —— 本端身份块长度与判据本就一致，见架构 §6.7）；诊断行本身属面板/宿主行为，本端单机面板无「账号序号 vs 请求」的对照需求。**重估触发条件**：本端出现「身份块达标仍 3012」的报障且需要用户侧取证模板时，按本行锚点取材 |
| R4：zcode captcha region 同源修复 | `77fbf6c` | **本端结构上免疫**，无需搬运：本端的 `zcodeCaptchaParam{Param, Region}` 的 Region 来自**产 param 的那一份配置**（`zcodeMintCaptchaParam(ctx, config, …)` → `Region: config.Region`），且 config 在 plan 循环**之前**取一次（上游修法正是「配置成为唯一真相源」）。⚠️ 本端无 captcha 推理侧产出（撞 3007 直接报错），故上游那条「组头时恒写 `captchaRegion ?? 'cn'`」的同型第二实例在本端**不存在** |
| R4：zcode Linux 浏览器探测候选链 | `892187d` / `22f3031` | 本端登录走 CLI 设备授权流（纯 HTTP），**没有**「探测本机浏览器可执行文件」那条链路；本端的浏览器选择是另一套（`internal/browserlaunch`，用户显式选择 × 会话模式，见架构 §3.9） |
| R4：zcode coding-plan key 取用接线 | `2e8bb86`（顺带修好） | R3-4 已由用户决定**不搬** coding-plan / zai 通道，故本端没有该取用点 —— 上游这次是修「`fetchCodingPlanApiKey` 建好却零调用方」的断链，前提（coding-plan 通道）在本端不存在。本端原先照抄留下的两个 `zcodeKeyFragmentPlan*` 死常量已随 R4 一并删除 |
| R1-7 旧差异「opencode 无 per-account 代理」 | R4-0 **反转为已实现**（用户要求全量对齐） | 原判据是「本端推理出站由 proxy 层决定，per-key 出口要动代理核心」。R4-0 做了这件事：`config.Key.Proxy` + 按代理串缓存的 transport + `upstreamClientFor`/`streamClientFor` 的 per-key 分支。**安全边界**：`Key.Proxy` 默认空 ⇒ 未设置的 provider/key 走原路径，逐字节不变（`perkey_proxy_test.go` 两条断言分别锁「设了的会绕」与「没设的不绕」） |
| **Gemini 渠道相关的一切（永久排除，2026-10-07 用户决定）** | `d9d0683` / `66753b4` / `ee0f730` / `e061b21` 族（`src/gemini*.ts` 7 文件 + 172 例单测） | **本端已整体删除该渠道**（R5-1：其 OAuth client 常量被 GitHub Push Protection 判为密钥、阻塞全部 `git push`，用户决定删渠道而非 unblock）。渠道不存在 ⇒ 协议事实、配额语义、模型目录、sessionId 派生、签名漂移兜底等全部无落点。**不再逐条评估**；若将来重新引入该渠道，须先解决密钥托管（env / 用户自备 client）再按本行锚点重估 |
| R5：记账 / Token 计数簇 12 条（`token-ledger*` 四期 + 三轮审计 + 宿主接线 + 面板图表） | `1ebad41` / `3e62a87` / `f510c88` / `eb0b7d0` / `b5170d8` / `e0df049` / `c10de34` / `a12ed03` / `dd5b591` / `648496a` / `a0f0940` / `d5b73ca` | 上游插件的**本地 Token 记账功能**（非协议/服务端事实），接线点全在 `dsh-llm` 与 `openai-gateway` 出口层（§5 已锁定）。本端 `internal/usage` + Monitor SPD/GT/TTFT 列 + `traces/` 日轮转已覆盖等价能力；`a0f0940` 的 TPS 分母塌缩教训本端结构性免疫（三处守卫实测）。见 §6 R5-2 |
| R5：DSH 宿主 / 面板专属项（buddy 成长面板与部署副本、buddy 图片能力三态与白名单、auto 选型、TRAE/LobsterAI 永久积分锁、RPC refresh 语义、调度器武装门） | `9462051` / `09fe2eb` / `97397a3` / `e60e555` / `f498586` / `e52f091` / `29f6bad` / `3de9312` / `570b0b3` / `68fb567` / `ac805a3` / `ba419ad` / `e784201` | 逐条理由见 §6 R5-3 / R5-4：或属宿主接线/面板行为，或本端已有等价实现（空候选 502、mark→exclude 无条件执行、九个刷新端点一律 502、`StartRefreshScheduler` 已无条件武装）。**其中三条纪律记入 R1-8 参考**（「未知 ≠ 不支持」/「目录重看 ≥10s 节流」/「等目录恢复才解决的错误不得进可重试集合」） |

## 6. 待办与实施记录（R1：`cecf376` → `e06283c`；R2：ZCode 重估；R3：→ `ff5e37d`；R4：→ `2e8bb86`；R5：→ `e73cd2f`）

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
  > **实施记录（2026-10-02）**：`internal/jethub/opencode.go` + `opencode_augment.go`（凭据/指纹/门禁/错误分类/SSE 聚合/账号添加）+ `products.go`（`Product.AnonymousKey`/`ModelFilter` 两个可选钩子）+ `bridge.go`（匿名 Key `Priority=100` 殿后 + 可见性过滤）+ API `POST /api/jethub/opencode/login` + 前端 apikey 弹窗（`__jethubApiKeyModal`，含「添加匿名通道」按钮）+ i18n en/cn。**真机验证**：匿名通道 `Bearer public` + 门禁形状对 `big-pickle` 实发 HTTP 200 SSE（curl 与**本端 augmenter 产出**各一次）。⚠️ **与 ref 的有意差异**：① 匿名槽改为**显式按钮**添加（ref 在首次启用自动补；TinyLab 无 per-provider enable 事件，自动写入会在未使用 opencode 的安装制造噪音）② ~~无 per-account 代理（用 provider 级 Use Proxy）~~ **R4-0 已补做**（见 §6 R4-0 的 P2-J2'）③ ~~指纹固定 generation=0（无代次轮换 UI）~~ **R4-0 已补做**（账号条目持代次，面板有「指纹」按钮）④ session id 按账号稳定（ref 按会话缓存；形状门禁一致）⑤ 付费可见性已实现（无 keyed 账号只列 7 条免费）。回归 `opencode_test.go`（10 个）+ `internal/api/jethub/opencode_test.go`（1 个）+ 前端路由形状守卫自动覆盖新路径。

### R1-8 参考设计：远端模型目录 gate（未来实现用）

- [ ] 上游：`0ca8256`（`src/remote-catalog-gate.ts` + 10 个消费点）——并发去重 + 失败/空结果冷却 + **兜底表不写缓存**（原缺陷：一次瞬时失败让 provider 整个进程生命周期只剩兜底模型）。
- [ ] 本项目现状：模型列表纯静态（架构 §6.3「远端目录未实现」是已知缺口，trae/lobsterai/buddy/cline 四家的倍率只有远端才有）。
- [ ] 本轮动作：**不实施**；作为将来实现远端目录时的正确形态参考（实施时在架构 §6.3 引用本行）。

#### R1-8 追加（R5 分诊产物，2026-10-07）：远端目录落地时的四条硬纪律

本轮 buddy 图片能力簇与 cline 兜底表簇产出了四条**与本端 R1-8 缺口直接相关**的纪律，
全部来自上游实测（实施远端模型目录时必须照抄，不要重新发明）：

1. **「未知 ≠ 不支持」**：能力字段缺席表示**未知**，必须省略该字段，**不得**投影成「不支持」
   （ref 09fe2eb：把未知投影成 `[text]` 会让贴图在宿主侧被静默丢掉）。本端将来加图片能力字段
   时同款：无信息就不写字段，代理本就透传图片。
2. **目录重看节流 ≥10s**：`RemoteCatalogGate.sinceLastAttemptMs`（ref 09fe2eb）—— 失败的目录
   拉取不得每请求重试；但**兜底表不写缓存**（R1-8 原始判据）。
3. **「等目录恢复才解决」的错误不得进可重试集合**：ref e60e555 实测把能力未知的贴图错误码
   放进 `DEFAULT_RETRYABLE_CODES`（含 `TRANSPORT`）会导致白重试 5 次并放大目录拉取 6 倍。
   本端等价物是 `internal/upstreamerr` 的类型化重试信号 —— 加新信号前先问「重试能不能解决」。
4. **兜底表并入必须有条件**：ref b0352fc —— 远端成功下发目录时，兜底表只用于给「远端仍认识」的
   条目补元数据，远端已不认识的（= 上游已下架）**不再新增**；判据用 `remote.entries.length > 0`
   而非 `freeIds.length > 0`（后者在上游把免费模型**全部**下架时合法为空，只看它会把「全撤」
   误判成「端点挂掉」，反而保留整张失效表）。本端无合并层，此条在实现远端目录时适用。

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

#### R4-0 账号卡片信息对齐（P0–P2，2026-10-05，用户报障驱动并全量实施）

> **触发**：用户报障「Zcode，DSH 里会显示限额重置的信息和准确时间，Tinylab 里不会显示」「Minimax, DSH 里会显示 credits 数字，Tinylab 里不会显示（**不止这一个，还有不少也都不显示 credits 数字**）」，并要求「完整的信息对齐」。**判定原则 §2 三条硬判据全过**：卡片显示的是服务端事实 + 本端数据，且不做会直接造成用户可见的信息缺失。

| # | 现象 | 根因（实测） | 落点 |
|---|---|---|---|
| P0-A | minimax / raccoon / trae / cline 四家**永不显示额度数字** | `ProviderMeta.HasBalance` 与实现脱节：四家的余额后端与 `/balance` 路由早已存在，能力位却是 false（该位是前端渲染额度行与「刷新积分」的**唯一**门控） | `internal/jethub/manager.go`（四家补 `HasBalance: true`）+ `internal/api/jethub/balance_capability_test.go`（**双向**守卫：路由有⇒标志必须有、标志有⇒路由必须有） |
| P0-B | 额度标签恒为「积分」 | 前端写死 `freeHubCreditsLabel`；而 `unit` 已传到前端却只用于格式化数字 | `web/static/jethub.js` 的 `__jethubCreditLabel` 三态（`token`→Token、`%`→额度、其余→积分，ref `unitLabel`）+ 标签随余额回填 |
| P0-C | Gemini 显示的是**两窗口平均值**（上游根本不存在的数） | `geminiBalanceOf` 的 `total = sum/2`；ref 已因此报障并把主行改成**逐窗口百分比** | 前端 `__jethubQuotaLine`/`__jethubQuotaDetail`（「5 小时窗口 90% · 周窗口 99%」，明细带「重置于」） |
| P0-J1 | Gemini 显示「重测 / 重置」两个必然无效的按钮 | 例外表只有 loomy | `internal/api/jethub/register.go` 的 `rateLimitExemptProviders` += gemini（配额窗口制：清标记/重测都不恢复配额，按钮只剩白烧配额与放回池里再撞一次） |
| 额外 | opencode 完全不显示额度行 | Zen **没有公开余额 API**（15 条候选路径全 404），ref 因此把能力位登记为「通道可用性」并使用**本地状态、零网络请求** | 新增 `Manager.OpencodeChannelBalance`（通道是否可用 + 是否限额冷却 ⇒ `Total`/`ExpiredTotal`/`expiredTotal`）+ `GET /api/jethub/opencode/balance`（200 里带 `error` 表示**状态**而非失败） |
| P1-I | **ZCode 那条的真正根因**：「限额重置」行对所有渠道恒为空 | 全仓**没有任何代码**写账号级 `ModelRateLimits` —— 唯一调用点是 trae 的内部记账键（UI 按 `__` 前缀过滤掉）；额度/限流错误一律走 `BillingLockError` → rotation 的 key 冷却 | `rotation.Selector.SetRateLimitObserver`（注入式观察者，rotation **不依赖** jethub）+ 四条写锁路径（`MarkRateLimited`/`MarkDailyQuotaLocked`/`MarkBalanceLocked`/`MarkNIM429`）都通知 + `app.go` 组合根映射到 `Manager.UpdateModelRateLimit`。**写回规则**：只延长不缩短（ref `account-pool.ts:1047`），空模型名拒收 |
| P1-I' | 重测说「仍受限」而卡片一条都不显示 | 重测只报结果、**不更新**解禁时刻；滚动窗口下旧时刻过期即被前端隐藏 | `internal/jethub/ratelimits.go` 的 `parseRateLimitResetTime`（ref `RESET_TIME_PATTERN`，中英两种句式 + **捕获**时区）+ 命中即写回 |
| P1-F/G/H | 只有一行合计数字：无「长期 / 临时」分桶、无资源包 hover 明细、无「另有 N 已失效」 | `CreditPackage` **没有任何到期字段**（buddy 解析出 `DeductionEndTime` 又只用来判 active、lobsterai 的 `expiresAt` 同理），`CreditBalance` 无 `expiredTotal` | DTO 扩展（`deductionEndTime`/`expiresAt`/`cycleEndTime`/`expiredTotal`/`windowDays`）+ 各 provider 填充（buddy/lobsterai/qoder 专用包/zcode 桶/gemini 窗口重置/trae 整张包表）+ 前端 `__jethubSplitByExpiry`/`__jethubPackageTooltip`/`__jethubPoolSplitLine` |
| P1-E | loomy 的两池、raccoon 的四池都不显示 | loomy 后端**已产出**两个池却被合计掩盖；raccoon 只读一个**并不存在**的 `balance` 字段（真实字段是 `available_points` + 四个池） | 前端池名分桶（`每日赠送`/`每日积分` ⇒「长期 X · 每日 Y」）+ raccoon 按池建包 |
| P1-D | Gemini 不显示「账号规格」（Pro/Free/Ultra） | 从未取 `loadCodeAssist`（常量已定义但零调用） | `gemini_credits.go` 的档位解析（`paidTier` 优先、`currentTier` 兜底、Ultra→Pro→Free 顺序）+ `extra.accountTier` + 卡片独立一行（取不到则**整行不渲染**） |
| P2-K | 账号顺序无法调整（拖拽排序缺失） | 池内顺序**就是**选号优先级，但 `SyncKeys` 里一句 `sort.Slice(keys, …ID < …ID)` 把它按 ID 字典序重排 ⇒ 「拖到第一位」对路由层完全无效 | `Manager.ReorderAccounts`（**严格集合相等**校验）+ `PUT /providers/{provider}/accounts/order`（改完 SyncKeys）+ key Priority 按池内位置（匿名恒殿后，与卡片序号同一套编号）+ 前端拖拽与序号徽标 |
| P2-J2 | opencode 无「指纹」按钮（且指纹代次恒 0） | `opencodeFingerprintGeneration` 字段不存在；augment 直接用凭据里的 projectID（**ref 明确的静默失效形态**：代次涨了 id 不变） | 账号条目加代次字段（落盘 + 备份兼容）+ `max(条目, 凭据)` 重新派生 + `POST /opencode/fingerprint/rotate` + 卡片按钮 |
| P2-J2' | opencode 无法给单个账号配出口（匿名额度按出口 IP 计 ⇒ 多账号共用同一份额度） | 本端此前把它记为「有意差异」（推理出站由 proxy 层按 **provider** 级 `UseProxy` 决定，没有 key 级出口的概念） | `config.Key.Proxy`（**默认空 ⇒ 默认路径逐字节不变**）+ `proxy.Handler.keyProxyClientsFor`（按代理串缓存独立 transport）+ `upstreamClientFor`/`streamClientFor` 的 per-key 分支（**优先于 provider 级**）+ `bridge.SyncKeys` 写 `Proxy` + `Manager.SetAccountProxy`（空串=清除、非法值当场报错）+ `PUT /opencode/proxy` + 卡片「代理」按钮；探针改走 `httpClientForAccount`（否则探测结论与真实流量不同源） |
| P2-J3/J4 | loomy 的「新手任务」后端已实现却**前端零入口**；raccoon 的一次性奖励被写成「领取」（像每日签到） | `dailyCheckin` 与 `onboardingTasks` 是原版能力矩阵里**两个彼此独立**的位，本端只搬了一半 | provider DTO 加 `claimKind`（daily/onboarding）与 `supportsOnboardingTasks` + 卡片按语义分文案与按钮（loomy 两个独立按钮、raccoon 单按钮改文案） |
| P2-L | 匿名通道无标记；无手机号/账号名派生显示 | — | `Account.anonymous`（**凭据内容**判定，非 id 前缀 —— 本端 id 形如 `{provider}-{8hex}`，前缀判据永不命中）+ 「匿名」标签与 tooltip；`Account.accountName`/`phone`（zcode 手机号由 user_id 前 11 位派生）+ 额度失败时把**原因**放进 title |
| 额外 | **不再有**「R1-7 的 per-account 代理差异」 | 见 P2-J2' | 该差异条目已从 §5 / 架构 §6.5 的「有意差异」里**移除**（改为已实现） |

**与 ref 的差异（有意）**：① ref 的「测试」按钮（无条件探活，仅 gemini）未搬（本端探针复用代理管线，无对应端点）。② 断网/失败时 ref 显示 `查询失败` 的位置，本端显示**原因**（更接近 ref 的 `title` 语义但更显眼）。~~opencode per-account 出口代理未接线~~ —— **R4-0 当日补做**（见下条）。

**R4-0 追加：opencode 的 per-account 出口代理已接线**（原先按 R1-7 记为有意差异）。落点：`config.Key.Proxy`（key 级出口，**默认空 ⇒ 默认路径逐字节不变**）+ `proxy.Handler.keyProxyClientsFor`（按代理串缓存独立 transport，连接池按出口隔离）+ `upstreamClientFor`/`streamClientFor` 的 per-key 分支（**per-key 优先于 provider 级开关**）+ `bridge.SyncKeys` 写 `Proxy` + `Manager.SetAccountProxy`（空串=清除，非法值当场报错）+ `PUT /api/jethub/opencode/proxy` + 面板「代理」按钮（tooltip 说明**不设会与其它账号共用同一出口 = 同一份额度**，且与「指纹」分开：**指纹分离不增加配额**）。探针同样改走 `httpClientForAccount` —— 从别的出口探测会得到与真实流量不同的结论。判据见 `internal/proxy/perkey_proxy_test.go`（设了的绕、没设的不绕、优先于 provider 级、非法回落直连）与 `internal/jethub/account_proxy_test.go`。

#### R4-1 zcode：删除「读本机官方客户端凭据」整条路径（**BREAKING，用户决定**）

- **上游**：`2e8bb86`（`src/zcode.ts` 597→178 行、`src/zcode-auth.ts`、`src/jet-hub-rpc.ts`，净减约 700 行）。理由三条：① **安全**（官方用 sha256(平台+家目录+用户名) 派生 AES-256-GCM 密钥，算法公开可复现 ⇒ 那条路等价于「任何本地进程都能解密 ZCode 登录凭据」）；② **正确性**（zai 渠道下双重失效：两个渠道的 `user_info` **结构**不同，导入结果 `user_id` 恒缺、标签退化成「设备xxxxxxxx」）；③ **一致性**（插件本就有完整可用的 OAuth 流程）。
- **本项目现状（分诊时核实）**：`zcodeImportLocalCredential`（`zcode.go`）就是同一条路径，且 **issue 描述的同一缺陷确实存在**（只认 `oauth:bigmodel:user_info`，zai 凭据会得到空 `user_id` + `设备xxxxxxxx`）；另有 `zcodeDetectAppVersion` 会读官方安装目录的清单文件。
- **本轮动作（用户 2026-10-05 决定：「删除」）**：删除 `zcodeImportLocalCredential` / `ZcodeImportLocalAccount` / `POST /api/jethub/zcode/import`、整套凭据文件解密（`enc:v1:` 前缀 `/` 派生密钥 `/` `ZCODE_CREDENTIAL_SECRET`）、`user_info` 解析、安装目录探测与版本清单解析、以及**零调用的** `zcodeKeyFragmentPlan*` 死常量。插件登录的 `AppVersion` 留空 ⇒ 回落内置常量（ref 同款）。
- **验收**：`TestZcodeNeverReadsLocalClientData`（**扫源码字面量** —— 断言某个函数不存在，对新写的读取函数无效；判据串在测试里拼接，避免守卫自己命中自己；已反向验证：注释里留一个 `credentials.json` 都会变红）+ `TestZcodeImportRouteIsGone`（**反向**回归：`POST /zcode/import` 必须 404，其余四条路由仍在）。
- ⚠️ **对用户的影响（如实告知）**：「装了官方客户端并登录过 ⇒ 零操作可用」的行为**没有了**，需要在 Free Hub 点一次「登录」走设备授权流；**存量凭据不受影响**，照常工作。

#### R4-2 zcode：两条旧说法的订正（事实修正，无代码改动）

- **上游**：`c94e659`（`src/zcode-identity.ts` 文件头 + `src/zcode-diagnostics.ts` 新增）。
- **事实 1**：3012 的 HTTP 状态是 **405**，不是 403（按 403 排查会走到「鉴权/权限」的错误分支；响应体还带 `logid`，向用户索取现场时优先要它）。**本端影响**：无功能影响 —— 本端的 zcode 分类**只看响应体业务码**（`zcodeIsRiskBlocked` 匹配 `3012`），状态码不参与判据；仅订正了 `zcode_response.go` 的注释。
- **事实 2**：**日期块不是判据**（去掉照样 200），它与身份块是「必要非充分」。本端仍照发（官方如此、零成本），注释已注明不要再把它当「3012 的最后一个开关」。
- **核实**：`src/zcode-identity.ts` 本轮**只改注释**（逐行过滤非注释增删 = 空）⇒ `zcode_identity_text.go` 的文本与 sha256/长度**不需要**重新提取（架构 §6.7 那条「每轮必查」的红线本轮通过）。

#### R4-3 收口

- pin 推进 `ff5e37d` → `2e8bb86`；PROJECT_MAP §22 / §19 / §24 同步。
- 不搬项入 §5（诊断模块 / Linux 浏览器链 / coding-plan 接线）；region 同源与 405 两条以「本端免疫 + 事实订正」入 §5 与架构 §6.7。

### R5（pin `2e8bb86` → `e73cd2f`，2026-10-07 分诊）

> 分诊记录（2026-10-07）：105 commits（69 触 `src/`）分四簇并行侦察（记账 / 轮询限流 / buddy 成长与模型目录 / zcode 与响应判据）。
> **上游数据永久排除一项**：gemini 渠道（§5 + R5-1）。其余结论如下，`[~]` 表示已分诊未实施（带 commit 锚点，下一轮不重复分诊）。

#### R5-1 Gemini Code Assist 渠道：整体移除（**BREAKING，用户决定**）✅

> 见上文 §5 新增的永久排除条目与架构 §6.8 的删除记录。上游 `src/gemini*.ts` 及其单测**不再纳入分诊范围**。

#### R5-2 记账 / Token 计数簇（12 条）：整体不搬 ✅（分诊结论）

- 上游：`1ebad41`（第 1 期全 provider 计数 + `src/token-ledger.ts` 新增）`3e62a87`（第 2 期账号维度 + 日聚合落盘）`f510c88`（第 3 期 TTFT 与 tok/s）`eb0b7d0`（第 4 期历史视图 + 面板）`b5170d8`/`e0df049`/`c10de34`（三轮审计修复）`a12ed03`/`dd5b591`/`648496a`（宿主接线测试与修复）`a0f0940`/`d5b73ca`（度量口径与图表修正）。
- **不搬理由**：该簇是上游插件自建的**本地 Token 记账功能**，不是协议/服务端事实；接线点全在 `dsh-llm`（`prepareCall`→`call.stream`）与 `src/openai-gateway/*` 出口层（§5 已锁定）。本端已有等价能力：`internal/usage` 记账 + Monitor 的 SPD/GT/TTFT 列 + `traces/` 日轮转 per-request 持久化（含失败请求与 `error` 字段）。
- **口径教训已结构性免疫**（无需动作）：`a0f0940` 的「982.5 tok/s」源于 TPS 分母塌缩，本端 live SPD 有 `genMs<200` 守卫（`monitor_state.js`）、终端 AvgSpeed 是 `total/total` 聚合而非比率均值（`usage/accumulator.go`）、live key 速率有 `elapsed<2s` 守卫（`proxy/inflight.go`）。

#### R5-3 轮询 / 换号 / 限流判据簇（11 条）：部分实施

- **可搬（P1，四条并为一项）**：`0abaf1a` + `51ded6a` + `7b524ff` + `1623538` —— **raccoon / loomy / trae 的 HTTP 200 内嵌错误帧分类判据族**。上游两文件自述「业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回」（协议事实）；本端这三家**没有 `InterceptResponse` 分支**（`qoder_adapter.go` 对未列 provider 直通）⇒ 内嵌帧不分类、不冷却、不换号，限额行也不写。换号机制本身不搬（本端 `proxy` 重试链 + rotation 已等价且更强），搬的是**错误帧 → 类别 → 动作**的判据。落点：`internal/jethub/raccoon_provider.go`、`loomy.go` 新增 interceptor（仿 `opencode` 的）+ `qoder_adapter.go` 分派加分支；`trae` 部分随响应桥（`products.go` 自述未实现 SOLO→OpenAI 转换）落地。判据细节实施时 `git show 0abaf1a` 复核。
- **可搬（独立）**：`edbe1f6` —— **trae 通道白名单是服务端事实**（同一模型只在列出它的通道里可调用，发错通道流内 4001）。本端双重缺口：请求侧对所有模型硬编码 `solo_work_lite`（`trae_provider.go`）、静态模型表无通道字段（`trae_model.go`）。模型表修剪独立有价值（防列出必然 4001 的模型）。
- **已实施 ✅**：`5334547` + `cfd7851` —— codearts flash 族输出上限收敛（与 R1-4 同判例）。本端 `codeartsClampMaxTokens`/`codeartsCappedModel` 原覆盖 `deepseek-v4-flash|pro` + `GLM-5.2`；按上游扩至 **`glm-5.3-flash` + `deepseek-v4.1-flash`**（`internal/jethub/codearts_augment.go`，cap 恒 65536）。回归 `codearts_refresh_test.go` 的 clamp 纯函数与 augmenter 端到端用例已覆盖新集合。
- **不搬**：`ba419ad`（「模型级限流误报未登录」是 DSH `resolveCredential` 兜底链问题，§5 已有 R3 `d77e716` 判例；本端空候选 → 502 + SonestCooldown，且 R4-0 P1-I 观察者已写卡片限额行）；`e784201`（「失败前标记最后一个耗尽账号」本端 mark→exclude 在每次尝试点无条件执行，不存在末账号漏标路径）；`68fb567`（DSH 面板 RPC；其语义内核「失败必须显式失败」本端九个刷新端点已满足，一律 502）；`ac805a3`（「续期调度器无条件武装」本端 `StartRefreshScheduler` 已是该形态，即 R1-2 ④ 已移植语义）。

#### R5-4 buddy 成长 / 失效模型剔除 / auto 选型 / 永久锁簇（15 条）：部分实施

- **可搬（高优先）**：`29a42ea` —— **模型饱和 `14003` 被误判成账号额度限流**。纯服务端事实：HTTP 429 + `{"code":14003,"msg":"too many requests","actions":["SWITCH_MODEL",…]}`（`actions` 无换号选项，报文自证模型级）；与 `6004`（账号额度限流，带重置时刻）动作相反。⚠️ 本端确有同型误判：buddy 无响应判据层，代理 429 分支 + rotation 观察者会对**任意** 429 写 `(account,model)` 标记并换号 ⇒ 14003 会逐个锁死整池。落点：`internal/jethub/buddy_response.go` 新建（仿 `zcode_response.go` 的同号退避 + `codearts_response.go` 的「先专项后通用」顺序），注册 ResponseInterceptor；`6004` 既有行为不得回退。
- **可搬（高价值）**：`f8748fa` —— **已失效模型的运行时实证剔除**（修「下架模型仍显示免费」），正是 R1-8 缺口中**不需要远端目录的那一半**。判据 = **阳性证据**（只认明确的「模型不存在」文案，中英各形态；一律不认额度/限流/认证/权限/排队/网络/参数错误，也不收「不可用」）。为何不用远端目录比对：cline 远端可比对，但 buddy 系远端刻意残缺（比对会删掉可用模型），qoder 无端点 ⇒ 运行时阳性证据是唯一安全通用层。记录按 `(provider,model)` 原子写 + **必须有 TTL**（默认 30 天，被剔除的模型用户选不到、无法靠成功自愈，只能过期回收）。落点：`internal/jethub/deadmodels.go` 新建 + 模型表出口过滤 + proxy 错误路径与 probe 的 404 喂记录；误判代价不对称（可用模型被藏），反例组必须多于正例组。
- **已实施 ✅**：`b0352fc` —— cline 兜底表不再复活已下架免费模型：`cline-free/deepseek-v4.1-flash` 已于 2026-10-05 被上游从 `free` 数组移除（free 4→**3**，直连回 404 `model not found`），本端 `internal/jethub/trae_model.go::clineFallbackModels` 已删除该条（与 R3-2 删 `gemini-3.8-flash` 同型）。⚠️ **有条件并入的机制不搬**：上游同时修了 `mergeClineModels` 的无条件兜底表并入（本端模型列表是**纯静态表**、无远端合并层，见 R1-8 缺口），该修复的判据（用 `remote.entries.length > 0` 而非 `freeIds.length > 0`）记入 R1-8 参考。
- **可搬（新能力，工作量大）**：`b21b159` + `f7bacac` + `041f467` —— **buddy 成长中心任务**（`src/buddy-growth.ts` 2566 行 + 476 行测试）。服务端事实：双任务端点 schema 不同必须合并读、`claim` 走 `claimBase`（CodeBuddy 中国版 = `www.workbuddy.cn`，**≠** API 域）、`requestModelId` 与 `requestModelName` 必须分离、`Expert_team_use_3` 按专家按天去重须轮换、`LEVEL_UNREACHABLE` 四项服务端只记 status 不记 progress（结构性 clientOnly）、凭据被删归 `inactive` 不计 `failed`。**建议裁剪**：首轮只做「任务列表合并读 + 扫尾补领 + claim」（不依赖 22 项遥测事件矩阵，性价比最高）。`041f467` 另给两条硬约束：`workbuddy`（国际版）后端**根本没有成长中心** ⇒ 不登记；`claimBase`/`webBase` 缺配置必须**显式报错**、不得让 `String(undefined)` 拼出的 URL 发出去。落点：`internal/jethub/buddy_growth.go` 新建 + `buddy_credits.go` 编排 + `buddy_product.go` 字段。
- **不搬**：`9462051`（被 `b21b159` 取代的部署副本）；`09fe2eb`/`97397a3`/`e60e555`（buddy 图片能力三态 + 白名单放宽 + 错误码可重试性——本端模型列表纯静态、无 per-model 图片门禁、`ModelDef` 无图片能力字段且代理对图片一律透传，见 R1-6 实施记录；**三条纪律记入 R1-8 参考**：远端目录落地时「未知 ≠ 不支持」、「目录重看 ≥10s 节流」、「等目录恢复才解决的错误不得进可重试集合」）；`f498586`/`e52f091`/`29f6bad`（auto 单一模型跨 provider 选型——本端 combo `greedy-squirrel` 已等价）；`3de9312`/`570b0b3`（TRAE/LobsterAI 永久积分锁——上游新增，本端架构 §3.1 已记「永久锁未移植选号侧语义」）。

#### R5-5 qoder 信封心跳帧 + zcode 判据 / 超时 / 诊断簇：部分实施

- **已实施 ✅**：`1846449`（issue IKJOZ8）—— **qoder 信封心跳帧不得判成业务错误，判据改为解析 JSON 结构**。本端 `internal/jethub/qoder_envelope.go` 与上游修复前**逐字同构**（`!strings.Contains(inner, "'choices'")` 即判业务错误），两个方向相反的缺陷都在：① `body: null` 序列化成 `null` → 不含 choices → **心跳帧被当业务错误**（模型正常回完内容却报失败，且该类错误可重试 ⇒ 白重发整轮对话）；② 错误文案里恰好含 `"choices"` 的帧被当正常帧**静默透传**。另发现同型第三处：`usage`-only 帧（`stream_options.include_usage` 的末帧）也被误判成错误。
  - 落点：新增 `qoderClassifyInner`（三态结构判据：chunk / error / heartbeat）+ `qoderTransformSSELine` 与 `qoderFlushSSELine` 消费点（心跳**整帧丢弃**，不透传 `data: null` —— 透传会让消费侧读 `.error` 抛未包装的 TypeError）+ `qoder_adapter.go` 的 peek 首帧分类改用**同一处**判据（HTTP 层与 SSE 层不得各有一套）。
  - 回归：`TestQoderHeartbeatFrameIsNotAnError`（6 种心跳形态必丢 + 3 种 chunk 形态 + 5 种 error 形态）+ `TestQoderHeartbeatFrameAtFlushIsDropped`。**反向验证已做**：把判据改回子串嗅探，两条用例立刻变红并复现出 `data: {"message":"null","type":"model_error"}` 的原始缺陷形态。
- **不搬（结构性免疫，逐条已核实）**：`e73cd2f`/`e9173b9`（边缘 CDN HTML 错误页判据——本端 live 分类 `zcodeBusinessCodeOf` 只认 JSON 码对象，HTML 页取不到 code 即透传，误封号侧免疫）；`4169d06`（空闲超时 vs 整轮墙钟——本端 F-02 已是每字节续期的 idle 超时 + 流式清除 `WriteTimeout`，无整轮墙钟）；`d2d09f3`（取凭据先于读 `currentAccountId`——本端 `zcodeAugment` 以 keyID 直解凭据，身份与凭据同源，无独立 Map 顺序依赖）；`4d947d2`/`cc4a40d`（签到按单位分列——本端一键签到只计 ok/fail、无跨单位金额汇总，`ClaimOutcome` 也无 `Unit` 字段）；macOS 藏窗族（`f045052`/`2fe8541`/`e0835ab`——本端无「藏窗口」链路）；三个仅测试提交（`ee867d1`/`8ffe214`/`9f133b0`）。
- **待定**：`9922777`（领取路径 3012 补齐文案与诊断 + 6 处判据缺陷）—— 本端领取路径确有 `zcodeDescribeClaimCode` 缺 3012 条目与 `ClaimZcodePlan` 非 JSON 时 raw dump 的形态，需实施时 `git show 9922777` 逐条核对判据后再定。


> 分诊进行中（并行侦察），结论落地后补入本节。

## 7. 轮次日志
| 轮次 | 日期 | pin 前 → 后 | 范围 | 结论 |
|---|---|---|---|---|
| R1 | 2026-10-02 | `cecf376` → `e06283c` | master 58 commits / 146 文件（31 触 src/）+ 分支 `feat/opencode-provider` 盘点；**R1-1..R1-7 全部实施** | 可搬 7 项全部落地（codearts 去头重试/续期判据+调度器/输出上限、qoder 刷新窗口、minimax 配对、cline 目录 23 条、opencode provider）；参考 2 项（R1-8/R1-9）留待未来；不搬 7 类入 §5；pin `e06283c`（分支未合并，不推进）。验证：`go vet ./...` 干净 + 全量 `go test ./...` 通过 + 前端 `node web/jethub.test.js` 全绿 + opencode 匿名通道真机 200（curl 与端内 augmenter 各一次） |
| R2 | 2026-10-02 | `e06283c`（不变） | **用户报障触发的重估**：ZCode provider 从 §5 不搬清单移出并整条移植（§6.1） | 新增 13 号 provider（Anthropic Messages 桥 + 3012 身份块/日期块 + CLI 设备授权登录 + 官方凭据解密导入 + token 桶余额 + 本地载体页 captcha 领取）；真机验证：登录 init / 凭据解密 / 余额 200 / 目录数值与 ref 一致 / 推理 200（无 3012）；未覆盖：有内容的正向流与领取载体页（需带 plan 账号）。新事实（目录两种形状、Node↔Go 密钥映射、身份块文本须随上游复核）已写入架构 §6.7（本节 §6 R2） |
| R3 | 2026-10-04 | `e06283c` → `ff5e37d` | master 85 commits / 150 文件（44 触 src/）；R1 的 opencode 分支已合入（其后 5 个修复归 UI 链不搬）；**R3-1 + R3-2 + R3-3 实施**（同日用户追加），R3-4 移入 §5 不搬，不搬 8 类 | R3-1 codearts 4291 额度判据（BillingLockError 至 UTC+8 24:00 + 换 key）+ 429 独立数字锚定（反向验证必红）；R3-2 cline 删已下线 `cline-free/gemini-3.8-flash`（免费 5→4）；**R3-3 新增 Gemini Code Assist provider（第 14 家）**：OAuth 浏览器回调登录 + 双层信封桥（身份五头/字母序/金标准前缀断言）+ SSE→OpenAI 响应桥 + 签名回填 + sandbox 配额窗口（百分比）+ API/前端接线。`zcode-identity.ts` 未变（已核实）。验证：`go build ./...` + 全量 `go test ./internal/...` 全绿（gemini_test.go 14 例；providers 计数 13→14；chi.Walk 守卫含 gemini） |
| R4 | 2026-10-05 | `ff5e37d` → `2e8bb86` | master 6 commits / 26 文件（全部 zcode + 文档）；**用户报障驱动的卡片信息全量对齐（P0–P2，§6 R4-0）+ R4-1 zcode 本机凭据路径删除 + R4-2 两条旧说法订正**，不搬 3 类入 §5 | **P0**：四家 `HasBalance` 开关补正（minimax/raccoon/trae/cline）+ 单位标签三态 + Gemini 逐窗口百分比 + gemini 排除重测/重置 + opencode「通道可用性」额度行（本地状态、零网络）；**P1**：限额重置标记**首次真正写入**（rotation 观察者 × 四条写锁路径 + app 组合根注入）+ 重测写回新解禁时刻（中英两种句式 + 捕获时区）+ `CreditPackage` 到期字段/`expiredTotal`/`windowDays`/`extra.accountTier` + 各 provider 填充 + 前端临时/长期分桶、资源包 hover 明细、失效额度、池名分桶、账号规格行；**P2**：账号拖拽排序（顺序=选号优先级，删掉 `SyncKeys` 的 ID 重排）+ opencode 指纹轮换（代次为权威）+ **opencode per-account 出口代理接线（`config.Key.Proxy` + per-key transport，默认空 ⇒ 原路径逐字节不变）** + loomy 新手任务入口 + raccoon 一次性奖励文案 + 匿名标记与账号名/手机号派生；**R4-1 删除** zcode 本机凭据导入（含安装目录探测，源码字面量守卫 + 路由反向回归）；**R4-2** 订正 3012 是 405、日期块非判据（本端按响应体判码故功能免疫）。验证：`go vet ./...` 干净 + 全量 `go test ./...` 全绿 + `node web/jethub.test.js` 全绿（含 5 组新用例：额度单位/分桶、排序、provider 专属卡片、通道状态、出口代理）；关键项已做反向验证（能力位、观察者、重测写回、指纹、per-key 代理、本机读取守卫） |
| R5 | 2026-10-07 | `2e8bb86` → `e73cd2f` | master 105 commits / 167 文件（69 触 `src/`）；**R5-1 整体移除 Gemini Code Assist 渠道（用户决定，push 阻塞驱动）** + R5-2 起按分簇分诊结果实施可搬项 | **R5-1**：gemini 渠道六个源文件 + 全部接线（product 表/augmenter/拦截器分派/API 路由/`rateLimitExemptProviders`）+ 前端配额单位（`%`）渲染链与账号规格行 + 四个 i18n 键 + `nonAggregatableProviders` 表；provider 14 → 13；上游该渠道数据永久移出同步范围（§5）。回归：`go build`/`go vet`/全量 `go test ./internal/...` + `node web/jethub.test.js` 全绿，`git grep -i gemini` 在 Free Hub 面零残留。R5-2 见同节 |
