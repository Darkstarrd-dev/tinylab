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
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// newCompatTestHandler builds a handler whose single provider carries a model
// with ChatResponsesCompat enabled, so /v1/chat/completions requests for that
// model are rewritten to /v1/responses upstream.
func newCompatTestHandler(t *testing.T, baseURL string) *Handler {
	t.Helper()
	provider := config.Provider{
		ID: "openai", Name: "OpenAI", Prefix: "openai",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-compat", Name: "OpenKey", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "muse-1.2", QuotaType: "limited", ChatResponsesCompat: true}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	usageBuf := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// TestChatToResponsesBody_AgentMultiturn reproduces the original failure: an
// agent's second turn contains the assistant tool_call message and the tool
// result, which the old converter silently dropped, producing a broken
// conversation for the Responses API.
func TestChatToResponsesBody_AgentMultiturn(t *testing.T) {
	chat := map[string]any{
		"model": "muse-1.2",
		"messages": []any{
			map[string]any{"role": "system", "content": "You are an agent"},
			map[string]any{"role": "user", "content": "search latest news"},
			map[string]any{"role": "assistant", "content": "",
				"tool_calls": []any{
					map[string]any{"id": "call_1", "type": "function",
						"function": map[string]any{"name": "web_search", "arguments": `{"q":"news"}`}},
				}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "top stories"},
			map[string]any{"role": "user", "content": "summarize"},
		},
	}
	got := chatToResponsesBody(chat)

	input, _ := got["input"].([]any)
	if len(input) != 5 {
		t.Fatalf("expected 5 input items (tool calls/result must survive), got %d: %v", len(input), input)
	}

	// Assistant tool_call must become a function_call item with the same id.
	fc, ok := input[2].(map[string]any)
	if !ok {
		t.Fatalf("input[2] not an object: %v", input[2])
	}
	if fc["type"] != "function_call" {
		t.Fatalf("expected input[2].type=function_call, got %v", fc["type"])
	}
	if fc["call_id"] != "call_1" || fc["name"] != "web_search" || fc["arguments"] != `{"q":"news"}` {
		t.Errorf("function_call item lost data: %v", fc)
	}

	// Tool result must become a function_call_output item keyed to call_1.
	fco, ok := input[3].(map[string]any)
	if !ok {
		t.Fatalf("input[3] not an object: %v", input[3])
	}
	if fco["type"] != "function_call_output" {
		t.Fatalf("expected input[3].type=function_call_output, got %v", fco["type"])
	}
	if fco["call_id"] != "call_1" || fco["output"] != "top stories" {
		t.Errorf("function_call_output lost data: %v", fco)
	}

	// Assistant message is still present as a text turn (empty content skipped).
	if _, ok := input[1].(map[string]any); !ok {
		t.Fatalf("input[1] not an object: %v", input[1])
	}
}

// TestChatToResponsesBody_ToolsAndMetadata verifies the tools/tool_choice
// translation and the max_tokens → max_output_tokens mapping, without which
// the upstream model cannot receive function definitions.
func TestChatToResponsesBody_ToolsAndMetadata(t *testing.T) {
	chat := map[string]any{
		"model":       "muse-1.2",
		"temperature": 0.5,
		"max_tokens":  2048,
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{
				"name": "web_search", "description": "Search the web",
				"parameters": map[string]any{"type": "object"}, "strict": true,
			}},
		},
		"tool_choice": map[string]any{"type": "function", "function": map[string]any{"name": "web_search"}},
		"messages":    []any{map[string]any{"role": "user", "content": "hi"}},
	}
	got := chatToResponsesBody(chat)

	tools, _ := got["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tools entry, got %d", len(tools))
	}
	tm, _ := tools[0].(map[string]any)
	if tm["type"] != "function" || tm["name"] != "web_search" ||
		tm["description"] != "Search the web" || tm["strict"] != true {
		t.Errorf("tool not externally→internally tagged correctly: %v", tm)
	}
	if _, ok := tm["parameters"].(map[string]any); !ok {
		t.Errorf("tool parameters not preserved: %v", tm)
	}

	tc, _ := got["tool_choice"].(map[string]any)
	if tc["type"] != "function" || tc["name"] != "web_search" {
		t.Errorf("tool_choice not mapped: %v", tc)
	}
	if v, _ := got["max_output_tokens"].(int); v != 2048 {
		t.Errorf("expected max_output_tokens=2048, got %v", got["max_output_tokens"])
	}
	if v, _ := got["temperature"].(float64); v != 0.5 {
		t.Errorf("expected temperature preserved, got %v", got["temperature"])
	}
	if store, ok := got["store"].(bool); !ok || store {
		t.Errorf("expected store=false, got %v", got["store"])
	}
}

// TestMaybeRewriteChatVisionToResponses_CompatGeneric verifies the provider
// toggle rewrites a plain chat request (no image) to /v1/responses — the
// generic chat→responses path that the agent flow relies on.
func TestMaybeRewriteChatVisionToResponses_CompatGeneric(t *testing.T) {
	body := []byte(`{"model":"muse-1.2","stream":true,"messages":[{"role":"user","content":"hello"}]}`)
	parsed := map[string]any{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	got, path, ok := maybeRewriteChatVisionToResponses(nil, "/v1/chat/completions", parsed, "muse-1.2", true)
	if !ok {
		t.Fatal("expected rewrite for a ChatResponsesCompat model")
	}
	if path != "/v1/responses" {
		t.Fatalf("expected upstream path /v1/responses, got %q", path)
	}
	var sent map[string]any
	if err := json.Unmarshal(got, &sent); err != nil {
		t.Fatal(err)
	}
	if _, ok := sent["input"].([]any); !ok {
		t.Fatalf("expected input array in rewritten body, got %v", sent)
	}
}

// TestResponsesToChatState_ToolCallStream feeds a Responses SSE event sequence
// for an agent turn (text + function call) and asserts the translator emits the
// chat tool_calls delta chunks and the "tool_calls" finish_reason that clients
// need to continue the loop. The old translator dropped function calls entirely.
func TestResponsesToChatState_ToolCallStream(t *testing.T) {
	conv := newResponsesToChatState("muse-1.2")

	var payloads []string
	feed := func(ev map[string]any) {
		for _, p := range conv.OnEvent(ev) {
			payloads = append(payloads, string(p))
		}
	}
	feed(map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_1", "created_at": float64(1700000000), "model": "muse-1.2"}})
	feed(map[string]any{"type": "response.output_text.delta", "item_id": "msg_1", "delta": "Let me search"})
	feed(map[string]any{"type": "response.output_item.added", "output_index": float64(1), "item": map[string]any{
		"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "web_search"}})
	feed(map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": `{"q":`})
	feed(map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": `"news"}`})
	feed(map[string]any{"type": "response.completed", "response": map[string]any{
		"id": "resp_1", "status": "requires_action", "model": "muse-1.2",
		"usage": map[string]any{"input_tokens": float64(10), "output_tokens": float64(5)}}})

	var gotArgs string
	finChunks := 0
	sawText, sawAnnounce := false, false
	for _, p := range payloads {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(p), &chunk); err != nil || len(chunk.Choices) == 0 {
			continue
		}
		d := chunk.Choices[0].Delta
		if d.Content != "" {
			sawText = true
		}
		for _, tc := range d.ToolCalls {
			if tc.ID == "call_1" && tc.Function.Name == "web_search" {
				sawAnnounce = true
			}
			gotArgs += tc.Function.Arguments
		}
		if chunk.Choices[0].FinishReason != nil && *chunk.Choices[0].FinishReason == "tool_calls" {
			finChunks++
		}
	}
	if !sawText {
		t.Errorf("text delta missing from output: %s", strings.Join(payloads, " "))
	}
	if !sawAnnounce {
		t.Errorf("tool call announce chunk missing: %s", strings.Join(payloads, " "))
	}
	if gotArgs != `{"q":"news"}` {
		t.Errorf("tool call arguments delta wrong: got %q", gotArgs)
	}
	if finChunks != 1 {
		t.Errorf("expected exactly one terminal finish_reason tool_calls chunk, got %d", finChunks)
	}
	if conv.usageInput != 10 || conv.usageOutput != 5 {
		t.Errorf("usage not captured: in=%d out=%d", conv.usageInput, conv.usageOutput)
	}
}

// TestResponsesToChatState_TextStream covers the plain-text terminal path so the
// converter still emits content + "stop" + a single finish chunk.
func TestResponsesToChatState_TextStream(t *testing.T) {
	conv := newResponsesToChatState("muse-1.2")
	var payloads []string
	feed := func(ev map[string]any) {
		for _, p := range conv.OnEvent(ev) {
			payloads = append(payloads, string(p))
		}
	}
	feed(map[string]any{"type": "response.output_text.delta", "delta": "hi"})
	feed(map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed"}})
	joined := strings.Join(payloads, "\n")
	if !strings.Contains(joined, `"content":"hi"`) || !strings.Contains(joined, `"finish_reason":"stop"`) {
		t.Errorf("text stream translation broken: %s", joined)
	}
}

// TestPassThroughResponsesAsChat_ToolCall covers the non-streaming path: a
// Responses body with a message + function_call must become a chat completion
// carrying both message.tool_calls and finish_reason "tool_calls".
func TestPassThroughResponsesAsChat_ToolCall(t *testing.T) {
	h := newCompatTestHandler(t, "http://upstream.invalid")
	upstreamBody := `{
		"id":"resp_1","object":"response","created_at":1700000000,"status":"requires_action",
		"output":[
			{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Let me search","annotations":[]}]},
			{"id":"fc_1","type":"function_call","call_id":"call_1","name":"web_search","arguments":"{\"q\":\"news\"}"}
		],
		"usage":{"input_tokens":10,"output_tokens":5}
	}`
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	}
	rec := httptest.NewRecorder()
	h.passThroughResponsesAsChat(rec, resp, "muse-1.2", nil, 10,
		[]byte(`{"model":"muse-1.2"}`), "req1", nil, "http://upstream.invalid/v1/responses", "muse-1.2", "sess")

	var chat map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &chat); err != nil {
		t.Fatalf("output not JSON: %v body=%s", err, rec.Body.String())
	}
	choices, _ := chat["choices"].([]any)
	if len(choices) != 1 {
		t.Fatalf("expected 1 choice, got %v", chat)
	}
	ch, _ := choices[0].(map[string]any)
	if ch["finish_reason"] != "tool_calls" {
		t.Errorf("expected finish_reason tool_calls, got %v", ch["finish_reason"])
	}
	msg, _ := ch["message"].(map[string]any)
	if msg["content"] != "Let me search" {
		t.Errorf("text lost: %v", msg["content"])
	}
	tcs, _ := msg["tool_calls"].([]any)
	if len(tcs) != 1 {
		t.Fatalf("expected 1 tool_call, got %v", msg)
	}
	tc, _ := tcs[0].(map[string]any)
	if tc["id"] != "call_1" || tc["type"] != "function" {
		t.Errorf("tool_call id/type wrong: %v", tc)
	}
	fn, _ := tc["function"].(map[string]any)
	if fn["name"] != "web_search" || fn["arguments"] != `{"q":"news"}` {
		t.Errorf("tool_call function wrong: %v", fn)
	}
}

// TestChatResponsesCompat_E2E_ToolCall drives the full /v1/chat/completions →
// /v1/responses → chat SSE round trip for an agent command. It asserts the
// upstream receives tool definitions + the tool result (which the old
// converter dropped) and that the client receives the tool_call delta stream
// with the "tool_calls" finish_reason.
func TestChatResponsesCompat_E2E_ToolCall(t *testing.T) {
	var gotPath string
	var gotBody string
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`data: {"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"muse-1.2"}}

data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Let me search"}

data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"web_search"}}

data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"q\":\"news\"}"}

data: {"type":"response.completed","response":{"id":"resp_1","status":"requires_action","model":"muse-1.2","usage":{"input_tokens":10,"output_tokens":5}}}

`))
	}))
	defer mockUpstream.Close()

	h := newCompatTestHandler(t, mockUpstream.URL)

	body := `{
		"model":"openai/muse-1.2","stream":true,
		"tools":[{"type":"function","function":{"name":"web_search","description":"Search","parameters":{"type":"object"}}}],
		"messages":[
			{"role":"user","content":"search latest news"},
			{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\"q\":\"news\"}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"top stories"},
			{"role":"user","content":"summarize"}
		]
	}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.ChatCompletions(w, req)
	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", resp.StatusCode, readBody(resp))
	}

	if gotPath != "/v1/responses" {
		t.Fatalf("expected upstream path /v1/responses, got %q", gotPath)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("upstream body not JSON: %v", err)
	}
	// tool definitions must reach the upstream model.
	tools, _ := sent["tools"].([]any)
	if len(tools) != 1 {
		t.Errorf("tools not forwarded upstream: %v", sent["tools"])
	}
	// the tool result must survive conversion.
	input, _ := sent["input"].([]any)
	var foundOutput bool
	for _, it := range input {
		im, _ := it.(map[string]any)
		if im["type"] == "function_call_output" && im["call_id"] == "call_1" && im["output"] == "top stories" {
			foundOutput = true
		}
	}
	if !foundOutput {
		t.Errorf("function_call_output missing upstream (input=%v)", input)
	}
	// the client must see the tool_call delta stream and the right finish.
	clientBody := w.Body.String()
	if !strings.Contains(clientBody, `"name":"web_search"`) {
		t.Errorf("client never received tool call name: %s", clientBody)
	}
	if !strings.Contains(clientBody, `"arguments":"{\"q\":\"news\"}"`) {
		t.Errorf("client never received tool call arguments: %s", clientBody)
	}
	if !strings.Contains(clientBody, `"finish_reason":"tool_calls"`) {
		t.Errorf("client never received tool_calls finish_reason: %s", clientBody)
	}
	if !strings.Contains(clientBody, "data: [DONE]") {
		t.Errorf("client never received [DONE]: %s", clientBody)
	}
}
