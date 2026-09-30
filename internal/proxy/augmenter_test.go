package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
)

// fakeAugmenter is a configurable RequestAugmenter for the three-state tests.
type fakeAugmenter struct {
	// fn, when set, produces (augmentedBody, error).
	fn func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error)
}

func (f *fakeAugmenter) Augment(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
	if f.fn == nil {
		return body, nil
	}
	return f.fn(r, body, providerID, keyID)
}

// newJethubTestProvider builds a test handler whose only provider is a
// bridged (APIType=jethub) one pointing at the given upstream.
func newJethubTestProvider(t *testing.T, baseURL string) *Handler {
	t.Helper()
	return newTestHandlerWithCustomProvider(t, config.Provider{
		ID: "jethub-codearts", Name: "CodeArts (Free Hub)", Prefix: "codearts",
		BaseURL: baseURL, APIType: "jethub", IsActive: true,
		Keys: []config.Key{
			{ID: "acct-1", Key: "tok-1", Name: "Account 1", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "deepseek-v4-flash"}},
	}, config.RotationConfig{Strategy: "fill-first", MaxRetries: 1, BackoffMaxSec: 300})
}

func TestForwardUpstream_JethubAugmenterReplacesHeaders(t *testing.T) {
	var gotAuth, gotCustom, gotBearer string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCustom = r.Header.Get("X-Custom-Signature")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
		if providerID != "jethub-codearts" || keyID != "acct-1" {
			t.Errorf("augmenter got providerID=%q keyID=%q", providerID, keyID)
		}
		// SDK-HMAC style: augmenter fully replaces the auth header.
		r.Header.Set("X-Custom-Signature", "sig-abc")
		return body, nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{
			ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub",
		},
		Key: config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	body := []byte(`{"model":"deepseek-v4-flash","messages":[]}`)
	resp, err := h.forwardUpstream(WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, body, http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	_ = gotBearer // standard Bearer header is still set on the bridged request
	if gotAuth == "" {
		t.Fatal("upstream did not receive Authorization header")
	}
	if gotCustom != "sig-abc" {
		t.Fatalf("augmenter header not applied: %q", gotCustom)
	}
}

func TestForwardUpstream_JethubAugmenterRewritesBody(t *testing.T) {
	var received string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		received = string(b)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
		return []byte(`{"encrypted":true,"orig":` + string(body) + `}`), nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{"m":1}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if !strings.HasPrefix(received, `{"encrypted":true,"orig":`) {
		t.Fatalf("augmented body not received upstream: %q", received)
	}
}

func TestForwardUpstream_JethubAugmenterErrorFailsForward(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream should not be reached when the augmenter errors")
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
		return nil, errAugmentFailed
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	_, err := h.forwardUpstream(WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err == nil {
		t.Fatal("expected augmenter error to fail the forward")
	}
}

// errAugmentFailed is a sentinel error for the augmenter failure path.
var errAugmentFailed = &augmentError{}

type augmentError struct{}

func (*augmentError) Error() string { return "augment failed" }

// Non-jethub providers must NOT invoke the augmenter.
func TestForwardUpstream_AugmenterSkippedForNormalProviders(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newTestHandlerWithCustomProvider(t, config.Provider{
		ID: "normal", Name: "Normal", Prefix: "normal",
		BaseURL: upstream.URL, IsActive: true,
		Keys: []config.Key{{ID: "k1", Key: "sk-1", IsActive: true}},
	}, config.RotationConfig{Strategy: "fill-first", MaxRetries: 1})
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
		called = true
		return body, nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "normal", BaseURL: upstream.URL},
		Key:      config.Key{ID: "k1", Key: "sk-1"}, KeyName: "k1",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if called {
		t.Fatal("augmenter must not run for non-jethub providers")
	}
}
