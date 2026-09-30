package jethub

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// --- JWT claim helpers (buddy TokenData parsing fallbacks) ---

// mustJWT builds a fake JWT with the given payload claims for tests.
func mustJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.RawURLEncoding.EncodeToString([]byte("test"))
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + "." + sig
}

func TestStripControlChars(t *testing.T) {
	// CodeBuddy scope carries newlines that break JSON-in-YAML persistence.
	got := stripControlChars("profile\n    offline_access\n\temail")
	if got != "profile offline_access email" {
		t.Fatalf("scope control chars not normalized: %q", got)
	}
}

func TestBuddyTokenExpiryMs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		jwt  string // fallback token
		want int64
	}{
		{"ms timestamp", "1800000000000", "", 1800000000000},
		{"sec timestamp", "1800000000", "", 1800000000000},
		{"iso", "2030-01-01T00:00:00Z", "", parseISOTime("2030-01-01T00:00:00Z")},
		{"jwt exp fallback", "", mustJWT(t, map[string]any{"exp": 1900000000}), 1900000000000},
		{"none", "", "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := buddyTokenExpiryMs(&BuddyCredential{ExpiresAt: c.raw, AccessToken: c.jwt})
			if got != c.want {
				t.Fatalf("got %d want %d", got, c.want)
			}
		})
	}
}

// --- ParseBuddyTokenData: relative expiresIn normalization (e2e-verified:
// /v2/plugin/auth/token returns expiresIn/refreshExpiresIn, NOT absolute
// values) ---

func TestParseBuddyTokenDataRelativeExpiresIn(t *testing.T) {
	token := mustJWT(t, map[string]any{"exp": 2000000000.0, "iat": 1700000000.0})
	data := ParseBuddyTokenData(map[string]any{
		"accessToken":       token,
		"refreshToken":      "rt-1",
		"expiresIn":         3600.0, // relative seconds
		"refreshExpiresIn":  7200.0,
		"scope":             "profile\n offline_access", // control chars
		"tokenType":         123.0,                      // number-typed fields tolerated
	})
	if token == "" {
		t.Fatal("test token empty")
	}
	if data.AccessToken != token || data.RefreshToken != "rt-1" {
		t.Fatalf("token fields wrong: %+v", data)
	}
	// expiresAt = jwt iat + expiresIn*1000
	if data.ExpiresAt == "" {
		t.Fatal("expiresAt must be normalized")
	}
	got := buddyTokenExpiryMs(&BuddyCredential{ExpiresAt: data.ExpiresAt, AccessToken: token})
	if got != wantExpirySeconds(1700000000, 3600) {
		t.Fatalf("expiresAt normalization wrong: got %d want %d", got, wantExpirySeconds(1700000000, 3600))
	}
	if data.TokenType != "123" {
		t.Fatalf("numeric tokenType must be stringified like readStringField: %q", data.TokenType)
	}
	// tokenType 缺失 → 默认 Bearer。
	def := ParseBuddyTokenData(map[string]any{"accessToken": token})
	if def.TokenType != "Bearer" {
		t.Fatalf("tokenType default wrong: %q", def.TokenType)
	}
	if strings.Contains(data.Scope, "\n") {
		t.Fatalf("scope must be control-char stripped: %q", data.Scope)
	}
}

func wantExpirySeconds(base, rel int64) int64 { return base*1000 + rel*1000 }

func TestParseBuddyAccountData(t *testing.T) {
	acc := ParseBuddyAccountData(map[string]any{"uid": "u1", "type": "enterprise", "enterpriseId": "ent-1"})
	if acc.UID != "u1" || acc.AccountType != "enterprise" || acc.EnterpriseID != "ent-1" {
		t.Fatalf("parse wrong: %+v", acc)
	}
	// type 缺失 → 默认 personal。
	def := ParseBuddyAccountData(map[string]any{"uid": "u2"})
	if def.AccountType != "personal" {
		t.Fatalf("default account type wrong: %q", def.AccountType)
	}
}

func TestBuildBuddyCredentialNicknameFallback(t *testing.T) {
	token := &BuddyTokenData{AccessToken: mustJWT(t, map[string]any{
		"exp": 2000000000.0, "nickname": "jwt-nick", "sub": "jwt-sub",
	})}
	// account.nickname 优先（非空时）。
	cred := BuildBuddyCredential(token, &BuddyAccountData{Nickname: "acct-nick"})
	if cred.Nickname != "acct-nick" {
		t.Fatalf("account nickname must win: %q", cred.Nickname)
	}
	// account.nickname 为空 → JWT nickname 兜底。
	cred = BuildBuddyCredential(token, &BuddyAccountData{})
	if cred.Nickname != "jwt-nick" || cred.UserID != "jwt-sub" {
		t.Fatalf("JWT fallback failed: %+v", cred)
	}
}

// --- UA 分档（international version per-model-family rules） ---

func TestResolveBuddyUserAgent(t *testing.T) {
	products := BuddyProducts()
	// CN product: single UA for all models.
	if got := resolveBuddyUserAgent(products["buddy"], "gpt-5.5"); got != products["buddy"].UserAgent {
		t.Fatalf("buddy UA override unexpected: %q", got)
	}
	// International: intl lines get the intl form, domestic lines the CN form.
	wb := products["workbuddy"]
	if got := resolveBuddyUserAgent(wb, "gpt-5.6-sol"); got != workbuddyUAIntl {
		t.Fatalf("gpt-* should use intl UA, got %q", got)
	}
	if got := resolveBuddyUserAgent(wb, "glm-5.2"); got != workbuddyUACN {
		t.Fatalf("glm-* should use cn UA, got %q", got)
	}
	if got := resolveBuddyUserAgent(wb, "kimi-k3"); got != workbuddyUACN {
		t.Fatalf("kimi-* should use cn UA, got %q", got)
	}
	if got := resolveBuddyUserAgent(wb, "unknown-model"); got != wb.UserAgent {
		t.Fatalf("fallback should be the product UA, got %q", got)
	}
}

// --- DecorateLoginURL：仅 WorkBuddy 追加参数（不得重建 URL） ---

func TestDecorateBuddyLoginURL(t *testing.T) {
	products := BuddyProducts()
	cn := DecorateBuddyLoginURL("https://auth.example.com/login?x=1", products["buddy"])
	if strings.Contains(cn, "loginSessionId") {
		t.Fatal("buddy must NOT append session params")
	}
	base := "https://auth.example.com/login"
	wb := DecorateBuddyLoginURL(base, products["workbuddy"])
	if !strings.HasPrefix(wb, base+"?") {
		t.Fatalf("URL must be preserved: %q", wb)
	}
	if !strings.Contains(wb, "version=5.5.2") || !strings.Contains(wb, "loginSessionId=") {
		t.Fatalf("workbuddy must append version + loginSessionId: %q", wb)
	}
	// 已有 query 时用 & 追加。
	wb2 := DecorateBuddyLoginURL(base+"?a=1", products["workbuddy"])
	if !strings.Contains(wb2, "?a=1&version=") {
		t.Fatalf("existing query must be preserved: %q", wb2)
	}
}

// --- 静态模型表 ---

func TestBuddyFallbackModelsRegistered(t *testing.T) {
	b := NewBridge(newTestManager(t).m, newFakeRegistry())
	RegisterDefaultProducts(b)
	prod, ok := b.Product("buddy")
	if !ok || len(prod.Models) == 0 {
		t.Fatal("buddy product must carry a model table")
	}
	if prod.BaseURL != "https://copilot.tencent.com" {
		t.Fatalf("buddy endpoint wrong: %q", prod.BaseURL)
	}
	wb, ok := b.Product("workbuddy")
	if !ok || len(wb.Models) == 0 {
		t.Fatal("workbuddy product must carry a model table")
	}
	if wb.BaseURL != "https://www.workbuddy.ai" {
		t.Fatalf("workbuddy endpoint wrong: %q", wb.BaseURL)
	}
	// 两个产品的模型表不共用（workbuddy 有 gpt 系、buddy 没有）。
	for _, m := range prod.Models {
		if strings.HasPrefix(m.ID, "gpt-") {
			t.Fatalf("CN catalog must not contain gpt models: %s", m.ID)
		}
	}
}

// --- bridge + token extractor：access_token 就是 bridge Key ---

func TestBridgeBuddyKeysAreAccessTokens(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)
	id, ref := NewAccountID("buddy")
	if err := m.AddAccount(Account{ID: id, Provider: "buddy", Nickname: "测试号", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &BuddyCredential{AccessToken: "bb-tok-1", RefreshToken: "rt-1", Domain: "copilot.tencent.com"}
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("buddy", ref, data, 123, true); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("buddy", "bb"); err != nil {
		t.Fatalf("set prefix: %v", err)
	}
	p, ok := reg.GetProvider("jethub-buddy")
	if !ok {
		t.Fatal("bridged buddy provider missing")
	}
	if len(p.Keys) != 1 || p.Keys[0].Key != "bb-tok-1" || p.Keys[0].Account != "测试号" {
		t.Fatalf("bridge keys wrong: %+v", p.Keys)
	}
}

// --- augment：归属头族 + Bearer + 模型分档 UA ---

func TestBuddyAugmentHeaders(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("workbuddy")
	_ = m.AddAccount(Account{ID: id, Provider: "workbuddy", Enabled: true, CredentialRef: ref})
	cred := &BuddyCredential{AccessToken: "wb-tok", Domain: "copilot.tencent.com", EnterpriseID: "e-1"}
	data, _ := json.Marshal(cred)
	_ = m.SetCredential("workbuddy", ref, data, 1, true)
	m.RegisterProviderAugmenters()

	p := BuddyProducts()["workbuddy"]
	req, _ := http.NewRequest(http.MethodPost, p.Endpoint+buddyChatPath, nil)
	req.Header.Set("X-Leftover", "should-vanish")
	body := []byte(`{"model":"glm-5.2"}`)
	out, err := m.buddyAugment(p)(req, body, "jethub-workbuddy", id, "glm-5.2")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(body) {
		t.Fatal("body must pass through unchanged")
	}
	if req.Header.Get("X-Leftover") != "" {
		t.Fatal("pre-existing headers must be cleared")
	}
	if req.Header.Get("Authorization") != "Bearer wb-tok" {
		t.Fatal("Bearer token missing")
	}
	// X-Domain 以产品为准（凭据 domain 是过期快照）。
	if req.Header.Get(buddyHeaderDomain) != "www.workbuddy.ai" {
		t.Fatalf("X-Domain must be product value, got %q", req.Header.Get(buddyHeaderDomain))
	}
	if req.Header.Get(buddyHeaderProductCode) != "workbuddy" {
		t.Fatal("X-Product-Code missing")
	}
	if req.Header.Get("X-Agent-Purpose") != "conversation" || req.Header.Get("X-IDE-Name") != "WorkBuddy" {
		t.Fatal("attribution header family missing")
	}
	// 模型分档 UA（glm-* → CN 形态）。
	if got := req.Header.Get("User-Agent"); got != workbuddyUACN {
		t.Fatalf("model-family UA wrong: %q", got)
	}
}

// --- credits：签到 mock 往返 ---

func TestBuddyClaimDailyFlow(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: ref})
	cred := &BuddyCredential{AccessToken: "tok", RefreshToken: "rt", UserID: "u1", Domain: "copilot.tencent.com"}
	data, _ := json.Marshal(cred)
	_ = m.SetCredential("buddy", ref, data, 1, true)

	var gotPath, gotProductCode, gotDomain, gotUserID string
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotProductCode = r.Header.Get(buddyHeaderProductCode)
		gotDomain = r.Header.Get(buddyHeaderDomain)
		gotUserID = r.Header.Get("X-User-Id")
		w.Write([]byte(`{"code":0,"data":{"credit":1000,"streak_days":2,"is_streak_day":true}}`))
	})
	defer srv.Close()

	// 指向 mock 端点（测试 hook）。
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {ID: "buddy", Endpoint: srv.URL, APIDomain: "copilot.tencent.com", ProductCode: "codebuddy", UserAgent: testUA},
	}
	defer func() { buddyProductsMap = old }()

	outcome, err := m.ClaimBuddyDaily(context.Background(), "buddy", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 1000 {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	if gotPath != buddyDailyCheckinPath {
		t.Fatalf("path = %q", gotPath)
	}
	if gotProductCode != "codebuddy" || gotDomain != "copilot.tencent.com" || gotUserID != "u1" {
		t.Fatalf("checkin headers wrong: %q %q %q", gotProductCode, gotDomain, gotUserID)
	}
}

func TestBuddyClaimAlreadyClaimedCode(t *testing.T) {
	m := newTestManager(t).m
	if err := m.SetModelDisabled("buddy", "x", true); err != nil {
		t.Fatal(err)
	}
	_ = m.SetModelDisabled("buddy", "x", false)
	// business code 10001 → already-claimed（幂等判定以响应体 code 为准,
	// HTTP 400 同样如此）。
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":10001,"msg":"今日已签到"}`))
	})
	defer srv.Close()
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {ID: "buddy", Endpoint: srv.URL, APIDomain: "x", ProductCode: "codebuddy", UserAgent: testUA},
	}
	defer func() { buddyProductsMap = old }()

	id, ref := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&BuddyCredential{AccessToken: "t"})
	_ = m.SetCredential("buddy", ref, data, 1, true)

	outcome, err := m.ClaimBuddyDaily(context.Background(), "buddy", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("HTTP 400 + code 10001 must be already-claimed, got %+v", outcome)
	}
}

// --- 余额解析（双层嵌套 data.Response.Data.Accounts[]） ---

func TestBuddyBalanceDoubleNested(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"Response":{"Data":{"Accounts":[
			{"PackageName":"Bonus Pack","Status":0,"CycleCapacityRemain":247,"CycleCapacityRemainPrecise":"247.87","CycleCapacitySize":300},
			{"PackageName":"Old","Status":3,"CycleCapacityRemain":400}
		]}}}}`))
	})
	defer srv.Close()
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {ID: "buddy", Endpoint: srv.URL, APIDomain: "x", ProductCode: "codebuddy", UserAgent: testUA},
	}
	defer func() { buddyProductsMap = old }()

	m := newTestManager(t).m
	id, ref := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&BuddyCredential{AccessToken: "t"})
	_ = m.SetCredential("buddy", ref, data, 1, true)

	bal, err := m.BuddyBalance(context.Background(), "buddy", id)
	if err != nil {
		t.Fatal(err)
	}
	// 失效包（Status=3）不得计入总额。
	if bal.Total != 247.87 {
		t.Fatalf("total = %v, want 247.87（precise 值优先且只累计有效包）", bal.Total)
	}
	if len(bal.Packages) != 2 {
		t.Fatalf("packages = %d", len(bal.Packages))
	}
}

// --- refresh：终态判定 ---

func TestBuddyRefreshTerminalExpired(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(buddyHeaderRefreshToken) != "rt-1" {
			t.Errorf("X-Refresh-Token missing")
		}
		if r.Header.Get(buddyHeaderRefreshSource) != buddyAuthRefreshSrc {
			t.Errorf("X-Auth-Refresh-Source missing")
		}
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"code":401,"message":"token expired"}`))
	})
	defer srv.Close()
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {ID: "buddy", Endpoint: srv.URL, APIDomain: "x", ProductCode: "codebuddy", UserAgent: testUA},
	}
	defer func() { buddyProductsMap = old }()

	m := newTestManager(t).m
	id, ref := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&BuddyCredential{AccessToken: "t", RefreshToken: "rt-1"})
	_ = m.SetCredential("buddy", ref, data, 1, true)

	if err := m.RefreshBuddyAccount(context.Background(), "buddy", id); err != ErrRefreshTokenExpired {
		t.Fatalf("expected ErrRefreshTokenExpired, got %v", err)
	}
	acc, _ := m.FindAccount(id)
	if acc.Refreshable {
		t.Fatal("account must be marked non-refreshable (终态，停止重试)")
	}
}

// --- auth/state + auth/token 轮询（mock 全登录流） ---

func TestBuddyLoginFlowMock(t *testing.T) {
	var stateHits, tokenHits, accountHits int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/auth/state"):
			stateHits++
			w.Write([]byte(`{"code":0,"data":{"state":"st-1","authUrl":"https://auth.example.com/login"}}`))
		case strings.HasSuffix(r.URL.Path, "/auth/token"):
			tokenHits++
			if tokenHits < 2 {
				// 第一拍未就绪（11217 → 继续轮询）
				w.Write([]byte(`{"code":11217,"message":"not ready"}`))
				return
			}
			tok := mustJWT(t, map[string]any{"exp": 2000000000.0, "nickname": "flow-nick", "sub": "u-9"})
			w.Write([]byte(`{"code":0,"data":{"accessToken":"` + tok + `","refreshToken":"rt-9","expiresIn":3600}}`))
		case strings.HasSuffix(r.URL.Path, "/login/account"):
			accountHits++
			w.Write([]byte(`{"code":0,"data":{"uid":"uid-9","type":"personal"}}`))
		default:
			w.WriteHeader(404)
		}
	})
	defer srv.Close()
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {
			ID: "buddy", Endpoint: srv.URL, APIDomain: "copilot.tencent.com",
			ProductCode: "codebuddy", UserAgent: testUA, Platform: "ide",
		},
	}
	defer func() { buddyProductsMap = old }()
	// 缩短轮询间隔让测试快速完成（buddyPollInterval 为包级常量；
	// 通过直接调用 buddyTokenOnce 并注入极小超时不可行，轮询间隔固定 1s。
	// 该测试等待两拍 token + 一拍 account ≈ 3s，可接受）。

	m := newTestManager(t).m
	id, _ := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: "X"})

	cred, err := m.buddyTokenOnce(context.Background(), buddyProductsMap["buddy"], "st-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if stateHits != 0 || tokenHits < 2 || accountHits < 1 {
		t.Fatalf("flow shape wrong: state=%d token=%d account=%d", stateHits, tokenHits, accountHits)
	}
	if cred.AccessToken == "" || cred.UserID != "uid-9" {
		t.Fatalf("credential assembly wrong: %+v", cred)
	}
	// nickname 来自 JWT（login/account 不带 nickname —— e2e 实证）。
	if cred.Nickname != "flow-nick" {
		t.Fatalf("nickname fallback failed: %q", cred.Nickname)
	}
	if err := m.CompleteBuddyLogin(id, cred); err != nil {
		t.Fatal(err)
	}
	acc, ok := m.FindAccount(id)
	if !ok || !acc.Refreshable {
		t.Fatalf("account display fields not updated: %+v", acc)
	}
	if time.Since(startTimeForTest) > 30*time.Second {
		t.Skip("test env too slow; polling took too long")
	}
}

var testUA = "TestUA/1.0"

var startTimeForTest = time.Now()
var _ = json.Marshal
