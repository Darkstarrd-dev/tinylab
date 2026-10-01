package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Cline protocol constants — 1:1 from ref cline.ts / cline-product.ts /
// cline-oauth.ts / cline-credits.ts. Distinctive: WorkOS device-code login,
// `{refreshToken, grantType}` camelCase renewal, `Bearer workos:<jwt>` where
// the prefix MUST be preserved (stripping it 401s), standard OpenAI body.
const (
	clineDeviceAuthorizePath    = "/user_management/authorize/device" // WorkOS grant
	clineDeviceAuthenticatePath = "/user_management/authenticate"     // WorkOS poll
	clineRegisterPath           = "/api/v1/auth/register"             // WorkOS→Cline token
	clineRefreshPath            = "/api/v1/auth/refresh"
	clineChatPath               = "/api/v1/chat/completions"
	clineModelsPath             = "/api/v1/models"
	clineMePath                 = "/api/v1/users/me"
	clineBalancePathFmt         = "/api/v1/users/%s/balance"
	clineHTTPTimeout            = 30 * time.Second
	// Device-auth expires/interval are default fallbacks for the server's
	// expires_in/interval fields (seconds in the response).
	clineDeviceAuthExpires  = 300 * time.Second
	clineDeviceAuthInterval = 5 * time.Second
	clinePollMaxFailures    = 5
	// clineBalanceScale converts the raw balance to credits. ⚠️ The ONLY
	// uncertain point in the module: measured balance:500000, no source
	// evidence for the scale — kept as a single named constant.
	clineBalanceScale = 100_000
)

// clineProduct is the Cline product (seventh independent config; shares only
// the architecture pattern).
var clineProduct = &clineConfig{
	APIBase:        "https://api.cline.bot",
	WorkOSBase:     "https://api.workos.com",
	WorkOSClientID: "client_01K3A541FN8TA3EPPHTD2325AR",
	ClientHeaders: map[string]string{
		"HTTP-Referer":   "https://cline.bot",
		"X-Title":        "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE":  "cline-sdk",
	},
	TokenPrefix: "workos:",
}

type clineConfig struct {
	APIBase        string
	WorkOSBase     string
	WorkOSClientID string
	ClientHeaders  map[string]string
	TokenPrefix    string
}

// ClineCredential mirrors ref cline.ts. The `workos:` prefix is REQUIRED in
// access_token (verified: stripped prefix → 401 with a misleading message).
type ClineCredential struct {
	AccessToken string `json:"access_token"` // carries workos: prefix
	// RefreshToken: presence decides renewability (an unexpired credential
	// without a refresh token still cannot renew).
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpireTime   int64  `json:"expire_time,omitempty"` // ms
	// AccountID (`usr-…`) — the balance endpoint REQUIRES it: the JWT sub
	// (`user_…`) returns `400 {"error":"Invalid request format"}` (verified).
	AccountID string `json:"account_id,omitempty"`
	Email     string `json:"email,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
}

// ClineBearerValue is the idempotent-prefix helper (the server normally sends
// a prefixed value; the patch branch is robustness only — stripped prefix
// yields 401 with text unrelated to the real cause).
func ClineBearerValue(accessToken string) string {
	token := strings.TrimSpace(accessToken)
	if token == "" {
		return ""
	}
	if strings.HasPrefix(token, clineProduct.TokenPrefix) {
		return token
	}
	return clineProduct.TokenPrefix + token
}

// ParseClineTimestamp accepts ISO 8601 / seconds / ms epochs.
func ParseClineTimestamp(value any) int64 {
	switch v := value.(type) {
	case float64:
		if v <= 0 {
			return 0
		}
		if v < 1e12 {
			return int64(v) * 1000
		}
		return int64(v)
	case string:
		if t := strings.TrimSpace(v); t != "" {
			if ms := parseISOTime(t); ms > 0 {
				return ms
			}
			if isAllDigits(t) {
				n := parsePositiveInt(t)
				if n < 1e12 {
					return n * 1000
				}
				return n
			}
		}
	}
	return 0
}

// clineTokenPayload is the register/refresh response payload (both endpoints
// pass through `toClineCredentials`, so shapes match).
type clineTokenPayload struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    int64
	AccountID    string
	Email        string
	DisplayName  string
}

// parseClineTokenPayload reads the `{success,data}` envelope. Judgement is
// `success && data.accessToken` (`requireClineTokenResponse`) — reading a
// bare accessToken would treat a failure envelope as success. Bare responses
// (no `data`) are tolerated.
func parseClineTokenPayload(value map[string]any) *clineTokenPayload {
	if value == nil {
		return &clineTokenPayload{}
	}
	inner, ok := value["data"].(map[string]any)
	if !ok {
		inner = value // bare-response compat
	}
	readStr := func(keys ...string) string {
		for _, k := range keys {
			if s, ok := inner[k].(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}
	out := &clineTokenPayload{
		AccessToken:  readStr("accessToken", "access_token"),
		RefreshToken: readStr("refreshToken", "refresh_token"),
	}
	out.ExpiresAt = ParseClineTimestamp(firstOf(inner["expiresAt"], inner["expires_at"], inner["expire_time"]))
	userInfo, _ := inner["userInfo"].(map[string]any)
	if userInfo != nil {
		out.AccountID = firstNonEmpty(clineJSONString(userInfo, "clineUserId"), clineJSONString(userInfo, "accountId"))
		out.Email = clineJSONString(userInfo, "email")
		first := clineJSONString(userInfo, "firstName")
		last := clineJSONString(userInfo, "lastName")
		out.DisplayName = strings.TrimSpace(strings.TrimSpace(first) + " " + strings.TrimSpace(last))
	}
	if out.AccountID == "" {
		out.AccountID = readStr("accountId", "account_id")
	}
	if out.Email == "" {
		out.Email = readStr("email")
	}
	return out
}

func clineJSONString(src map[string]any, key string) string {
	if src == nil {
		return ""
	}
	if s, ok := src[key].(string); ok {
		return strings.TrimSpace(s)
	}
	if f, ok := src[key].(float64); ok {
		return fmt.Sprintf("%v", f)
	}
	return ""
}

func firstOf(vals ...any) any {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// BuildClineCredential assembles the persisted credential. Nickname prefers
// the email (unique and stable), then display name, then account id.
func BuildClineCredential(payload *clineTokenPayload) *ClineCredential {
	if payload == nil {
		return nil
	}
	nickname := firstNonEmpty(payload.Email, payload.DisplayName, payload.AccountID)
	return &ClineCredential{
		AccessToken:  ClineBearerValue(payload.AccessToken),
		RefreshToken: payload.RefreshToken,
		ExpireTime:   payload.ExpiresAt,
		AccountID:    payload.AccountID,
		Email:        payload.Email,
		Nickname:     nickname,
	}
}

// applyClineRefresh merges a refresh payload. account_id/email/nickname are
// KEPT (the refresh response's userInfo may omit them; losing them breaks the
// balance query and the card display).
func applyClineRefresh(previous *ClineCredential, payload *clineTokenPayload) *ClineCredential {
	if previous == nil || payload == nil {
		return previous
	}
	next := *previous
	next.AccessToken = ClineBearerValue(payload.AccessToken)
	if payload.RefreshToken != "" {
		next.RefreshToken = payload.RefreshToken
	}
	if payload.ExpiresAt > 0 {
		next.ExpireTime = payload.ExpiresAt
	}
	if payload.AccountID != "" {
		next.AccountID = payload.AccountID
	}
	if payload.Email != "" {
		next.Email = payload.Email
	}
	return &next
}

// ClineRefreshBody marshals the camelCase renewal body: {refreshToken,
// grantType}. Both fields are required; a wrong name surfaces as a generic
// auth failure that is nearly impossible to diagnose.
func ClineRefreshBody(cred *ClineCredential) string {
	data, _ := json.Marshal(map[string]string{
		"refreshToken": cred.RefreshToken,
		"grantType":    "refresh_token",
	})
	return string(data)
}

// clineHeaders builds the inference/account header set (workos:-prefixed
// bearer + product client identity headers).
func clineHeaders(cred *ClineCredential, acceptJSON bool) map[string]string {
	accept := "text/event-stream, application/json"
	if acceptJSON {
		accept = "application/json"
	}
	h := map[string]string{
		"Authorization": "Bearer " + ClineBearerValue(cred.AccessToken),
		"Accept":        accept,
		"Content-Type":  "application/json",
	}
	for k, v := range clineProduct.ClientHeaders {
		h[k] = v
	}
	return h
}

// clineExpiresAtMs: 0 when unknown (not judged expired — server 401 decides).
func clineExpiresAtMs(cred *ClineCredential) int64 { return cred.ExpireTime }

// clineErrorDetail extracts error_description for readable failures.
func errorDetailOf(payload map[string]any) string {
	if d, ok := payload["error_description"].(string); ok && d != "" {
		return " - " + d
	}
	return ""
}

// init registers the cline token extractor (the bridge Key carries the
// workos:-prefixed value verbatim — it IS the request bearer).
func init() {
	RegisterTokenExtractor("cline", func(cred jsonRaw) (string, error) {
		var c ClineCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse cline credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// --- WorkOS device-code login (ref cline-oauth.ts) ---

// clineDeviceAuthorization is the device grant offer. device_code/user_code/
// verification_uri are all required.
type clineDeviceAuthorization struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresInMs             int64
	IntervalMs              int64
}

// toMsValue converts a seconds-ish numeric field to ms (nonpositive → 0).
func toMsValue(v any) int64 {
	if f, ok := v.(float64); ok && f > 0 {
		return int64(f) * 1000
	}
	return 0
}

// firstPositive returns the first positive duration value.
func firstPositive(vals ...int64) int64 {
	for _, v := range vals {
		if v > 0 {
			return v
		}
	}
	return 0
}

// RequestClineDeviceAuthorization POSTs the device grant (client_id in the
// form body). Missing device_code/user_code/verification_uri = invalid.
func (m *Manager) RequestClineDeviceAuthorization(ctx context.Context) (*clineDeviceAuthorization, error) {
	form := urlFormEncode(map[string]string{"client_id": clineProduct.WorkOSClientID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		clineProduct.WorkOSBase+clineDeviceAuthorizePath, strReader(form))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	tctx, cancel := context.WithTimeout(ctx, clineHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("cline").Do(req)
	if err != nil {
		return nil, fmt.Errorf("Cline：设备码授权失败（网络）：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	jsonErr := json.Unmarshal(raw, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Cline：设备码授权失败（HTTP %d）%s", resp.StatusCode, errorDetailOf(payload))
	}
	out := &clineDeviceAuthorization{
		DeviceCode:      jsonStringField(payload, "device_code"),
		UserCode:        jsonStringField(payload, "user_code"),
		VerificationURI: jsonStringField(payload, "verification_uri"),
		ExpiresInMs:     firstPositive(toMsValue(payload["expires_in"]), int64(clineDeviceAuthExpires)),
		IntervalMs:      firstPositive(toMsValue(payload["interval"]), int64(clineDeviceAuthInterval)),
	}
	if complete := jsonStringField(payload, "verification_uri_complete"); complete != "" {
		out.VerificationURIComplete = complete
	}
	if out.DeviceCode == "" || out.UserCode == "" || out.VerificationURI == "" {
		snippet := clineBodySnippet(raw, jsonErr)
		if jsonErr == nil {
			snippet += "（JSON 键：" + clineJSONKeys(payload) + "）"
		}
		return nil, fmt.Errorf("Cline：设备码授权响应缺少必要字段（HTTP %d，响应体：%s；%s）",
			resp.StatusCode, snippet, m.clineEgressNote("cline"))
	}
	return out, nil
}

func urlFormEncode(pairs map[string]string) string {
	var b strings.Builder
	first := true
	for k, v := range pairs { // deterministic key order not required here
		if !first {
			b.WriteByte('&')
		}
		first = false
		b.WriteString(urlQueryEscape(k))
		b.WriteByte('=')
		b.WriteString(urlQueryEscape(v))
	}
	return b.String()
}
