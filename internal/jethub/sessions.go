package jethub

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// loginSessionGracePeriod is how long a settled session stays observable
// before the pump reaps it (several poll intervals; session state is tiny).
const loginSessionGracePeriod = 30 * time.Second

// reapAfterGrace removes the session entry once the UI poll had a chance to
// observe the settled outcome (several poll intervals; entries are tiny).
func reapAfterGrace(id string) {
	go func() {
		<-time.After(loginSessionGracePeriod)
		TakeLoginSession(id)
	}()
}

// httpClient lazily builds the shared outbound client used by provider
// adapters for signed GET/POST management calls (30s budget, aligned with the
// plugin's REQUEST_TIMEOUT_MS).
//
// ⚠️ Proxy awareness (real defect, cline login): the transport defaults to
// http.ProxyFromEnvironment, which only honors HTTP(S)_PROXY env vars — and
// those are empty for the app process. A user whose machine reaches these
// upstreams through the local routing proxy (Windows system proxy on
// 127.0.0.1:2080, mirrored into config.yaml proxy.enabled) gets TLS
// handshake timeouts from the Go app while browser/DSH-undici flows through
// the proxy just fine. The manager therefore carries an explicit proxy URL
// (wired from config by the app, SetProxyURL) that wins over the env.
func (m *Manager) httpClient() *http.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sharedClient == nil {
		transport := &http.Transport{} // ProxyFromEnvironment default
		if u := m.proxyURLValueLocked(); u != nil {
			transport.Proxy = http.ProxyURL(u)
		}
		m.sharedClient = &http.Client{Timeout: 30 * time.Second, Transport: transport}
	}
	return m.sharedClient
}

// proxyURLValueLocked returns the currently configured proxy URL (caller
// holds m.mu; the value itself is immutable once set).
func (m *Manager) proxyURLValueLocked() *url.URL {
	if m.proxyURL == nil {
		return nil
	}
	return m.proxyURL
}

// SetProxyURL configures the global upstream proxy for all jethub outbound
// calls (login/token/credits/renewal). Pass "http://host:port" (the shape
// proxy.SetProxy already produces) or "" to disable. Must be called before
// the first outbound request (app assembly); later calls are best-effort:
// the shared client is rebuilt only if it has not been created yet.
func (m *Manager) SetProxyURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		m.mu.Lock()
		m.proxyURL = nil
		m.mu.Unlock()
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("jethub: invalid proxy URL %q: %w", raw, err)
	}
	m.mu.Lock()
	m.proxyURL = u
	m.sharedClient = nil // rebuild lazily with the proxy transport
	m.mu.Unlock()
	return nil
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
	s.Key = id
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
//
// ⚠️ Single-consumer discipline: the pump goroutine started by the login
// handler is the ONLY reader of Started.Result (via SettleAndCleanup); the
// UI status poll reads the recorded state through SessionStatus. Two direct
// channel readers would race for the single buffered outcome and one side
// would hang forever.
type LoginSession struct {
	// Key is the registry id (assigned by registerLoginSession; used by
	// SettleAndCleanup to remove the entry exactly once).
	Key string
	// Manager, when set, lets SettleAndCleanup delete the placeholder
	// account when the flow fails (no credential-less leftovers).
	Manager *Manager
	Started *StartedLogin
	Account string

	// recorded outcome (guarded by settleMu; written only by
	// SettleAndCleanup, read by SessionStatus).
	settleMu   sync.Mutex
	settled    bool
	settledOK  bool
	settledErr error
}

// SessionStatus is the non-blocking UI poll: reports whether the flow has
// settled and, if so, its recorded outcome.
func SessionStatus(s *LoginSession) (done, success bool, errMsg string) {
	s.settleMu.Lock()
	defer s.settleMu.Unlock()
	if !s.settled {
		return false, false, ""
	}
	msg := ""
	if s.settledErr != nil {
		msg = s.settledErr.Error()
	}
	return true, s.settledOK, msg
}

// SettleAndCleanup is the pump: it blocks until the flow delivers exactly one
// outcome, records it (SessionStatus turns visible), removes the session and:
//   - on failure deletes the placeholder account — without this a timed-out /
//     canceled login leaves a credential-less entry that renders as a
//     usable-looking card and can never work;
//   - on success hands the credential JSON to complete (provider-specific
//     persistence). Flows that already persist internally pass nil here.
//
// ⚠️ Call sites MUST NOT wire the flow itself to the HTTP request context:
// the login handler returns long before the user finishes authorization, and
// net/http cancels the request context right after — every flow bound to
// r.Context() aborted the moment its handler responded (the "+新建账号
// placeholder appears, credential never lands" defect: raccoon/cline/trae/
// lobsterai/buddy/minimax all polled on r.Context(); qoder was the only one
// that documented and avoided it).
func SettleAndCleanup(sess *LoginSession, complete func(LoginOutcome) error) {
	outcome := <-sess.Started.Result
	sess.settleMu.Lock()
	if sess.settled { // defensive: never run twice
		sess.settleMu.Unlock()
		return
	}
	sess.settled = true
	sess.settledOK = outcome.Err == nil
	sess.settledErr = outcome.Err
	sess.settleMu.Unlock()

	// Reap only after a grace period: the UI polls every ~2s, so removing
	// the entry immediately would make the poller's next request 404 and the
	// "done" transition would never be observed — the dialog would hang on
	// "waiting" even though the login finished (real defect recorded).
	reapAfterGrace(sess.Key)
	if outcome.Err != nil {
		if sess.Manager != nil {
			_ = sess.Manager.DeleteAccount(sess.Account)
		}
		return
	}
	if complete != nil && outcome.CredentialJSON != nil {
		if err := complete(outcome); err != nil {
			if sess.Manager != nil {
				_ = sess.Manager.DeleteAccount(sess.Account)
			}
		}
	}
}
