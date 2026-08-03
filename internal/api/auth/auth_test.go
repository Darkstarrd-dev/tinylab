package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/registry"
)

func TestGenerateToken_Uniqueness(t *testing.T) {
	n := 100
	tokens := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		token, err := GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken at iteration %d: %v", i, err)
		}
		if tokens[token] {
			t.Fatalf("duplicate token at iteration %d: %s", i, token)
		}
		tokens[token] = true
	}
}

func TestGenerateToken_Length(t *testing.T) {
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if len(token) != 64 {
		t.Fatalf("token length = %d, want 64", len(token))
	}
}

func TestSessionStore_ValidateAfterAdd(t *testing.T) {
	SessionStore.ClearAll()
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	SessionStore.Lock()
	SessionStore.tokens[token] = time.Now()
	SessionStore.Unlock()
	if !IsValidSession(token) {
		t.Fatal("IsValidSession returned false for a token that was just added")
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
	SessionStore.Lock()
	SessionStore.tokens[token] = time.Now()
	SessionStore.Unlock()
	SessionStore.ClearAll()
	if IsValidSession(token) {
		t.Fatal("IsValidSession returned true after ClearAll")
	}
}

func TestSessionStore_ExpiredToken(t *testing.T) {
	SessionStore.ClearAll()
	token, _ := GenerateToken()
	SessionStore.Lock()
	SessionStore.tokens[token] = time.Now().Add(-25 * time.Hour)
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
	SessionStore.tokens[token] = time.Time{} // zero value
	SessionStore.Unlock()
	if IsValidSession(token) {
		t.Fatal("IsValidSession returned true for token with zero expiry")
	}
}

func TestSessionStore_ConcurrentAccess(t *testing.T) {
	SessionStore.ClearAll()
	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func() {
			token, _ := GenerateToken()
			SessionStore.Lock()
			SessionStore.tokens[token] = time.Now()
			SessionStore.Unlock()
			IsValidSession(token)
			done <- true
		}()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestAuthStatusHandler_ResponseFormat(t *testing.T) {
	req := httptest.NewRequest("GET", "/auth/status", nil)
	w := httptest.NewRecorder()

	// Create a dummy registry with password enabled
	cfg := &config.Config{}
	cfg.Security.PasswordEnabled = true
	reg := registry.New(cfg)
	d := &apibase.Deps{Reg: reg}
	h := NewHandler(d)

	h.AuthStatusHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var data map[string]bool
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatalf("failed to decode JSON response: %v", err)
	}

	if !data["authEnabled"] || !data["passwordEnabled"] {
		t.Errorf("expected authEnabled and passwordEnabled to be true, got %v", data)
	}
	if data["loggedIn"] || data["authenticated"] {
		t.Errorf("expected loggedIn and authenticated to be false, got %v", data)
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
