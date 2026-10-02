package webhub

import (
	"context"
	"errors"
	"testing"

	"github.com/chromedp/cdproto/target"
)

// fakeTargets models the browser's tab list. It deliberately includes a
// localhost tab (the exact shape that caused the P0 accident: the DSH GUI
// running on 127.0.0.1:20199) to prove it is never reused.
func fakeTargets(urls ...string) func(context.Context) ([]*target.Info, error) {
	return func(context.Context) ([]*target.Info, error) {
		out := make([]*target.Info, 0, len(urls)+1)
		out = append(out, &target.Info{
			Type:     "page",
			URL:      "http://127.0.0.1:20199/", // must never be selected
			TargetID: "TAB-LOCAL",
		})
		for i, u := range urls {
			out = append(out, &target.Info{
				Type:     "page",
				URL:      u,
				TargetID: target.ID("TAB-" + string(rune('A'+i))),
			})
		}
		// A non-page target must be ignored even if it matches.
		out = append(out, &target.Info{Type: "background_page", URL: "https://chat.deepseek.com/", TargetID: "TAB-BG"})
		return out, nil
	}
}

// 域名精确匹配：只选目标站点的 tab，绝不复用非目标 tab（P0 事故）。
func TestFindTabDomainExactMatch(t *testing.T) {
	sm := NewSessionManager("ws://127.0.0.1:9333")
	sm.listTargets = fakeTargets("https://chat.deepseek.com/", "https://chatgpt.com/")

	tab, err := sm.FindTab(context.Background(), "chat.deepseek.com")
	if err != nil {
		t.Fatalf("FindTab: %v", err)
	}
	if tab == nil {
		t.Fatal("no tab found")
	}
	if tab.URL != "https://chat.deepseek.com/" {
		t.Fatalf("selected %q", tab.URL)
	}
}

// 站点没有打开时必须返回 (nil, nil) —— 不能退化成「拿第一个 page tab 顶上」。
// P0 原型正是这样把用户的 DSH GUI 页面导航到了 DeepSeek。
func TestFindTabNeverFallsBackToForeignTab(t *testing.T) {
	sm := NewSessionManager("ws://127.0.0.1:9333")
	sm.listTargets = fakeTargets() // only the localhost tab + background page

	tab, err := sm.FindTab(context.Background(), "chat.deepseek.com")
	if err != nil {
		t.Fatalf("FindTab: %v", err)
	}
	if tab != nil {
		t.Fatalf("must not reuse a foreign tab, got %q", tab.URL)
	}
}

// www. 与非 www. 视作同一站点（规则数据里的 route alias 语义）。
func TestFindTabWWWAlias(t *testing.T) {
	sm := NewSessionManager("ws://127.0.0.1:9333")
	sm.listTargets = fakeTargets("https://www.kimi.com/")

	tab, err := sm.FindTab(context.Background(), "www.kimi.com")
	if err != nil {
		t.Fatalf("FindTab: %v", err)
	}
	if tab == nil {
		t.Fatal("kimi tab not matched")
	}
}

// 未连接（无 endpoint）时立即报 ErrNotConnected，不挂起管理 RPC。
func TestFindTabNotConnected(t *testing.T) {
	sm := NewSessionManager("")
	if _, err := sm.FindTab(context.Background(), "chat.deepseek.com"); err != ErrNotConnected {
		t.Fatalf("err = %v, want ErrNotConnected", err)
	}
}

// 列表失败（浏览器已崩）必须透传为错误，而不是当成「没有 tab」。
func TestFindTabListError(t *testing.T) {
	sm := NewSessionManager("ws://127.0.0.1:9333")
	boom := errors.New("cdp gone")
	sm.listTargets = func(context.Context) ([]*target.Info, error) { return nil, boom }
	if _, err := sm.FindTab(context.Background(), "chat.deepseek.com"); err == nil {
		t.Fatal("expected the list error to surface")
	}
}

// 换 endpoint 必须丢弃缓存会话（新 endpoint = 另一个浏览器实例）。
func TestSetEndpointDropsSessions(t *testing.T) {
	sm := NewSessionManager("ws://a")
	sm.sessions["chat.deepseek.com"] = &Session{Site: "chat.deepseek.com"}
	sm.SetEndpoint("ws://b")
	if sm.Endpoint() != "ws://b" {
		t.Fatalf("endpoint = %q", sm.Endpoint())
	}
	if sm.For("chat.deepseek.com") != nil {
		t.Fatal("cached session must be dropped")
	}
	// 同值设置不应清空。
	sm.sessions["chat.deepseek.com"] = &Session{Site: "chat.deepseek.com"}
	sm.SetEndpoint("ws://b")
	if sm.For("chat.deepseek.com") == nil {
		t.Fatal("same endpoint must not drop sessions")
	}
}

func TestSessionManagerStatusAndDrop(t *testing.T) {
	sm := NewSessionManager("ws://a")
	if attached, _ := sm.Status("chat.deepseek.com"); attached {
		t.Fatal("empty manager must report detached")
	}
	sm.sessions["chat.deepseek.com"] = &Session{Site: "chat.deepseek.com", Tab: TabInfo{URL: "https://chat.deepseek.com/"}}
	if attached, url := sm.Status("chat.deepseek.com"); !attached || url == "" {
		t.Fatalf("status = %v %q", attached, url)
	}
	sm.Drop("chat.deepseek.com")
	if sm.For("chat.deepseek.com") != nil {
		t.Fatal("Drop must remove the session")
	}
}
