package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/api/probe"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/customheaders"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// newTestRouter builds a minimal Router wired to an in-memory registry, a real
// proxy.Handler (so ManagementClient works), a quota tracker, and a temp config
// file used to observe saveConfig side effects.
func newTestRouter(t *testing.T, cfg *config.Config) (*Router, string) {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")

	reg := registry.New(cfg)
	ph := proxy.New(reg, nil, nil, usage.New(100), usage.NewQuotaTracker(), console.New(100), 5)
	rt := &Router{
		deps: deps{
			reg:          reg,
			configPath:   cfgPath,
			quotaTracker: usage.NewQuotaTracker(),
			logger:       console.New(100),
			proxyHandler: ph,
		},
	}
	return rt, cfgPath
}

// okServer returns 200 for every request (regardless of path/method).
func okServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
}

// newTestProbeHandler creates a minimal probe handler for static probe helper tests.
func newTestProbeHandler() *probe.Handler {
	return probe.NewHandler(nil)
}

func decodeProbeResult(t *testing.T, srv *httptest.Server, fn func(ctx context.Context, client *http.Client, baseURL, model, apiKey string, custom customheaders.Config, onOK probe.ProbeQuotaHook) probe.ProbeResult) (probe.ProbeResult, map[string]any) {
	t.Helper()
	client := srv.Client()
	res := fn(context.Background(), client, srv.URL, "model-x", "sk-test", customheaders.Config{}, nil)
	reqMap, _ := res.Request["body"].(map[string]any)
	return res, reqMap
}

func TestProbe_OpenAICompat_Success(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	res, body := decodeProbeResult(t, srv, h.ProbeOpenAICompat)
	if !res.Ok {
		t.Fatalf("expected Ok=true, got %+v (err=%q)", res, res.Error)
	}
	if gotPath != "/v1/chat/completions" {
		t.Fatalf("path = %q, want /v1/chat/completions", gotPath)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth = %q, want Bearer sk-test", gotAuth)
	}
	if _, hasMessages := body["messages"]; !hasMessages {
		t.Fatalf("body missing 'messages': %+v", body)
	}
	if _, hasInput := body["input"]; hasInput {
		t.Fatalf("openai-compat body should not have 'input': %+v", body)
	}
}

func TestProbe_OpenAIResponses_Success(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"output":[]}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	res, body := decodeProbeResult(t, srv, h.ProbeOpenAIResponses)
	if !res.Ok {
		t.Fatalf("expected Ok=true, got %+v (err=%q)", res, res.Error)
	}
	if gotPath != "/v1/responses" {
		t.Fatalf("path = %q, want /v1/responses", gotPath)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth = %q, want Bearer sk-test", gotAuth)
	}
	if _, hasInput := body["input"]; !hasInput {
		t.Fatalf("responses body missing 'input': %+v", body)
	}
	if _, hasMessages := body["messages"]; hasMessages {
		t.Fatalf("responses body should not have 'messages': %+v", body)
	}
}

func TestProbe_Anthropic_Success(t *testing.T) {
	var gotPath, gotXAPIKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotXAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[]}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	res, body := decodeProbeResult(t, srv, h.ProbeAnthropic)
	if !res.Ok {
		t.Fatalf("expected Ok=true, got %+v (err=%q)", res, res.Error)
	}
	if gotPath != "/v1/messages" {
		t.Fatalf("path = %q, want /v1/messages", gotPath)
	}
	if gotXAPIKey != "sk-test" {
		t.Fatalf("x-api-key = %q, want sk-test", gotXAPIKey)
	}
	if gotVersion != "2023-06-01" {
		t.Fatalf("anthropic-version = %q, want 2023-06-01", gotVersion)
	}
	if _, hasMessages := body["messages"]; !hasMessages {
		t.Fatalf("anthropic body missing 'messages': %+v", body)
	}
}

func TestProbe_OpenAICompat_Failure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	res, _ := decodeProbeResult(t, srv, h.ProbeOpenAICompat)
	if res.Ok {
		t.Fatalf("expected Ok=false, got %+v", res)
	}
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.Status)
	}
	if !strings.Contains(res.Error, "500") {
		t.Fatalf("error should mention status code, got %q", res.Error)
	}
}
func TestProbe_CustomHeadersApplied(t *testing.T) {
	var gotCustom, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCustom = r.Header.Get("X-Provider-Tag")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	client := srv.Client()
	custom := customheaders.Config{Enabled: true, Headers: map[string]string{
		"X-Provider-Tag": "acme",
		"Authorization":  "Bearer custom-secret",
	}}
	res := h.ProbeOpenAICompat(context.Background(), client, srv.URL, "model-x", "sk-test", custom, nil)
	if !res.Ok {
		t.Fatalf("expected Ok=true, got %+v (err=%q)", res, res.Error)
	}
	if gotCustom != "acme" {
		t.Errorf("X-Provider-Tag = %q, want acme", gotCustom)
	}
	if gotAuth != "Bearer custom-secret" {
		t.Errorf("Authorization = %q, want custom override Bearer custom-secret", gotAuth)
	}
}

func TestProbe_CustomHeadersDisabledNoOp(t *testing.T) {
	var gotCustom string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCustom = r.Header.Get("X-Provider-Tag")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	h := newTestProbeHandler()
	client := srv.Client()
	res := h.ProbeOpenAICompat(context.Background(), client, srv.URL, "model-x", "sk-test", customheaders.Config{Enabled: true, Headers: nil}, nil)
	if !res.Ok {
		t.Fatalf("expected Ok=true, got %+v (err=%q)", res, res.Error)
	}
	if gotCustom != "" {
		t.Errorf("X-Provider-Tag = %q, want empty", gotCustom)
	}
}
