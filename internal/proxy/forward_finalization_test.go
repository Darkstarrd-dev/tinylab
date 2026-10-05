package proxy

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/keystate"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// ---------------------------------------------------------------------------
// F-04 regression tests: the retry loop's per-attempt finalization
// (EntryTracker.Remove + DecInFlight + Signal) is unified in one defer inside
// forwardAttempt, and forwardWithRetry's three-state return contract
// (written / canceled / terminal-no-keys) guarantees the caller never stacks
// a second WriteHeader on an already-committed response.
// ---------------------------------------------------------------------------

// getInFlight reads the key's in-flight counter under its lock.
func getInFlight(t *testing.T, ks *keystate.KeyRuntimeState) int {
	t.Helper()
	ks.Lock()
	defer ks.Unlock()
	return ks.InFlight
}

// TestForwardWithRetry_MarshalFailure_ReleasesInFlightAndStops is the exact
// F-04 finding: the marshal-failure branch returned after IncInFlight without
// DecInFlight, and its (false, reqID) return made handleProxy stack a 502 on
// the committed 500. The trigger: ensureToolCallIDs assigns generateToolCallID()
// (an unpaired surrogate half, unmarshalable by encoding/json) into
// tool_call_id, so json.Marshal fails on the rewritten body.
func TestForwardWithRetry_MarshalFailure_ReleasesInFlightAndStops(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	h, rb := newTwoKeyHandler(t, upstream.URL)

	// json.Marshal(map[string]any) fails on math.NaN() values
	// (UnsupportedValueError) — exactly the marshal branch under test
	// (practically unreachable in production: the parsed map comes from
	// json.Unmarshal; the point is the branch contract).
	parsed := map[string]any{
		"model": "gpt-4",
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
		},
	}
	// Inject the unmarshalable value post-parse (json.Marshal of the parsed
	// map is what fails in the branch under test).
	parsed["temperature"] = math.NaN()

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, false, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")

	if hits.Load() != 0 {
		t.Fatalf("upstream must never be reached on a marshal failure, got %d hits", hits.Load())
	}
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 from the marshal branch", w.Code)
	}
	// written=true contract: forwardWithRetry reports success to the caller
	// so neither handleProxy (extra 502) nor combo fallback (next target)
	// continues past the committed 500.
	if !ok {
		t.Fatal("expected written=true (ok=true) from the marshal terminal 500")
	}

	for _, keyID := range []string{"key1", "key2"} {
		ks := h.reg.GetKeyState("test", keyID)
		if ks == nil {
			t.Fatalf("expected key state for %s", keyID)
		}
		if got := getInFlight(t, ks); got != 0 {
			t.Fatalf("key %s in-flight leaked (got %d): the marshal branch must release the counter", keyID, got)
		}
		// The defect is internal — no key may be cooled down or excluded.
		ks.Lock()
		locks, level := len(ks.ModelLocks), ks.BackoffLevel
		ks.Unlock()
		if locks != 0 || level != 0 {
			t.Fatalf("key %s must not be cooled down on an internal marshal failure (locks=%d level=%d)", keyID, locks, level)
		}
	}

	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
	// The marshal branch writes no usage entry (recordUsage is not called).
	for _, e := range rb.All() {
		if e.Status == "error" {
			t.Fatalf("marshal failure must not record a key error usage entry (got %q)", e.Error)
		}
	}
}

// TestForwardWithRetry_SameKeyLimit_Writes503WithoutCaller502 exercises the
// written=true contract on the same-key retry branch (maxSameKeyRetries=4
// immediate resends — fast). The bridge rejects every attempt regardless of
// the marker, so the branch exhausts and writes its own final 503.
func TestForwardWithRetry_SameKeyLimit_Writes503WithoutCaller502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&alwaysRejectBridge{})

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "deepseek-v4-flash", "messages": []any{}}

	ok, _ := h.forwardWithRetry(w, req, "jethub-codearts", "deepseek-v4-flash", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")

	// written=true → forwardWithRetry reports success to the caller even
	// though the response is a 503: the caller must not add a 502.
	if !ok {
		t.Fatalf("expected written=true (ok=true) so the caller does not stack a 502, got status %d", w.Code)
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 from the same-key limit branch", w.Code)
	}

	ks := h.reg.GetKeyState("jethub-codearts", "acct-1")
	if ks == nil {
		t.Fatal("expected key state for acct-1")
	}
	if got := getInFlight(t, ks); got != 0 {
		t.Fatalf("in-flight leaked on the same-key limit branch (got %d)", got)
	}
	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
}

// alwaysRejectBridge rejects every attempt with a SameKeyRetryError whose
// header fix is never accepted (it re-rejects even with the marker present),
// driving sameKeyRetries past maxSameKeyRetries.
type alwaysRejectBridge struct{}

func (*alwaysRejectBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (*alwaysRejectBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	return nil, 0, &SameKeyRetryError{Header: "maas_type", Reason: "test: always reject"}
}

// TestHandleProxy_AllKeysExhausted_Single502 verifies the terminal path end
// to end: both keys excluded by real network errors → exactly one 502 body
// envelope, exactly one no-key failure entry, zero in-flight/tracker leaks.
func TestHandleProxy_AllKeysExhausted_Single502(t *testing.T) {
	// Port 1 is reserved and refuses connections: real network errors.
	h, rb := newTwoKeyHandler(t, "http://127.0.0.1:1")

	body := `{"model":"test/gpt-4","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	if got := strings.Count(w.Body.String(), "proxy_error"); got != 1 {
		t.Fatalf("expected exactly one error envelope in body, got %d: %s", got, w.Body.String())
	}
	// Terminal no-key failure recorded exactly once (no duplicates from the
	// loop or the caller path).
	noKey := 0
	for _, e := range rb.All() {
		if e.Status == "error" && e.KeyID == "" {
			noKey++
		}
	}
	if noKey != 1 {
		t.Fatalf("expected exactly 1 terminal no-key usage entry, got %d", noKey)
	}
	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
	for _, keyID := range []string{"key1", "key2"} {
		if ks := h.reg.GetKeyState("test", keyID); ks != nil && getInFlight(t, ks) != 0 {
			t.Fatalf("key %s in-flight leaked across retry branches", keyID)
		}
	}
}

// TestHandleCombo_FallbackAllFail_Single502 covers the combo fallback path:
// both targets fail, the client gets exactly one 502, and no entry/in-flight
// state leaks between targets.
func TestHandleCombo_FallbackAllFail_Single502(t *testing.T) {
	failUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer failUpstream.Close()

	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: failUpstream.URL, IsActive: true,
				Keys:   []config.Key{{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1}},
				Models: []config.ModelDef{{ID: "m1", QuotaType: "limited"}},
			},
			{
				ID: "p2", Name: "P2", Prefix: "p2", BaseURL: failUpstream.URL, IsActive: true,
				Keys:   []config.Key{{ID: "k2", Key: "sk-2", Name: "K2", IsActive: true, Priority: 1}},
				Models: []config.ModelDef{{ID: "m2", QuotaType: "limited"}},
			},
		},
		Combos: []config.Combo{
			{ID: "cb", Name: "cb", Strategy: "fallback", Models: []string{"p1/m1", "p2/m2"}},
		},
		Rotation: config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	rb := usage.New(100)
	h := New(reg, rotation.New(reg, &cfg.Rotation), combo.New(reg), rb, usage.NewQuotaTracker(), console.New(100), 0)

	body := `{"model":"cb","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 after all combo targets fail", w.Code)
	}
	if got := strings.Count(w.Body.String(), "proxy_error"); got != 1 {
		t.Fatalf("expected exactly one error envelope, got %d: %s", got, w.Body.String())
	}
	for _, pk := range [][2]string{{"p1", "k1"}, {"p2", "k2"}} {
		if ks := reg.GetKeyState(pk[0], pk[1]); ks != nil && getInFlight(t, ks) != 0 {
			t.Fatalf("key %s/%s in-flight leaked across combo targets", pk[0], pk[1])
		}
	}
	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
}

// TestForwardWithRetry_CancelDuringQueueWait releases the in-flight counter
// and exits silently when the client cancels during a queue wait — the abort
// path of the three-state contract (return (false, ""), no response).
func TestForwardWithRetry_CancelDuringQueueWait(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"queued":true,"retry_after_ms":1000}`))
	}))
	defer upstream.Close()

	// A bridged (APIType=jethub) provider whose interceptor always signals a
	// queue retry with a short delay: exercises the real QueueRetryError
	// wait path. Only bridged providers consult the augmenter/interceptor.
	provider := config.Provider{
		ID: "jethub-codearts", Name: "CodeArts (Free Hub)", Prefix: "codearts",
		BaseURL: upstream.URL, APIType: "jethub", IsActive: true,
		Keys:   []config.Key{{ID: "acct-1", Key: "tok-1", Name: "Account 1", IsActive: true, Priority: 1}},
		Models: []config.ModelDef{{ID: "deepseek-v4-flash"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 1, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	rb := usage.New(100)
	h := New(reg, rotation.New(reg, &cfg.Rotation), combo.New(reg), rb, usage.NewQuotaTracker(), console.New(100), 0)
	h.SetRequestAugmenter(&queueRetryBridge{delayMs: 1500})

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "deepseek-v4-flash", "messages": []any{}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		ok bool
	}
	done := make(chan result, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req.WithContext(ctx), "jethub-codearts", "deepseek-v4-flash", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")
		done <- result{ok: ok}
	}()

	// Cancel while the loop sits inside the first queue wait (1.5s).
	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case res := <-done:
		if res.ok {
			t.Fatal("expected silent abort (ok=false) after cancel during queue wait")
		}
		if w.Code != 200 {
			t.Fatalf("expected no response written on abort, got status %d", w.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forwardWithRetry did not exit promptly after cancel during queue wait")
	}

	ks := h.reg.GetKeyState("jethub-codearts", "acct-1")
	if ks != nil && getInFlight(t, ks) != 0 {
		t.Fatalf("in-flight leaked after cancel during queue wait (got %d)", getInFlight(t, ks))
	}
	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
	if entries := rb.All(); len(entries) != 0 {
		t.Fatalf("expected no usage entries for a canceled request, got %d", len(entries))
	}
}

// queueRetryBridge always signals a queue retry (retryAfterMs) — driving the
// QueueRetryError wait path deterministically without a real Qoder upstream.
type queueRetryBridge struct{ delayMs int64 }

func (*queueRetryBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (q *queueRetryBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	return nil, q.delayMs, nil
}

var (
	_ RequestAugmenter    = (*alwaysRejectBridge)(nil)
	_ ResponseInterceptor = (*alwaysRejectBridge)(nil)
	_ RequestAugmenter    = (*queueRetryBridge)(nil)
	_ ResponseInterceptor = (*queueRetryBridge)(nil)
)
