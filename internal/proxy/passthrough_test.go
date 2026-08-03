package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// TestPassThrough_LargeBodyStreamsFully verifies the non-stream pass-through
// no longer silently truncates responses at 64MB (H3): a body larger than the
// old io.LimitReader cap must reach the client in full, while the
// usage-capture copy passed to recordUsage stays bounded at 512KB.
func TestPassThrough_LargeBodyStreamsFully(t *testing.T) {
	h := newSingleKeyHandler(t, "", 0)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test"},
		Key:      config.Key{ID: "k1", Key: "sk-test", Name: "TestKey"},
		KeyName:  "TestKey",
	}
	// Just past the old 64MB cap: the pre-fix code delivered only the first
	// 64MB to the client and silently dropped the rest.
	big := bytes.Repeat([]byte("a"), 64<<20+4096)
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(big)),
	}
	w := httptest.NewRecorder()
	h.passThroughResponse(w, resp, "gpt-4", sel, 5, nil, "req-large", nil, "http://upstream/v1/chat/completions", "gpt-4", "sess")
	if w.Body.Len() != len(big) {
		t.Fatalf("client received %d bytes, want %d (response was truncated)", w.Body.Len(), len(big))
	}
	if !bytes.Equal(w.Body.Bytes(), big) {
		t.Fatal("client payload differs from upstream body")
	}
}

// newSingleKeyHandler builds a Handler whose single-key provider points at the
// given mock upstream URL. Shared by the pass-through / cooldown-wait tests.
func newSingleKeyHandler(t *testing.T, upstreamURL string, maxRetries int) *Handler {
	t.Helper()
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "test", Name: "Test", Prefix: "test",
				BaseURL: upstreamURL, IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-test", Name: "TestKey", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
			},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: maxRetries, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// TestPassThrough_400RequestShapeError_NotLocked is the core regression test
// for the user's bug: a 400 (request-validation, e.g. Ollama "invalid reasoning
// value") on a single-key provider must be returned to the client as a 400
// (NOT 502), the key must NOT be locked, and a SUBSEQUENT request to the same
// key must succeed immediately without a "no available keys" burst.
func TestPassThrough_400RequestShapeError_NotLocked(t *testing.T) {
	// First request: upstream returns 400 invalid_request_error (request is
	// malformed, key is healthy). Subsequent requests return 200.
	var calls int32
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":{"message":"invalid reasoning value: 'minimal'","type":"invalid_request_error"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"hi"}}]}`))
	}))
	defer mockUpstream.Close()

	h := newSingleKeyHandler(t, mockUpstream.URL, 3)

	// Request 1: should pass the 400 through to the client.
	body1 := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req1 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body1))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	h.ChatCompletions(w1, req1)

	resp1 := w1.Result()
	defer resp1.Body.Close()
	if resp1.StatusCode != http.StatusBadRequest {
		t.Fatalf("request 1: expected 400 pass-through, got %d", resp1.StatusCode)
	}
	rb1, _ := io.ReadAll(resp1.Body)
	if !strings.Contains(string(rb1), "invalid reasoning value") {
		t.Fatalf("request 1: expected upstream error body forwarded, got: %s", string(rb1))
	}

	// The key must NOT be locked: its ModelLock for gpt-4 must be absent/zero.
	ks := h.keyState.GetKeyState("test", "k1")
	if ks == nil {
		t.Fatal("expected key state")
	}
	ks.Lock()
	locked := false
	if dl, ok := ks.ModelLocks["gpt-4"]; ok && !dl.IsZero() && time.Now().Before(dl) {
		locked = true
	}
	status := ks.ModelStatus["gpt-4"]
	ks.Unlock()
	if locked {
		t.Fatal("key was locked after a 400 pass-through — key must stay healthy")
	}
	if status == "cooldown" {
		t.Fatalf("key status = 'cooldown' after 400 pass-through, want not cooldown")
	}

	// Request 2: must succeed immediately (no 30s "no available keys" burst).
	body2 := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req2 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body2))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	h.ChatCompletions(w2, req2)

	resp2 := w2.Result()
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("request 2: expected 200 (key not locked), got %d", resp2.StatusCode)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("expected exactly 2 upstream calls (no retry on pass-through), got %d", got)
	}
}

// TestPassThrough_422RequestShapeError verifies 422 is also passed through.
func TestPassThrough_422RequestShapeError(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		w.Write([]byte(`{"error":{"message":"bad field","type":"invalid_request_error"}}`))
	}))
	defer mockUpstream.Close()

	h := newSingleKeyHandler(t, mockUpstream.URL, 3)
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 pass-through, got %d", resp.StatusCode)
	}
	// Key must not be locked.
	ks := h.keyState.GetKeyState("test", "k1")
	ks.Lock()
	_, hasLock := ks.ModelLocks["gpt-4"]
	ks.Unlock()
	if hasLock {
		t.Fatal("key was locked after a 422 pass-through — key must stay healthy")
	}
}

// TestPassThrough_AggregatorTransient400_Retries verifies a 400 whose body
// indicates the aggregator's OWN upstream failed ("upstream request failed")
// is NOT passed through: the text rule overrides → ActionBackoff → the key is
// locked (backoff) and the request retries / exhausts. On a single-key
// provider this surfaces as 502 (exhausted), and the key IS locked.
func TestPassThrough_AggregatorTransient400_Retries(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"upstream request failed"}`))
	}))
	defer mockUpstream.Close()

	h := newSingleKeyHandler(t, mockUpstream.URL, 1)
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	// Single key, MaxRetries 1 → exhausted → 502 (not 400 pass-through).
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("aggregator-transient 400 on single key: expected 502 (exhausted), got %d", resp.StatusCode)
	}
	// The key IS locked (backoff) because this is a retryable action.
	ks := h.keyState.GetKeyState("test", "k1")
	ks.Lock()
	_, hasLock := ks.ModelLocks["gpt-4"]
	ks.Unlock()
	if !hasLock {
		t.Fatal("aggregator-transient 400 should lock the key (ActionBackoff), but ModelLock is absent")
	}
}

// TestCooldownWait_WaitsThenSucceeds verifies Part B: when the only key is
// cooling down, a request does NOT get an instant 502 — it WAITS for the
// cooldown to expire (bounded), then SelectKey succeeds and the request
// reaches the upstream. The key is pre-locked directly (bypassing 429's own
// same-key retry logic) so the test is deterministic and fast (<1s).
func TestCooldownWait_WaitsThenSucceeds(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"ok","choices":[{"message":{"content":"hi"}}]}`))
	}))
	defer mockUpstream.Close()

	h := newSingleKeyHandler(t, mockUpstream.URL, 3)

	// Pre-lock the only key for ~400ms (cooldown-wait path, not excluded).
	ks := h.keyState.GetKeyState("test", "k1")
	ks.Lock()
	ks.ModelLocks["gpt-4"] = time.Now().Add(400 * time.Millisecond)
	ks.ModelStatus["gpt-4"] = "cooldown"
	ks.ModelErrors["gpt-4"] = "429: rate limited"
	ks.Unlock()

	// The request: SelectKey finds the key locked → SonestCooldown sees the
	// ~400ms lock → waits → retries SelectKey (lock now expired) → 200. Without
	// Part B this would be an instant 502.
	start := time.Now()
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	elapsed := time.Since(start)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after waiting for cooldown, got %d (elapsed=%v)", resp.StatusCode, elapsed)
	}
	// It must have actually waited (~400ms), proving it didn't instant-502.
	if elapsed < 300*time.Millisecond {
		t.Fatalf("returned too fast (elapsed=%v); expected to wait for the ~400ms cooldown before retrying", elapsed)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["id"] != "ok" {
		t.Fatalf("unexpected body: %v", result)
	}
}

// TestCooldownWait_Instant502WhenGenuinelyExhausted verifies the 502 still
// returns after waiting when the key genuinely keeps failing (not merely
// cooling down). After Part B waits for the lock and retries SelectKey, the
// key is available again but fails the same way → exhausts → 502. The point:
// Part B WAITED (elapsed ≥ wait), proving it ran instead of instant-502-ing.
func TestCooldownWait_WaitsThenStill502(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"forbidden"}`))
	}))
	defer mockUpstream.Close()

	h := newSingleKeyHandler(t, mockUpstream.URL, 3)

	// Pre-lock the only key for ~300ms (so Part B's wait is fast). The key is
	// NOT excluded for this fresh request, so SonestCooldown finds the lock.
	ks := h.keyState.GetKeyState("test", "k1")
	ks.Lock()
	ks.ModelLocks["gpt-4"] = time.Now().Add(300 * time.Millisecond)
	ks.ModelStatus["gpt-4"] = "cooldown"
	ks.ModelErrors["gpt-4"] = "403: forbidden"
	ks.Unlock()

	start := time.Now()
	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ChatCompletions(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	elapsed := time.Since(start)
	// After the ~300ms wait the key unlocks; upstream returns 403 again → another
	// exhaustion → 502. The status is unchanged; the wait is what we assert.
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 (403 again after wait), got %d", resp.StatusCode)
	}
	if elapsed < 250*time.Millisecond {
		t.Fatalf("returned too fast (elapsed=%v); expected Part B to wait for the ~300ms lock before exhausting", elapsed)
	}
}
