package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// newStatusHandler mounts the whole protected jethub route group (the panel's
// own endpoints), exactly as internal/api/router.go does.
func newStatusHandler(t *testing.T) (http.Handler, *corejethub.Manager) {
	t.Helper()
	m, err := corejethub.NewManager(t.TempDir(), "", nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	h := NewHandler(&Deps{Manager: m})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.Register(r) })
	return r, m
}

// statusRoutes enumerates every GET `…/status` route the panel may poll, with
// path params substituted by a live provider id.
func statusRoutes(t *testing.T, h http.Handler) []string {
	t.Helper()
	r, ok := h.(*chi.Mux)
	if !ok {
		t.Fatalf("expected *chi.Mux, got %T", h)
	}
	var out []string
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || !strings.HasSuffix(route, "/status") {
			return nil
		}
		out = append(out, strings.ReplaceAll(route, "{provider}", "loomy"))
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return out
}

// TestEveryProviderStatusHonorsLoginID is the structural guard behind real
// defect 19 (loomy 的 Provider Login modal 永远停在「等待登录」).
//
// 面板的登录 modal 只轮 `GET /jethub/{provider}/status?loginId=…`，并靠响应里的
// `done` 字段判断流程是否结束（`st.done` 为真才关闭弹窗、刷新账号列表）。任何
// provider 的 status handler 只要**漏掉 loginId 分支**（返回账号快照
// `{"accounts":…}`），前端就永远读不到 `done`：登录其实已经成功、凭据已经落盘，
// 弹窗却一动不动，30s 后会话被回收更是变成无声的 404 空转 —— 这正是 loomy 的
// 实测症状（codesnapshot 与 pollLogin 两种响应形状的分歧）。
//
// 所以断言不看实现：**对每一条 /status 路由发一个不存在的 loginId**，响应必须
// 落在「pollLogin 语义」里 —— 200 且带 `done` 字段（未结算/已结算），或 404 且带
// JSON `error`（会话已回收/无效 id）。带 `accounts` 快照回来的一律判失败。
//
// ⚠️ 这条守卫的价值在于**覆盖新增 provider**：手写一张 provider 表只能复查已知的
// 那几个，而路由走得是 chi.Walk —— 新加一个 `/status` 忘了分支，测试立刻报红。
func TestEveryProviderStatusHonorsLoginID(t *testing.T) {
	srv, _ := newStatusHandler(t)
	routes := statusRoutes(t, srv)
	if len(routes) < 8 {
		t.Fatalf("walked only %d status routes (%v) — the enumeration is broken, not the code", len(routes), routes)
	}
	sawLoomy := false
	for _, route := range routes {
		if strings.Contains(route, "/loomy/") {
			sawLoomy = true
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, route+"?loginId=defect-guard-unknown", nil)
		srv.ServeHTTP(rec, req)

		body := rec.Body.String()
		var payload map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Errorf("%s?loginId=… returned non-JSON %d: %s", route, rec.Code, body)
			continue
		}
		switch rec.Code {
		case http.StatusOK:
			if _, ok := payload["done"]; !ok {
				t.Errorf("%s ignores loginId: 200 without a `done` field (%s) — the panel's login modal will wait forever (defect 19)", route, body)
			}
		case http.StatusNotFound:
			if _, ok := payload["error"]; !ok {
				t.Errorf("%s: 404 without a JSON `error` field (%s)", route, body)
			}
		default:
			t.Errorf("%s?loginId=… = %d (%s), want 200+done or 404+error", route, rec.Code, body)
		}
	}
	if !sawLoomy {
		t.Fatalf("no loomy status route found in %v", routes)
	}
}

// TestLoomyStatusAcceptsLoginID is the direct regression for defect 19: with a
// live session the loomy status route must report the recorded outcome (not the
// account snapshot), and without a loginId it stays the snapshot endpoint the
// panel uses elsewhere.
func TestLoomyStatusAcceptsLoginID(t *testing.T) {
	srv, m := newStatusHandler(t)

	// Login rate 面板的账号快照分支必须保留（无 loginId）。
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/loomy/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accounts"`) {
		t.Fatalf("snapshot branch broken: %d %s", rec.Code, rec.Body.String())
	}

	// 有 loginId：未结算 → done:false；结算后 → done:true + success。
	ch := make(chan corejethub.LoginOutcome, 1)
	sess := &corejethub.LoginSession{
		Started: &corejethub.StartedLogin{LoginURL: "http://127.0.0.1/free-hub-loomy-login.html", Result: ch},
		Account: "loomy-abc",
		Manager: m,
	}
	corejethub.RegisterLoginSession("loomy-login-1", sess)

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/loomy/status?loginId=loomy-login-1", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"done":false`) {
		t.Fatalf("pending poll must report done:false (got %d %s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"accounts"`) {
		t.Fatalf("a loginId poll must never return the account snapshot: %s", rec.Body.String())
	}

	go corejethub.SettleAndCleanup(sess, nil)
	ch <- corejethub.LoginOutcome{CredentialJSON: []byte(`{"access_token":"t"}`)}

	deadline := time.Now().Add(2 * time.Second)
	for {
		rec = httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/loomy/status?loginId=loomy-login-1", nil))
		if strings.Contains(rec.Body.String(), `"success":true`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("loomy status never reported the settled outcome: %s", rec.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 会话回收后：404 + JSON error（前端据此收尾，而不是无声空转）。
	corejethub.TakeLoginSession("loomy-login-1")
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/loomy/status?loginId=loomy-login-1", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "error") {
		t.Fatalf("reaped session must 404 with a JSON error: %d %s", rec.Code, rec.Body.String())
	}
}
