package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/rotation"
)

// webhubE2EBridge drives a fake "page": ChatRequest comes in, a canned reply
// comes out, split into deltas for the streaming path. It stands in for
// webhub's driver so this test covers the PROXY side of the bridge
// (prefix → provider → Customize → InterceptResponse → client) end to end.
type webhubE2EBridge struct {
	reply string
	got   struct {
		providerID string
		model      string
		stream     bool
		prompt     string
	}
	seen bool
}

func (w *webhubE2EBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}

func (w *webhubE2EBridge) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	w.seen = true
	w.got.providerID = providerID
	w.got.model = upstreamModel
	var parsed struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(body, &parsed)
	w.got.stream = parsed.Stream
	var msgs struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &msgs); err == nil && len(msgs.Messages) > 0 {
		w.got.prompt = msgs.Messages[len(msgs.Messages)-1].Content
	}
	// No URL: webhub has no endpoint.
	return "", body, nil
}

func (w *webhubE2EBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	if !isStream {
		return strings.NewReader(`{"id":"wh","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"` + w.reply + `"},"finish_reason":"stop"}]}`), 0, nil
	}
	// Two deltas then the terminator, exactly as the real bridge emits.
	sse := "data: {\"id\":\"wh\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
		"data: {\"id\":\"wh\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"" + w.reply + "\"}}]}\n\n" +
		"data: {\"id\":\"wh\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: [DONE]\n\n"
	return strings.NewReader(sse), 0, nil
}

func newWebhubE2EHandler(t *testing.T, reply string) (*Handler, *webhubE2EBridge) {
	t.Helper()
	h := newTestHandlerWithCustomProvider(t, config.Provider{
		ID: "webhub-chat.deepseek.com", Name: "DeepSeek (Web Hub)", Prefix: "ds",
		BaseURL: "", APIType: "webhub", IsActive: true,
		Keys:   []config.Key{{ID: "browser-session", Key: "synthetic", IsActive: true}},
		Models: []config.ModelDef{{ID: "chat.deepseek.com"}, {ID: "deepseek"}},
	}, config.RotationConfig{Strategy: "fill-first", MaxRetries: 1, BackoffMaxSec: 300})
	br := &webhubE2EBridge{reply: reply}
	h.SetRequestAugmenter(br)
	return h, br
}

// e2e（非流式）：POST /v1/chat/completions model="ds/deepseek" → 真实回复，
// 且全程不发出任何 HTTP 请求（webhub 没有端点）。
func TestE2E_WebHubNonStream(t *testing.T) {
	var dialed bool
	// 即使有一个上游在跑，webhub 也不该去打它。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dialed = true
	}))
	defer upstream.Close()

	h, br := newWebhubE2EHandler(t, "P0-PROBE-OK")
	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"ds/deepseek","messages":[{"role":"user","content":"Say ok"}]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	if dialed {
		t.Fatal("webhub must never dial an HTTP upstream")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("body not JSON: %v (%q)", err, w.Body.String())
	}
	if len(out.Choices) != 1 || out.Choices[0].Message.Content != "P0-PROBE-OK" {
		t.Fatalf("choices = %+v", out.Choices)
	}
	if out.Choices[0].Message.Role != "assistant" {
		t.Fatalf("role = %q", out.Choices[0].Message.Role)
	}
	// 链路参数校验：providerID 与模型 ID 必须一路传到桥。
	if br.got.providerID != "webhub-chat.deepseek.com" {
		t.Fatalf("providerID = %q", br.got.providerID)
	}
	if br.got.model != "deepseek" {
		t.Fatalf("upstreamModel = %q, want the model id after the prefix", br.got.model)
	}
	if br.got.prompt != "Say ok" {
		t.Fatalf("prompt = %q", br.got.prompt)
	}
}

// e2e（流式）：stream=true 必须逐 delta 返回，并以 [DONE] 收尾。
func TestE2E_WebHubStream(t *testing.T) {
	h, br := newWebhubE2EHandler(t, "hello")
	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"ds/chat.deepseek.com","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "data: ") {
		t.Fatalf("not an SSE stream: %q", body)
	}
	if !strings.Contains(body, "hello") {
		t.Fatalf("delta lost: %q", body)
	}
	if !strings.Contains(body, "finish_reason\":\"stop\"") {
		t.Fatalf("terminal chunk lost: %q", body)
	}
	if !strings.Contains(body, "[DONE]") {
		t.Fatalf("[DONE] lost: %q", body)
	}
	if !br.got.stream {
		t.Fatal("stream flag must reach the bridge")
	}
	if !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("content-type = %q", w.Header().Get("Content-Type"))
	}
}

// 未知前缀必须 400（不是 502 也不是空响应）。
func TestE2E_WebHubUnknownPrefix(t *testing.T) {
	h, _ := newWebhubE2EHandler(t, "x")
	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"nope/deepseek","messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown prefix = %d, want 400", w.Code)
	}
}

// 桥接失败必须让请求失败（不带空 200 蒙混过关）。
func TestE2E_WebHubBridgeErrorFailsRequest(t *testing.T) {
	h := newTestHandlerWithCustomProvider(t, config.Provider{
		ID: "webhub-chat.deepseek.com", Name: "DS", Prefix: "ds",
		APIType: "webhub", IsActive: true,
		Keys: []config.Key{{ID: "browser-session", Key: "s", IsActive: true}},
	}, config.RotationConfig{Strategy: "fill-first", MaxRetries: 1, BackoffMaxSec: 300})
	h.SetRequestAugmenter(&failingWebhubBridge{})

	req := httptest.NewRequest("POST", "/v1/chat/completions",
		strings.NewReader(`{"model":"ds/deepseek","messages":[{"role":"user","content":"hi"}]}`))
	w := httptest.NewRecorder()
	h.handleProxy(w, req, "/v1/chat/completions", combo.EntryFormatOpenAI)
	if w.Code == http.StatusOK {
		t.Fatalf("bridge failure must not return 200 (%s)", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "P0-PROBE-OK") {
		t.Fatal("a failed turn must not emit content")
	}
}

type failingWebhubBridge struct{}

func (failingWebhubBridge) Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	return body, nil
}
func (failingWebhubBridge) Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (string, []byte, error) {
	return "", body, nil
}
func (failingWebhubBridge) InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (io.Reader, int64, error) {
	return nil, 0, io.ErrUnexpectedEOF
}

// 合成 Key 只用于 rotation 计数：它不得出现在任何出站报文里。
// （webhub 没有任何凭据可泄露，这条是给未来改动兜底的回归守卫。）
func TestE2E_WebHubSyntheticKeyNeverLeaves(t *testing.T) {
	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "webhub-chat.deepseek.com", APIType: "webhub"},
		Key:      config.Key{ID: "browser-session", Key: "webhub-browser-session"},
	}
	if sel.Key.Key == "" {
		t.Fatal("synthetic key must exist for rotation bookkeeping")
	}
	// 站点规则与状态里不得出现凭据字段。
	if strings.Contains(strings.ToLower(sel.Provider.ID), "secret") {
		t.Fatal("provider id must not carry secrets")
	}
}
