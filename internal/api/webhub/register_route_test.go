package webhub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/tinylab/tinylab/internal/config"
	corewebhub "github.com/tinylab/tinylab/internal/webhub"
)

// fakeRegistry is an in-memory corewebhub.BridgeDeps so route tests can wire a
// real Bridge without the app-level registry.
type fakeRegistry struct {
	providers map[string]config.Provider
}

func (f *fakeRegistry) GetProviderByPrefix(prefix string) (*config.Provider, bool) {
	for _, p := range f.providers {
		if p.Prefix == prefix {
			return &p, true
		}
	}
	return nil, false
}

func (f *fakeRegistry) GetProvider(id string) (*config.Provider, bool) {
	p, ok := f.providers[id]
	return &p, ok
}

func (f *fakeRegistry) AddProvider(p config.Provider)    { f.providers[p.ID] = p }
func (f *fakeRegistry) UpsertProvider(p config.Provider) { f.providers[p.ID] = p }
func (f *fakeRegistry) HasProvider(id string) bool       { _, ok := f.providers[id]; return ok }
func (f *fakeRegistry) DeleteProvider(id string) bool {
	_, ok := f.providers[id]
	delete(f.providers, id)
	return ok
}
func (f *fakeRegistry) UpdateProvider(id string, u config.Provider) bool {
	if _, ok := f.providers[id]; !ok {
		return false
	}
	f.providers[id] = u
	return true
}

func (f *fakeRegistry) ListProviders() []config.Provider {
	out := make([]config.Provider, 0, len(f.providers))
	for _, p := range f.providers {
		out = append(out, p)
	}
	return out
}

// newRouteTestHandler mounts the real webhub route table on a chi router so
// route-shape regressions are caught at the HTTP layer.
//
// ⚠️ 这是 jethub 缺陷 6/14（同一坑复发两次）的守卫：前端与后端路径必须同形。
// 不带 `sites/` 段的旧形状必须 404，否则前端会拿到 chi 的纯文本 404 体。
func newRouteTestHandler(t *testing.T) http.Handler {
	t.Helper()
	m, err := corewebhub.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	// Never launch a real browser from a route test: status/open/probe lazily
	// connect, so the stub must fail fast and honestly.
	m.SetConnectFn(func(string, int, bool) (string, bool, error) {
		return "", false, corewebhub.ErrNoBrowser
	})
	// A conflict source: another provider already owning "taken".
	reg := &fakeRegistry{providers: map[string]config.Provider{
		"other": {ID: "other", Prefix: "taken"},
	}}
	h := NewHandler(&Deps{Manager: m, Bridge: corewebhub.NewBridge(m, reg)})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.Register(r) })
	return r
}

func TestSitesListRouteShape(t *testing.T) {
	srv := newRouteTestHandler(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/webhub/sites", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /sites = %d", rec.Code)
	}
	var out struct {
		Sites []struct {
			ID string `json:"id"`
		} `json:"sites"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not JSON: %q", rec.Body.String())
	}
	if len(out.Sites) == 0 {
		t.Fatal("no sites returned")
	}
}

// 站点段必须在 sites/ 之下：/api/webhub/{site}/status 这类形状必须 404。
func TestStatusRouteRequiresSitesSegment(t *testing.T) {
	srv := newRouteTestHandler(t)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/webhub/sites/chat.deepseek.com/status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET sites/{site}/status = %d (body %q)", rec.Code, rec.Body.String())
	}

	// 旧形状（漏掉 sites/）必须不可达。
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/webhub/chat.deepseek.com/status", nil))
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("/api/webhub/{site}/status = %d, want 404 (the shape that caused jethub defects 6/14)", rec2.Code)
	}
}

// 未知站点必须返回 JSON 404（带 error 字段），而不是 chi 的纯文本 404。
func TestUnknownSiteReturnsJSON404(t *testing.T) {
	srv := newRouteTestHandler(t)

	for _, path := range []string{
		"/api/webhub/sites/nope.example/status",
		"/api/webhub/sites/nope.example/probe",
	} {
		rec := httptest.NewRecorder()
		method := http.MethodGet
		if strings.HasSuffix(path, "/probe") {
			method = http.MethodPost
		}
		srv.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "error") {
			t.Fatalf("%s must carry a JSON error: %q", path, rec.Body.String())
		}
	}
}

// prefix 路由形状与校验：非法前缀 400，冲突 409，正常 200 并回传模型 ID。
func TestPrefixRoutes(t *testing.T) {
	srv := newRouteTestHandler(t)

	// 非法前缀 → 400
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/webhub/sites/chat.deepseek.com/prefix",
		strings.NewReader(`{"prefix":"BAD PREFIX!"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad prefix = %d, want 400", rec.Code)
	}

	// 坏 JSON → 400
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodPut, "/api/webhub/sites/chat.deepseek.com/prefix",
		strings.NewReader(`{`)))
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON = %d, want 400", rec2.Code)
	}

	// 正常设置 → 200 + 前缀生效 + 模型 ID 带上前缀
	rec3 := httptest.NewRecorder()
	srv.ServeHTTP(rec3, httptest.NewRequest(http.MethodPut, "/api/webhub/sites/chat.deepseek.com/prefix",
		strings.NewReader(`{"prefix":"ds"}`)))
	if rec3.Code != http.StatusOK {
		t.Fatalf("set prefix = %d (%s)", rec3.Code, rec3.Body.String())
	}
	var out struct {
		Prefix   string   `json:"prefix"`
		ModelIDs []string `json:"modelIds"`
	}
	if err := json.Unmarshal(rec3.Body.Bytes(), &out); err != nil {
		t.Fatalf("prefix body: %v", err)
	}
	if out.Prefix != "ds" {
		t.Fatalf("prefix = %q", out.Prefix)
	}
	if len(out.ModelIDs) == 0 || !strings.HasPrefix(out.ModelIDs[0], "ds/") {
		t.Fatalf("modelIds = %v, want prefixed ids", out.ModelIDs)
	}

	// 冲突（另一个 provider 已占用 "taken"）→ 409
	rec4 := httptest.NewRecorder()
	srv.ServeHTTP(rec4, httptest.NewRequest(http.MethodPut, "/api/webhub/sites/chat.deepseek.com/prefix",
		strings.NewReader(`{"prefix":"taken"}`)))
	if rec4.Code != http.StatusConflict {
		t.Fatalf("conflicting prefix = %d, want 409", rec4.Code)
	}

	// 清除 → 200
	rec5 := httptest.NewRecorder()
	srv.ServeHTTP(rec5, httptest.NewRequest(http.MethodDelete, "/api/webhub/sites/chat.deepseek.com/prefix", nil))
	if rec5.Code != http.StatusOK {
		t.Fatalf("clear prefix = %d", rec5.Code)
	}
}

// 未装配（Manager/Bridge 为 nil）必须降级为 JSON 503，不能 panic。
func TestUnwiredDegradesTo503(t *testing.T) {
	h := NewHandler(&Deps{})
	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) { h.Register(r) })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/webhub/sites", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unwired = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "error") {
		t.Fatalf("503 must be JSON: %q", rec.Body.String())
	}
}
