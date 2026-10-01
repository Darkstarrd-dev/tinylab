package jethub

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// newPublicPageHandler mounts ONLY the public scan-login page routes, exactly
// as the real router does (outside the auth group).
func newPublicPageHandler(t *testing.T) (http.Handler, *corejethub.Manager) {
	t.Helper()
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	h := NewHandler(&Deps{Manager: m, Bridge: nil})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.RegisterPublicLoginPage(r) })
	return r, m
}

// registerQRLoginSession seeds a live QR session (raccoon-shaped) and returns
// the outcome channel so tests can settle it.
func registerQRLoginSession(t *testing.T, m *corejethub.Manager, loginID, accountID, qr string) (*corejethub.LoginSession, chan corejethub.LoginOutcome) {
	t.Helper()
	ch := make(chan corejethub.LoginOutcome, 1)
	sess := &corejethub.LoginSession{
		Started: &corejethub.StartedLogin{LoginURL: "http://127.0.0.1/free-hub-login.html", QRContent: qr, Result: ch},
		Account: accountID,
		Manager: m,
	}
	corejethub.RegisterLoginSession(loginID, sess)
	return sess, ch
}

// TestLoginPageReturnsQRContent: the page's data endpoint must hand back the
// QR payload (the xiaohuanxiong URL) — NOT the page URL.
func TestLoginPageReturnsQRContent(t *testing.T) {
	srv, m := newPublicPageHandler(t)
	qr := "https://xiaohuanxiong.com/login/mp?code=abc&appname=%E5%95%86%E6%B1%A4"
	registerQRLoginSession(t, m, "login-1", "acc-1", qr)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/login-page?loginId=login-1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("login-page = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var out struct {
		OK    bool   `json:"ok"`
		QR    string `json:"qr"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, rec.Body.String())
	}
	if !out.OK || out.QR != qr {
		t.Fatalf("payload wrong: %+v", out)
	}
	if out.Title == "" {
		t.Fatal("page needs a title for the card heading")
	}
	if strings.Contains(rec.Body.String(), "access_token") {
		t.Fatal("the public page payload must never carry credentials")
	}
}

// TestLoginPageUnknownOrNonQRSession: bogus/expired ids and sessions without a
// QR payload must 404 with a JSON error (the page shows it verbatim).
func TestLoginPageUnknownOrNonQRSession(t *testing.T) {
	srv, m := newPublicPageHandler(t)
	registerQRLoginSession(t, m, "no-qr", "acc-2", "")
	cases := []struct {
		name string
		url  string
		want int
	}{
		{"missing id", "/api/jethub/login-page", http.StatusBadRequest},
		{"unknown id", "/api/jethub/login-page?loginId=nope", http.StatusNotFound},
		{"session without QR", "/api/jethub/login-page?loginId=no-qr", http.StatusNotFound},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.url, nil))
		if rec.Code != tc.want {
			t.Errorf("%s = %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "error") {
			t.Errorf("%s must return a JSON error body, got %s", tc.name, rec.Body.String())
		}
	}
}

// TestLoginPageStatusLifecycle: pending → done+success, and the payload never
// leaks the account id (the endpoint is outside the auth group).
func TestLoginPageStatusLifecycle(t *testing.T) {
	srv, m := newPublicPageHandler(t)
	sess, ch := registerQRLoginSession(t, m, "login-2", "acc-3", "https://example.com/qr")

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/login-page/status?loginId=login-2", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"done":false`) {
		t.Fatalf("pending status wrong: %d %s", rec.Code, rec.Body.String())
	}

	go corejethub.SettleAndCleanup(sess, nil)
	ch <- corejethub.LoginOutcome{CredentialJSON: []byte(`{"access_token":"t"}`)}

	deadline := time.Now().Add(2 * time.Second)
	for {
		rec = httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/login-page/status?loginId=login-2", nil))
		if strings.Contains(rec.Body.String(), `"success":true`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status never settled: %s", rec.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if strings.Contains(rec.Body.String(), "acc-3") {
		t.Fatalf("the public status payload must not expose the account id: %s", rec.Body.String())
	}
}

// TestLoginPageStatusFailure: a failed flow reports the error to the page.
func TestLoginPageStatusFailure(t *testing.T) {
	srv, m := newPublicPageHandler(t)
	sess, ch := registerQRLoginSession(t, m, "login-3", "acc-4", "https://example.com/qr")

	go corejethub.SettleAndCleanup(sess, nil)
	ch <- corejethub.LoginOutcome{Err: errors.New("raccoon: 扫码已取消")}

	deadline := time.Now().Add(2 * time.Second)
	for {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/login-page/status?loginId=login-3", nil))
		if strings.Contains(rec.Body.String(), `"success":false`) {
			if !strings.Contains(rec.Body.String(), "扫码已取消") {
				t.Fatalf("failure reason must reach the page: %s", rec.Body.String())
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("status never settled: %s", rec.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestRaccoonLoginPageURL: the browser opens the LOCAL page (page URL), while
// the QR content travels separately inside StartedLogin.QRContent.
func TestRaccoonLoginPageURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/jethub/raccoon/login", nil)
	req.Host = "127.0.0.1:8080"
	got := raccoonLoginPageURL(req, "abc123")
	want := "http://127.0.0.1:8080/free-hub-login.html?loginId=abc123&provider=raccoon"
	if got != want {
		t.Fatalf("page URL = %q, want %q", got, want)
	}
	if strings.Contains(got, "xiaohuanxiong.com") {
		t.Fatal("the page URL must never be the QR content (reported defect: opening it cannot authenticate)")
	}
}

// TestLoomyLoginPageURL: loomy 用**独立页面**（微信下发的二维码是 JPEG，不能像
// raccoon 那样把文本交给浏览器端画），且页面 URL 必须指向它。
func TestLoomyLoginPageURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/jethub/loomy/login", nil)
	req.Host = "127.0.0.1:8080"
	got := loomyLoginPageURL(req, "l1")
	want := "http://127.0.0.1:8080/free-hub-loomy-login.html?loginId=l1&provider=loomy"
	if got != want {
		t.Fatalf("loomy page URL = %q, want %q", got, want)
	}
	if strings.Contains(got, "open.weixin.qq.com") {
		t.Fatal("the page URL must be the local page, not the WeChat auth page")
	}
}

// TestLoginPageLabelsCoverLoomy: 页面标题/提示要有 loomy 分支（否则回退成「登录 loomy」）。
func TestLoginPageLabelsCoverLoomy(t *testing.T) {
	title, hint := loginPageLabels("loomy")
	if !strings.Contains(title, "微信") || !strings.Contains(title, "Loomy") {
		t.Fatalf("loomy title = %q", title)
	}
	if !strings.Contains(hint, "微信") {
		t.Fatalf("loomy hint = %q", hint)
	}
}

// TestLoomyOnlyEndpointsRejectOtherSessions: qr-image / poll / complete 只服务
// loomy 的微信流程；其他会话必须明确拒绝（不能 500，也不能静默返回空）。
func TestLoomyOnlyEndpointsRejectOtherSessions(t *testing.T) {
	srv, m := newPublicPageHandler(t)
	registerQRLoginSession(t, m, "raccoon-1", "acc-9", "https://xiaohuanxiong.com/login/mp?code=x")

	cases := []struct {
		name   string
		method string
		url    string
		body   string
	}{
		{"qr-image", http.MethodGet, "/api/jethub/login-page/qr-image?loginId=raccoon-1", ""},
		{"poll", http.MethodGet, "/api/jethub/login-page/poll?loginId=raccoon-1", ""},
		{"complete", http.MethodPost, "/api/jethub/login-page/complete", `{"loginId":"raccoon-1","action":"send_sms","phone":"13011111111"}`},
	}
	for _, tc := range cases {
		var body io.Reader
		if tc.body != "" {
			body = strings.NewReader(tc.body)
		}
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.url, body))
		if rec.Code == http.StatusOK {
			t.Errorf("%s: must not succeed for a non-loomy session (%s)", tc.name, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "error") {
			t.Errorf("%s: refusal must be a JSON error, got %s", tc.name, rec.Body.String())
		}
	}
}

// TestStartRaccoonQRLoginSeparatesPageFromQRContent: LoginURL is the page,
// QRContent is the WeChat login URL, and the page opens only after the caller
// registered the session (the API layer owns that ordering).
func TestStartRaccoonQRLoginSeparatesPageFromQRContent(t *testing.T) {
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := m.StartRaccoonQRLogin(t.Context(), "acc", "http://127.0.0.1/free-hub-login.html?loginId=x")
	if err != nil {
		t.Fatal(err)
	}
	if started.LoginURL != "http://127.0.0.1/free-hub-login.html?loginId=x" {
		t.Fatalf("LoginURL must be the local page: %q", started.LoginURL)
	}
	if !strings.HasPrefix(started.QRContent, "https://xiaohuanxiong.com/login/mp?code=") {
		t.Fatalf("QRContent must be the scannable WeChat URL: %q", started.QRContent)
	}
	if !strings.Contains(started.QRContent, "appname=") {
		t.Fatalf("QRContent must carry the appname param: %q", started.QRContent)
	}
}
