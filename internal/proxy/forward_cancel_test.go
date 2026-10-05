package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newTwoKeyHandler builds a handler whose provider has two active keys and the
// given upstream base URL. The returned ring buffer lets the test inspect
// recorded usage entries.
func newTwoKeyHandler(t *testing.T, baseURL string) (*Handler, *usage.RingBuffer) {
	t.Helper()
	provider := config.Provider{
		ID: "test", Name: "Test Provider", Prefix: "test",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "key1", Key: "sk-test-key-1", Name: "Key One", IsActive: true, Priority: 1},
			{ID: "key2", Key: "sk-test-key-2", Name: "Key Two", IsActive: true, Priority: 2},
		},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
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

// TestForwardWithRetry_ClientCancel_DoesNotCooldownOrPollKeys is the F-01
// regression test: a client cancellation while the upstream request is in
// flight must exit silently — the key is NOT cooled down, NOT excluded, no
// error usage is recorded, and the remaining keys are NOT polled.
func TestForwardWithRetry_ClientCancel_DoesNotCooldownOrPollKeys(t *testing.T) {
	var hits atomic.Int32
	reached := make(chan struct{})
	var reachOnce atomic.Bool
	// Upstream hangs until the proxy's outbound request is canceled (server
	// side observes its own request context die). The body must be fully
	// read first — otherwise net/http never starts the background read that
	// detects the client (proxy transport) closing the connection, and the
	// request context is never canceled.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		hits.Add(1)
		if reachOnce.CompareAndSwap(false, true) {
			close(reached)
		}
		<-r.Context().Done()
	}))
	// CloseClientConnections first: forces any lingering handler's ctx done
	// so Close cannot hang the test binary.
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	h, rb := newTwoKeyHandler(t, srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body)).WithContext(ctx)
	parsed := map[string]any{"model": "gpt-4", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	w := httptest.NewRecorder()

	type result struct {
		ok bool
	}
	done := make(chan result, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, false, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
		done <- result{ok: ok}
	}()

	// Cancel only after the upstream actually has the request in flight.
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never received the request")
	}
	cancel()

	select {
	case res := <-done:
		if res.ok {
			t.Fatal("expected forwardWithRetry to report failure after client cancel")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forwardWithRetry did not exit promptly after client cancel")
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("expected exactly 1 upstream attempt (no polling of remaining keys), got %d", got)
	}

	for _, keyID := range []string{"key1", "key2"} {
		ks := h.reg.GetKeyState("test", keyID)
		if ks == nil {
			continue
		}
		ks.Lock()
		locks := len(ks.ModelLocks)
		level := ks.BackoffLevel
		inflight := ks.InFlight
		ks.Unlock()
		if locks != 0 || level != 0 {
			t.Fatalf("key %s must not be cooled down on client cancel (locks=%d backoffLevel=%d)", keyID, locks, level)
		}
		if inflight != 0 {
			t.Fatalf("key %s in-flight not released (inflight=%d)", keyID, inflight)
		}
	}

	if entries := rb.All(); len(entries) != 0 {
		t.Fatalf("expected no usage entries for a canceled request, got %d (status=%s)", len(entries), entries[0].Status)
	}

	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
}

// TestForwardWithRetry_RealNetworkError_StillCoolsKeys is the control group:
// a genuine network failure (connection refused) must still cool down and
// exclude keys — the cancellation carve-out must not swallow real errors.
func TestForwardWithRetry_RealNetworkError_StillCoolsKeys(t *testing.T) {
	// Port 1 is reserved and refuses connections.
	h, rb := newTwoKeyHandler(t, "http://127.0.0.1:1")

	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	parsed := map[string]any{"model": "gpt-4", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	w := httptest.NewRecorder()

	ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, false, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
	if ok {
		t.Fatal("expected failure against a refused upstream")
	}

	for _, keyID := range []string{"key1", "key2"} {
		ks := h.reg.GetKeyState("test", keyID)
		if ks == nil {
			t.Fatalf("expected key state for %s", keyID)
		}
		ks.Lock()
		locks := len(ks.ModelLocks)
		level := ks.BackoffLevel
		ks.Unlock()
		if locks == 0 || level == 0 {
			t.Fatalf("key %s must be cooled down on a real network error (locks=%d backoffLevel=%d)", keyID, locks, level)
		}
	}

	// One error entry per key attempt (the terminal "no available keys"
	// recordNoKeyFailure entry carries no KeyID and is not counted here).
	perKeyErr := 0
	for _, e := range rb.All() {
		if e.Status == "error" && e.KeyID != "" {
			perKeyErr++
		}
	}
	if perKeyErr != 2 {
		t.Fatalf("expected 2 per-key error usage entries, got %d", perKeyErr)
	}

	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
}
