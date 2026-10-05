package proxy

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newStreamTimeoutHandler builds a handler whose provider has two active keys
// and per-provider stream timeouts (F-02). ttfbSec/idleSec are applied as
// StreamTTFBTimeoutSec/StreamIdleTimeoutSec.
func newStreamTimeoutHandler(t *testing.T, baseURL string, ttfbSec, idleSec int) (*Handler, *usage.RingBuffer) {
	t.Helper()
	provider := config.Provider{
		ID: "test", Name: "Test Provider", Prefix: "test",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "key1", Key: "sk-test-key-1", Name: "Key One", IsActive: true, Priority: 1},
			{ID: "key2", Key: "sk-test-key-2", Name: "Key Two", IsActive: true, Priority: 2},
		},
		Models:               []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
		StreamTTFBTimeoutSec: &ttfbSec,
		StreamIdleTimeoutSec: &idleSec,
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	rb := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, rb, qt, logger, 0), rb
}

func streamRequest() (map[string]any, string) {
	body := `{"model":"test/gpt-4","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	parsed := map[string]any{
		"model":    "gpt-4",
		"stream":   true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	return parsed, body
}

// TestStreamTTFBTimeout_FailsOver is the F-02 regression test for the
// first-byte bound: an upstream that accepts the request but never sends
// response headers must trip the TTFB timeout, cool the key via the
// network-error branch, and fail over to the next key.
func TestStreamTTFBTimeout_FailsOver(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The body must be fully read first — otherwise net/http never starts
		// the background read that detects the peer closing the connection,
		// and the server-side request context is never canceled (hangs Close).
		_, _ = io.Copy(io.Discard, r.Body)
		if r.Header.Get("Authorization") == "Bearer sk-test-key-1" {
			// Hung gateway: connected, request accepted, headers never come.
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fl.Flush()
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	h, rb := newStreamTimeoutHandler(t, srv.URL, 1, 5)

	parsed, body := streamRequest()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()

	done := make(chan bool, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, true, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
		done <- ok
	}()

	select {
	case ok := <-done:
		if !ok {
			t.Fatal("expected failover to key2 to succeed")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("request did not finish — TTFB timeout/failover did not fire")
	}

	if !strings.Contains(w.Body.String(), "hi") {
		t.Fatalf("expected streamed content from key2, got %q", w.Body.String())
	}

	ks1 := h.reg.GetKeyState("test", "key1")
	ks1.Lock()
	locks1, level1 := len(ks1.ModelLocks), ks1.BackoffLevel
	ks1.Unlock()
	if locks1 == 0 || level1 == 0 {
		t.Fatalf("key1 must be cooled after the TTFB timeout (locks=%d backoffLevel=%d)", locks1, level1)
	}
	ks2 := h.reg.GetKeyState("test", "key2")
	ks2.Lock()
	locks2 := len(ks2.ModelLocks)
	ks2.Unlock()
	if locks2 != 0 {
		t.Fatalf("key2 served the request and must not be cooled (locks=%d)", locks2)
	}

	var sawTimeoutErr, sawSuccess bool
	for _, e := range rb.All() {
		if e.Status == "error" && e.KeyID == "key1" && strings.Contains(e.Error, "first-byte timeout") {
			sawTimeoutErr = true
		}
		if e.Status == "success" && e.KeyID == "key2" {
			sawSuccess = true
		}
	}
	if !sawTimeoutErr {
		t.Error("expected a key1 error usage entry mentioning the first-byte timeout")
	}
	if !sawSuccess {
		t.Error("expected a key2 success usage entry")
	}
}

// TestStreamIdleTimeout_AbortsStream is the F-02 regression test for the idle
// bound: an upstream that sends headers and one chunk and then goes silent
// forever must be aborted after the idle window. The 200 is already committed
// to the client, so no failover is possible — the attempt must terminate
// (freeing goroutine and connection) and be recorded as an error, and the
// key must NOT be cooled (partial data was delivered; the key is not proven
// faulty for routing purposes).
func TestStreamIdleTimeout_AbortsStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		fl.Flush()
		// Half-open stream: never send again, never close.
		<-r.Context().Done()
	}))
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	h, rb := newStreamTimeoutHandler(t, srv.URL, 5, 1)

	parsed, body := streamRequest()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()

	done := make(chan bool, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, true, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
		done <- ok
	}()

	select {
	case ok := <-done:
		if !ok {
			t.Fatal("expected forwardWithRetry to return after the aborted stream (200 was committed)")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream did not terminate — idle timeout did not fire")
	}

	if !strings.Contains(w.Body.String(), "partial") {
		t.Fatalf("expected the partial chunk to reach the client, got %q", w.Body.String())
	}

	var sawIdleErr bool
	for _, e := range rb.All() {
		if e.Status == "error" && strings.Contains(e.Error, "stream idle timeout") {
			sawIdleErr = true
			if e.Decision != "stream idle timeout" {
				t.Errorf("Decision = %q, want %q", e.Decision, "stream idle timeout")
			}
		}
	}
	if !sawIdleErr {
		t.Error("expected an error usage entry mentioning the stream idle timeout")
	}

	for _, keyID := range []string{"key1", "key2"} {
		ks := h.reg.GetKeyState("test", keyID)
		ks.Lock()
		locks, inflight := len(ks.ModelLocks), ks.InFlight
		ks.Unlock()
		if locks != 0 {
			t.Errorf("key %s must not be cooled on a mid-stream idle timeout (locks=%d)", keyID, locks)
		}
		if inflight != 0 {
			t.Errorf("key %s in-flight not released (inflight=%d)", keyID, inflight)
		}
	}
}

// TestStreamTimeouts_Resolution pins the per-provider override contract:
// nil = default, <=0 = disabled, positive = override.
func TestStreamTimeouts_Resolution(t *testing.T) {
	ttfb, idle := streamTimeouts(config.Provider{})
	if ttfb != 120*time.Second || idle != 300*time.Second {
		t.Fatalf("nil fields must resolve to defaults (120s/300s), got %s/%s", ttfb, idle)
	}
	zero := 0
	ttfb, idle = streamTimeouts(config.Provider{StreamTTFBTimeoutSec: &zero, StreamIdleTimeoutSec: &zero})
	if ttfb != 0 || idle != 0 {
		t.Fatalf("0 must disable both bounds, got %s/%s", ttfb, idle)
	}
	seven, neg := 7, -3
	ttfb, idle = streamTimeouts(config.Provider{StreamTTFBTimeoutSec: &seven, StreamIdleTimeoutSec: &neg})
	if ttfb != 7*time.Second || idle != 0 {
		t.Fatalf("override/disable mix resolved to %s/%s, want 7s/0", ttfb, idle)
	}
}
