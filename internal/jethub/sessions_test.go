package jethub

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// TestSettleAndCleanupFailureDeletesPlaceholder covers the +new-account
// failure path: a flow that delivers an error (timeout / user cancel /
// upstream rejection) must delete the placeholder account, not leave a
// credential-less entry that renders as usable.
func TestSettleAndCleanupFailureDeletesPlaceholder(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("raccoon")
	if err := env.m.AddAccount(Account{ID: id, Provider: "raccoon", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-failed", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)

	// The status poll must see done:false until the outcome arrives.
	if done, _, _ := SessionStatus(sess); done {
		t.Fatal("session reported settled before the outcome was delivered")
	}
	resultCh <- LoginOutcome{Err: errors.New("扫码登录超时")}

	waitFor(t, 2*time.Second, func() bool {
		_, ok := FindTestAccount(env.m, id)
		return !ok
	})
	// ⚠️ The session stays observable through the grace period (the UI poll
	// must be able to read the outcome), so it is NOT reaped immediately.
	if _, still := PeekLoginSession(sess.Key); !still {
		t.Fatal("session reaped before the UI could observe the outcome")
	}
	done, success, msg := SessionStatus(sess)
	if !done || success || msg != "扫码登录超时" {
		t.Fatalf("status after failure = (%v, %v, %q), want (true, false, 扫码登录超时)", done, success, msg)
	}
}

// TestSettleAndCleanupSuccessKeepsAccount: a delivered credential with a nil
// completer must keep the account (the flow persisted it internally) and
// record a successful settle.
func TestSettleAndCleanupSuccessKeepsAccount(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("cline")
	if err := env.m.AddAccount(Account{ID: id, Provider: "cline", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-ok", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)
	resultCh <- LoginOutcome{CredentialJSON: []byte(`{"access_token":"a"}`), ExpiresAt: 123}

	waitFor(t, 2*time.Second, func() bool {
		done, _, _ := SessionStatus(sess)
		return done
	})
	if _, ok := FindTestAccount(env.m, id); !ok {
		t.Fatal("successful flow deleted the account")
	}
	// The session stays observable through the grace period (not reaped yet).
	if _, still := PeekLoginSession(sess.Key); !still {
		t.Fatal("session reaped before the UI could observe the outcome")
	}
	if done, success, _ := SessionStatus(sess); !done || !success {
		t.Fatalf("status after success = (%v, %v), want (true, true)", done, success)
	}
}

// TestSettleAndCleanupCompleteErrorDeletes: when the provider-specific
// persistence callback fails, the placeholder is removed too (an account
// whose credential could not be stored is unusable).
func TestSettleAndCleanupCompleteErrorDeletes(t *testing.T) {
	env := newTestManager(t)
	id, _ := NewAccountID("buddy")
	if err := env.m.AddAccount(Account{ID: id, Provider: "buddy", Nickname: id, Enabled: true, CredentialRef: "X"}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{
		Key: "test-cpl", Account: id, Manager: env.m,
		Started: NewStartedLoginWithChannel("https://example.com/login", resultCh),
	}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, func(LoginOutcome) error { return errors.New("persist failed") })
	resultCh <- LoginOutcome{CredentialJSON: []byte(`{}`)}

	waitFor(t, 2*time.Second, func() bool {
		_, ok := FindTestAccount(env.m, id)
		return !ok
	})
}

// TestSessionStatusUnsettled: a fresh session reports not-done with empty
// fields (the UI poll's "still waiting" branch).
func TestSessionStatusUnsettled(t *testing.T) {
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{Started: NewStartedLoginWithChannel("u", resultCh)}
	if done, success, msg := SessionStatus(sess); done || success || msg != "" {
		t.Fatalf("fresh session = (%v,%v,%q), want all zero", done, success, msg)
	}
}

// TestSessionReapedAfterGrace: the settled session stays in the registry for
// the UI poll's grace period, then is reaped (real defect: immediate reap
// made the 2s poller 404 and the dialog never observed done:true).
func TestSessionReapedAfterGrace(t *testing.T) {
	resultCh := make(chan LoginOutcome, 1)
	sess := &LoginSession{Key: "test-grace", Started: NewStartedLoginWithChannel("u", resultCh)}
	RegisterLoginSession(sess.Key, sess)
	go SettleAndCleanup(sess, nil)
	resultCh <- LoginOutcome{Err: errors.New("x")}

	// Immediately after settle: still observable.
	waitFor(t, 2*time.Second, func() bool {
		_, _, _ = SessionStatus(sess)
		return func() bool { _, ok := PeekLoginSession(sess.Key); return ok }()
	})
	if _, ok := PeekLoginSession(sess.Key); !ok {
		t.Fatal("session reaped before the grace period elapsed")
	}
	// After the grace period: reaped.
	waitFor(t, loginSessionGracePeriod+2*time.Second, func() bool {
		_, ok := PeekLoginSession(sess.Key)
		return !ok
	})
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not reached within deadline")
}

// FindTestAccount is a test-only alias of Manager.FindAccount.
func FindTestAccount(m *Manager, id string) (Account, bool) { return m.FindAccount(id) }

// TestSetProxyURLRewiresOutboundClient: SetProxyURL must make the manager's
// proxy-routed client send through the proxy (real defect: a machine reaching
// the upstreams only through the local routing proxy got TLS handshake
// timeouts because the Go client dialed direct).
func TestSetProxyURLRewiresOutboundClient(t *testing.T) {
	env := newTestManager(t)

	if err := env.m.SetProxyURL(""); err != nil {
		t.Fatal(err)
	}
	if err := env.m.SetProxyURL("http://127.0.0.1:2080"); err != nil {
		t.Fatal(err)
	}
	// The toggle routes cline through the proxy pair.
	if err := env.m.SetProxyEnabled("cline", true); err != nil {
		t.Fatal(err)
	}

	// The proxy-routed client must actually send requests through the proxy:
	// an httptest server acts as the proxy endpoint; if the request arrives
	// there, the transport honors the proxy URL.
	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.String() // absolute-form for proxied requests
		w.WriteHeader(200)
	}))
	defer srv.Close()

	proxyURL, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	env.m.mu.Lock()
	env.m.proxyURL = proxyURL
	env.m.sharedClients = jethubClients{proxy: &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}}
	env.m.mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, "http://target.example.com/ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := env.m.httpClient("cline").Do(req)
	if err != nil {
		t.Fatalf("proxied request failed: %v", err)
	}
	resp.Body.Close()
	if seenPath != "http://target.example.com/ping" {
		t.Fatalf("proxy saw %q, want absolute-form target URL", seenPath)
	}
}

// TestProxyTogglePicksClient: the per-provider Use Proxy toggle decides
// between the direct and the proxy-routed client, and the setting persists.
func TestProxyTogglePicksClient(t *testing.T) {
	env := newTestManager(t)
	if env.m.ProxyEnabled("cline") {
		t.Fatal("default must be direct")
	}
	// Without a global proxy URL the toggle-on degrades to direct (nothing to
	// route through) — configure one first so the proxy pair is a real client.
	if err := env.m.SetProxyURL("http://127.0.0.1:2080"); err != nil {
		t.Fatal(err)
	}
	direct := env.m.httpClient("cline")

	// Toggle cline on: the client must change (proxy-routed pair).
	if err := env.m.SetProxyEnabled("cline", true); err != nil {
		t.Fatal(err)
	}
	if !env.m.ProxyEnabled("cline") {
		t.Fatal("toggle not persisted in memory")
	}
	routed := env.m.httpClient("cline")
	if direct == routed {
		t.Fatal("proxy-enabled provider must get the proxy client")
	}
	// qoder (toggle off) still gets the direct client.
	if env.m.httpClient("qoder") != direct {
		t.Fatal("toggle-off provider must keep the direct client")
	}

	// Persisted across a reload (NewManager over the same dir).
	reloaded, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.ProxyEnabled("cline") {
		t.Fatal("proxy toggle must persist across reload")
	}
}
