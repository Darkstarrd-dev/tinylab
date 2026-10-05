package jethub

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// OpenCode Zen provider constants (ref opencode-product.ts, branch
// feat/opencode-provider @ 7dd3422; the branch is not merged into master yet).
const (
	// opencodeBaseURL is the Zen gateway origin.
	opencodeBaseURL = "https://opencode.ai/zen"
	// opencodeChatPath is the OpenAI-compatible chat endpoint.
	opencodeChatPath = "/v1/chat/completions"
	// opencodeAnonymousKey is the literal the official CLI sends when no key is
	// configured (`{ apiKey: 'public' }`); the anonymous channel only serves
	// free models.
	opencodeAnonymousKey = "public"
	// opencodeDefaultUA mirrors the reference default (`opencode/<version>`).
	opencodeDefaultUA = "opencode/1.18.22"
)

// opencodeGateTools are the tool names the anonymous free-lane shape gate
// requires (ref opencode-messages.ts FREE_LANE_GATE_TOOLS: stream:true + bash +
// read). Injected on EVERY channel — harmless on keyed channels (the official
// CLI ships a full tool set anyway) and mandatory for the anonymous one.
var opencodeGateTools = []string{"bash", "read"}

// OpencodeFingerprint mirrors ref OpencodeFingerprint (backup compatibility:
// field names are the persisted contract).
type OpencodeFingerprint struct {
	// ProjectID is 40 lowercase hex (sha1 shape, official CLI form).
	ProjectID  string `json:"projectId"`
	Generation int    `json:"generation"`
}

// OpencodeCredential mirrors ref opencode.ts OpencodeCredential field-for-field
// (§1.5 backup compatibility).
type OpencodeCredential struct {
	// APIKey is the Zen API key (`sk-…`) or the literal `public` for the
	// anonymous channel.
	APIKey   string `json:"api_key"`
	Nickname string `json:"nickname,omitempty"`
	// Fingerprint is optional (derived from the identity when absent).
	Fingerprint *OpencodeFingerprint `json:"fingerprint,omitempty"`
	// Proxy is the per-account egress ("" = direct). Stored for parity with the
	// reference; this port routes through the provider-level Use Proxy toggle
	// instead (documented deviation).
	Proxy string `json:"proxy,omitempty"`
}

// isAnonymousOpencodeKey reports whether the credential is the anonymous
// channel (literal `public`).
func isAnonymousOpencodeKey(apiKey string) bool {
	return apiKey == opencodeAnonymousKey
}

// deriveOpencodeProjectID derives the x-opencode-project fingerprint
// (ref deriveProjectId): sha256(`identity generation`) hex, then
// sha1(`git-remote:opencode/<inner>`) hex — the official CLI's 40-hex shape.
func deriveOpencodeProjectID(identity string, generation int) string {
	inner := sha256.Sum256([]byte(fmt.Sprintf("%s %d", identity, generation)))
	innerHex := hex.EncodeToString(inner[:])
	sum := sha1.Sum([]byte("git-remote:opencode/" + innerHex))
	return hex.EncodeToString(sum[:])
}

// opencodeBase62 is the official id alphabet (0-9A-Za-z).
const opencodeBase62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// opencodeSessionIDFor derives a STABLE session id per account with the
// official shape: `ses_` + 12 lowercase hex + 14 base62 (total tail 26).
//
// ⚠️ 形状即门禁（ref 实测）：`ses_` + 12hex + **14** base62；写成 38 字符
// （12hex + 26 base62）会让匿名通道一律 403 FreeTierError。本端按账号稳定派生
// （参考实现按会话缓存）—— 重试/重启复用同一 id，形状与稳定性都满足。
func opencodeSessionIDFor(keyID string) string {
	sum := sha256.Sum256([]byte("jethub-opencode-session:" + keyID))
	timePart := hex.EncodeToString(sum[:6]) // 12 lowercase hex
	var tail strings.Builder
	for i := 0; i < 14; i++ {
		tail.WriteByte(opencodeBase62[int(sum[6+i])%len(opencodeBase62)])
	}
	return "ses_" + timePart + tail.String()
}

// newOpencodeRequestID returns a fresh per-request id (`req_` + 32 hex).
func newOpencodeRequestID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand failure: fall back to a time-derived id (shape preserved).
		n := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(n >> (8 * (i % 8)))
		}
	}
	return "req_" + hex.EncodeToString(raw)
}

// opencodeHeaders builds the identity header set sent to Zen (ref
// opencodeHeaders; `x-opencode-client` is the literal `cli`).
func opencodeHeaders(projectID, sessionID, requestID string) map[string]string {
	return map[string]string{
		"x-opencode-project": projectID,
		"x-opencode-session": sessionID,
		"x-opencode-request": requestID,
		"x-opencode-client":  "cli",
		"user-agent":         opencodeDefaultUA,
	}
}

// opencodeCredentialFor resolves + parses one opencode account credential.
func (m *Manager) opencodeCredentialFor(keyID string) (*OpencodeCredential, string, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "opencode" {
		return nil, "", fmt.Errorf("jethub: account %s not found for opencode", keyID)
	}
	raw, ok := m.Credential("opencode", acc.CredentialRef)
	if !ok {
		return nil, "", fmt.Errorf("jethub: credential missing for account %s", keyID)
	}
	var cred OpencodeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, "", fmt.Errorf("jethub: parse opencode credential for %s: %w", keyID, err)
	}
	if cred.APIKey == "" {
		return nil, "", fmt.Errorf("jethub: opencode 凭据缺少 api_key（请重新添加账号）")
	}
	return &cred, acc.ID, nil
}

// AddOpencodeAccount stores one account from a pasted API key (or the
// anonymous channel when anonymous=true). Mirrors the reference
// opencode.addAccount semantics: a key already present is REUSED, not
// duplicated (returns reused=true).
func (m *Manager) AddOpencodeAccount(apiKey, nickname string, anonymous bool) (string, bool, error) {
	apiKey = strings.TrimSpace(apiKey)
	if anonymous {
		apiKey = opencodeAnonymousKey
	}
	if apiKey == "" {
		return "", false, errors.New("jethub: API key 不能为空")
	}
	// Dedup by stored api_key (same key added twice = reuse).
	for _, a := range m.Accounts("opencode") {
		cred, _, err := m.opencodeCredentialFor(a.ID)
		if err != nil || cred == nil {
			continue
		}
		if cred.APIKey == apiKey {
			return a.ID, true, nil
		}
	}
	nick := strings.TrimSpace(nickname)
	if nick == "" {
		if anonymous {
			nick = "匿名通道"
		} else {
			nick = "OpenCode " + opencodeKeyTail(apiKey)
		}
	}
	id, ref := NewAccountID("opencode")
	if err := m.AddAccount(Account{ID: id, Provider: "opencode", Nickname: nick, Enabled: true, CredentialRef: ref}); err != nil {
		return "", false, err
	}
	cred := OpencodeCredential{APIKey: apiKey, Nickname: nick}
	raw, err := json.Marshal(cred)
	if err != nil {
		return "", false, err
	}
	// No renewal exists for a pasted key: expiresAt 0 (unknown) and an honest
	// refreshable=false (the UI must not promise auto-renewal).
	if err := m.SetCredential("opencode", ref, raw, 0, false); err != nil {
		return "", false, err
	}
	return id, false, nil
}

// opencodeKeyTail returns the last 4 characters of a key for the default
// nickname (never the whole key).
func opencodeKeyTail(apiKey string) string {
	if len(apiKey) <= 4 {
		return apiKey
	}
	return apiKey[len(apiKey)-4:]
}

// opencodeFingerprintGeneration resolves the effective fingerprint generation
// of one account: the **account entry** is authoritative, the credential's own
// generation is only a floor (ref 的接线约定：`max(本字段, 凭据内代次)`).
//
// 只存**整数代次**而不是新指纹本体：project id 由 `(identity, generation)` 唯一
// 决定，故换代次即可整体换一份新 project id，无需让调用方拼哈希（与 trae 的
// 签到设备代次同款取舍）。
func (m *Manager) opencodeFingerprintGeneration(accountID string, cred *OpencodeCredential) int {
	generation := 0
	if cred != nil && cred.Fingerprint != nil && cred.Fingerprint.Generation > generation {
		generation = cred.Fingerprint.Generation
	}
	if acc, ok := m.FindAccount(accountID); ok && acc.OpencodeFingerprintGeneration > generation {
		generation = acc.OpencodeFingerprintGeneration
	}
	return generation
}

// RotateOpencodeFingerprint bumps the account's fingerprint generation by one
// and returns the new value —— 用于「怀疑多个账号被关联时」换一份 project id。
//
// ⚠️ 与「换出口代理」是**两种独立的分离手段**：指纹分离不增加配额（匿名通道按
// 出口 IP 限额），代理分离才会。面板上两个按钮并列，文案不得把它们混为一谈。
func (m *Manager) RotateOpencodeFingerprint(accountID string) (int, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "opencode" {
		return 0, errAccountNotFound(accountID)
	}
	next := acc.OpencodeFingerprintGeneration + 1
	if err := m.UpdateAccount(accountID, func(a *Account) {
		a.OpencodeFingerprintGeneration = next
	}); err != nil {
		return 0, err
	}
	return next, nil
}

// OpencodeChannelBalance reports the **channel availability** of one opencode
// account — NOT a credit number (ref jet-hub-rpc.ts 的 OPENCODE 分支).
//
// ## 为什么不是 `balance: false`（真实缺陷，2026-10-02 上游改）
//
// Zen 是**按量计费**的网关，早期据此判「没有可查询的余额」并把能力登记成
// false —— 那会把整个额度行挡死，用户看到的是「opencode 没有额度」，而 Zen
// 明明有额度（耗尽会回 `402 Insufficient account funds`）。可它**没有公开的
// 余额 API**（上游实测 `/zen/v1/` 下 15 条候选路径全部 404，只回官网 HTML）。
//
// ## 改后的口径
//
// 展示**我们真正测得到的东西**：该通道当前是否可用、是否有模型处于限额冷却。
// 数据全部来自**本地状态**（账号 `enabled` + `modelRateLimits`），**零网络请求**
// —— 因此这个函数不会失败，也不会因为上游抖动而产生噪音。
//
// 语义映射（**不伪装成余额**）：
//   - `Total` = 当前可用通道数（0 或 1），单位固定「通道」；
//   - 处于限额冷却时把 1 放进 `ExpiredTotal`，面板显示「另有 1 已失效」
//     ——与其它渠道的「已失效资源包」口径一致，前端逻辑无需为它特判。
//
// 返回的 `error` 文案（「已停用」/「限额中，<时刻> 恢复」）由调用方与 balance
// 一起回给前端：它是**状态**而不是查询失败，两者必须能同时出现。
func (m *Manager) OpencodeChannelBalance(accountID string) (*CreditBalance, string, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "opencode" {
		return nil, "", errAccountNotFound(accountID)
	}
	now := nowMillis()
	limitedUntil := int64(0)
	limitedModels := 0
	for modelID, resetAt := range acc.ModelRateLimits {
		if isBookkeepingRateLimitKey(modelID) {
			continue
		}
		if resetAt > limitedUntil {
			limitedUntil = resetAt
		}
		// 只数**尚未到期**的限额（已过期的标记不构成「限额中」）。
		if resetAt > now {
			limitedModels++
		}
	}
	available := 0.0
	if acc.Enabled && limitedUntil <= now {
		available = 1
	}
	name := "可用通道"
	if limitedModels > 0 {
		name = fmt.Sprintf("%d 个模型限额中", limitedModels)
	}
	out := &CreditBalance{
		Total: available,
		Packages: []CreditPackage{{
			Name: name, Unit: "通道",
			Remaining: available, Total: available, Active: true,
		}},
	}
	if acc.Enabled && limitedUntil > now {
		out.ExpiredTotal = 1
	}
	switch {
	case !acc.Enabled:
		return out, "已停用", nil
	case limitedUntil > now:
		// 与其它渠道的「查询失败」文案区分：这是**状态**，不是故障。
		return out, "限额中，" + time.UnixMilli(limitedUntil).Format("2006-01-02 15:04") + " 恢复", nil
	}
	return out, "", nil
}

// --- Model table (ref OPENCODE_FALLBACK_MODELS, 实测 2026-10-01) ---

// opencodeFreeModels is the set the ANONYMOUS channel may use (`Bearer public`);
// everything else requires a keyed account. Only ids verified reachable on the
// chat endpoint are listed (ref dropped ling-3.0-flash-fin-free: its endpoint
// 500s / 404s on both channels).
var opencodeFreeModels = map[string]bool{
	"big-pickle":                  true,
	"space-bunny-free":            true,
	"longcat-2.5-preview-free":    true,
	"mimo-v2.6-flash-free":        true,
	"mimo-v2.5-free":              true,
	"nemotron-3-ultra-free":       true,
	"nemotron-3.5-lightning-free": true,
}

// isFreeOpencodeModel reports whether the anonymous channel can serve the model
// (unknown ids ⇒ false: the remote catalog may contain new free models, but
// exposing them to the anonymous slot before verification only buys 403s).
func isFreeOpencodeModel(id string) bool {
	return opencodeFreeModels[id]
}

// opencodeModels is the static fallback table (ctx 262144 = ref value).
// Free entries carry the panel's ` · 免费` marker (same convention as cline).
var opencodeModels = ModelTable{
	{ID: "big-pickle", QuotaType: "unlimited", Alias: "Big Pickle · 免费", Note: "ctx 262144"},
	{ID: "space-bunny-free", QuotaType: "unlimited", Alias: "Space Bunny Free · 免费", Note: "ctx 262144"},
	{ID: "longcat-2.5-preview-free", QuotaType: "unlimited", Alias: "LongCat 2.5 Preview Free · 免费", Note: "ctx 262144"},
	{ID: "mimo-v2.6-flash-free", QuotaType: "unlimited", Alias: "MiMo-V2.6-Flash Free · 免费", Note: "ctx 262144"},
	{ID: "mimo-v2.5-free", QuotaType: "unlimited", Alias: "MiMo-V2.5 Free · 免费", Note: "ctx 262144"},
	{ID: "nemotron-3-ultra-free", QuotaType: "unlimited", Alias: "Nemotron 3 Ultra Free · 免费", Note: "ctx 262144"},
	{ID: "nemotron-3.5-lightning-free", QuotaType: "unlimited", Alias: "Nemotron 3.5 Lightning Free · 免费", Note: "ctx 262144"},
	{ID: "deepseek-v4-flash", QuotaType: "limited", Alias: "DeepSeek V4 Flash", Note: "ctx 262144"},
	{ID: "deepseek-v4.1-flash", QuotaType: "limited", Alias: "DeepSeek V4.1 Flash", Note: "ctx 262144"},
	{ID: "glm-5.2", QuotaType: "limited", Alias: "GLM 5.2", Note: "ctx 262144"},
	{ID: "kimi-k2.5", QuotaType: "limited", Alias: "Kimi K2.5", Note: "ctx 262144"},
	{ID: "minimax-m2.7", QuotaType: "limited", Alias: "minimax M2.7", Note: "ctx 262144"},
	{ID: "minimax-m3", QuotaType: "limited", Alias: "minimax M3", Note: "ctx 262144"},
	{ID: "qwen3.8-max", QuotaType: "limited", Alias: "Qwen3.8 Max", Note: "ctx 262144"},
}

// opencodeHasKeyedAccount reports whether any enabled non-anonymous account
// exists (the visibility gate for paid models).
func opencodeHasKeyedAccount(m *Manager, provider string) bool {
	for _, a := range m.Accounts(provider) {
		if !a.Enabled {
			continue
		}
		cred, _, err := m.opencodeCredentialFor(a.ID)
		if err != nil || cred == nil {
			continue
		}
		if !isAnonymousOpencodeKey(cred.APIKey) {
			return true
		}
	}
	return false
}

// opencodeVisibleModels implements Product.ModelFilter: with NO keyed account
// the anonymous channel can only serve free models, so paid models are hidden
// from the catalog (ref listModels visibility rule). A keyed account restores
// the full table.
func opencodeVisibleModels(m *Manager, provider string, models []config.ModelDef) []config.ModelDef {
	if opencodeHasKeyedAccount(m, provider) {
		return models
	}
	out := make([]config.ModelDef, 0, len(models))
	for _, md := range models {
		if isFreeOpencodeModel(md.ID) {
			out = append(out, md)
		}
	}
	return out
}

// --- Error classification (ref opencode-product.ts classifyOpencodeError) ---

// opencodeErrorKinds mirror the reference union.
const (
	opencodeErrFreeUsageLimit = "free_usage_limit"
	opencodeErrGoUsageLimit   = "go_usage_limit"
	opencodeErrRateLimit      = "rate_limit"
	opencodeErrFreeTier       = "free_tier"
	opencodeErrQuota          = "quota"
	opencodeErrAuth           = "auth"
	opencodeErrServer         = "server"
	opencodeErrTransport      = "transport"
)

// opencodeErrorInfo is the classified failure.
type opencodeErrorInfo struct {
	kind          string
	retryAfterMs  int64
	hasRetryAfter bool
	detail        string
}

// parseOpencodeRetryAfter parses a `retry-after` header value (seconds or an
// HTTP date) into milliseconds. ⚠️ 0 is a VALID value ("lift immediately");
// callers must use the boolean, never a falsy check.
func parseOpencodeRetryAfter(raw string) (int64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	var seconds float64
	if _, err := fmt.Sscanf(raw, "%f", &seconds); err == nil && seconds >= 0 {
		return int64(seconds*1000 + 0.5), true
	}
	if at, err := time.Parse(time.RFC1123, raw); err == nil {
		ms := at.UnixMilli() - nowMillis()
		if ms < 0 {
			ms = 0
		}
		return ms, true
	}
	return 0, false
}

// opencodeReadableDetail extracts a human-readable fragment from an error body
// (never a raw JSON blob).
func opencodeReadableDetail(body string) string {
	text := strings.TrimSpace(body)
	if text == "" {
		return "（上游未返回错误详情）"
	}
	var data struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
	}
	if err := json.Unmarshal([]byte(text), &data); err == nil {
		parts := []string{}
		if data.Message != "" {
			parts = append(parts, data.Message)
		}
		if len(data.Error) > 0 {
			var s string
			if json.Unmarshal(data.Error, &s) == nil && s != "" {
				parts = append(parts, s)
			} else {
				var nested struct {
					Message string `json:"message"`
				}
				if json.Unmarshal(data.Error, &nested) == nil && nested.Message != "" {
					parts = append(parts, nested.Message)
				}
			}
		}
		if data.Msg != "" {
			parts = append(parts, data.Msg)
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	if len(text) > 500 {
		return text[:500] + "…"
	}
	return text
}

// classifyOpencodeError mirrors the reference classifier: the ORDER is the
// priority. Quota/limit semantics are judged BEFORE the status code because
// Zen's quota errors frequently carry 401/403 — judging by status first would
// misreport "out of quota" as "key invalid" and hide the only useful action.
func classifyOpencodeError(status int, body string, retryAfterMs int64, hasRetryAfter bool) opencodeErrorInfo {
	detail := opencodeReadableDetail(body)
	info := opencodeErrorInfo{kind: opencodeErrAuth, retryAfterMs: retryAfterMs, hasRetryAfter: hasRetryAfter, detail: detail}
	lower := strings.ToLower(body)
	switch {
	case strings.Contains(body, "FreeUsageLimitError"):
		info.kind = opencodeErrFreeUsageLimit
	case strings.Contains(body, "GoUsageLimitError"):
		info.kind = opencodeErrGoUsageLimit
	case strings.Contains(body, "FreeTierError"):
		info.kind = opencodeErrFreeTier
	case status == 429 || strings.Contains(lower, "too many requests") || strings.Contains(lower, "rate limit"):
		info.kind = opencodeErrRateLimit
	case status == 0 || strings.Contains(lower, "fetch failed") || strings.Contains(lower, "terminated") ||
		strings.Contains(lower, "econnreset") || strings.Contains(lower, "socket hang up") ||
		strings.Contains(lower, "getaddrinfo") || strings.Contains(lower, "econnrefused"):
		info.kind = opencodeErrTransport
	case status == 402 || strings.Contains(lower, "insufficient account funds") ||
		strings.Contains(lower, "insufficient funds") || strings.Contains(lower, "insufficient balance"):
		info.kind = opencodeErrQuota
	case status == 401 || status == 403:
		info.kind = opencodeErrAuth
	case status >= 500:
		info.kind = opencodeErrServer
	}
	return info
}

// opencodeRetryAfterMs converts (kind, server delay) into the lock duration.
// Server value wins (clamped to 30min); 0 stays 0. Without a server value:
// free/go usage limits and quota lock for a day (daily quota / empty wallet),
// auth for a minute, everything else exponential up to 30min.
func opencodeRetryAfterMs(kind string, retryAfterMs int64, hasRetryAfter bool, attempt int) int64 {
	const capMs = 30 * 60_000
	if hasRetryAfter {
		if retryAfterMs < 0 {
			return 0
		}
		if retryAfterMs > capMs {
			return capMs
		}
		return retryAfterMs
	}
	switch kind {
	case opencodeErrFreeUsageLimit, opencodeErrGoUsageLimit:
		return 24 * 60 * 60_000
	case opencodeErrQuota:
		return 24 * 60 * 60_000
	case opencodeErrAuth:
		return 60_000
	}
	shift := attempt - 1
	if shift < 0 {
		shift = 0
	}
	ms := int64(60_000) << uint(shift)
	if ms > capMs || ms <= 0 {
		return capMs
	}
	return ms
}

// init registers the opencode key extractor: the bridge uses the Zen API key
// itself as the rotation key (`Bearer <api_key>` is the outbound identity).
func init() {
	RegisterTokenExtractor("opencode", func(cred jsonRaw) (string, error) {
		var c OpencodeCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", errors.New("jethub: parse opencode credential: " + err.Error())
		}
		return c.APIKey, nil
	})
}
