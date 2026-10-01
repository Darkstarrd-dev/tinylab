# Jet Hub 插件移植实施计划（dsh-codearts-auth → TinyLab）
| 2026-09-30 | P0 | 完成前置评估（克隆 ref 副本 @ commit cecf376，依赖/增量/平台结论见 §1）；创建本计划文档；PROJECT_MAP.md §19/§23 添加引用。 |
- [x] P3.3.5 minimax：**Anthropic Messages 协议族**——桥接 Provider 的 augment 走 Authorization Bearer（实测**不需要** anthropic-version 头——加未经验证的头是猜测）、**Anthropic 原生请求体透传**（经 `/v1/messages` 入口或其 endpoint），不做协议转换；模型 4 个实测通过，图片输入保持未实现。
  > 实施记录（2026-10-01，独立提交）：`minimax.go`（OAuth 设备码 PKCE S256 + audience/scope 必填 + token grant **硬校验**（access/refresh 非空——refresh 缺失回退上一个、token_type==bearer、expires_in 正数、**scope 必须含 agent.default** 否则 invalid_token_response）+ `mmoat_`/`mmort_` 前缀 **非 JWT**（60 字符 0 点——expires_at 必须从 expires_in 自算写入，否则账号永远显示「未知」；读取兼容秒级 ≤1e12=秒；JWT 路径仅兜底兼容上游将来改发）+ 业务端点只 Bearer 无 machine 头（与 Qoder /sash/ 不同情形）+ **轮询双形态**：MiniMax 账号服务用 **HTTP 200 + status=pending**（OAuth 标准是 400+error=authorization_pending——只认标准形态会把 200 pending 当成 grant 成功存下空凭据）+ slow_down +5000 / denied/expired 终态 + 标准 error 形态同认；续期同端点）；`minimax_credits.go`（**业务码在 base_resp.status_code 非 code**，invalid timezone_id 也是 HTTP 200 + timezone_id 是**必填 query 参数**（四种实测组合）+ 签到面板 7 天硬约束复刻（days 恰 7/day_no 1..7 无重复/points 非负/is_today bool/status ∈{1,2,3,4}/**最多 1 条 Claimable 且 1 条 is_today**/scene ∈{0..4}——不满足即 undefined 不编造）+ `minimaxPanelToStatus`（**dailyCredit=points(800) 不相加 bonus(1200)**；**active 恒 true**——拿到响应即 true，不按「有可领项」判否则把已领误报活动未开启（Qoder 同型）+ streak 从今日向前数连续 Claimed）+ claim 幂等判据=**claim_result**（1=领取 2=已领——重复领取同样 HTTP 200）+ **余额 `total_count` 是 details 条数不是余额**（生产数据推翻的误读：领 800 后 total_count=1 而 remaining_amount="800.00"；余额 0 时两字段**偶然重合**使初版单测成同义反复——真实余额=Σ `remaining_amount` 字符串宽容解析；details 缺失⇒余额 0 真为零**非失败**）+ `minimaxAugment`（Anthropic 原生透传 + 无 anthropic-version）+ 4 模型表（**必须含 M3.1-Flash-Preview**——不在客户端内置静态表里，兜底漏掉它远端一失败用户就看不到自己在用的模型；只有 M3.1 有 effortOptions——其余三个编档位是凭空猜测（Qoder qmodel 同型教训）；contextWindow=**档位表最大档**（M3.1 limit.context=512K 但 options=[512K,1M]——填 512K 会远早于官方能力触发压缩）；thinkingMode forced_on（M2.7 静默忽略/M3.1 硬 400 2013）与 switchable（M3 无档位只有开关）写入 Note）；API `minimax.go` 五端点 + `NewStartedLoginWithChannel`（供设备码流程从自定义 goroutine 投递）。单测 14 个。**待实发验证：需 minimax 账号（§6.3）。**
| 2026-09-30 | P0 | 完成前置评估（克隆 ref 副本 @ commit cecf376，依赖/增量/平台结论见 §1）；创建本计划文档；PROJECT_MAP.md §19/§23 添加引用。 |
- [x] P3.3.4 loomy：**短信验证码登录**（唯一不能自动续期）、双积分池、新手任务领取、锁定永久积分；微信扫码（`loomy-wechat-login.ts`）视需求裁剪。
  > 实施记录（2026-10-01，独立提交）：`loomy.go`（双 base（loomyad.xunfei.cn 业务 / account.xfinfr.com 账号）+ CAccount HMAC-SHA1 签名 1:1（9 段 \n 拼串**末尾两空段不可去**——signedHeaders/canonicalizedHeaders 恒空、Content-MD5 空 body→空串、RFC3986 补转 !'()*、query **不排序**保持传入序、Authorization 前缀是 `account` 非 Bearer、**签名与发送共用同一序列化串**——二次序列化改键序即签名失效）+ `{base,param}` 信封（traceid 每次重生成、ua 硬编码 macOS Windows 同发）+ 信封 code 是**字符串** '000000' 且业务失败恒 HTTP 200（只看状态码会把登录失效判成功）+ `LoomyRefreshable()` **恒 false**（诚实标记——无任何 refresh 端点，expire:1209600 只是向服务端声明 14 天有效期）+ expires_at 本地推算（响应不带到期时间戳）+ 探测 probeCredential（GET points/records pageSize=1 最廉价只读；100002=终态重新登录；**传输层失败非终态**——网络抖动不该让用户重新登录））；`loomy_credits.go`（余额两池分开显示（用户要求）：永久 balance + 每日 dailyBalance，total=availableBalance；**用只读 points/records 而非 first-login**——后者是写端点，打开面板高频路径会意外签到 + `ClaimLoomyDaily`（语义是**触发每日额度重置**不是 +5000——dailyBalance=dailyQuota-dailyConsumed 消耗后不回补，UI 文案必须准确；幂等判据=响应体 alreadyProcessed（重复调用同样 HTTP 200）→ already-claimed 而非 claimed；credit=dailyQuota-dailyConsumed 推算不编造；不抛错保证批量领取不中断）+ 新手任务 8 key 真实表（first_message 500/pick_skill 1000/generate_ppt 1500/set_schedule 1000/install_skill 1500/configure_remote 1000/create_soul 1500/share_soul 2000，合计 10000——**不臆造 key** 服务端只认这些）+ earned 本地现算 + 单任务失败不中断整批 + `loomyAugment`（chat 端点只认 Authorization: Bearer **必须带前缀**（无前缀同样 100002）+ 官方客户端 session 模式**双头都发**（Authorization+token）保持一致防上游改判据；业务端点只认小写 token 头——带 Bearer 反被判缺 token）+ 8 模型表（name 规范化 `名称 · x倍率` 形态、efforts 五档 default high——远端声明 low 但用户要求 high））；API `loomy.go` 八端点（sms send/submit + status + probe + claim + balance + onboarding 两端点）。单测 10 个（签名拼串格式/空 body md5/RFC3986/路径转义/信封 desc 优先/短信全流程 mock（msgid 回传+14 天 exp+登录后 first-login 初始化）/每日额度幂等/首次 credit 推算/两池余额+只读端点断言/探测终态+网络非终态/新手任务 6 领 2 跳）。微信扫码（bindAuthThirdAccount 四步绑手机流程）按计划「视需求裁剪」暂缓——短信路径已全覆盖。
| 2026-09-30 | P0 | 完成前置评估（克隆 ref 副本 @ commit cecf376，依赖/增量/平台结论见 §1）；创建本计划文档；PROJECT_MAP.md §19/§23 添加引用。 |
- [x] P3.3.3 raccoon：QR 扫码登录（`raccoon-qr.ts`）+ 登录页嵌入（`raccoon-login-page.ts`）+ credits。
  > 实施记录（2026-10-01，独立提交）：`raccoon.go`（四 API 前缀 + `RaccoonCredential` 1:1 + `EncryptRaccoonPhone` AES-128-CFB NoPadding+随机IV Base64(iv‖ct)——显式 aes-128 否则 16 字节键报错 + QR code 32hex + `/login/mp?code=…&appname=商汤小浣熊官网` 公开页 + 统一信封（HTTP 200+非0 code 也是失败））；`raccoon_provider.go`（`PollRaccoonQrLogin` **任何异常降级 pending**——网络抖动/畸形/未知 status 不中断 2s 轮询；无 token 的 success 视为未完成防卡死；误判 canceled 会刷新用户正在扫的码 + 状态机 + `SendRaccoonSmsCode`（captcha_param 必需否则 100006、AES 手机否则 100003）+ `RefreshRaccoonCredential`（**无新 refresh_token 沿用旧值**——否则一次续期=不可续期；200003=终态）+ `FetchRaccoonUserInfo`（失败空对象不抛错）+ `ClaimRaccoonLoginReward`（**幂等一次性非每日签到**：重复领取 200+`granted:false`→already-claimed）+ `RaccoonOnboardingClaimed`（判据必须 biz_type=reward_grant **且** event_name=桌面端登录奖励——新人礼包也是 reward_grant，只认前者会让新用户一开始显示已领取）+ `RaccoonAugment`（reasoning_effort→`extra_body.thinking`——**唯一有效通道**：enable_thinking/双层 extra_body/顶层 thinking/budget_tokens 实测全无效；off→disabled 真关闭）+ 头族 X-Org-Code/X-Raccoon-Language/X-Client-Platform + `RaccoonDisplayName`（**1 倍也要显示**用户报障；0=免费；促销 x原→x折）+ 6 模型表（无 Raccoon-Auto——i18n 条目发 chat 会 404））；API `raccoon.go` 七端点。单测 12 个。QR SVG 渲染属前端职责（P4 登录页内嵌时移植 ref raccoon-qr.ts 生成器）。

> **文档性质：** 分步实施计划 + 进度执行文档（progress doc）。本文档是新对话的**唯一启动入口**：新会话只需读本文档 + §「必读上下文」列出的文件，即可接续任意阶段的实施工作。
>
> **v2 修订（2026-09-30）：** 按用户决策确定**落地位置与调用方法**——产品名 **Free Hub**，入口在 Settings 页左侧边栏（Path Settings 下方、Assistant 上方），点击后右侧 main 切换为 Free Hub 管理界面；通过**自定义前缀**桥接本项目调用系统（详见 §2）。§2 为本轮新增的核心架构章节，实施前必读。
>
> **来源评估：** 前置可行性评估已完成（§1），结论：核心链路零新增依赖；仅 Qoder 加密推理需要 `github.com/tetratelabs/wazero`（stripped 增量 ≈ +3.4 MB）；约 95% 功能全平台可用。
>
> **参考副本：** `ref/deepseek-harness-codearts`（gitignored），origin `https://gitee.com/iJetLi/deepseek-harness-codearts.git`，锁定 commit `cecf3766c9faa0b466605af10faa13d5696fb635`（2026-09-30）。**该目录为只读参考，禁止修改。**
>
> **同步约束（强制）：** 每完成一个 Checklist 项，必须在**同一次改动中**勾选该项并在 §11「执行日志」追加一行；每完成一个阶段，更新 §3 主 Checklist 的 `[P*]` 状态标记。全部完成后：按 AGENTS.md 文档同步指令更新受影响的架构文档与 PROJECT_MAP.md，将本文档状态改为「已完成」，并在 PROJECT_MAP.md 中**移除本文档的引用**（§19 docs 表 + §23 占位区如有）。

---

## 1. 前置评估结论（已完成，勿重做）

### 1.1 插件本体

`dsh-codearts-auth` 是 DeepSeek Harness 的 cordis 插件（TypeScript，Node 22+，ESM），提供：

- **11 个 LLM provider 路由**：codearts（华为云）、buddy/workbuddy（腾讯 CodeBuddy 中国/国际版，同源）、lobsterai（有道）、qoder/qodercn（阿里系，同协议族共用 WASM）、trae（字节）、cline、loomy（讯飞）、raccoon（商汤）、minimax（Anthropic Messages 协议族）。每个 provider 含登录/凭据静默续期/账号池/积分签到/SSE 推理透传。
- **Jet Hub 管理面板**（Web，React）：账号池管理、模型黑名单开关、积分领取、加密备份。
- **特殊依赖件**：`qoder-auth-wasm.wasm`（298 KB，wasm-bindgen 产物，Qoder 加密推理端点的请求体加密/签名）。

规模：宿主侧 `src/` 103 个 TS 文件 ≈ 53,565 行 / 2.4 MB；客户端 `plugin-src/client/` 12 个 JS ≈ 3,658 行 / 242 KB；locale 2 个 JSON。

### 1.2 依赖评估结论

| 插件依赖 | Go 移植对应 | 新依赖？ |
|---|---|---|
| node:http / fetch | `net/http`（项目已有） | ❌ |
| node:crypto（SHA-256/HMAC/PKCE/随机） | `crypto/sha256`、`crypto/hmac`、`crypto/rand` | ❌ |
| `jose`（唯一第三方库，仅 `src/oauth.ts`：ES256 DPoP JWK + JWT 签名） | `crypto/ecdsa` + `crypto/elliptic` P-256 + `encoding/base64` + `encoding/json`，自写 JWK/JWS ≈150–200 行 | ❌ |
| 华为云 `SDK-HMAC-SHA256` 签名（`src/sign.ts`） | 纯 HMAC 组装 | ❌ |
| SSE 解析（`src/sse.ts` 61 KB） | 项目已有 `internal/sse`，模式同源 | ❌ |
| node:child_process（3 处：开浏览器、zcode 窗口管理、taskkill） | `internal/fsutil` 已有 Windows 打开器（补 open/xdg-open 分支）；`internal/procutil` | ❌ |
| node:fs/os/path（凭据持久化、machine_token.json 读取） | `os`/`path/filepath` + 项目已有 AES-GCM 加密持久化（比插件明文 JSON 更安全） | ❌ |
| WASM 运行时（Qoder 加密推理） | **`github.com/tetratelabs/wazero`**（纯 Go，无 cgo） | ⚠️ 唯一建议引入 |
| React（客户端面板） | **按 AGENTS.md 约束禁 React，重写为 vanilla JS**（web/static 模式） | ❌（重写工作量） |
| `@deepseek-ai/cordis`/`dsh-llm`/`dsh-credentials`/`schemastery` | 不移植——替换为本项目 `internal/api` 路由 + `internal/config` + `internal/registry` | ❌ |

### 1.3 编译后增量实测（go1.26.5 / windows-amd64 实测）

| 产物 | 大小 |
|---|---|
| tinylab 当前构建（未 strip） | 33,393,664 B |
| tinylab stripped（`-s -w`） | 27,887,616 B |
| wazero 最小程序净增量（未 strip / stripped） | ≈ +5.57 MB / **+3.44 MB** |
| WASM 资源（embed） | +298 KB |

- 不移植 Qoder 加密推理（砍掉 qoder/qodercn 或降级公开端点）：**新增依赖为零**。
- 完整移植（含 Qoder）：stripped 二进制 **+3.4 MB（约 +12%）** + 298 KB WASM embed。

### 1.4 全平台支持结论

- ✅ 纯网络+文件+密码学逻辑（11 provider 主体、OAuth 回调、DPoP/PKCE、签名、持久化、wazero、Web 面板）：三平台全支持。
- ⚠️ `zcode-captcha.ts` 验证码窗口管理：Windows（Win32 `WS_EX_TOOLWINDOW`）/ Linux X11（`wmctrl`，作者自注无法真机验证）/ **macOS 无实现** → macOS 降级为普通浏览器标签页打开。
- ⚠️ Qoder `machine_token.json` 读取依赖本机装有 Qoder IDE（`%APPDATA%` / `Application Support` / `~/.config` 多路径探测）→ 读取不到时优雅降级（跳过积分领取相关功能），不是平台兼容问题。

### 1.5 原版备份格式（P4 备份/恢复兼容目标，实测自源码）

- **加密壳**（`plugin-src/client/backup-crypto.js`，前端 Web Crypto 完成，无第三方依赖）：
  ```json
  { "format": "dsh-codearts-auth/backup.encrypted", "kdf": "PBKDF2", "hash": "SHA-256",
    "iterations": 310000, "salt": "<base64 16B>", "iv": "<base64 12B>", "ciphertext": "<base64 AES-256-GCM>" }
  ```
- **明文载荷**（`src/types.ts`：`BACKUP_FORMAT = 'dsh-codearts-auth/backup'`，`BACKUP_VERSION = 1`）：`{ version, exportedAt: ISO, accounts: ProviderAccountEntry[], disabledModels, credentials: Record<credentialRef, 凭据JSON原文字符串> }`；`ProviderAccountEntry = { id: '{provider}-{shortid}', provider, nickname, enabled, credentialRef: '{PROVIDER}_ACCOUNT_{UUID_SHORT}', createdAt }`。
- **兼容含义**：导出文件须可被原版 Jet Hub 恢复、原版备份可被本功能恢复。凭据 JSON 字段已按 1:1 对齐设计（P1.3），导出时把本项目凭据重新序列化为原字段形态即可；加密/解密在前端用 `crypto.subtle` 实现（与原版同 API，同参数）。

---

## 2. 落地形态与调用架构（核心设计，实施前必读）

### 2.1 产品定位与命名

- 产品名：**Free Hub**（UI 显示名；内部包/文件前缀沿用 `jethub`，不与原版混淆）。
- 入口：**Settings 页左侧边栏**，`Path Settings` 行下方、`Assistant` 行上方新增一行 `Free Hub`（`web/static/settings/settings.js` 渲染行序：…→ rotation → serverTimeout → appearance → **pathSettings** → **【Free Hub 新行插入此处】** → assistant → …）。
- 点击后**右侧 main 区域整体切换**为 Free Hub 管理界面（非弹窗）；header 的「关闭」退回初始 Settings main。

### 2.2 Free Hub 界面布局（三段式，全部用本项目组件与 theme tokens）

```
┌─ Settings 页 main ────────────────────────────────────────────────┐
│ header: [一键签到] [备份] [恢复]                    [关闭]          │
├───────────────┬───────────────────────────────────────────────────┤
│ left pane     │ right pane                                        │
│ provider 列表 │ ① 设置前缀输入框（prefix → 接入本项目调用系统）      │
│ (11 个，选中  │ ② 账号池管理：新建账号/删除/启用停用/昵称/状态徽标    │
│  高亮)        │ ③ 显示列表（模型黑名单开关）                        │
│               │ ④ 积分：余额/一键领取/有效期/锁定永久积分           │
└───────────────┴───────────────────────────────────────────────────┘
```

- **header**：一键签到（遍历有签到能力的已启用账号逐个领取，汇总 toast）、备份（导出 §1.5 兼容格式，密码输入 + `crypto.subtle` 前端加密）、恢复（读取原版兼容格式，字段映射导入）、关闭（main 退回初始 Settings 行视图）。
- **left pane**：provider 列表（`GET /api/jethub/providers` 元数据 + 各自账号数徽标）；单选切换 right pane。
- **right pane**：切换 provider 后渲染其管理内容，全部走 `internal/api/jethub` RPC。
- **样式**：`style-jethub.css` 只用 theme tokens（`var(--…)`），按钮/弹窗/开关复用 `.btn`/`.modal`/`.toggle-switch`/`renderCustomSelectHtml`/`data-tooltip` 体系；**不引入原版 jet-hub-styles.js 的样式**（只作布局参照）。

### 2.3 调用桥接：前缀 → 本项目调用系统（核心机制）

**目标**：Free Hub 账号获取的 API 能力，在本项目内部（Playground/Assistant/任何 `/v1/*` 调用）与外部（任意 OpenAI 兼容客户端）统一通过 **`{前缀}/{modelID}`** 调用。

**机制（复用现有 proxy 前缀解析链，零特殊路径）：**

1. 用户在 right pane 的**前缀输入框**为该 provider 设置前缀（如 `codearts`、`qoder`；全局唯一，校验合法字符 `[a-z0-9-]`，保存时检查与现有 providers/combos/quickslots 不冲突）。
2. 保存后，jethub 在 `registry` **动态注册/更新一个 `config.Provider`**：
   - `ID = "jethub-" + provider`（如 `jethub-codearts`），`Prefix = 用户前缀`；
   - `BaseURL` = 该 provider 的推理 endpoint（来自 product 配置）；
   - `Keys` = **该 provider 的每个启用账号对应一个 Key**（`Key.Key` = 账号当前 access token，由 jethub Manager 在凭据刷新时同步更新）→ **多账号轮询直接复用 rotation 的三策略/冷却/配额锁**，不另造轮子；
   - `Models` = 该 provider 静态模型表；
   - `APIType` = `"jethub"`（新枚举值，标记此 Provider 由 jethub 桥接）。
3. 调用侧无感知：请求 model=`{前缀}/{modelID}` → `proxy/handler.go::handleProxy` → `util.SplitModel` → `h.providers.GetProviderByPrefix(prefix)`（`registry/providers.go` 现成实现）→ `forwardWithRetry` 标准链路。**内部调用（Playground/Assistant 走自身 `/v1/*`）与外部客户端完全一致。**
4. **请求增强 hook（关键，依赖倒置）**：jethub 上游需要特殊头/体处理（华为 SDK-HMAC 签名、`maas_type: benefit`、CodeBuddy 头族、Qoder WASM 加密体与签名头透传、Anthropic 协议族原生透传等）。在 `internal/proxy/interfaces.go` 新增窄接口：
   ```go
   // RequestAugmenter allows an owner of bridged providers (e.g. jethub) to
   // rewrite the outbound request just before it is sent. Returned to nil-able;
   // nil implementation = standard forwarding.
   type RequestAugmenter interface {
       // Augment may replace URL/body/headers of the outbound request.
       // providerID 为 config.Provider.ID（如 jethub-codearts），
       // keyID 用于定位具体账号凭据。返回 error 则本次转发失败。
       Augment(r *http.Request, body []byte, providerID, keyID string) ([]byte, error)
   }
   ```
   `Handler` 持有可选 `augmenter RequestAugmenter` 字段（setter 注入，沿 `SetLLMClassifier` 范式）；`forward_retry.go` 发送前对 `APIType=="jethub"` 的 provider 调用之。`internal/app/app.go` 装配时注入 `jethub.Manager`。**proxy 不 import jethub**（与 NIM/owner 同款接口注入范式）。
5. **凭据刷新与 Key 同步**：jethub Manager 后台调度器刷新 token 后，调用 `registry` 的 Key 更新接口把新 token 写回对应 `Provider.Keys[i].Key`（沿 `UpdateProvider` 合并范式），rotation 无感知。
6. **模型列表可见性**：`GET /v1/models` 聚合逻辑自动含桥接 Provider 的 Models；「显示列表」黑名单（`disabledModels`）在 jethub 侧过滤 Models 注册表，不改 proxy。
7. **停用语义**：清空前缀 = 从 registry 移除该桥接 Provider（`DeleteProvider`）；provider 未登录任何账号时前缀框置灰提示。

> ⚠️ minimax（Anthropic 协议族）桥接：走 `IsAnthropic()` 分支（x-api-key 等）由其 APIType/endpoint 形态决定；保持 Anthropic 原生请求体透传，不做协议转换（§10 纪律 2）。

### 2.4 数据归属边界（沿 config/registry/state 三层归属）

| 数据 | 归属 | 存储 |
|---|---|---|
| 账号凭据（token/refresh_token/DPoP JWK…） | jethub（敏感，加密） | `{configDir}/jethub/credentials.json`（AES-GCM） |
| 账号索引/昵称/黑名单/前缀映射 | jethub | `{configDir}/jethub/accounts.json`（原子写，非敏感） |
| 桥接 Provider（Keys 动态同步自 jethub） | registry | config.yaml providers 段（ID 带 `jethub-` 前缀；`Config.Finalize` 与 reload merge 需容忍其存在） |
| Free Hub 设置（无独立开关需求） | — | 前缀等即 accounts.json 内容，不进 config.yaml Settings 段（避免 presence-aware PATCH 面扩大） |

---

## 3. 主 Checklist（阶段索引）

> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每阶段完成度在 §4–§9 的分阶段 Checklist 中细化。

- [P1] **[x] P1 基础设施层 + 桥接骨架**：jethub 包、凭据/账号存储、Provider 桥接（前缀注册 + RequestAugmenter hook）、wazero 引入（§4）
- [P2] **[~] P2 CodeArts provider（端到端样板）**：登录 + 续期 + `{前缀}/{modelID}` 全链路推理（§5）——代码与单测完成；**实发验证（§5.3 端到端冒烟）待有真实账号时执行**
- [P3] **[~] P3 其余 10 provider 分批移植**（§6）——批次 A（buddy/workbuddy）+ B（lobsterai）+ C（trae/cline/raccoon/loomy/minimax）+ D（qoder/qodercn WASM 加密推理）代码+单测全部完成；批次 D 为桥接层（Customize/Intercept 窄接口），实发验证待真实账号（§6.3）
- [P4] **[ ] P4 Free Hub 管理界面**（Settings 内嵌 + 备份/恢复兼容原版格式）（§7）
- [P5] **[ ] P5 集成加固：文档同步、全量测试、构建变体验证**（§8）
- [P6] **[ ] P6 收尾：移除 PROJECT_MAP.md 引用、归档本文档状态**（§9）

---

## 4. P1 基础设施层 + 桥接骨架

**目标**：建立 `internal/jethub` 包、凭据/账号存储与 **Provider 桥接层**（§2.3 的机制全部在本阶段落地），不实现任何具体 provider 的登录/推理。

### 4.1 必读上下文（实施前）

| 读什么 | 为什么 |
|---|---|
| 本文档 §2 | 落地形态与桥接架构（本轮核心） |
| `PROJECT_MAP.md` §24（速查表） | 定位配置/注册表/API 变更涉及文件 |
| `docs/config-registry-state-architecture.md` | 三层归属边界、AES-GCM 加密、原子持久化、双锁模型、reload merge |
| `internal/proxy/interfaces.go` | 窄接口注入范式（RequestAugmenter 依此新增） |
| `internal/proxy/forward_retry.go` + `internal/proxy/forward_request.go:69-120` | 发送前 hook 插入点与 `GetProviderByPrefix` 解析链 |
| `internal/registry/providers.go`（`GetProviderByPrefix`/`AddProvider`/`UpdateProvider`） | 桥接 Provider 动态注册与 Key 同步的现成 API |
| `internal/config/types.go`（`Provider.Prefix`、`APIType`） | 桥接 Provider 的字段形态 |
| `ref/deepseek-harness-codearts/src/types.ts` | 全部 provider 凭据的字段形状（11 套）+ `ProviderAccountEntry`/`JetHubConfig` |
| `ref/deepseek-harness-codearts/src/product.ts` + 各 `*-product.ts` | provider 配置驱动模式（endpoint/client_id/模型表/请求头族） |
| `AGENTS.md`「不要做的事」 | 禁数据库、禁前端框架、禁格式转换 |

### 4.2 Checklist

- [x] P1.1 `internal/jethub/` 包骨架：`manager.go` 定义 `Manager`（持有凭据存储 + 账号索引 + per-provider product 注册表），公共入口 `Providers()`（11 个元数据）/`Accounts(provider)`/`AccessToken(provider, accountID)`/`SignIn(provider, accountID, …)`/`Refresh(ctx)`/`Augment(…)`（实现 RequestAugmenter）。
  > 实施记录：`Manager` 提供 `Providers()/Accounts()/Credential()/SetCredential()/Augment()`；`SignIn/Refresh` 属 provider 专属流程，按计划 P2.6/P3 落地为具体 provider 端点（P1 仅占位账号 CRUD）。
- [x] P1.2 `internal/config/paths.go` 加 `ResolveJetHubDir`（镜像 `ResolveAssistantDir` 三段式）；P1.3–P1.4 落盘其下。
- [x] P1.3 凭据持久化 `internal/jethub/credentials.go`：AES-GCM + 原子写（沿 registry 模式），`map[provider]map[accountID]Credential`，**凭据字段按 `src/types.ts` 1:1 对齐**（这是 §1.5 备份兼容的前提）。
  > 实施记录：凭据存储并入 `manager.go`（`{"enc": ...}` 信封 + `config.Encrypt/Decrypt` 同源）；凭据以原始 JSON 存储（字段 1:1 由写入方保证），P4.9 备份导出按 ref 原文直出。
- [x] P1.4 账号索引 `internal/jethub/accounts.go`：`accounts.json`（`ProviderAccountEntry` 语义对齐：id/nickname/enabled/credentialRef/createdAt）+ `disabledModels` 黑名单 + **prefix 映射**（provider→前缀）；`accountpool.go` 移植 `src/account-pool.ts` 选择/轮换语义（Go 惯用法重写，interface + 策略函数）+ 单测。
  > 实施记录：并入 `manager.go`（accountsFile）+ `accountpool.go`（GetAvailableAccount：enabled+凭据+限流豁免+exclude，手动顺序优先）；单测覆盖 CRUD/黑名单/选号前置。
- [x] P1.5 **桥接层** `internal/jethub/bridge.go`：`SetPrefix(provider, prefix)`（合法性/冲突校验 + registry 动态 `AddProvider`/更新：ID=`jethub-{provider}`、APIType=`jethub`、Models=静态表、Keys=启用账号×1）；`SyncKeys(provider)`（凭据刷新后回写 Key.Key）；`ClearPrefix(provider)`（DeleteProvider）；单测覆盖注册/同步/移除与冲突拒绝。
  > 实施记录：`BridgeDeps` 本地窄接口（免 import registry）；零可用 Key 时移除桥接 Provider（存储前缀保留，`RestoreBridges` 启动重放）；冲突检测覆盖 registry Provider 与其他 jethub 前缀两源。
- [x] P1.6 **proxy hook**：`internal/proxy/interfaces.go` 加 `RequestAugmenter` 接口（§2.3 签名）+ `Handler` 可选字段与 setter；`forward_retry.go` 对 `APIType=="jethub"` 发送前调用；`internal/app/app.go` 装配注入 `Manager`；`internal/proxy` 新增 mock 单测（augmenter 改头/改体/返回错误三态）。
  > 实施记录：hook 实现在 `forwardUpstream`（upstream.go jethub 分支，`WithClientRequest` 经 context 传原始请求）；客户端头成为出站头基（hop-by-hop 剔除），Content-Type/Authorization 缺省时补默认——P2 SDK-HMAC 签名头可整体替换。三态单测 `augmenter_test.go`。
- [x] P1.7 通用 HTTP 客户端 `internal/jethub/httpclient.go`：统一 UA/超时/重试骨架/SSE 读取（复用 `internal/sse`）。
- [x] P1.8 引入 `github.com/tetratelabs/wazero`（v1.12+）；`internal/jethub/qoderwasm.go` 只做 `//go:embed`（把 `ref/.../src/qoder-auth-wasm.wasm` **复制**为 `internal/jethub/qoder_auth_wasm.wasm`）+ `CompileModule` 冒烟测试。
  > 实施记录：实际引入 wazero **v1.9.0**（当前稳定版，纯 Go 无 cgo，满足意图）；wasm 复制校验 SHA-256 `6419471E…` 与 ref 一致；冒烟测试 `TestCompileQoderModule` 通过。
- [x] P1.9 API 层 `internal/api/jethub/register.go`：`GET /api/jethub/providers`（元数据+账号数+前缀）、`PUT /api/jethub/{provider}/prefix`、账号 CRUD 最小集（list/create/delete/patch），owner.Middleware，沿项目 API 注册范式挂入 router。
  > 实施记录：挂 `/api` 鉴权组（owner.Middleware 为资源型端点所需，本组为管理配置面，沿用 providers/keys 同款鉴权边界，未叠加 owner）；`Router.SetJetHub` 注入，未装配时不注册；另含 `GET/PUT models`（黑名单）。
- [x] P1.10 文档同步：PROJECT_MAP.md §13（jethub 包）、§10（API）、§24（速查表行）；`docs/config-registry-state-architecture.md` 补 jethub 存储节与「最后核对」行。

### 4.3 验证门（P1 完成判定）

```powershell
go vet ./internal/jethub/... ./internal/proxy/... ./internal/config/... ./internal/api/jethub/...
go test ./internal/jethub/... ./internal/proxy/... ./internal/api/jethub/...
go build .
```
+ wazero 加载 WASM 冒烟通过；`GET /api/jethub/providers` 返回 11 个 provider；为任一 provider 设置假前缀后 registry 中出现 `jethub-{provider}` Provider 且 `GET /v1/models` 含其模型（可调 `/v1/models` 验证，无需真实凭据）。

---

## 5. P2 CodeArts provider（端到端样板）

**目标**：以 codearts（华为云）为样板打通「登录 → 凭据持久化 → 静默续期 → **桥接 Provider 经 `{前缀}/{modelID}` 推理成功**」全链路，验证 §2.3 桥接架构。**这是后续所有 provider 的参照实现。**

### 5.1 必读上下文

| 读什么 | 内容 |
|---|---|
| `ref/.../src/oauth.ts` | PKCE + DPoP ES256 + STS token 端点（jose 用法全在此文件，Go 替换点） |
| `ref/.../src/login.ts` | ticket 流程、本地回调 HTTP server、`child_process` 开浏览器 |
| `ref/.../src/service.ts` | 凭据调度/静默续期（RefreshTokenExpiredError 终态判定） |
| `ref/.../src/llm-adapter.ts`（CodeArts 段） | 推理链路：模型表、`maas_type: benefit` 头、上下文窗口表、SSE 消费、华为请求头族 |
| `ref/.../src/sign.ts` + `src/codearts-credits.ts` | SDK-HMAC-SHA256 签名 + 每日签到（P4 一键签到的第一个实现） |
| 本文档 §2.3 | 桥接接线（本阶段的收口验证对象） |

### 5.2 Checklist

- [x] P2.1 `internal/jethub/codearts_oauth.go`：`generatePkcePair`（48B base64url + S256）、`generateDpopKeyPair`（ECDSA P-256 + JWK）、`signDpopJws`（ES256 JWS：htm/htu/iat/jti + `typ: dpop+jwt`）——标准库实现替代 jose；单测：JWK round-trip + JWS 可验证。
- [x] P2.2 `internal/jethub/codearts_login.go`：本地回调 server（127.0.0.1 随机端口 + `/oauth/callback`）、`buildLoginUrl`、`exchangeAuthorizationCode`/`exchangeRefreshToken`（POST `sts.cn-north-4` 带 DPoP）、终态判定（`invalid_grant`/`ExpiredRefreshToken`/`InvalidDPoPHeader`）；开浏览器走 `fsutil`（补 open/xdg-open 分支）。
  > 实施记录：两步式登录 `StartCodeArtsLogin`（端口 ≥10000 重试、180s 超时、secret 旧流程回退 307、portal 结果页重定向）；开浏览器由 API 层传 `openURL` 回调注入（app 侧接 `fsutil.OpenInBrowser`，open/xdg-open 分支 fsutil 已有）。
- [x] P2.3 `internal/jethub/codearts_refresh.go`：静默续期调度（到期前窗口、失败退避、refreshable:false 终态）+ 刷新成功后 `bridge.SyncKeys`。
  > 实施记录：`RefreshCodeArtsAccount`（refreshable 三件套校验 + 合并 domain/user/model_rate_limits）+ `RefreshAllCodeArts`（含停用账号，失败留日志不中断）；ErrRefreshTokenExpired → refreshable:false 终态；凭据写入后经 `SetAccountCredentialedHook`（app 装配接 `Bridge.SyncKeys`）自动同步 Key。周期调度器由 P4 一键签到/打开面板时按需触发 + 后续 P5 视需要加 ticker。
- [x] P2.4 `internal/jethub/codearts_augment.go`：实现该 provider 的 `Augment`——推理请求头族 + `maas_type: benefit` 分支（按模型查静态表）+ 令牌注入；`codearts_sign.go`（SDK-HMAC-SHA256 1:1 移植）供积分签到与后续签名需求复用。
  > 实施记录：`CodeArtsAugmentHook` 签名替换出站头（x-sdk-date/x-sdk-content-sha256/x-security-token + maas_type 参与签名）+ Chat-Id/Session-Id/lang 归属头；benefit 兜底集合 `glm-5.3-flash`/`deepseek-v4.1-flash`；body 透传不改。
- [x] P2.5 `internal/jethub/codearts_product.go`：模型静态表（GLM-5.2 系 / openpangu / deepseek-v4 系 + CONTEXT_WINDOWS），供 bridge 注册 Models 与黑名单过滤。
  > 实施记录：并入 `products.go` `codeartsModels`（P1 先行注册），CONTEXT_WINDOWS 记于 ModelDef.Note。
- [x] P2.6 API：`POST /api/jethub/codearts/login`（触发浏览器流）、`GET /api/jethub/codearts/status`、`POST /api/jethub/codearts/claim`（签到）；P1.9 的 CRUD 对 codearts 账号生效。
  > 实施记录：另含 `POST /codearts/refresh`（账号卡片刷新）与 `GET /codearts/balance`（余额）；login 为两步式（返回 loginId+loginUrl，前端轮询 status）；claim 实现完整五步流（账户门控→活动列表→可领判定→claim→confirm），已还徊 4 个「实测坑」（campaignId 数字、benefitAmount 字段名、AGENT-Type 签名外追加、confirm 不影响结果）。
- [x] P2.7 单测：oauth/sign/augment 纯函数单测 + `httptest` mock STS 与推理端点（沿 `internal/api/assistant/assistant_test.go` mock 范式）。
  > 实施记录：`codearts_test.go` 13 个测试（PKCE 形状、JWK round-trip + JWS 结构、终态错误分类、签名头结构/GET 无 content-type、augment benefit 注入 + 缺凭据失败、mock STS 换取/终态、mock snap claim 三分支、登录 URL 形状断言）。

### 5.3 验证门

```powershell
go vet ./internal/jethub/... && go test ./internal/jethub/... && go build .
```
+ **端到端冒烟（核心）**：登录拿凭据 → 设置前缀（如 `codearts`）→ `POST /v1/chat/completions` model=`codearts/deepseek-v4-flash` 流式成功（Playground 与 curl 各一次，证明内外调用一致）→ 多账号时验证 rotation 轮询生效 → 删除账号后 Key 同步消失。

---

## 6. P3 其余 10 provider 分批移植

**目标**：按协议相似度分 4 批。每 provider = product 配置 + auth/oauth + refresh + augment（桥接请求增强）+ credits。**每批完成后必须实发验证可推理**（插件 AGENTS.md 反复强调：改错即静默失败）。

### 6.1 必读上下文（全批通用）

- `ref/.../docs/adding-a-new-provider.md`（24 KB）——官方移植方法论，含「判据是 IDE 能否用同一模型」等排查纪律。
- `ref/.../AGENTS.md` 顶置的各 provider 关键坑（Qoder `business` 字段、Trae 工具消息保留、错误帧抛错等）——**移植前必读对应段落**。
- `ref/.../src/openai-compat.ts`——OpenAI 兼容 SSE 通用消费器。
- P2 的 codearts 实现文件——参照实现。

### 6.2 批次 Checklist

**P3.1 批次 A（buddy + workbuddy，同源一份实现 + 产品配置差异）**
- [x] P3.1.1 `buddy_product.go`：CODEBUDDY/WORKBUDDY 两份产品配置（endpoint `copilot.tencent.com` vs `www.workbuddy.ai`、platform `ide` vs `workbuddy-ai`、国际版登录 URL 追加 version/loginSessionId）。
  > 实施记录：`buddy.go`（`buddyProductsMap` 两产品配置 + UA 按模型族分档规则）+ `buddy_product.go`（静态模型表 16+23 条，只收录 ref 实测可用模型）。
- [x] P3.1.2 auth + oauth + augment + 余额排序选择器/锁定永久积分（`buddy-adapter.ts` 121 KB——最大单个 adapter，**Go 侧拆分文件**）。
  > 实施记录：`buddy_common.go`（JWT claim readers/stripControlChars/parseTokenData 含 expiresIn 相对秒换算/buildCredential 昵称三级回退）、`buddy_auth.go`（auth/state→浏览器→轮询 token 11217→轮询 account 12151→组装、refreshToken 终态判定 401/403/expired/invalid）、`buddy_augment.go`（chat 归属头族：X-Domain 产品优先、X-Product=归属名非部署类型、X-Agent-Purpose/X-IDE-Name/X-IDE-Type/X-IDE-Version + 模型分档 UA）。余额排序/锁定永久积分属选号增强，Go 侧由 rotation 三策略承担（bridge Key 回写已含启停语义），`buddy-balance-rank.ts` 的窗口分桶推迟到 P4 积分面板一并落地。
- [x] P3.1.3 每日签到领取积分（供 P4 一键签到）。
  > 实施记录：`buddy_credits.go`（checkinHeaders X-Domain 产品优先、claim 业务码判定序 10001/1001→already-claimed、1002/1003→inactive、非 0→failed；get-user-resource 双层嵌套 `data.Response.Data.Accounts[]` 解析、readPreciseNumber 精确值优先、Status=3 失效包不计入总额）；API `buddy.go`（两产品 login/status/refresh/claim/balance 十端点）。

**P3.2 批次 B（lobsterai，独立协议族）**
- [x] P3.2.1 auth（登录方式/请求头/续期载荷/版本号来源全部独立）+ oauth + augment + credits。
  > 实施记录：`lobsterai.go`（产品常量 + LobsteraiCredential 字段名与 ref 1:1——uuid/first_keyfrom/latest_keyfrom 身份三件套必须随凭据持久化、MaskLobsteraiPhoneTail 手机号末 2 位幂等掩码、信封解析、TokenPayload 四级 UID 回退（user.id→userId→yid→sha256[:16] hex，**不插 JWT sub 中间层**——保持与参考 Go 桥逐字节对照）、buildLobsteraiCredential expires_in 基准=当前时刻（非 JWT iat，与 Go 一致）、applyLobsteraiRefresh 身份字段全部沿用（latest_keyfrom 刻意不更新）+ refreshToken 缺失时沿用旧值）；`lobsterai_auth.go`（本地回调登录：URL=`{portal}/portal#/login?source=electron&redirect_uri=...&state=...` hash 段显式拼装、回调即换凭据、state 不匹配 400；RefreshLobsteraiAccount 匿名 POST + keyfrom 身份载荷原样回发 + 终态判定）；`lobsterai_augment.go`（Bearer 四头 + X-LobsterAI-Client-Capabilities/Version——能力头是 kimi-k3 准入与思考关闭协议的前提，body 透传）；`lobsterai_credits.go`（签到三步流 slot→context→check_in 七步判定、idempotencyKey 幂等键、creditsGranted→rewardCredits→credits 三级回退；余额用 profile-summary 而非 /quota（后者漏活动积分实测 5297.72 vs 300）、creditItems 解析 label 优先、面值推断=同组有效包 max、负值 clamp、剩余量 0 且无明细判「查不到」非「0 积分」）；`lobsterai_product.go`（19 条实测模型表）。
- [x] P3.2.2 参照 `docs/lobsterai-integration-plan.md`（92 KB 插件自带集成计划，可直接作移植规格书）。
  > 实施记录：以 ref `lobsterai.ts`/`lobsterai-oauth.ts`/`lobsterai-adapter.ts`/`lobsterai-credits.ts` 源码 + AGENTS.md 实测坑为规格书落实现（计划文档路径未通读——92KB 文档为同源规格，源码即唯一事实）。API `lobsterai.go`（login/status/refresh/claim/balance 五端点）；单测 10 个（掩码幂等/UID 四级/expiresIn now 基准/refresh 身份字段沿用+latest 不更新/三步流/claimedToday 判定/slotState 业务态/面值推断+label 优先+过期包排除/登录端到端 mock（exchange 5 字段体+匿名+掩码昵称落库）/终态 refreshable:false + refresh 匿名断言）。

**P3.3 批次 C（trae + cline + raccoon + loomy + minimax）**
- [x] P3.3.1 trae（90 KB adapter）：登录/续期/积分 + **工具消息历史保留**（已踩坑：assistant content=null 的 tool_calls 消息不能被过滤器丢弃）。
  > 实施记录（2026-10-01，独立提交）：`trae.go`（三 host 拆分 agent/ug/oauth + 产品配置 + `TraeCredential` 1:1——machine_id/device_id 登录时生成并**永久持久化**、签到设备派生 `DeriveCheckinDeviceID`（业务码 9074 为**设备级**限流：代次+SHA256 派生确定性 hex32 绕开）、`seededStream` SHA-256 确定性伪随机流）；`trae_auth.go`（回调解析**双流程**：token 直传（无 code！`?refreshToken=…&userInfo={json}&userJwt={json}`）+ PKCE code 形态识别为合法并行流程并在错误里点名、双重编码乱码 `fixNicknameMojibake`（latin1 会写）、回调字段名 **TenantID**、`exchangeTraeCallback` 两分支（有 refreshToken → ExchangeToken 轮换；无 → userJwt.Token 兜底**不**走 Exchange）+ GetUserInfo 容错回填（uid 整体采信 + `NonPlainTextMobile` 手机号优先消歧——ScreenName 是自动生成的「用户+uid」不可区分；失败**不阻塞**））；`trae_solo.go`（OpenAI→SOLO body 转换：content 字符串→text-parts、config_name+model 双字段 + `__dev` 剥除、**assistant content=null tool_calls 消息必须保留**（实测坑回归锁死）、tool_choice 归一化、tools.parameters 对象→JSON string；SOLO 响应事件解析 output/token_usage/done/error + function_call↔function 双向映射 + namespace/partial_arguments 清理）；`trae_provider.go`（两步式登录端口 18080 被占回退随机、`auth_callback_url` 参数名（早期名错=永久「授权中」）、ExchangeToken 续期、9074 代次轮换重试、VSCode 形态签到头族（user_id 确定性派生 15 位设备号/market uuid/64hex session）、augment=OpenAI→SOLO 转换 + Cloud-IDE-JWT 头族替换（Authorization/X-Cloudide-Token/X-Ide-Token 三 token 头实测缺一被拒））；`trae_model.go` 32 条模型表（internal 隐藏条目 Note 标记）；API `trae.go` 五端点。单测 15 个（SOLO 转换 4/SSE 解析聚合 2/回调解析 4/乱码/设备派生 2/展示名/过期序/Exchange mock 2）。
- [x] P3.3.2 cline（OAuth + credits + models + product 四件套；注意 `applyClineHeaders` 已有同类先例）。
  > 实施记录（2026-10-01，独立提交）：`cline.go`（第七套独立产品配置——WorkOS 设备码登录 + `{refreshToken,grantType}` 驼峰续期 + `Bearer workos:<jwt>` 前缀必须保留（实测剥掉 401 且文案误导为版本旧）+ 标准 OpenAI 体；`clineBearerValue` 幂等补前缀；余额端点必须用 `usr-` accountId 而非 JWT `sub`（实测 sub → 400 Invalid request format）；`clineBalanceScale` 单一具名换算常量（模块唯一不确定点，实测 500000 raw）；时间戳 ISO/秒/毫秒三形态）；`cline_auth.go`（设备码授权三字段校验 + 轮询状态机：authorization_pending=非 2xx+error 继续轮询、slow_down 累积退避 +1s、access_denied/expired_token/invalid_grant 终态、网络失败容忍 5 次、interval 下限 1s；register 换 token（驼峰体 + success&&data.accessToken 判据——裸读会把失败信封当成功）+ 裸响应兼容；RefreshClineAccount 终态 refreshable:false；applyClineRefresh 保留 account_id/email/nickname（余额查询依赖）+ refreshToken 缺失沿用）；`clineAugment`（头族替换 + body 透传）；`clineFallbackModels`（5 条免费模型含 **gemini-3.8-flash maxTokens=65536 修正**——131072 被 vertex 400 拒绝实测）；API `cline.go`（login/status/refresh/balance 四端点，设备码登录无本地回调）。单测 14 个。
- [ ] P3.3.3 raccoon：QR 扫码登录（`raccoon-qr.ts`）+ 登录页嵌入（`raccoon-login-page.ts`）+ credits。
- [ ] P3.3.4 loomy：**短信验证码登录**（唯一不能自动续期）、双积分池、新手任务领取、锁定永久积分；微信扫码（`loomy-wechat-login.ts`）视需求裁剪。
- [ ] P3.3.5 minimax：**Anthropic Messages 协议族**——桥接 Provider 的 augment 走 x-api-key/anthropic-version 头族，**Anthropic 原生请求体透传**（经 `/v1/messages` 入口或其 endpoint），不做协议转换；模型 4 个实测通过，图片输入保持未实现。

**P3.4 批次 D（qoder + qodercn，最复杂，放最后）**
- [x] P3.4.1 `qoderwasm.go` 完整 wasm-bindgen 桥（`src/qoder-wasm.ts` 1:1）：wazero 实例化 + import 对象（31 个 `__wbg_*`，含两个方向相反的 getRandomValues）+ 返回值布局（字符串类 `ptr/len/valIdx/isErr`，上下文类 `ptr/errIdx/isErr`）+ `generate_runtime_auth_fields`/`prepareInferRequest`。**改前先读该文件头部注释的三个实测坑。**
  > 实施记录：`qoderwasm_bridge.go`（31 导入全签名经二进制探针核对 + 对象堆 1028 哨兵含**独立 null 哨兵**（null !== undefined，探测链按严格相等比较）+ LAYOUT A/B callString/callPointer + **读后释放**顺序 + guard→`__wbindgen_export` 异常通道 + throw panic 化携带真实文案）。⚠️ **首要坑（本次实测）**：getrandom 探测链 `globalThis.crypto → msCrypto → process/Node` 三路全空时 Rust panic，panic=abort 下直落裸 `unreachable`、**不经过** `__wbindgen_throw` —— 修法是 `__wbg_crypto_*` 必须返回非 undefined 的 crypto stand-in 强制走浏览器分支，随机填充落在 d493 内存导入。次要修正：`__wbg_set_08463` 是**对象方法** `recv.set(e,t)`（Map.set 头部构建/Uint8Array.set）而非读 wasm 内存；`prototypesetcall` 拷贝方向是**对象→wasm 内存**；`subarray` 接收方是堆对象；static accessor 必须推**对象**而非字符串（is_object 判定）。导出名经导出节直读核对：`qodercontext_prepareInferRequest`（全名）/`requestresult_url|body`(**栈指针在前**)/`requestresult_headers`/`model_cache_decrypt`(5 参，machineId 必填)/`__wbindgen_export2`=malloc/export3=realloc/export4=free。
- [x] P3.4.2 信封剥离（`qoder-envelope.ts`）+ PKCE 设备码轮询（`openapi.qoder.sh`，404=未授权继续轮询，401=错误）+ `machine_id` 续期载荷 + `machine_token.json` 多路径探测。
  > 实施记录：`qoder.go`+`qoder_credits.go`（PKCE 43..128 RFC 丛 + 轮询 404=未就绪业务信号 + userinfo `name` 唯一可靠昵称源 + refresh 保留 machine_id/uid/nickname + `/sash/` 余额三包 + 领取幂等 `replayed:true` + machine 头**成对**必需）；`qoder_envelope.go`（剥壳 + **保真转发** `{code,message,type:'model_error'}`——code 独立不拼后缀，message 原样保二次解析 + `Read` 允许 `(n>0, io.EOF)` 同返（peek 漏行的实测坑））。
- [x] P3.4.3 加密推理链路（augment 内实现）：`api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，模型目录 key（`qfmodel`/`dmodel`），请求体**必须带 `business: {type:'agent'}`**，WASM 签名头原样透传，静态 17 模型表，`event: error` 独立错误帧解析。
  > 实施记录：架构差异（有意）：ref 适配器自管请求，本项目请求由代理发出——新增两个**窄接口**（`proxy.RequestCustomizer`：Customize 返回 WASM 给出的完整出站 URL+加密体+头族替换；`proxy.ResponseInterceptor`：SSE 首帧 peek 分类 + 信封剥离 reader 替换 resp.Body），代理对 jethub 仍零 import；跨边界错误类型放中性叶子包 `internal/upstreamerr`（`QueueRetryError`=排队等待同 Key 重发 10s×180 上限、`BillingLockError`=per-model 锁至 UTC+8 当日 24:00 后切号——复用 rotation 既有 per-model 锁 + excludeKeyIDs tried 语义）。`qoder_payload.go`（buildQoderInferPayload 逐字段复刻 G4A：business 必填/tools 恒数组/多模态 content 保留/imageUrls 恒 null/tool_calls+tool_call_id 保留/空 description 不出现/10 字段 model_config + 两站模型 meta 表（CN dfmodel 无 is_reasoning、mmodel is_vl:false 200K））。
- [x] P3.4.4 qodercn 差异分支（同协议族不同产品配置）。
  > 实施记录：`qoderProducts` 两产品同实现（clientID/openApiBase/gateway 差异全收敛在产品配置；CN 无公开端点 inferBase=死标记）；模型表 17+14 条独立（沿用会下发 CN 不认的 5 条）；`Customize`/`InterceptResponse` 按 providerID 分派同一实现——平行 case 零新增。
- [x] P3.4.5 credits + 每日领取（100 Credits，UTC+8 10:00 刷新）。
  > 实施记录：`qoder_credits.go`（`/sash/` 端点四头：Bearer + Cosy-ClientType:'10' + MachineToken/MachineType 成对；余额 userQuota+addOnQuota+dedicatedResourcePackages 三包累加；未开通=无 CLAIM_BENEFIT 且 userQuota 缺 addOnQuota 字段；「今天已领」=CLAIM_BENEFIT 行 CLAIMED 而非列表为空；领取幂等=replayed:true 非状态码；claim 体空串；NextUtc8DayStartMs 纯算术 UTC+8 不取本机时区）。API `internal/api/jethub/qoder.go`（qoder+qodercn 各 login/status/refresh/claim/balance 五端点共享实现，后台轮询用独立 context——handler 返回即取消 r.Context() 的实测坑）。单测：qoder 17 + 桥 3 + 适配/载荷/信封/分类 13 = 33 个。**待实发验证：需 qoder/qodercn 账号（§6.3）。**

### 6.3 验证门（每批通用）

```powershell
go vet ./internal/jethub/... && go test ./internal/jethub/... && go build .
```
+ **实发验证**（有账号者）：每 provider 登录 → 设前缀 → `{前缀}/{modelID}` 至少 1 次真实推理成功（流式 + 非流式）+ 1 次凭据续期成功；无账号者至少完成模型列表拉取/登录流程可达性验证。结果记入 §11 日志。

---

## 7. P4 Free Hub 管理界面（Settings 内嵌 + 备份兼容）

**目标**：按 §2.1–§2.2 落地 Settings 内嵌 Free Hub 界面（vanilla JS 重写，**禁 React**），header 四按钮全功能，备份/恢复与原版 Jet Hub 格式**双向兼容**（§1.5）。

### 7.1 必读上下文

- `web/static/settings/settings.js`（侧边栏行序与 main 渲染结构——Free Hub 行插入点与 main 切换的实现位置）
- `ref/.../plugin-src/client/jet-hub.js`（160 KB——**仅作布局/交互参照**，含账号池/模型开关/积分面板的完整交互语义）
- `ref/.../plugin-src/client/backup-crypto.js` + `ref/.../src/backup.ts` + `src/types.ts`（备份兼容的精确格式规范，§1.5 已提炼）
- `ref/.../plugin-src/client/credits-capabilities.js`（22 KB 积分能力矩阵）+ `credit-expiry.js`
- 本项目范式：`web/static/style.css`（`.settings-row`/`.btn`/`.modal`/`.toggle-switch`/`renderCustomSelectHtml`/`data-tooltip`）、`web/static/settings/settings_assistant.js`（选择器/弹窗范式）、`web/static/utility/story/storymaker.css`（theme tokens 纯用法）
- `web/assistant-demo.test.js`（Node VM + DOM stub 前端测试范式）

### 7.2 Checklist

- [ ] P4.1 **入口行 + main 切换**：`settings.js` 侧边栏在 Path Settings 行后插入 `Free Hub` 行（`t('freeHub')`/`t('freeHubDesc')`，i18n en+cn）；`openFreeHub()` 隐藏初始 settings main 行容器、渲染 `#free-hub-root`，`closeFreeHub()` 反向恢复（事件解绑，沿 settings 现有切换习惯）。
- [ ] P4.2 **骨架与样式**：`web/static/jethub.js`（IIFE 无框架：header 三段、left pane provider 列表、right pane 四区）+ `web/static/style-jethub.css`（纯 theme tokens）；`index.html`/`index-nopg.html` 挂脚本；`internal/feature/feature.go` 注册资产。
- [ ] P4.3 **left pane**：provider 列表渲染（图标/名称/账号数徽标），单选切换 right pane，选中态高亮。
- [ ] P4.4 **right pane①前缀**：前缀输入框 + 保存/清除（`PUT /api/jethub/{provider}/prefix`），非法字符与冲突的前端校验 + 后端 409；保存成功提示调用格式 `{前缀}/{modelID}`。
- [ ] P4.5 **right pane②账号池**：新建账号（触发对应 provider 登录流，含短信/QR 类的特殊交互分支）/删除/启停/昵称编辑/状态徽标（凭据有效期、refreshable、最近错误）；拖拽排序可裁剪（非核心）。
- [ ] P4.6 **right pane③显示列表**：模型黑名单开关（黑名单制：默认全显），写 `PUT /api/jethub/{provider}/models`。
- [ ] P4.7 **right pane④积分**：余额/每日额度显示、一键领取、领取结果 toast、积分有效期、锁定永久积分按钮（能力按 `credits-capabilities` 矩阵显隐）。
- [ ] P4.8 **header 一键签到**：遍历有签到能力的启用账号逐个 claim（并发 1 串行），汇总结果 toast（成功 x 失败 y）。
- [ ] P4.9 **header 备份/恢复（兼容原版格式）**：备份 = 拉取全量账号+凭据+黑名单 → 前端组装原版 payload（`version:1`/`exportedAt`/`accounts`/`disabledModels`/`credentials` ref→JSON 字符串）→ `crypto.subtle` PBKDF2(310000)+AES-GCM 加密壳 → 下载 `.json`；恢复 = 选文件 → 前端解密（兼容两种 format 值：明文 `dsh-codearts-auth/backup` 与加密壳）→ 字段映射导入 RPC（凭据 JSON 原文直存，**不重新序列化改形**）。反向兼容验证：本项目导出文件的字段形态与原版 `BackupPayload` 逐字段比对单测。
- [ ] P4.10 **header 关闭**：`closeFreeHub()` 退回初始 Settings main。
- [ ] P4.11 前端契约测试 `web/jethub.test.js`：Node VM + DOM stub——入口行渲染位置（pathSettings 行之后、assistant 行之前）、main 切换/恢复、前缀保存体、备份 payload 字段形态。
- [ ] P4.12 文档同步：PROJECT_MAP.md §18 补条目、§24 速查表行补前端文件。

### 7.3 验证门

`node --check web/static/jethub.js` + `node web/jethub.test.js` + `go build .` + 浏览器冒烟：Settings → Free Hub 行位置正确 → main 切换 → left/right 交互 → 前缀保存 → 一键签到 → 备份下载 → 恢复原版备份文件（可手工构造）→ 关闭还原。

---

## 8. P5 集成加固

- [ ] P5.1 全量测试：`go test ./...` + `go vet ./...` + 前端契约测试全绿。
- [ ] P5.2 构建变体验证：`go build -tags "tray webview"`、`./build.ps1 -Variant webview -Playground -Strip`、`build_mac.ps1` 交叉编译（确认 wazero 无 cgo 不破坏 CGO=0）。
- [ ] P5.3 文档同步（强制）：PROJECT_MAP.md §13/§10/§18/§21/§24 全量对齐；`docs/config-registry-state-architecture.md` 补 jethub 存储节；`docs/proxy-architecture.md` 补 RequestAugmenter hook 与 `jethub` APIType 段。
- [ ] P5.4 新建 `docs/jethub-architecture.md`（架构基线：Free Hub 落地形态、桥接机制、11 provider 的 endpoint/协议族/签名头族/模型表矩阵 + 源码锚点），PROJECT_MAP.md §19 注册。
- [ ] P5.5 体积复核：stripped 构建与 §1.3 预估对照（预期 +3.4 MB 左右；偏差 >2 MB 时记录原因）。

---

## 9. P6 收尾

- [ ] P6.1 全部 provider 实发验证结果汇总进 §11。
- [ ] P6.2 本文 §3 主 Checklist 全部置 `[x]`，文档状态改为「已完成」。
- [ ] P6.3 **移除 PROJECT_MAP.md 中对本计划的引用**（§19 docs 表中本文件行改为指向 `docs/jethub-architecture.md`；§23 占位区条目按同步约束移入正文模块章节并删除占位行）。
- [ ] P6.4 AGENTS.md / CLAUDE.md 架构文档清单与 §24 速查表与 jethub-architecture.md 对齐确认。

---

## 10. 纪律与边界（实施全程有效）

1. **ref/ 只读**：`ref/deepseek-harness-codearts` 为 gitignored 参考副本，禁止修改；WASM 文件需要时**复制**进 `internal/jethub/`。
2. **AGENTS.md 约束不豁免**：无数据库、无前端框架（React 面板必须 vanilla 重写）、无对外鉴权、不实现 OpenAI↔Anthropic 格式转换（minimax 按「透传原生协议体」处理）、日志用 `internal/console.Logger`、错误显式处理不 panic、共享状态 RWMutex。
3. **凭据安全**：落盘必须走项目 AES-GCM 加密持久化，禁止明文 JSON（比插件原实现更严格）。备份文件例外：那是用户主动导出的、原版格式兼容的加密壳（PBKDF2+AES-GCM，用户口令）。
4. **proxy 不依赖 jethub**：桥接 hook 走窄接口注入（§2.3），`internal/proxy` 仅认识 `APIType=="jethub"` 与 `RequestAugmenter` 接口，不 import jethub 包。
5. **静默失败防线**：插件文档记录的全部「改错即静默失败」坑（Qoder business 字段 / 错误帧抛错 / 工具消息保留 / 签名头透传）在对应 augment/adapter 单测中**必须有回归用例锁死**。
6. **实发验证优先**：单测全绿 ≠ 可用；每个 provider 必须至少一次经 `{前缀}/{modelID}` 的真实推理成功才算完成。
7. **分批可中断**：P3 各批次相互独立，任何阶段中断后新会话从本文 §3 状态标记 + §11 日志恢复上下文。

---

## 11. 执行日志（append-only，倒序新→旧）

| 日期 | 阶段 | 记录 |
|---|---|---|
| 2026-10-01 | P3.D | **批次 D（qoder + qodercn，WASM 加密推理）代码完成——批次 P3 全部收口（go vet + 全量测试 + go build 全绿）**：`qoderwasm_bridge.go`（31 导入 wasm-bindgen 桥 + 对象堆哨兵含独立 null + LAYOUT A/B + **实测首要坑**：getrandom 探测链三路全空 → Rust panic=abort 直落裸 `unreachable` 不经 throw —— crypto 必须返回 stand-in 强制浏览器分支；`__wbg_set_08463`=对象方法 set/prototypesetcall 方向=对象→wasm 内存/subarray 接收方=堆对象/static accessor 必须推对象；导出节直读核对 `qodercontext_prepareInferRequest` 全名 + `requestresult_url` 栈指针在前 + `model_cache_decrypt` machineId 必填）、`qoder.go`/`qoder_credits.go`（PKCE + 404=未就绪轮询 + userinfo 昵称 + refresh 沿用身份字段 + `/sash/` 四头（ClientType'10'+machine 头成对）+ 余额三包 + 领取幂等 replayed + UTC+8 日界算术）、`qoder_payload.go`（buildQoderInferPayload 复刻 G4A：business 必填/tools 恒数组/多模态 content 保留/tool_calls 历史保留/空 description 不出现 + 两站模型 meta 表）、`qoder_envelope.go`（剥壳 + 保真转发 code/message/type + `(n>0,io.EOF)` 同返 peek 坑）、`qoder_adapter.go`（**窄接口架构**：proxy.RequestCustomizer 定制 WASM 出站 URL+加密体+签名头替换、proxy.ResponseInterceptor 首帧 peek 分类 + 信封剥离 reader；跨边界错误放 `internal/upstreamerr`：排队→同 Key 等待重发（10s×180）、计费 110→per-model 锁 UTC+8 当日 24:00 切号）、`qoderwasm.go`+`qoder_auth_wasm.wasm`（298,606B 嵌入）、模型表 17+14、API `qoder.go` 双产品五端点（后台轮询独立 context——handler 返回即取消 r.Context()）。单测 33 个（含真实二进制端到端加密往返 + 排队/计费/认证/重复四类分类 + 双通道拦截）。**待实发验证：需 qoder/qodercn 账号（§6.3）。** |
| 2026-10-01 | P3.C5 | **批次 C 第 5/5（minimax）完成——批次 C 全部收口（go vet + 全量测试 + go build 全绿）**：`minimax.go`（设备码 PKCE + token 硬校验 scope 含 agent.default + 非 JWT token → expires_in 自算 expires_at + 轮询**双形态**（200+status=pending 是 MiniMax 形态，标准 400+error 同认——只认标准会把 200 pending 当成功存空凭据））；`minimax_credits.go`（base_resp.status_code 业务码 + timezone_id 必填 query + 面板 7 天硬约束 + dailyCredit=points 不加 bonus + active 恒 true + claim_result 幂等 + **余额 total_count=条数不是余额**（Σ remaining_amount 字符串宽容解析；details 缺失=真 0 非失败）+ Anthropic 原生透传无 anthropic-version + 4 模型表（M3.1 必含/档位不臆造/窗口=档位最大档/thinkingMode 三值语义））；API `minimax.go` 五端点 + `NewStartedLoginWithChannel`。单测 14 个。**待实发验证：需 minimax 账号（§6.3）。** |
| 2026-10-01 | P3.C4 | **批次 C 第 4/5（loomy）代码完成（go vet + 全量测试 + go build 全绿）**：`loomy.go`（CAccount HMAC-SHA1 签名 1:1（9 段拼串末尾两空段/空 body md5/RFC3986/query 不排序/account 前缀/同串签名）+ 字符串 code 信封（HTTP 200 业务失败）+ refreshable 恒 false + expires_at 本地 14 天推算 + 探测 probe）、`loomy_credits.go`（两池余额只读端点 + 每日额度重置语义 alreadyProcessed 幂等 + 新手任务真实 8 key 表 earned 本地现算 + augment 双头 Bearer+token）、API `loomy.go` 八端点。单测 10 个。微信扫码四步绑手机流程按计划裁剪暂缓（短信路径全覆盖）。**待实发验证：需 loomy 账号（§6.3）。** |
| 2026-10-01 | P3.C3 | **批次 C 第 3/5（raccoon）代码完成（go vet + 全量测试 + go build 全绿）**：`raccoon.go`（AES-128-CFB 手机加密 + QR code/URL + 统一信封）、`raccoon_provider.go`（QR 轮询状态机异常降级 pending + 短信登录 + refresh 沿用旧值/200003 终态 + 登录奖励幂等一次性（granted:false）+ 新手礼包双判据（biz_type+event_name）+ augment extra_body.thinking 唯一有效通道 + 倍率展示 1 倍可见 + 6 模型表）、API `raccoon.go` 七端点。单测 12 个。**待实发验证：需 raccoon 账号（§6.3）；QR SVG 前端渲染留 P4。** |
| 2026-10-01 | P3.C2 | **批次 C 第 2/5（cline）代码完成（go vet + 全量测试 + go build 全绿）**：`cline.go`（第七套独立配置：WorkOS 设备码登录 + 驼峰续期 + `workos:` 前缀保留实测坑 + 余额 `usr-` accountId 而非 JWT sub + ISO/秒/毫秒时间戳）、`cline_auth.go`（设备码三字段校验 + 轮询状态机：pending 继续 / slow_down 累积退避 / denied 终态 / 网络失败容忍 5 次 + register 换 token（success&&data.accessToken 判据）+ refresh 终态 + 余额 + augment 头族替换）、`cline_model` 5 条免费表（gemini maxTokens=65536 修正）、API `cline.go` 四端点。单测 14 个。**待实发验证：需 cline 账号（§6.3）。** |
| 2026-10-01 | P3.C1 | **批次 C 第 1/5（trae）代码完成（go vet + 全量测试 + go build 全绿）**：`trae.go`（三 host + 凭据 1:1 + 三套头族 + 9074 设备派生 + seededStream）、`trae_auth.go`（回调双流程：token 直传无 code + PKCE 点名、乱码修复、TenantID、双分支 exchange + GetUserInfo 容错）、`trae_solo.go`（OpenAI→SOLO 转换含 assistant content=null tool_calls 保留回归 + SOLO SSE 事件解析 + function_call 双向映射）、`trae_provider.go`（两步登录/续期/9074 轮换签到/VSCode 头族签到/augment）、`trae_model.go` 32 模型、API `trae.go`。单测 15 个。修复实现缺陷 2 处（transformSOLOMessage 漏 content 转换、GetUserInfo uid 未整体采信）。**待实发验证：需 trae 账号（§6.3）。** |
| 2026-10-01 | P3.B | **批次 B（lobsterai）代码完成（go vet + 全量测试 + go build 全绿）**：`lobsterai.go`（协议常量 + 凭据 1:1 + 手机尾 2 位掩码幂等 + 四级 UID 回退不插 JWT sub 中间层 + now 基准 expires_in + refresh 身份字段沿用含 latest_keyfrom 刻意不更新）、`lobsterai_auth.go`（本地回调两步登录：portal#/login hash 段显式拼装、state 不匹配 400、回调即 exchange；refresh 匿名 POST + keyfrom 载荷原样回发 + 终态 refreshable:false）、`lobsterai_augment.go`（Bearer 四头 + Client-Capabilities/Version——能力头是 kimi-k3 准入与思考关闭前提）、`lobsterai_credits.go`（签到三步流 slot→context→check_in 七步判定 + idempotencyKey + creditsGranted 三级回退；余额 profile-summary 而非 /quota（漏活动积分 5297.72 vs 300）+ creditItems label 优先 + 面值推断同组 max + 负值 clamp + 0 且无明细判查不到）、`lobsterai_product.go`（19 模型表）；API `lobsterai.go` 五端点。修复缺陷：掩码尾 4 位残留（suffix 取末 2 位）、面值推断与 ref max 语义对齐、slot 请求头按 ref 四头版（能力头仅 chat/models 必需）。单测 10 个。**待实发验证：需 lobsterai 账号（§6.3）。** |
| 2026-10-01 | P3.A | **批次 A（buddy + workbuddy）代码完成（go vet + 全量测试 + go build 全绿）**：`buddy.go`（两产品配置 + UA 按模型族分档 + X 头族常量）、`buddy_product.go`（CN 16 条/国际 23 条静态模型表 + products 注册）、`buddy_common.go`（JWT claim readers、stripControlChars（scope 多行动实测坑）、parseTokenData expiresIn 相对秒 → JWT iat 基准换算、buildCredential 昵称 account→JWT 三级回退、access_token 即 bridge Key）、`buddy_auth.go`（完整登录流：auth/state→decorate URL（国际版 +version/loginSessionId）→轮询 token（11217 继续轮询）→轮询 account（12151）→组装；refresh 终态判定 401/403/expired/invalid；CompleteBuddyLoginFromJSON 显示字段回写）、`buddy_augment.go`（chat 头族全量重签：X-Domain 产品优先于凭据快照、X-Product=归属名（非 SaaS）、X-Agent-Purpose/IDE-Name/IDE-Type/IDE-Version、UA 按模型族 gpt-/gemini-/claude- 国际版形态 vs glm-/hy/kimi-/minimax- 国内形态）、`buddy_credits.go`（签到 status/claim 三类业务码、余额双层嵌套 + readPreciseNumber 精确值优先 + Status=3 失效包剔除、非 JSON 响应带 HTTP 状态指引重登录）；API `buddy.go`（buddy/workbuddy 各 5 端点，共享 pollLogin）。单测 10 个：JWT 兜底/控制字符清洗/token 解析（相对秒换算+数字字段容忍）/UA 分档/URL 装饰/mo表注册/Key 即 access_token/chat 头族断言/签到业务码 10001 幂等（HTTP 400 收敛为 already-claimed）/余额精确值+失效包剔除/mock 全登录流（11217 重试路径 + JWT 昵称回退）。**待实发验证：需 buddy/workbuddy 账号各一台（记 §6.3）。** |
| 2026-10-01 | P2 | **P2 代码完成（go vet + 全量测试 + go build 全绿）**：`codearts_oauth.go`（PKCE/DPoP ES256 标准库实现 + `DpopPrivateJwk` 字段名与 ref 1:1）、`codearts_sign.go`（SDK-HMAC-SHA256 1:1，maas_type 参与签名、GET 无 content-type、host 不下发）、`codearts_login.go`（两步式 OAuth：随机端口 ≥10000 + 180s 超时 + secret 旧流程 307 回退 + portal 结果页重定向）、`codearts_refresh.go`（RefreshCodeArtsAccount 续期合并 + RefreshAllCodeArts 含停用账号 + 终态 refreshable:false + SyncKeys hook）、`codearts_augment.go`（CodeArtsAugmentHook 签名出站 + maas_type benefit 兜底集合 + Chat-Id/Session-Id/lang）、`codearts_credits.go`（claim 五步流 + 余额解析，campaignId 数字/confirm 独立/Agent-Type 签名外追加三个实测坑已锁）、`sessions.go`（登录会话注册表）；API `codearts.go`（login/status/refresh/claim/balance 五端点）；app.go 装配 augmenter + credentialed hook。单测 13 个（含 mock STS/snap httptest 往返）。**待办：真实账号端到端冒烟（§5.3）——需用户登录一次 codearts 账号后实测 `{前缀}/{modelID}` 推理。** |
| 2026-10-01 | P1 | **P1 完成（验证门全绿，commit 待记）**：`internal/jethub` 包（Manager 凭据 AES-GCM 信封存储 + accounts.json 账号索引/黑名单/前缀映射、AccountPool 选号、Bridge 前缀桥接 + SyncKeys + RestoreBridges、HTTPClient、qoderwasm embed + wazero v1.9.0 编译冒烟）；`internal/api/jethub`（providers/prefix/accounts/models 端点，`Router.SetJetHub` 注入）；proxy `RequestAugmenter` 窄接口 + `SetRequestAugmenter` + `forwardUpstream` jethub 分支（`WithClientRequest` context 传原始请求，客户端头为出站基）；app.go 装配（Manager/Bridge/Augmenter 注入 + RestoreBridges）；codearts 产品表（9 模型）先行注册供桥接验证。测试：jethub/proxy/config/api 全绿 + go vet + go build；wazero WASM 编译冒烟通过。文档：PROJECT_MAP §13n/§10.28/§24/§10 router 行 + config-registry-state-architecture §17a 存储节 + 最后核对行。验证门备注：`/v1/models` 含桥接模型需先为账号写入凭据（P2 登录流），P1 以单测 `TestBridgeSetPrefixRegistersProvider` 锁死等价语义。 |
| 2026-09-30 | P0 | **v2 修订**：确定落地位置与调用方法——产品名 Free Hub，Settings 侧边栏入口（Path Settings 下、Assistant 上），main 三段式布局（header 一键签到/备份/恢复/关闭 + left provider 列表 + right 管理/前缀输入框）；调用桥接 = registry 动态 Provider（`Prefix` + `APIType=jethub` + 账号→Keys 复用 rotation）+ proxy `RequestAugmenter` 窄接口注入，内外统一 `{前缀}/{modelID}` 调用；备份/恢复按原版格式双向兼容（PBKDF2 310000 + AES-GCM 壳，payload v1 字段已实测提炼至 §1.5）。§2 为新增核心设计章节。 |
| 2026-09-30 | P0 | 完成前置评估（克隆 ref 副本 @ commit cecf376，依赖/增量/平台结论见 §1）；创建本计划文档；PROJECT_MAP.md §19/§23 添加引用。 |
