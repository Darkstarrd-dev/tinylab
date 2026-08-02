package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "test", Name: "Test Provider", Prefix: "test",
				BaseURL: "http://localhost:9999", IsActive: true,
				Keys: []config.Key{
					{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{
					{ID: "gpt-4", QuotaType: "limited"},
				},
			},
		},
		Rotation: config.RotationConfig{
			Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300,
		},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

func newTestHandlerWithCustomProvider(t *testing.T, provider config.Provider, rotationCfg config.RotationConfig) *Handler {
	t.Helper()
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  rotationCfg,
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

func TestForwardUpstream_Success(t *testing.T) {
	receivedModel := ""
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test-key" {
			t.Error("unexpected Authorization header")
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Error("unexpected Content-Type")
		}
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		json.Unmarshal(body, &parsed)
		receivedModel, _ = parsed["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"test","choices":[{"message":{"content":"hi"}}]}`))
	}))
	defer mockUpstream.Close()

	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: mockUpstream.URL, IsActive: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}

	body := []byte(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`)
	headers := http.Header{"User-Agent": {"test-agent"}}

	resp, err := h.forwardUpstream(context.Background(), sel, body, headers, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	if receivedModel != "gpt-4" {
		t.Fatalf("expected upstream model gpt-4, got %s", receivedModel)
	}

	respBody, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(respBody), `"id":"test"`) {
		t.Fatalf("unexpected response body: %s", string(respBody))
	}
}

func TestForwardUpstream_NetworkError(t *testing.T) {
	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: "http://127.0.0.1:1", IsActive: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}

	body := []byte(`{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`)
	_, err := h.forwardUpstream(context.Background(), sel, body, nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
}

func TestForwardUpstream_UserAgentForwarded(t *testing.T) {
	var receivedUA string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedUA = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer mockUpstream.Close()

	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: mockUpstream.URL, IsActive: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}

	body := []byte(`{"model":"gpt-4"}`)
	headers := http.Header{"User-Agent": {"custom-agent/1.0"}}

	_, err := h.forwardUpstream(context.Background(), sel, body, headers, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}

	if receivedUA != "custom-agent/1.0" {
		t.Fatalf("expected User-Agent custom-agent/1.0, got %s", receivedUA)
	}
}

// captureTransport records the upstream request and returns a canned 200,
// letting cline-domain tests exercise header wiring without network I/O.
type captureTransport struct {
	lastReq *http.Request
}

func (t *captureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.lastReq = req
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(`{}`)),
		Request:    req,
	}, nil
}

func TestForwardUpstream_ClineClientTypeHeader(t *testing.T) {
	tests := []struct {
		name      string
		baseURL   string
		clientVal string // incoming x-client-type, "" = none
		want      string // expected upstream x-client-type, "" = absent
	}{
		{name: "cline_domain_injects", baseURL: "https://api.cline.bot", clientVal: "", want: "cline-cli"},
		{name: "cline_domain_replaces_client_value", baseURL: "https://api.cline.bot", clientVal: "vscode", want: "cline-cli"},
		{name: "cline_path_bearing_base", baseURL: "https://api.cline.bot/api/v1", clientVal: "", want: "cline-cli"},
		{name: "non_cline_absent", baseURL: "https://api.openai.com/v1", clientVal: "", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tr := &captureTransport{}
			h := newTestHandler(t)
			h.client = &http.Client{Transport: tr}
			sel := &rotation.SelectedKey{
				Provider: config.Provider{ID: "test", Name: "Test Provider", Prefix: "test", BaseURL: tt.baseURL, IsActive: true},
				Key:      config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
				KeyName:  "Key Main",
			}
			headers := http.Header{}
			if tt.clientVal != "" {
				headers.Set("X-Client-Type", tt.clientVal)
			}
			resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"cline-free/glm-5.2"}`), headers, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
			if err != nil {
				t.Fatalf("forwardUpstream failed: %v", err)
			}
			resp.Body.Close()
			if got := tr.lastReq.Header.Get("X-Client-Type"); got != tt.want {
				t.Fatalf("upstream x-client-type = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestForwardGetUpstream_ClineClientTypeHeader(t *testing.T) {
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider", Prefix: "test", BaseURL: "https://api.cline.bot", IsActive: true},
		Key:      config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName:  "Key Main",
	}
	resp, err := h.forwardGetUpstream(context.Background(), sel, "/v1/tasks/t1", nil)
	if err != nil {
		t.Fatalf("forwardGetUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Client-Type"); got != "cline-cli" {
		t.Fatalf("upstream x-client-type = %q, want %q", got, "cline-cli")
	}
}

func TestMaskURL(t *testing.T) {
	tests := []struct {
		url  string
		want string
	}{
		{"short", "short"},
		{"https://api.example.com/v1/chat/completions", "https://api.example...."},
	}
	for _, tt := range tests {
		got := maskURL(tt.url)
		if got != tt.want {
			t.Errorf("maskURL(%q) = %q, want %q", tt.url, got, tt.want)
		}
	}
}

func TestForwardUpstream_StreamingSetsAcceptHeader(t *testing.T) {
	var gotAccept string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer mockUpstream.Close()

	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: mockUpstream.URL, IsActive: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}

	body := []byte(`{"model":"gpt-4"}`)
	_, err := h.forwardUpstream(context.Background(), sel, body, nil, true, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}

	if gotAccept != "text/event-stream" {
		t.Fatalf("expected Accept: text/event-stream for stream, got %s", gotAccept)
	}
}

func TestForwardWithRetry_NetworkError(t *testing.T) {
	h := newTestHandler(t)

	body := []byte(`{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`)
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	rb, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(rb), "all keys exhausted") {
		t.Fatalf("expected error body, got: %s", string(rb))
	}
}

func TestSelectKey_Integration(t *testing.T) {
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "test", Name: "Test Provider", Prefix: "test",
				BaseURL: "http://localhost:9999", IsActive: true,
				Keys: []config.Key{
					{ID: "key1", Key: "sk-key1", Name: "Key1", IsActive: true, Priority: 1},
					{ID: "key2", Key: "sk-key2", Name: "Key2", IsActive: true, Priority: 2},
				},
			},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: 2, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)

	selected, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("SelectKey failed: %v", err)
	}
	if selected.Key.ID != "key1" {
		t.Fatalf("expected key1, got %s", selected.Key.ID)
	}

	// Exclude key1
	selected2, err := sel.SelectKey("test", "gpt-4", []string{"key1"})
	if err != nil {
		t.Fatalf("SelectKey with exclude failed: %v", err)
	}
	if selected2.Key.ID != "key2" {
		t.Fatalf("expected key2, got %s", selected2.Key.ID)
	}

	// Exclude both
	_, err = sel.SelectKey("test", "gpt-4", []string{"key1", "key2"})
	if err == nil {
		t.Fatal("expected error when all keys excluded")
	}
}

func TestHandleProxy_InvalidModel(t *testing.T) {
	h := newTestHandler(t)
	body := `{"model":"unknown/model"}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown prefix, got %d", resp.StatusCode)
	}
}

func TestHandleProxy_MissingModel(t *testing.T) {
	h := newTestHandler(t)
	body := `{"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing model, got %d", resp.StatusCode)
	}
}

func TestHandleProxy_InvalidJSON(t *testing.T) {
	h := newTestHandler(t)
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON, got %d", resp.StatusCode)
	}
}

func TestHandleProxy_BadModelFormat(t *testing.T) {
	h := newTestHandler(t)
	body := `{"model":"no-slash"}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad model format, got %d", resp.StatusCode)
	}
}

func TestChatCompletions_SuccessWithMock(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]any
		json.Unmarshal(body, &parsed)
		model, _ := parsed["model"].(string)
		resp := map[string]any{
			"id":    "test-response",
			"model": model,
			"choices": []map[string]any{
				{"message": map[string]any{"content": "hello"}},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer mockUpstream.Close()

	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "test", Name: "Test", Prefix: "test",
				BaseURL: mockUpstream.URL, IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-test", Name: "TestKey", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{
					{ID: "gpt-4", QuotaType: "limited"},
				},
			},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: 2, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	h := New(reg, sel, comboRes, usageBuf, qt, logger, 0)

	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["id"] != "test-response" {
		t.Fatalf("unexpected response id: %v", result["id"])
	}
}

func TestMaxRetries_Default(t *testing.T) {
	h := newTestHandler(t)
	mr := h.maxRetries()
	if mr != 5 {
		t.Fatalf("expected default maxRetries 5, got %d", mr)
	}
}

func TestMaxRetries_Custom(t *testing.T) {
	provider := config.Provider{
		ID: "test", Name: "Test", Prefix: "test",
		BaseURL: "http://localhost:9999", IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
		},
	}
	cfg := config.RotationConfig{Strategy: "fill-first", MaxRetries: 2, BackoffMaxSec: 300}
	h := newTestHandlerWithCustomProvider(t, provider, cfg)
	mr := h.maxRetries()
	if mr != 2 {
		t.Fatalf("expected custom maxRetries 2, got %d", mr)
	}
}

func TestRecordUsage(t *testing.T) {
	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider", Prefix: "test"},
		Key:      config.Key{ID: "key1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
	h.recordUsage("test-id", "test", "gpt-4", sel, "success", 100, 50, 10, 20, "", nil, nil, nil, 0, nil, "", "", "success", "", "")

	// Assert the entry actually landed in the usage ring buffer.
	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("expected usage to be *usage.RingBuffer, got %T", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	e := entries[0]
	if e.Provider != "Test Provider" {
		t.Errorf("Provider = %q, want Test Provider", e.Provider)
	}
	if e.Model != "gpt-4" {
		t.Errorf("Model = %q, want gpt-4", e.Model)
	}
	if e.KeyName != "K1" {
		t.Errorf("KeyName = %q, want K1", e.KeyName)
	}
	if e.InputTokens != 10 || e.OutputTokens != 20 {
		t.Errorf("tokens = in=%d out=%d, want in=10 out=20", e.InputTokens, e.OutputTokens)
	}
	if e.Status != "success" {
		t.Errorf("Status = %q, want success", e.Status)
	}
}

func TestAfterMaxRetries_WithMock(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":"rate limit exceeded"}`))
	}))
	defer mockUpstream.Close()

	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "test", Name: "Test", Prefix: "test",
				BaseURL: mockUpstream.URL, IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{
					{ID: "gpt-4", QuotaType: "limited"},
				},
			},
		},
		Rotation: config.RotationConfig{
			Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300,
		},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	h := New(reg, sel, comboRes, usageBuf, qt, logger, 0)

	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	bodyBytes, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(bodyBytes), "all keys exhausted") {
		t.Fatalf("expected error body, got: %s", string(bodyBytes))
	}
}

func TestWriteError(t *testing.T) {
	w := httptest.NewRecorder()
	writeError(w, http.StatusBadRequest, "test error")

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	errObj, ok := result["error"].(map[string]any)
	if !ok {
		t.Fatal("expected error object")
	}
	if errObj["message"] != "test error" {
		t.Fatalf("unexpected error message: %v", errObj["message"])
	}
}

func TestInjectStreamOptions(t *testing.T) {
	// Mock upstream that captures the request body and returns a 200 chat completion.
	var capturedBody string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		capturedBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"done"}}]}`))
	}))
	defer mockUpstream.Close()

	provider := config.Provider{
		ID: "test", Name: "Test", Prefix: "test",
		BaseURL:          mockUpstream.URL,
		IsActive:         true,
		InjectStreamOpts: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
	cfg := config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300}

	reg := registry.New(&config.Config{Providers: []config.Provider{provider}, Rotation: cfg})
	sel := rotation.New(reg, &cfg)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	h := New(reg, sel, comboRes, usageBuf, qt, logger, 0)

	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}],"stream":true}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// Assert stream_options.include_usage was injected into the upstream request body.
	var sent map[string]any
	if err := json.Unmarshal([]byte(capturedBody), &sent); err != nil {
		t.Fatalf("failed to parse captured upstream body: %v", err)
	}
	so, ok := sent["stream_options"].(map[string]any)
	if !ok {
		t.Fatalf("expected stream_options in upstream body, got: %s", capturedBody)
	}
	if so["include_usage"] != true {
		t.Errorf("expected stream_options.include_usage = true, got %v", so["include_usage"])
	}
}

func TestListModels(t *testing.T) {
	h := newTestHandler(t)
	w := httptest.NewRecorder()
	h.ListModels(w, req(t))

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	data, ok := result["data"].([]any)
	if !ok {
		t.Fatal("expected data array")
	}
	if len(data) == 0 {
		t.Fatal("expected at least one model")
	}
	entry := data[0].(map[string]any)
	if entry["id"] != "test/gpt-4" {
		t.Fatalf("expected model id test/gpt-4, got %v", entry["id"])
	}
}

func req(t *testing.T) *http.Request {
	t.Helper()
	return httptest.NewRequest("GET", "/v1/models", nil)
}

func TestParseAndUpdateQuota(t *testing.T) {
	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: "https://modelscope.cn/v1", IsActive: true,
			Keys: []config.Key{
				{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
			},
		},
		Key:     config.Key{ID: "key1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
		KeyName: "K1",
	}

	headers := http.Header{}
	headers.Set("Modelscope-Ratelimit-Model-Requests-Limit", "100")
	headers.Set("Modelscope-Ratelimit-Model-Requests-Remaining", "80")

	h.parseAndUpdateQuota(sel, "test", "gpt-4", headers)

	keyState := h.reg.GetKeyState("test", "key1")
	if keyState == nil {
		t.Fatal("expected key state")
	}
	quota := keyState.GetQuota("gpt-4")
	if quota == nil {
		t.Fatal("expected quota info")
	}
	if quota.ModelLimit != 100 {
		t.Fatalf("expected ModelLimit 100, got %d", quota.ModelLimit)
	}
	if quota.ModelRemaining != 80 {
		t.Fatalf("expected ModelRemaining 80, got %d", quota.ModelRemaining)
	}
}

func TestHandleProxy_StreamRequest(t *testing.T) {
	// Verify stream=true flag is parsed correctly through handleProxy
	h := newTestHandler(t)
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}],"stream":true}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	// Since upstream doesn't exist, should return 502
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 for stream with no upstream, got %d", resp.StatusCode)
	}
}

func TestComboResponse_Fallback(t *testing.T) {
	// Combo with two targets: first fails (500), second succeeds.
	// The handler must fall back to the second target and return 200.
	failUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer failUpstream.Close()

	okUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"done"}}]}`))
	}))
	defer okUpstream.Close()

	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: failUpstream.URL, IsActive: true,
				Keys:   []config.Key{{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1}},
				Models: []config.ModelDef{{ID: "m1", QuotaType: "limited"}},
			},
			{
				ID: "p2", Name: "P2", Prefix: "p2", BaseURL: okUpstream.URL, IsActive: true,
				Keys:   []config.Key{{ID: "k2", Key: "sk-2", Name: "K2", IsActive: true, Priority: 1}},
				Models: []config.ModelDef{{ID: "m2", QuotaType: "limited"}},
			},
		},
		Combos: []config.Combo{
			{ID: "cb", Name: "cb", Strategy: "fallback", Models: []string{"p1/m1", "p2/m2"}},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	h := New(reg, sel, comboRes, usageBuf, qt, logger, 0)

	body := `{"model":"cb","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after fallback, got %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["id"] != "ok" {
		t.Fatalf("expected id ok from second provider, got %v", result["id"])
	}
}

func TestRoundTrip_Success(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"done"}}]}`))
	}))
	defer mockUpstream.Close()

	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "rt", Name: "RoundTrip", Prefix: "rt",
				BaseURL: mockUpstream.URL, IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
			},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: 2, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	h := New(reg, sel, comboRes, usageBuf, qt, logger, 0)

	body := `{"model":"rt/gpt-4","messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["id"] != "ok" {
		t.Fatalf("expected id ok, got %v", result["id"])
	}
}

func TestParseAndUpdateQuota_NoHeaders(t *testing.T) {
	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test", Prefix: "test",
			BaseURL: "http://localhost:9999", IsActive: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-1", Name: "K1"},
		KeyName: "K1",
	}
	// nil/empty headers should not panic
	h.parseAndUpdateQuota(sel, "test", "gpt-4", http.Header{})
}

func TestDebugMode(t *testing.T) {
	h := newTestHandler(t)
	if h.debugMode() {
		t.Fatal("expected debugMode false by default")
	}
	h.SetDebugModeProvider(func() bool { return true })
	if !h.debugMode() {
		t.Fatal("expected debugMode true after setting provider")
	}
}

func TestRecordUsage_DebugModeCapture(t *testing.T) {
	h := newTestHandler(t)
	h.SetDebugModeProvider(func() bool { return true })

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider"},
		Key:      config.Key{ID: "k1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
	headers := http.Header{"X-Custom": {"val"}}
	h.recordUsage("test-id", "test", "gpt-4", sel, "success", 100, 50, 10, 20, "", []byte(`{"req":true}`), []byte(`{"resp":true}`), headers, 200, nil, "", "", "success", "", "")
}

func TestManagementClient(t *testing.T) {
	h := newTestHandler(t)

	// UseProxy=false always returns the direct client.
	if got := h.ManagementClient(config.Provider{UseProxy: false}); got != h.mgmtClient {
		t.Fatalf("expected mgmtClient for UseProxy=false, got %p want %p", got, h.mgmtClient)
	}

	// UseProxy=true but SetProxy not called (proxyURL nil) → still the direct client.
	if got := h.ManagementClient(config.Provider{UseProxy: true}); got != h.mgmtClient {
		t.Fatalf("expected mgmtClient when proxy not configured, got %p want %p", got, h.mgmtClient)
	}

	// UseProxy=true with proxy configured → proxy client.
	if err := h.SetProxy(true, "127.0.0.1", "2080"); err != nil {
		t.Fatalf("SetProxy: %v", err)
	}
	if got := h.ManagementClient(config.Provider{UseProxy: true}); got != h.mgmtProxyClient {
		t.Fatalf("expected mgmtProxyClient for UseProxy=true with proxy set, got %p want %p", got, h.mgmtProxyClient)
	}
}

func TestManagementClient_RoutesViaProxy(t *testing.T) {
	// Mirrors TestForwardUpstream_UseProxy but asserts the ManagementClient
	// selection actually forwards a management probe through the proxy.
	var upstreamHits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamHits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	var proxyHits int32
	parsedUpstream, _ := url.Parse(upstream.URL)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxyHits, 1)
		r.URL.Scheme = parsedUpstream.Scheme
		r.URL.Host = parsedUpstream.Host
		r.RequestURI = ""
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	defer proxySrv.Close()

	proxyURL, _ := url.Parse(proxySrv.URL)
	proxyHost := proxyURL.Hostname()
	proxyPort := proxyURL.Port()

	h := newTestHandler(t)
	if err := h.SetProxy(true, proxyHost, proxyPort); err != nil {
		t.Fatalf("SetProxy: %v", err)
	}

	req, _ := http.NewRequest("GET", upstream.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer sk-test")
	resp, err := h.ManagementClient(config.Provider{UseProxy: true}).Do(req)
	if err != nil {
		t.Fatalf("ManagementClient request failed: %v", err)
	}
	resp.Body.Close()

	if atomic.LoadInt32(&proxyHits) != 1 {
		t.Fatalf("expected 1 proxy hit for ManagementClient UseProxy=true, got %d", proxyHits)
	}
	if atomic.LoadInt32(&upstreamHits) != 1 {
		t.Fatalf("expected 1 upstream hit, got %d", upstreamHits)
	}
}

func TestSetProxy(t *testing.T) {
	h := newTestHandler(t)

	// Disabled and empty host/port must leave proxyURL nil (no proxying) and not error.
	if err := h.SetProxy(false, "127.0.0.1", "2080"); err != nil {
		t.Fatalf("expected nil error when disabled, got %v", err)
	}
	if u, _ := h.proxyURL.Load().(*url.URL); u != nil {
		t.Fatalf("expected nil proxyURL when disabled, got %v", u)
	}
	if err := h.SetProxy(true, "", "2080"); err != nil {
		t.Fatalf("expected nil error when host empty (disable), got %v", err)
	}
	if u, _ := h.proxyURL.Load().(*url.URL); u != nil {
		t.Fatalf("expected nil proxyURL when host empty, got %v", u)
	}
	if err := h.SetProxy(true, "127.0.0.1", ""); err != nil {
		t.Fatalf("expected nil error when port empty (disable), got %v", err)
	}
	if u, _ := h.proxyURL.Load().(*url.URL); u != nil {
		t.Fatalf("expected nil proxyURL when port empty, got %v", u)
	}

	// Valid proxy configuration stores a *url.URL.
	if err := h.SetProxy(true, "127.0.0.1", "2080"); err != nil {
		t.Fatalf("SetProxy: %v", err)
	}
	u, ok := h.proxyURL.Load().(*url.URL)
	if !ok || u == nil {
		t.Fatalf("expected non-nil *url.URL proxyURL, got %v", h.proxyURL.Load())
	}
	if u.Host != "127.0.0.1:2080" {
		t.Fatalf("expected proxy host 127.0.0.1:2080, got %s", u.Host)
	}

	// http:// scheme prefix on host is tolerated.
	if err := h.SetProxy(true, "http://127.0.0.1", "2080"); err != nil {
		t.Fatalf("SetProxy with http:// prefix: %v", err)
	}
	u, _ = h.proxyURL.Load().(*url.URL)
	if u == nil || u.Host != "127.0.0.1:2080" {
		t.Fatalf("expected scheme-stripped host 127.0.0.1:2080, got %v", u)
	}

	// https:// scheme prefix on host is also tolerated.
	if err := h.SetProxy(true, "https://127.0.0.1", "2080"); err != nil {
		t.Fatalf("SetProxy with https:// prefix: %v", err)
	}
	u, _ = h.proxyURL.Load().(*url.URL)
	if u == nil || u.Host != "127.0.0.1:2080" {
		t.Fatalf("expected scheme-stripped host 127.0.0.1:2080, got %v", u)
	}

	// Invalid port returns an error and leaves proxyURL nil (no silent failure).
	if err := h.SetProxy(true, "127.0.0.1", "abc"); err == nil {
		t.Fatal("expected error for non-numeric port, got nil")
	}
	if u, _ := h.proxyURL.Load().(*url.URL); u != nil {
		t.Fatalf("expected nil proxyURL after invalid port, got %v", u)
	}

	// Out-of-range port returns an error and leaves proxyURL nil.
	if err := h.SetProxy(true, "127.0.0.1", "70000"); err == nil {
		t.Fatal("expected error for out-of-range port, got nil")
	}
	if u, _ := h.proxyURL.Load().(*url.URL); u != nil {
		t.Fatalf("expected nil proxyURL after out-of-range port, got %v", u)
	}
}

func TestForwardUpstream_UseProxy(t *testing.T) {
	// upstream: the real target the provider points at.
	var upstreamHits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamHits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"done"}}]}`))
	}))
	defer upstream.Close()

	// proxySrv: a forward proxy that relays to upstream and records the hit.
	var proxyHits int32
	parsedUpstream, _ := url.Parse(upstream.URL)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxyHits, 1)
		// Rewrite the request target to point at the upstream and forward it.
		r.URL.Scheme = parsedUpstream.Scheme
		r.URL.Host = parsedUpstream.Host
		r.RequestURI = ""
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for k, vs := range resp.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	defer proxySrv.Close()

	proxyURL, _ := url.Parse(proxySrv.URL)
	proxyHost := proxyURL.Hostname()
	proxyPort := proxyURL.Port()

	// Case 1: UseProxy=false → upstream hit directly, proxy bypassed.
	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: upstream.URL, IsActive: true, UseProxy: false,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if atomic.LoadInt32(&upstreamHits) != 1 {
		t.Fatalf("expected 1 upstream hit, got %d", upstreamHits)
	}
	if atomic.LoadInt32(&proxyHits) != 0 {
		t.Fatalf("expected 0 proxy hits for UseProxy=false, got %d", proxyHits)
	}

	// Case 2: UseProxy=true (with SetProxy) → request routed via proxySrv,
	// which forwards to upstream.
	if err := h.SetProxy(true, proxyHost, proxyPort); err != nil {
		t.Fatalf("SetProxy: %v", err)
	}
	sel.Provider.UseProxy = true
	resp2, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream (proxy) failed: %v", err)
	}
	resp2.Body.Close()
	if atomic.LoadInt32(&upstreamHits) != 2 {
		t.Fatalf("expected 2 upstream hits after proxy, got %d", upstreamHits)
	}
	if atomic.LoadInt32(&proxyHits) != 1 {
		t.Fatalf("expected 1 proxy hit for UseProxy=true, got %d", proxyHits)
	}
}

func TestForwardUpstream_UseProxyDisabledStillDirect(t *testing.T) {
	// Even with UseProxy=true, if SetProxy was never called (proxyURL nil),
	// the request must still go directly to upstream.
	var upstreamHits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamHits, 1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: upstream.URL, IsActive: true, UseProxy: true,
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if atomic.LoadInt32(&upstreamHits) != 1 {
		t.Fatalf("expected upstream hit when proxy disabled, got %d", upstreamHits)
	}
}
