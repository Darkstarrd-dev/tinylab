package jethub

// Accio（阿里 Accio Work）—— 第 15 家 provider。
//
// 上游参考：ref/deepseek-harness-codearts @ origin/master 的
// `src/accio-product.ts` / `src/accio.ts` / `src/accio-oauth.ts` /
// `src/accio-auth.ts` / `src/accio-messages.ts` / `src/accio-adapter.ts` /
// `src/accio-credits.ts`（协议要点见 ref docs/agent-notes/providers-accio.md，
// 2026-10-12 起的真机实测结论）。
//
// 协议总览（ref accio.ts 文件头）：
//
//	POST {gateway}/api/adk/llm/generateContent?sg_k={md5(requestId)}
//	  headers: Content-Type / Accept: text/event-stream / utdid / version / appKey='OneChat'
//	  body   : Gemini 风格信封（键 snake_case），token 放 **body**（放
//	           Authorization 头恒 HTTP 200 + 流内 402）
//	响应   : 顶层 {content:{role,parts}, partial, usage_metadata, finish_reason}
//	         帧（**不是** candidates[]），无 [DONE] 终止行。
//
// 三条与参考实现相反的实测结论（providers-accio.md §0）：
//  1. 标准 OAuth2 + PKCE 公开客户端（`accio-work`，无 secret）——完全脱离 IDE；
//  2. **不需要** SecurityGuard `pctb-x-*` 签名（不带同样 200）；
//  3. 没有签到端点，但登录会触发服务端按日发放（积分）。
//
// ⚠️ 区域（cn/global）只是**登录页域名**参数：gateway 恒为
// `phoenix-gw.alibaba.com`，与区域无关（ref accio-product.ts 文件头）。
// 故 region 存在凭据里，不是第二个 provider id。
//
// ⚠️ refresh 会**轮换** refresh_token（参考实现明确记录；本端未实测，ref §10
// U-A）——续期必须 per-credentialRef 串行 + 锁内重读 + 判终态前重读
// （accio_refresh.go，codearts/officeace 同款三件套）。

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// Accio endpoints & login constants (1:1 from ref accio-product.ts).
const (
	// accioTokenExchangePath / accioRefreshPath are the OAuth endpoints (JSON
	// envelope {success,code,message,data}).
	accioTokenExchangePath = "/api/oauth/token"
	accioRefreshPath       = "/api/auth/refresh_token"
	// accioLLMPath is the inference endpoint (Gemini-style streaming).
	accioLLMPath = "/api/adk/llm/generateContent"
	// accioCatalogPath is the remote model catalog (token in body).
	accioCatalogPath = "/api/llm/config/v2"
	// accioUserinfoPath (POST, token in body) / accioSubscriptionPath /
	// accioQuotaPath (GET, token in query) are the read-only credits trio.
	accioUserinfoPath      = "/api/auth/userinfo"
	accioSubscriptionPath  = "/api/entitlement/currentSubscription"
	accioQuotaPath         = "/api/entitlement/quota"
	accioCallbackPath      = "/auth/callback"
	accioClientID          = "accio-work" // PKCE public client (no secret)
	accioAppKey            = "OneChat"    // 固定 appKey 头（非产品名）
	accioAppVersion        = "0.34.4"
	accioRequestTimeout    = 30 * time.Second
	accioLoginBudget       = 10 * time.Minute
	accioLoginPollInterval = 2 * time.Second
	// accioRefreshLead mirrors the shared refresh lead (renew within 1h of
	// expiry; the access token itself lives ~1 month).
	accioRefreshLead = time.Hour
)

// accioGatewayBase is the region-INDEPENDENT API gateway. Var so tests can
// point it at a mock server (setAccioBase; officeace setOfficeaceBase 同款).
var accioGatewayBase = "https://phoenix-gw.alibaba.com"

func setAccioBase(u string) { accioGatewayBase = u }

// accioLoginBaseOf returns the login page host for a region (cn/global; the
// ONLY region-dependent host — the gateway is shared). Unknown values fall
// back to the cn host (normalizeAccioRegion has already whitelisted).
func accioLoginBaseOf(region string) string {
	if region == "global" {
		return "https://zh.accio.com"
	}
	return "https://www.accio-ai.com"
}

// normalizeAccioRegion whitelists the client-supplied region (ref
// normalizeAccioRegion: 未登记的值一律回落 'cn'，不报错).
func normalizeAccioRegion(raw string) string {
	if raw == "global" {
		return "global"
	}
	return "cn"
}

// AccioCredential mirrors ref AccioCredential field-for-field (snake_case
// JSON — the ref credential is exactly this shape). ⚠️ `access_token` 必须是
// 这个名字：通用 bridge-key 提取器（accessTokenOf 的 generic 分支）取的就是它
// 作 Key.Key（不参与出站鉴权 —— token 走 body；只用于轮询选号与用量归属）。
type AccioCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	// ExpiresAtMs is the expiry in MILLISECONDS. ⚠️⚠️ 上游 `expiresAt` 是**秒**
	// （官方客户端自己做 1e3*）；若忘了归一化，时间量纲错成 1970 年 ⇒ 每个请求
	// 都触发续期 ⇒ 反复消费 refresh_token ⇒ invalid_grant ⇒ 账号被标死。
	// 归一化只在 accioExpiresAtMs（兑换/续期返回处）做一次。
	ExpiresAtMs int64  `json:"expires_at"`
	Sgcookie    string `json:"sgcookie,omitempty"`
	// Region is the login-page region chosen at login ("cn"/"global").
	Region   string `json:"region,omitempty"`
	UserID   string `json:"user_id,omitempty"`
	AccioID  string `json:"accio_id,omitempty"`
	Nickname string `json:"nickname,omitempty"`
}

// accioExpiresAtMs normalizes the upstream `expiresAt` (SECONDS — or already
// ms from a tolerant future) into ms. >1e12 ⇒ treat as already-ms (ref
// accioExpiresAtMs 的同款防御). ok=false when missing/non-positive.
func accioExpiresAtMs(raw any) (int64, bool) {
	var n float64
	switch t := raw.(type) {
	case float64:
		n = t
	case int64:
		n = float64(t)
	case int:
		n = float64(t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, false
		}
		n = f
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, false
		}
		if _, err := fmt.Sscanf(s, "%g", &n); err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	if n <= 0 {
		return 0, false
	}
	if n > 1e12 {
		return int64(n), true
	}
	return int64(n * 1000), true
}

// accioRefreshable reports whether the credential carries a refresh_token
// (ref isAccioRefreshable：只看凭据材料，不读池里的 refreshable 布尔).
func accioRefreshable(cred *AccioCredential) bool {
	return cred != nil && cred.RefreshToken != ""
}

// accioShouldRefreshNow: unknown expiry ⇒ refresh now; otherwise only within
// the lead window (ref shouldRefreshNow 同款判据).
func accioShouldRefreshNow(cred *AccioCredential, nowMs int64) bool {
	if cred == nil || cred.ExpiresAtMs <= 0 {
		return true
	}
	return cred.ExpiresAtMs-nowMs <= accioRefreshLead.Milliseconds()
}

// accioCredentialExpiresAt returns the display expiry (ms); an absent value
// falls back to now + 24h (与 codearts 的展示兜底一致 —— 官方客户端的
// access_token 寿命约 30 天，读不到时 24h 是保守显示值，不参与续期判据).
func accioCredentialExpiresAt(cred *AccioCredential) int64 {
	if cred != nil && cred.ExpiresAtMs > 0 {
		return cred.ExpiresAtMs
	}
	return time.Now().Add(24 * time.Hour).UnixMilli()
}

// accioRequestID is one request's identity (`req-<ms>-<8hex>`; ref
// accioRequestId 取 randomUUID 前 8 位 —— 一样是 8 个 hex 字符).
func accioRequestID() string {
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand 失败（owner/assistant/sheet 的既有例外契约）：退化为
		// 纳秒计数的 8 hex —— 仍是合法 hex，仅随机性下降。
		now := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return fmt.Sprintf("req-%d-%s", time.Now().UnixMilli(), hex.EncodeToString(raw))
}

// accioSgK is the `sg_k` query value: md5(requestId) hex.
func accioSgK(requestID string) string {
	sum := md5.Sum([]byte(requestID))
	return hex.EncodeToString(sum[:])
}

// accioMessageID derives the REQUIRED body `message_id` (缺它上游回 400)：
// md5(requestId + ":" + <16 random bytes hex>)。掺入随机量：同一 requestId
// 连续两次不能相同（上游可能按它去重，ref accioMessageId 注释）。
func accioMessageID(requestID string) string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		now := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	sum := md5.Sum([]byte(requestID + ":" + hex.EncodeToString(raw)))
	return hex.EncodeToString(sum[:])
}

// accioToSnake converts camelCase keys to snake_case, recursively — the same
// 口径 as the official client's Vn() (ref accioToSnake). ⚠️ **不下钻字符串**：
// 工具参数（`parameters_json` 的 JSON 串）是**数据**，递归改写会把 schema 键
// （filePath…）静默改成 file_path —— 与调用方按原 schema 消费的定义失配。
// JSON null（Go nil）按 null 保留（ref 只丢 undefined 键；JSON 里没有 undefined）.
func accioToSnake(value any) any {
	switch t := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, v := range t {
			out[accioSnakeKey(k)] = accioToSnake(v)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, v := range t {
			out[i] = accioToSnake(v)
		}
		return out
	default:
		return value
	}
}

// accioSnakeKey inserts `_` before every ASCII upper-case letter and lowercases
// it (ref `k.replace(/[A-Z]/g, c => '_' + c.toLowerCase())`).
func accioSnakeKey(k string) string {
	var b strings.Builder
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c >= 'A' && c <= 'Z' {
			b.WriteByte('_')
			b.WriteByte(c + ('a' - 'A'))
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// accioBodyOptions is one buildAccioBody call's inputs (ref BuildAccioBodyOptions).
type accioBodyOptions struct {
	model             string
	accessToken       string
	contents          []any
	systemInstruction string
	tools             []any
	temperature       any // float64 or nil
	maxOutputTokens   any // float64 or nil
	utdid             string
	requestID         string
}

// buildAccioBody constructs the snake_case request body.
//
// ⚠️ 四处硬约束（逐条实测 / 逐字逆向，ref buildAccioBody）：
//  1. `empid` / `tenant` / `iai_tag` **必须空串**（真实值会被拒）；
//  2. `message_id` **必填**（缺它上游回 400）；
//  3. `token` 必须放 **body**（放 Authorization 头恒 HTTP 200 + 流内 402）；
//  4. ⚠️⚠️ `system_instruction` 是「字符串」，不是 {parts:[{text}]} 对象 ——
//     对象形态实测恒 HTTP 200 + 流内 400（ref §4.1.1；官方 proto 该字段是
//     string，Accio 与 Gemini 在这一格上不同）。
//
// ⚠️ `properties` 子树**不参与** camel→snake 转换：实测成功的形状是 `appKey`
// 驼峰 + `normalized_response` snake 混用（参考实现与官方客户端都只往里补
// normalized_response，不转换它）。走通用递归会把它改成 app_key —— 未实测形状。
func buildAccioBody(o accioBodyOptions) map[string]any {
	camel := map[string]any{
		"model":         o.model,
		"empid":         "",
		"tenant":        "",
		"iaiTag":        "",
		"requestId":     o.requestID,
		"userRequestId": o.requestID,
		"contents":      accioToSnake(o.contents),
		"stopSequences": []any{},
		"properties": map[string]any{
			"utdid":   o.utdid,
			"version": accioAppVersion,
			"appKey":  accioAppKey,
			// ⚠️ 该子树不参与转换（见函数注释），直接按实测形状写。
			"normalizedResponse": "true",
		},
		"token":       o.accessToken,
		"messageId":   accioMessageID(o.requestID),
		"incremental": true,
	}
	if o.systemInstruction != "" {
		// ⚠️ 字符串原样传（不要包成 {parts:[...]}），空串时不产出该键。
		camel["systemInstruction"] = o.systemInstruction
	}
	if len(o.tools) > 0 {
		// ⚠️⚠️ tools 的 JSON Schema 必须保持「字符串化」（parameters_json），
		// **不得**改成包装形 {function_declarations:[...]} 或对象形态：
		// accioToSnake 不下钻字符串，参数名原样送达；对象形态会被递归
		// snake 化改写 schema 键（ref accio.ts tools 区域的整段警告）。
		camel["tools"] = accioToSnake(o.tools)
	}
	if o.temperature != nil {
		camel["temperature"] = o.temperature
	}
	if o.maxOutputTokens != nil {
		camel["maxOutputTokens"] = o.maxOutputTokens
	}
	body, _ := accioToSnake(camel).(map[string]any)
	// properties 子树按实测形状覆写（appKey 驼峰 + normalized_response snake）。
	body["properties"] = map[string]any{
		"utdid":               o.utdid,
		"version":             accioAppVersion,
		"appKey":              accioAppKey,
		"normalized_response": "true",
	}
	return body
}

// accioHeaders builds the inference request headers. ⚠️ **不带** SecurityGuard
// `pctb-x-*`（实测不必需）；**不带** Authorization（token 走 body —— 头上放了
// 恒 HTTP 200 + 流内 402，ref accio.ts 文件头 + providers-accio.md §4.2）。
func accioHeaders(utdid, sgcookie string) map[string]string {
	headers := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "text/event-stream",
		"utdid":        utdid,
		"version":      accioAppVersion,
		"appKey":       accioAppKey,
	}
	if sgcookie != "" {
		headers["sgcookie"] = sgcookie
	}
	return headers
}

// accioStableUtdid returns the process-wide stable device id. 上游不校验它的
// 取值（实测缺它反而命中风控 HTML 页 —— 200 + text/html），恒定进程内一份即可。
var accioUtdid = randomHex(16)

// ── 模型表（兜底 + slug 映射） ────────────────────────────────────────────

// accioModelEntry mirrors ref AccioFallbackModel：上游 `modelCode` 形如
// `1Drift-N8kP2Q7wR5mX`，**非人类可读**（无法凭名字手写维护）—— 远端目录永远
// 是首选，本表只作离线回退（ref accio-product.ts FALLBACK_MODELS，2026-10-12
// 实测的 15 个可见模型，按倍率升序）。
type accioModelEntry struct {
	// ID is the upstream modelCode.
	ID string
	// Name is the display name (倍率后缀由展示层拼，不进这里).
	Name          string
	ContextWindow int
	MaxTokens     int
	SupportsImage bool
	// Multiple is the billing rate (上游 effectiveMultiple；跨度 0.013~2.8，
	// 用户选型时最重要的信号 —— 展示名必须体现). HasMultiple marks presence
	// (0 是合法值，不能当哨兵).
	Multiple    float64
	HasMultiple bool
	// Efforts / DefaultEffort are the catalog's reasoning tiers (ref
	// reasoningEfforts / defaultReasoningEffort；default-only 也算单档).
	Efforts       []string
	DefaultEffort string
}

// accioFallbackModels is the offline fallback table (ref FALLBACK_MODELS).
var accioFallbackModels = []accioModelEntry{
	{ID: "1Drift-N8kP2Q7wR5mX", Name: "Qwen 3.8 27B", ContextWindow: 512000, SupportsImage: true, Multiple: 0.013},
	{ID: "1Drift-F8hS3mK7pL2n", Name: "Qwen 3.8 Flash", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.03},
	{ID: "1Chronos-F53X9nQ3rT8w", Name: "GLM 5.3 Flash", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.03},
	{ID: "1Nova-Q3xM8vJ1rH6z", Name: "DeepSeek V4.1 Flash", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.045},
	{ID: "1Zenith-M27hS2SR5xQ2p", Name: "MiniMax M3", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.08},
	{ID: "1Chronos-dX3cV9sA2mK7", Name: "GLM 5.1", ContextWindow: 200000, SupportsImage: false, Multiple: 0.12},
	{ID: "1Nexus-R3wF8qJ5vB6h", Name: "Standard", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.13},
	{ID: "1Drift-A3bM5nK8pQ2w", Name: "Qwen 3.5 A3B", ContextWindow: 256000, SupportsImage: false, Multiple: 0.13},
	{ID: "1Synapse-G5aJ8wL1dV4s", Name: "Kimi K2.6", ContextWindow: 256000, SupportsImage: true, Multiple: 0.14},
	{ID: "1Chronos-L53W8nP2qR6m", Name: "GLM-5.3", ContextWindow: 1000000, SupportsImage: false, Multiple: 0.16},
	{ID: "1Chronos-G5p2V9sA2mK7", Name: "GLM-5.2", ContextWindow: 1000000, SupportsImage: false, Multiple: 0.16},
	{ID: "1Nova-bW7yT4kL9pN2", Name: "DeepSeek V4 Pro", ContextWindow: 1000000, SupportsImage: false, Multiple: 0.17},
	{ID: "1Drift-T3TB6WS9a23w", Name: "Qwen 3.8 Max", ContextWindow: 1000000, SupportsImage: true, Multiple: 0.44},
	{ID: "1Orbit-I9eY4tK8bW1f", Name: "Professional", ContextWindow: 1000000, SupportsImage: true, Multiple: 1},
	{ID: "1Orbit-Q7hN3xR6cP2m", Name: "Ultimate", ContextWindow: 1000000, SupportsImage: true, Multiple: 2.8},
}

// accioModelKeySlug is the external model id rule: the display name normalized
// to a lowercase slug（用户要求「对外 id 是人话」，ref accioModelIdOf +
// normalizeNameKey）。规则与上游聚合的规范键同一套，不另写一份：
//
//	剥第一个 '·' 之后（倍率后缀）→ 去掉「免费」→ trim/小写 → 剥路径前缀 →
//	剥 ":free" 后缀 → 剥 "sn-" 前缀 → '.'→'-' → 空白→'-'。
//	归一后为空时回退原始 modelCode（宁可非人类可读也不产出空 id —— 空串会让
//	目录校验直接失败，ref accioModelIdOf 的兜底注释）。
func accioModelKeySlug(name string) string {
	s := name
	if idx := strings.Index(s, "·"); idx >= 0 {
		s = s[:idx]
	}
	s = strings.ReplaceAll(s, "免费", "")
	s = strings.TrimSpace(s)
	s = strings.ToLower(s)
	if idx := strings.LastIndex(s, "/"); idx >= 0 {
		s = s[idx+1:]
	}
	s = strings.TrimSuffix(s, ":free")
	s = strings.TrimPrefix(s, "sn-")
	s = strings.ReplaceAll(s, ".", "-")
	s = strings.ReplaceAll(s, " ", "-")
	return s
}

// accioModelIDOf returns the external (slug) id of one entry.
func accioModelIDOf(e accioModelEntry) string {
	if slug := accioModelKeySlug(e.Name); slug != "" {
		return slug
	}
	return e.ID
}

// accioModelCodeOf maps an external slug id back to the upstream modelCode.
// ⚠️ 未知 id **原样透传**（用户手填的 id 应由上游报错，本地不得静默改成空模型名；
// ref accioModelCodeOf 的语义 —— raw modelCode 也因此能直接当 id 用）。
func accioModelCodeOf(models []accioModelEntry, slug string) string {
	for _, e := range models {
		if accioModelIDOf(e) == slug {
			return e.ID
		}
	}
	return slug
}

// accioDisplayName renders "Name · xM"（倍率写进展示名，本仓库既有约定；
// ref displayNameOfAccioModel）。无倍率时返回裸名。
func accioDisplayName(e accioModelEntry) string {
	if !e.HasMultiple && e.Multiple <= 0 {
		return e.Name
	}
	return fmt.Sprintf("%s · x%s", e.Name, accioFormatMultiple(e.Multiple))
}

// accioFormatMultiple prints the rate without a trailing ".0" (0.013→"0.013",
// 1→"1", 2.8→"2.8").
func accioFormatMultiple(m float64) string {
	s := fmt.Sprintf("%g", m)
	return s
}

// accioModelTable converts entries into the bridged ModelTable shape:
// ID = slug（对外人话 id），Alias = "Name · xM"（modelDisplayParts 会拆出倍率
// 展示），Note = "ctx N"（本端 ModelDef 无独立字段的既有口径，同 codearts 表）。
func accioModelTable(models []accioModelEntry) ModelTable {
	out := make(ModelTable, 0, len(models))
	for _, e := range models {
		note := ""
		if e.ContextWindow > 0 {
			note = fmt.Sprintf("ctx %d", e.ContextWindow)
		}
		if e.MaxTokens > 0 {
			if note != "" {
				note += "; "
			}
			note += fmt.Sprintf("out %d", e.MaxTokens)
		}
		out = append(out, config.ModelDef{
			ID:        accioModelIDOf(e),
			Alias:     accioDisplayName(e),
			Note:      note,
			QuotaType: "limited",
		})
	}
	return out
}

// accioFallbackModelTable is the static table registered on the bridged
// provider (offline fallback for the remote catalog).
var accioFallbackModelTable = accioModelTable(accioFallbackModels)
