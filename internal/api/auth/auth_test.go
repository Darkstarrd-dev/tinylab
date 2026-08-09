package auth

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

const testPassword = "test-password"

// newTestHandler builds an auth Handler with a registry whose security state
// matches enabled. When enabled, the config carries an encrypted password so
// LoginHandler can verify credentials.
func newTestHandler(t *testing.T, enabled bool) *Handler {
	t.Helper()
	cfg := config.DefaultConfig()
	if enabled {
		key, err := config.GenerateKey()
		if err != nil {
			t.Fatal(err)
		}
		enc, err := config.Encrypt(key, testPassword)
		if err != nil {
			t.Fatal(err)
		}
		cfg.Security = config.SecurityConfig{
			PasswordEnabled:   true,
			EncryptionKey:     key,
			PasswordEncrypted: enc,
		}
	}
	reg := registry.New(cfg)
	deps := &apibase.Deps{
		Reg:        reg,
		ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
	}
	return NewHandler(deps)
}

// newTestRouter mounts the public auth routes plus one protected probe route
// behind the returned middleware, so tests can exercise the full auth+CSRF
// boundary over HTTP. It mirrors the real router: everything lives under /api.
func newTestRouter(t *testing.T, enabled bool) (*httptest.Server, *Handler) {
	t.Helper()
	h := newTestHandler(t, enabled)
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) {
		authMW := h.Register(r)
		r.Group(func(r chi.Router) {
			r.Use(authMW)
			r.Post("/protected", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			})
		})
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	// The CSRF Origin check validates against the configured management port,
	// which must match the port the server is actually listening on.
	alignRegistryPort(t, h, srv)
	return srv, h
}

// alignRegistryPort sets the registry's config port to the test server's real
// port so the Origin check in AuthMiddleware accepts the test origin.
func alignRegistryPort(t *testing.T, h *Handler, srv *httptest.Server) {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	cfg := h.d.Reg.Config()
	cfg.Port = port
	h.d.Reg.Reload(&cfg)
}

func doJSON(t *testing.T, method, url string, body string, headers map[string]string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return string(data)
}

func TestGenerateToken_Uniqueness(t *testing.T) {
	n := 100
	tokens := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		token, err := GenerateToken()
		if err != nil {
			t.Fatal(err)
		}
		if tokens[token] {
			t.Fatalf("duplicate token generated: %s", token)
		}
		tokens[token] = true
	}
}

func TestGenerateToken_Length(t *testing.T) {
	token, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(token))
	}
}

func TestSessionStore_ValidateAfterAdd(t *testing.T) {
	SessionStore.ClearAll()
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	SessionStore.StoreToken(token)
	if !IsValidSession(token) {
		t.Fatal("IsValidSession returned false for a token that was just added")
	}
	if CSRFToken(token) == "" {
		t.Fatal("expected a session-bound CSRF token after StoreToken")
	}
}

func TestSessionStore_ValidateUnknown(t *testing.T) {
	SessionStore.ClearAll()
	if IsValidSession("nonexistent-token") {
		t.Fatal("IsValidSession returned true for unknown token")
	}
}

func TestSessionStore_ValidateEmpty(t *testing.T) {
	SessionStore.ClearAll()
	if IsValidSession("") {
		t.Fatal("IsValidSession returned true for empty token")
	}
}

func TestSessionStore_ClearAll(t *testing.T) {
	SessionStore.ClearAll()
	token, _ := GenerateToken()
	SessionStore.StoreToken(token)
	SessionStore.ClearAll()
	if IsValidSession(token) {
		t.Fatal("IsValidSession returned true after ClearAll")
	}
	if CSRFToken(token) != "" {
		t.Fatal("CSRFToken returned a token after ClearAll")
	}
}

func TestSessionStore_ExpiredToken(t *testing.T) {
	SessionStore.ClearAll()
	token, _ := GenerateToken()
	SessionStore.Lock()
	SessionStore.tokens[token] = sessionEntry{createdAt: time.Now().Add(-25 * time.Hour)}
	SessionStore.Unlock()
	if IsValidSession(token) {
		t.Fatal("IsValidSession returned true for expired token")
	}
	SessionStore.RLock()
	_, ok := SessionStore.tokens[token]
	SessionStore.RUnlock()
	if ok {
		t.Fatal("expired token should have been removed from store")
	}
}

func TestSessionStore_ExpiryNotSet(t *testing.T) {
	SessionStore.ClearAll()
	token, _ := GenerateToken()
	SessionStore.Lock()
	SessionStore.tokens[token] = sessionEntry{} // zero createdAt
	SessionStore.Unlock()
	if IsValidSession(token) {
		t.Fatal("IsValidSession returned true for token with zero createdAt")
	}
}

func TestSessionStore_ConcurrentAccess(t *testing.T) {
	SessionStore.ClearAll()
	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func() {
			token, _ := GenerateToken()
			SessionStore.StoreToken(token)
			IsValidSession(token)
			CSRFToken(token)
			done <- true
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestSessionStore_NewSessionBindsCSRFAndOwner(t *testing.T) {
	SessionStore.ClearAll()
	token, csrf, err := SessionStore.NewSession("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || csrf == "" {
		t.Fatal("expected non-empty token and csrf")
	}
	if CSRFToken(token) != csrf {
		t.Fatal("CSRFToken lookup must return the token bound at creation")
	}
	SessionStore.RLock()
	owner := SessionStore.tokens[token].owner
	SessionStore.RUnlock()
	if owner != "127.0.0.1" {
		t.Fatalf("expected owner 127.0.0.1, got %q", owner)
	}
	if CSRFToken("unknown") != "" {
		t.Fatal("CSRFToken must be empty for unknown sessions")
	}
}

// --- Auth status ---

func TestAuthStatusHandler_ResponseFormat(t *testing.T) {
	h := newTestHandler(t, true)
	req := httptest.NewRequest("GET", "/auth/status", nil)
	w := httptest.NewRecorder()
	h.AuthStatusHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatalf("failed to decode JSON response: %v", err)
	}
	if data["authEnabled"] != true || data["passwordEnabled"] != true {
		t.Errorf("expected authEnabled and passwordEnabled to be true, got %v", data)
	}
	if data["setupRequired"] != false {
		t.Errorf("expected setupRequired false when protected, got %v", data["setupRequired"])
	}
	if data["loggedIn"] != false || data["authenticated"] != false {
		t.Errorf("expected loggedIn and authenticated to be false, got %v", data)
	}
	if data["csrfToken"] != "" {
		t.Errorf("expected empty csrfToken when not logged in, got %v", data["csrfToken"])
	}
}

func TestAuthStatusHandler_SetupRequired(t *testing.T) {
	h := newTestHandler(t, false)
	req := httptest.NewRequest("GET", "/auth/status", nil)
	w := httptest.NewRecorder()
	h.AuthStatusHandler(w, req)

	var data map[string]any
	if err := json.NewDecoder(w.Result().Body).Decode(&data); err != nil {
		t.Fatal(err)
	}
	if data["authEnabled"] != false || data["passwordEnabled"] != false {
		t.Errorf("expected auth disabled in setup-required state, got %v", data)
	}
	if data["setupRequired"] != true {
		t.Errorf("expected setupRequired true, got %v", data["setupRequired"])
	}
}

// --- Middleware: setup-required boundary (F-04) ---

func TestAuthMiddleware_SetupRequiredBlocksManagement(t *testing.T) {
	h := newTestHandler(t, false)
	// Even a validly stored session must not pass: in setup-required state no
	// management route is reachable.
	token, _, err := SessionStore.NewSession("test")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/providers", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	w := httptest.NewRecorder()
	h.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 in setup-required state, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "setup_required") {
		t.Fatalf("expected setup_required error body, got %q", w.Body.String())
	}
}

// --- Middleware: CSRF / Origin / Content-Type (F-05) ---

func TestAuthMiddleware_CSRFEnforcement(t *testing.T) {
	h := newTestHandler(t, true)
	token, csrf, err := SessionStore.NewSession("test")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://127.0.0.1:20128"
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}

	cases := []struct {
		name       string
		method     string
		body       string
		headers    map[string]string
		wantStatus int
	}{
		{
			name:       "GET without CSRF passes",
			method:     http.MethodGet,
			wantStatus: http.StatusOK,
		},
		{
			name:       "POST without CSRF token rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Origin": origin},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "POST with wrong CSRF token rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Origin": origin, "X-CSRF-Token": "deadbeef"},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "POST with valid token but external Origin rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Origin": "http://evil.example.com", "X-CSRF-Token": csrf},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "POST with valid token but same-site different-port Origin rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Origin": "http://localhost:9999", "X-CSRF-Token": csrf},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "POST with Referer fallback on external origin rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Referer": "http://localhost:9999/x", "X-CSRF-Token": csrf},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "POST form-encoded content type rejected",
			method:     http.MethodPost,
			body:       `a=b`,
			headers:    map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Origin": origin, "X-CSRF-Token": csrf},
			wantStatus: http.StatusUnsupportedMediaType,
		},
		{
			name:       "POST text/plain content type rejected",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "text/plain", "Origin": origin, "X-CSRF-Token": csrf},
			wantStatus: http.StatusUnsupportedMediaType,
		},
		{
			name:       "POST valid JSON with token and origin passes",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "Origin": origin, "X-CSRF-Token": csrf},
			wantStatus: http.StatusOK,
		},
		{
			name:       "POST multipart with token and origin passes",
			method:     http.MethodPost,
			body:       `--x`,
			headers:    map[string]string{"Content-Type": "multipart/form-data; boundary=x", "Origin": origin, "X-CSRF-Token": csrf},
			wantStatus: http.StatusOK,
		},
		{
			name:       "POST without Origin/Referer but with token passes (non-browser client)",
			method:     http.MethodPost,
			body:       `{}`,
			headers:    map[string]string{"Content-Type": "application/json", "X-CSRF-Token": csrf},
			wantStatus: http.StatusOK,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var rdr io.Reader
			if tc.body != "" {
				rdr = strings.NewReader(tc.body)
			}
			req := httptest.NewRequest(tc.method, "/protected", rdr)
			req.AddCookie(cookie)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})).ServeHTTP(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("expected %d, got %d (body %s)", tc.wantStatus, w.Code, w.Body.String())
			}
		})
	}
}

// --- Login flow: session, CSRF issuance, logout (F-04 lifecycle) ---

func TestLoginFlow_SessionCSRFAndLogout(t *testing.T) {
	srv, _ := newTestRouter(t, true)

	// Wrong password → 401 and no session.
	resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"wrong"}`, map[string]string{
		"Content-Type": "application/json",
		"Origin":       srv.URL,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Correct login → session cookie + CSRF token.
	resp = doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"`+testPassword+`"}`, map[string]string{
		"Content-Type": "application/json",
		"Origin":       srv.URL,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on login, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var login struct {
		Success   bool   `json:"success"`
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&login); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !login.Success || login.CSRFToken == "" {
		t.Fatalf("expected success + csrfToken in login response, got %+v", login)
	}
	cookies := resp.Cookies()
	if len(cookies) == 0 || cookies[0].Name != sessionCookieName {
		t.Fatalf("expected session cookie, got %+v", cookies)
	}

	// Status reports logged in with the same CSRF token.
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/status", nil)
	req.AddCookie(cookies[0])
	statusResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.NewDecoder(statusResp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	statusResp.Body.Close()
	if status["loggedIn"] != true || status["csrfToken"] != login.CSRFToken {
		t.Fatalf("expected loggedIn with matching csrfToken, got %v", status)
	}

	// Protected POST with cookie + CSRF + Origin works.
	req, _ = http.NewRequest("POST", srv.URL+"/api/protected", strings.NewReader(`{}`))
	req.AddCookie(cookies[0])
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", srv.URL)
	req.Header.Set("X-CSRF-Token", login.CSRFToken)
	protResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	protResp.Body.Close()
	if protResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on protected POST with CSRF, got %d", protResp.StatusCode)
	}

	// Logout invalidates the session.
	req, _ = http.NewRequest("POST", srv.URL+"/api/auth/logout", nil)
	req.AddCookie(cookies[0])
	req.Header.Set("Origin", srv.URL)
	req.Header.Set("X-CSRF-Token", login.CSRFToken)
	logoutResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	logoutResp.Body.Close()
	if logoutResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on logout, got %d", logoutResp.StatusCode)
	}

	// The old session token is gone: protected POST now 401.
	req, _ = http.NewRequest("POST", srv.URL+"/api/protected", strings.NewReader(`{}`))
	req.AddCookie(cookies[0])
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", srv.URL)
	req.Header.Set("X-CSRF-Token", login.CSRFToken)
	afterResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	afterResp.Body.Close()
	if afterResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 after logout, got %d", afterResp.StatusCode)
	}
}

func TestLoginFlow_ConcurrentLogins(t *testing.T) {
	srv, _ := newTestRouter(t, true)
	var wg sync.WaitGroup
	statuses := make([]int, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"`+testPassword+`"}`, map[string]string{
				"Content-Type": "application/json",
				"Origin":       srv.URL,
			})
			statuses[idx] = resp.StatusCode
			resp.Body.Close()
		}(i)
	}
	wg.Wait()
	for i, s := range statuses {
		if s != http.StatusOK {
			t.Errorf("concurrent login %d returned %d", i, s)
		}
	}
}

// --- Setup endpoint (F-04 setup-required bootstrap) ---

func TestSetupHandler_InitializesProtection(t *testing.T) {
	srv, _ := newTestRouter(t, false)

	// Management API is locked in setup-required state.
	resp := doJSON(t, "GET", srv.URL+"/api/auth/status", "", nil)
	var status map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if status["setupRequired"] != true {
		t.Fatalf("expected setupRequired before setup, got %v", status)
	}

	// Setup with a password unlocks the app and mints a session + CSRF.
	resp = doJSON(t, "POST", srv.URL+"/api/auth/setup", `{"password":"`+testPassword+`"}`, map[string]string{
		"Content-Type": "application/json",
		"Origin":       srv.URL,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on setup, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
	var setup struct {
		Success   bool   `json:"success"`
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&setup); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !setup.Success || setup.CSRFToken == "" {
		t.Fatalf("expected success + csrfToken, got %+v", setup)
	}
	cookies := resp.Cookies()
	if len(cookies) == 0 {
		t.Fatal("expected session cookie after setup")
	}

	// Status now reports protected.
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/status", nil)
	req.AddCookie(cookies[0])
	statusResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(statusResp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	statusResp.Body.Close()
	if status["setupRequired"] != false || status["passwordEnabled"] != true {
		t.Fatalf("expected protected after setup, got %v", status)
	}
}

func TestSetupHandler_RejectsWhenAlreadyProtected(t *testing.T) {
	srv, _ := newTestRouter(t, true)
	resp := doJSON(t, "POST", srv.URL+"/api/auth/setup", `{"password":"x"}`, map[string]string{
		"Content-Type": "application/json",
		"Origin":       srv.URL,
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 when protection already configured, got %d: %s", resp.StatusCode, readBody(t, resp))
	}
}

func TestSetupHandler_RejectsEmptyPassword(t *testing.T) {
	srv, _ := newTestRouter(t, false)
	resp := doJSON(t, "POST", srv.URL+"/api/auth/setup", `{"password":""}`, map[string]string{
		"Content-Type": "application/json",
		"Origin":       srv.URL,
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty password, got %d", resp.StatusCode)
	}
}

func TestLoginHandler_RejectsInconsistentState(t *testing.T) {
	// LoginHandler must return 500 (not success) when PasswordEnabled=true
	// but PasswordEncrypted="" — the defensive bypass is removed.
	cfg := &config.Config{}
	cfg.Security.PasswordEnabled = true
	// PasswordEncrypted and EncryptionKey are intentionally left empty.
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg}
	h := NewHandler(d)

	body := `{"password":"anything"}`
	req := httptest.NewRequest("POST", "/auth/login", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.LoginHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 Internal Server Error, got %d", resp.StatusCode)
	}
}

func TestLoginHandler_RejectsNonJSONContentType(t *testing.T) {
	h := newTestHandler(t, true)
	req := httptest.NewRequest("POST", "/auth/login", strings.NewReader("password=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.LoginHandler(w, req)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for form-encoded login, got %d", w.Code)
	}
}

// --- Rate limiter (F-26) ---

// TestLoginRateLimiter_MalformedBodyCountsAsFailure proves that malformed JSON
// (which yields a 400 from LoginHandler) counts toward the brute-force
// threshold instead of resetting it: 4 malformed bodies + 1 wrong password
// must leave the client blocked, and a correct password must then be refused.
func TestLoginRateLimiter_MalformedBodyCountsAsFailure(t *testing.T) {
	srv, _ := newTestRouter(t, true)
	jsonHeaders := map[string]string{"Content-Type": "application/json", "Origin": srv.URL}

	for i := 0; i < 4; i++ {
		resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `not-json{`, jsonHeaders)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("malformed attempt %d: expected 400, got %d", i, resp.StatusCode)
		}
		resp.Body.Close()
	}
	// 5th failure (wrong password) trips the block.
	resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"wrong"}`, jsonHeaders)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got %d", resp.StatusCode)
	}
	resp.Body.Close()
	// A correct password is now refused: malformed bodies did not reset.
	resp = doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"`+testPassword+`"}`, jsonHeaders)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after threshold crossed via malformed bodies, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestLoginRateLimiter_MalformedBodyCannotUnblock proves that once blocked,
// malformed bodies are refused without touching the counter.
func TestLoginRateLimiter_MalformedBodyCannotUnblock(t *testing.T) {
	srv, _ := newTestRouter(t, true)
	jsonHeaders := map[string]string{"Content-Type": "application/json", "Origin": srv.URL}

	for i := 0; i < 5; i++ {
		resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `{"password":"wrong"}`, jsonHeaders)
		resp.Body.Close()
	}
	// Blocked: malformed body must yield 429 (block check runs first), not 400.
	resp := doJSON(t, "POST", srv.URL+"/api/auth/login", `not-json{`, jsonHeaders)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 for malformed body while blocked, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestLoginRateLimiter_Implicit200DoesNotReset covers the implicit-Write path:
// a handler that writes a body without calling WriteHeader (auto-200) must not
// clear the failure counter.
func TestLoginRateLimiter_Implicit200DoesNotReset(t *testing.T) {
	l := newLoginRateLimiter()
	for i := 0; i < 4; i++ {
		l.RecordFailure("1.2.3.4")
	}
	req := httptest.NewRequest("POST", "/auth/login", nil)
	rec := httptest.NewRecorder()
	l.Wrap(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true}`)) // implicit 200 via Write
	})(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected implicit 200, got %d", rec.Code)
	}
	if l.IsBlocked("1.2.3.4") {
		t.Fatal("should not be blocked after only 4 failures")
	}
	l.RecordFailure("1.2.3.4") // 5th failure → blocked
	if !l.IsBlocked("1.2.3.4") {
		t.Fatal("implicit 200 must NOT reset the failure counter")
	}
}

// TestLoginRateLimiter_ExplicitSuccessResets proves the only reset path is the
// handler's explicit success notification.
func TestLoginRateLimiter_ExplicitSuccessResets(t *testing.T) {
	l := newLoginRateLimiter()
	l.RecordFailure("1.2.3.4")
	l.RecordFailure("1.2.3.4")
	g := &loginGuard{limiter: l, ip: "1.2.3.4"}
	g.Success()
	l.mu.Lock()
	n := len(l.attempts)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("explicit success must clear the counter, %d entries remain", n)
	}
}

// TestLoginRateLimiter_WriteHeaderRecordsFailures verifies the writer counts
// every non-success status (400/401/500) as a failure and never records
// success by itself.
func TestLoginRateLimiter_WriteHeaderRecordsFailures(t *testing.T) {
	l := newLoginRateLimiter()
	for _, code := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusInternalServerError} {
		req := httptest.NewRequest("POST", "/auth/login", nil)
		rec := httptest.NewRecorder()
		l.Wrap(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		})(rec, req)
	}
	l.mu.Lock()
	fc := 0
	if a := l.attempts["192.0.2.1"]; a != nil {
		fc = a.failCount
	}
	l.mu.Unlock()
	if fc != 3 {
		t.Fatalf("expected 3 recorded failures (400/401/500), got %d", fc)
	}
}
