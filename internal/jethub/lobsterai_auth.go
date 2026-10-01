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

// LobsterAI login + silent renewal (ref lobsterai-oauth.ts). Local callback
// server on 127.0.0.1 random port; the callback handler completes the
// exchange in-process. Identity fields (uuid/firstKeyfrom) are generated
// client-side and must be persisted with the credential.

// LobsteraiLoginSession is the client-generated identity (uuid + first ts).
type LobsteraiLoginSession struct {
	UUID         string
	FirstKeyfrom string
}

func createLobsteraiLoginSession() *LobsteraiLoginSession {
	return &LobsteraiLoginSession{UUID: lobsteraiRandomID(), FirstKeyfrom: fmt.Sprintf("%d", nowMillis())}
}

// BuildLobsteraiLoginURL: `{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
// (hash fragment assembled explicitly — searchParams cannot express it).
func BuildLobsteraiLoginURL(port int, state string) string {
	redirect := fmt.Sprintf("http://127.0.0.1:%d%s", port, lobsteraiCallbackPath)
	q := urlValues{
		"source":       "electron",
		"redirect_uri": redirect,
		"state":        state,
	}
	return "https://lobsterai.youdao.com/portal#/login?" + q.encode()
}

// exchangeLobsteraiAuthCode trades the code for a credential. Body must carry
// the 5 fields (authCode/firstKeyfrom/latestKeyfrom/uuid/version).
func (m *Manager) exchangeLobsteraiAuthCode(ctx context.Context, code string, session *LobsteraiLoginSession, clientVersion string) (*LobsteraiCredential, error) {
	body := map[string]any{
		"authCode":      code,
		"firstKeyfrom":  session.FirstKeyfrom,
		"latestKeyfrom": fmt.Sprintf("%d", nowMillis()),
		"uuid":          session.UUID,
		"version":       clientVersion,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		lobsteraiProduct.Endpoint+lobsteraiExchangePath, strReader(string(data)))
	if err != nil {
		return nil, err
	}
	for k, v := range lobsteraiAnonymousHeaders() {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, lobsteraiRequestTimeout)
	defer cancel()
	resp, err := m.httpClient().Do(req)
	_ = tctx
	_ = cancel
	if err != nil {
		return nil, fmt.Errorf("LobsterAI exchange 网络失败：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("LobsterAI exchange 响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	envData, _, envMsg, ok := lobsteraiEnvelope(parsed)
	if !ok {
		return nil, fmt.Errorf("LobsterAI exchange 失败：%s", envMsg)
	}
	payload := parseLobsteraiTokenPayload(envData)
	if payload.AccessToken == "" {
		return nil, fmt.Errorf("LobsterAI exchange 响应缺少 accessToken")
	}
	return buildLobsteraiCredential(payload, session.UUID, session.FirstKeyfrom, fmt.Sprintf("%d", nowMillis())), nil
}

// lobsteraiRefresh exchanges the refresh token (anonymous POST; the server
// only reads the body's refreshToken).
func (m *Manager) lobsteraiRefreshOnce(ctx context.Context, cred *LobsteraiCredential, clientVersion string) (*LobsteraiCredential, error) {
	body := map[string]any{
		"firstKeyfrom":  cred.FirstKeyfrom,
		"latestKeyfrom": cred.LatestKeyfrom, // 登录时刻原样回发（Go 参考实现约定）
		"version":       clientVersion,
		"refreshToken":  cred.RefreshToken,
	}
	if cred.UUID != "" {
		body["uuid"] = cred.UUID
	}
	if cred.UserID != "" {
		body["userId"] = cred.UserID
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		lobsteraiProduct.Endpoint+lobsteraiRefreshPath, strReader(string(data)))
	if err != nil {
		return nil, err
	}
	for k, v := range lobsteraiAnonymousHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("LobsterAI refresh 网络失败：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, ErrRefreshTokenExpired
		}
		return nil, fmt.Errorf("LobsterAI refresh 响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	envData, _, envMsg, ok := lobsteraiEnvelope(parsed)
	if !ok {
		// 终态判定：refresh_token 失效（401/403 或 message 含 expired/invalid）。
		lower := strings.ToLower(envMsg)
		if strings.Contains(lower, "expired") || strings.Contains(lower, "invalid") {
			return nil, ErrRefreshTokenExpired
		}
		return nil, fmt.Errorf("LobsterAI refresh 失败：%s", envMsg)
	}
	payload := parseLobsteraiTokenPayload(envData)
	if payload.AccessToken == "" {
		return nil, fmt.Errorf("LobsterAI refresh 响应缺少 accessToken")
	}
	return applyLobsteraiRefresh(cred, payload, nowMillis()), nil
}

// StartLobsteraiLogin starts the two-step login: local callback server →
// portal URL → poll → exchange in-process.
func (m *Manager) StartLobsteraiLogin(ctx context.Context, accountID string, openURL func(string)) (*StartedLogin, error) {
	session := createLobsteraiLoginSession()
	state := lobsteraiRandomID()
	clientVersion := lobsteraiProduct.ClientVersion

	ln, port, err := listenCallbackPort()
	if err != nil {
		return nil, err
	}
	result := make(chan LoginOutcome, 1)
	mux := http.NewServeMux()
	mux.HandleFunc(lobsteraiCallbackPath, func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		gotState := r.URL.Query().Get("state")
		if code == "" || gotState != state {
			// state mismatch: not initiated by (or forged against) this login.
			http.Error(w, "登录回调参数无效", http.StatusBadRequest)
			return
		}
		cred, err := m.exchangeLobsteraiAuthCode(r.Context(), code, session, clientVersion)
		if err != nil {
			http.Error(w, "登录换取凭据失败", http.StatusInternalServerError)
			deliver(result, LoginOutcome{Err: err})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>"))
		if err := m.CompleteLobsteraiLogin(accountID, cred); err != nil {
			deliver(result, LoginOutcome{Err: err})
			return
		}
		credJSON, _ := json.Marshal(cred)
		deliver(result, LoginOutcome{
			CredentialJSON: credJSON,
			ExpiresAt:      lobsteraiCredentialExpiresAtMs(cred),
			Refreshable:    cred.RefreshToken != "",
		})
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(ln) }()
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	go func() {
		select {
		case <-time.After(lobsteraiLoginTimeout):
			deliver(result, LoginOutcome{Err: fmt.Errorf("LobsterAI 登录超时（600 秒内未完成）")})
		case <-ctx.Done():
		}
	}()

	loginURL := BuildLobsteraiLoginURL(port, state)
	// Auto-open like the original plugin (explicit openURL wins if given).
	m.openURLWithBrowser(loginURL)
	if openURL != nil {
		go openURL(loginURL)
	}
	return &StartedLogin{LoginURL: loginURL, Result: result}, nil
}

// CompleteLobsteraiLogin persists the credential (SetCredential triggers the
// key-sync hook) and applies the masked nickname.
func (m *Manager) CompleteLobsteraiLogin(accountID string, cred *LobsteraiCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, lobsteraiCredentialExpiresAtMs(cred), cred.RefreshToken != ""); err != nil {
		return err
	}
	// 账号昵称 = 手机号掩码归一化（服务端把手机号当昵称下发）。
	_ = m.UpdateAccount(accountID, func(a *Account) {
		a.Nickname = LobsteraiDisplayNickname(cred.Nickname, acc.ID)
	})
	return nil
}

// RefreshLobsteraiAccount renews one lobsterai credential with the stored
// identity body. Terminal failure marks the account non-refreshable.
func (m *Manager) RefreshLobsteraiAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred LobsteraiCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse lobsterai credential %s: %w", accountID, err)
	}
	if cred.RefreshToken == "" {
		return ErrRefreshTokenExpired
	}
	refreshed, err := m.lobsteraiRefreshOnce(ctx, &cred, lobsteraiProduct.ClientVersion)
	if err != nil {
		if err == ErrRefreshTokenExpired {
			_ = m.UpdateAccount(accountID, func(a *Account) { a.Refreshable = false })
		}
		return err
	}
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, lobsteraiCredentialExpiresAtMs(refreshed), refreshed.RefreshToken != "")
}
