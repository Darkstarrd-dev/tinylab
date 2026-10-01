package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Buddy login + silent renewal (ref buddy-oauth.ts runBuddyLoginFlow /
// refreshToken). One loop per product; the product config drives every
// identity header (UA / X-Domain / platform).

// buddyTokenOnce polls auth/token then login/account and assembles the
// credential (full login flow minus the browser opening).
func (m *Manager) buddyTokenOnce(ctx context.Context, p *BuddyProduct, state string, token *BuddyTokenData) (*BuddyCredential, error) {
	client := m.httpClient(p.ID)
	deadline := time.Now().Add(buddyLoginTimeout)
	tokenURL := p.Endpoint + buddyAuthTokenPath + "?state=" + urlQueryEscape(state)
	tokenHeaders := map[string]string{
		buddyHeaderNoAuthorization: "true",
		"User-Agent":               p.UserAgent,
	}
	for token == nil {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("jethub: buddy 获取 token 超时（5 分钟）")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(buddyPollInterval):
		}
		status, body, err := buddyGetJSON(ctx, client, tokenURL, tokenHeaders)
		if err != nil {
			continue // network errors keep polling (aligned with Rust loop_get_token)
		}
		if status == http.StatusOK {
			if data := bodyData(body); data != nil {
				token = ParseBuddyTokenData(data)
				break
			}
			continue // data null → keep polling
		}
		if bodyCode(body) == codeTokenNotReadyCode {
			continue
		}
		return nil, fmt.Errorf("jethub: buddy auth/token HTTP %d code=%d: %s", status, bodyCode(body), bodyMessage(body))
	}

	accURL := p.Endpoint + buddyLoginAccPath + "?state=" + urlQueryEscape(state)
	accHeaders := map[string]string{
		buddyHeaderDomain:         firstNonEmpty(token.Domain, p.APIDomain),
		"Authorization":           "Bearer " + token.AccessToken,
		buddyHeaderNoUserID:       "true",
		buddyHeaderNoEnterpriseID: "true",
		"User-Agent":              p.UserAgent,
	}
	var account *BuddyAccountData
	for account == nil {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("jethub: buddy 获取账户信息超时（5 分钟）")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(buddyPollInterval):
		}
		status, body, err := buddyGetJSON(ctx, client, accURL, accHeaders)
		if err != nil {
			continue
		}
		if status == http.StatusOK {
			if data := bodyData(body); data != nil {
				account = ParseBuddyAccountData(data)
				break
			}
			continue
		}
		if bodyCode(body) == codeAcctNotReadyCode {
			continue
		}
		return nil, fmt.Errorf("jethub: buddy login/account HTTP %d code=%d: %s", status, bodyCode(body), bodyMessage(body))
	}
	return BuildBuddyCredential(token, account), nil
}

// StartBuddyLogin starts a two-step login for a buddy-family product:
// fetch state → (openURL) → background poll → persist via CompleteBuddyLogin.
func (m *Manager) StartBuddyLogin(ctx context.Context, provider string, accountID string, openURL func(string)) (*StartedLogin, error) {
	p, ok := BuddyProducts()[provider]
	if !ok {
		return nil, fmt.Errorf("jethub: unknown buddy product %q", provider)
	}
	state, err := BuddyFetchAuthState(ctx, m.httpClient(p.ID), p)
	if err != nil {
		return nil, err
	}
	loginURL := DecorateBuddyLoginURL(state.AuthURL, p)
	// Auto-open like the original plugin (explicit openURL wins if given).
	m.openURLWithBrowser(loginURL)
	if openURL != nil {
		go openURL(loginURL)
	}
	result := make(chan LoginOutcome, 1)
	go func() {
		cred, err := m.buddyTokenOnce(ctx, p, state.State, nil)
		if err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		if err := m.CompleteBuddyLogin(accountID, cred); err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		data, err := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: data, ExpiresAt: buddyTokenExpiryMs(cred),
			Refreshable: cred.RefreshToken != "", Err: err,
		})
	}()
	return &StartedLogin{LoginURL: loginURL, Result: result}, nil
}

// CompleteBuddyLogin persists a buddy credential and refreshes display
// fields (SetCredential triggers the key-sync hook).
func (m *Manager) CompleteBuddyLogin(accountID string, cred *BuddyCredential) error {
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	return m.CompleteBuddyLoginFromJSON(accountID, credJSON, buddyTokenExpiryMs(cred), cred.RefreshToken != "")
}

// CompleteBuddyLoginFromJSON stores a pre-encoded credential (login outcome
// pump path) and refreshes display fields.
func (m *Manager) CompleteBuddyLoginFromJSON(accountID string, credentialJSON []byte, expiresAt int64, refreshable bool) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credentialJSON, expiresAt, refreshable); err != nil {
		return err
	}
	// Nickname from the credential (JWT claims) when available.
	var cred BuddyCredential
	if err := jsonUnmarshal(credentialJSON, &cred); err == nil && cred.Nickname != "" {
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = cred.Nickname })
	}
	return nil
}

// RefreshBuddyAccount renews one buddy-family credential via
// auth/token/refresh with the product identity headers.
func (m *Manager) RefreshBuddyAccount(ctx context.Context, provider, accountID string) error {
	p, ok := BuddyProducts()[provider]
	if !ok {
		return fmt.Errorf("jethub: unknown buddy product %q", provider)
	}
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred BuddyCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse buddy credential %s: %w", accountID, err)
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	url := p.Endpoint + buddyAuthRefreshPath
	headers := map[string]string{
		buddyHeaderDomain:        p.APIDomain,
		"User-Agent":             p.UserAgent,
		"Authorization":          "Bearer " + cred.AccessToken,
		buddyHeaderRefreshToken:  cred.RefreshToken,
		buddyHeaderRefreshSource: buddyAuthRefreshSrc,
	}
	if cred.EnterpriseID != "" {
		headers[buddyHeaderEnterpriseID] = cred.EnterpriseID
		headers[buddyHeaderTenantID] = cred.EnterpriseID
	}
	status, body, err := buddyPostJSON(ctx, m.httpClient(p.ID), url, headers, "")
	if err != nil {
		return fmt.Errorf("jethub: buddy refresh network error: %w", err)
	}
	if status != http.StatusOK {
		code := bodyCode(body)
		message := bodyMessage(body)
		lower := strings.ToLower(message)
		expired := status == 401 || status == 403 || code == 401 || code == 403 ||
			strings.Contains(lower, "expired") || strings.Contains(lower, "invalid")
		if expired {
			_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
			return ErrRefreshTokenExpired
		}
		return fmt.Errorf("jethub: buddy 刷新 token HTTP %d code=%d: %s", status, code, message)
	}
	data := bodyData(body)
	if data == nil {
		return fmt.Errorf("jethub: buddy refresh response missing data")
	}
	token := ParseBuddyTokenData(data)
	refreshed := cred // merge: keep user/account fields, swap tokens
	refreshed.AccessToken = token.AccessToken
	refreshed.RefreshToken = token.RefreshToken
	refreshed.ExpiresAt = token.ExpiresAt
	refreshed.RefreshExpireAt = token.RefreshExpireAt
	refreshed.TokenType = token.TokenType
	refreshed.Scope = token.Scope
	refreshed.Domain = token.Domain
	credJSON, err := json.Marshal(&refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, buddyTokenExpiryMs(&refreshed), refreshed.RefreshToken != "")
}

// urlQueryEscape keeps encoding semantics close to the plugin (values are
// opaque server-generated states).
func urlQueryEscape(s string) string { return url.QueryEscape(s) }
