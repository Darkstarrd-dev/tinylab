package jethub

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

// httpClient lazily builds the shared outbound client used by provider
// adapters for signed GET/POST management calls (30s budget, aligned with the
// plugin's REQUEST_TIMEOUT_MS).
func (m *Manager) httpClient() *http.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sharedClient == nil {
		m.sharedClient = &http.Client{Timeout: 30 * time.Second}
	}
	return m.sharedClient
}

// strReader is a tiny strings.NewReader alias for readability.
func strReader(s string) *strings.Reader { return strings.NewReader(s) }

// NewLoginSessionID generates a random session id for in-flight login flows.
func NewLoginSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// loginSessions is the process-local registry of in-flight login flows
// (guarded; entries removed when settled).
var (
	loginMu       sync.Mutex
	loginSessions = map[string]*LoginSession{}
)

// registerLoginSession tracks a flow; the API status endpoint polls it.
func registerLoginSession(id string, s *LoginSession) {
	loginMu.Lock()
	defer loginMu.Unlock()
	loginSessions[id] = s
}

// TakeLoginSession removes a settled flow.
func TakeLoginSession(id string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	delete(loginSessions, id)
}

// PeekLoginSession reads a flow without removing it.
func PeekLoginSession(id string) (*LoginSession, bool) {
	loginMu.Lock()
	defer loginMu.Unlock()
	s, ok := loginSessions[id]
	return s, ok
}

// RegisterLoginSession is the exported alias (API layer calls this).
func RegisterLoginSession(id string, s *LoginSession) { registerLoginSession(id, s) }

// loginSession is one in-flight OAuth flow (codearts; P3 providers reuse the
// shape via their own start functions).
type LoginSession struct {
	Started *StartedLogin
	Account string
}
