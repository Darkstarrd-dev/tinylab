package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/api/probe"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// sampleConfig returns a minimal config with one provider (p1/Prov1) that has
// one active key (k1/Key1/sk-test) and one model (m1, limited quota).
func sampleConfig(baseURL string) *config.Config {
	return &config.Config{
		Providers: []config.Provider{
			{
				ID:      "p1",
				Name:    "Prov1",
				BaseURL: baseURL,
				Keys: []config.Key{
					{ID: "k1", Name: "Key1", Key: "sk-test", IsActive: true},
				},
				Models: []config.ModelDef{
					{ID: "m1", QuotaType: "limited"},
				},
			},
		},
	}
}

// serveProtoTest routes through chi so that chi.URLParam resolves the provider id.
func serveProtoTest(t *testing.T, h *probe.Handler, providerID, model, proto string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"model": model, "proto": proto})
	req := httptest.NewRequest(http.MethodPost, "/providers/"+providerID+"/models/test-proto", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	r := chi.NewRouter()
	h.Register(r)
	r.ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------------------
// Happy-path tests: each proto returns a single-probe result with the expected
// protocol field and a 200 status.
// ---------------------------------------------------------------------------

func TestTestProviderModelProto_OpenAICompat(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "p1", "m1", config.ProtocolOpenAICompat)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}

	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rec.Body.String())
	}
	if proto, _ := out["protocol"].(string); proto != "openai-compat" {
		t.Fatalf("protocol = %q, want openai-compat", proto)
	}
	if ok, _ := out["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %+v", out)
	}
	// Verify the full field set matches probeResultToMap shape.
	for _, f := range []string{"protocol", "ok", "status", "latencyMs", "error", "skipped", "request", "responseHeaders", "responseBody", "responseBodyRaw"} {
		if _, ok := out[f]; !ok {
			t.Fatalf("response missing field %q", f)
		}
	}
}

func TestTestProviderModelProto_OpenAIResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"output":[]}`))
	}))
	defer srv.Close()

	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "p1", "m1", config.ProtocolOpenAIResponses)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}

	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rec.Body.String())
	}
	if proto, _ := out["protocol"].(string); proto != "openai-responses" {
		t.Fatalf("protocol = %q, want openai-responses", proto)
	}
}

func TestTestProviderModelProto_Anthropic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[]}`))
	}))
	defer srv.Close()

	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "p1", "m1", config.ProtocolAnthropic)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}

	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rec.Body.String())
	}
	if proto, _ := out["protocol"].(string); proto != "anthropic" {
		t.Fatalf("protocol = %q, want anthropic", proto)
	}
}

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

func TestTestProviderModelProto_InvalidProto(t *testing.T) {
	srv := okServer(t)
	defer srv.Close()
	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "p1", "m1", "bogus")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid proto, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestTestProviderModelProto_EmptyModel(t *testing.T) {
	srv := okServer(t)
	defer srv.Close()
	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	body, _ := json.Marshal(map[string]string{"model": "", "proto": config.ProtocolOpenAICompat})
	req := httptest.NewRequest(http.MethodPost, "/providers/p1/models/test-proto", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r := chi.NewRouter()
	h.Register(r)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty model, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestTestProviderModelProto_ProviderNotFound(t *testing.T) {
	srv := okServer(t)
	defer srv.Close()
	cfg := sampleConfig(srv.URL)
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "ghost", "m1", config.ProtocolOpenAICompat)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing provider, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestTestProviderModelProto_NoActiveKey(t *testing.T) {
	srv := okServer(t)
	defer srv.Close()
	cfg := sampleConfig(srv.URL)
	cfg.Providers[0].Keys[0].IsActive = false
	rt, _ := newTestRouter(t, cfg)

	h := probe.NewHandler(&apibase.Deps{
		Reg:          rt.reg,
		ProxyHandler: rt.proxyHandler,
		Logger:       rt.logger,
	})

	rec := serveProtoTest(t, h, "p1", "m1", config.ProtocolOpenAICompat)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for no active key, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}
