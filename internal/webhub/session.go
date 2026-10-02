package webhub

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
)

// attachTimeout bounds one attach/list-targets round trip. Short on purpose:
// a browser that is not answering CDP is "not connected" and the caller must
// be able to say so immediately instead of hanging a management RPC.
const attachTimeout = 10 * time.Second

// devtoolsPollInterval / devtoolsReadyTimeout bound the wait for the CDP HTTP
// endpoint after launching a browser (a cold Chrome start is ~1-2s).
const (
	devtoolsPollInterval = 200 * time.Millisecond
	devtoolsReadyTimeout = 20 * time.Second
)

// TabInfo is a page target visible over CDP.
type TabInfo struct {
	ID  target.ID
	URL string
}

// Session is one attached browser tab for one site.
//
// ⚠️ One session per site: a single browser login can only serve one
// conversation at a time, so requests for a site are serialized (see
// Driver.Acquire). The session holds no credential — the login state lives in
// the browser profile directory.
type Session struct {
	// Site is the site domain this tab was matched for.
	Site string
	// Tab is the matched page target.
	Tab TabInfo
	// cancel releases the CDP context bound to this tab.
	cancel context.CancelFunc
	// runCtx is the long-lived per-tab context. Per-request timeouts are
	// derived from it, never from it directly (canceling it would detach).
	runCtx context.Context
}

// SessionManager resolves and caches the tab of each site.
//
// It is safe for concurrent use. Ownership note: it does NOT own the browser
// process — webhub only connects (and launches one when nothing is listening);
// it never kills a browser the user may be using.
type SessionManager struct {
	mu sync.RWMutex
	// wsURL is the CDP endpoint ("" = not configured / browser not launched).
	wsURL string
	// sessions maps site domain → attached session.
	sessions map[string]*Session
	// listTargets is the CDP target-listing hook (injected in tests).
	listTargets func(ctx context.Context) ([]*target.Info, error)
}

// NewSessionManager creates a manager bound to a CDP endpoint. Pass "" to
// create a disconnected manager (every operation then reports "not connected").
func NewSessionManager(wsURL string) *SessionManager {
	return &SessionManager{
		wsURL:       wsURL,
		sessions:    map[string]*Session{},
		listTargets: chromedp.Targets,
	}
}

// SetEndpoint updates the CDP endpoint and drops every cached session (a new
// endpoint means a different browser instance).
func (m *SessionManager) SetEndpoint(wsURL string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.wsURL == wsURL {
		return
	}
	for site, s := range m.sessions {
		if s.cancel != nil {
			s.cancel()
		}
		delete(m.sessions, site)
	}
	m.wsURL = wsURL
}

// Endpoint returns the current CDP endpoint ("" when not connected).
func (m *SessionManager) Endpoint() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.wsURL
}

// Drop forgets the cached session for a site (the tab is detached, the browser
// is left running — webhub never closes a user's tab).
func (m *SessionManager) Drop(site string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[site]; ok && s.cancel != nil {
		s.cancel()
	}
	delete(m.sessions, site)
}

// Close detaches every session. The browser process is NOT terminated.
func (m *SessionManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for site, s := range m.sessions {
		if s.cancel != nil {
			s.cancel()
		}
		delete(m.sessions, site)
	}
}

// Status reports whether a site's tab is currently attached.
func (m *SessionManager) Status(site string) (attached bool, tabURL string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[normalizeDomain(site)]
	if !ok || s == nil {
		return false, ""
	}
	return true, s.Tab.URL
}

// For returns the cached session for a site, or nil.
func (m *SessionManager) For(site string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[normalizeDomain(site)]
}

// FindTab lists the browser's page targets and returns the one that belongs to
// site. It NEVER falls back to an unrelated tab: when no page of the site is
// open it returns nil with no error.
//
// ⚠️ This is the guard the P0 prototype lacked. The prototype fell back to
// "the first page tab" and navigated it — which sent the operator's own DSH
// GUI page to DeepSeek. An unrelated tab (including a bare-IP host such as
// 127.0.0.1:20199) must never be reused, no matter how convenient.
func (m *SessionManager) FindTab(ctx context.Context, site string) (*TabInfo, error) {
	m.mu.RLock()
	wsURL := m.wsURL
	list := m.listTargets
	m.mu.RUnlock()
	if wsURL == "" {
		return nil, ErrNotConnected
	}
	if list == nil {
		list = chromedp.Targets
	}

	runCtx, cancel := context.WithTimeout(ctx, attachTimeout)
	defer cancel()

	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(runCtx, wsURL)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()

	targets, err := list(browserCtx)
	if err != nil {
		return nil, fmt.Errorf("webhub: list targets: %w", err)
	}
	for _, t := range targets {
		if t == nil || t.Type != "page" {
			continue
		}
		if domainMatches(site, t.URL) {
			return &TabInfo{ID: t.TargetID, URL: t.URL}, nil
		}
	}
	return nil, nil
}

// Open attaches to (or reuses the already-attached) tab of a site.
//
// Returns ErrNoTab when the browser is reachable but the site has no open page
// — the caller must then ask the user to open the site (POST .../open). It
// never navigates a foreign tab and never opens a new one behind the user's
// back: the user signs in themselves, in their own browser.
func (m *SessionManager) Open(ctx context.Context, site string) (*Session, error) {
	domain := normalizeDomain(site)
	if domain == "" {
		return nil, fmt.Errorf("webhub: empty site")
	}
	if cached := m.For(domain); cached != nil {
		return cached, nil
	}

	tab, err := m.FindTab(ctx, domain)
	if err != nil {
		return nil, err
	}
	if tab == nil {
		return nil, ErrNoTab
	}

	m.mu.RLock()
	wsURL := m.wsURL
	m.mu.RUnlock()

	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(context.Background(), wsURL)
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	tabCtx, cancelTab := chromedp.NewContext(browserCtx, chromedp.WithTargetID(tab.ID))
	// A failing attach must not leak the parent contexts.
	ok := false
	defer func() {
		if !ok {
			cancelTab()
			cancelBrowser()
			cancelAlloc()
		}
	}()
	if err := chromedp.Run(tabCtx); err != nil {
		return nil, fmt.Errorf("webhub: attach tab: %w", err)
	}
	ok = true

	s := &Session{Site: domain, Tab: *tab, runCtx: tabCtx, cancel: func() {
		cancelTab()
		cancelBrowser()
		cancelAlloc()
	}}
	m.mu.Lock()
	if existing, dup := m.sessions[domain]; dup && existing != nil && existing.cancel != nil {
		// Lost a race with a concurrent Open: keep the first, drop ours.
		m.mu.Unlock()
		s.cancel()
		return existing, nil
	}
	m.sessions[domain] = s
	m.mu.Unlock()
	return s, nil
}

// Context returns the CDP context bound to the session's tab.
func (s *Session) Context() context.Context { return s.runCtx }

// OpenTab opens url as a new page tab in the attached browser. This backs the
// site detail pane's "Open Site" action — the user's explicit way to reach
// the (login) page inside the webhub browser, whose persistent profile keeps
// the session. Driver/probe flows never open tabs behind the user's back.
func (m *SessionManager) OpenTab(ctx context.Context, rawURL string) error {
	m.mu.RLock()
	wsURL := m.wsURL
	m.mu.RUnlock()
	if wsURL == "" {
		return ErrNotConnected
	}
	runCtx, cancel := context.WithTimeout(ctx, attachTimeout)
	defer cancel()
	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(runCtx, wsURL)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	return chromedp.Run(browserCtx, chromedp.ActionFunc(func(ctx context.Context) error {
		_, err := target.CreateTarget(rawURL).Do(ctx)
		return err
	}))
}

// ErrNotConnected is returned when no CDP endpoint is configured (the browser
// was never launched / never found).
var ErrNotConnected = fmt.Errorf("webhub: browser not connected")

// ErrNoTab is returned when the browser is reachable but no page of the
// requested site is open. The user must open (and sign into) the site.
var ErrNoTab = fmt.Errorf("webhub: no open tab for this site (open it in the browser first)")

// WaitForDevTools polls the browser's /json/version until the CDP HTTP
// endpoint answers, so a launcher can hand a ready endpoint to
// NewSessionManager. It returns an error when the deadline passes.
func WaitForDevTools(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url) // #nosec G107 -- fixed loopback URL built from an int port
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(devtoolsPollInterval)
	}
	err := fmt.Errorf("webhub: devtools not ready on port %d after %s", port, timeout)
	if diag := lastLaunchDiag(); diag != "" {
		err = fmt.Errorf("%w (%s)", err, diag)
	}
	return err
}
