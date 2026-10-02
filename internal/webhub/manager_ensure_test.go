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

// 缺陷 24（2026-10-03）：status 绝不启动浏览器。
//
// 此前 ResolveSite 遇到失效端点会自己重连（于是「看一眼状态」就把 Chrome
// 拉起来，app 启动时也会弹窗）。现在它只报告：端点失效 ⇒ 清空 + 报
// connected=false，等用户点「打开站点」再拉起。
func TestResolveSiteNeverLaunchesBrowser(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var connectCalls int
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		connectCalls++
		return "ws://127.0.0.1:9333/devtools/browser/fresh", true, nil
	})

	// ① 从未连接：status 只报 false，不得触发启动。
	connected, attached, tabURL := m.ResolveSite("chat.deepseek.com")
	if connected || attached || tabURL != "" {
		t.Fatalf("fresh manager = (%v,%v,%q), want all false", connected, attached, tabURL)
	}
	if connectCalls != 0 {
		t.Fatalf("ResolveSite launched the browser (%d connect calls), want 0", connectCalls)
	}

	// ② 端点失效（浏览器被关掉）：清空 + 报 false，同样不得启动。
	m.SetEndpoint("ws://127.0.0.1:9333/devtools/browser/dead")
	m.sessions.listTargets = func(context.Context) ([]*target.Info, error) {
		return nil, errors.New("connection refused (stale endpoint)")
	}
	connected, attached, tabURL = m.ResolveSite("chat.deepseek.com")
	if connected || attached || tabURL != "" {
		t.Fatalf("stale endpoint = (%v,%v,%q), want all false", connected, attached, tabURL)
	}
	if connectCalls != 0 {
		t.Fatalf("ResolveSite launched the browser on a stale endpoint (%d calls)", connectCalls)
	}
	if got := m.sessions.Endpoint(); got != "" {
		t.Fatalf("endpoint after stale = %q, want cleared", got)
	}

	// ③ 已连接但无本站点 tab：报 connected=true / attached=false（附着逻辑
	// 与「绝不附着非目标 tab」由 TestResolveSiteAttachesOwnTabOnly 覆盖；
	// 这里不伪造 CDP 端点做真实拨号）。
	m.sessions.listTargets = func(context.Context) ([]*target.Info, error) {
		return []*target.Info{{Type: "page", URL: "https://chatgpt.com/"}}, nil
	}
	m.SetEndpoint("ws://127.0.0.1:9333/devtools/browser/live")
	connected, _, _ = m.ResolveSite("chat.deepseek.com")
	if !connected {
		t.Fatal("connected = false, want true (endpoint is live)")
	}
	if connectCalls != 0 {
		t.Fatalf("ResolveSite launched the browser while already connected (%d calls)", connectCalls)
	}
}

// 已连接时 status 必须附着**本站点**的 tab，绝不附着非目标 tab（P0 事故守卫）。
func TestResolveSiteAttachesOwnTabOnly(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	m.sessions.listTargets = func(context.Context) ([]*target.Info, error) {
		return []*target.Info{{Type: "page", URL: "https://chatgpt.com/"}}, nil
	}
	m.SetEndpoint("ws://127.0.0.1:9333/devtools/browser/live")
	connected, attached, tabURL := m.ResolveSite("chat.deepseek.com")
	if !connected {
		t.Fatal("connected = false, want true (endpoint is live)")
	}
	if attached || tabURL != "" {
		t.Fatalf("attached=(%v,%q): must not attach a foreign tab", attached, tabURL)
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
