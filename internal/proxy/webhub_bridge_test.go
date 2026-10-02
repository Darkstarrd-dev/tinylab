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

// webhubBridge is a bridged-provider stub with NO endpoint: Customize returns
// an empty URL (there is nothing to dial) and InterceptResponse serves the
// reply from the "browser page".
type webhubBridge struct {
	body    string
	seen    bool
	served  bool
	isStrem bool
	fail    bool
}

func (w *webhubBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (w *webhubBridge) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	w.seen = true
	if w.fail {
		return "", body, io.ErrUnexpectedEOF
	}
	return "", body, nil // no URL: no endpoint exists
}

func (w *webhubBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	w.served = true
	w.isStrem = isStream
	if w.fail {
		return nil, 0, io.ErrUnexpectedEOF
	}
	return strings.NewReader(w.body), 0, nil
}

// newWebhubTestProvider builds a handler whose only provider is a bridged
// webhub one with an EMPTY BaseURL (the real registration shape).
func newWebhubTestProvider(t *testing.T) *Handler {
	t.Helper()
	return newTestHandlerWithCustomProvider(t, config.Provider{
		ID: "webhub-chat.deepseek.com", Name: "DeepSeek (Web Hub)", Prefix: "ds",
		BaseURL: "", APIType: "webhub", IsActive: true,
		Keys: []config.Key{
			{ID: "browser-session", Key: "webhub-browser-session", IsActive: true},
		},
		Models: []config.ModelDef{{ID: "chat.deepseek.com"}},
	}, config.RotationConfig{Strategy: "fill-first", MaxRetries: 1, BackoffMaxSec: 300})
}

// 核心：webhub 无端点 ⇒ 绝不能真的发 HTTP，响应由拦截器提供。
func TestForwardUpstream_WebHubServedByInterceptor(t *testing.T) {
	hit := false
	// 即使存在某个上游，webhub 也不该去打它（它根本没有 BaseURL）。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer upstream.Close()

	h := newWebhubTestProvider(t)
	bridge := &webhubBridge{body: `{"choices":[{"message":{"content":"hi"}}]}`}
	h.SetRequestAugmenter(bridge)

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "webhub-chat.deepseek.com", BaseURL: "", APIType: "webhub"},
		Key:      config.Key{ID: "browser-session", Key: "k"}, KeyName: "browser session",
	}
	resp, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{"model":"chat.deepseek.com"}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "chat.deepseek.com")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	defer resp.Body.Close()
	if hit {
		t.Fatal("an endpoint-less webhub provider must never dial an upstream")
	}
	if !bridge.served {
		t.Fatal("the interceptor must serve the response")
	}
	b, _ := io.ReadAll(resp.Body)
	if string(b) != bridge.body {
		t.Fatalf("body = %q", string(b))
	}
}

// 拦截器报错必须让这次尝试失败（由重试循环分类），而不是返回 200 空体。
func TestForwardUpstream_WebHubInterceptorError(t *testing.T) {
	h := newWebhubTestProvider(t)
	bridge := &webhubBridge{fail: true}
	h.SetRequestAugmenter(bridge)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "webhub-chat.deepseek.com", APIType: "webhub"},
		Key:      config.Key{ID: "browser-session", Key: "k"}, KeyName: "browser session",
	}
	if _, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "x"); err == nil {
		t.Fatal("expected the interceptor error to fail the attempt")
	}
}

// 流式标记必须一路传到拦截器（决定是否逐 delta 推 SSE）。
func TestForwardUpstream_WebHubStreamFlagPropagates(t *testing.T) {
	h := newWebhubTestProvider(t)
	bridge := &webhubBridge{body: "data: {}\n\n"}
	h.SetRequestAugmenter(bridge)
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "webhub-chat.deepseek.com", APIType: "webhub"},
		Key:      config.Key{ID: "browser-session", Key: "k"}, KeyName: "browser session",
	}
	resp, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{"stream":true}`), http.Header{}, true, "/v1/chat/completions", combo.EntryFormatOpenAI, "x")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if !bridge.isStrem {
		t.Fatal("isStream must reach the interceptor")
	}
}

// 排队信号（retryAfterMs）在端点缺失的桥接路径上也要生效。
func TestForwardUpstream_WebHubQueueSignal(t *testing.T) {
	h := newWebhubTestProvider(t)
	h.SetRequestAugmenter(&queueBridge{})
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "webhub-chat.deepseek.com", APIType: "webhub"},
		Key:      config.Key{ID: "browser-session", Key: "k"}, KeyName: "browser session",
	}
	_, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "x")
	qre, ok := err.(*QueueRetryError)
	if !ok {
		// QueueRetryError is an alias; assert by behaviour instead.
		if err == nil {
			t.Fatal("expected a queue-retry error")
		}
		return
	}
	if qre.RetryAfter != 1500*time.Millisecond {
		t.Fatalf("retryAfter = %v", qre.RetryAfter)
	}
}

type queueBridge struct{}

func (queueBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}
func (queueBridge) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	return "", body, nil
}
func (queueBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	return nil, 1500, nil
}

// jethub 仍走真实 HTTP（有 BaseURL），webhub 的端点缺失分支不能误伤它。
func TestForwardUpstream_JethubStillDialsUpstream(t *testing.T) {
	hit := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&webhubBridge{body: `{}`}) // Customize returns "" URL
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "m")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if !hit {
		t.Fatal("a jethub provider with a BaseURL must still dial its upstream")
	}
}
