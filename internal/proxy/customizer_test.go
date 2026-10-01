package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// fakeCustomizer implements Augment + the two optional capabilities
// (RequestCustomizer / ResponseInterceptor) for the jethub wiring tests.
type fakeCustomizer struct {
	customize func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error)
	intercept func(resp *http.Response) (io.Reader, int64, error)
}

func (f *fakeCustomizer) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (f *fakeCustomizer) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	if f.customize == nil {
		return "", body, nil
	}
	return f.customize(r, body, providerID, keyID, upstreamModel)
}

func (f *fakeCustomizer) InterceptResponse(_ *http.Request, resp *http.Response, _, _, _ string, _ bool) (io.Reader, int64, error) {
	if f.intercept == nil {
		return nil, 0, nil
	}
	return f.intercept(resp)
}

// Customize 返回的完整 URL 必须生效（加密端点的路径与查询串由 WASM 决定，
// BaseURL+entryPath 构造不出它），且默认 URL 构造不再被使用。
func TestForwardUpstream_CustomizeOverridesURL(t *testing.T) {
	defaultHit, customHit := false, false
	defaultUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defaultHit = true
		w.Write([]byte(`{}`))
	}))
	defer defaultUpstream.Close()
	var gotPath, gotQuery, gotSig string
	customUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		customHit = true
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		gotSig = r.Header.Get("X-Cosy-Signature")
		w.Write([]byte(`{}`))
	}))
	defer customUpstream.Close()

	h := newJethubTestProvider(t, defaultUpstream.URL)
	h.SetRequestAugmenter(&fakeCustomizer{customize: func(r *http.Request, body []byte, _, _, _ string) (string, []byte, error) {
		r.Header.Set("X-Cosy-Signature", "COSY.abc.def")
		return customUpstream.URL + "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
			[]byte(`{"encrypted":true}`), nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: defaultUpstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, false, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	resp.Body.Close()
	if defaultHit {
		t.Fatal("default upstream must not be hit when Customize supplies a URL")
	}
	if !customHit {
		t.Fatal("custom URL upstream not reached")
	}
	if gotPath != "/algo/api/v2/service/pro/sse/agent_chat_generation" {
		t.Fatalf("path: %q", gotPath)
	}
	if gotQuery != "FetchKeys=llm_model_result&AgentId=agent_common&Encode=1" {
		t.Fatalf("query: %q", gotQuery)
	}
	// ⚠️ WASM 签名头不可被普通 Bearer 覆盖（只缺省补，不覆盖已有值）。
	if gotSig != "COSY.abc.def" {
		t.Fatalf("signature header: %q", gotSig)
	}
}

// 响应拦截：outBody 替换 resp.Body（信封剥离的接线点）。
func TestForwardUpstream_InterceptorReplacesBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`RAW-ENVELOPE-STREAM`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeCustomizer{intercept: func(resp *http.Response) (io.Reader, int64, error) {
		return io.NopCloser(strings.NewReader(`data: {"choices":[]}` + "\n")), 0, nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	resp, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, true, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	if err != nil {
		t.Fatalf("forwardUpstream: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if string(b) != "data: {\"choices\":[]}\n" {
		t.Fatalf("intercepted body: %q", string(b))
	}
}

// 排队信号：forwardUpstream 把 retryAfterMs 变成 *QueueRetryError（重试循环
// 据此等待后同 Key 重发，不排除不冷却）。
func TestForwardUpstream_InterceptorQueueSignal(t *testing.T) {
	closed := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`queue`))
	}))
	defer upstream.Close()

	h := newJethubTestProvider(t, upstream.URL)
	h.SetRequestAugmenter(&fakeCustomizer{intercept: func(resp *http.Response) (io.Reader, int64, error) {
		return nil, 2500, nil
	}})

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "jethub-codearts", BaseURL: upstream.URL, APIType: "jethub"},
		Key:      config.Key{ID: "acct-1", Key: "tok-1"}, KeyName: "Account 1",
	}
	_, err := h.forwardUpstream(
		WithClientRequest(context.Background(), httptest.NewRequest("POST", "/v1/chat/completions", nil)),
		sel, []byte(`{}`), http.Header{}, true, "/v1/chat/completions", combo.EntryFormatOpenAI, "")
	var qre *upstreamerr.QueueRetryError
	if !errors.As(err, &qre) {
		t.Fatalf("want QueueRetryError, got %T (%v)", err, err)
	}
	if qre.RetryAfter != 2500*time.Millisecond {
		t.Fatalf("retryAfter: %v", qre.RetryAfter)
	}
	_ = closed
}
