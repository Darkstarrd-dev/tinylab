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
)

// fakeAugmenter is a configurable RequestAugmenter for the three-state tests.
type fakeAugmenter struct {
	// fn, when set, produces (augmentedBody, error).
	fn func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error)
}

func (f *fakeAugmenter) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	if f.fn == nil {
		return body, nil
	}
	return f.fn(r, body, providerID, keyID, upstreamModel)
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
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
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
		sel, body, http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
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
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		return []byte(`{"encrypted":true,"orig":` + string(body) + `}`), nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{"m":1}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
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
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		return nil, errAugmentFailed
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	_, err := h.forwardUpstream(WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err == nil {
		t.Fatal("expected augmenter error to fail the forward")
	}
}

// errAugmentFailed is a sentinel error for the augmenter failure path.
var errAugmentFailed = &augmentError{}

type augmentError struct{}

func (*augmentError) Error() string { return "augment failed" }

// dropRetryBridge is a bridged-provider stub implementing both Augment and
// InterceptResponse: the first attempt is rejected with a SameKeyRetryError
// carrying the header to drop; the retry (marker present) succeeds.
type dropRetryBridge struct {
	attempts             int
	markerSeenOnRetry    bool
	markerLeakedUpstream bool
}

func (d *dropRetryBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	d.attempts++
	if r.Header.Get(RetryDropHeaderMarker) != "" {
		d.markerSeenOnRetry = true
	}
	return body, nil
}

func (d *dropRetryBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if clientReq.Header.Get(RetryDropHeaderMarker) == "" {
		return nil, 0, &SameKeyRetryError{Header: "maas_type", Reason: "test: drop the rejected header"}
	}
	return nil, 0, nil
}

// TestForwardWithRetry_SameKeyRetryDropsHeader: a bridge-originated
// SameKeyRetryError must resend immediately with the SAME key, write the
// loopback marker for the bridge's augmenter, and never leak the marker
// upstream (the header copy guard).
func TestForwardWithRetry_SameKeyRetryDropsHeader(t *testing.T) {
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
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "deepseek-v4-flash", "messages": []any{}}
	ok, _ := h.forwardWithRetry(w, req, "jethub-codearts", "deepseek-v4-flash", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")
	if !ok {
		t.Fatalf("forwardWithRetry failed: %d %s", w.Code, w.Body.String())
	}
	if bridge.attempts != 2 {
		t.Fatalf("expected exactly 2 attempts (1 reject + 1 retry), got %d", bridge.attempts)
	}
	if !bridge.markerSeenOnRetry {
		t.Fatal("the loopback marker must be visible to the augmenter on the retry")
	}
	if bridge.markerLeakedUpstream {
		t.Fatal("the loopback marker must never reach the upstream")
	}
	if got := req.Header.Get(RetryDropHeaderMarker); got != "maas_type" {
		t.Fatalf("marker = %q, want maas_type on the client request", got)
	}
}

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
	h.SetRequestAugmenter(&fakeAugmenter{fn: func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		called = true
		return body, nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "normal", BaseURL: upstream.URL},
		Key:      config.Key{ID: "k1", Key: "sk-1"}, KeyName: "k1",
	}
	resp, err := h.forwardUpstream(context.Background(), sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if called {
		t.Fatal("augmenter must not run for non-jethub providers")
	}
}

// saturationBridge rejects every attempt with a ModelSaturationError (the
// buddy 14003 signal): the retry loop must wait and retry the SAME key, then
// fail with 429 — never cooling or excluding the key.
type saturationBridge struct {
	attempts int
}

func (s *saturationBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	s.attempts++
	return body, nil
}

func (s *saturationBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	return nil, 0, &ModelSaturationError{
		RetryAfter: time.Millisecond, // 测试不真等 2s
		Reason:     "模型 space-bunny 当前请求量饱和——请换模型或稍后重试",
	}
}

// TestForwardWithRetry_ModelSaturationDoesNotLockKey 是 buddy 14003 的**行为级**
// 防线（ref 29a42ea 的核心缺陷）：模型饱和**不得**写限流标记、**不得**换号 ——
// 否则一个模型级信号会把整个账号池逐个锁死。
//
// 反向验证：把 forward_retry.go 的 ModelSaturationError 分支删掉（= 修复前
// 行为），饱和错误会落进通用 handleNetworkError 路径 ⇒ 本用例的
// 「无 ModelLock / 无 BackoffLevel」两条断言立刻变红。
func TestForwardWithRetry_ModelSaturationDoesNotLockKey(t *testing.T) {
	bridge := &saturationBridge{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(bridge)

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "space-bunny", "messages": []any{}}
	ok, _ := h.forwardWithRetry(w, req, "jethub-codearts", "space-bunny", "/v1/chat/completions", nil, parsed, false, 1, "", "Buddy", combo.EntryFormatOpenAI, "", "")
	if !ok {
		t.Fatalf("expected written=true (the 429 was written), got status %d", w.Code)
	}
	// 饱和用尽后必须报 429（不是 502/503），文案指向换模型。
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 for model saturation", w.Code)
	}
	if body := w.Body.String(); !strings.Contains(body, "换模型") {
		t.Fatalf("the saturation message must point at switching model, got %q", body)
	}
	// 重试预算：maxSaturationRetries=2 ⇒ 共 3 次尝试（1 + 2 次重试）。
	if bridge.attempts != maxSaturationRetries+1 {
		t.Fatalf("attempts = %d, want %d (1 initial + %d same-key retries)",
			bridge.attempts, maxSaturationRetries+1, maxSaturationRetries)
	}

	// ⚠️ 核心断言：key 必须**没有**被冷却、**没有**模型锁、**没有**进排除集。
	ks := h.reg.GetKeyState("jethub-codearts", "acct-1")
	if ks == nil {
		t.Fatal("expected key state for acct-1")
	}
	if locks := len(ks.ModelLocks); locks != 0 {
		t.Fatalf("model saturation must NOT write a model lock (got %d) — it would lock the whole pool", locks)
	}
	if ks.BackoffLevel != 0 {
		t.Fatalf("model saturation must NOT raise the backoff level (got %d)", ks.BackoffLevel)
	}
	if got := getInFlight(t, ks); got != 0 {
		t.Fatalf("in-flight leaked on the saturation branch (got %d)", got)
	}
	if tracked := h.EntryTracker.All(); len(tracked) != 0 {
		t.Fatalf("expected EntryTracker cleaned up, got %d stale entries", len(tracked))
	}
}

// deadModelBridge implements Augment + the optional ModelGoneReporter /
// success-path forget hooks so a real retry loop can be driven end to end.
type deadModelBridge struct {
	reported []string
	forgot   []string
}

func (d *deadModelBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (d *deadModelBridge) ReportModelGone(providerID, model, message string) {
	d.reported = append(d.reported, providerID+"/"+model+" :: "+message)
}

func (d *deadModelBridge) ForgetModelGoneByProviderID(providerID, model string) {
	d.forgot = append(d.forgot, providerID+"/"+model)
}

// TestForwardWithRetry_ReportsModelGoneOn404 是「已失效模型运行时实证剔除」的
// **行为级**防线（R5, ref f8748fa）：真实 404 必须被上报给 bridge，否则下架的
// 模型会永远留在列表里、每轮都 404。
//
// 反向验证：删掉 forward_retry.go 的 ReportModelGone 调用 ⇒ 本用例立刻变红。
func TestForwardWithRetry_ReportsModelGoneOn404(t *testing.T) {
	bridge := &deadModelBridge{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":{"message":"model not found"}}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(bridge)

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "gone-model", "messages": []any{}}
	h.forwardWithRetry(w, req, "jethub-codearts", "gone-model", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")

	if len(bridge.reported) == 0 {
		t.Fatal("a real 404 'model not found' must be reported to the bridge (else the model stays listed forever)")
	}
	if !strings.Contains(bridge.reported[0], "gone-model") || !strings.Contains(bridge.reported[0], "model not found") {
		t.Fatalf("the report must carry provider/model/message, got %q", bridge.reported[0])
	}
}

// TestForwardWithRetry_ForgetsModelGoneOnSuccess 锁成功路径：模型能答 2xx ⇒ 记录
// 必须被清掉，否则一个回来的模型要等满 TTL 才会重新出现。
func TestForwardWithRetry_ForgetsModelGoneOnSuccess(t *testing.T) {
	bridge := &deadModelBridge{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(bridge)

	req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	w := httptest.NewRecorder()
	parsed := map[string]any{"model": "revived-model", "messages": []any{}}
	h.forwardWithRetry(w, req, "jethub-codearts", "revived-model", "/v1/chat/completions", nil, parsed, false, 1, "", "CodeArts", combo.EntryFormatOpenAI, "", "")

	if len(bridge.forgot) == 0 {
		t.Fatal("a 2xx response must clear the dead-model record")
	}
	if !strings.Contains(bridge.forgot[0], "revived-model") {
		t.Fatalf("the forget must name the model, got %q", bridge.forgot[0])
	}
	if len(bridge.reported) != 0 {
		t.Fatalf("a 2xx response must not report the model as gone, got %v", bridge.reported)
	}
}
