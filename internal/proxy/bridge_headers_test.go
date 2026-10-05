package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
)

// TestForwardUpstream_BridgeOutboundHasNoClientHeaders pins the F-05
// framework guarantee: the bridged provider's outbound headers are built on a
// BLANK per-attempt base, so the augmenter's writes ARE the outbound set.
// Even an augmenter that never deletes anything cannot leak client-supplied
// headers (credentials included) to the bridged upstream.
func TestForwardUpstream_BridgeOutboundHasNoClientHeaders(t *testing.T) {
	var upstreamHeaders http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		// Deliberately does NOT wipe r.Header: the proxy hands over a blank
		// base, so containment is not the augmenter's job anymore. The only
		// pre-seeded entries are the loopback markers.
		for k := range r.Header {
			if !strings.EqualFold(k, RetryDropHeaderMarker) && !strings.EqualFold(k, webhubTurnHeaderName) {
				t.Errorf("bridge request must start blank, got %s", k)
			}
		}
		r.Header.Set("X-Bridge-Signed", "sig-1")
		r.Header.Set("Authorization", "Bearer bridge-cred")
		return body, nil
	}})

	clientReq := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	// Client credentials/headers that must NOT reach the bridged upstream.
	clientReq.Header.Set("Authorization", "Bearer client-secret")
	clientReq.Header.Set("X-Session-Fingerprint", "fp-1")
	clientReq.Header.Set("Cookie", "sid=secret")

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(WithClientRequest(clientReq.Context(), clientReq),
		sel, []byte(`{"m":1}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()

	for _, name := range []string{"Authorization", "X-Session-Fingerprint", "Cookie"} {
		if got := upstreamHeaders.Get(name); got == "client-secret" || got == "fp-1" || got == "sid=secret" {
			t.Fatalf("client header %s leaked to the bridged upstream: %q", name, got)
		}
	}
	if got := upstreamHeaders.Get("X-Bridge-Signed"); got != "sig-1" {
		t.Fatalf("augmenter header missing outbound: %q", got)
	}
	// The augmenter's Authorization wins; the key fallback is only applied
	// when the augmenter left it unset.
	if got := upstreamHeaders.Get("Authorization"); got != "Bearer bridge-cred" {
		t.Fatalf("Authorization = %q, want the augmenter value", got)
	}
	if upstreamHeaders.Get(RetryDropHeaderMarker) != "" {
		t.Fatal("loopback marker must never reach the upstream")
	}
}

// TestForwardUpstream_BridgeAuthFallbackUsesKey: with a blank base the
// augmenter may legitimately leave Authorization unset; the proxy then fills
// it from the bridged key's credential (never from the client request).
func TestForwardUpstream_BridgeAuthFallbackUsesKey(t *testing.T) {
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, _, _, _ string) ([]byte, error) {
		r.Header.Set("X-Bridge-Signed", "sig-1")
		return body, nil
	}})

	clientReq := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	clientReq.Header.Set("Authorization", "Bearer client-secret")

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(WithClientRequest(clientReq.Context(), clientReq),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if gotAuth != "Bearer tok-1" {
		t.Fatalf("Authorization = %q, want the bridged key credential", gotAuth)
	}
}

// TestForwardUpstream_BridgeAttemptsAreIsolated: two attempts sharing one
// client request (what a combo crossing two bridged providers, or a same-key
// retry, does) must not let the first attempt's augmenter headers leak into
// the second attempt's outbound set.
func TestForwardUpstream_BridgeAttemptsAreIsolated(t *testing.T) {
	var upstreamHeaders http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	seenOnSecond := ""
	attempts := 0
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, _, _, _ string) ([]byte, error) {
		attempts++
		if attempts == 1 {
			r.Header.Set("X-Attempt-Once", "first")
		} else if v := r.Header.Get("X-Attempt-Once"); v != "" {
			seenOnSecond = v
		}
		r.Header.Set("X-Bridge-Signed", "sig")
		return body, nil
	}})

	clientReq := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	for range 2 {
		resp, err := h.forwardUpstream(WithClientRequest(clientReq.Context(), clientReq),
			sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
		if err != nil {
			t.Fatalf("forwardUpstream attempt %d: %v", attempts+1, err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	if attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts)
	}
	if seenOnSecond != "" {
		t.Fatal("first attempt's augmenter headers leaked into the second attempt's bridge request")
	}
	if upstreamHeaders.Get("X-Attempt-Once") != "" {
		t.Fatal("stale augmenter header reached the upstream on the second attempt")
	}
}

// TestForwardWithRetry_BridgeSameKeyRetryKeepsMarkerFlow: end-to-end contract
// of the SameKeyRetryError flow under the blank-base regime — the retry loop
// writes the marker onto the CLIENT request, the bridge request re-seeds it,
// the augmenter sees it on the resend, and the upstream never does.
func TestForwardWithRetry_BridgeSameKeyRetryKeepsMarkerFlow(t *testing.T) {
	bridge := &dropRetryBridge{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(RetryDropHeaderMarker) != "" {
			bridge.markerLeakedUpstream = true
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(bridge)

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer client-secret")
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "deepseek-v4-flash", "messages": []any{}}
	ok, _ := h.forwardWithRetry(w, req, "jethub-codearts", "deepseek-v4-flash", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")
	if !ok {
		t.Fatalf("forwardWithRetry failed: %d %s", w.Code, w.Body.String())
	}
	if bridge.attempts != 2 {
		t.Fatalf("expected exactly 2 attempts, got %d", bridge.attempts)
	}
	if !bridge.markerSeenOnRetry {
		t.Fatal("the loopback marker must be re-seeded onto the retry's bridge request")
	}
	if bridge.markerLeakedUpstream {
		t.Fatal("the loopback marker must never reach the upstream")
	}
}
