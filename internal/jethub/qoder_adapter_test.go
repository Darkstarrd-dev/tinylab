package jethub

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// --- 载荷纯构造层（加密后本地不可解，只能靠这里锁字段） ---

// ⚠️ business 决定服务端路由池：缺失时 qfmodel 恒落到故障节点
// oa_qwen-plus-2025-04-28（真实缺陷，2026-09-20 定位）。
func TestBuildQoderInferPayloadBusinessAlwaysPresent(t *testing.T) {
	payload := buildQoderInferPayload(&qoderInferAsk{
		ModelKey: "qfmodel", UserText: "hi", Business: map[string]any{"type": "agent"},
	})
	biz, ok := payload["business"].(map[string]any)
	if !ok || biz["type"] != "agent" {
		t.Fatalf("business missing/malformed: %v", payload["business"])
	}
}

// 顶层 tools 键恒在（空数组而非缺字段），与客户端一致。
func TestBuildQoderInferPayloadToolsAlwaysArray(t *testing.T) {
	payload := buildQoderInferPayload(&qoderInferAsk{ModelKey: "qfmodel", UserText: "hi"})
	tools, ok := payload["tools"].([]any)
	if !ok || len(tools) != 0 {
		t.Fatalf("tools must be an (empty) array, got %T %v", payload["tools"], payload["tools"])
	}
	// tools 真的下发：缺了模型只能用正文 XML 臆造工具调用（真实缺陷）。
	withTools := buildQoderInferPayload(&qoderInferAsk{
		ModelKey: "qfmodel", UserText: "hi",
		Tools: []any{map[string]any{"type": "function", "function": map[string]any{"name": "f"}}},
	})
	if got := withTools["tools"].([]any); len(got) != 1 {
		t.Fatalf("tools not forwarded: %v", withTools["tools"])
	}
}

// 工具历史：assistant 的 tool_calls（content null）与 tool 的 tool_call_id
// 必须保留 —— 丢了模型看不到自己调用过什么（同 TRAE 的同型缺陷）。
func TestQoderExtractInferInputsKeepsToolHistory(t *testing.T) {
	body := `{"messages":[
		{"role":"system","content":"be brief"},
		{"role":"user","content":"list files"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"ls","arguments":"{}"}}]},
		{"role":"tool","content":"a.txt","tool_call_id":"c1"},
		{"role":"user","content":"thanks"}],
		"tools":[{"type":"function","function":{"name":"ls","description":"","parameters":{"type":"object"}}}],
		"max_tokens":512,"reasoning_effort":"none"}`
	inputs := qoderExtractInferInputs([]byte(body))
	if inputs.SystemText != "be brief" {
		t.Fatalf("system text: %q", inputs.SystemText)
	}
	if inputs.UserText != "thanks" {
		t.Fatalf("userText must come from the LAST user message: %q", inputs.UserText)
	}
	if len(inputs.History) != 4 {
		t.Fatalf("history should exclude system, got %d", len(inputs.History))
	}
	assistant := inputs.History[1]
	if assistant.Content != nil {
		t.Fatalf("assistant tool-call content must stay null: %v", assistant.Content)
	}
	if len(assistant.ToolCalls) != 1 || assistant.ToolCalls[0].(map[string]any)["id"] != "c1" {
		t.Fatalf("tool_calls lost: %v", assistant.ToolCalls)
	}
	tool := inputs.History[2]
	if tool.ToolCallID != "c1" {
		t.Fatalf("tool_call_id lost: %+v", tool)
	}
	// 空描述不出现（ref $Hc：缺省时该键不存在）。
	fn := inputs.Tools[0].(map[string]any)["function"].(map[string]any)
	if _, has := fn["description"]; has {
		t.Fatalf("empty description must be omitted: %v", fn)
	}
	if inputs.MaxTokens == nil || *inputs.MaxTokens != 512 {
		t.Fatalf("max_tokens: %v", inputs.MaxTokens)
	}
}

// reasoning_effort=none → enable_thinking=false（真正关闭）；不发档位时
// 两个字段都不写（verify-qoder-effort-wire 的离线等价）。
func TestBuildQoderInferPayloadReasoningWire(t *testing.T) {
	effortNone := buildQoderInferPayload(&qoderInferAsk{ModelKey: "qfmodel", UserText: "x", ReasoningEffort: "none"})
	params := effortNone["parameters"].(map[string]any)
	if params["enable_thinking"] != false || params["reasoning_effort"] != "none" {
		t.Fatalf("none wire wrong: %v", params)
	}
	noEffort := buildQoderInferPayload(&qoderInferAsk{ModelKey: "qfmodel", UserText: "x"})
	if _, has := noEffort["parameters"].(map[string]any)["reasoning_effort"]; has {
		t.Fatal("reasoning_effort must be absent when no effort given")
	}
}

// 带图消息的 content 数组必须原样保留（压成纯文本 = 图片丢失，真实缺陷）；
// imageUrls 恒 null 是忠实复刻（官方 Hyc()）。
func TestQoderExtractInferInputsPreservesImageContent(t *testing.T) {
	body := `{"messages":[{"role":"user","content":[
		{"type":"text","text":"看这张图"},
		{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}`
	inputs := qoderExtractInferInputs([]byte(body))
	if inputs.UserText != "看这张图" {
		t.Fatalf("userText from multimodal content: %q", inputs.UserText)
	}
	content, ok := inputs.History[0].Content.([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("image content array lost: %v", inputs.History[0].Content)
	}
	payload := buildQoderInferPayload(&qoderInferAsk{ModelKey: "qfmodel", UserText: inputs.UserText, History: inputs.History})
	ctx := payload["chat_context"].(map[string]any)
	if ctx["imageUrls"] != nil {
		t.Fatalf("imageUrls must stay null (official Hyc()): %v", ctx["imageUrls"])
	}
}

// 两站模型 meta 不能互相套用：CN dfmodel 无 is_reasoning（intl 为 true）、
// CN mmodel 是 is_vl=false。
func TestQoderModelMetaPerProduct(t *testing.T) {
	if !qoderModelMetaFor("qoder", "dfmodel").Reasoning {
		t.Fatal("intl dfmodel should be reasoning")
	}
	if qoderModelMetaFor("qodercn", "dfmodel").Reasoning {
		t.Fatal("CN dfmodel is_reasoning is false (directory)")
	}
	if qoderModelMetaFor("qodercn", "mmodel").Vl {
		t.Fatal("CN mmodel is_vl is false")
	}
	if qoderModelMetaFor("qodercn", "mmodel").Ctx != 200_000 {
		t.Fatal("CN mmodel only has the 200K tier")
	}
}

// --- 信封剥离 ---

func TestQoderEnvelopeInnerTextShapes(t *testing.T) {
	if inner, ok := qoderEnvelopeInnerText(`{"body":"{\"a\":1}"}`); !ok || inner != `{"a":1}` {
		t.Fatalf("string body: %q %v", inner, ok)
	}
	if inner, ok := qoderEnvelopeInnerText(`{"body":{"a":1}}`); !ok || inner != `{"a":1}` {
		t.Fatalf("object body: %q %v", inner, ok)
	}
	if _, ok := qoderEnvelopeInnerText(`{"choices":[]}`); ok {
		t.Fatal("no body field → not an envelope")
	}
	if _, ok := qoderEnvelopeInnerText(`not json`); ok {
		t.Fatal("unparsable → not an envelope")
	}
}

// 剥壳转换：data 帧解包、event 行保留、[DONE] 透传、空行保形。
func TestQoderEnvelopeReaderTransform(t *testing.T) {
	stream := "data:{\"body\":\"{\\\"choices\\\":[{\\\"delta\\\":{\\\"content\\\":\\\"Q\\\"}}]}\"}\n" +
		"event: finish\n" +
		"\n" +
		"data:[DONE]\n"
	r := newQoderEnvelopeReader(strings.NewReader(stream), nil)
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	// ref 转发格式是 `data: ${inner}\n`（data: 后带一个空格）。
	want := "data: {\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}\nevent: finish\n\ndata: [DONE]\n"
	if got != want {
		t.Fatalf("transform mismatch:\n got %q\nwant %q", got, want)
	}
}

// ⚠️ 错误帧保真转发：code 独立字段 + message 原样（不拼后缀）——
// 后缀会污染排队 message 里的内层 JSON，使二次解析拿不到延迟。
func TestQoderEnvelopeReaderErrorFrameFaithful(t *testing.T) {
	inner := `{"code":"10605","message":"{\"isQueued\":true,\"retryAfterSeconds\":30}"}`
	stream := "data:" + innerEnvelopeBody(t, inner) + "\n"
	r := newQoderEnvelopeReader(strings.NewReader(stream), nil)
	out, _ := io.ReadAll(r)
	line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "data:"))
	var frame map[string]any
	if err := json.Unmarshal([]byte(line), &frame); err != nil {
		t.Fatalf("frame unparsable: %v (%q)", err, line)
	}
	if frame["code"] != "10605" {
		t.Fatalf("code field must survive independently: %v", frame)
	}
	if frame["type"] != "model_error" {
		t.Fatalf("type must be model_error: %v", frame)
	}
	msg, _ := frame["message"].(string)
	var innerBack map[string]any
	if err := json.Unmarshal([]byte(msg), &innerBack); err != nil {
		t.Fatalf("message must stay parseable inner JSON (no suffix pollution): %q", msg)
	}
	if innerBack["retryAfterSeconds"] != float64(30) {
		t.Fatalf("retryAfterSeconds lost: %v", innerBack)
	}
}

func innerEnvelopeBody(t *testing.T, inner string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"body": inner, "statusCodeValue": 200, "statusCode": "OK"})
	return string(b)
}

// --- 错误帧分类（同型缺陷防线：HTTP 层与 SSE 层共用一套判据） ---

// 瞬时排队是 isQueued:false（serviceAvailable:true, waitTime:0）——判据不能
// 要求 isQueued===true，否则落到 1s 兜底而非服务端要求的 2s。
func TestQoderClassifyErrorFrameQueueTransient(t *testing.T) {
	inner := `{"code":"10605","message":"{\"isQueued\":false,\"serviceAvailable\":true,\"waitTime\":0,\"retryAfterSeconds\":2}"}`
	ms, perr, handled := qoderClassifyErrorFrame(inner)
	if !handled || perr != nil || ms != 2000 {
		t.Fatalf("transient queue: ms=%d err=%v handled=%v", ms, perr, handled)
	}
	// 无 code 的网关形态（内层消息直接出现）也要认。
	innerNoCode := `{"isQueued":true,"retryAfterSeconds":5}`
	ms2, _, handled2 := qoderClassifyErrorFrame(innerNoCode)
	if !handled2 || ms2 != 5000 {
		t.Fatalf("gateway-shape queue: ms=%d handled=%v", ms2, handled2)
	}
}

// 计费 110 → BillingLockError，Until 必须是 UTC+8 当日 24:00（严格大于 now）。
func TestQoderClassifyErrorFrameBilling(t *testing.T) {
	for _, inner := range []string{
		`{"code":110,"message":"Billing daily count exceeded","type":"model_error"}`,
		`{"message":"Qoder assistant failed: billing_error"}`,
	} {
		_, perr, handled := qoderClassifyErrorFrame(inner)
		if !handled {
			t.Fatalf("billing not handled: %s", inner)
		}
		ble, ok := perr.(*upstreamerr.BillingLockError)
		if !ok {
			t.Fatalf("want BillingLockError, got %T (%v)", perr, perr)
		}
		if !ble.Until.After(time.Now()) {
			t.Fatalf("Until must be in the future: %v", ble.Until)
		}
		if got := ble.Until.UnixMilli(); got != NextUtc8DayStartMs(time.Now().UnixMilli()) {
			t.Fatalf("Until must be the UTC+8 day start: got %d want %d", got, NextUtc8DayStartMs(time.Now().UnixMilli()))
		}
	}
}

// 认证失败（105/auth_error）走续期；重复请求直接重发；未知错误透传。
func TestQoderClassifyErrorFrameOtherCodes(t *testing.T) {
	if _, perr, handled := qoderClassifyErrorFrame(`{"code":"105","message":"auth_error"}`); !handled || perr != errQoderAuth {
		t.Fatalf("auth 105: %v %v", perr, handled)
	}
	ms, perr, handled := qoderClassifyErrorFrame(`{"code":"duplicate_request","message":"dup"}`)
	if !handled || perr != nil || ms != 100 {
		t.Fatalf("duplicate: ms=%d err=%v handled=%v", ms, perr, handled)
	}
	if _, _, handled := qoderClassifyErrorFrame(`{"message":"[FAIL]node:oa_qwen-plus msg:Execution failed"}`); handled {
		t.Fatal("unknown error must pass through, not retry")
	}
}

// --- InterceptResponse：两条通道（HTTP 403 + SSE 帧内） ---

func TestQoderInterceptResponseHTTPQueueAndBilling(t *testing.T) {
	m := newTestManager(t).m
	resp := func(status int, body string) *http.Response {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
	}
	// ① HTTP 403 + 排队 JSON（message 是「一个 JSON 字符串」）→ 等服务端延迟。
	queueBody := `{"code":"10605","message":"{\"isQueued\":true,\"retryAfterSeconds\":3}"}`
	out, ms, err := m.qoderInterceptResponse(resp(403, queueBody), "qoder", "a1", "qfmodel", true)
	if err != nil || out != nil || ms != 3000 {
		t.Fatalf("403 queue: out=%v ms=%d err=%v", out, ms, err)
	}
	// ② 顶层 code 是 403、10605 嵌在 message 里的双层形态（第三次回归）。
	nested := `{"code":403,"message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,\\\"retryAfterSeconds\\\":30}\"}","type":"model_error"}`
	_, ms2, err2 := m.qoderInterceptResponse(resp(403, nested), "qoder", "a1", "qfmodel", true)
	if err2 != nil || ms2 != QueueMaxDelayMS {
		t.Fatalf("nested 403 queue must clamp to 10s: ms=%d err=%v", ms2, err2)
	}
	// ③ 计费 110 → 不可重试的 BillingLockError（不能落在 SERVER 白重试）。
	_, _, err3 := m.qoderInterceptResponse(resp(403, `{"code":110,"message":"Billing daily count exceeded"}`), "qoder", "a1", "qfmodel", true)
	if _, ok := err3.(*upstreamerr.BillingLockError); !ok {
		t.Fatalf("billing must be BillingLockError, got %T (%v)", err3, err3)
	}
	// ④ 认证失败（401）→ errQoderAuth（凭据缺失时续期失败也要显式报错）。
	if _, _, err4 := m.qoderInterceptResponse(resp(401, `{"message":"unauthorized"}`), "qoder", "a1", "qfmodel", true); err4 == nil {
		t.Fatal("401 must surface an error (refresh path)")
	}
}

// SSE 帧内排队：HTTP 200 + 首帧内嵌 10605 → 重试信号（通道②，第一版漏掉的那条）。
func TestQoderInterceptResponseSSEQueue(t *testing.T) {
	m := newTestManager(t).m
	sse := "data:" + innerEnvelopeBody(t, `{"code":"10605","message":"{\"isQueued\":true,\"retryAfterSeconds\":2}"}`) + "\n\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sse))
	}))
	defer srv.Close()
	httpResp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer httpResp.Body.Close()
	out, ms, err := m.qoderInterceptResponse(httpResp, "qoder", "a1", "qfmodel", true)
	if err != nil || out != nil || ms != 2000 {
		t.Fatalf("SSE queue: out=%v ms=%d err=%v", out, ms, err)
	}
}

// 正常流：信封被剥离、正文帧原样到达客户端。
func TestQoderInterceptResponseSSENormal(t *testing.T) {
	m := newTestManager(t).m
	chunk := `{"choices":[{"delta":{"content":"Q"}}]}`
	sse := "data:" + innerEnvelopeBody(t, chunk) + "\ndata:[DONE]\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(sse))
	}))
	defer srv.Close()
	httpResp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer httpResp.Body.Close()
	out, ms, err := m.qoderInterceptResponse(httpResp, "qoder", "a1", "qfmodel", true)
	if err != nil || out == nil || ms != 0 {
		t.Fatalf("normal SSE: out=%v ms=%d err=%v", out, ms, err)
	}
	body, _ := io.ReadAll(out)
	got := string(body)
	if !strings.Contains(got, `"choices"`) || strings.Contains(got, `"body"`) {
		t.Fatalf("envelope must be stripped: %q", got)
	}
	if !strings.Contains(got, "data: [DONE]") {
		t.Fatalf("[DONE] must pass through: %q", got)
	}
}

// --- 端到端：客户端 OpenAI 体 → WASM 加密请求（真实二进制） ---

func TestQoderCustomizeEndToEnd(t *testing.T) {
	m := newSeedQoderManager(t)
	accountID := firstQoderAccount(t, m)

	req, _ := http.NewRequest("POST", "http://client/v1/chat/completions", nil)
	outURL, outBody, err := m.qoderCustomize(req, []byte(
		`{"model":"qfmodel","messages":[{"role":"user","content":"你好"}],"max_tokens":128}`), "qoder", accountID, "qfmodel")
	if err != nil {
		t.Fatalf("qoderCustomize: %v", err)
	}
	if !strings.HasPrefix(outURL, "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation") {
		t.Fatalf("outURL must be the encrypted endpoint (api2, NOT api2-v2): %s", outURL)
	}
	for _, key := range []string{"FetchKeys=llm_model_result", "AgentId=agent_common", "Encode=1"} {
		if !strings.Contains(outURL, key) {
			t.Fatalf("outURL missing %s: %s", key, outURL)
		}
	}
	auth := req.Header.Get("Authorization")
	if auth == "" || auth == "Bearer client-token" || strings.HasPrefix(auth, "Bearer ") && !strings.Contains(auth, "COSY.") {
		// WASM 签名头是 Bearer COSY.<载荷>.<签名> —— 普通 Bearer 覆盖会 403。
		t.Fatalf("Authorization must be the WASM COSY signature, got %q", auth)
	}
	// ⚠️ outBody 是 WASM 加密产物（自定义编码），不是 JSON —— 「解析不出
	// JSON 且非空」恰恰是加密成功的证据。
	if len(outBody) == 0 {
		t.Fatal("encrypted body must not be empty")
	}
	var probe map[string]any
	if err := json.Unmarshal(outBody, &probe); err == nil {
		t.Fatalf("body must be the ENCRYPTED payload (not plain JSON): %q", string(outBody))
	}
}
