// Package auth provides the authentication HTTP handlers and middleware.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

const sessionCookieName = "tinyrouter_session"
const sessionMaxAge = 24 * time.Hour

// maxSessions caps the number of live sessions held in memory. Tokens are
// only created by admin login / password setup / password change, so a store
// at capacity means repeated logins whose tokens never expired naturally;
// beyond the cap the oldest session is evicted.
const maxSessions = 1000

// sessionEntry is one live session: creation time, the session-bound CSRF
// token (returned to the UI after login and required on every state-changing
// management request), and the login owner (client address) for auditability.
type sessionEntry struct {
	createdAt time.Time
	csrf      string
	owner     string
}

// SessionStoreType is the thread-safe session token store.
type SessionStoreType struct {
	sync.RWMutex
	tokens map[string]sessionEntry
}

// ClearAll removes all sessions from the store.
func (s *SessionStoreType) ClearAll() {
	s.Lock()
	defer s.Unlock()
	s.tokens = make(map[string]sessionEntry)
}

// StoreToken stores a token with the current timestamp and a fresh
// session-bound CSRF token.
func (s *SessionStoreType) StoreToken(token string) {
	s.Lock()
	defer s.Unlock()
	s.tokens[token] = sessionEntry{createdAt: time.Now(), csrf: randomToken(), owner: ""}
	s.sweepLocked()
}

// NewSession creates a session token and its bound CSRF token in one step and
// records the login owner.
func (s *SessionStoreType) NewSession(owner string) (token, csrf string, err error) {
	token, err = GenerateToken()
	if err != nil {
		return "", "", err
	}
	csrf = randomToken()
	s.Lock()
	s.tokens[token] = sessionEntry{createdAt: time.Now(), csrf: csrf, owner: owner}
	s.sweepLocked()
	s.Unlock()
	return token, csrf, nil
}

// sweepLocked evicts expired sessions and then the oldest remaining sessions
// beyond the capacity cap. The caller must hold the write lock.
func (s *SessionStoreType) sweepLocked() {
	if len(s.tokens) <= maxSessions {
		return
	}
	now := time.Now()
	for tok, e := range s.tokens {
		if now.Sub(e.createdAt) > sessionMaxAge {
			delete(s.tokens, tok)
		}
	}
	for len(s.tokens) > maxSessions {
		var oldest string
		var oldestAt time.Time
		for tok, e := range s.tokens {
			if oldest == "" || e.createdAt.Before(oldestAt) {
				oldest, oldestAt = tok, e.createdAt
			}
		}
		delete(s.tokens, oldest)
	}
}

// SessionStore is the global session token store.
var SessionStore = &SessionStoreType{tokens: make(map[string]sessionEntry)}

// GenerateToken returns a cryptographically random hex token.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// randomToken returns a cryptographically random hex token, or "" when the
// RNG fails (the session then simply carries no CSRF protection and every
// state-changing request is rejected, which is fail-closed).
func randomToken() string {
	t, err := GenerateToken()
	if err != nil {
		return ""
	}
	return t
}

// IsValidSession reports whether the given token has a valid (non-expired) session.
func IsValidSession(token string) bool {
	if token == "" {
		return false
	}
	SessionStore.RLock()
	entry, ok := SessionStore.tokens[token]
	SessionStore.RUnlock()
	if !ok {
		return false
	}
	if time.Since(entry.createdAt) > sessionMaxAge {
		SessionStore.Lock()
		delete(SessionStore.tokens, token)
		SessionStore.Unlock()
		return false
	}
	return true
}

// CSRFToken returns the CSRF token bound to the given session token, or ""
// when no such session exists.
func CSRFToken(sessionToken string) string {
	if sessionToken == "" {
		return ""
	}
	SessionStore.RLock()
	defer SessionStore.RUnlock()
	return SessionStore.tokens[sessionToken].csrf
}

// SetSessionCookie sets the session cookie on the response.
func SetSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   0,
	})
}

// Handler holds auth dependencies and provides handler methods.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new auth Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers auth routes and returns the auth middleware for use
// by other domains. The returned middleware enforces the full management
// boundary: setup-required state, session validity, and CSRF/origin/content
// type on state-changing requests.
func (h *Handler) Register(r chi.Router) func(http.Handler) http.Handler {
	loginLimiter := newLoginRateLimiter()

	// Public bootstrap endpoints: auth status, login, and the minimal
	// setup-password endpoint reachable only while setup-required.
	r.Get("/auth/status", h.AuthStatusHandler)
	r.Post("/auth/login", loginLimiter.Wrap(h.LoginHandler))
	r.Post("/auth/setup", h.SetupHandler)

	// Protected: register the logout route inside a group with the combined
	// auth + CSRF middleware.
	r.Group(func(r chi.Router) {
		r.Use(h.AuthMiddleware)
		r.Post("/auth/logout", h.LogoutHandler)
	})

	return h.AuthMiddleware
}

func (h *Handler) isAuthEnabled() bool {
	cfg := h.d.Reg.Config()
	return cfg.Security.PasswordEnabled
}

// AuthMiddleware is the management API gate. It enforces, in order:
//
//  1. setup-required: when no password is configured the management API is
//     locked (401 setup_required) until POST /api/auth/setup initializes
//     password protection. Legacy PasswordEnabled=false configs migrate to
//     this state instead of open access.
//  2. a valid session cookie must be present.
//  3. state-changing requests (POST/PUT/PATCH/DELETE) must additionally pass
//     the CSRF contract: a session-bound X-CSRF-Token, a local Origin/Referer
//     when present, and a JSON or multipart Content-Type when present.
func (h *Handler) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.isAuthEnabled() {
			// Setup-required: no password configured yet. Only the public
			// bootstrap endpoints (/api/auth/status, /api/auth/login,
			// /api/auth/setup) are reachable; every management route stays
			// locked until password protection is initialized.
			apibase.WriteAPIError(w, http.StatusUnauthorized, "setup_required")
			return
		}

		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || !IsValidSession(cookie.Value) {
			apibase.WriteAPIError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if isStateChanging(r.Method) && !h.csrfChecksPass(w, r, cookie.Value) {
			return
		}

		next.ServeHTTP(w, r)
	})
}

// csrfChecksPass enforces the CSRF contract for state-changing requests:
// a session-bound X-CSRF-Token, a local Origin/Referer, and a JSON or
// multipart Content-Type. It writes the error response and returns false
// when any check fails.
func (h *Handler) csrfChecksPass(w http.ResponseWriter, r *http.Request, sessionToken string) bool {
	// 1. Session-bound CSRF token. A session whose RNG failed carries an
	// empty token and rejects everything (fail-closed).
	expected := CSRFToken(sessionToken)
	provided := r.Header.Get("X-CSRF-Token")
	if expected == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		apibase.WriteAPIError(w, http.StatusForbidden, "invalid or missing CSRF token")
		return false
	}
	// 2. Origin/Referer must be the local management origin when present.
	// Browsers always send Origin on cross-origin requests; a request with
	// neither header is a non-browser client, which is still bound by the
	// CSRF token check above.
	if !originAllowed(r, h.d.Reg.Config().Port) {
		apibase.WriteAPIError(w, http.StatusForbidden, "cross-origin request rejected")
		return false
	}
	// 3. JSON APIs must declare application/json; multipart uploads are
	// exempt from the content-type rule (their CSRF is the header check
	// above). An absent Content-Type is tolerated for bodyless requests and
	// plain non-browser clients; form-encoded and text/plain bodies are
	// rejected so simple HTML form submissions cannot reach the API.
	if ct := r.Header.Get("Content-Type"); ct != "" {
		mt := strings.TrimSpace(strings.SplitN(ct, ";", 2)[0])
		if mt != "application/json" && mt != "multipart/form-data" {
			apibase.WriteAPIError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json or multipart/form-data")
			return false
		}
	}
	return true
}

// isStateChanging reports whether the HTTP method can mutate state.
func isStateChanging(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// originAllowed reports whether the request's Origin (or Referer fallback)
// matches the local management origin: http(s)://127.0.0.1:<port>,
// http(s)://localhost:<port>, or http(s)://[::1]:<port>. A missing Origin
// and Referer passes (non-browser client); the CSRF token check still
// applies. Any other origin (external site, different localhost port) is
// rejected, which is the defense against same-site different-port CSRF.
func originAllowed(r *http.Request, port int) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = r.Header.Get("Referer")
	}
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return false
	}
	if p := u.Port(); p != "" {
		return p == strconv.Itoa(port)
	}
	return port == 80
}

// AuthStatusHandler returns the current auth status (enabled/disabled +
// logged in + setup-required) and, when logged in, the session-bound CSRF
// token the UI must echo on state-changing requests.
func (h *Handler) AuthStatusHandler(w http.ResponseWriter, r *http.Request) {
	enabled := h.isAuthEnabled()
	loggedIn := false
	csrf := ""
	if enabled {
		if cookie, err := r.Cookie(sessionCookieName); err == nil {
			loggedIn = IsValidSession(cookie.Value)
			if loggedIn {
				csrf = CSRFToken(cookie.Value)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"authEnabled":     enabled,
		"passwordEnabled": enabled,
		"setupRequired":   !enabled,
		"loggedIn":        loggedIn,
		"authenticated":   loggedIn,
		"csrfToken":       csrf,
	})
}

// requireJSONBody rejects requests that declare a non-JSON content type.
// Login and setup are JSON-only APIs; form-encoded submissions are refused
// (defense-in-depth against login CSRF via HTML forms).
func requireJSONBody(w http.ResponseWriter, r *http.Request) bool {
	if ct := r.Header.Get("Content-Type"); ct != "" {
		mt := strings.TrimSpace(strings.SplitN(ct, ";", 2)[0])
		if mt != "application/json" {
			apibase.WriteAPIError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
			return false
		}
	}
	return true
}

// LoginHandler handles password-based login.
func (h *Handler) LoginHandler(w http.ResponseWriter, r *http.Request) {
	if !requireJSONBody(w, r) {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg := h.d.Reg.Config()
	if !cfg.Security.PasswordEnabled {
		// Setup-required: login is not the bootstrap path; the UI must use
		// POST /api/auth/setup to initialize password protection.
		apibase.WriteAPIError(w, http.StatusUnauthorized, "setup_required")
		return
	}
	// Defense-in-depth: password protection is enabled but no password was ever
	// saved. finalizeConfig normalizes this to disabled on load, but if we
	// somehow reach here, reject login instead of granting access.
	if cfg.Security.PasswordEncrypted == "" || cfg.Security.EncryptionKey == "" {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "password protection is enabled but no password is configured; run setup via the setup screen")
		return
	}
	plaintext, err := config.Decrypt(cfg.Security.EncryptionKey, cfg.Security.PasswordEncrypted)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to decrypt password")
		return
	}
	if subtle.ConstantTimeCompare([]byte(req.Password), []byte(plaintext)) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "wrong password"})
		return
	}
	// Success is recorded explicitly with the rate limiter — never inferred
	// from the response status code or an implicit 200 Write (F-26).
	if g, ok := loginGuardFrom(r.Context()); ok {
		g.Success()
	}
	token, csrf, err := SessionStore.NewSession(r.RemoteAddr)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate session")
		return
	}
	SetSessionCookie(w, token)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "csrfToken": csrf})
}

// SetupHandler initializes password protection from the setup-required state
// (no password configured). It is the minimal public bootstrap endpoint: it
// sets a password, persists the config, clears stale sessions and mints the
// caller a fresh session + CSRF token. When protection is already enabled the
// endpoint rejects with 409.
func (h *Handler) SetupHandler(w http.ResponseWriter, r *http.Request) {
	if !requireJSONBody(w, r) {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg := h.d.Reg.Config()
	if cfg.Security.PasswordEnabled {
		apibase.WriteAPIError(w, http.StatusConflict, "password protection is already configured; use /api/auth/login")
		return
	}
	if req.Password == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "password is required")
		return
	}
	key, err := config.GenerateKey()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate encryption key")
		return
	}
	encrypted, err := config.Encrypt(key, req.Password)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to encrypt password")
		return
	}
	cfg.Security.EncryptionKey = key
	cfg.Security.PasswordEncrypted = encrypted
	cfg.Security.PasswordEnabled = true
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	SessionStore.ClearAll()
	token, csrf, err := SessionStore.NewSession(r.RemoteAddr)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate session")
		return
	}
	SetSessionCookie(w, token)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "csrfToken": csrf})
}

// LogoutHandler clears the session cookie.
func (h *Handler) LogoutHandler(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil {
		SessionStore.Lock()
		delete(SessionStore.tokens, cookie.Value)
		SessionStore.Unlock()
	}
	SetSessionCookie(w, "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
