package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// --- R1-2: 续期判据 / 镜像对账 / 串行 / 终态（ref cf5edab） ---

// seedCodeArtsAccount adds one codearts account with the given credential and
// returns its account id.
func seedCodeArtsAccount(t *testing.T, m *Manager, cred *CodeArtsCredential, refreshable bool) string {
	t.Helper()
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cred)
	if err := m.SetCredential("codearts", ref, raw, codeartsCredentialExpiresAt(cred), refreshable); err != nil {
		t.Fatal(err)
	}
	return id
}

// refreshableCodeArtsCred builds a credential with a complete renewal kit that
// expires in 30 minutes (inside the 1h lead window).
func refreshableCodeArtsCred(t *testing.T) *CodeArtsCredential {
	t.Helper()
	jwk, err := GenerateDpopKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	return &CodeArtsCredential{
		AccessKeyID: "AK1", SecretAccessKey: "SK1", SecurityToken: "ST1",
		ExpiresAt:    time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
		RefreshToken: "RT1", CodeVerifier: "CV1", DpopPrivateJwk: &jwk,
	}
}

// withSTS points the package-level STS endpoint at a mock for the test.
func withSTS(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	old := codeartsSTSURL
	setSTSURL(srv.URL)
	t.Cleanup(func() { setSTSURL(old) })
	return srv
}

// TestCodeartsShouldRefreshNow: 未知到期 ⇒ 立即（ref shouldRefreshNow 语义）；
// 窗口内 ⇒ 是；窗口外 ⇒ 否。
func TestCodeartsShouldRefreshNow(t *testing.T) {
	now := nowMillis()
	if !codeartsShouldRefreshNow(&CodeArtsCredential{}, now) {
		t.Fatal("unknown expiry must mean refresh now (ref shouldRefreshNow)")
	}
	soon := time.UnixMilli(now + 30*60*1000).UTC().Format(time.RFC3339)
	if !codeartsShouldRefreshNow(&CodeArtsCredential{ExpiresAt: soon}, now) {
		t.Fatal("expiry inside the 1h lead must refresh")
	}
	far := time.UnixMilli(now + 3*3600*1000).UTC().Format(time.RFC3339)
	if codeartsShouldRefreshNow(&CodeArtsCredential{ExpiresAt: far}, now) {
		t.Fatal("expiry outside the lead must NOT refresh")
	}
}

// TestRefreshAllCodeArtsSelfHealsMisflagged: 池里 refreshable=false 但凭据材料
// 齐全（被误标）⇒ 调度轮必须照常续期并自愈为 true（ref cf5edab 第 1 条：拿
// refreshable 当单向门会让账号永不进入续期循环，重启也没用）。
func TestRefreshAllCodeArtsSelfHealsMisflagged(t *testing.T) {
	m := newTestManager(t).m
	id := seedCodeArtsAccount(t, m, refreshableCodeArtsCred(t), false)

	var mu sync.Mutex
	requests := 0
	withSTS(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.Write([]byte(`{"credentials":{"access_key_id":"AK2","secret_access_key":"SK2","security_token":"ST2","expiration":"2030-01-01T00:00:00Z"},"refresh_token":"RT2"}`))
	})

	m.RefreshAllCodeArts(ctxBackground())

	mu.Lock()
	got := requests
	mu.Unlock()
	if got != 1 {
		t.Fatalf("misflagged account must be refreshed exactly once, got %d requests", got)
	}
	acc, ok := m.FindAccount(id)
	if !ok {
		t.Fatal("account vanished")
	}
	if !acc.Refreshable {
		t.Fatal("refreshable must self-heal to true after a successful renewal")
	}
}

// TestRefreshAllCodeArtsSkipsFreshCredential: 到期还早 ⇒ 不发请求（不烧一次性
// refresh_token）。
func TestRefreshAllCodeArtsSkipsFreshCredential(t *testing.T) {
	m := newTestManager(t).m
	cred := refreshableCodeArtsCred(t)
	cred.ExpiresAt = time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	seedCodeArtsAccount(t, m, cred, true)

	requests := 0
	withSTS(t, func(w http.ResponseWriter, r *http.Request) { requests++ })

	m.RefreshAllCodeArts(ctxBackground())
	if requests != 0 {
		t.Fatalf("fresh credential must not be renewed, got %d requests", requests)
	}
}

// TestRefreshAllCodeArtsMarksNonRefreshableWhenMaterialMissing: 材料缺失 ⇒ 只做
// 镜像对账（refreshable=false），不发任何请求。
func TestRefreshAllCodeArtsMarksNonRefreshableWhenMaterialMissing(t *testing.T) {
	m := newTestManager(t).m
	cred := &CodeArtsCredential{AccessKeyID: "AK", SecretAccessKey: "SK", SecurityToken: "ST", ExpiresAt: "2030-01-01T00:00:00Z"}
	id := seedCodeArtsAccount(t, m, cred, true) // 误标成 true

	requests := 0
	withSTS(t, func(w http.ResponseWriter, r *http.Request) { requests++ })

	m.RefreshAllCodeArts(ctxBackground())
	if requests != 0 {
		t.Fatalf("missing renewal kit must not trigger a request, got %d", requests)
	}
	acc, _ := m.FindAccount(id)
	if acc.Refreshable {
		t.Fatal("missing renewal kit must reconcile refreshable=false")
	}
}

// TestRefreshCodeArtsConcurrentSameRefSingleRequest: 同一凭据并发续期只发一次
// 请求（STS 换新会作废旧 refresh_token；并发消费必然「1 成功 N invalid_grant」）。
func TestRefreshCodeArtsConcurrentSameRefSingleRequest(t *testing.T) {
	m := newTestManager(t).m
	id := seedCodeArtsAccount(t, m, refreshableCodeArtsCred(t), true)

	var mu sync.Mutex
	requests := 0
	withSTS(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		// 新 refresh_token + 远期到期 ⇒ 第二个调用者在锁内重读后应直接跳过。
		w.Write([]byte(`{"credentials":{"access_key_id":"AK2","secret_access_key":"SK2","security_token":"ST2","expiration":"2030-01-01T00:00:00Z"},"refresh_token":"RT2"}`))
	})

	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.RefreshCodeArtsAccount(ctxBackground(), id)
		}()
	}
	wg.Wait()

	mu.Lock()
	got := requests
	mu.Unlock()
	if got != 1 {
		t.Fatalf("concurrent renewals on the same credential must send exactly 1 request, got %d", got)
	}
}

// TestRefreshCodeArtsInvalidDPoPNotTerminal: InvalidDPoPHeader 不再当终态
// （ref cf5edab）：账号必须保持 refreshable，下一轮还会再试。
func TestRefreshCodeArtsInvalidDPoPNotTerminal(t *testing.T) {
	m := newTestManager(t).m
	id := seedCodeArtsAccount(t, m, refreshableCodeArtsCred(t), true)

	withSTS(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		// ⚠️ 不能带 error=invalid_grant —— 那本身就是终态判据（ref 同样如此）；
		// InvalidDPoPHeader 的真实形态是只有错误码（或 invalid_request + 该码）。
		w.Write([]byte(`{"error":"invalid_request","error_code":"InvalidDPoPHeader"}`))
	})

	err := m.RefreshCodeArtsAccount(ctxBackground(), id)
	if err == nil || err == ErrRefreshTokenExpired {
		t.Fatalf("InvalidDPoPHeader must be a transient failure, got %v", err)
	}
	acc, _ := m.FindAccount(id)
	if !acc.Refreshable {
		t.Fatal("a transient DPoP rejection must NOT mark the account non-refreshable")
	}
}

// TestRefreshCodeArtsTerminalKeepsCredential: 真终态（ExpiredRefreshToken）⇒ 标记
// refreshable=false，但**凭据本体不被损坏**（仍可读出 refresh_token 供人工排查）。
func TestRefreshCodeArtsTerminalKeepsCredential(t *testing.T) {
	m := newTestManager(t).m
	id := seedCodeArtsAccount(t, m, refreshableCodeArtsCred(t), true)

	withSTS(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant","error_code":"ExpiredRefreshToken"}`))
	})

	if err := m.RefreshCodeArtsAccount(ctxBackground(), id); err != ErrRefreshTokenExpired {
		t.Fatalf("ExpiredRefreshToken must be terminal, got %v", err)
	}
	acc, _ := m.FindAccount(id)
	if acc.Refreshable {
		t.Fatal("terminal failure must mark the account non-refreshable")
	}
	raw, ok := m.Credential("codearts", acc.CredentialRef)
	if !ok {
		t.Fatal("credential must survive a terminal refresh failure")
	}
	var cred CodeArtsCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		t.Fatal(err)
	}
	if cred.RefreshToken != "RT1" {
		t.Fatalf("credential body must be untouched on terminal failure, got refresh_token=%q", cred.RefreshToken)
	}
}

// --- R1-1: augmenter side of the drop-header retry ---

// TestCodeartsAugmentDropsBenefitHeaderOnRetry: 回环标记指名 maas_type 时，本次
// 尝试不得再签入/发送该头，且标记必须跨头部重写存活（拦截器据此判断「已试过」）。
func TestCodeartsAugmentDropsBenefitHeaderOnRetry(t *testing.T) {
	m := newAugmentTestManager(t)
	accID := firstCodeArtsAccount(t, m)
	req := httptest.NewRequest(http.MethodPost, "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", nil)
	req.Header.Set(upstreamerr.RetryDropHeaderMarker, "maas_type")

	if _, err := m.codeartsAugment(req, []byte(`{"model":"deepseek-v4.1-flash"}`), "jethub-codearts", accID, "deepseek-v4.1-flash"); err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("maas_type"); got != "" {
		t.Fatalf("maas_type must be omitted on the drop-header retry, got %q", got)
	}
	if auth := req.Header.Get("Authorization"); strings.Contains(auth, "maas_type") {
		t.Fatalf("SignedHeaders must not include maas_type on the retry: %q", auth)
	}
	if got := req.Header.Get(upstreamerr.RetryDropHeaderMarker); got != "maas_type" {
		t.Fatalf("loopback marker must survive the header rewrite, got %q", got)
	}
}

// --- R1-4: 输出上限收敛（ref 916c647/da0a2ad，R5 由 5334547 扩集合） ---

// TestCodeartsClampMaxTokens: 实测拒绝 128000 的模型收敛到 65536（两个字段
// 都管）；未超限与其它模型**字节级不变**。
//
// ⚠️ 模型集合必须与 codeartsCappedModel 一致：R5 加入了 glm-5.3-flash 与
// deepseek-v4.1-flash（ref 5334547 把网关的收敛集合扩到这两个）。反向验证：
// 把任一条目从 codeartsCappedModel 摘掉，本用例立刻变红。
func TestCodeartsClampMaxTokens(t *testing.T) {
	for _, model := range []string{
		"GLM-5.2", "deepseek-v4-flash", "deepseek-v4-pro",
		"glm-5.3-flash", "deepseek-v4.1-flash",
	} {
		for _, field := range []string{"max_tokens", "max_completion_tokens"} {
			in := []byte(`{"model":"x","` + field + `":128000}`)
			out := codeartsClampMaxTokens(in, model)
			var got map[string]any
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if got[field] != float64(codeartsMaxOutputCap) {
				t.Fatalf("%s %s = %v, want %d", model, field, got[field], codeartsMaxOutputCap)
			}
		}
	}
	for _, tc := range []struct{ model, body string }{
		{"GLM-5.2", `{"max_tokens":32768}`},
		{"GLM-5.1", `{"max_tokens":128000}`},
		{"GLM-5.3", `{"max_tokens":128000}`},
	} {
		if out := codeartsClampMaxTokens([]byte(tc.body), tc.model); string(out) != tc.body {
			t.Fatalf("%s %s must stay byte-identical, got %s", tc.model, tc.body, out)
		}
	}
}

// TestCodeartsAugmentClampsOutputBudget: augmenter 端到端地改写 body（GLM-5.2
// 128000 → 65536），并把新 body 交给签名/转发。
func TestCodeartsAugmentClampsOutputBudget(t *testing.T) {
	m := newAugmentTestManager(t)
	accID := firstCodeArtsAccount(t, m)
	req := httptest.NewRequest(http.MethodPost, "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions", nil)

	out, err := m.codeartsAugment(req, []byte(`{"max_tokens":128000}`), "jethub-codearts", accID, "GLM-5.2")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["max_tokens"] != float64(codeartsMaxOutputCap) {
		t.Fatalf("augmented body max_tokens = %v, want %d", got["max_tokens"], codeartsMaxOutputCap)
	}
}
