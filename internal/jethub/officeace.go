package jethub

// OfficeAce（华为 ModelArts MaaS「果办」云直连通道）—— 第 14 家 provider。
//
// 上游参考：ref/deepseek-harness-codearts @ origin/master 的
// `src/officeace-auth.ts` / `src/officeace-product.ts` / `src/officeace-adapter.ts`
// （协议要点见 ref docs/agent-notes/providers-officeace.md，全部实测结论）。
//
// 登录链（完全公开可自走，无需果办客户端）：
//
//	① POST {claw}/v1/claw/auth/state              → 云侧登记 state（匿名）
//	② 浏览器打开 auth.huaweicloud.com 授权页       → SSO → 云侧回调带 code
//	③ GET  {claw}/v1/claw/auth/code?state=        → 取回 code（匿名，秒级时效）
//	④ POST sts.cn-north-4.../v1/oauth2/tokens     → code+verifier+DPoP 换 STS
//	⑤ GET  {claw}/v1/claw/client-permission-validate（SDK-HMAC 签名）
//	   → subscription.model_info.model_auth_info.model_app_key/secret ⇒ 推理凭据
//
// 推理：`POST {maasBaseUrl}/v2/chat/completions`，
// `Authorization: Basic base64(model_app_key:secret)`，标准 OpenAI SSE（无新协议桥）。
// ⚠️ 华为**按账号下发专属网关**（modelgw-NNNN.officeace...），推理/探测必须优先用
// 凭据里的 `maasBaseUrl`（缺省回退默认域）—— 打错 host 是 401 APIG.1009（ref §5.7）。
// V11 签名的管理面（/v1/subscription、/v1/model-token-rates）**永远打默认域**，
// 不跟随 maasBaseUrl（ref §5.7 的范围守卫）。
//
// ⚠️ refresh_token **一次性**（30 天有效期，成功换新即作废旧的那份）—— 续期必须
// per-ref 串行 + 锁内重读 + 判终态前重读（officeace_refresh.go，ref §2 的三条铁律）。

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OfficeAce endpoints & login constants (1:1 from ref officeace-auth.ts).
const (
	// officeaceChatPath / officeaceModelsPath — ref officeace-product.ts.
	officeaceChatPath   = "/v2/chat/completions"
	officeaceModelsPath = "/v2/models"
	// officeaceClientID is the PKCE public client (no secret).
	officeaceClientID = "pdp5_for_agentarts"
	// officeaceAuthorizePage wraps the OAuth authorize URL in the Huawei SSO
	// login page (service=<encoded authorize url>).
	officeaceAuthorizePage = "https://auth.huaweicloud.com/authui/login.html"
	officeaceAuthorizeBase = "https://auth.huaweicloud.com/authui/v1/oauth2/authorize"
	// officeaceStatePath / officeaceCodePath / officeacePermissionPath are
	// anonymous (state/code) and AK/SK-signed (permission) claw endpoints.
	officeaceStatePath      = "/v1/claw/auth/state"
	officeaceCodePath       = "/v1/claw/auth/code"
	officeacePermissionPath = "/v1/claw/client-permission-validate"
	// officeaceLoginPollInterval / officeaceLoginBudget pace the two-step flow.
	officeaceLoginPollInterval = 2 * time.Second
	officeaceLoginBudget       = 5 * time.Minute
	// officeaceSTSFallbackTTL is the display fallback when the STS expiration
	// cannot be parsed (Huawei STS credentials live ~2 hours).
	officeaceSTSFallbackTTL = 2 * time.Hour
)

// officeaceDefaultBaseURL is the ModelArts MaaS gateway default host — the
// INFERENCE fallback AND the management face (V11 /v1/subscription 永远打这个
// 域，不跟随 per-account maasBaseUrl，ref §5.7)。Var so tests can point both
// faces at a mock server (setOfficeaceBase; codearts setSnapBase 同款).
var officeaceDefaultBaseURL = "https://officeace.cn-southwest-2.huaweicloud-agentarts.com"

func setOfficeaceBase(u string) { officeaceDefaultBaseURL = u }

// officeaceClawBase is the AgentArts claw gateway. Var so tests can point it at
// a mock server (setClawBase).
var officeaceClawBase = "https://agentarts.cn-southwest-2.myhuaweicloud.com"

func setClawBase(u string) { officeaceClawBase = u }

// officeaceSTSURL is the Huawei STS token endpoint (same service codearts
// uses; separate var so the two test hooks do not interfere).
var officeaceSTSURL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"

func setOfficeaceSTSURL(u string) { officeaceSTSURL = u }

// OfficeAceCredential mirrors ref OfficeAceCredential field-for-field
// (camelCase JSON — backup compatibility with the original plugin requires
// the exact names). The DPoP private JWK MUST be persisted: refresh requests
// have to sign with the SAME key (换一把 ⇒ 服务端拒绝, ref §1).
type OfficeAceCredential struct {
	// ModelAppKey/ModelAppSecret are the MaaS Basic credential pair
	// (permission-validate returns them; they may rotate on refresh).
	ModelAppKey    string `json:"modelAppKey"`
	ModelAppSecret string `json:"modelAppSecret"`
	// MaasBaseUrl is the per-account MaaS gateway host (model_api_url_base).
	// ⚠️ 推理/探测的主路径（ref §5.7：默认域对新账号直接 401）。
	MaasBaseUrl string `json:"maasBaseUrl"`
	// Access/Secret/SecurityToken/ProjectID are the Huawei IAM STS credentials
	// (the claw management APIs sign with them).
	Access        string `json:"access"`
	Secret        string `json:"secret"`
	SecurityToken string `json:"securityToken"`
	ProjectID     string `json:"projectId,omitempty"`
	// ExpiresAt is the STS expiration — an **ISO 8601 string** (no s/ms
	// ambiguity; do NOT port the buddy-style >1e12 normalization, ref §1).
	ExpiresAt string `json:"expiresAt"`
	// RefreshToken is the OAuth refresh token (30 days, ONE-TIME use).
	RefreshToken string `json:"refreshToken,omitempty"`
	// DpopPrivateJwk is the DPoP ES256 private key (refresh must reuse it).
	DpopPrivateJwk *DpopPrivateJwk `json:"dpopPrivateJwk,omitempty"`
	// DisplayName / AccountID are optional display fields (ref same names).
	DisplayName string `json:"displayName,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
}

// officeaceRefreshable reports whether the credential carries a complete
// renewal kit (one-time refresh_token + the SAME DPoP key).
func officeaceRefreshable(cred *OfficeAceCredential) bool {
	return cred != nil && cred.RefreshToken != "" && cred.DpopPrivateJwk != nil
}

// officeaceExpiryMs parses the ISO 8601 STS expiration into ms; ok=false when
// missing/unparsable (⇒ refresh now). ⚠️ 华为 STS 的 expiration 是 ISO 字符串，
// 不需要秒→毫秒归一化（ref officeaceExpiresAtMs 的同款注释）。
func officeaceExpiryMs(cred *OfficeAceCredential) (int64, bool) {
	return officeaceParseTimeMs(cred.ExpiresAt)
}

// officeaceParseTimeMs parses an ISO-ish timestamp into ms (RFC3339 first,
// then the space-separated and no-zone layouts codearts also tolerates).
func officeaceParseTimeMs(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UnixMilli(), true
	}
	for _, layout := range []string{"2006-01-02T15:04:05Z", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// officeaceCredentialExpiresAt returns the display expiry (ms); an
// unparsable value falls back to now + the STS lifetime (2h — not 24h:
// the honest default for this credential family).
func officeaceCredentialExpiresAt(cred *OfficeAceCredential) int64 {
	if ms, ok := officeaceExpiryMs(cred); ok {
		return ms
	}
	return time.Now().Add(officeaceSTSFallbackTTL).UnixMilli()
}

// officeaceShouldRefreshNow mirrors ref shouldRefreshNow: unknown expiry ⇒
// refresh now; otherwise only within the lead window (1 hour).
func officeaceShouldRefreshNow(cred *OfficeAceCredential, nowMs int64) bool {
	exp, ok := officeaceExpiryMs(cred)
	if !ok {
		return true
	}
	return exp-nowMs <= codeartsRefreshLead.Milliseconds()
}

// officeaceLoginFlow is one in-flight cloud-direct login (the state is
// registered cloud-side; the authorize URL opens the Huawei SSO page).
type officeaceLoginFlow struct {
	State        string
	AuthorizeURL string
	// CodeVerifier + DpopJwk are the in-memory中间态 (never serialized to the
	// client): the token exchange consumes both right after the poll returns.
	CodeVerifier string
	DpopJwk      DpopPrivateJwk
}

// StartOfficeaceLogin performs step ①: register the state cloud-side (the
// callback later matches on it — self-made states are never found), generate
// the PKCE pair + DPoP key and assemble the authorize URL.
func (m *Manager) StartOfficeaceLogin(ctx context.Context) (*officeaceLoginFlow, error) {
	// ① 云侧登记 state（⚠️ 必须用云侧发的）。
	state, err := m.officeaceRegisterState(ctx)
	if err != nil {
		return nil, err
	}
	pkce, err := GeneratePkcePair()
	if err != nil {
		return nil, err
	}
	jwk, err := GenerateDpopKeyPair()
	if err != nil {
		return nil, err
	}
	params := url.Values{
		"client_id":             {officeaceClientID},
		"code_challenge":        {pkce.CodeChallenge},
		"code_challenge_method": {"SHA-256"},
		"state":                 {state},
		"scope":                 {"openid"},
		"redirect_uri":          {officeaceClawBase + "/v1/claw/auth/callback"},
		"response_type":         {"code"},
	}
	authorize := officeaceAuthorizeBase + "?" + params.Encode()
	authorizeURL := officeaceAuthorizePage + "?service=" + url.QueryEscape(authorize)
	return &officeaceLoginFlow{
		State:        state,
		AuthorizeURL: authorizeURL,
		CodeVerifier: pkce.CodeVerifier,
		DpopJwk:      jwk,
	}, nil
}

// officeaceRegisterState POSTs the anonymous state registration.
func (m *Manager) officeaceRegisterState(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		officeaceClawBase+officeaceStatePath, strings.NewReader("{}"))
	if err != nil {
		return "", fmt.Errorf("officeace: 构造 state 请求失败：%w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpClient("officeace").Do(req)
	if err != nil {
		return "", fmt.Errorf("officeace: 无法连接华为云 state 服务：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("officeace: 华为云 state 注册失败（HTTP %d）：%.200s", resp.StatusCode, string(raw))
	}
	var parsed struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.State == "" {
		return "", fmt.Errorf("officeace: 华为云未返回 state：%s", strings.TrimSpace(string(raw)))
	}
	return parsed.State, nil
}

// officeacePollOutcome is one anonymous code poll (step ③).
type officeacePollOutcome struct {
	Code    string
	Pending bool
	Err     error
}

// PollOfficeaceLoginCode polls `GET /v1/claw/auth/code?state=` — an anonymous
// server-side poll (no browser cookies involved; the window can be closed
// afterwards, ref §5.5). 202/404 mean "not ready" and keep polling.
func (m *Manager) PollOfficeaceLoginCode(ctx context.Context, state string) officeacePollOutcome {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		officeaceClawBase+officeaceCodePath+"?state="+url.QueryEscape(state), nil)
	if err != nil {
		return officeacePollOutcome{Pending: true}
	}
	req.Header.Set("Accept", "application/json")
	resp, err := m.httpClient("officeace").Do(req)
	if err != nil {
		return officeacePollOutcome{Pending: true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return officeaceParseCodeResponse(resp.StatusCode, raw)
}

// officeaceParseCodeResponse is the pure parse step of one code poll (split
// out for tests): non-2xx or shape-mismatched bodies are "pending".
func officeaceParseCodeResponse(status int, raw []byte) officeacePollOutcome {
	if status < 200 || status >= 300 {
		return officeacePollOutcome{Pending: true} // 202/404 = 未就绪
	}
	var parsed struct {
		Code any `json:"code"`
		Data struct {
			Code any `json:"code"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return officeacePollOutcome{Pending: true}
	}
	for _, v := range []any{parsed.Code, parsed.Data.Code} {
		if s, ok := v.(string); ok && s != "" {
			return officeacePollOutcome{Code: s}
		}
	}
	return officeacePollOutcome{Pending: true}
}

// officeaceTokenResponse is the STS /v1/oauth2/tokens payload.
type officeaceTokenResponse struct {
	Credentials *struct {
		AccessKeyID     string `json:"access_key_id"`
		SecretAccessKey string `json:"secret_access_key"`
		SecurityToken   string `json:"security_token"`
		Expiration      string `json:"expiration"`
		ProjectID       string `json:"project_id"`
	} `json:"credentials"`
	RefreshToken string `json:"refresh_token"`
	Error        string `json:"error"`
	ErrorCode    string `json:"error_code"`
	ErrorMsg     string `json:"error_msg"`
}

// officeaceTokenRequest POSTs a form-encoded STS request with a DPoP ES256
// proof (htm=POST, htu=TOKEN_URL; no `ath` — correct per RFC 9449 when no
// access token exists yet, ref §1). Failures carry the real body (cline 教训).
func officeaceTokenRequest(ctx context.Context, form map[string]string, priv *ecdsa.PrivateKey) (*officeaceTokenResponse, error) {
	dpop, err := SignDpopJws(priv, "POST", officeaceSTSURL)
	if err != nil {
		return nil, err
	}
	values := url.Values{}
	for k, v := range form {
		values.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, officeaceSTSURL, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("DPoP", dpop)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := callbackClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("officeace: STS 请求网络错误：%w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var token officeaceTokenResponse
	if err := json.Unmarshal(data, &token); err != nil {
		return nil, fmt.Errorf("officeace: STS 响应不是 JSON（HTTP %d）：%.200s", resp.StatusCode, string(data))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || token.Credentials == nil {
		return nil, officeaceClassifyTokenError(&token, resp.StatusCode, string(data))
	}
	return &token, nil
}

// officeaceClassifyTokenError reuses the codearts terminal/transient split
// (invalid_grant / ExpiredRefreshToken are terminal — the shared STS service
// speaks the same error dialect). The message always carries the status and a
// body snippet.
func officeaceClassifyTokenError(token *officeaceTokenResponse, status int, body string) error {
	view := &CodeArtsTokenResponse{Error: token.Error, ErrorCode: token.ErrorCode, ErrorMsg: token.ErrorMsg}
	if err := ClassifyTokenError(view); errors.Is(err, ErrRefreshTokenExpired) {
		return ErrRefreshTokenExpired
	}
	return fmt.Errorf("officeace: STS 请求失败（HTTP %d）：%s %.200s", status, token.Error, body)
}

// exchangeOfficeaceAuthorizationCode performs step ④ (code → STS + refresh_token).
// ⚠️ code 是秒级时效 —— 轮询到后必须立刻调用。
func exchangeOfficeaceAuthorizationCode(ctx context.Context, code, codeVerifier string, priv *ecdsa.PrivateKey) (*officeaceTokenResponse, error) {
	return officeaceTokenRequest(ctx, map[string]string{
		"client_id":     officeaceClientID,
		"code":          code,
		"code_verifier": codeVerifier,
		"grant_type":    GrantAuthorizationCode,
		"redirect_uri":  officeaceClawBase + "/v1/claw/auth/callback",
	}, priv)
}

// exchangeOfficeaceRefreshToken performs the silent renewal (one-time token).
func exchangeOfficeaceRefreshToken(ctx context.Context, refreshToken string, priv *ecdsa.PrivateKey) (*officeaceTokenResponse, error) {
	return officeaceTokenRequest(ctx, map[string]string{
		"client_id":     officeaceClientID,
		"grant_type":    GrantRefreshToken,
		"refresh_token": refreshToken,
	}, priv)
}

// RunOfficeaceLogin drives steps ②–⑤ from the API layer's background
// goroutine: poll the anonymous code endpoint until the browser-side
// authorization lands (or the budget lapses), then exchange code → STS →
// permission-validate and return the ready-to-persist credential.
//
// ⚠️ ctx 必须是**后台 context**（调用方自行传入）：登录 handler 早已返回，
// 请求 context 会在响应写完即取消 —— 绑上去的登录流永远走不到换 token（
// sessions.go SettleAndCleanup 头注释的同一条纪律）。code 是秒级时效，
// 轮询到后立即换，不经过任何可取消的等待。
func (m *Manager) RunOfficeaceLogin(ctx context.Context, flow *officeaceLoginFlow, timeout time.Duration) (*OfficeAceCredential, error) {
	if timeout <= 0 {
		timeout = officeaceLoginBudget
	}
	deadline := time.Now().Add(timeout)
	priv, err := KeyPairFromStoredJwk(flow.DpopJwk)
	if err != nil {
		return nil, err
	}
	var code string
	for {
		outcome := m.PollOfficeaceLoginCode(ctx, flow.State)
		if outcome.Code != "" {
			code = outcome.Code
			break
		}
		if outcome.Err != nil {
			return nil, outcome.Err
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("officeace: 登录超时（未在有效期内完成授权），请重新发起")
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("officeace: 登录已取消")
		case <-time.After(officeaceLoginPollInterval):
		}
	}
	token, err := exchangeOfficeaceAuthorizationCode(ctx, code, flow.CodeVerifier, priv)
	if err != nil {
		return nil, err
	}
	creds := token.Credentials
	cred := &OfficeAceCredential{
		Access:         creds.AccessKeyID,
		Secret:         creds.SecretAccessKey,
		SecurityToken:  creds.SecurityToken,
		ExpiresAt:      creds.Expiration,
		ProjectID:      creds.ProjectID,
		RefreshToken:   token.RefreshToken,
		DpopPrivateJwk: &flow.DpopJwk,
	}
	if err := officeaceFetchModelInfo(ctx, m, cred); err != nil {
		return nil, err
	}
	return cred, nil
}

// officeacePermissionResponse is the permission-validate payload (step ⑤).
type officeacePermissionResponse struct {
	AccountID    string `json:"account_id"`
	PrincipalUrn string `json:"principal_urn"`
	Subscription struct {
		ModelInfo struct {
			ModelAuthInfo struct {
				ModelAppKey    any `json:"model_app_key"`
				ModelAppSecret any `json:"model_app_secret"`
			} `json:"model_auth_info"`
			ModelAPIURLBase any `json:"model_api_url_base"`
		} `json:"model_info"`
	} `json:"subscription"`
}

// officeaceFetchModelInfo exchanges the STS credentials for the MaaS Basic
// pair (signed GET on the claw management API). Mutates cred in place.
func officeaceFetchModelInfo(ctx context.Context, m *Manager, cred *OfficeAceCredential) error {
	signed, err := officeaceSignSDKHMAC(cred.Access, cred.Secret, http.MethodGet,
		officeaceClawBase+officeacePermissionPath, map[string]string{
			"content-type":     "application/json",
			"x-security-token": cred.SecurityToken,
			"x-project-id":     cred.ProjectID,
		}, "")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, officeaceClawBase+officeacePermissionPath, nil)
	if err != nil {
		return err
	}
	// ⚠️ 签名头集合即出站头集合：X-Sdk-Date 与签名一致，Host 由 transport 生成。
	for k, v := range signed {
		if strings.EqualFold(k, "host") {
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("officeace").Do(req)
	if err != nil {
		return fmt.Errorf("officeace: 权限校验请求失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("officeace: 华为云权限校验失败（HTTP %d）：%.200s", resp.StatusCode, string(data))
	}
	var parsed officeacePermissionResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("officeace: 权限校验响应不是 JSON：%.200s", string(data))
	}
	auth := parsed.Subscription.ModelInfo.ModelAuthInfo
	key, _ := auth.ModelAppKey.(string)
	secret, _ := auth.ModelAppSecret.(string)
	if key == "" || secret == "" {
		return errors.New("officeace: 华为云未返回 MaaS 凭据（账号可能未订阅 ModelArts MaaS）")
	}
	cred.ModelAppKey = key
	cred.ModelAppSecret = secret
	if base, ok := parsed.Subscription.ModelInfo.ModelAPIURLBase.(string); ok && base != "" {
		// ref fetchModelInfo: normalize to an https:// URL.
		base = strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
		cred.MaasBaseUrl = "https://" + base
	}
	if parsed.AccountID != "" {
		cred.AccountID = parsed.AccountID
	}
	return nil
}

// OfficeaceOutcomeMeta exposes the LoginOutcome display hints to the API
// layer (expiry + refreshability): the exchange chain runs in the core
// package, but the outcome is delivered by the api handler.
func OfficeaceOutcomeMeta(cred *OfficeAceCredential) (expiresAt int64, refreshable bool) {
	return officeaceCredentialExpiresAt(cred), officeaceRefreshable(cred)
}

// officeaceMaasBase normalizes the per-account inference base: trim, strip the
// trailing slash, default fallback (ref maasBaseUrlOf), plus an https://
// prefix when a hand-imported credential carries a bare host.
func officeaceMaasBase(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimRight(raw, "/")
	if raw == "" {
		return officeaceDefaultBaseURL
	}
	if !strings.HasPrefix(raw, "https://") && !strings.HasPrefix(raw, "http://") {
		raw = "https://" + raw
	}
	return raw
}

// CompleteOfficeaceLogin persists a finished login: stores the credential on
// the account's ref and back-fills the nickname ("OfficeAce " + accountId 前 8
// 位, ref pool.updateAccount 的同款标签).
func (m *Manager) CompleteOfficeaceLogin(accountID string, credentialJSON []byte, expiresAt int64, refreshable bool) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credentialJSON, expiresAt, refreshable); err != nil {
		return err
	}
	var cred OfficeAceCredential
	if err := jsonUnmarshal(credentialJSON, &cred); err == nil && cred.AccountID != "" {
		nickname := "OfficeAce " + cred.AccountID
		if len(cred.AccountID) > 8 {
			nickname = "OfficeAce " + cred.AccountID[:8]
		}
		_ = m.UpdateAccount(accountID, func(a *Account) { a.Nickname = nickname })
	}
	return nil
}

// officeaceCredential reads + parses one account's stored credential
// (nil, nil when absent).
func (m *Manager) officeaceCredential(acc *Account) (*OfficeAceCredential, error) {
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return nil, nil
	}
	var cred OfficeAceCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse officeace credential %s: %w", acc.ID, err)
	}
	return &cred, nil
}

// officeaceCredentialFor resolves + validates the credential behind a
// rotation key id (the augmenter/customizer path).
func (m *Manager) officeaceCredentialFor(keyID string) (*OfficeAceCredential, error) {
	acc, ok := m.FindAccount(keyID)
	if !ok || acc.Provider != "officeace" {
		return nil, fmt.Errorf("jethub: account %s not found for officeace", keyID)
	}
	cred, err := m.officeaceCredential(&acc)
	if err != nil {
		return nil, err
	}
	if cred == nil {
		return nil, fmt.Errorf("jethub: credential missing for officeace account %s", keyID)
	}
	if cred.ModelAppKey == "" || cred.ModelAppSecret == "" {
		return nil, fmt.Errorf("jethub: officeace 凭据不完整（缺 model_app_key/secret），请重新登录（账号 %s）", keyID)
	}
	return cred, nil
}

// officeaceBasicToken is the MaaS inference Authorization value
// (ref basicAuthorization: base64(appKey:secret)).
func officeaceBasicToken(cred *OfficeAceCredential) string {
	return base64.StdEncoding.EncodeToString([]byte(cred.ModelAppKey + ":" + cred.ModelAppSecret))
}

// init registers the officeace bridge-key extractor.
//
// ⚠️ 与 codearts 同款的真实缺陷防线（缺陷 15）：凭据里**没有** `access_token`
// 字段，通用提取器恒返回空串 ⇒ Bridge.SyncKeys 跳过该账号 ⇒ 可用 Key 数为 0 ⇒
// 桥接 provider 被整个静默摘除。MaaS 的 Basic 对（modelAppKey）在这里充当
// Key.Key —— 它**不参与出站鉴权**（augmenter 用 appKey:secret 重写
// Authorization），只用于轮询选号、用量归属与日志遮蔽。
func init() {
	RegisterTokenExtractor("officeace", func(cred jsonRaw) (string, error) {
		var c OfficeAceCredential
		if err := jsonUnmarshal(cred, &c); err != nil {
			return "", errors.New("jethub: parse officeace credential: " + err.Error())
		}
		if c.ModelAppKey != "" {
			return c.ModelAppKey, nil
		}
		if c.SecurityToken != "" {
			return c.SecurityToken, nil
		}
		if c.Access != "" {
			return c.Access, nil
		}
		// 手写/旧夹具凭据仍可能带通用 access_token —— 让账号被桥接，
		// 由 augmenter 报「凭据不完整」的明确错误（codearts 同款兜底）。
		var generic struct {
			AccessToken string `json:"access_token"`
		}
		_ = jsonUnmarshal(cred, &generic)
		return generic.AccessToken, nil
	})
}
