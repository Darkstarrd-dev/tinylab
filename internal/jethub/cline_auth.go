package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Cline login + renewal + balance (ref cline-oauth.ts / cline-auth.ts /
// cline-credits.ts).

// PollClineWorkOsTokens polls until the user completes authorization.
// State machine (source pollWorkOSTokens):
//   - authorization_pending → keep polling at interval (NOT an error);
//   - slow_down → interval += 1s ACCUMULATIVE (a fixed interval keeps being
//     throttled after the server demands slower polling);
//   - access_denied/expired_token/invalid_grant → terminal;
//   - other non-2xx → terminal;
//   - network failures tolerated up to clinePollMaxFailures consecutive.
func (m *Manager) pollClineWorkOsTokens(ctx context.Context, grant *clineDeviceAuthorization) (accessToken, refreshToken string, err error) {
	deadline := nowMillis() + grant.ExpiresInMs
	// ⚠️ At least 1s: a server sending 0/negative would hammer without limit.
	intervalMs := firstPositive(grant.IntervalMs, 1000)
	failures := 0
	for nowMillis() <= deadline {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		default:
		}
		form := map[string]string{
			"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
			"device_code": grant.DeviceCode,
			"client_id":   clineProduct.WorkOSClientID,
		}
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost,
			clineProduct.WorkOSBase+clineDeviceAuthenticatePath, strReader(urlFormEncode(form)))
		if reqErr != nil {
			return "", "", reqErr
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		tctx, cancel := context.WithTimeout(ctx, clineHTTPTimeout)
		req = req.WithContext(tctx)
		resp, reqErr := m.httpClient().Do(req)
		cancel()
		if reqErr != nil {
			failures++
			if failures >= clinePollMaxFailures {
				return "", "", fmt.Errorf("无法连接 Cline 登录服务（连续 %d 次失败）：%v", failures, reqErr)
			}
			clineSleep(ctx, intervalMs)
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		failures = 0

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			access := jsonStringField(payload, "access_token")
			refresh := jsonStringField(payload, "refresh_token")
			if access == "" || refresh == "" {
				// 2xx without tokens = server anomaly (NOT "waiting for user")
				// to avoid an infinite loop.
				return "", "", fmt.Errorf("Cline：WorkOS token 响应缺少必要字段")
			}
			return access, refresh, nil
		}
		switch jsonStringField(payload, "error") {
		case "authorization_pending":
			// ⚠️ Not an error: the user has not clicked authorize yet.
			clineSleep(ctx, intervalMs)
		case "slow_down":
			// Accumulate (source `intervalSeconds += 1`), never reset.
			intervalMs += 1000
			clineSleep(ctx, intervalMs)
		case "access_denied", "expired_token", "invalid_grant":
			return "", "", fmt.Errorf("Cline：%s", firstNonEmpty(jsonStringField(payload, "error_description"), "WorkOS 授权失败"))
		default:
			return "", "", fmt.Errorf("Cline：WorkOS token 轮询失败（HTTP %d）%s", resp.StatusCode, errorDetailOf(payload))
		}
	}
	return "", "", fmt.Errorf("Cline：登录等待已超时，请重新发起登录")
}

// ctxWithTimeout applies a per-call deadline and returns the cancel together
// with the context (poduje callers defer it explicitly).
func ctxWithTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

// clineSleep waits respecting context cancellation.
func clineSleep(ctx context.Context, ms int64) {
	if ms <= 0 {
		ms = 1000
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Duration(ms) * time.Millisecond):
	}
}

// StartClineLogin runs the two-step device-code login: request grant →
// (openURL with verification_uri_complete) → background poll → register →
// persist via CompleteClineLogin.
func (m *Manager) StartClineLogin(ctx context.Context, accountID string, openURL func(string)) (*StartedLogin, error) {
	grant, err := m.RequestClineDeviceAuthorization(ctx)
	if err != nil {
		return nil, err
	}
	loginURL := grant.VerificationURI
	if grant.VerificationURIComplete != "" {
		loginURL = grant.VerificationURIComplete
	}
	if openURL != nil {
		go openURL(loginURL)
	}
	result := make(chan LoginOutcome, 1)
	go func() {
		access, refresh, err := m.pollClineWorkOsTokens(ctx, grant)
		if err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		// WorkOS tokens → Cline tokens (`/api/v1/auth/register`).
		payload, err := m.registerClineTokens(ctx, access, refresh)
		if err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		cred := BuildClineCredential(payload)
		if err := m.CompleteClineLogin(accountID, cred); err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      clineExpiresAtMs(cred),
			Refreshable:    cred.RefreshToken != "",
		})
	}()
	return &StartedLogin{
		LoginURL: loginURL,
		Result:   result,
	}, nil
}

// registerClineTokens POSTs `{accessToken, refreshToken}` (camelCase) to
// /api/v1/auth/register and parses the `{success,data}` envelope.
func (m *Manager) registerClineTokens(ctx context.Context, workOSAccess, workOSRefresh string) (*clineTokenPayload, error) {
	body, _ := json.Marshal(map[string]string{
		"accessToken":  workOSAccess,
		"refreshToken": workOSRefresh,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		clineProduct.APIBase+clineRegisterPath, strReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range clineProduct.ClientHeaders {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, clineHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("Cline：token 注册失败（网络）：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Cline：token 注册失败（HTTP %d）%s", resp.StatusCode, errorDetailOf(payload))
	}
	parsed := parseClineTokenPayload(payload)
	// ⚠️ Judgement is success && data.accessToken (a bare token reading
	// would treat a failure envelope as success).
	if success, _ := payload["success"].(bool); !success || parsed.AccessToken == "" {
		return nil, fmt.Errorf("Cline：token 注册响应无效")
	}
	return parsed, nil
}

// CompleteClineLogin persists the credential (SetCredential triggers the
// key-sync hook) and applies the nickname.
func (m *Manager) CompleteClineLogin(accountID string, cred *ClineCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, clineExpiresAtMs(cred), cred.RefreshToken != ""); err != nil {
		return err
	}
	if cred.Nickname != "" {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = cred.Nickname })
	}
	return nil
}

// RefreshClineAccount renews via /api/v1/auth/refresh (camelCase body).
// Terminal failure marks the account non-refreshable.
func (m *Manager) RefreshClineAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred ClineCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse cline credential %s: %w", accountID, err)
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		clineProduct.APIBase+clineRefreshPath, strReader(ClineRefreshBody(&cred)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range clineProduct.ClientHeaders {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, clineHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("Cline refresh 网络失败：%w", err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	_ = json.Unmarshal(rawBody, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
		return ErrRefreshTokenExpired
	}
	parsed := parseClineTokenPayload(payload)
	if parsed.AccessToken == "" {
		return fmt.Errorf("Cline：续期响应缺少 accessToken")
	}
	refreshed := applyClineRefresh(&cred, parsed)
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, clineExpiresAtMs(refreshed), refreshed.RefreshToken != "")
}

// ClineBalance queries /api/v1/users/{accountId}/balance (accountId, NOT the
// JWT sub — a `user_…` sub returns 400 Invalid request format). The raw
// balance is micro-USD-ish; clineBalanceScale is the single named constant
// for the uncertain conversion, and raw is returned for diagnostics.
func (m *Manager) ClineBalance(ctx context.Context, accountID string) (*CreditBalance, int64, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "cline" {
		return nil, 0, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("cline", acc.CredentialRef)
	if !ok {
		return nil, 0, errCredentialMissing(accountID)
	}
	var cred ClineCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, 0, fmt.Errorf("jethub: parse cline credential %s: %w", accountID, err)
	}
	if cred.AccountID == "" {
		return nil, 0, fmt.Errorf("jethub: cline account_id 缺失（余额端点必填，不能传 JWT sub）")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		clineProduct.APIBase+fmt.Sprintf(clineBalancePathFmt, url.PathEscape(cred.AccountID)), nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range clineHeaders(&cred, true) {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, clineHTTPTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	_ = json.Unmarshal(rawBody, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, 0, fmt.Errorf("Cline：余额查询失败（HTTP %d）", resp.StatusCode)
	}
	// Judgement: success === true && data.balance is a finite number.
	success, _ := payload["success"].(bool)
	data, _ := payload["data"].(map[string]any)
	if !success || data == nil {
		return nil, 0, fmt.Errorf("Cline：余额响应不可解析")
	}
	rawBalance := jsonNumberField(data, "balance")
	total := roundCredits(rawBalance / clineBalanceScale)
	return &CreditBalance{
		Total:    total,
		Packages: []CreditPackage{{Name: "Cline Balance", Unit: "credit", Remaining: total, Total: total, Active: true}},
		IsCredit: true,
	}, int64(rawBalance), nil
}

// clineAugment: standard OpenAI body passthrough; headers replaced with the
// workos:-prefixed bearer + product client identity headers.
func (m *Manager) clineAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "cline" {
		return nil, errAccountNotFound(keyID)
	}
	raw, ok := m.Credential("cline", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(keyID)
	}
	var cred ClineCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(keyID)
	}
	for k := range r.Header {
		r.Header.Del(k)
	}
	for k, v := range clineHeaders(&cred, false) {
		r.Header.Set(k, v)
	}
	// Body passthrough (standard OpenAI protocol — no conversion).
	return body, nil
}
