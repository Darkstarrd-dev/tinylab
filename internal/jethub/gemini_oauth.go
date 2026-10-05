package jethub

// Gemini (Cloud Code Assist) 的 Google OAuth 授权流程（R3-3，ref gemini-oauth.ts）。
//
// ⚠️ 三条上游硬约束（ref 实测踩过）：
//  1. token 端点强制校验客户端身份：只发 client_id 会回
//     `invalid_request: client_secret is missing`（症状：浏览器显示授权成功，
//     面板里账号一直不出现）。exchange/refresh 必须带 client_secret。
//  2. 必须「先监听、再拼 URL」：端口被占时回退别的端口，先拼 URL 会
//     redirect_uri_mismatch。Google 对原生应用的 loopback 重定向（RFC 8252）
//     允许任意端口。
//  3. 回调里 state 不匹配一律 400 拒绝（防伪造回调）。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	geminiAuthEndpoint    = "https://accounts.google.com/o/oauth2/v2/auth"
	geminiTokenEndpoint   = "https://oauth2.googleapis.com/token"
	geminiUserinfoURL     = "https://www.googleapis.com/oauth2/v2/userinfo"
	geminiRevokeURL       = "https://oauth2.googleapis.com/revoke"
	geminiDefaultClientID = os.Getenv("CMDC_PAK_GOOGLE_CLIENT_ID")
	// ⚠️ 上游 Cloud Code 客户端的公开 client（原生应用公开安装的 secret，
	// ref 逐字同值——它不是本项目的凭据，是上游客户端的固有常量）。
	geminiDefaultClientSecret = os.Getenv("CMDC_PAK_GOOGLE_CLIENT_SECRET")
	geminiCallbackPath        = "/oauth-callback" // 与 client 注册值逐字一致，改了就 redirect_uri_mismatch
	geminiRedirectHost        = "localhost"       // ⚠️ 必须 localhost 而不是 127.0.0.1
	geminiAuthFlowTimeout     = 10 * time.Minute  // 授权总预算（没人来点）
)

// geminiScopes 授权 scope（ref GEMINI_SCOPES 逐字）。
var geminiScopes = []string{
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
}

func init() {
	// 桥接 Key = access_token（bridge.go 的 tokenExtractors；SyncKeys 从
	// 凭据 JSON 提取 Bearer 值）。
	RegisterTokenExtractor("gemini", func(cred jsonRaw) (string, error) {
		var c GeminiCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", fmt.Errorf("jethub: parse gemini credential: %w", err)
		}
		return c.AccessToken, nil
	})
}

// geminiClientID / geminiClientSecret：上游公开 client（env 可覆盖，ref 同款
// 逃生舱 CMDC_PAK_GOOGLE_CLIENT_*）。
func geminiClientID() string {
	if v := strings.TrimSpace(os.Getenv("CMDC_PAK_GOOGLE_CLIENT_ID")); v != "" {
		return v
	}
	return geminiDefaultClientID
}

func geminiClientSecret() string {
	if v := strings.TrimSpace(os.Getenv("CMDC_PAK_GOOGLE_CLIENT_SECRET")); v != "" {
		return v
	}
	return geminiDefaultClientSecret
}

// GeminiLoginFlow is a started OAuth flow surfaced to the API layer.
type GeminiLoginFlow struct {
	LoginURL string
	flow     *geminiOAuthFlow
}

// URL returns the browser URL（兼容 StartedLogin 形状的调用方）。
func (f *GeminiLoginFlow) URL() string { return f.LoginURL }

// Wait blocks until the user completes authorization, then exchanges the
// code for a credential.
func (f *GeminiLoginFlow) Wait(ctx context.Context, m *Manager) (*GeminiCredential, error) {
	res, err := f.flow.wait(ctx)
	if err != nil {
		return nil, err
	}
	defer f.flow.close()
	grant, err := m.exchangeGeminiCode(ctx, res.code, f.flow.redirectURI)
	if err != nil {
		return nil, err
	}
	return geminiApplyGrant(nil, grant, time.Now()), nil
}

// Close cancels the local callback server（用户点取消时调用）。
func (f *GeminiLoginFlow) Close() { f.flow.close() }

// StartGeminiLogin starts an OAuth flow: listen first (硬约束 2), build the
// URL, open the browser with the browser/session selection from the +新建账号
// dialog (zero value = remembered preference). The caller waits via flow.Wait.
func (m *Manager) StartGeminiLogin(opt OpenOptions) (*GeminiLoginFlow, error) {
	flow, err := m.startGeminiOAuthFlow()
	if err != nil {
		return nil, err
	}
	loginURL := flow.buildGeminiAuthURL()
	m.OpenURLWithBrowser(loginURL, opt)
	return &GeminiLoginFlow{LoginURL: loginURL, flow: flow}, nil
}

// geminiTokenGrant 是令牌端点响应的解析结果。
type geminiTokenGrant struct {
	AccessToken  string
	RefreshToken string
	TokenType    string
	ExpiresIn    int64
	Scope        string
	// IDToken 是 OIDC 身份令牌（授权带 openid scope 时必然返回；
	// 身份从这里解，不再依赖可静默失败的 userinfo 跨域请求）。
	IDToken string
}

// parseGeminiTokenGrant 解析令牌端点 JSON。三种失败形态都给可定位的文案
// （ref parseGeminiTokenGrant 同口径）；`previousRefreshToken` 兜底
// 「refresh 响应不轮换 refresh_token」的形态。
func parseGeminiTokenGrant(payload []byte, previousRefreshToken string) (*geminiTokenGrant, error) {
	var record struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		TokenType        string `json:"token_type"`
		ExpiresIn        int64  `json:"expires_in"`
		Scope            string `json:"scope"`
		IDToken          string `json:"id_token"`
	}
	if err := json.Unmarshal(payload, &record); err != nil {
		return nil, fmt.Errorf("gemini: 令牌端点返回无法解析（非 JSON 对象）")
	}
	if record.Error != "" {
		if record.ErrorDescription != "" {
			return nil, fmt.Errorf("gemini: %s: %s", record.Error, record.ErrorDescription)
		}
		return nil, fmt.Errorf("gemini: %s", record.Error)
	}
	if record.AccessToken == "" {
		return nil, fmt.Errorf("gemini: 令牌端点未返回 access_token")
	}
	refresh := record.RefreshToken
	if refresh == "" {
		refresh = previousRefreshToken
	}
	expiresIn := record.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	tokenType := record.TokenType
	if tokenType == "" {
		tokenType = "Bearer"
	}
	return &geminiTokenGrant{
		AccessToken:  record.AccessToken,
		RefreshToken: refresh,
		TokenType:    tokenType,
		ExpiresIn:    expiresIn,
		Scope:        record.Scope,
		IDToken:      record.IDToken,
	}, nil
}

// geminiIdentityFromIDToken 从 id_token 解出 (sub, email)。⚠️ 不验签：该值只用于
// 展示名与稳定标识（令牌响应已由 TLS 保护）；任何解析失败返回零值不抛错。
func geminiIdentityFromIDToken(idToken string) (sub, email string) {
	if idToken == "" {
		return "", ""
	}
	parts := strings.Split(idToken, ".")
	if len(parts) < 2 {
		return "", ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ""
	}
	var payload struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return "", ""
	}
	return payload.Sub, payload.Email
}

// geminiApplyGrant 把令牌授予结果并成一条凭据（保留既有身份/project；
// refresh_token 轮换时回写新值——Google 偶尔轮换，不回写下一次续期用已作废旧值）。
func geminiApplyGrant(prev *GeminiCredential, grant *geminiTokenGrant, now time.Time) *GeminiCredential {
	cred := &GeminiCredential{
		AccessToken: grant.AccessToken,
		TokenType:   grant.TokenType,
		ExpiresIn:   grant.ExpiresIn,
		Expiry:      now.Add(time.Duration(grant.ExpiresIn) * time.Second).UTC().Format(time.RFC3339),
		Scope:       grant.Scope,
	}
	if grant.RefreshToken != "" {
		cred.RefreshToken = grant.RefreshToken
	} else if prev != nil {
		cred.RefreshToken = prev.RefreshToken
	}
	// 身份优先取 id_token（同一次响应自带，零额外请求），退到既有凭据。
	sub, email := geminiIdentityFromIDToken(grant.IDToken)
	if sub == "" && prev != nil {
		sub = prev.Sub
	}
	if email == "" && prev != nil {
		email = prev.Email
	}
	cred.Sub, cred.Email = sub, email
	if prev != nil {
		cred.Project = prev.Project
		cred.APIKey = prev.APIKey
	}
	return cred
}

// postGeminiForm POST 表单到令牌端点。⚠️ 刻意不设伪装 UA：antigravity 伪装只用
// 在 Cloud Code 的推理/配额端点；令牌端点是标准 Google OAuth（ref 同口径）。
func (m *Manager) postGeminiForm(ctx context.Context, endpoint string, form url.Values) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := m.httpClient("gemini").Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return raw, resp.StatusCode, nil
}

// geminiOAuthFlow holds a started flow: the local callback server + state.
type geminiOAuthFlow struct {
	state       string
	redirectURI string
	server      *http.Server
	resultCh    chan *geminiCallbackResult
	timer       *time.Timer
}

type geminiCallbackResult struct {
	code string
	err  error
}

// startGeminiOAuthFlow listens on a loopback port FIRST (硬约束 2), then
// returns the auth URL. The caller opens the browser.
func (m *Manager) startGeminiOAuthFlow() (*geminiOAuthFlow, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("gemini: 回调端口监听失败: %w", err)
	}
	state := randomHex(16)
	flow := &geminiOAuthFlow{
		state:       state,
		redirectURI: fmt.Sprintf("http://%s%s", listener.Addr(), geminiCallbackPath),
		resultCh:    make(chan *geminiCallbackResult, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc(geminiCallbackPath, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if errText := q.Get("error"); errText != "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("授权被拒绝：" + errText))
			flow.deliver(&geminiCallbackResult{err: fmt.Errorf("gemini: Google 授权已取消（%s）", errText)})
			return
		}
		if q.Get("state") != flow.state { // 硬约束 3：state 不匹配一律 400
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("state mismatch"))
			flow.deliver(&geminiCallbackResult{err: fmt.Errorf("gemini: 回调 state 不匹配（疑似伪造回调）")})
			return
		}
		code := q.Get("code")
		if code == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("missing code"))
			flow.deliver(&geminiCallbackResult{err: fmt.Errorf("gemini: 回调缺少 code")})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><meta charset='utf-8'><title>Gemini 授权完成</title><p>Gemini 授权完成，可以关闭此页面。</p>"))
		flow.deliver(&geminiCallbackResult{code: code})
	})
	flow.server = &http.Server{Handler: mux, ReadHeaderTimeout: 30 * time.Second}
	go func() {
		_ = flow.server.Serve(listener)
	}()
	// 授权总预算：超时后收掉本地服务器，结果通道送达超时错误。
	flow.timer = time.AfterFunc(geminiAuthFlowTimeout, func() {
		flow.deliver(&geminiCallbackResult{err: fmt.Errorf("gemini: Google 授权超时，请重新发起")})
	})
	return flow, nil
}

// buildGeminiAuthURL 构造授权 URL（参数顺序无关，Google 不校验）。
func (f *geminiOAuthFlow) buildGeminiAuthURL() string {
	q := url.Values{
		"client_id":              {geminiClientID()},
		"response_type":          {"code"},
		"redirect_uri":           {f.redirectURI},
		"scope":                  {strings.Join(geminiScopes, " ")},
		"state":                  {f.state},
		"access_type":            {"offline"},
		"include_granted_scopes": {"true"},
		"prompt":                 {"consent"},
	}
	return geminiAuthEndpoint + "?" + q.Encode()
}

func (f *geminiOAuthFlow) deliver(res *geminiCallbackResult) {
	select {
	case f.resultCh <- res:
	default:
	}
}

// wait 阻塞等回调结果（含超时预算）。
func (f *geminiOAuthFlow) wait(ctx context.Context) (*geminiCallbackResult, error) {
	select {
	case res := <-f.resultCh:
		if res.err != nil {
			return nil, res.err
		}
		return res, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// close 关闭本地回调服务器（幂等）。
func (f *geminiOAuthFlow) close() {
	if f.timer != nil {
		f.timer.Stop()
	}
	if f.server != nil {
		_ = f.server.Close()
	}
}

// exchangeGeminiCode 用授权码换令牌（**必须**带 client_secret，硬约束 1）。
func (m *Manager) exchangeGeminiCode(ctx context.Context, code, redirectURI string) (*geminiTokenGrant, error) {
	ctx, cancel := context.WithTimeout(ctx, geminiOAuthTimeout)
	defer cancel()
	raw, status, err := m.postGeminiForm(ctx, geminiTokenEndpoint, url.Values{
		"client_id":     {geminiClientID()},
		"client_secret": {geminiClientSecret()},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
	})
	if err != nil {
		return nil, err
	}
	grant, perr := parseGeminiTokenGrant(raw, "")
	if perr != nil && status != http.StatusOK {
		return nil, fmt.Errorf("gemini: 令牌端点 HTTP %d: %v", status, perr)
	}
	return grant, perr
}

// RefreshGeminiCredential 用 refresh_token 续期（Google 偶尔轮换 refresh_token：
// 响应给了新值必须回写，geminiApplyGrant 已处理）。
func (m *Manager) RefreshGeminiCredential(ctx context.Context, refreshToken string) (*geminiTokenGrant, error) {
	if refreshToken == "" {
		return nil, fmt.Errorf("gemini: 没有 refresh_token，需要重新授权")
	}
	ctx, cancel := context.WithTimeout(ctx, geminiOAuthTimeout)
	defer cancel()
	raw, status, err := m.postGeminiForm(ctx, geminiTokenEndpoint, url.Values{
		"client_id":     {geminiClientID()},
		"client_secret": {geminiClientSecret()},
		"refresh_token": {refreshToken},
		"grant_type":    {"refresh_token"},
	})
	if err != nil {
		return nil, err
	}
	grant, perr := parseGeminiTokenGrant(raw, refreshToken)
	if perr != nil && status != http.StatusOK {
		return nil, fmt.Errorf("gemini: 续期 HTTP %d: %v", status, perr)
	}
	return grant, perr
}
