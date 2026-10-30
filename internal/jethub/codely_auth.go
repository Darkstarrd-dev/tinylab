package jethub

// Codely 设备码登录（ref src/codely-auth.ts @ 301f6bc）。
//
// 三步协议（纯 HTTP，无本地回调端口）：
//
//	POST /auth/device/initiate {provider:"unity", client_name:"codely-vscode", auth_from:"vscode-codely"}
//	  → {auth_request_token, user_code, verification_uri, verification_uri_complete, interval, expires_in}
//	GET  /auth/device/poll?auth_request_token=…
//	  → {status:"pending|slow_down|authorized|completed|denied|expired", authorization_code?}
//	POST /auth/device/exchange {authorization_code}
//	  → {access_token, refresh_token}
//
// 凭据字段与 ref 1:1；过期时刻从 access_token 的 JWT `exp` 解码（响应里没有
// expires_in），解码不出就缺省（绝不编造）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// codelyDeviceAuth is the device-authorization grant.
type codelyDeviceAuth struct {
	AuthRequestToken string
	UserCode         string
	VerificationURI  string
	LoginURL         string
	Interval         time.Duration
	Expires          time.Duration
}

// codelyJSON performs one anonymous JSON request with the provider's HTTP client.
func (m *Manager) codelyJSON(ctx context.Context, method, endpoint string, body []byte) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-User-Agent", codelyUserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	tctx, cancel := context.WithTimeout(ctx, codelyHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient(codelyProviderID).Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &parsed)
	}
	return parsed, resp.StatusCode, nil
}

// codelyAuthorizedJSON is codelyJSON with `Authorization: Bearer <token>`.
func (m *Manager) codelyAuthorizedJSON(ctx context.Context, method, endpoint string, body []byte, accessToken string) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-User-Agent", codelyUserAgent)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	tctx, cancel := context.WithTimeout(ctx, codelyHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient(codelyProviderID).Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &parsed)
	}
	return parsed, resp.StatusCode, nil
}

// RequestCodelyDeviceAuthorization starts the flow (step ①).
func (m *Manager) RequestCodelyDeviceAuthorization(ctx context.Context) (*codelyDeviceAuth, error) {
	body, _ := json.Marshal(map[string]string{
		"provider":    "unity",
		"client_name": "codely-vscode",
		"auth_from":   "vscode-codely",
	})
	payload, status, err := m.codelyJSON(ctx, http.MethodPost, codelyAPIBase+codelyDeviceInitiatePath, body)
	if err != nil {
		return nil, fmt.Errorf("Codely 设备码授权网络失败：%w", err)
	}
	if status < 200 || status >= 300 || payload == nil {
		return nil, fmt.Errorf("Codely 设备码授权失败（HTTP %d）", status)
	}
	return codelyParseDeviceAuth(payload)
}

// codelyParseDeviceAuth is the pure parse step (split out for tests).
func codelyParseDeviceAuth(payload map[string]any) (*codelyDeviceAuth, error) {
	token, _ := payload["auth_request_token"].(string)
	userCode, _ := payload["user_code"].(string)
	uri, _ := payload["verification_uri"].(string)
	complete, _ := payload["verification_uri_complete"].(string)
	if token == "" || uri == "" {
		return nil, fmt.Errorf("Codely 设备码授权响应缺少必要字段")
	}
	loginURL := uri
	if complete != "" {
		loginURL = complete
	}
	return &codelyDeviceAuth{
		AuthRequestToken: token,
		UserCode:         userCode,
		VerificationURI:  uri,
		LoginURL:         loginURL,
		Interval:         codelySecondsOr(payload["interval"], 2*time.Second),
		Expires:          codelySecondsOr(payload["expires_in"], 15*time.Minute),
	}, nil
}

// codelySecondsOr converts a JSON seconds value to a duration with a fallback.
func codelySecondsOr(value any, fallback time.Duration) time.Duration {
	n, ok := zcodeJSONNumber(value)
	if !ok || n <= 0 {
		return fallback
	}
	return time.Duration(n * float64(time.Second))
}

// PollCodelyAuthorizationCode polls until the user authorizes (step ②).
//
// State machine (ref): pending → keep; slow_down → interval +=1s (accumulative);
// authorized → return code; completed/denied/expired/other → terminal; network
// failures tolerated up to codelyPollFailures consecutive.
func (m *Manager) PollCodelyAuthorizationCode(ctx context.Context, auth *codelyDeviceAuth) (string, error) {
	deadline := time.Now().Add(auth.Expires)
	interval := auth.Interval
	if interval < codelyPollMin {
		interval = codelyPollMin
	}
	failures := 0
	for time.Now().Before(deadline) {
		endpoint := codelyAPIBase + codelyDevicePollPath + "?auth_request_token=" + url.QueryEscape(auth.AuthRequestToken)
		payload, status, err := m.codelyJSON(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			failures++
			if failures >= codelyPollFailures {
				return "", fmt.Errorf("Codely 登录轮询网络连续失败 %d 次：%w", failures, err)
			}
		} else if status < 200 || status >= 300 || payload == nil {
			// ref: 非 2xx / 非 JSON ⇒ 终态失败（不是可重试的服务端故障）。
			return "", fmt.Errorf("Codely 登录轮询失败（HTTP %d）", status)
		} else {
			failures = 0
			state, _ := payload["status"].(string)
			switch state {
			case "pending":
				// keep polling
			case "slow_down":
				interval += time.Second
			case "authorized":
				code, _ := payload["authorization_code"].(string)
				if code == "" {
					return "", fmt.Errorf("Codely 授权成功但响应缺少 authorization_code")
				}
				return code, nil
			case "completed":
				return "", fmt.Errorf("Codely 授权码已被使用，请重新发起登录")
			case "denied":
				return "", fmt.Errorf("Codely 登录被拒绝")
			case "expired":
				return "", fmt.Errorf("Codely 设备码已过期，请重新发起登录")
			default:
				return "", fmt.Errorf("Codely 登录状态异常（%q）", state)
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
	}
	return "", fmt.Errorf("Codely 登录超时（设备码有效期 %.0f 分钟）", auth.Expires.Minutes())
}

// ExchangeCodelyAuthorizationCode exchanges the code for tokens (step ③).
func (m *Manager) ExchangeCodelyAuthorizationCode(ctx context.Context, code string) (string, string, error) {
	body, _ := json.Marshal(map[string]string{"authorization_code": code})
	payload, status, err := m.codelyJSON(ctx, http.MethodPost, codelyAPIBase+codelyDeviceExchangePath, body)
	if err != nil {
		return "", "", fmt.Errorf("Codely 令牌交换网络失败：%w", err)
	}
	if status < 200 || status >= 300 || payload == nil {
		return "", "", fmt.Errorf("Codely 令牌交换失败（HTTP %d）", status)
	}
	return codelyParseExchange(payload)
}

// codelyParseExchange is the pure parse step (split out for tests).
func codelyParseExchange(payload map[string]any) (string, string, error) {
	access, _ := payload["access_token"].(string)
	refresh, _ := payload["refresh_token"].(string)
	if access == "" || refresh == "" {
		return "", "", fmt.Errorf("Codely 令牌交换响应缺少必要字段")
	}
	return access, refresh, nil
}

// FetchCodelyNickname queries /auth/external/me (best-effort).
func (m *Manager) FetchCodelyNickname(ctx context.Context, accessToken string) string {
	payload, status, err := m.codelyAuthorizedJSON(ctx, http.MethodGet, codelyAPIBase+codelyMePath, nil, accessToken)
	if err != nil || status < 200 || status >= 300 || payload == nil {
		return ""
	}
	name, _ := payload["username"].(string)
	if strings.TrimSpace(name) == "" {
		name, _ = payload["email"].(string)
	}
	return strings.TrimSpace(name)
}

// CompleteCodelyLogin persists the exchanged tokens (called after poll).
func (m *Manager) CompleteCodelyLogin(accountID, accessToken, refreshToken string) (*CodelyCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return nil, ErrNotFound
	}
	nickname := m.FetchCodelyNickname(context.Background(), accessToken)
	cred := &CodelyCredential{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ObtainedAt:   nowMillis(),
		ExpiresAt:    codelyISOFromJWT(accessToken),
		Nickname:     nickname,
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		return nil, err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, raw, codelyExpiresAtMs(cred), refreshToken != ""); err != nil {
		return nil, err
	}
	if nickname != "" {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = nickname })
	}
	return cred, nil
}

// decodeJWTPayload decodes the middle segment of a JWT (claims only, no
// signature verification — we read claims, we do not authenticate).
func decodeJWTPayload(token string) (map[string]any, bool) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return nil, false
	}
	payload := strings.ReplaceAll(strings.ReplaceAll(segments[1], "-", "+"), "_", "/")
	for len(payload)%4 != 0 {
		payload += "="
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, false
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, false
	}
	return claims, true
}
