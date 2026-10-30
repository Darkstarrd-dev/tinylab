package jethub

// Codely（Unity 团结引擎）provider。
//
// 参考实现：ref/deepseek-harness-codearts @ 301f6bc 的 src/codely-product.ts /
// src/codely-auth.ts / src/codely-sign.ts / src/codely-adapter.ts /
// src/codely-credits.ts。
//
// 形态：
//   - 登录：自有设备码轮询（initiate → poll → exchange），纯 HTTP，无需本地端口；
//   - 推理：OpenAI 兼容网关 `https://codely-litellm.tuanjie.cn/v1/chat/completions`。
//     每次请求先 GET `/api/api-token/cli-api-key` 换发 `sk-` CLI key，再用
//     HMAC-SHA256 签名（`X-Codely-Signature`，覆盖 pathname，LF 分隔）；
//   - 目录：`GET /api/model-status`（Bearer access_token，只取 modelGroup）；
//   - 积分：`GET /api/user/usage/summary`；每日签到走
//     `POST /api/points/check-in/init` → `POST /api/points/check-in`。

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

const (
	codelyProviderID   = "codely"
	codelyDisplayName  = "Codely (Unity)"
	codelyAPIBase      = "https://codely.tuanjie.cn"
	codelyChatHost     = "https://codely-litellm.tuanjie.cn/v1"
	codelyUserAgent    = "codely-vscode/4.3.0"
	codelyHTTPTimeout  = 30 * time.Second
	codelyInferTimeout = 10 * time.Minute
	codelyPollMin      = 500 * time.Millisecond
	codelyPollFailures = 5

	codelyDeviceInitiatePath = "/auth/device/initiate"
	codelyDevicePollPath     = "/auth/device/poll"
	codelyDeviceExchangePath = "/auth/device/exchange"
	codelyMePath             = "/auth/external/me"
	codelyRefreshPath        = "/auth/refresh"
	codelyCLIKeyPath         = "/api/api-token/cli-api-key"
	codelyModelStatusPath    = "/api/model-status"
	codelyUsageSummaryPath   = "/api/user/usage/summary"
	codelyCheckinInitPath    = "/api/points/check-in/init"
	codelyCheckinPath        = "/api/points/check-in"
)

// CodelyCredential is the persisted credential (field names are the backup
// compatibility contract; 1:1 with ref CodelyCredential).
type CodelyCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	// ObtainedAt is the acquisition time (ms).
	ObtainedAt int64 `json:"obtained_at"`
	// ExpiresAt is the access token's absolute expiry (ISO 8601). Decoded from
	// the JWT `exp`; omitted when undecodable (never invent a timestamp).
	ExpiresAt string `json:"expires_at,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
}

func init() {
	RegisterTokenExtractor("codely", func(cred jsonRaw) (string, error) {
		var c CodelyCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse codely credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// codelyCredentialFor resolves + parses a Codely credential by account id.
func (m *Manager) codelyCredentialFor(accountID string) (*CodelyCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != codelyProviderID {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential(codelyProviderID, acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred CodelyCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse codely credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// CodelyFallbackModels is the static catalog (ref CODERLY_FALLBACK_MODELS,
// verbatim `modelGroup` values measured 2026-10-20; no display names invented).
func CodelyFallbackModels() ModelTable {
	return ModelTable{
		{ID: "codely-core", Alias: "codely-core", QuotaType: "limited"},
		{ID: "codely-basic", Alias: "codely-basic", QuotaType: "limited"},
		{ID: "codely-flash", Alias: "codely-flash", QuotaType: "limited"},
		{ID: "codely-air", Alias: "codely-air", QuotaType: "limited"},
		{ID: "codely-vl", Alias: "codely-vl", QuotaType: "limited"},
		{ID: "DeepSeek-V4.1-Flash", Alias: "DeepSeek-V4.1-Flash", QuotaType: "limited"},
		{ID: "GLM-5.3-FLASH", Alias: "GLM-5.3-FLASH", QuotaType: "limited"},
		{ID: "KIMI-K3", Alias: "KIMI-K3", QuotaType: "limited"},
	}
}

// codelyExpiresAtMs parses the credential's ISO expiry (0 = unknown).
func codelyExpiresAtMs(cred *CodelyCredential) int64 {
	if cred == nil || cred.ExpiresAt == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, cred.ExpiresAt)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// CodelyExpiresAtMs exposes the credential expiry to the API layer.
func CodelyExpiresAtMs(cred *CodelyCredential) int64 { return codelyExpiresAtMs(cred) }

// decodeCodelyJWTExpMs decodes the JWT `exp` claim (ms). Returns 0 when the
// token is not a 3-segment JWT or the claim is absent/invalid — never invent.
func decodeCodelyJWTExpMs(token string) int64 {
	claims, ok := decodeJWTPayload(token)
	if !ok {
		return 0
	}
	exp, ok := claims["exp"].(float64)
	if !ok || exp <= 0 {
		return 0
	}
	return int64(exp) * 1000
}

// RefreshCodelyAccount renews the access token via POST /auth/refresh.
// ⚠️ ref refresh_token 不轮换（连续三次返回同值）；缺省时沿用旧值。
func (m *Manager) RefreshCodelyAccount(ctx context.Context, accountID string) error {
	cred, err := m.codelyCredentialFor(accountID)
	if err != nil {
		return err
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	body, _ := json.Marshal(map[string]string{"refresh_token": cred.RefreshToken})
	payload, status, err := m.codelyJSON(ctx, "POST", codelyAPIBase+codelyRefreshPath, body)
	if err != nil {
		return fmt.Errorf("Codely refresh 网络失败：%w", err)
	}
	if status < 200 || status >= 300 || payload == nil {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
		return ErrRefreshTokenExpired
	}
	access, _ := payload["access_token"].(string)
	if access == "" {
		return fmt.Errorf("Codely refresh 响应缺少 access_token")
	}
	nextRefresh, _ := payload["refresh_token"].(string)
	if nextRefresh == "" {
		nextRefresh = cred.RefreshToken
	}
	next := &CodelyCredential{
		AccessToken:  access,
		RefreshToken: nextRefresh,
		ObtainedAt:   nowMillis(),
		ExpiresAt:    codelyISOFromJWT(access),
		Nickname:     cred.Nickname,
	}
	raw, _ := json.Marshal(next)
	if err := m.SetCredential(codelyProviderID, m.credentialRefOf(accountID), raw, codelyExpiresAtMs(next), true); err != nil {
		return err
	}
	return nil
}

// codelyISOFromJWT renders the JWT exp as an ISO timestamp ("" = unknown).
func codelyISOFromJWT(token string) string {
	exp := decodeCodelyJWTExpMs(token)
	if exp == 0 {
		return ""
	}
	return time.UnixMilli(exp).UTC().Format(time.RFC3339)
}

// credentialRefOf returns the account's credential ref ("" when missing).
func (m *Manager) credentialRefOf(accountID string) string {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ""
	}
	return acc.CredentialRef
}
