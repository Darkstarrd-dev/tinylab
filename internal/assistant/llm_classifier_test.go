package assistant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestLLMClassifier_ParsesToolCalls verifies the smart-assistant reply path
// (item 3): given a mock /v1/chat/completions that returns tool_calls, the
// classifier extracts the chosen tool names (deduped, order-stable). The
// no-network bench cannot exercise this path, so this is the behavioral
// proof that the LLM classifier works end-to-end over a local httptest
// upstream (no external network).
func TestLLMClassifier_ParsesToolCalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "test-model" {
			t.Errorf("expected model test-model, got %v", body["model"])
		}
		if body["tool_choice"] != "auto" {
			t.Errorf("expected tool_choice auto, got %v", body["tool_choice"])
		}
		tools, _ := body["tools"].([]any)
		if len(tools) != 1 {
			t.Fatalf("expected 1 tool offered, got %d", len(tools))
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"1","type":"function","function":{"name":"image.generate"}},{"id":"2","type":"function","function":{"name":"image.generate"}}]}}]}`))
	}))
	defer srv.Close()

	c := &LLMClassifier{
		Client: srv.Client(),
		Addr:   srv.URL,
		Model:  "test-model",
		Tools:  []LLMTool{{Name: "image.generate", Desc: "生成图片"}},
	}
	names, err := c.Classify(context.Background(), "画一只猫")
	if err != nil {
		t.Fatalf("Classify error: %v", err)
	}
	if len(names) != 1 || names[0] != "image.generate" {
		t.Fatalf("expected [image.generate], got %v", names)
	}
}

// TestLLMClassifier_NoToolCalls verifies that an upstream response with no
// tool_calls yields an empty (non-error) result, so the caller falls back to
// the keyword classifier.
func TestLLMClassifier_NoToolCalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"no match"}}]}`))
	}))
	defer srv.Close()

	c := &LLMClassifier{Client: srv.Client(), Addr: srv.URL, Model: "m", Tools: []LLMTool{{Name: "x", Desc: "d"}}}
	names, err := c.Classify(context.Background(), "intent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("expected no names, got %v", names)
	}
}

// TestLLMClassifier_NotConfigured verifies the guard: an unconfigured
// classifier (empty model) errors so the caller falls back.
func TestLLMClassifier_NotConfigured(t *testing.T) {
	c := &LLMClassifier{Addr: "http://x", Model: "", Tools: []LLMTool{{Name: "x"}}}
	if _, err := c.Classify(context.Background(), "intent"); err == nil {
		t.Fatal("expected error when model is empty")
	}
}

// TestLLMClassifier_UpstreamError verifies that a 5xx upstream propagates an
// error so the dispatch path falls back to the keyword brain.
func TestLLMClassifier_UpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &LLMClassifier{Client: srv.Client(), Addr: srv.URL, Model: "m", Tools: []LLMTool{{Name: "x", Desc: "d"}}}
	if _, err := c.Classify(context.Background(), "intent"); err == nil {
		t.Fatal("expected error on upstream 500")
	}
}
