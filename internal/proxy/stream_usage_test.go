package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// TestStreamResponse_TerminalFallbackNoUsage covers the review +4/A3 fix:
// when the upstream never emits a usage chunk (no include_usage injection, or
// the gateway stripped it), the terminal record must fall back to the SSE
// content-character estimate so the output column is non-zero.
func TestStreamResponse_TerminalFallbackNoUsage(t *testing.T) {
	// Content deltas only — no usage chunk anywhere in the stream.
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n" +
		"data: [DONE]\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()
	w := httptest.NewRecorder()

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-req-id", nil, "", combo.EntryFormatOpenAI, "", "")

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	// contentCharsTotal counts unescaped "content" chars ("hello"=5, " world"=6);
	// /4 rounds to 2, so the terminal fallback must be > 0.
	if entries[0].OutputTokens == 0 {
		t.Fatalf("terminal fallback failed: output tokens must be non-zero when upstream sends no usage, got 0 (content=%d)", entries[0].OutputTokens)
	}
}

// TestStreamResponse_ConditionalPerFieldStore covers the review +5 fix: a
// usage chunk carrying only one of the two token counts must not clobber the
// other back to 0. Before the fix, `if in>0 || out>0 { inputTokens=in;
// outputTokens=out }` would reset input to 0 on an output-only chunk.
func TestStreamResponse_ConditionalPerFieldStore(t *testing.T) {
	// Chunk 1: only prompt_tokens (10). Chunk 2: only completion_tokens (5).
	// The output-only chunk must NOT reset input to 0.
	raw := "data: {\"usage\":{\"prompt_tokens\":10}}\n" +
		"data: {\"usage\":{\"completion_tokens\":5}}\n" +
		"data: [DONE]\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()
	w := httptest.NewRecorder()

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-req-id", nil, "", combo.EntryFormatOpenAI, "", "")

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	if entries[0].InputTokens != 10 {
		t.Errorf("expected input tokens 10 preserved across output-only usage chunk, got %d", entries[0].InputTokens)
	}
	if entries[0].OutputTokens != 5 {
		t.Errorf("expected output tokens 5, got %d", entries[0].OutputTokens)
	}
}
