package proxy

import (
	"net/http"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newTransportTestHandler builds a minimal one-provider/one-key handler for
// transport wiring assertions (F-03).
func newTransportTestHandler(t *testing.T) *Handler {
	t.Helper()
	provider := config.Provider{
		ID: "test", Name: "Test Provider", Prefix: "test",
		BaseURL: "http://upstream.invalid", IsActive: true,
		Keys:   []config.Key{{ID: "key1", Key: "sk-test-key-1", Name: "Key One", IsActive: true, Priority: 1}},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	return New(reg, sel, comboRes, usage.New(100), usage.NewQuotaTracker(), console.New(100), 0)
}

func mustTransport(t *testing.T, c *http.Client) *http.Transport {
	t.Helper()
	tr, ok := c.Transport.(*http.Transport)
	if !ok || tr == nil {
		t.Fatalf("client %p has no dedicated *http.Transport (got %T) — would fall back to http.DefaultTransport", c, c.Transport)
	}
	return tr
}

// TestUpstreamTransports_DedicatedPools is the F-03 regression test for the
// pool half of the finding: the proxy main line must not share
// http.DefaultTransport, and the (previously zero-value) proxy transport must
// carry real dial/TLS-handshake/idle timeouts.
func TestUpstreamTransports_DedicatedPools(t *testing.T) {
	h := newTransportTestHandler(t)

	direct := mustTransport(t, h.client)
	if tr := mustTransport(t, h.streamClient); tr != direct {
		t.Fatalf("streamClient must share the direct transport pool, got %p want %p", tr, direct)
	}
	if tr := mustTransport(t, h.mgmtClient); tr != direct {
		t.Fatalf("mgmtClient must share the direct transport pool, got %p want %p", tr, direct)
	}
	if direct == http.DefaultTransport {
		t.Fatal("direct transport must not be http.DefaultTransport (pool is shared with unrelated http.DefaultClient users)")
	}

	proxied := mustTransport(t, h.proxyClient)
	if tr := mustTransport(t, h.proxyStream); tr != proxied {
		t.Fatalf("proxyStream must share the proxy transport pool, got %p want %p", tr, proxied)
	}
	if tr := mustTransport(t, h.mgmtProxyClient); tr != proxied {
		t.Fatalf("mgmtProxyClient must share the proxy transport pool, got %p want %p", tr, proxied)
	}

	for name, tr := range map[string]*http.Transport{"direct": direct, "proxied": proxied} {
		if tr.MaxIdleConnsPerHost != upstreamMaxIdleConnsPerHost {
			t.Fatalf("%s: MaxIdleConnsPerHost=%d, want %d (default 2 closes extra conns under concurrency, forcing re-handshake per request)", name, tr.MaxIdleConnsPerHost, upstreamMaxIdleConnsPerHost)
		}
		if tr.MaxIdleConns != upstreamMaxIdleConns {
			t.Fatalf("%s: MaxIdleConns=%d, want %d", name, tr.MaxIdleConns, upstreamMaxIdleConns)
		}
		if tr.DialContext == nil {
			t.Fatalf("%s: DialContext must be set (zero-value Transport dials with no timeout)", name)
		}
		if tr.TLSHandshakeTimeout != 10*time.Second {
			t.Fatalf("%s: TLSHandshakeTimeout=%v, want 10s", name, tr.TLSHandshakeTimeout)
		}
		if tr.IdleConnTimeout != 90*time.Second {
			t.Fatalf("%s: IdleConnTimeout=%v, want 90s (zero-value proxyTransport kept idle conns forever)", name, tr.IdleConnTimeout)
		}
	}
}

// TestUpstreamTransports_DirectIgnoresEnvProxy is the F-03 regression test for
// the semantics half: with HTTP(S)_PROXY exported, a UseProxy=false provider
// must still get a truly-direct client (Transport.Proxy == nil — environment
// variables are never consulted), while a UseProxy=true provider gets the
// explicitly configured proxy. Loopback exemption in ProxyFromEnvironment
// makes an end-to-end dial test meaningless, so this asserts the wiring
// contract that decides whether env vars are consulted at all.
func TestUpstreamTransports_DirectIgnoresEnvProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")

	h := newTransportTestHandler(t)
	if err := h.SetProxy(true, "127.0.0.1", "7890"); err != nil {
		t.Fatal(err)
	}

	directSel := &rotation.SelectedKey{Provider: config.Provider{UseProxy: false}}
	proxySel := &rotation.SelectedKey{Provider: config.Provider{UseProxy: true}}

	// Sanity: the old code path (nil Transport → http.DefaultTransport) WOULD
	// consult the environment.
	if dt, ok := http.DefaultTransport.(*http.Transport); !ok || dt.Proxy == nil {
		t.Fatal("test premise broken: http.DefaultTransport.Proxy is expected to be ProxyFromEnvironment")
	}

	for name, c := range map[string]*http.Client{
		"upstreamClientFor(UseProxy=false)": h.upstreamClientFor(directSel),
		"streamClientFor(UseProxy=false)":   h.streamClientFor(directSel),
		"ManagementClient(UseProxy=false)":  h.ManagementClient(config.Provider{UseProxy: false}),
	} {
		tr := mustTransport(t, c)
		if tr.Proxy != nil {
			t.Fatalf("%s: direct client must ignore HTTP(S)_PROXY env vars (Proxy must be nil)", name)
		}
	}

	req, err := http.NewRequest("POST", "https://upstream.example/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]*http.Client{
		"upstreamClientFor(UseProxy=true)": h.upstreamClientFor(proxySel),
		"streamClientFor(UseProxy=true)":   h.streamClientFor(proxySel),
		"ManagementClient(UseProxy=true)":  h.ManagementClient(config.Provider{UseProxy: true}),
	} {
		tr := mustTransport(t, c)
		if tr.Proxy == nil {
			t.Fatalf("%s: proxied client lost its proxy policy", name)
		}
		u, err := tr.Proxy(req)
		if err != nil || u == nil || u.String() != "http://127.0.0.1:7890" {
			t.Fatalf("%s: proxy func = %v, %v; want http://127.0.0.1:7890", name, u, err)
		}
	}
}
