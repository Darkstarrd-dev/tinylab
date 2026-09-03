package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
)

// TestStreamSignature_RoundTrip verifies the full pipeline: the proxy caches a
// Gemini thought_signature as it streams the first response, then replays it
// into the client's second request (whose assistant tool_calls lack the field)
// before forwarding to the upstream.
func TestStreamSignature_RoundTrip(t *testing.T) {
	var round2Body string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		round2Body = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"done"}}]}`))
	}))
	defer mockUpstream.Close()

	geminiBase := "http://generativelanguage.googleapis.com/v1beta/openai"
	provider := config.Provider{
		ID: "gem", Name: "Gemini", Prefix: "gem",
		BaseURL:  geminiBase,
		IsActive: true,
		Keys:     []config.Key{{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1}},
		Models:   []config.ModelDef{{ID: "gemini", QuotaType: "limited"}},
	}
	h := newTestHandlerWithCustomProvider(t, provider,
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})

	// Route the gemini host to the local mock server.
	mockU, _ := url.Parse(mockUpstream.URL)
	dialer := func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, mockU.Host)
	}
	h.client.Transport = &http.Transport{DialContext: dialer}

	sel := &rotation.SelectedKey{
		Provider: provider,
		Key:      config.Key{ID: "k1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}

	// Round 1: stream a response carrying the thought_signature.
	raw := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"extra_content\":{\"google\":{\"thought_signature\":\"Eo4GCosG===\"}},\"function\":{\"name\":\"task\",\"arguments\":\"{}\"},\"id\":\"FL1tqiJ9\",\"type\":\"function\"}],\"index\":0}}]}\n" +
		"data: [DONE]\n"
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	w1 := httptest.NewRecorder()
	h.streamResponse(w1, resp, "gemini", sel, 5, []byte("{}"), false, "req-1", nil, "", combo.EntryFormatOpenAI, "", "")

	if sig, ok := h.sigCache.Get("FL1tqiJ9"); !ok || sig != "Eo4GCosG===" {
		t.Fatalf("expected cached sig Eo4GCosG===, got %q ok=%v", sig, ok)
	}

	// Round 2: client returns the assistant tool_calls WITHOUT the signature.
	parsed := map[string]any{
		"model": "gem/gemini",
		"messages": []any{
			map[string]any{"role": "user", "content": "use task"},
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":       "FL1tqiJ9",
						"type":     "function",
						"function": map[string]any{"name": "task", "arguments": "{}"},
					},
				},
			},
			map[string]any{"role": "tool", "tool_call_id": "FL1tqiJ9", "content": "result"},
		},
	}

	w2 := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	ok, _ := h.forwardWithRetry(w2, req, "gem", "gemini", "/v1/chat/completions", nil, parsed, false, 2, "", "Gem", combo.EntryFormatOpenAI, "", "")
	if !ok {
		t.Fatalf("forwardWithRetry failed for round 2")
	}

	var sent map[string]any
	if err := json.Unmarshal([]byte(round2Body), &sent); err != nil {
		t.Fatalf("failed to parse round-2 upstream body: %v", err)
	}
	msgs := sent["messages"].([]any)
	asst := msgs[1].(map[string]any)
	tc := asst["tool_calls"].([]any)[0].(map[string]any)
	extra, ok := tc["extra_content"].(map[string]any)
	if !ok {
		t.Fatalf("expected extra_content backfilled into round-2 request, body=%s", round2Body)
	}
	google := extra["google"].(map[string]any)
	if google["thought_signature"] != "Eo4GCosG===" {
		t.Fatalf("expected backfilled thought_signature Eo4GCosG===, body=%s", round2Body)
	}
}
