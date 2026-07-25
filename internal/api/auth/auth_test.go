package auth

import (
	"testing"
	"time"
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