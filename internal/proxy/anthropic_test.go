package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newAnthropicTestHandler builds a handler whose single provider is an
// apiType=anthropic provider pointed at the given BaseURL.
func newAnthropicTestHandler(t *testing.T, baseURL, version, beta string) *Handler {
	t.Helper()
	provider := config.Provider{
		ID:               "anth",
		Name:             "Anthropic",
		Prefix:           "anth",
		BaseURL:          baseURL,
		APIType:          "anthropic",
		AnthropicVersion: version,
		AnthropicBeta:    beta,
		IsActive:         true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-ant-key", Name: "AnthKey", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "claude-3-5-sonnet", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// newOpenAITestHandlerURL builds a handler whose single provider is a standard
// OpenAI-compatible provider pointed at the given BaseURL.
func newOpenAITestHandlerURL(t *testing.T, baseURL string) *Handler {
	t.Helper()
	provider := config.Provider{
		ID: "openai", Name: "OpenAI", Prefix: "openai",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-openai-key", Name: "OpenKey", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// TestMessages_AnthropicProvider_HeaderSet verifies that a request hitting the
// /v1/messages entry with an anthropic provider forwards with x-api-key and
// anthropic-version headers, and crucially does NOT send an Authorization header.
func TestMessages_AnthropicProvider_HeaderSet(t *testing.T) {
	var (
		gotXAPIKey       string
		gotAnthropicVer  string
		gotAnthropicBeta string
		gotAuthorization string
		gotContentType   string
		gotURL           string
		gotBody          string
	)
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXAPIKey = r.Header.Get("x-api-key")
		gotAnthropicVer = r.Header.Get("anthropic-version")
		gotAnthropicBeta = r.Header.Get("anthropic-beta")
		gotAuthorization = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotURL = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}`))
	}))
	defer mockUpstream.Close()

	h := newAnthropicTestHandler(t, mockUpstream.URL+"/v1/messages", "2023-06-01", "tools-2024-04-04")

	body := `{"model":"anth/claude-3-5-sonnet","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Messages(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	if gotXAPIKey != "sk-ant-key" {
		t.Errorf("expected x-api-key sk-ant-key, got %q", gotXAPIKey)
	}
	if gotAnthropicVer != "2023-06-01" {
		t.Errorf("expected anthropic-version 2023-06-01, got %q", gotAnthropicVer)
	}
	if gotAnthropicBeta != "tools-2024-04-04" {
		t.Errorf("expected anthropic-beta tools-2024-04-04, got %q", gotAnthropicBeta)
	}
	if gotAuthorization != "" {
		t.Errorf("anthropic entry must NOT set Authorization header, got %q", gotAuthorization)
	}
	if gotContentType != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", gotContentType)
	}
	// URL must NOT inject another /v1/messages; base already contains the endpoint.
	if gotURL != "/v1/messages" {
		t.Errorf("expected upstream path /v1/messages, got %q", gotURL)
	}
	// Body must be forwarded unchanged (no OpenAI<->Anthropic translation).
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("failed to parse upstream body: %v", err)
	}
	if sent["model"] != "claude-3-5-sonnet" {
		t.Errorf("expected upstream model claude-3-5-sonnet, got %v", sent["model"])
	}
}

// TestMessages_NonAnthropicProvider_Forwarded verifies the soft strategy: the
// /v1/messages entry no longer rejects a request merely because the resolved
// provider's APIType != "anthropic". The entry still routes through
// buildAnthropicUpstreamRequest (x-api-key header, no Authorization) because
// the upstream construction is driven by entryFormat, not provider.APIType.
func TestMessages_NonAnthropicProvider_Forwarded(t *testing.T) {
	var (
		gotXAPIKey       string
		gotAuthorization string
		gotURL           string
	)
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXAPIKey = r.Header.Get("x-api-key")
		gotAuthorization = r.Header.Get("Authorization")
		gotURL = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}`))
	}))
	defer mockUpstream.Close()

	h := newOpenAITestHandlerURL(t, mockUpstream.URL)

	body := `{"model":"openai/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Messages(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	// Soft strategy: must NOT be rejected with 400.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 (forwarded), got %d", resp.StatusCode)
	}
	// Still built as an anthropic upstream request by entry protocol.
	if gotXAPIKey != "sk-openai-key" {
		t.Errorf("expected x-api-key sk-openai-key from the openai provider key, got %q", gotXAPIKey)
	}
	if gotAuthorization != "" {
		t.Errorf("anthropic entry must NOT set Authorization header, got %q", gotAuthorization)
	}
	if gotURL != "/v1/messages" {
		t.Errorf("expected upstream path /v1/messages, got %q", gotURL)
	}
}

// TestChatCompletions_OpenAIProvider_AuthorizationHeader is a regression guard:
// the OpenAI entry must still use the Authorization: Bearer header and must NOT
// set anthropic-specific headers.
func TestChatCompletions_OpenAIProvider_AuthorizationHeader(t *testing.T) {
	var (
		gotAuthorization string
		gotXAPIKey       string
		gotAnthropicVer  string
	)
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		gotXAPIKey = r.Header.Get("x-api-key")
		gotAnthropicVer = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"hi"}}]}`))
	}))
	defer mockUpstream.Close()

	h := newOpenAITestHandlerURL(t, mockUpstream.URL)

	body := `{"model":"openai/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if gotAuthorization != "Bearer sk-openai-key" {
		t.Errorf("expected Authorization Bearer sk-openai-key, got %q", gotAuthorization)
	}
	if gotXAPIKey != "" {
		t.Errorf("OpenAI entry must NOT set x-api-key, got %q", gotXAPIKey)
	}
	if gotAnthropicVer != "" {
		t.Errorf("OpenAI entry must NOT set anthropic-version, got %q", gotAnthropicVer)
	}
}

// TestMessages_AnthropicProvider_HostRootAppendsPath verifies that when the
// anthropic provider BaseURL is a host-root (no /v1/messages), the proxy appends
// /v1/messages itself.
func TestMessages_AnthropicProvider_HostRootAppendsPath(t *testing.T) {
	var gotURL string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"msg_1","type":"message"}`))
	}))
	defer mockUpstream.Close()

	h := newAnthropicTestHandler(t, mockUpstream.URL, "2023-06-01", "")

	body := `{"model":"anth/claude-3-5-sonnet","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Messages(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if gotURL != "/v1/messages" {
		t.Errorf("expected appended upstream path /v1/messages, got %q", gotURL)
	}
}

// TestBuildUpstreamRequest_AnthropicHeaders verifies the low-level request
// builder uses x-api-key + anthropic-version and no Authorization.
func TestBuildUpstreamRequest_AnthropicHeaders(t *testing.T) {
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "anth", Name: "Anthropic", Prefix: "anth",
			BaseURL:          "https://api.anthropic.com/v1/messages",
			APIType:          "anthropic",
			AnthropicVersion: "2023-06-01",
			AnthropicBeta:    "tools-2024-04-04",
		},
		Key:     config.Key{ID: "k1", Key: "sk-ant-key", Name: "AnthKey"},
		KeyName: "AnthKey",
	}
	url, req, err := buildUpstreamRequest(context.Background(), sel, []byte(`{"model":"claude"}`), "/v1/messages", false)
	if err != nil {
		t.Fatalf("buildUpstreamRequest failed: %v", err)
	}
	if url != "https://api.anthropic.com/v1/messages" {
		t.Errorf("expected verbatim URL, got %q", url)
	}
	if req.Header.Get("x-api-key") != "sk-ant-key" {
		t.Errorf("expected x-api-key sk-ant-key, got %q", req.Header.Get("x-api-key"))
	}
	if req.Header.Get("anthropic-version") != "2023-06-01" {
		t.Errorf("expected anthropic-version 2023-06-01, got %q", req.Header.Get("anthropic-version"))
	}
	if req.Header.Get("anthropic-beta") != "tools-2024-04-04" {
		t.Errorf("expected anthropic-beta tools-2024-04-04, got %q", req.Header.Get("anthropic-beta"))
	}
	if req.Header.Get("Authorization") != "" {
		t.Errorf("must not set Authorization, got %q", req.Header.Get("Authorization"))
	}
	// Note: the Accept: text/event-stream header is applied by forwardUpstream
	// (shared by both OpenAI and Anthropic paths) after the request is built,
	// so it is intentionally absent at the builder level.
}

// TestBuildAnthropicUpstreamRequest_DefaultVersion verifies the version defaults
// to 2023-06-01 when not configured.
func TestBuildUpstreamRequest_DefaultAnthropicVersion(t *testing.T) {
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "anth", Name: "Anthropic", Prefix: "anth",
			BaseURL: "https://api.anthropic.com/v1/messages",
			APIType: "anthropic",
		},
		Key:     config.Key{ID: "k1", Key: "sk-ant-key", Name: "AnthKey"},
		KeyName: "AnthKey",
	}
	_, req, err := buildUpstreamRequest(context.Background(), sel, nil, "/v1/messages", false)
	if err != nil {
		t.Fatalf("buildUpstreamRequest failed: %v", err)
	}
	if req.Header.Get("anthropic-version") != "2023-06-01" {
		t.Errorf("expected default anthropic-version 2023-06-01, got %q", req.Header.Get("anthropic-version"))
	}
	// No beta configured → header must be absent.
	if req.Header.Get("anthropic-beta") != "" {
		t.Errorf("expected no anthropic-beta header, got %q", req.Header.Get("anthropic-beta"))
	}
}
