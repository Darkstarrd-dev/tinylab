# Free Hub (jethub) 架构

> **最后核对：** 2026-10-01（P3 批次 A–D + P4 全部落地；对应 P1–P4 源码状态）
>
> Free Hub 是 DeepSeek Harness 插件 `dsh-codearts-auth`（11 个第三方 LLM provider 的账号池 + Web 管理面板，TS/React）的 TinyLab 原生移植：产品名 **Free Hub**，内部包前缀沿用 `jethub`。只读参考副本位于 `ref/deepseek-harness-codearts`（**禁止修改**；每份移植实现的语义权威）。
>
> **变更维护清单（改动时必须同步本文）：**
> - 新增/修改 provider 适配（登录/续期/签名头族/模型表）→ §6 矩阵 + `internal/jethub/` 对应文件
> - 修改代理桥接接口（RequestAugmenter/RequestCustomizer/ResponseInterceptor）或重试语义 → §4 + `internal/proxy/interfaces.go`/`forward_retry.go`/`upstream.go`
> - 修改 Qoder WASM 桥（导入表/导出封装/对象堆）→ §5 + `internal/jethub/qoderwasm_bridge.go`
> - 修改备份格式 → §7 + `internal/jethub/backup.go`（与原版格式**双向兼容**，改动即破坏兼容，须先读 ref types.ts）
> - 修改 Free Hub UI 布局/入口 → §3 + `web/static/jethub.js`/`settings.js`/`i18n.js`

## 1. 模块组成与边界

| 部分 | 位置 | 说明 |
|---|---|---|
| 核心 | `internal/jethub/` | 账号/凭据存储、账号池、registry 桥接、11 provider 适配、WASM 桥、备份 |
| API | `internal/api/jethub/` | `/api/jethub/*` RPC（§10.28 PROJECT_MAP）：providers/prefix/accounts/models + 每 provider login/status/refresh/claim/balance + backup export/import |
| 前端 | `web/static/jethub.js` + `style-jethub.css` | Free Hub 管理界面（vanilla JS，无框架），入口嵌在 Settings 页 |
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
- **main 切换**：`openFreeHub()` 隐藏 `.settings-layout` 渲染 `#free-hub-root`；`closeFreeHub()` 反向恢复（轮询定时器一并清理）。
- **布局三段式**：header（一键签到/备份/恢复/关闭）+ left pane（11 provider 列表，账号数徽标单选）+ right pane 四区（调用前缀 / 账号池 / 模型黑名单 / 积分）。
- 登录流按 provider `loginModes` 分派：`url`/`qr` → 登录 URL 弹窗 + 2s 轮询（`{done,success}` 契约）；`sms` → 发码/验码两步弹窗。
- 样式只用 theme tokens（`var(--…)`），控件复用全局 `.btn`/`.badge`/`.modal`/`.input` 体系。

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

- 载荷 `BackupPayload`（`internal/jethub/backup.go`）与 ref `types.ts` **逐字段同构**：`{format:"dsh-codearts-auth/backup", version:1, exportedAt, credentials: ref→JSON 原文字符串, accounts: ProviderAccountEntry[], disabledModels}`。
- **加密壳在浏览器**（`crypto.subtle`，与原版 backup-crypto.js 同参数：PBKDF2 310000 / SHA-256 / AES-256-GCM / salt 16B / iv 12B，`format: dsh-codearts-auth/backup.encrypted`）；明文载荷由 Go 组装/导入（`GET /api/jethub/backup/export`、`POST /api/jethub/backup/import`）。
- 导入语义：账号按**原 id upsert**（幂等）、凭据 JSON **原文直存不重新序列化**、黑名单整体替换、格式/版本硬校验拒绝；导入后全桥接 provider SyncKeys。
- 原版可选字段 `permanentLocks`/`loomyPermanentLocked`（锁定永久积分）本端未实现，导出不写、导入忽略。

## 8. 错误语义（两条通道共用一套判据，`qoder_queue.go`）

| 形态 | 判据 | 处理 |
|---|---|---|
| 排队 10605 | `ParseQueueError` BFS 穿透 data/result/message/body（外层整体与内层消息两种入参；瞬时排队 `isQueued:false` 不要求 true） | 同 Key 按服务端延迟等待重发（<10s 遵其值，≥10s 封顶 10s，180 次上限） |
| 计费 110 | 业务码 + **窄文案兜底**（`billing daily count exceeded`/`billing_error`；泛词会误伤正文） | per-model 锁至 UTC+8 当日 24:00（纯算术，不取本机时区）+ 切号 |
| 认证 105/401 | 业务码/状态码 | 续期凭据后报错换路（唯一走 refresh 的情形） |
| 重复请求 | `duplicate_request` | 直接重发，不续期 |
