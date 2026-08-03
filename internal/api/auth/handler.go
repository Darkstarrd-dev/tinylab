// Package auth provides the authentication HTTP handlers and middleware.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

const sessionCookieName = "tinyrouter_session"
const sessionMaxAge = 24 * time.Hour

// SessionStoreType is the thread-safe session token store.
type SessionStoreType struct {
	sync.RWMutex
	tokens map[string]time.Time
}

// ClearAll removes all sessions from the store.
func (s *SessionStoreType) ClearAll() {
	s.Lock()
	defer s.Unlock()
	s.tokens = make(map[string]time.Time)
}

// StoreToken stores a token with the current timestamp.
func (s *SessionStoreType) StoreToken(token string) {
	s.Lock()
	s.tokens[token] = time.Now()
	s.Unlock()
}

// SessionStore is the global session token store.
var SessionStore = &SessionStoreType{tokens: make(map[string]time.Time)}

// GenerateToken returns a cryptographically random hex token.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// IsValidSession reports whether the given token has a valid (non-expired) session.
func IsValidSession(token string) bool {
	if token == "" {
		return false
	}
	SessionStore.RLock()
	createdAt, ok := SessionStore.tokens[token]
	SessionStore.RUnlock()
	if !ok {
		return false
	}
	if time.Since(createdAt) > sessionMaxAge {
		SessionStore.Lock()
		delete(SessionStore.tokens, token)
		SessionStore.Unlock()
		return false
	}
	return true
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
// by other domains.
func (h *Handler) Register(r chi.Router) func(http.Handler) http.Handler {
	loginLimiter := newLoginRateLimiter()

	r.Get("/auth/status", h.AuthStatusHandler)
	r.Post("/auth/login", loginLimiter.Wrap(h.LoginHandler))

	// Protected: register the logout route inside a group with auth middleware
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

// AuthMiddleware checks for a valid session cookie on every request.
func (h *Handler) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.isAuthEnabled() {
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || !IsValidSession(cookie.Value) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			return
		}

		next.ServeHTTP(w, r)
	})
}

// AuthStatusHandler returns the current auth status (enabled/disabled + logged in).
func (h *Handler) AuthStatusHandler(w http.ResponseWriter, r *http.Request) {
	enabled := h.isAuthEnabled()
	loggedIn := false
	if enabled {
		if cookie, err := r.Cookie(sessionCookieName); err == nil {
			loggedIn = IsValidSession(cookie.Value)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{
		"authEnabled":     enabled,
		"passwordEnabled": enabled,
		"loggedIn":        loggedIn,
		"authenticated":   loggedIn,
	})
}

// LoginHandler handles password-based login.
func (h *Handler) LoginHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg := h.d.Reg.Config()
	if !cfg.Security.PasswordEnabled {
		SetSessionCookie(w, "")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
		return
	}
	// Defense-in-depth: password protection is enabled but no password was ever
	// saved. finalizeConfig normalizes this to disabled on load, but if we
	// somehow reach here, reject login instead of granting access.
	if cfg.Security.PasswordEncrypted == "" || cfg.Security.EncryptionKey == "" {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "password protection is enabled but no password is configured; edit config.yaml to set passwordEnabled: false")
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
	token, err := GenerateToken()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	SessionStore.StoreToken(token)
	SetSessionCookie(w, token)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
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
