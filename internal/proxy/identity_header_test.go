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

// TestFailurePathIdentityHeaders pins the failure-path half of the same
// contract: a failed request must still carry X-TinyLab-Request-Id, otherwise
// the Playground bubble cannot bind its usage entry and the ⓘ request-detail
// view is unreachable exactly when the error needs inspecting.
func TestFailurePathIdentityHeaders(t *testing.T) {
	const reqID = "req-failure-1"

	newHandler := func(t *testing.T) *Handler {
		t.Helper()
		return newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
			config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	}

	t.Run("proxy error without key carries request id only", func(t *testing.T) {
		w := httptest.NewRecorder()
		writeProxyError(w, reqID, nil, http.StatusBadGateway, "all keys exhausted")
		if w.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", w.Code)
		}
		if got := w.Header().Get("X-TinyLab-Request-Id"); got != reqID {
			t.Errorf("X-TinyLab-Request-Id = %q, want %q", got, reqID)
		}
		if got := w.Header().Get("X-TinyLab-Provider"); got != "" {
			t.Errorf("X-TinyLab-Provider = %q, want empty (no key selected)", got)
		}
	})

	t.Run("upstream pass-through error advertises identity", func(t *testing.T) {
		h := newHandler(t)
		w := httptest.NewRecorder()
		resp := &http.Response{
			StatusCode: http.StatusBadRequest,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"bad model"}}`)),
		}
		r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		stopped := h.handleUpstreamError(w, resp, sseSelectedKey(), "prov-1", "gpt-4",
			&retryState{}, r, reqID, []byte("{}"), "http://upstream", time.Now(), "", "")
		if !stopped {
			t.Fatalf("handleUpstreamError = false, want true (pass-through stops the retry loop)")
		}
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		assertIdentityHeaders(t, w, reqID)
		if !strings.Contains(w.Body.String(), "bad model") {
			t.Errorf("body = %q, want relayed upstream error", w.Body.String())
		}
	})
}

// TestRecordNoKeyFailure pins the no-key visibility contract: a terminal
// "all keys exhausted" failure is recorded as an error usage entry (routed to
// the playground ring when the request carries X-TinyLab-Source: playground)
// so Monitor/Playground can show the failure instead of a bare 502.
func TestRecordNoKeyFailure(t *testing.T) {
	h := newTestHandlerWithCustomProvider(t, sseTestProvider("http://localhost:9999"),
		config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300})
	pgBuf := usage.New(50)
	h.SetPgUsage(pgBuf)

	srcHeaders := http.Header{}
	srcHeaders.Set("X-TinyLab-Source", "playground")
	h.recordNoKeyFailure("req-nokey-1", "Test", "gpt-4", "no available keys (all keys exhausted)",
		srcHeaders, "sess-1")

	got, ok := pgBuf.ByID("req-nokey-1")
	if !ok {
		t.Fatalf("playground ring missing the no-key failure entry")
	}
	if got.Status != "error" || got.Source != "playground" || got.Model != "gpt-4" {
		t.Errorf("entry = %+v, want error/playground/gpt-4", got)
	}
	if got.Error == "" {
		t.Errorf("entry error message is empty")
	}
	if got.SessionKey != "sess-1" {
		t.Errorf("session key = %q, want sess-1", got.SessionKey)
	}
}
