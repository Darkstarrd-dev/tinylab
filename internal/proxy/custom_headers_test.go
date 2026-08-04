package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
)

func TestForwardUpstream_CustomHeaders(t *testing.T) {
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL:          "https://api.example.com/v1",
			IsActive:         true,
			UseCustomHeaders: true,
			CustomHeaders:    map[string]string{"X-Provider-Tag": "acme", "X-Other": "v2"},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Provider-Tag"); got != "acme" {
		t.Errorf("X-Provider-Tag = %q, want acme", got)
	}
	if got := tr.lastReq.Header.Get("X-Other"); got != "v2" {
		t.Errorf("X-Other = %q, want v2", got)
	}
}

func TestForwardUpstream_CustomHeadersDisabledNoOp(t *testing.T) {
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL: "https://api.example.com/v1", IsActive: true,
			UseCustomHeaders: false,
			CustomHeaders:    map[string]string{"X-Provider-Tag": "acme"},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Provider-Tag"); got != "" {
		t.Errorf("X-Provider-Tag = %q, want empty (disabled)", got)
	}
}

func TestForwardUpstream_CustomHeadersOverrideGenerated(t *testing.T) {
	var gotAuth, gotContentType, gotAccept string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotAccept = r.Header.Get("Accept")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer mockUpstream.Close()

	h := newTestHandler(t)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL:          mockUpstream.URL,
			IsActive:         true,
			UseCustomHeaders: true,
			CustomHeaders: map[string]string{
				"Authorization": "Bearer custom-secret",
				"Content-Type":  "application/x-custom",
				"Accept":        "application/json",
			},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	// Streaming path: the generated Accept: text/event-stream must be
	// overridden by the custom Accept value.
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, true, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if gotAuth != "Bearer custom-secret" {
		t.Errorf("Authorization = %q, want custom override", gotAuth)
	}
	if gotContentType != "application/x-custom" {
		t.Errorf("Content-Type = %q, want custom override", gotContentType)
	}
	if gotAccept != "application/json" {
		t.Errorf("Accept = %q, want custom override of text/event-stream", gotAccept)
	}
}

func TestForwardUpstream_CustomHeadersClinePrecedence(t *testing.T) {
	// api.cline.bot: the hardcoded applyClineHeaders must beat a custom
	// X-Client-Type configured for the same provider.
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL:          "https://api.cline.bot",
			IsActive:         true,
			UseCustomHeaders: true,
			CustomHeaders:    map[string]string{"X-Client-Type": "vscode"},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"cline-free/glm-5.2"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Client-Type"); got != "cline-cli" {
		t.Errorf("X-Client-Type = %q, want hardcoded cline-cli override", got)
	}
}

func TestForwardUpstream_CustomHeadersCRLFRejected(t *testing.T) {
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL:          "https://api.example.com/v1",
			IsActive:         true,
			UseCustomHeaders: true,
			CustomHeaders: map[string]string{
				"X-Clean":        "ok",
				"X-Injected\r\n": "evil",
				"X-Sneaky":       "bad\r\nInjected: yes",
			},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{"model":"gpt-4"}`), nil, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Clean"); got != "ok" {
		t.Errorf("X-Clean = %q, want ok", got)
	}
	if got := tr.lastReq.Header.Get("X-Sneaky"); got != "" {
		t.Errorf("X-Sneaky = %q, want empty (CRLF rejected)", got)
	}
}

func TestForwardGetUpstream_CustomHeaders(t *testing.T) {
	tr := &captureTransport{}
	h := newTestHandler(t)
	h.client = &http.Client{Transport: tr}
	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "test", Name: "Test Provider", Prefix: "test",
			BaseURL:          "https://api.example.com/v1",
			IsActive:         true,
			UseCustomHeaders: true,
			CustomHeaders:    map[string]string{"X-Provider-Tag": "poll"},
		},
		Key:     config.Key{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1},
		KeyName: "Key Main",
	}
	resp, err := h.forwardGetUpstream(context.Background(), sel, "/v1/tasks/t1", nil)
	if err != nil {
		t.Fatalf("forwardGetUpstream failed: %v", err)
	}
	resp.Body.Close()
	if got := tr.lastReq.Header.Get("X-Provider-Tag"); got != "poll" {
		t.Errorf("X-Provider-Tag = %q, want poll", got)
	}
}
