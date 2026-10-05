package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// CodeArts ticket (legacy login fallback) endpoint + constants.
const (
	codeartsCredentialEndpoint = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket"
	codeartsTicketPollAttempts = 120
	codeartsTicketPluginName   = "snap_jetbrains"
	codeartsTicketPluginVer    = "26.3.3"
)

// CodeArtsChatAPIBase is the inference base URL registered by the product.
const CodeArtsChatAPIBase = codeartsBaseURL

// CodeArtsQueueStatusBase is the concurrency queue status endpoint.
const CodeArtsQueueStatusBase = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status"

// ticketResponse mirrors ref types.ts CodeArtsCredentialResponse.
type ticketResponse struct {
	Credential *struct {
		Access        string `json:"access"`
		Secret        string `json:"secret"`
		Securitytoken string `json:"securitytoken"`
		SecurityToken string `json:"securityToken"`
		ExpiresAt     string `json:"expires_at"`
		ExpiresAtAlt  string `json:"expiresAt"`
	} `json:"credential"`
	Result *struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		SecurityToken   string `json:"securityToken"`
		Expiration      string `json:"expiration"`
		ExpiresAt       string `json:"expiresAt"`
	} `json:"result"`
	DomainID string `json:"domain_id"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}

// parseTicketCredential normalizes both response envelope shapes; nil when
// incomplete.
func parseTicketCredential(data *ticketResponse) *CodeArtsCredential {
	if data == nil {
		return nil
	}
	if data.Credential != nil && data.Credential.Access != "" {
		st := data.Credential.Securitytoken
		if st == "" {
			st = data.Credential.SecurityToken
		}
		if st == "" {
			return nil
		}
		expires := data.Credential.ExpiresAt
		if expires == "" {
			expires = data.Credential.ExpiresAtAlt
		}
		return &CodeArtsCredential{
			AccessKeyID: data.Credential.Access, SecretAccessKey: data.Credential.Secret,
			SecurityToken: st, ExpiresAt: expires,
			DomainID: data.DomainID, UserID: data.UserID, UserName: data.UserName,
		}
	}
	if data.Result != nil && data.Result.AccessKeyID != "" && data.Result.SecurityToken != "" {
		expires := data.Result.Expiration
		if expires == "" {
			expires = data.Result.ExpiresAt
		}
		return &CodeArtsCredential{
			AccessKeyID: data.Result.AccessKeyID, SecretAccessKey: data.Result.SecretAccessKey,
			SecurityToken: data.Result.SecurityToken, ExpiresAt: expires,
		}
	}
	return nil
}

// pollCodeArtsTicket polls the ticket endpoint until credentials arrive or
// attempts are exhausted (1s interval; transient failures skipped).
func pollCodeArtsTicket(ctx context.Context, ticketID, secret, pluginName, pluginVersion string) (*CodeArtsCredential, error) {
	if pluginName == "" {
		pluginName = codeartsTicketPluginName
	}
	if pluginVersion == "" {
		pluginVersion = codeartsTicketPluginVer
	}
	endpoint := codeartsCredentialEndpoint + "?ticket_id=" + url.QueryEscape(ticketID) + "&secret=" + url.QueryEscape(secret)
	for i := 0; i < codeartsTicketPollAttempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json;charset=UTF-8")
		req.Header.Set("plugin-name", pluginName)
		req.Header.Set("plugin-version", pluginVersion)
		resp, err := callbackClient.Do(req)
		if err != nil {
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			continue
		}
		var tr ticketResponse
		if err := json.Unmarshal(data, &tr); err != nil {
			continue
		}
		if cred := parseTicketCredential(&tr); cred != nil {
			return cred, nil
		}
	}
	return nil, fmt.Errorf("jethub: codearts login timed out")
}

// codeartsCredentialExpiresAt parses expires_at into a ms timestamp; a
// missing/unparsable value falls back to +24h (aligned with the plugin).
func codeartsCredentialExpiresAt(cred *CodeArtsCredential) int64 {
	if ms, ok := codeartsExpiryMs(cred); ok {
		return ms
	}
	return time.Now().Add(24 * time.Hour).UnixMilli()
}

// codeartsRefreshable reports whether the credential carries a full renewal
// kit (refresh_token + code_verifier + dpop JWK).
func codeartsRefreshable(cred *CodeArtsCredential) bool {
	return cred != nil && cred.RefreshToken != "" && cred.CodeVerifier != "" && cred.DpopPrivateJwk != nil
}

// codeartsRefreshLead mirrors ref REFRESH_LEAD_MS (refresh.ts): renew when the
// access credential expires within one hour.
const codeartsRefreshLead = time.Hour

// codeartsRefreshSchedulerInterval mirrors the plugin's 30-minute scheduler
// round (ref index.ts, including the startup first round).
const codeartsRefreshSchedulerInterval = 30 * time.Minute

// codeartsExpiryMs parses the credential expiry into a ms timestamp;
// ok=false when missing/unparsable. Huawei emits "2006-01-02T15:04:05Z07:00"
// -ish strings without strict RFC3339 sometimes; a couple of common layouts
// are tried.
func codeartsExpiryMs(cred *CodeArtsCredential) (int64, bool) {
	if cred == nil || cred.ExpiresAt == "" {
		return 0, false
	}
	if t, err := time.Parse(time.RFC3339, cred.ExpiresAt); err == nil {
		return t.UnixMilli(), true
	}
	for _, layout := range []string{"2006-01-02T15:04:05Z", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, cred.ExpiresAt); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// codeartsShouldRefreshNow mirrors ref shouldRefreshNow (expiry-sync.ts):
// an unknown expiry counts as "refresh now"; otherwise renew only when the
// credential expires within the lead window.
func codeartsShouldRefreshNow(cred *CodeArtsCredential, nowMs int64) bool {
	exp, ok := codeartsExpiryMs(cred)
	if !ok {
		return true
	}
	return exp-nowMs <= codeartsRefreshLead.Milliseconds()
}

// lockCodeartsRefresh serializes refreshes per credentialRef (ref cf5edab):
// the scheduler and the manual refresh button must not consume the SAME
// refresh_token concurrently — Huawei STS invalidates the old one when it
// issues a new credential, so a concurrent loser would read a spurious
// invalid_grant (and, before this fix, mark the account dead).
func (m *Manager) lockCodeartsRefresh(ref string) func() {
	v, _ := m.codeartsRefreshLocks.LoadOrStore(ref, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// codeartsCredential reads + parses the stored credential of an account
// (nil, nil when absent).
func (m *Manager) codeartsCredential(acc *Account) (*CodeArtsCredential, error) {
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return nil, nil
	}
	var cred CodeArtsCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse credential %s: %w", acc.ID, err)
	}
	return &cred, nil
}

// RefreshCodeArtsAccount renews one stored credential via refresh_token and
// writes the merged credential back (preserving domain_id/user_id/user_name
// and model_rate_limits like the plugin's refreshCredential).
func (m *Manager) RefreshCodeArtsAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	cred, err := m.codeartsCredential(&acc)
	if err != nil {
		return err
	}
	if cred == nil {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	if !codeartsRefreshable(cred) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}

	// 串行 + 锁内重读：另一个调用者可能刚续期成功（STS 换新会作废旧
	// refresh_token，并发消费必然「1 成功 N invalid_grant」）。
	unlock := m.lockCodeartsRefresh(acc.CredentialRef)
	defer unlock()
	latest, err := m.codeartsCredential(&acc)
	if err != nil {
		return err
	}
	if latest == nil || !codeartsRefreshable(latest) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}
	// 锁内重读后仍在有效期内 ⇒ 不发请求（ref cf5edab：续期只在到期前窗口内
	// 发生；这同时让「等锁期间已被他处续好」的第二个调用者少烧一次
	// refresh_token —— 华为 STS 换新会作废旧的那一份）。
	if !codeartsShouldRefreshNow(latest, nowMillis()) {
		if m.logger != nil {
			m.logger.Info("[jethub] codearts 账号 %s 凭据仍在有效期内（可能已被他处续期），跳过本次续期请求", accountID)
		}
		return nil
	}
	return m.refreshCodeArtsLocked(ctx, &acc, latest)
}

// refreshCodeArtsLocked performs the exchange + persistence. The caller holds
// the per-credentialRef lock.
func (m *Manager) refreshCodeArtsLocked(ctx context.Context, acc *Account, cred *CodeArtsCredential) error {
	priv, err := KeyPairFromStoredJwk(*cred.DpopPrivateJwk)
	if err != nil {
		return err
	}
	token, err := ExchangeCodeArtsRefreshToken(ctx, cred.RefreshToken, cred.CodeVerifier, priv)
	if err != nil {
		if err == ErrRefreshTokenExpired {
			// 判终态前先重读（ref cf5edab 第 2 条）：若 refresh_token 已被他处
			// 换新，那是「别人已经续成功」（服务端烧的是旧的那一份），不是
			// 「本账号不可续期」—— 不作废账号。
			if latest, rerr := m.codeartsCredential(acc); rerr == nil && latest != nil && latest.RefreshToken != cred.RefreshToken {
				if m.logger != nil {
					m.logger.Warn("[jethub] codearts 账号 %s: refresh_token 已被他处续期，本次 invalid_grant 不按终态处理", acc.ID)
				}
				return nil
			}
			// Terminal: mark the account non-refreshable so the scheduler and
			// UI stop treating it as renewable. Only write when the value
			// changes — the account file is rewritten as a whole and the
			// scheduler runs every 30min.
			if acc.Refreshable {
				_ = m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = false })
			}
		}
		return err
	}
	refreshed := CredentialFromTokenResponse(token, PkcePair{CodeVerifier: cred.CodeVerifier}, cred.DpopPrivateJwk)
	refreshed.DomainID = cred.DomainID
	refreshed.UserID = cred.UserID
	refreshed.UserName = cred.UserName
	refreshed.ModelRateLimits = cred.ModelRateLimits
	merged, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, merged, codeartsCredentialExpiresAt(refreshed), codeartsRefreshable(refreshed))
}

// RefreshAllCodeArts renews every codearts account whose credential material
// is complete and whose access token expires within the lead window
// (including disabled ones — disabled only affects selection, not credential
// health).
//
// ⚠️ `refreshable` 只是**凭据材料的镜像**：每轮按凭据对账（被误标的账号在
// 下一轮自愈），绝不能拿它当调度判据（ref cf5edab 第 1 条：把调度建在它上面
// 会让被误标的账号永不进入续期循环，重启也没用）。Single-account failures are
// logged and do not abort the loop.
func (m *Manager) RefreshAllCodeArts(ctx context.Context) {
	for _, acc := range m.Accounts("codearts") {
		cred, err := m.codeartsCredential(&acc)
		if err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] codearts 账号 %s 凭据解析失败: %v", acc.ID, err)
			}
			continue
		}
		want := codeartsRefreshable(cred)
		if acc.Refreshable != want {
			_ = m.UpdateAccount(acc.ID, func(a *Account) { a.Refreshable = want })
		}
		if !want || !codeartsShouldRefreshNow(cred, nowMillis()) {
			continue
		}
		if err := m.RefreshCodeArtsAccount(ctx, acc.ID); err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] codearts 账号 %s 续期失败: %v", acc.ID, err)
			}
		}
	}
}

// StartRefreshScheduler runs the codearts renewal loop until ctx is done: one
// pass immediately (the plugin's startup first round) and then every 30
// minutes (ref index.ts). Failures never surface to the user — they are
// logged and retried next round.
func (m *Manager) StartRefreshScheduler(ctx context.Context) {
	go func() {
		m.RefreshAllCodeArts(ctx)
		ticker := time.NewTicker(codeartsRefreshSchedulerInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.RefreshAllCodeArts(ctx)
			}
		}
	}()
}

// CompleteCodeArtsLogin persists the outcome of a finished login flow:
// stores the credential on the account's ref, refreshes display fields and
// re-syncs the bridged keys (via the SetCredential hook). Called by the API
// layer's login result pump.
func (m *Manager) CompleteCodeArtsLogin(accountID string, credentialJSON []byte, expiresAt int64, refreshable bool) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credentialJSON, expiresAt, refreshable)
}

// SetAccountCredentialedHook registers the post-credential callback (the app
// wires it to Bridge.SyncKeys so the bridged provider picks up new keys).
func (m *Manager) SetAccountCredentialedHook(fn func(provider string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onAccountCredentialed = fn
}

// SetBrowserOpener registers the "open the login page in the chosen browser"
// callback. internal/app wires it to Manager.OpenLoginURL (the built-in
// launcher, incl. private windows and per-account isolated profiles); nil (unit
// tests) means no browser is launched at all, so tests never pop windows.
//
// The OpenOptions carry the browser/session the user picked in the +新建账号
// dialog; the zero value means "the remembered preference".
func (m *Manager) SetBrowserOpener(fn func(url string, opt OpenOptions)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.browserOpener = fn
}

// openURLWithBrowser invokes the registered opener asynchronously. It never
// fails the login on an opener error (the dialog keeps the link as a manual
// fallback) — the *selection* is validated synchronously by the API layer
// before the flow starts, so an unusable choice is a 4xx, not a silent no-op.
func (m *Manager) openURLWithBrowser(url string, opt OpenOptions) {
	m.mu.RLock()
	fn := m.browserOpener
	m.mu.RUnlock()
	if fn == nil {
		return
	}
	go func() { fn(url, opt) }()
}

// OpenURLWithBrowser is the API layer's entry point: the handlers that build the
// login URL inline (minimax/qoder/raccoon/loomy/zcode) and background actions
// call it with the selection from the request (zero value = remembered
// preference).
func (m *Manager) OpenURLWithBrowser(url string, opt OpenOptions) {
	m.openURLWithBrowser(url, opt)
}
