package webhub

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/chromedp/cdproto/target"
)

// The lazy bring-up (EnsureBrowser) and live resolution (ResolveSite) must
// never launch a real browser from a unit test: connectFn is injected in every
// test below. The real-machine attach path is verified manually (migration
// plan §4.4 / architecture §6 matrix).

func TestEnsureBrowserFailsAndThrottles(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	boom := errors.New("no browser in test")
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		calls++
		return "", false, boom
	})
	for i := range 3 {
		if err := m.EnsureBrowser(); !errors.Is(err, boom) {
			t.Fatalf("EnsureBrowser[%d] = %v, want the stub error", i, err)
		}
	}
	if calls != 1 {
		t.Fatalf("connect attempts = %d, want 1 (throttle must suppress retries inside %s)", calls, browserRetryInterval)
	}
	if m.sessions.Endpoint() != "" {
		t.Fatal("endpoint must stay empty after a failed ensure")
	}
}

func TestEnsureBrowserSucceedsOnce(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		calls++
		return "ws://127.0.0.1:9333/devtools/browser/test", true, nil
	})
	for i := range 3 {
		if err := m.EnsureBrowser(); err != nil {
			t.Fatalf("EnsureBrowser[%d] = %v", i, err)
		}
	}
	if calls != 1 {
		t.Fatalf("connect attempts = %d, want 1 (endpoint already set short-circuits)", calls)
	}
	if m.sessions.Endpoint() != "ws://127.0.0.1:9333/devtools/browser/test" {
		t.Fatalf("endpoint = %q", m.sessions.Endpoint())
	}
}

func TestResolveSiteEnsureFailureReportsDisconnected(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		return "", false, errors.New("no browser in test")
	})
	connected, attached, tabURL := m.ResolveSite("chat.deepseek.com")
	if connected || attached || tabURL != "" {
		t.Fatalf("ResolveSite = (%v,%v,%q), want all-false when the browser cannot be brought up", connected, attached, tabURL)
	}
}

func TestResolveSiteStaleEndpointReconnects(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a browser that was closed since the last attach: the cached
	// endpoint points at a dead DevTools (target listing fails), and the
	// reconnect brings up a fresh browser whose tabs do NOT include the site.
	m.SetEndpoint("ws://127.0.0.1:9333/devtools/browser/dead")
	stale := true
	m.sessions.listTargets = func(context.Context) ([]*target.Info, error) {
		if stale {
			return nil, errors.New("connection refused (stale endpoint)")
		}
		return []*target.Info{{Type: "page", URL: "https://chatgpt.com/"}}, nil
	}
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		stale = false // the fresh browser answers target listings
		return "ws://127.0.0.1:9333/devtools/browser/fresh", true, nil
	})
	connected, attached, tabURL := m.ResolveSite("chat.deepseek.com")
	// The fresh browser has a chatgpt tab but no DeepSeek tab: reachable, not
	// attached, and the foreign tab must NOT be reported (P0 guard).
	if !connected {
		t.Fatal("connected = false, want true after reconnect")
	}
	if attached || tabURL != "" {
		t.Fatalf("attached=(%v,%q), want no attachment and no foreign tab", attached, tabURL)
	}
	if m.sessions.Endpoint() != "ws://127.0.0.1:9333/devtools/browser/fresh" {
		t.Fatalf("endpoint after reconnect = %q", m.sessions.Endpoint())
	}
}

func TestResolveSiteReconnectFailureReportsDisconnected(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	m.SetEndpoint("ws://127.0.0.1:9333/devtools/browser/dead")
	m.sessions.listTargets = func(context.Context) ([]*target.Info, error) {
		return nil, errors.New("connection refused (stale endpoint)")
	}
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		return "", false, errors.New("still no browser")
	})
	connected, attached, tabURL := m.ResolveSite("chat.deepseek.com")
	if connected || attached || tabURL != "" {
		t.Fatalf("ResolveSite = (%v,%v,%q), want all-false when reconnect also fails", connected, attached, tabURL)
	}
	if m.sessions.Endpoint() != "" {
		t.Fatal("endpoint must be cleared when the reconnect fails, so the next call retries")
	}
}

func TestEnsureBrowserThrottleWindowExpires(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		calls++
		return "", false, errors.New("no browser in test")
	})
	if err := m.EnsureBrowser(); err == nil {
		t.Fatal("first ensure must fail")
	}
	// Force the throttle window open to prove a new attempt is made afterwards.
	m.lastEnsure = time.Now().Add(-2 * browserRetryInterval)
	if err := m.EnsureBrowser(); err == nil {
		t.Fatal("second ensure after the window must attempt again and fail")
	}
	if calls != 2 {
		t.Fatalf("connect attempts = %d, want 2", calls)
	}
}
