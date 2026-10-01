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
		AccessKeyID   string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		SecurityToken string `json:"securityToken"`
		Expiration    string `json:"expiration"`
		ExpiresAt     string `json:"expiresAt"`
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
	if cred != nil && cred.ExpiresAt != "" {
		if t, err := time.Parse(time.RFC3339, cred.ExpiresAt); err == nil {
			return t.UnixMilli()
		}
		// Huawei emits "2006-01-02T15:04:05Z07:00"-ish without strict RFC3339
		// sometimes; try a couple of common layouts.
		for _, layout := range []string{"2006-01-02T15:04:05Z", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, cred.ExpiresAt); err == nil {
				return t.UnixMilli()
			}
		}
	}
	return time.Now().Add(24 * time.Hour).UnixMilli()
}

// codeartsRefreshable reports whether the credential carries a full renewal
// kit (refresh_token + code_verifier + dpop JWK).
func codeartsRefreshable(cred *CodeArtsCredential) bool {
	return cred != nil && cred.RefreshToken != "" && cred.CodeVerifier != "" && cred.DpopPrivateJwk != nil
}

// RefreshCodeArtsAccount renews one stored credential via refresh_token and
// writes the merged credential back (preserving domain_id/user_id/user_name
// and model_rate_limits like the plugin's refreshCredential).
func (m *Manager) RefreshCodeArtsAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred CodeArtsCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse credential %s: %w", accountID, err)
	}
	if !codeartsRefreshable(&cred) {
		return fmt.Errorf("jethub: 无 refresh_token，请重新登录")
	}
	priv, err := KeyPairFromStoredJwk(*cred.DpopPrivateJwk)
	if err != nil {
		return err
	}
	token, err := ExchangeCodeArtsRefreshToken(ctx, cred.RefreshToken, cred.CodeVerifier, priv)
	if err != nil {
		if err == ErrRefreshTokenExpired {
			// Terminal: mark the account non-refreshable so the scheduler and
			// UI stop treating it as renewable.
			_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
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
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, merged, codeartsCredentialExpiresAt(refreshed), codeartsRefreshable(refreshed)); err != nil {
		return err
	}
	return nil
}

// RefreshAllCodeArts renews every refreshable codearts account (including
// disabled ones — disabled only affects selection, not credential health).
// Single-account failures are logged and do not abort the loop.
func (m *Manager) RefreshAllCodeArts(ctx context.Context) {
	accounts := m.Accounts("codearts")
	for _, acc := range accounts {
		if !acc.Refreshable {
			continue
		}
		if err := m.RefreshCodeArtsAccount(ctx, acc.ID); err != nil {
			if m.logger != nil {
				m.logger.Warn("[jethub] codearts 账号 %s 续期失败: %v", acc.ID, err)
			}
		}
	}
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

// SetBrowserOpener registers the OS "open URL in default browser" callback
// (the app wires it to fsutil.OpenInBrowser). Login flows call it with the
// authorization URL so the flow matches the original plugin: +new account →
// browser opens automatically. nil (tests) keeps the URL UI-only.
func (m *Manager) SetBrowserOpener(fn func(url string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.browserOpener = fn
}

// openURLWithBrowser invokes the registered browser opener asynchronously and
// never fails the login on an opener error (the URL stays in the dialog).
func (m *Manager) openURLWithBrowser(url string) {
	m.mu.RLock()
	fn := m.browserOpener
	m.mu.RUnlock()
	if fn == nil {
		return
	}
	go func() { fn(url) }()
}

// OpenURLWithBrowser is the exported alias for the API layer (qoder's flow
// builds its URL in a start function without an opener hook of its own).
func (m *Manager) OpenURLWithBrowser(url string) { m.openURLWithBrowser(url) }
