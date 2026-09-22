package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
)

// TestResponseIdentityHeaders pins the response-header contract the Playground
// relies on: X-TinyLab-Provider / X-TinyLab-Key identify the serving key and
// X-TinyLab-Request-Id carries the internal request ID, which is how a response
// bubble binds itself to its usage/monitor entry. Every response path that
// advertises provider/key must also carry the request ID.
func TestResponseIdentityHeaders(t *testing.T) {
	const reqID = "req-identity-1"

	newHandler := func(t *testing.T) *Handler {
		t.Helper()
		return newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
			config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	}

	t.Run("streaming", func(t *testing.T) {
		h := newHandler(t)
		w := httptest.NewRecorder()
		resp := &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n")),
		}
		h.streamResponse(w, resp, "gpt-4", sseSelectedKey(), 5, []byte("{}"), false, reqID, nil, "", combo.EntryFormatOpenAI, "", "")
		assertIdentityHeaders(t, w, reqID)
	})

	t.Run("non-streaming", func(t *testing.T) {
		h := newHandler(t)
		w := httptest.NewRecorder()
		resp := &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`)),
		}
		h.passThroughResponse(w, resp, "gpt-4", sseSelectedKey(), 5, []byte("{}"), reqID, nil, "", "gpt-4", "")
		assertIdentityHeaders(t, w, reqID)
	})

	t.Run("empty request id omits header", func(t *testing.T) {
		w := httptest.NewRecorder()
		setUpstreamIdentityHeaders(w, sseSelectedKey(), "")
		if got := w.Header().Get("X-TinyLab-Request-Id"); got != "" {
			t.Fatalf("X-TinyLab-Request-Id = %q, want empty", got)
		}
		if got := w.Header().Get("X-TinyLab-Key"); got != "K1" {
			t.Fatalf("X-TinyLab-Key = %q, want K1", got)
		}
	})
}

func assertIdentityHeaders(t *testing.T, w *httptest.ResponseRecorder, wantReqID string) {
	t.Helper()
	if got := w.Header().Get("X-TinyLab-Request-Id"); got != wantReqID {
		t.Errorf("X-TinyLab-Request-Id = %q, want %q", got, wantReqID)
	}
	if got := w.Header().Get("X-TinyLab-Provider"); got != "Test" {
		t.Errorf("X-TinyLab-Provider = %q, want Test", got)
	}
	if got := w.Header().Get("X-TinyLab-Key"); got != "K1" {
		t.Errorf("X-TinyLab-Key = %q, want K1", got)
	}
}
