package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/usage"
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

// TestSSEContentLength_TextMarker covers the provider-agnostic live OUT
// estimate: Anthropic content_block_delta carries incremental text in
// delta.text ("text":"..."), not delta.content. Both markers must count.
func TestSSEContentLength_TextMarker(t *testing.T) {
	openai := []byte(`{"choices":[{"delta":{"content":"hello"}}]}`)
	if got := sseContentLength(openai); got != 5 {
		t.Errorf("content marker: got %d, want 5", got)
	}
	anthropic := []byte(`{"delta":{"text":"hello world"}}`)
	if got := sseContentLength(anthropic); got != 11 {
		t.Errorf("text marker: got %d, want 11", got)
	}
	escaped := []byte(`{"delta":{"text":"a\"b"}}`)
	if got := sseContentLength(escaped); got != 3 {
		t.Errorf("escaped quote: got %d, want 3", got)
	}
	none := []byte(`{"usage":{"output_tokens":5}}`)
	if got := sseContentLength(none); got != 0 {
		t.Errorf("no text field: got %d, want 0", got)
	}
}

// TestSSESplit_RES_CT_Segregation covers the RES/CT column split: reasoning
// deltas must land in RES only, content deltas in CT only. This is the
// llama.cpp reasoning-model shape (reasoning_content during thinking,
// content for the body).
func TestSSESplit_RES_CT_Segregation(t *testing.T) {
	reasoning := []byte(`{"choices":[{"delta":{"reasoning_content":"hello"}}]}`)
	if got := sseContentLength(reasoning); got != 0 {
		t.Errorf("CT must ignore reasoning_content: got %d, want 0", got)
	}
	if got := sseReasoningLength(reasoning); got != 5 {
		t.Errorf("RES reasoning_content: got %d, want 5", got)
	}
	content := []byte(`{"choices":[{"delta":{"content":"hello world"}}]}`)
	if got := sseReasoningLength(content); got != 0 {
		t.Errorf("RES must ignore content: got %d, want 0", got)
	}
	if got := sseContentLength(content); got != 11 {
		t.Errorf("CT content: got %d, want 11", got)
	}
	// Responses reasoning summary shape.
	respReason := []byte(`{"type":"response.reasoning_summary_text.delta","delta":"think"}`)
	if got := sseContentLength(respReason); got != 5 {
		t.Errorf("CT responses delta: got %d, want 5", got)
	}
	// Pure-toolcall shape: post-reasoning output arrives as tool_calls[]
	// function.arguments with content:null — arguments count as CT, never RES.
	toolcall := []byte(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pel"}}]}}]}`)
	if got := sseContentLength(toolcall); got != 3 {
		t.Errorf("CT toolcall arguments: got %d, want 3", got)
	}
	if got := sseReasoningLength(toolcall); got != 0 {
		t.Errorf("RES must ignore toolcall arguments: got %d, want 0", got)
	}
}

// TestCountContentSplit_MixedStreamDedup covers the opencode.ai mixed stream:
// each increment arrives twice (native Responses event + translated chat
// chunk). The translated row counts; the native duplicate within the window
// is suppressed. A lone native row (pure passthrough, no translation seen)
// still counts.
func TestCountContentSplit_MixedStreamDedup(t *testing.T) {
	native := []byte(`{"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"Test"}`)
	translated := []byte(`{"choices":[{"delta":{"content":"Test"}}]}`)
	var last int64
	// Pure passthrough first: native row counts.
	if ct, _ := countContentSplit(native, 1000, &last); ct != 4 {
		t.Errorf("lone native: got %d, want 4", ct)
	}
	// Translated row counts and stamps.
	if ct, _ := countContentSplit(translated, 2000, &last); ct != 4 {
		t.Errorf("translated: got %d, want 4", ct)
	}
	// Native duplicate inside the window is suppressed.
	if ct, _ := countContentSplit(native, 2100, &last); ct != 0 {
		t.Errorf("suppressed native: got %d, want 0", ct)
	}
	// After the window the native row counts again (new stream phase).
	if ct, _ := countContentSplit(native, 2000+3000, &last); ct != 4 {
		t.Errorf("native past window: got %d, want 4", ct)
	}
}

// TestStreamResponse_ReasoningSplitTerminal covers the llama reasoning-model
// stream end to end: reasoning-phase chunks accumulate RES, body chunks CT,
// and the terminal entry records the split alongside the aggregate.
func TestStreamResponse_ReasoningSplitTerminal(t *testing.T) {
	// Payloads sized past the chars/4 estimate grain (single chunks under 4
	// chars round to 0).
	raw := "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking hard here\"}}]}\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"hello world body\"}}]}\n" +
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
	h.streamResponse(w, resp, "qwen-reason", sel, 5, []byte("{}"), false, "test-reason-split", nil, "", combo.EntryFormatOpenAI, "", "")

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	e := entries[0]
	if e.ReasoningTokens == 0 {
		t.Errorf("expected non-zero ReasoningTokens, got 0 (entry=%+v)", e)
	}
	if e.ContentTokens == 0 {
		t.Errorf("expected non-zero ContentTokens, got 0 (entry=%+v)", e)
	}
	if e.OutputTokens != e.ReasoningTokens+e.ContentTokens {
		t.Errorf("expected OutputTokens=%d to equal RES+CT=%d+%d",
			e.OutputTokens, e.ReasoningTokens, e.ContentTokens)
	}
}

// TestEntryTracker_RefreshKeepsTimestamp verifies the GT-jump fix: Refresh
// must record liveness without moving Entry.Timestamp (the frontend GT/TTFT
// anchor), while SweepStale still honors refreshed liveness.
func TestEntryTracker_RefreshKeepsTimestamp(t *testing.T) {
	tracker := NewEntryTracker()
	start := time.Now().Add(-5 * time.Minute)
	tracker.Register(usage.Entry{ID: "req-1", Status: "processing", Timestamp: start})
	tracker.Refresh("req-1")
	e, _ := tracker.Get("req-1")
	if !e.Timestamp.Equal(start) {
		t.Fatalf("Refresh moved Timestamp: was %v, now %v", start, e.Timestamp)
	}
	// Refreshed just now: must NOT sweep with a 1-minute maxAge even though
	// Timestamp is 5 minutes old.
	if stale := tracker.SweepStale(time.Minute); len(stale) != 0 {
		t.Fatalf("expected refreshed entry to survive sweep, got %d stale", len(stale))
	}
	// Without refresh an old entry still sweeps.
	tracker.Register(usage.Entry{ID: "req-old", Status: "processing", Timestamp: start})
	// Backdate its heartbeat by re-registering semantics: remove + add old.
	tracker.Remove("req-old")
	tracker.Register(usage.Entry{ID: "req-old", Status: "processing", Timestamp: start})
	tracker.mu.Lock()
	tracker.lastActive["req-old"] = start
	tracker.mu.Unlock()
	if stale := tracker.SweepStale(time.Minute); len(stale) != 1 {
		t.Fatalf("expected 1 stale entry, got %d", len(stale))
	}
}

// TestStreamResponseAnthropic_TerminalFallbackNoUsage covers the Anthropic
// path of the same fallback: message deltas with text but no message_delta
// usage must still record non-zero OUT via the text-marker estimate.
func TestStreamResponseAnthropic_TerminalFallbackNoUsage(t *testing.T) {
	raw := "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hello\"}}\n" +
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\" world\"}}\n" +
		"data: {\"type\":\"message_stop\"}\n"

	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()
	w := httptest.NewRecorder()

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(raw)),
	}
	h.streamResponse(w, resp, "claude", sel, 5, []byte("{}"), false, "test-req-id", nil, "", combo.EntryFormatAnthropic, "", "")

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	if entries[0].OutputTokens == 0 {
		t.Fatalf("anthropic text fallback failed: output tokens must be non-zero, got 0")
	}
}

// TestSSEHasEncryptedReasoning covers the RES=enc sentinel trigger: an
// "encrypted_content" value marks opaque reasoning; empty/null values and
// unrelated payloads do not.
func TestSSEHasEncryptedReasoning(t *testing.T) {
	enc := []byte(`{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"Q-PaDgFM"}}`)
	if !sseHasEncryptedReasoning(enc) {
		t.Errorf("expected encrypted_content to flag opaque reasoning")
	}
	empty := []byte(`{"item":{"type":"reasoning","encrypted_content":""}}`)
	if sseHasEncryptedReasoning(empty) {
		t.Errorf("empty encrypted_content must not flag")
	}
	plain := []byte(`{"choices":[{"delta":{"content":"hello"}}]}`)
	if sseHasEncryptedReasoning(plain) {
		t.Errorf("plain content must not flag")
	}
}

// TestCountContentSplit_NativeDoneEchoSuppressed covers the delta+done dedup:
// native Responses terminal echoes (output_item.done re-emitting accumulated
// text via "text":"...") are not incremental and must not count. *.delta
// rows still count on a pure-passthrough stream.
func TestCountContentSplit_NativeDoneEchoSuppressed(t *testing.T) {
	var last int64
	delta := []byte(`{"type":"response.output_text.delta","delta":"hello"}`)
	if ct, _ := countContentSplit(delta, 1000, &last); ct != 5 {
		t.Errorf("delta row: got %d, want 5", ct)
	}
	done := []byte(`{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}`)
	if ct, res := countContentSplit(done, 2000, &last); ct != 0 || res != 0 {
		t.Errorf("done echo: got ct=%d res=%d, want 0,0", ct, res)
	}
	completed := []byte(`{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}`)
	if ct, res := countContentSplit(completed, 3000, &last); ct != 0 || res != 0 {
		t.Errorf("completed echo: got ct=%d res=%d, want 0,0", ct, res)
	}
}

// TestStreamResponse_EncryptedReasoningSentinel covers the end-to-end enc
// path: a native Responses stream with encrypted reasoning and one commentary
// delta records ReasoningTokens=-1 (rendered "enc"), keeps CT from the
// delta only (done echo not double-counted), and keeps OUT == CT.
func TestStreamResponse_EncryptedReasoningSentinel(t *testing.T) {
	commentary := "sort commentary here resync now"
	raw := "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"encrypted_content\":\"Q-PaDgFM\"}}\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"" + commentary + "\"}\n" +
		"data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"" + commentary + "\"}]}}\n" +
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
	h.streamResponse(w, resp, "muse-spark", sel, 5, []byte("{}"), false, "test-enc-sentinel", nil, "", combo.EntryFormatOpenAIResponses, "", "")

	rb, ok := h.usage.(*usage.RingBuffer)
	if !ok {
		t.Fatalf("usage is %T, expected *usage.RingBuffer", h.usage)
	}
	entries := rb.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 usage entry, got %d", len(entries))
	}
	e := entries[0]
	if e.ReasoningTokens != reasoningEncryptedSentinel {
		t.Errorf("expected ReasoningTokens=%d (enc), got %d (entry=%+v)", reasoningEncryptedSentinel, e.ReasoningTokens, e)
	}
	wantCt := len(commentary) / 4
	if e.ContentTokens != wantCt {
		t.Errorf("expected ContentTokens=%d (single-counted delta), got %d (entry=%+v)", wantCt, e.ContentTokens, e)
	}
	if e.OutputTokens != e.ContentTokens {
		t.Errorf("expected OutputTokens=%d to equal CT (enc normalizes to 0), got %d", e.ContentTokens, e.OutputTokens)
	}
}
