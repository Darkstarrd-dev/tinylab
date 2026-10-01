package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/download"
	"github.com/tinylab/tinylab/internal/jethub"
	"github.com/tinylab/tinylab/internal/proxy"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// setupProtectedJethubServer builds the real router with password protection
// ON and the Free Hub manager/bridge wired (like a protected deployment).
func setupProtectedJethubServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := config.DefaultConfig()
	key, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	enc, err := config.Encrypt(key, testAPIPassword)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Security = config.SecurityConfig{
		PasswordEnabled:   true,
		EncryptionKey:     key,
		PasswordEncrypted: enc,
	}
	reg := registry.New(cfg)
	logger := console.New(100)
	usageBuf := usage.New(100)
	selector := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	proxyHandler := proxy.New(reg, selector, comboRes, usageBuf, usage.NewQuotaTracker(), logger, 0)
	tmpFile := filepath.Join(t.TempDir(), "config.yaml")
	apiRouter := New(reg, cfg, tmpFile, usageBuf, usage.New(50), usage.NewQuotaTracker(), logger, proxyHandler, context.CancelFunc(func() {}), selector, comboRes, download.NewManager(download.RuntimeSettings{}, logger))

	mgr, err := jethub.NewManager(t.TempDir(), cfg.Security.EncryptionKey, logger)
	if err != nil {
		t.Fatal(err)
	}
	apiRouter.SetJetHub(mgr, jethub.NewBridge(mgr, reg))

	handler := apiRouter.Routes(proxyHandler)
	srv := httptest.NewServer(handler)
	t.Cleanup(func() { apiRouter.Cleanup() })
	alignServerPort(t, reg, srv)
	return srv
}

// TestFreeHubLoginPageIsPublicUnderPasswordProtection: the scan-login page is
// opened in the system default browser, which has NO management UI cookie —
// mounting its data endpoints inside the auth group would break every scan
// login for password-protected installs (a fresh form of the "cannot
// authenticate" defect). Protected routes must still reject anonymous calls.
func TestFreeHubLoginPageIsPublicUnderPasswordProtection(t *testing.T) {
	srv := setupProtectedJethubServer(t)

	// ① Protected: /api/jethub/providers stays auth-gated.
	resp, err := http.Get(srv.URL + "/api/jethub/providers")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /api/jethub/providers without a session = %d, want 401", resp.StatusCode)
	}

	// ② Public: the page endpoints reach their handler (404 = unknown loginId,
	// NOT 401 = stopped by the auth middleware).
	resp2, err := http.Get(srv.URL + "/api/jethub/login-page?loginId=does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	body := readBody(t, resp2)
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /api/jethub/login-page = %d (%s), want 404 from the handler (401 would mean the page is behind auth)",
			resp2.StatusCode, body)
	}
	if !strings.Contains(body, "unknown or settled loginId") {
		t.Fatalf("public page endpoint did not reach its handler: %s", body)
	}

	// ③ Same for the status poll.
	resp3, err := http.Get(srv.URL + "/api/jethub/login-page/status?loginId=does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /api/jethub/login-page/status = %d, want 404 from the handler", resp3.StatusCode)
	}

	// ④ The static page + QR encoder are public assets (the browser loads them
	// before it has any session).
	for _, asset := range []string{"/free-hub-login.html", "/raccoon-qr.js"} {
		r, err := http.Get(srv.URL + asset)
		if err != nil {
			t.Fatal(err)
		}
		code := r.StatusCode
		r.Body.Close()
		if code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200 (public static asset)", asset, code)
		}
	}
}

// TestFreeHubLoginPageServesRegisteredSession: with a live session the page
// payload carries the QR content and nothing else sensitive (no cookies
// needed) — the full public path end to end.
func TestFreeHubLoginPageServesRegisteredSession(t *testing.T) {
	srv := setupProtectedJethubServer(t)
	// Reuse the public route table through a direct manager session: the
	// manager instance behind the router is not reachable from here, so the
	// session is registered in the process-local registry instead (the router's
	// handler reads the same registry).
	ch := make(chan jethub.LoginOutcome, 1)
	qr := "https://xiaohuanxiong.com/login/mp?code=deadbeef&appname=test"
	sess := &jethub.LoginSession{
		Started: &jethub.StartedLogin{LoginURL: "http://127.0.0.1/free-hub-login.html", QRContent: qr, Result: ch},
		Account: "acc-public",
	}
	jethub.RegisterLoginSession("public-login-1", sess)

	resp, err := http.Get(srv.URL + "/api/jethub/login-page?loginId=public-login-1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw := readBody(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login-page = %d (%s), want 200", resp.StatusCode, raw)
	}
	var out struct {
		OK bool   `json:"ok"`
		QR string `json:"qr"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, raw)
	}
	if !out.OK || out.QR != qr {
		t.Fatalf("payload wrong: %s", raw)
	}
	if strings.Contains(raw, "acc-public") {
		t.Fatalf("the public payload must not expose the account id: %s", raw)
	}

	resp2, err := http.Get(srv.URL + "/api/jethub/login-page/status?loginId=public-login-1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	raw2 := readBody(t, resp2)
	if resp2.StatusCode != http.StatusOK || !strings.Contains(raw2, `"done":false`) {
		t.Fatalf("status = %d (%s), want pending", resp2.StatusCode, raw2)
	}
}
