package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// mockSSEUpstream returns an httptest server that streams the given raw SSE
// body in two chunks (to exercise the Read loop boundary) and then closes.
func mockSSEUpstream(t *testing.T, rawBody string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		mid := len(rawBody) / 2
		w.Write([]byte(rawBody[:mid]))
		if flusher != nil {
			flusher.Flush()
		}
		time.Sleep(10 * time.Millisecond)
		w.Write([]byte(rawBody[mid:]))
		if flusher != nil {
			flusher.Flush()
		}
	}))
}

func sseTestProvider(baseURL string) config.Provider {
	return config.Provider{
		ID: "test", Name: "Test", Prefix: "test", BaseURL: baseURL, IsActive: true,
		Keys:   []config.Key{{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1}},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
}

// selectedKey returns a SelectedKey matching sseTestProvider.
func sseSelectedKey() *rotation.SelectedKey {
	return &rotation.SelectedKey{
		Provider: sseTestProvider("http://localhost:9999"),
		Key:      config.Key{ID: "k1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
}

// TestStreamResponse_NonNormalizeNoDuplicate verifies the P1.4 fix: when the
// upstream SSE chunk has no trailing newline, streamResponse must not emit the
// trailing fragment twice in the non-normalize path.
func TestStreamResponse_NonNormalizeNoDuplicate(t *testing.T) {
	// The last line "data: [DONE]" has NO trailing newline. The read loop
	// splits into "data: {...}" and "data: [DONE]" (remaining, no newline).
	// The non-normalize path writes the whole buffer in the loop and must NOT
	// re-write the remaining fragment at EOF.
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n" +
		"data: [DONE]"

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

	out := w.Body.String()
	count := strings.Count(out, "data: [DONE]")
	if count != 1 {
		t.Fatalf("expected exactly 1 'data: [DONE]' in output, got %d\n--- output ---\n%s", count, out)
	}
}

// TestStreamResponse_NormalizePathVariable covers the normalize path too, to
// ensure normalize keeps producing valid output and counts tokens.
func TestStreamResponse_NormalizePathVariable(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n" +
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
	h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), true, "test-req-id", nil, "", combo.EntryFormatOpenAI, "", "")

	out := w.Body.String()
	if strings.Count(out, "data: [DONE]") != 1 {
		t.Fatalf("expected exactly 1 [DONE] in normalize path, got %d\n%s", strings.Count(out, "data: [DONE]"), out)
	}
}

// TestStreamResponse_TokenExtraction verifies usage is recorded with extracted
// token counts when the SSE carries usage information.
func TestStreamResponse_TokenExtraction(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n" +
		"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n" +
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
	if entries[0].OutputTokens == 0 {
		t.Errorf("expected output tokens > 0 from usage chunk, got %d", entries[0].OutputTokens)
	}
}

// TestStreamResponse_ClientCancel verifies that when the request context is
// canceled mid-stream, streamResponse returns without blocking forever
// (P1.5 context propagation / P3.12).
func TestStreamResponse_ClientCancel(t *testing.T) {
	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	sel := sseSelectedKey()
	w := httptest.NewRecorder()

	ctx, cancel := context.WithCancel(context.Background())
	blockingBody := io.NopCloser(&cancelReader{ctx: ctx, data: []byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n")})
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       blockingBody,
	}

	done := make(chan struct{})
	go func() {
		h.streamResponse(w, resp, "gpt-4", sel, 5, []byte("{}"), false, "test-req-id", nil, "", combo.EntryFormatOpenAI, "", "")
		close(done)
	}()

	// Cancel immediately; streamResponse should finish quickly.
	cancel()
	select {
	case <-done:
		// success
	case <-time.After(2 * time.Second):
		t.Fatal("streamResponse did not return after context cancel")
	}
}

// cancelReader is an io.Reader whose Read returns the initial data once, then
// blocks until ctx is canceled.
type cancelReader struct {
	ctx  context.Context
	data []byte
	sent bool
}

func (c *cancelReader) Read(p []byte) (int, error) {
	if !c.sent {
		c.sent = true
		return copy(p, c.data), nil
	}
	select {
	case <-c.ctx.Done():
		return 0, c.ctx.Err()
	case <-time.After(100 * time.Millisecond):
		return 0, nil
	}
}
