package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/rotation"
)

// TestPerKeyProxyRoutesThatKeyOnly 是「账号自带出口代理」的核心判据：
// **设了代理的 key 走它自己的出口，没设的 key 一步都不绕**。
//
// 为什么必须两条都断言：这个能力的**安全边界**就是「默认路径逐字节不变」——
// 只证明「设了的会绕」而不证明「没设的不绕」，等于放任一次全局路由回归（所有
// provider 突然都走某条代理），而那是最难察觉的一类事故。
//
// 反向验证：把 `upstreamClientFor` 里的 per-key 分支删掉，第一条断言变红；把它改成
// 无条件使用（不判空），第二条变红。
func TestPerKeyProxyRoutesThatKeyOnly(t *testing.T) {
	proxyHits := 0
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits++
		// A real egress proxy would forward; for the assertion we only need to
		// know the request arrived here instead of at the upstream.
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"proxied":true}`)
	}))
	defer proxySrv.Close()

	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"direct":true}`)
	}))
	defer upstream.Close()

	h := New(nil, nil, nil, nil, nil, console.New(100), 30)
	proxyURL, _ := url.Parse(proxySrv.URL)
	h.proxyURL.Store(proxyURL)

	newSel := func(keyProxy string) *rotation.SelectedKey {
		return &rotation.SelectedKey{
			Provider: config.Provider{ID: "p", BaseURL: upstream.URL, IsActive: true, UseProxy: false},
			Key:      config.Key{ID: "k", Key: "sk", IsActive: true, Proxy: keyProxy},
		}
	}

	// get performs one request through the client chosen for sel.
	get := func(sel *rotation.SelectedKey) (*http.Response, error) {
		req, err := http.NewRequest(http.MethodPost, upstream.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		return h.upstreamClientFor(sel).Do(req)
	}

	// ① 设了 per-key 代理 ⇒ 上游一次都不该被直接打到（请求进了代理）。
	resp, err := get(newSel(proxySrv.URL))
	if err != nil {
		t.Fatalf("per-key proxied request failed: %v", err)
	}
	_ = resp.Body.Close()
	if proxyHits != 1 {
		t.Fatalf("per-key proxy must be used, proxy hits = %d", proxyHits)
	}
	if upstreamHits != 0 {
		t.Fatalf("a per-key proxied request must NOT reach the upstream directly (upstream hits = %d)", upstreamHits)
	}

	// ② 没设 per-key 代理 + provider 级 UseProxy=false ⇒ 真直连（一个字节都不绕）。
	resp, err = get(newSel(""))
	if err != nil {
		t.Fatalf("direct request failed: %v", err)
	}
	_ = resp.Body.Close()
	if upstreamHits != 1 || proxyHits != 1 {
		t.Fatalf("an unset per-key proxy must stay direct: upstream=%d proxy=%d", upstreamHits, proxyHits)
	}

	// ③ per-key 代理**优先于** provider 级开关（账号自己的出口是更具体的意图）。
	sel := newSel(proxySrv.URL)
	sel.Provider.UseProxy = true
	resp, err = get(sel)
	if err != nil {
		t.Fatalf("per-key (overriding provider) request failed: %v", err)
	}
	_ = resp.Body.Close()
	if proxyHits != 2 {
		t.Fatalf("per-key proxy must win over the provider toggle: proxy hits = %d", proxyHits)
	}

	// ④ 非法代理串 ⇒ 忽略并回落直连（用户手输的值不该让 key 变成不可用）。
	resp, err = get(newSel("not a url"))
	if err != nil {
		t.Fatalf("invalid per-key proxy must fall back to direct: %v", err)
	}
	_ = resp.Body.Close()
	if upstreamHits != 2 {
		t.Fatalf("invalid per-key proxy must fall back to direct, upstream hits = %d", upstreamHits)
	}

	// ⑤ 同一个代理串复用同一个 client（连接池按出口隔离，但同一出口不该每次新建）。
	a, okA := h.keyProxyClientsFor(proxySrv.URL)
	b, okB := h.keyProxyClientsFor(proxySrv.URL)
	if !okA || !okB || a != b {
		t.Fatal("the same proxy string must reuse one cached client pair")
	}
	// 流式客户端同样是 per-key 的（长连接不能因为换 key 而串出口）。
	if h.streamClientFor(newSel(proxySrv.URL)) != a.stream {
		t.Fatal("streamClientFor must use the per-key stream client")
	}
}
