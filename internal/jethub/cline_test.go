package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- workos: 前缀（本 provider 最容易踩的坑：剥掉即 401，文案误导为版本旧） ---

func TestClineBearerValueIdempotent(t *testing.T) {
	if got := ClineBearerValue("workos:eyJ"); got != "workos:eyJ" {
		t.Fatalf("prefixed value passes through: %q", got)
	}
	if got := ClineBearerValue("eyJ"); got != "workos:eyJ" {
		t.Fatalf("unprefixed value patched: %q", got)
	}
	if got := ClineBearerValue("  workos:eyJ  "); got != "workos:eyJ" {
		t.Fatalf("trim first: %q", got)
	}
	if got := ClineBearerValue(""); got != "" {
		t.Fatalf("empty stays empty: %q", got)
	}
}

// --- 时间戳解析（ISO / 秒 / 毫秒） ---

func TestParseClineTimestamp(t *testing.T) {
	if got := ParseClineTimestamp("2026-09-25T05:23:47.000Z"); got != parseISOTime("2026-09-25T05:23:47.000Z") {
		t.Fatalf("ISO wrong: %d", got)
	}
	if got := ParseClineTimestamp(1786847930.0); got != 1786847930000 {
		t.Fatalf("seconds → ms: %d", got)
	}
	if got := ParseClineTimestamp(1786847930141.0); got != 1786847930141 {
		t.Fatalf("ms passthrough: %d", got)
	}
	if ParseClineTimestamp(0.0) != 0 {
		t.Fatal("nonpositive → 0")
	}
}

// --- 信封解析：判据是 success && data.accessToken（不是裸 accessToken） ---

func TestParseClineTokenPayloadEnvelope(t *testing.T) {
	payload := parseClineTokenPayload(map[string]any{
		"success": true,
		"data": map[string]any{
			"accessToken": "workos:eyJ9", "refreshToken": "tmgEeM",
			"expiresAt": "2026-09-25T05:23:47.000Z",
			"userInfo": map[string]any{
				"clineUserId": "usr-01M3BCV4", "email": "a@b.c",
				"firstName": "Ada", "lastName": "L",
			},
		},
	})
	if payload.AccessToken != "workos:eyJ9" || payload.RefreshToken != "tmgEeM" {
		t.Fatalf("tokens wrong: %+v", payload)
	}
	if payload.ExpiresAt != parseISOTime("2026-09-25T05:23:47.000Z") {
		t.Fatalf("expiresAt wrong: %d", payload.ExpiresAt)
	}
	if payload.AccountID != "usr-01M3BCV4" || payload.Email != "a@b.c" || payload.DisplayName != "Ada L" {
		t.Fatalf("userInfo wrong: %+v", payload)
	}
}

func TestParseClineTokenPayloadFailureEnvelope(t *testing.T) {
	if p := parseClineTokenPayload(map[string]any{"success": false, "error": "x"}); p.AccessToken != "" {
		t.Fatalf("failure envelope misread: %+v", p)
	}
	bare := parseClineTokenPayload(map[string]any{"accessToken": "workos:x", "refreshToken": "y"})
	if bare.AccessToken != "workos:x" || bare.RefreshToken != "y" {
		t.Fatalf("bare response compat broken: %+v", bare)
	}
}

// --- 昵称回退（email → displayName → accountId）+ 前缀落凭据 ---

func TestBuildClineCredentialNickname(t *testing.T) {
	if cred := BuildClineCredential(&clineTokenPayload{AccessToken: "eyJ", Email: "a@b.c", AccountID: "usr-1"}); cred.Nickname != "a@b.c" {
		t.Fatalf("email nickname wins: %q", cred.Nickname)
	}
	if cred := BuildClineCredential(&clineTokenPayload{AccessToken: "eyJ", DisplayName: "Ada", AccountID: "usr-1"}); cred.Nickname != "Ada" {
		t.Fatalf("displayName second: %q", cred.Nickname)
	}
	cred := BuildClineCredential(&clineTokenPayload{AccessToken: "eyJ", AccountID: "usr-1"})
	if cred.Nickname != "usr-1" {
		t.Fatalf("accountId last: %q", cred.Nickname)
	}
	if !strings.HasPrefix(cred.AccessToken, "workos:") {
		t.Fatalf("stored token must carry prefix: %q", cred.AccessToken)
	}
}

// --- applyClineRefresh：身份字段保留（余额查询依赖 account_id） ---

func TestApplyClineRefreshKeepsIdentity(t *testing.T) {
	prev := &ClineCredential{
		AccessToken: "workos:old", RefreshToken: "rt-0",
		AccountID: "usr-keep", Email: "keep@b.c", Nickname: "n",
	}
	next := applyClineRefresh(prev, &clineTokenPayload{AccessToken: "new"})
	if next == prev {
		t.Fatal("must return a copy")
	}
	if next.AccessToken != "workos:new" {
		t.Fatalf("bearer patched: %q", next.AccessToken)
	}
	if next.RefreshToken != "rt-0" {
		t.Fatalf("refresh preserved: %q", next.RefreshToken)
	}
	if next.AccountID != "usr-keep" || next.Email != "keep@b.c" || next.Nickname != "n" {
		t.Fatalf("identity kept: %+v", next)
	}
}

// --- 续期请求体（驼峰字段名！写错=泛化认证失败难定位） ---

func TestClineRefreshBodyCamelCase(t *testing.T) {
	var parsed map[string]string
	if err := json.Unmarshal([]byte(ClineRefreshBody(&ClineCredential{RefreshToken: "rt-1"})), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["refreshToken"] != "rt-1" || parsed["grantType"] != "refresh_token" {
		t.Fatalf("camelCase body required: %v", parsed)
	}
	if _, hasSnake := parsed["refresh_token"]; hasSnake {
		t.Fatal("snake_case must not appear")
	}
}

// --- 设备码授权响应校验（三字段齐备才通过） ---

func TestClineDeviceAuthorizationMock(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
			t.Errorf("device grant must be form-encoded, got %q", ct)
		}
		if r.PostFormValue("client_id") != clineProduct.WorkOSClientID {
			t.Errorf("client_id form field required")
		}
		w.Write([]byte(`{"device_code":"dc-1","user_code":"uc-1","verification_uri":"https://accounts.cline.bot/device","verification_uri_complete":"https://accounts.cline.bot/device?code=uc-1","expires_in":300,"interval":5}`))
	})
	restoreClineWorkOSBase(t, srv.URL)

	m := newTestManager(t).m
	grant, err := m.RequestClineDeviceAuthorization(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if grant.DeviceCode != "dc-1" || grant.UserCode != "uc-1" {
		t.Fatalf("grant wrong: %+v", grant)
	}
	if grant.ExpiresInMs != 300_000 || grant.IntervalMs != 5_000 {
		t.Fatalf("timings wrong: %+v", grant)
	}
	// 两步式登录 URL 用 complete 形态（免手输 user_code）。
	if started, _ := m.StartClineLogin(context.Background(), "none", nil); started != nil {
		if started.LoginURL != "https://accounts.cline.bot/device?code=uc-1" {
			t.Fatalf("verification_uri_complete must be preferred: %s", started.LoginURL)
		}
		started.Close()
	}
}

func TestClineDeviceAuthorizationMissingFields(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"device_code":"dc-1"}`)) // user_code/verification_uri 缺失
	})
	restoreClineWorkOSBase(t, srv.URL)
	m := newTestManager(t).m
	if _, err := m.RequestClineDeviceAuthorization(context.Background()); err == nil {
		t.Fatal("missing required fields must fail")
	}
}

// --- register：WorkOS token → Cline token（驼峰体 + success 判据） ---

func TestRegisterClineTokensMock(t *testing.T) {
	var body map[string]string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Write([]byte(`{"success":true,"data":{"accessToken":"workos:ctok","refreshToken":"crt","userInfo":{"clineUserId":"usr-9","email":"u@c.d"}}}`))
	})
	restoreClineAPIBase(t, srv.URL)

	m := newTestManager(t).m
	payload, err := m.registerClineTokens(context.Background(), "workos:w", "wrt")
	if err != nil {
		t.Fatal(err)
	}
	if payload.AccessToken != "workos:ctok" {
		t.Fatalf("payload wrong: %+v", payload)
	}
	if body["accessToken"] != "workos:w" || body["refreshToken"] != "wrt" {
		t.Fatalf("register body must be camelCase: %+v", body)
	}
}

// --- 轮询状态机（pending 继续 / denied 终态 / token 齐） ---

func TestPollClineWorkOsTokensStates(t *testing.T) {
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			// WorkOS pending = 非 2xx + error 字段（继续轮询路径）。
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"authorization_pending"}`))
		case 2:
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"slow_down"}`))
		default:
			w.Write([]byte(`{"access_token":"workos:wtok","refresh_token":"wrt"}`))
		}
	})
	restoreClineWorkOSBase(t, srv.URL)
	// 注入 1s interval（服务端下发 0 → 下限 1s；避免测试慢）。
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	access, refresh, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	if access != "workos:wtok" || refresh != "wrt" {
		t.Fatalf("tokens wrong: %q %q", access, refresh)
	}
	if calls < 3 {
		t.Fatalf("pending/slow_down must keep polling: %d", calls)
	}
}

func TestPollClineAccessDeniedTerminal(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"access_denied","error_description":"no"}`))
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	_, _, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err == nil || !strings.Contains(err.Error(), "no") {
		t.Fatalf("access_denied is terminal with description: %v", err)
	}
}

// TestPollClinePendingOnHTTP200: WorkOS normally answers pending with 400, but
// a 2xx + `error` body must still be treated as "keep polling" — the previous
// "2xx ⇒ success" ordering reported it as a bogus "missing fields" failure
// (real defect reported by the user: 「WorkOS token 响应缺少必要字段」).
func TestPollClinePendingOnHTTP200(t *testing.T) {
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			// 200 + error — the shape that used to abort the login.
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"error":"authorization_pending","error_description":"still pending"}`))
			return
		}
		w.Write([]byte(`{"access_token":"workos:at","refresh_token":"rt"}`))
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	access, refresh, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err != nil {
		t.Fatalf("200+pending must keep polling, got %v", err)
	}
	if access != "workos:at" || refresh != "rt" || calls < 2 {
		t.Fatalf("second poll must succeed: calls=%d access=%q refresh=%q", calls, access, refresh)
	}
}

// TestPollClineNonJSONBodySurfacesPayload: a 2xx whose body is not the token
// JSON (empty body / HTML from a proxy or gateway) must report the status and
// the body — not a bare "缺少必要字段" that hides the cause.
func TestPollClineNonJSONBodySurfacesPayload(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`<html><body>blocked by proxy</body></html>`))
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	_, _, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err == nil {
		t.Fatal("non-JSON 2xx must fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, "非 JSON") || !strings.Contains(msg, "blocked by proxy") {
		t.Fatalf("error must carry the real body, got: %s", msg)
	}
	if !strings.Contains(msg, "HTTP 200") {
		t.Fatalf("error must carry the status, got: %s", msg)
	}
}

// TestPollClineEmptyBodySurfacesPayload: an empty 2xx body is a distinct,
// equally opaque failure — must say so explicitly.
func TestPollClineEmptyBodySurfacesPayload(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	_, _, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err == nil || !strings.Contains(err.Error(), "空响应体") {
		t.Fatalf("empty 2xx body must be reported explicitly: %v", err)
	}
}

// TestPollClineUnexpectedJSONShapeNamesKeys: a valid-JSON 2xx without tokens
// must name the keys the server actually sent (decisive diagnostics).
func TestPollClineUnexpectedJSONShapeNamesKeys(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"pending_authentication_token":"pat","organization_id":"org_1"}`))
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	_, _, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err == nil {
		t.Fatal("token-less 2xx must fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, "organization_id") || !strings.Contains(msg, "pending_authentication_token") {
		t.Fatalf("error must name the JSON keys, got: %s", msg)
	}
}

// TestPollClineCamelCaseTokens: token fields are accepted in camelCase too
// (WorkOS user-management responses vary across endpoints/versions).
func TestPollClineCamelCaseTokens(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"accessToken":"workos:cc","refreshToken":"cc-rt"}`))
	})
	restoreClineWorkOSBase(t, srv.URL)
	grant := &clineDeviceAuthorization{DeviceCode: "dc", UserCode: "uc", VerificationURI: "u", IntervalMs: 1000, ExpiresInMs: 30000}
	m := newTestManager(t).m
	access, refresh, err := m.pollClineWorkOsTokens(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	if access != "workos:cc" || refresh != "cc-rt" {
		t.Fatalf("camelCase tokens not accepted: %q %q", access, refresh)
	}
}

// --- 余额：accountId（usr-）而非 JWT sub（user- 400 实测） ---

func TestClineBalanceUsesAccountID(t *testing.T) {
	var gotPath string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(`{"success":true,"data":{"userId":"usr-9","balance":500000}}`))
	})
	restoreClineAPIBase(t, srv.URL)

	m := newSeedClineManager(t)
	bal, raw, err := m.ClineBalance(context.Background(), firstClineAccount(t, m))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotPath, "usr-9") {
		t.Fatalf("balance must use usr- accountId (sub returns 400): %s", gotPath)
	}
	if raw != 500000 || bal.Total != 5.0 {
		t.Fatalf("scale conversion: raw=%d total=%v", raw, bal.Total)
	}
}

func TestClineBalanceRequiresAccountID(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request may happen without account_id")
	})
	restoreClineAPIBase(t, srv.URL)
	m := newTestManager(t).m
	id, ref := NewAccountID("cline")
	_ = m.AddAccount(Account{ID: id, Provider: "cline", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&ClineCredential{AccessToken: "workos:x"})
	_ = m.SetCredential("cline", ref, data, 1, true)
	if _, _, err := m.ClineBalance(context.Background(), id); err == nil {
		t.Fatal("account_id missing must fail explicitly")
	}
}

// --- augment：头族替换 + body 透传 ---

func TestClineAugmentHeaders(t *testing.T) {
	m := newSeedClineManager(t)
	accID := firstClineAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://api.cline.bot/api/v1/chat/completions", nil)
	req.Header.Set("X-Leftover", "vanish")
	out, err := m.clineAugment(req, []byte(`{"m":1}`), "jethub-cline", accID, "cline-free/deepseek-v4.1-flash")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"m":1}` {
		t.Fatal("standard OpenAI body must pass through unchanged")
	}
	if req.Header.Get("X-Leftover") != "" {
		t.Fatal("pre-existing headers cleared")
	}
	if req.Header.Get("Authorization") != "Bearer workos:ctok" {
		t.Fatalf("workos-prefixed bearer: %q", req.Header.Get("Authorization"))
	}
	if req.Header.Get("HTTP-Referer") != "https://cline.bot" || req.Header.Get("X-CLIENT-TYPE") != "cline-sdk" {
		t.Fatal("product client headers missing")
	}
}

// --- 测试基建 ---

func restoreClineWorkOSBase(t *testing.T, mockURL string) {
	t.Helper()
	old := clineProduct.WorkOSBase
	clineProduct.WorkOSBase = mockURL
	t.Cleanup(func() { clineProduct.WorkOSBase = old })
}

func restoreClineAPIBase(t *testing.T, mockURL string) {
	t.Helper()
	old := clineProduct.APIBase
	clineProduct.APIBase = mockURL
	t.Cleanup(func() { clineProduct.APIBase = old })
}

func newSeedClineManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("cline")
	if err := m.AddAccount(Account{ID: id, Provider: "cline", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &ClineCredential{AccessToken: "workos:ctok", RefreshToken: "crt", AccountID: "usr-9", Email: "u@c.d", Nickname: "u@c.d"}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("cline", ref, data, 1, true); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstClineAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("cline")
	if len(accounts) == 0 {
		t.Fatal("no seeded cline account")
	}
	return accounts[0].ID
}
