package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// TestSessionKey_EndToEnd_FlowedToEntryAndConsoleLog drives a real chat
// request through handleProxy against a mock upstream and confirms:
//   - the recorded usage Entry carries a non-empty SessionKey (so /usage JSON
//     exposes it), and
//   - the console log lines tag the request with [|sess:<8hex>].
//
// A second turn of the SAME conversation (same system + first-user root, more
// messages) must record the SAME SessionKey (continuity inference), a
// different first-user message must yield a different key, and a single-shot
// request with no user message must yield an empty key (ungrouped) with no
// |sess: tag in its console REQUEST line.
func TestSessionKey_EndToEnd_FlowedToEntryAndConsoleLog(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"r","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`))
	}))
	defer mockUpstream.Close()

	provider := config.Provider{
		ID: "test", Name: "Test Provider", Prefix: "test",
		BaseURL: mockUpstream.URL, IsActive: true,
		Keys:   []config.Key{{ID: "key1", Key: "sk-test-key", Name: "Key Main", IsActive: true, Priority: 1}},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
	h := newTestHandlerWithCustomProvider(t, provider, config.RotationConfig{
		Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300,
	})
	logger := h.logger.(*console.Logger)

	send := func(body string) {
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	}

	// Turn 1: system + first user (the conversation root).
	send(`{"model":"test/gpt-4","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What is 2+2?"}]}`)

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("expected *usage.RingBuffer, got %T", h.usage)
	}
	entries := rb.All()
	if len(entries) == 0 {
		t.Fatal("expected at least one usage entry after request")
	}
	first := entries[0]
	if first.SessionKey == "" {
		t.Fatal("expected non-empty SessionKey on usage entry")
	}
	if len(first.SessionKey) != 8 {
		t.Fatalf("expected 8-char SessionKey, got %q (len %d)", first.SessionKey, len(first.SessionKey))
	}

	// Console log must carry the |sess:<key> tag on at least one line.
	var foundTag bool
	for _, line := range logger.AllLines() {
		if strings.Contains(line, "|sess:"+first.SessionKey) {
			foundTag = true
			break
		}
	}
	if !foundTag {
		t.Fatalf("expected a console line tagged with |sess:%s", first.SessionKey)
	}

	// Turn 2: same root, appended assistant + user turn → same SessionKey.
	send(`{"model":"test/gpt-4","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What is 2+2?"},{"role":"assistant","content":"4"},{"role":"user","content":"And 3+3?"}]}`)
	entries = rb.All()
	if len(entries) < 2 {
		t.Fatalf("expected >=2 entries after second turn, got %d", len(entries))
	}
	if entries[0].SessionKey != entries[1].SessionKey {
		t.Fatalf("continuity broken: turn1 key %s != turn2 key %s", entries[1].SessionKey, entries[0].SessionKey)
	}

	// A DIFFERENT conversation (different first-user message) → different key.
	send(`{"model":"test/gpt-4","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Translate this to French."}]}`)
	entries = rb.All()
	if entries[0].SessionKey == entries[1].SessionKey {
		t.Fatalf("different first-user message must yield different SessionKey, both %s", entries[0].SessionKey)
	}

	// A single-shot request with NO user message → empty SessionKey (ungrouped),
	// and its console REQUEST line must NOT carry |sess:.
	send(`{"model":"test/gpt-4","messages":[{"role":"system","content":"system only"}]}`)
	entries = rb.All()
	if entries[0].SessionKey != "" {
		t.Fatalf("system-only (no user) must yield empty SessionKey, got %q", entries[0].SessionKey)
	}
	var lastRequest string
	for _, line := range logger.AllLines() {
		if strings.Contains(line, "] REQUEST ") {
			lastRequest = line
		}
	}
	if strings.Contains(lastRequest, "|sess:") {
		t.Fatalf("ungrouped request line should not carry |sess: : %s", lastRequest)
	}
}
