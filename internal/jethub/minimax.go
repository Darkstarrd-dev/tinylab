package jethub

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MiniMax Code (中国版) protocol constants — 1:1 from ref minimax.ts /
// minimax-product.ts / minimax-oauth.ts / minimax-credits.ts.
// Distinctive: Anthropic Messages inference (NO anthropic-version header —
// verified unnecessary), `mmoat_` prefixed NON-JWT tokens (expires_at MUST be
// written from expires_in), dual-form device poll (HTTP 200 + status OR
// HTTP 400 + error), and base_resp.status_code business codes.
const (
	minimaxDeviceCodePath   = "/oauth2/device/code"
	minimaxTokenPath        = "/oauth2/token"
	minimaxModelsPath       = "/mavis/api/v1/models"
	minimaxInferPath        = "/mavis/api/v1/llm/v1/messages"
	minimaxSigninStatusPath = "/minimax-cloud/api/v1/signin/status"
	minimaxSigninClaimPath  = "/minimax-cloud/api/v1/signin/claim"
	minimaxCreditDetails    = "/minimax-cloud/api/v1/credit/details"
	minimaxRequestTimeout   = 30 * time.Second
	minimaxOAuthTimeout     = 20 * time.Second
)

// minimaxProduct is the product config.
var minimaxProduct = &minimaxConfig{
	AccountHost: "https://account.minimax.cn", APIHost: "https://agent.minimax.cn",
	Region: "cn", BuildEnv: "prod", ClientID: "mcode-public",
	Audience: "agent-backend", Scope: "agent.default",
}

type minimaxConfig struct {
	AccountHost string
	APIHost     string
	Region      string
	BuildEnv    string
	ClientID    string
	Audience    string
	Scope       string
}

// Signin day statuses / claim results / panel scenes (asar enums).
const (
	minimaxStatusActive     = 1
	minimaxStatusClaimable  = 2
	minimaxStatusClaimed    = 3
	minimaxStatusDisabled   = 4
	minimaxClaimClaimed     = 1
	minimaxClaimAlready     = 2
	minimaxSceneUnknown     = 0
	minimaxSceneFirst       = 1
	minimaxSceneActive      = 2
	minimaxSceneCompleted   = 3
	minimaxSceneBroken      = 4
)

// MinimaxCredential mirrors ref minimax.ts. ⚠️ access_token is NOT a JWT
// (mmoat_ prefix, 60 chars, 0 dots) — expires_at MUST be written from
// expires_in or the account shows "unknown" forever.
type MinimaxCredential struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	// ExpiresAt: ms string; a seconds-typed value (>1e12 判据 inverted: ≤1e12
	// = seconds) is tolerated on read — the buddy.ts convention.
	ExpiresAt string `json:"expires_at,omitempty"`
	Scope     string `json:"scope,omitempty"`
	AccountID string `json:"account_id,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
}

// MinimaxExpiresAtMs: numeric-only parsing (' 123 '/'123abc'/'1e12' are
// ILLEGAL — Number('') silently → 0 and Number(' 123 ') → 123 both break the
// semantics); ≤1e12 = seconds → ms (a seconds value read as ms would be 1970
// ⇒ permanently expired + pointless renewals); JWT fallback for future
// JWT-issuing upstreams (currently never hits).
func MinimaxExpiresAtMs(cred *MinimaxCredential) int64 {
	if raw := cred.ExpiresAt; raw != "" && isAllDigits(raw) {
		n := parsePositiveInt(raw)
		if n > 1_000_000_000_000 {
			return n
		}
		return n * 1000
	}
	return jwtExpiresAtMs(cred.AccessToken)
}

// MinimaxRefreshable: refresh_token present.
func MinimaxRefreshable(cred *MinimaxCredential) bool { return cred.RefreshToken != "" }

// minimaxHeaders: business endpoints need ONLY Bearer (signin/credits/catalog
// verified — no machine headers, unlike Qoder's /sash/).
func minimaxHeaders(cred *MinimaxCredential, withBody bool) map[string]string {
	h := map[string]string{
		"Authorization": "Bearer " + cred.AccessToken,
		"Accept":        "application/json",
	}
	if withBody {
		h["Content-Type"] = "application/json"
	}
	return h
}

// MinimaxInferHeaders: ⚠️ NO anthropic-version header (verified 2026-09-29:
// Authorization + Content-Type + Accept alone → 200; adding the documented
// header is an unverified guess). Accept = text/event-stream (stream:true).
func MinimaxInferHeaders(cred *MinimaxCredential) map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + cred.AccessToken,
		"Content-Type":  "application/json",
		"Accept":        "text/event-stream",
	}
}

// createMinimaxPKCE generates the S256 pair.
func createMinimaxPKCE() (verifier, challenge string, err error) {
	p, err := GeneratePkcePair()
	if err != nil {
		return "", "", err
	}
	return p.CodeVerifier, p.CodeChallenge, nil
}

// minimaxDeviceAuthorization is the device grant offer.
type minimaxDeviceAuthorization struct {
	DeviceCode              string
	CodeVerifier            string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresInSec            int64
	IntervalSec             int64
}

// parseMinimaxDeviceAuthorization: interval defaults to 5 SECONDS (asar value);
// verification_url is an accepted alias.
func parseMinimaxDeviceAuthorization(payload map[string]any) *minimaxDeviceAuthorization {
	if payload == nil {
		return nil
	}
	deviceCode := jsonStringField(payload, "device_code")
	userCode := jsonStringField(payload, "user_code")
	verification := firstNonEmpty(jsonStringField(payload, "verification_uri"), jsonStringField(payload, "verification_url"))
	expiresIn := jsonNumberField(payload, "expires_in")
	if deviceCode == "" || userCode == "" || verification == "" || expiresIn <= 0 {
		return nil
	}
	interval := jsonNumberField(payload, "interval")
	if interval <= 0 {
		interval = 5
	}
	return &minimaxDeviceAuthorization{
		DeviceCode: deviceCode, UserCode: userCode, VerificationURI: verification,
		VerificationURIComplete: firstNonEmpty(jsonStringField(payload, "verification_uri_complete"), verification),
		ExpiresInSec:            int64(expiresIn), IntervalSec: int64(interval),
	}
}

// StartMinimaxDeviceAuthorization requests the device grant (PKCE S256 body).
func (m *Manager) StartMinimaxDeviceAuthorization(ctx context.Context) (*minimaxDeviceAuthorization, error) {
	verifier, challenge, err := createMinimaxPKCE()
	if err != nil {
		return nil, err
	}
	form := map[string]string{
		"client_id": minimaxProduct.ClientID, "scope": minimaxProduct.Scope,
		"audience": minimaxProduct.Audience, "code_challenge": challenge,
		"code_challenge_method": "S256",
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		minimaxProduct.AccountHost+minimaxDeviceCodePath, strReader(urlFormEncode(form)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	tctx, cancel := context.WithTimeout(ctx, minimaxOAuthTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("minimax").Do(req)
	if err != nil {
		return nil, fmt.Errorf("MiniMax 设备码申请失败（网络）：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("MiniMax 设备码申请失败（HTTP %d）", resp.StatusCode)
	}
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	parsed := parseMinimaxDeviceAuthorization(payload)
	if parsed == nil {
		return nil, fmt.Errorf("MiniMax 设备码响应无法解析")
	}
	parsed.CodeVerifier = verifier
	return parsed, nil
}

// minimaxTokenGrant is the shared poll/refresh token response parser.
// Hard validations (asar parseTokenGrant): access_token non-empty,
// refresh_token non-empty (fallback to previous), token_type == bearer,
// expires_in positive, scope MUST contain the product scope (else the
// credential is invalid — invalid_token_response).
func parseMinimaxTokenGrant(payload map[string]any, previousRefresh string) (*MinimaxCredential, error) {
	if payload == nil {
		return nil, fmt.Errorf("MiniMax 令牌响应不是对象")
	}
	access := jsonStringField(payload, "access_token")
	refresh := jsonStringField(payload, "refresh_token")
	if refresh == "" {
		refresh = previousRefresh // 缺失时回退上一个（asar 行为）
	}
	tokenType := jsonStringField(payload, "token_type")
	expiresIn := jsonNumberField(payload, "expires_in")
	if access == "" {
		return nil, fmt.Errorf("MiniMax 令牌响应缺少 access_token")
	}
	if refresh == "" {
		return nil, fmt.Errorf("MiniMax 令牌响应缺少 refresh_token")
	}
	if !strings.EqualFold(tokenType, "bearer") {
		return nil, fmt.Errorf("MiniMax 令牌响应的 token_type 不是 Bearer")
	}
	if expiresIn <= 0 {
		return nil, fmt.Errorf("MiniMax 令牌响应缺少 expires_in")
	}
	scope := jsonStringField(payload, "scope")
	if !containsToken(scope, minimaxProduct.Scope) {
		return nil, fmt.Errorf("MiniMax 令牌响应的 scope 不含 %s", minimaxProduct.Scope)
	}
	// ⚠️ expires_at 以 expires_in 为准（token 非 JWT——不能指望从 token 解；
	// 不写 expires_at 会让账号永远显示「未知」）。
	return &MinimaxCredential{
		AccessToken: access, RefreshToken: refresh, TokenType: "Bearer",
		ExpiresAt: fmt.Sprintf("%d", nowMillis()+int64(expiresIn)*1000),
		Scope:     scope,
		AccountID: jwtSubOf(access), // JWT 兜底兼容（当前恒空）
	}, nil
}

// containsToken reports whether a space-separated scope list contains target.
func containsToken(scope, target string) bool {
	for _, part := range strings.Fields(scope) {
		if part == target {
			return true
		}
	}
	return false
}

func jwtSubOf(token string) string { return jwtSubject(token) }

// sha256SumHex is the challenge helper.
func sha256SumHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hexEncodeLower(sum[:])
}

func hexEncodeLower(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, x := range b {
		out = append(out, digits[x>>4], digits[x&0x0F])
	}
	return string(out)
}

// minimaxTokenPOST posts a form body to the token endpoint.
func (m *Manager) minimaxTokenPOST(ctx context.Context, form map[string]string) (map[string]any, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		minimaxProduct.AccountHost+minimaxTokenPath, strReader(urlFormEncode(form)))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	tctx, cancel := context.WithTimeout(ctx, minimaxOAuthTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("minimax").Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	return payload, resp.StatusCode, nil
}

// PollMinimaxDeviceToken polls until tokens arrive. ⚠️ BOTH "waiting" forms
// are recognized (MiniMax's account service uses HTTP 200 + status=pending —
// unlike the OAuth-standard 400 + error=authorization_pending; treating a 200
// pending as success would store an empty credential).
func (m *Manager) PollMinimaxDeviceToken(ctx context.Context, grant *minimaxDeviceAuthorization) (*MinimaxCredential, error) {
	deadline := nowMillis() + grant.ExpiresInSec*1000
	intervalMs := grant.IntervalSec * 1000
	for nowMillis() < deadline {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeAfter(time.Duration(intervalMs) * time.Millisecond):
		}
		payload, status, err := m.minimaxTokenPOST(ctx, map[string]string{
			"grant_type": "urn:ietf:params:oauth:grant-type:device_code",
			"device_code": grant.DeviceCode, "client_id": minimaxProduct.ClientID,
			"code_verifier": grant.CodeVerifier,
		})
		if err != nil {
			continue // transient network → keep polling
		}
		respStatus := jsonStringField(payload, "status")
		respError := jsonStringField(payload, "error")
		// 形态一：HTTP 200 + status 字段。
		if status >= 200 && status < 300 {
			switch respStatus {
			case "pending":
				continue
			case "slow_down":
				intervalMs += 5000
				continue
			case "denied", "access_denied":
				return nil, fmt.Errorf("MiniMax：授权被拒绝")
			case "expired", "expired_token":
				return nil, fmt.Errorf("MiniMax：授权已过期，请重新发起登录")
			}
			// 200 且无 pending 类 status → 成功 grant。
			return parseMinimaxTokenGrant(payload, "")
		}
		// 形态二：非 200 + error（OAuth 标准形态）。
		switch respError {
		case "authorization_pending":
			continue
		case "slow_down":
			intervalMs += 5000
			continue
		}
		return nil, fmt.Errorf("MiniMax 授权失败：%s", firstNonEmpty(respError, fmt.Sprintf("HTTP %d", status)))
	}
	return nil, fmt.Errorf("MiniMax：授权已过期，请重新发起登录")
}

// RefreshMinimaxCredential renews via the same token endpoint.
func (m *Manager) RefreshMinimaxCredential(ctx context.Context, previous *MinimaxCredential) (*MinimaxCredential, error) {
	payload, status, err := m.minimaxTokenPOST(ctx, map[string]string{
		"grant_type": "refresh_token", "refresh_token": previous.RefreshToken,
		"client_id": minimaxProduct.ClientID, "scope": minimaxProduct.Scope,
		"audience": minimaxProduct.Audience,
	})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("MiniMax 续期失败：%s", firstNonEmpty(jsonStringField(payload, "error"), fmt.Sprintf("HTTP %d", status)))
	}
	return parseMinimaxTokenGrant(payload, previous.RefreshToken)
}

// init registers the minimax token extractor.
func init() {
	RegisterTokenExtractor("minimax", func(cred jsonRaw) (string, error) {
		var c MinimaxCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse minimax credential: %w", err)
		}
		return c.AccessToken, nil
	})
}
