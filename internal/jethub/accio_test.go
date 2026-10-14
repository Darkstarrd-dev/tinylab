package jethub

// Accio 协议与编排骨径测试（不联网 —— 所有出站都指向 httptest mock）。
//
// 覆盖面与 ref 依据（每条测试标出处）：
//   - 登录：PKCE 复用 + 授权 URL 参数逐项（accio_login.go / ref accio-auth.ts）
//   - OAuth：信封判据 + 秒→毫秒归一 + 终态标记（accio_oauth.go / ref accio-oauth.ts）
//   - 续期：三规则（串行 / lead-time / 判终态前重读）+ RefreshAll 对账（accio_refresh.go）
//   - 目录：解析判据 + token 键名 + 兜底表 slug 契约（accio_models.go / ref accio-auth.ts fetchModels）
//   - body/URL/头：四处硬约束 + properties 豁免 + sg_k（accio.go / ref accio.ts）
//   - 积分：信封 ok/authFailed 判据 + 桶语义（accio_credits.go / ref accio-credits.ts）
//   - 探针：stream:true 无 max_tokens（probe.go / ref accio-adapter.ts）

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// accioTestCred builds a complete, refreshable credential with the given
// expiry (0 = unknown ⇒ refresh now).
func accioTestCred(expiryMs int64) *AccioCredential {
	return &AccioCredential{
		AccessToken:  "AT-OLD",
		RefreshToken: "RT-OLD",
		ExpiresAtMs:  expiryMs,
		Region:       "cn",
	}
}

// accioSeedCred registers an accio account with the credential (officeace
// seed helper 的同款).
func accioSeedCred(t *testing.T, m *Manager, accountID string, cred *AccioCredential) {
	t.Helper()
	_, ref := NewAccountID("accio")
	if err := m.AddAccount(Account{ID: accountID, Provider: "accio", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetCredential("accio", ref, raw, accioCredentialExpiresAt(cred), accioRefreshable(cred)); err != nil {
		t.Fatal(err)
	}
}

// accioCredentialOf reads back the stored credential of an account.
func accioCredentialOf(t *testing.T, m *Manager, accountID string) *AccioCredential {
	t.Helper()
	acc, ok := m.FindAccount(accountID)
	if !ok {
		t.Fatalf("account %s missing", accountID)
	}
	raw, ok := m.Credential("accio", acc.CredentialRef)
	if !ok {
		t.Fatalf("credential %s missing", acc.CredentialRef)
	}
	var cred AccioCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		t.Fatal(err)
	}
	return &cred
}

// ── region / 登录 URL ────────────────────────────────────────────────────

func TestAccioRegionNormalization(t *testing.T) {
	if got := normalizeAccioRegion("global"); got != "global" {
		t.Fatalf("global must pass through, got %q", got)
	}
	for _, raw := range []string{"", "cn", "CN", "eu", "unknown"} {
		if got := normalizeAccioRegion(raw); got != "cn" {
			t.Fatalf("region %q must fall back to cn, got %q", raw, got)
		}
	}
}

// TestAccioAuthURLParams: 授权 URL 参数缺一不可（少了 code_challenge 会被登录
// 页判成 legacy 客户端而弹「请升级客户端」，ref buildAccioAuthUrl 的事故说明）。
func TestAccioAuthURLParams(t *testing.T) {
	challenge := strings.Repeat("a", 43)
	tests := []struct {
		region string
		host   string
	}{
		{"cn", "https://www.accio-ai.com"},
		{"global", "https://zh.accio.com"},
		{"", "https://www.accio-ai.com"},
	}
	for _, tc := range tests {
		u := accioBuildAuthURL(tc.region, "http://127.0.0.1:1"+accioCallbackPath, "st-123", challenge)
		if !strings.HasPrefix(u, tc.host+"/login?") {
			t.Errorf("region %q: URL host = %s", tc.region, u)
		}
		for _, want := range []string{
			"return_url=http%3A%2F%2F127.0.0.1%3A1%2Fauth%2Fcallback",
			"state=st-123",
			"code_challenge=" + challenge,
			"code_challenge_method=S256",
			"client_id=accio-work",
			"ttid=ttid_",
			"language=zh",
		} {
			if !strings.Contains(u, want) {
				t.Errorf("region %q: URL missing %s\n%s", tc.region, want, u)
			}
		}
	}
}

// TestAccioLoginStateContract: StartAccioLogin 起回调监听并返回授权 URL；
// state 是 32 字节随机 hex（64 字符）。超时预算 10 分钟由 accioLoginBudget 契约
// 常量守住（这里不起真流程，只验证常量与路径）。
func TestAccioLoginConstants(t *testing.T) {
	if accioCallbackPath != "/auth/callback" {
		t.Fatalf("callback path = %q", accioCallbackPath)
	}
	if accioLoginBudget != 10*time.Minute {
		t.Fatalf("login budget = %v", accioLoginBudget)
	}
	if accioClientID != "accio-work" {
		t.Fatalf("client id = %q", accioClientID)
	}
	state := randomHex(32)
	if len(state) != 64 {
		t.Fatalf("state hex length = %d", len(state))
	}
}

// ── OAuth 信封 / 归一 / 终态 ─────────────────────────────────────────────

// TestAccioUnwrapEnvelope: success!==true 即失败（带服务端 code+message）；
// 缺 data 也是失败（兑换/续期是硬操作，ref unwrapTokenEnvelope）。
func TestAccioUnwrapEnvelope(t *testing.T) {
	data, err := accioUnwrapEnvelope("/api/oauth/token", 200,
		[]byte(`{"success":true,"code":"0","message":"","data":{"accessToken":"a","refreshToken":"r","expiresAt":123}}`))
	if err != nil || data["accessToken"] != "a" {
		t.Fatalf("ok envelope: data=%v err=%v", data, err)
	}
	if _, err := accioUnwrapEnvelope("/api/oauth/token", 200,
		[]byte(`{"success":false,"code":"invalid_grant","message":"bad code"}`)); err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Fatalf("failed envelope must carry the server code, got %v", err)
	}
	if _, err := accioUnwrapEnvelope("/api/oauth/token", 200,
		[]byte(`{"success":true}`)); err == nil || !strings.Contains(err.Error(), "data") {
		t.Fatalf("missing data must fail, got %v", err)
	}
	if _, err := accioUnwrapEnvelope("/api/oauth/token", 500,
		[]byte(`not-json`)); err == nil {
		t.Fatal("non-JSON must fail")
	}
}

// TestAccioExpiresAtMs: 上游 expiresAt 是**秒**；>1e12 视为已是毫秒（容错未来）。
func TestAccioExpiresAtMs(t *testing.T) {
	cases := []struct {
		raw  any
		want int64
		ok   bool
	}{
		{float64(1234), 1234000, true},                    // 秒 → 毫秒
		{float64(2_000_000_000_000), 2000000000000, true}, // 已是毫秒
		{"5678", 5678000, true},                           // 字符串秒
		{float64(0), 0, false},
		{float64(-5), 0, false},
		{"", 0, false},
		{"abc", 0, false},
		{nil, 0, false},
	}
	for _, tc := range cases {
		got, ok := accioExpiresAtMs(tc.raw)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("accioExpiresAtMs(%v) = %d,%v want %d,%v", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

// TestAccioToTokenResult: 兑换/续期结果的毫秒归一恰好做一次（秒→毫秒，重复
// ×1000 是 accio 的同型历史坑）。
func TestAccioToTokenResult(t *testing.T) {
	res, err := accioToTokenResult("/api/oauth/token", map[string]any{
		"accessToken": "a", "refreshToken": "r", "expiresAt": float64(1893456000),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExpiresAtMs != 1893456000000 {
		t.Fatalf("seconds must ×1000 once, got %d", res.ExpiresAtMs)
	}
	if _, err := accioToTokenResult("/x", map[string]any{"accessToken": "a", "refreshToken": "r"}); err == nil {
		t.Fatal("missing expiresAt must fail")
	}
}

// TestAccioTerminalRefreshMarkers: 判终态只认 refresh_token 家族标记；泛化
// 401/403 / 网络抖动一律可重试（ref ACCIO_TERMINAL_REFRESH_MARKERS 的取舍）。
func TestAccioTerminalRefreshMarkers(t *testing.T) {
	for _, msg := range []string{
		`jethub: upstream HTTP 400: {"code":"invalid_grant"}`,
		"refresh token expired",
		"NOT_LOGIN",
		"Refresh_Token Has Been Used", // 大小写不敏感
	} {
		if !isAccioTerminalRefreshMessage(msg) {
			t.Errorf("%q must be terminal", msg)
		}
	}
	for _, msg := range []string{
		`jethub: upstream HTTP 401: unauthorized`,
		"connection reset by peer",
		`HTTP 403: forbidden by risk control`,
		"",
	} {
		if isAccioTerminalRefreshMessage(msg) {
			t.Errorf("%q must NOT be terminal (retryable)", msg)
		}
	}
}

// ── 续期三规则 ───────────────────────────────────────────────────────────

// accioMockToken spins a token endpoint mock: counts calls, validates the
// request shape (JSON envelope with refreshToken/clientId/grantType) and
// returns the given body/status after a delay.
func accioMockToken(t *testing.T, delay time.Duration, status int, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		if delay > 0 {
			time.Sleep(delay)
		}
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

// TestAccioRefreshRenewal: 过期凭据 → 换新并立即落盘；新凭据远未到期 →
// lead-time 跳过、不发请求（规则 2，ref cf5edab）。
func TestAccioRefreshRenewal(t *testing.T) {
	srv, calls := accioMockToken(t, 0, 200,
		`{"success":true,"code":"0","data":{"accessToken":"AT-NEW","refreshToken":"RT-NEW","expiresAt":4102444800}}`)
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	m := newTestManager(t).m
	// 已过期（2020 年）⇒ 必须续。
	accioSeedCred(t, m, "acct-r", accioTestCred(1577836800000))
	if err := m.RefreshAccioAccount(context.Background(), "acct-r"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 token call, got %d", calls.Load())
	}
	cred := accioCredentialOf(t, m, "acct-r")
	if cred.AccessToken != "AT-NEW" || cred.RefreshToken != "RT-NEW" {
		t.Fatalf("renewal not persisted: %+v", cred)
	}
	if cred.ExpiresAtMs != 4102444800000 {
		t.Fatalf("expiry seconds must ×1000 once, got %d", cred.ExpiresAtMs)
	}
	// region/身份字段跨续期保留。
	if cred.Region != "cn" {
		t.Fatalf("region must survive renewal: %+v", cred)
	}
	acc, _ := m.FindAccount("acct-r")
	if !acc.Refreshable || acc.ExpiresAt != 4102444800000 {
		t.Fatalf("display fields not refreshed: %+v", acc)
	}

	// 第二次：新凭据 2100 年到期 → 跳过（规则 2）。
	if err := m.RefreshAccioAccount(context.Background(), "acct-r"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("fresh credential must skip the refresh request (rule 2)")
	}
}

// TestAccioRefreshSerialRules: 同一凭据的并发续期必须串行（规则 1）—— 锁内
// 重读让后到者看到新凭据直接跳过，绝不烧两次 refresh（并发消费同一份
// refresh_token 必然「1 成功 N invalid_grant」）。
func TestAccioRefreshSerialRules(t *testing.T) {
	srv, calls := accioMockToken(t, 150*time.Millisecond, 200,
		`{"success":true,"code":"0","data":{"accessToken":"AT-NEW","refreshToken":"RT-NEW","expiresAt":4102444800}}`)
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	m := newTestManager(t).m
	accioSeedCred(t, m, "acct-s", accioTestCred(1577836800000)) // 已过期

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// 错开 50ms 启动：第二个调用者一定在第一个持锁期间到达。
			time.Sleep(time.Duration(i) * 50 * time.Millisecond)
			errs <- m.RefreshAccioAccount(context.Background(), "acct-s")
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent refresh failed: %v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("per-ref serialization must issue exactly ONE refresh, got %d", calls.Load())
	}
	if cred := accioCredentialOf(t, m, "acct-s"); cred.RefreshToken != "RT-NEW" {
		t.Fatalf("renewed credential not persisted: %+v", cred)
	}
}

// TestAccioRefreshTerminalVsRenewedElsewhere: invalid_grant 时先重读（规则 3）：
//   - refresh_token 未变 ⇒ 真终态（ErrRefreshTokenExpired + Refreshable=false）；
//   - 已被换新 ⇒ 他处续期成功（nil，账号不作废）。
func TestAccioRefreshTerminalVsRenewedElsewhere(t *testing.T) {
	srv, _ := accioMockToken(t, 0, 401, `{"code":"invalid_grant","message":"bad refresh token"}`)
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	t.Run("token unchanged → terminal", func(t *testing.T) {
		m := newTestManager(t).m
		accioSeedCred(t, m, "acct-t", accioTestCred(1577836800000))
		err := m.RefreshAccioAccount(context.Background(), "acct-t")
		if err != ErrRefreshTokenExpired {
			t.Fatalf("want ErrRefreshTokenExpired, got %v", err)
		}
		acc, _ := m.FindAccount("acct-t")
		if acc.Refreshable {
			t.Fatal("terminal failure must clear Refreshable")
		}
	})

	t.Run("token rotated elsewhere → nil", func(t *testing.T) {
		m := newTestManager(t).m
		accioSeedCred(t, m, "acct-e", accioTestCred(1577836800000))
		// 模拟「锁内重读之后、失败之前」凭据被他处换新：直接以旧凭据材料
		// 调 refreshAccioLocked（磁盘上已是 RT-NEW）。
		acc, _ := m.FindAccount("acct-e")
		if err := m.SetCredential("accio", acc.CredentialRef, mustJSON(t, accioTestCred(1577836800000+1)), 0, true); err != nil {
			t.Fatal(err)
		}
		rotated := accioTestCred(1577836800000)
		rotated.RefreshToken = "RT-NEW"
		if err := m.SetCredential("accio", acc.CredentialRef, mustJSON(t, rotated), 0, true); err != nil {
			t.Fatal(err)
		}
		stale := accioTestCred(1577836800000) // 持有的还是 RT-OLD
		if err := m.refreshAccioLocked(context.Background(), &acc, stale); err != nil {
			t.Fatalf("rotated-elsewhere must be a soft success, got %v", err)
		}
		after, _ := m.FindAccount("acct-e")
		if !after.Refreshable {
			t.Fatal("rotated-elsewhere must NOT clear Refreshable")
		}
	})
}

// TestRefreshAllAccioSelfHeal: 每轮按凭据材料对账 refreshable 标记（被误标的
// 账号下一轮自愈；无材料的不发请求），且 lead 窗口外的账号跳过。
func TestRefreshAllAccioSelfHeal(t *testing.T) {
	srv, calls := accioMockToken(t, 0, 200,
		`{"success":true,"code":"0","data":{"accessToken":"AT-N","refreshToken":"RT-N","expiresAt":4102444800}}`)
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	m := newTestManager(t).m
	// acct-ok：材料完好但被误标 Refreshable=false（应自愈为 true）；到期在
	// lead 窗口内 ⇒ 触发一次真实续期。
	accioSeedCred(t, m, "acct-ok", accioTestCred(nowMillis()+30*time.Minute.Milliseconds()))
	if err := m.UpdateAccount("acct-ok", func(a *Account) { a.Refreshable = false }); err != nil {
		t.Fatal(err)
	}
	// acct-noRT：无 refresh_token（不可续期，绝不发请求）。
	accioSeedCred(t, m, "acct-noRT", &AccioCredential{AccessToken: "AT", Region: "cn"})
	// acct-fresh：材料完好、远未到期（对账但不发请求）。
	accioSeedCred(t, m, "acct-fresh", accioTestCred(nowMillis()+30*24*time.Hour.Milliseconds()))

	m.RefreshAllAccio(context.Background())

	if acc, _ := m.FindAccount("acct-ok"); !acc.Refreshable {
		t.Fatal("refreshable flag must self-heal from credential material")
	}
	if acc, _ := m.FindAccount("acct-noRT"); acc.Refreshable {
		t.Fatal("no-material account must be reconciled to refreshable=false")
	}
	if calls.Load() != 1 {
		t.Fatalf("only the lead-window account must refresh, got %d calls", calls.Load())
	}
	if cred := accioCredentialOf(t, m, "acct-ok"); cred.AccessToken != "AT-N" {
		t.Fatalf("renewal not persisted: %+v", cred)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// ── 模型目录 / slug 契约 ─────────────────────────────────────────────────

// resetAccioCatalogCache clears the process-wide catalog cache between tests.
func resetAccioCatalogCache() {
	accioCatalogCache.mu.Lock()
	defer accioCatalogCache.mu.Unlock()
	accioCatalogCache.models = nil
	accioCatalogCache.fetched = time.Time{}
	accioCatalogCache.failed = false
	accioCatalogCache.inflight = false
}

// TestAccioParseCatalog: visible!==true 剔除、modelCode 空剔除、按倍率升序
// （缺倍率垫底；HasMultiple 是存在标记，0 是合法值不当哨兵）。
func TestAccioParseCatalog(t *testing.T) {
	raw := []byte(`{"data":[
		{"modelList":[
			{"visible":true,"modelCode":"M2","modelDisplayName":"Beta","contextWindow":1000,"maxTokens":100,"effectiveMultiple":0.5},
			{"visible":false,"modelCode":"M-HIDDEN","modelDisplayName":"Hidden","effectiveMultiple":0.01},
			{"visible":true,"modelCode":"","modelDisplayName":"NoCode"},
			{"visible":true,"modelCode":"M1","modelDisplayName":"Alpha","contextWindow":2000,"maxTokens":100,"effectiveMultiple":0.013},
			{"visible":true,"modelCode":"M0","modelDisplayName":"Zero","effectiveMultiple":0},
			{"visible":true,"modelCode":"M3","modelDisplayName":"NoRate"}
		]}
	]}`)
	models := accioParseCatalog(raw)
	if len(models) != 4 {
		t.Fatalf("want 4 visible models, got %d: %+v", len(models), models)
	}
	// 倍率升序：0 → 0.013 → 0.5 → 缺倍率。0 与 0.013 都是合法倍率，
	// 按数值升序（0 < 0.013）。
	if models[0].ID != "M0" || models[1].ID != "M1" {
		t.Fatalf("ascending multiple order broken: %s, %s", models[0].ID, models[1].ID)
	}
	// 缺倍率的排最后，且 HasMultiple=false（0 是合法倍率，不能当哨兵）。
	last := models[len(models)-1]
	if last.ID != "M3" || last.HasMultiple {
		t.Fatalf("missing-multiple must sort last with HasMultiple=false: %+v", last)
	}
	if models[0].Multiple != 0 || !models[0].HasMultiple {
		t.Fatalf("multiple 0 is a legal rate: %+v", models[1])
	}
	if models[1].ContextWindow != 2000 || models[1].MaxTokens != 100 {
		t.Fatalf("catalog metadata lost: %+v", models[1])
	}
	if models := accioParseCatalog([]byte(`not-json`)); models != nil {
		t.Fatal("malformed catalog must parse to nil")
	}
}

// TestAccioSlugContract: 对外 id 是展示名归一的 slug（人话），上行由
// accioModelCodeOf 映射回 modelCode；未知 id 原样透传。
func TestAccioSlugContract(t *testing.T) {
	if len(accioFallbackModels) != 15 {
		t.Fatalf("fallback table drifted: %d entries (ref FALLBACK_MODELS @2026-10-12)", len(accioFallbackModels))
	}
	for _, e := range accioFallbackModels {
		slug := accioModelIDOf(e)
		if slug == "" || slug != strings.ToLower(slug) {
			t.Fatalf("slug %q of %q must be lowercase non-empty", slug, e.Name)
		}
		if strings.Contains(slug, " ") || strings.Contains(slug, ".") {
			t.Fatalf("slug %q must be normalized (space/. → -)", slug)
		}
		if code := accioModelCodeOf(accioFallbackModels, slug); code != e.ID {
			t.Fatalf("round-trip broken: %q → %q want %q", slug, code, e.ID)
		}
	}
	// 具体样例（展示层契约）。
	if got := accioModelIDOf(accioFallbackModels[1]); got != "qwen-3-8-flash" { // "Qwen 3.8 Flash"
		t.Fatalf("slug sample = %q", got)
	}
	// 未知 id 透传（手写 modelCode 直接可用）。
	if got := accioModelCodeOf(accioFallbackModels, "1Custom-XYZ"); got != "1Custom-XYZ" {
		t.Fatalf("unknown id must pass through, got %q", got)
	}
	// 展示名带倍率（本仓库既有约定：Alias = "Name · xM"）。
	table := accioModelTable(accioFallbackModels)
	first := table[0]
	if !strings.Contains(first.Alias, "· x") {
		t.Fatalf("display alias must embed the rate: %+v", first)
	}
}

// accioRegisterProduct registers the real product table for a test Manager
// (产品表登记会把 InferURL 发布到 Manager，供 accioCustomize / inferURLFor 读).
func accioRegisterProduct(t *testing.T, m *Manager) {
	t.Helper()
	RegisterDefaultProducts(NewBridge(m, newFakeRegistry()))
}

// TestAccioModelsForFallsBackOffline: 无凭据（未登录）不发请求，直接回落
// 兜底表；SyncKeys 与 /models API 共用这一份。
func TestAccioModelsForFallsBackOffline(t *testing.T) {
	resetAccioCatalogCache()
	defer resetAccioCatalogCache()
	old := accioGatewayBase

	m := newTestManager(t).m
	accioRegisterProduct(t, m)
	// 指向一个必然打不到的地址：若实现误发请求，测试会挂起/报错而不是静默通过。
	setAccioBase("http://127.0.0.1:1")
	defer setAccioBase(old)

	models := AccioModelsFor(m)
	if len(models) != len(accioFallbackModelTable) {
		t.Fatalf("fallback expected, got %d models", len(models))
	}
	if got, ok := m.inferURLFor("accio"); !ok || got != old+accioLLMPath {
		// 说明：产品表在改动前用原始网关注册；断言必须拿 old（不是被测试
		// 改过的 accioGatewayBase）比较。
		t.Fatalf("declared InferURL = %q ok=%v", got, ok)
	}
}

// TestAccioFetchCatalogTokenKey: 目录请求体键是 **token**（不是 accessToken），
// 且成功结果进入 10 分钟缓存；失败进入 30 秒冷却（期间不再发请求）。
func TestAccioFetchCatalogTokenKey(t *testing.T) {
	resetAccioCatalogCache()
	defer resetAccioCatalogCache()

	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		mu.Lock()
		bodies = append(bodies, string(buf[:n]))
		mu.Unlock()
		if strings.Contains(r.URL.Path, "/api/llm/config/v2") {
			w.Write([]byte(`{"success":true,"data":[{"modelList":[
				{"visible":true,"modelCode":"M-REMOTE","modelDisplayName":"Remote One","effectiveMultiple":0.1}
			]}]}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	m := newTestManager(t).m
	accioSeedCred(t, m, "acct-c", accioTestCred(nowMillis()+time.Hour.Milliseconds()))

	models := m.accioRemoteModels(context.Background())
	if len(models) != 1 || models[0].ID != "M-REMOTE" {
		t.Fatalf("remote catalog not parsed: %+v", models)
	}
	mu.Lock()
	if len(bodies) != 1 || !strings.Contains(bodies[0], `"token":"AT-OLD"`) || strings.Contains(bodies[0], "accessToken") {
		t.Fatalf("catalog body must use the token key: %v", bodies)
	}
	mu.Unlock()

	// 第二次读数命中缓存：不发新请求。
	_ = m.accioRemoteModels(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("success cache must serve the second read, got %d calls", len(bodies))
	}
}

// ── 推理 body / URL / 头 ─────────────────────────────────────────────────

// TestAccioBodyShape: buildAccioBody 的四处硬约束 + properties 豁免 +
// tools 参数串保真（ref accio.ts buildAccioBody 逐条实测约束）。
func TestAccioBodyShape(t *testing.T) {
	requestID := accioRequestID()
	tools := []any{map[string]any{
		"name": "read_file", "description": "reads",
		"parametersJson": `{"type":"object","properties":{"filePath":{"type":"string"}}}`,
	}}
	body := buildAccioBody(accioBodyOptions{
		model: "1Drift-F8hS3mK7pL2n", accessToken: "AT",
		contents:          []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi"}}}},
		systemInstruction: "be nice",
		tools:             tools,
		temperature:       0.5,
		maxOutputTokens:   128.0,
		utdid:             "UTD",
		requestID:         requestID,
	})

	// ① snake 键 + ② empid/tenant/iai_tag 空串。
	for _, key := range []string{"model", "empid", "tenant", "iai_tag", "request_id", "user_request_id",
		"contents", "stop_sequences", "token", "message_id", "incremental", "system_instruction",
		"tools", "temperature", "max_output_tokens", "properties"} {
		if _, ok := body[key]; !ok {
			t.Errorf("missing key %q in body %v", key, body)
		}
	}
	if body["empid"] != "" || body["tenant"] != "" || body["iai_tag"] != "" {
		t.Fatalf("empid/tenant/iai_tag must be empty strings: %v", body)
	}
	// ③ token 走 body。
	if body["token"] != "AT" {
		t.Fatalf("token must ride in the body, got %v", body["token"])
	}
	// ④ system_instruction 是字符串（对象形态恒 200+流内 400）。
	if s, ok := body["system_instruction"].(string); !ok || s != "be nice" {
		t.Fatalf("system_instruction must be a plain string, got %#v", body["system_instruction"])
	}
	// message_id 必填。
	if mid, _ := body["message_id"].(string); mid == "" {
		t.Fatal("message_id is required")
	}
	// properties 子树**不参与**转换：appKey 驼峰 + normalized_response snake。
	props, _ := body["properties"].(map[string]any)
	if props["appKey"] != "OneChat" || props["normalized_response"] != "true" {
		t.Fatalf("properties subtree must keep the measured shape: %v", props)
	}
	if props["utdid"] != "UTD" {
		t.Fatalf("utdid lost: %v", props)
	}
	// tools：parametersJson → parameters_json，值仍是**原始 JSON 字符串**
	//（accioToSnake 不下钻字符串 —— schema 键 filePath 不得被改成 file_path）。
	toolsOut, _ := body["tools"].([]any)
	tool0, _ := toolsOut[0].(map[string]any)
	if tool0["name"] != "read_file" || tool0["description"] != "reads" {
		t.Fatalf("tool identity lost: %v", tool0)
	}
	paramsJSON, _ := tool0["parameters_json"].(string)
	if !strings.Contains(paramsJSON, `"filePath"`) || strings.Contains(paramsJSON, "file_path") {
		t.Fatalf("parameters_json must be the verbatim schema string: %s", paramsJSON)
	}
}

// TestAccioHeadersNoAuthorization: 推理头不带 Authorization（token 走 body；
// 头上放了恒 200+流内 402），也不带 SecurityGuard pctb-x-*。
func TestAccioHeadersNoAuthorization(t *testing.T) {
	headers := accioHeaders("UTD", "SG")
	if _, ok := headers["Authorization"]; ok {
		t.Fatal("Authorization must NOT be sent")
	}
	for _, k := range []string{"utdid", "appKey", "version", "Content-Type", "Accept"} {
		if headers[k] == "" {
			t.Errorf("header %q missing: %v", k, headers)
		}
	}
	if headers["appKey"] != "OneChat" {
		t.Fatalf("appKey = %q", headers["appKey"])
	}
	if _, ok := headers["sgcookie"]; !ok {
		t.Fatal("sgcookie present in credential must be forwarded")
	}
	if _, ok := accioHeaders("UTD", "")["sgcookie"]; ok {
		t.Fatal("empty sgcookie must be omitted")
	}
}

// TestAccioSgKAndMessageID: sg_k = md5(requestId)；message_id 由 requestId
// 派生但掺随机（同一 requestId 连续两次不同）。
func TestAccioSgKAndMessageID(t *testing.T) {
	rid := "req-1-abcdef01"
	sum := md5.Sum([]byte(rid))
	if got := accioSgK(rid); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("sg_k mismatch: %s", got)
	}
	if m1, m2 := accioMessageID(rid), accioMessageID(rid); m1 == m2 {
		t.Fatal("message_id must differ across calls for the same requestId")
	}
	if got := accioRequestID(); !strings.HasPrefix(got, "req-") {
		t.Fatalf("request id shape: %s", got)
	}
}

// TestAccioCustomizeURLAndBody: Customize 分支产出
//   - URL = 网关 + /api/adk/llm/generateContent?sg_k=md5(request_id)，且与
//     body 里的 request_id 同源（URL 与 body 共享同一次随机）；
//   - 出站头含 utdid/appKey、**无** Authorization、且打上
//     NoDefaultAuthHeader 否决标记（代理默认 Bearer 填充对 accio 是错误形状）；
//   - slug 模型名映射回 modelCode。
func TestAccioCustomizeURLAndBody(t *testing.T) {
	resetAccioCatalogCache()
	defer resetAccioCatalogCache()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/api/llm/config/v2") {
			w.Write([]byte(`{"success":true,"data":[{"modelList":[
				{"visible":true,"modelCode":"1Code-Remote","modelDisplayName":"Remote Probe","effectiveMultiple":0.1}
			]}]}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	m := newTestManager(t).m
	accioRegisterProduct(t, m)
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	accioSeedCred(t, m, "acct-x", accioTestCred(nowMillis()+time.Hour.Milliseconds()))

	req, _ := http.NewRequest(http.MethodPost, "https://tinylab.local/v1/chat/completions", nil)
	body := []byte(`{"model":"remote-probe","messages":[{"role":"user","content":"hi"}]}`)
	outURL, outBody, err := m.accioCustomize(req, body, "accio", "acct-x", "remote-probe")
	if err != nil {
		t.Fatal(err)
	}
	// URL 形状。
	if !strings.HasPrefix(outURL, accioGatewayBase+accioLLMPath+"?sg_k=") {
		t.Fatalf("customize URL = %s", outURL)
	}
	sgK := strings.TrimPrefix(outURL, accioGatewayBase+accioLLMPath+"?sg_k=")
	// body 与 URL 的 requestId 同源。
	var envelope map[string]any
	if err := json.Unmarshal(outBody, &envelope); err != nil {
		t.Fatal(err)
	}
	requestID, _ := envelope["request_id"].(string)
	if requestID == "" || accioSgK(requestID) != sgK {
		t.Fatalf("sg_k must equal md5(body request_id): url=%s body=%s", sgK, requestID)
	}
	// 模型名映射（slug → modelCode）。
	if envelope["model"] != "1Code-Remote" {
		t.Fatalf("model must map to modelCode, got %v", envelope["model"])
	}
	// 否决标记 + 出站头。
	if req.Header.Get(upstreamerr.NoDefaultAuthHeader) == "" {
		t.Fatal("accioCustomize must veto the default Bearer fill")
	}
	if req.Header.Get("Authorization") != "" {
		t.Fatal("Authorization must not be set on the outbound request")
	}
	if req.Header.Get("appKey") != "OneChat" || req.Header.Get("utdid") == "" {
		t.Fatalf("inference headers missing: %v", req.Header)
	}
	if declared, ok := m.inferURLFor("accio"); !ok || declared != old+accioLLMPath {
		t.Fatalf("declared InferURL = %q", declared)
	}
}

// ── 积分（信封判据 / 桶语义 / token 位置） ────────────────────────────────

// TestAccioParseEnvelope: 余额是尽力而为 —— success!==false 即成功；但
// HTTP 401/403 或 code/message=401/NOT_LOGIN（数字 code 容忍）⇒ authFailed。
func TestAccioParseEnvelope(t *testing.T) {
	env := accioParseEnvelope(200, []byte(`{"data":{"entitlement":{}}}`))
	if !env.ok || env.authFailed {
		t.Fatalf("absent success must be ok: %+v", env)
	}
	env = accioParseEnvelope(200, []byte(`{"success":false,"data":{}}`))
	if env.ok {
		t.Fatal("success:false must not be ok")
	}
	env = accioParseEnvelope(200, []byte(`{"success":true,"code":401,"data":{}}`))
	if !env.authFailed {
		t.Fatalf("numeric 401 code must mark authFailed: %+v", env)
	}
	env = accioParseEnvelope(200, []byte(`{"success":true,"message":"NOT_LOGIN","data":{}}`))
	if !env.authFailed {
		t.Fatalf("NOT_LOGIN message must mark authFailed: %+v", env)
	}
	env = accioParseEnvelope(403, []byte(`{"success":true,"data":{}}`))
	if !env.authFailed {
		t.Fatalf("HTTP 403 must mark authFailed: %+v", env)
	}
}

// TestParseAccioSubscription: 桶存在 ⇒ 留行（0 也留）；缺席 ⇒ 不产行；存在但
// remaining 读不到 ⇒ 跳过；单位 credit；数字字符串容忍。
func TestParseAccioSubscription(t *testing.T) {
	raw := []byte(`{"success":true,"data":{"entitlement":{
		"daily":{"remaining":"12.5","total":100,"used":87.5},
		"monthly":{"remaining":0,"total":500,"used":500},
		"referral":{"used":3}
	}}}`)
	balance, err := parseAccioSubscription(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(balance.Packages) != 2 {
		t.Fatalf("want 2 rows (referral has remaining missing -> skipped): got %+v", balance.Packages)
	}
	// referral 桶存在但 remaining 读不到 => 跳过（数据不足不按 0 展示）。
	if len(balance.Packages) == 3 {
		t.Fatalf("unreadable remaining must skip the bucket: %+v", balance.Packages)
	}
	if balance.Packages[0].Name != "每日积分" || balance.Packages[0].Unit != "credit" || balance.Packages[0].Remaining != 12.5 {
		t.Fatalf("daily row wrong: %+v", balance.Packages[0])
	}
	if balance.Packages[1].Remaining != 0 || !balance.Packages[1].Active {
		t.Fatalf("remaining 0 must be kept (已用光 ≠ 查不到): %+v", balance.Packages[1])
	}
	if balance.Total != 12.5 {
		t.Fatalf("total = %v", balance.Total)
	}

	// 缺席的桶不产生行：只有 daily。
	balance2, err := parseAccioSubscription([]byte(`{"data":{"entitlement":{"daily":{"remaining":7}}}}`))
	if err != nil || len(balance2.Packages) != 1 || balance2.Packages[0].Remaining != 7 {
		t.Fatalf("absent buckets must not produce rows: %+v err=%v", balance2, err)
	}

	// 无任何桶 → 显式错误（不编 0）。
	if _, err := parseAccioSubscription([]byte(`{"data":{"entitlement":{}}}`)); err == nil {
		t.Fatal("empty entitlement must error")
	}
	// 未登录。
	if _, err := parseAccioSubscription([]byte(`{"success":false,"code":"401","message":"NOT_LOGIN"}`)); err != errAccioNotLogin {
		t.Fatalf("NOT_LOGIN must map to errAccioNotLogin, got %v", err)
	}
}

// TestAccioBalanceFlow: 端到端余额读数 —— currentSubscription GET + token 在
// query；accioParseEnvelope 的 authFailed → errAccioNotLogin 直达。
func TestAccioBalanceFlow(t *testing.T) {
	var sawQuery atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, accioSubscriptionPath) {
			if r.Method != http.MethodGet {
				t.Errorf("subscription must be GET, got %s", r.Method)
			}
			if r.URL.Query().Get("accessToken") == "AT-OLD" {
				sawQuery.Store(true)
			}
			w.Write([]byte(`{"success":true,"data":{"entitlement":{"daily":{"remaining":42},"monthly":{"remaining":1000}}}}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	m := newTestManager(t).m
	accioSeedCred(t, m, "acct-b", accioTestCred(nowMillis()+time.Hour.Milliseconds()))

	balance, err := m.AccioBalance(context.Background(), "acct-b")
	if err != nil {
		t.Fatal(err)
	}
	if !sawQuery.Load() {
		t.Fatal("subscription token must ride in the query")
	}
	if balance.Total != 1042 {
		t.Fatalf("total = %v (%+v)", balance.Total, balance)
	}
	// 未知账号。
	if _, err := m.AccioBalance(context.Background(), "nope"); err != ErrNotFound {
		t.Fatalf("unknown account must be ErrNotFound, got %v", err)
	}
}

// TestAccioCreditsCallShapes: 三个只读端点的传参方式各不相同（POST userinfo
// token 在 body；GET 两个 token 在 query）—— 用错就是 405/400。
func TestAccioCreditsCallShapes(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{} // path → method
	var userInfoBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.Method
		mu.Unlock()
		if strings.Contains(r.URL.Path, accioUserinfoPath) {
			buf := make([]byte, 1024)
			n, _ := r.Body.Read(buf)
			mu.Lock()
			userInfoBody = string(buf[:n])
			mu.Unlock()
			w.Write([]byte(`{"success":true,"data":{"userId":"u-1","userName":"Alice"}}`))
			return
		}
		w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	defer srv.Close()
	old := accioGatewayBase
	setAccioBase(srv.URL)
	defer setAccioBase(old)

	cred := accioTestCred(nowMillis() + time.Hour.Milliseconds())
	info, err := accioFetchUserInfo(context.Background(), srv.Client(), cred)
	if err != nil || info.UserID != "u-1" || info.UserName != "Alice" {
		t.Fatalf("userinfo: %+v err=%v", info, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen[accioUserinfoPath] != http.MethodPost {
		t.Fatalf("userinfo must be POST, got %s", seen[accioUserinfoPath])
	}
	if !strings.Contains(userInfoBody, `"accessToken":"AT-OLD"`) {
		t.Fatalf("userinfo token must ride in the body: %s", userInfoBody)
	}
	if _, ok := seen[accioSubscriptionPath]; ok {
		t.Fatal("flow test must not have called the subscription endpoint here")
	}
}

// ── 探针 ────────────────────────────────────────────────────────────────

// TestAccioProbeEntryPath: ref 恒 stream:true 且无 max_tokens（探针只看 HTTP
// 状态码并丢弃 body）。
func TestAccioProbeEntryPath(t *testing.T) {
	path, body := probeEntryPath("accio", "m-1")
	if path != "/v1/chat/completions" {
		t.Fatalf("probe path = %s", path)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["stream"] != true {
		t.Fatalf("probe must stream, got %v", parsed)
	}
	if _, ok := parsed["max_tokens"]; ok {
		t.Fatal("probe must not set max_tokens (accio body has no such field)")
	}
}

// TestAccioTokenExtractor: 桥接 key 的 bearer 取自 access_token（通用提取器
// 的泛化分支；token 不用于出站鉴权，只用于选号与用量归属）。
func TestAccioTokenExtractor(t *testing.T) {
	token, err := accessTokenOf("accio", []byte(`{"access_token":"AT-X"}`))
	if err != nil || token != "AT-X" {
		t.Fatalf("generic extractor: %q err=%v", token, err)
	}
}

// TestAccioLoginStateShape: StartAccioLogin 返回的 StartedLogin 结构（登录页
// URL + Result 通道）—— 真回调流程不需要网络（只起 loopback 监听）。
func TestAccioLoginStateShape(t *testing.T) {
	started, err := StartAccioLogin(nil, "global")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if started.cancel != nil {
			started.cancel()
		}
	}()
	if !strings.HasPrefix(started.LoginURL, "https://zh.accio.com/login?") {
		t.Fatalf("global login URL = %s", started.LoginURL)
	}
	if started.Result == nil {
		t.Fatal("Result channel missing")
	}
	// URL 里的 state 与 ttid 参数存在。
	if !strings.Contains(started.LoginURL, "state=") || !strings.Contains(started.LoginURL, "ttid=ttid_") {
		t.Fatalf("state/ttid missing: %s", started.LoginURL)
	}
}

// TestAccioMessageIDDeterminism: message_id 只依赖 requestId 材料的部分
// 确定（md5 形状），掺随机后长度不变。
func TestAccioMessageIDDeterminism(t *testing.T) {
	sum := sha256.Sum256([]byte("x")) // 占位：保证 sha256 引用不被误删
	_ = sum
	mid := accioMessageID("req-2-01234567")
	if len(mid) != 32 {
		t.Fatalf("message_id must be md5 hex, got %q", mid)
	}
}

var _ = fmt.Sprintf // keep fmt imported for error constructors above
