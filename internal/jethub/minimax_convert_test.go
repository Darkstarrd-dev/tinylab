package jethub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// minimaxReasoningSSE is a realistic Anthropic Messages stream (thinking +
// text + tool_use), mirroring the event set verified 2026-09-29 in the
// reference implementation.
const minimaxReasoningSSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"MiniMax-M3.1-Flash-Preview","content":[],"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想一下"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc123"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"北京\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42,"output_tokens_details":{"thinking_tokens":7}}}

event: message_stop
data: {"type":"message_stop"}

`

// --- 出站 URL ---

func TestMinimaxCustomizeReturnsFullInferURL(t *testing.T) {
	m := newSeedMinimaxManager(t)
	// 生产装配：RegisterDefaultProducts 把 Product.InferURL 发布给 Manager
	// （Customize 据此覆盖出站 URL）。
	RegisterDefaultProducts(NewBridge(m, newFakeRegistry()))
	m.SetAugmenter("minimax", m.minimaxAugment) // app 装配时注册（RegisterProviderAugmenters）
	id := firstMinimaxAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://agent.minimax.cn/v1/chat/completions", nil)
	body := `{"model":"MiniMax-M3","messages":[{"role":"user","content":"hi"}]}`
	outURL, outBody, err := m.Customize(req, []byte(body), "jethub-minimax", id, "MiniMax-M3")
	if err != nil {
		t.Fatal(err)
	}
	// 用户实测的 404 根因：路径必须是完整的 /mavis/api/v1/llm/v1/messages。
	if outURL != "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages" {
		t.Fatalf("customize URL wrong: %q", outURL)
	}
	var parsed map[string]any
	if err := json.Unmarshal(outBody, &parsed); err != nil {
		t.Fatal(err)
	}
	// OpenAI 进站 → 必须已转成 Anthropic 形状。
	if _, ok := parsed["system"]; ok {
		t.Fatal("empty system must not be emitted")
	}
	if parsed["stream"] != true {
		t.Fatal("upstream only implements the streaming branch → stream:true required")
	}
	if parsed["max_tokens"] != float64(128_000) {
		t.Fatalf("max_tokens must default to the model limit, got %v", parsed["max_tokens"])
	}
	msgs, _ := parsed["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("messages wrong: %v", parsed["messages"])
	}
}

func TestMinimaxCustomizeLeavesOtherProvidersAlone(t *testing.T) {
	m := newSeedMinimaxManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://example.com/v1/chat/completions", nil)
	outURL, outBody, err := m.Customize(req, []byte(`{"model":"GLM-5.2"}`), "jethub-codearts", "a1", "GLM-5.2")
	if err != nil {
		t.Fatal(err)
	}
	if outURL != "" {
		t.Fatalf("non-minimax providers must not override the URL, got %q", outURL)
	}
	if string(outBody) != `{"model":"GLM-5.2"}` {
		t.Fatalf("body must pass through: %s", outBody)
	}
}

// --- 请求体转换 ---

func TestMinimaxBuildRequestAnthropicEntry(t *testing.T) {
	out, err := minimaxBuildRequest(true, []byte(`{"model":"MiniMax-M3","messages":[{"role":"user","content":"hi"}]}`), "MiniMax-M3")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	_ = json.Unmarshal(out, &parsed)
	if parsed["stream"] != true {
		t.Fatal("Anthropic entry must be forced to stream:true (upstream has no non-stream branch)")
	}
	if _, ok := parsed["thinking"]; ok {
		t.Fatal("Anthropic entry must NOT invent a thinking block")
	}
}

func TestMinimaxOpenAIToAnthropicRequest(t *testing.T) {
	body := `{
		"model":"MiniMax-M3.1-Flash-Preview",
		"stream":true,
		"reasoning_effort":"high",
		"temperature":0.3,
		"stop":["STOP"],
		"messages":[
			{"role":"system","content":"你是助手"},
			{"role":"developer","content":[{"type":"text","text":"额外约束"}]},
			{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]},
			{"role":"assistant","content":"我来查","reasoning_content":"思考历史必须丢弃","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"晴 25 度"}
		],
		"tools":[{"type":"function","function":{"name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
		"tool_choice":"required"
	}`
	out, err := minimaxBuildRequest(false, []byte(body), "MiniMax-M3.1-Flash-Preview")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["system"] != "你是助手\n\n额外约束" {
		t.Fatalf("system must fold every system/developer message, got %#v", parsed["system"])
	}
	if parsed["stream"] != true {
		t.Fatal("stream:true required")
	}
	if parsed["max_tokens"] != float64(128_000) {
		t.Fatalf("max_tokens default wrong: %v", parsed["max_tokens"])
	}
	if parsed["temperature"] != 0.3 {
		t.Fatalf("temperature must pass through: %v", parsed["temperature"])
	}
	if fmt.Sprint(parsed["stop_sequences"]) != "[STOP]" {
		t.Fatalf("stop → stop_sequences wrong: %v", parsed["stop_sequences"])
	}
	// 思考档位：M3.1 必须 adaptive + output_config.effort。
	thinking, _ := parsed["thinking"].(map[string]any)
	if thinking["type"] != "adaptive" {
		t.Fatalf("M3.1 requires adaptive thinking, got %v", parsed["thinking"])
	}
	oc, _ := parsed["output_config"].(map[string]any)
	if oc["effort"] != "high" {
		t.Fatalf("output_config.effort wrong: %v", parsed["output_config"])
	}
	// system/developer 消息不得出现在 messages 里，且 tool 结果折进 user 消息。
	msgs, _ := parsed["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("expected user / assistant / user(tool_result), got %d: %s", len(msgs), out)
	}
	if text := string(out); strings.Contains(text, `"role":"system"`) || strings.Contains(text, `"role":"developer"`) || strings.Contains(text, `"role":"tool"`) {
		t.Fatalf("no OpenAI-only roles may reach the upstream: %s", out)
	}
	first, _ := msgs[0].(map[string]any)
	firstBlocks, _ := first["content"].([]any)
	if len(firstBlocks) != 2 {
		t.Fatalf("user blocks wrong: %s", out)
	}
	img, _ := firstBlocks[1].(map[string]any)
	if img["type"] != "image" {
		t.Fatalf("image block expected, got %v", img)
	}
	src, _ := img["source"].(map[string]any)
	if src["type"] != "base64" || src["media_type"] != "image/png" || src["data"] != "AAAA" {
		t.Fatalf("image source wrong: %v", src)
	}
	if strings.Contains(string(out), "image_url") || strings.Contains(string(out), "data:image") {
		t.Fatalf("upstream rejects image_url / data: prefixes: %s", out)
	}
	assistant, _ := msgs[1].(map[string]any)
	if assistant["role"] != "assistant" {
		t.Fatalf("assistant role lost: %s", out)
	}
	assistantBlocks, _ := assistant["content"].([]any)
	last, _ := assistantBlocks[len(assistantBlocks)-1].(map[string]any)
	if last["type"] != "tool_use" || last["id"] != "call_1" || last["name"] != "get_weather" {
		t.Fatalf("tool_use block wrong: %v", last)
	}
	input, _ := last["input"].(map[string]any)
	if input["city"] != "北京" {
		t.Fatalf("tool_use input must be the parsed arguments object: %v", input)
	}
	if strings.Contains(string(out), "思考历史必须丢弃") {
		t.Fatal("history reasoning_content must NOT be sent back (unsigned thinking is rejected)")
	}
	toolMsg, _ := msgs[2].(map[string]any)
	toolBlocks, _ := toolMsg["content"].([]any)
	result, _ := toolBlocks[0].(map[string]any)
	if result["type"] != "tool_result" || result["tool_use_id"] != "call_1" {
		t.Fatalf("tool_result block wrong: %v", result)
	}
	// tools / tool_choice 形态。
	tools, _ := parsed["tools"].([]any)
	tool0, _ := tools[0].(map[string]any)
	if tool0["name"] != "get_weather" || tool0["input_schema"] == nil {
		t.Fatalf("tools must use input_schema: %v", tool0)
	}
	choice, _ := parsed["tool_choice"].(map[string]any)
	if choice["type"] != "any" {
		t.Fatalf("tool_choice required → any, got %v", choice)
	}
}

func TestMinimaxOpenAIToAnthropicRemoteImageRejected(t *testing.T) {
	body := `{"model":"MiniMax-M3","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]}]}`
	if _, err := minimaxBuildRequest(false, []byte(body), "MiniMax-M3"); err == nil {
		t.Fatal("remote image URLs must fail loudly (upstream only accepts inline base64)")
	}
}

func TestMinimaxConsecutiveSameRoleMessagesCoalesce(t *testing.T) {
	body := `{"model":"MiniMax-M3","messages":[{"role":"user","content":"a"},{"role":"user","content":"b"}]}`
	out, err := minimaxBuildRequest(false, []byte(body), "MiniMax-M3")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	_ = json.Unmarshal(out, &parsed)
	msgs, _ := parsed["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("consecutive same-role messages must coalesce: %s", out)
	}
}

// --- 工具块配对 ---
//
// 上游 commit c74e0c2（ref src/minimax-messages.ts 的 resolveToolPairing +
// commitPending）修的是一条真实缺陷：Anthropic 拒绝孤儿工具块（没有结果的
// tool_use、指向不存在 tool_use 的 tool_result），也要求 tool_result 紧跟
// 产生它的 assistant —— 否则上游 400 `tool call result does not follow tool
// call (2013)`。本组用例锁住移植过来的三条通用不变量。

// minimaxConvertedMessages 跑一次 OpenAI → Anthropic 转换并取回 messages 数组。
func minimaxConvertedMessages(t *testing.T, messagesJSON string) []any {
	t.Helper()
	body := `{"model":"MiniMax-M3.1-Flash-Preview","messages":` + messagesJSON + `}`
	out, err := minimaxBuildRequest(false, []byte(body), "MiniMax-M3.1-Flash-Preview")
	if err != nil {
		t.Fatalf("minimaxBuildRequest: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	msgs, _ := parsed["messages"].([]any)
	return msgs
}

// minimaxMessageRoles 返回每条消息的 role。
func minimaxMessageRoles(msgs []any) []string {
	roles := make([]string, 0, len(msgs))
	for _, raw := range msgs {
		msg, _ := raw.(map[string]any)
		role, _ := msg["role"].(string)
		roles = append(roles, role)
	}
	return roles
}

// minimaxToolIDs 按出现顺序收集某类工具块的 id（idKey 为 id / tool_use_id）。
func minimaxToolIDs(msgs []any, blockType, idKey string) []string {
	var ids []string
	for _, raw := range msgs {
		msg, _ := raw.(map[string]any)
		blocks, _ := msg["content"].([]any)
		for _, rawBlock := range blocks {
			block, _ := rawBlock.(map[string]any)
			if block["type"] != blockType {
				continue
			}
			id, _ := block[idKey].(string)
			ids = append(ids, id)
		}
	}
	return ids
}

// minimaxAssertToolPairing 断言协议配对不变量（ref 的「成对提交」口径）：
// 角色严格交替；每个 tool_use 之后紧跟的那条 user 消息里必须有它的 tool_result；
// 不存在指向别的 assistant 的 tool_result。
func minimaxAssertToolPairing(t *testing.T, msgs []any) {
	t.Helper()
	pending := map[string]bool{}
	prevRole := ""
	for i, raw := range msgs {
		msg, _ := raw.(map[string]any)
		role, _ := msg["role"].(string)
		if role == prevRole {
			t.Fatalf("messages[%d] 与前一条同角色 %q（连续同角色会被上游拒）", i, role)
		}
		prevRole = role
		blocks, _ := msg["content"].([]any)
		seenResult := map[string]bool{}
		for _, rawBlock := range blocks {
			block, _ := rawBlock.(map[string]any)
			switch block["type"] {
			case "tool_use":
				if role != "assistant" {
					t.Fatalf("messages[%d]: tool_use 只能出现在 assistant 里", i)
				}
				id, _ := block["id"].(string)
				pending[id] = true
			case "tool_result":
				if role != "user" {
					t.Fatalf("messages[%d]: tool_result 只能出现在 user 里", i)
				}
				id, _ := block["tool_use_id"].(string)
				if !pending[id] {
					t.Fatalf("messages[%d]: tool_result %q 是孤儿（紧邻的上一条 assistant 没有该 tool_use）", i, id)
				}
				seenResult[id] = true
			}
		}
		if role == "user" {
			for id := range pending {
				if !seenResult[id] {
					t.Fatalf("messages[%d]: tool_use %q 的结果没有出现在紧跟其后的 user 消息里", i, id)
				}
			}
			pending = map[string]bool{}
		}
	}
	if len(pending) > 0 {
		t.Fatalf("请求末尾仍有未配对的 tool_use：%v", pending)
	}
}

func TestMinimaxConvertMessagesDropsOrphanToolResult(t *testing.T) {
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"你好"},
		{"role":"tool","tool_call_id":"call_ghost","content":"没有对应 tool_use 的结果"},
		{"role":"assistant","content":"收到"}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant]" {
		t.Fatalf("孤儿 tool_result 必须整条丢弃，得到 %v", got)
	}
	if ids := minimaxToolIDs(msgs, "tool_result", "tool_use_id"); len(ids) != 0 {
		t.Fatalf("孤儿 tool_result 不得下发：%v", ids)
	}
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); len(ids) != 0 {
		t.Fatalf("无调用方，不得凭空补 tool_use：%v", ids)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesDropsOrphanToolUseKeepsAssistantText(t *testing.T) {
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"查天气"},
		{"role":"assistant","content":"我查一下","tool_calls":[{"id":"call_x","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},
		{"role":"assistant","content":"结果没拿到"}
	]`)
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); len(ids) != 0 {
		t.Fatalf("孤儿 tool_use（没有 tool_result）必须剔除：%v", ids)
	}
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant]" {
		t.Fatalf("assistant 正文必须保留：%v", got)
	}
	assistant, _ := msgs[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	var texts []string
	for _, rawBlock := range blocks {
		block, _ := rawBlock.(map[string]any)
		if block["type"] == "text" {
			texts = append(texts, fmt.Sprint(block["text"]))
		}
	}
	if fmt.Sprint(texts) != "[我查一下 结果没拿到]" {
		t.Fatalf("assistant 正文被工具块过滤误伤：%v", texts)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesMatchedPairMergesIntoOneFollowingUserMessage(t *testing.T) {
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"查天气"},
		{"role":"assistant","content":"我查一下","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"晴 25 度"}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant user]" {
		t.Fatalf("配对必须保留且结果紧跟 assistant：%v", got)
	}
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); fmt.Sprint(ids) != "[call_1]" {
		t.Fatalf("tool_use 丢失：%v", ids)
	}
	last, _ := msgs[2].(map[string]any)
	blocks, _ := last["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("结果必须合并进唯一一条 user 消息：%v", blocks)
	}
	result, _ := blocks[0].(map[string]any)
	if result["type"] != "tool_result" || result["tool_use_id"] != "call_1" {
		t.Fatalf("tool_result 块形态错误：%v", result)
	}
	inner, _ := result["content"].([]any)
	text, _ := inner[0].(map[string]any)
	if text["text"] != "晴 25 度" {
		t.Fatalf("工具结果正文丢失：%v", result)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesResultAndTextMergeIntoOneUserMessage(t *testing.T) {
	// 过滤之后同角色合并必须仍然成立：结果与它后面那条 user 正文只能落在**一条**
	// user 消息里（否则第二条 user 前面是 user → 上游 2013），且 tool_result 在首位。
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"查天气"},
		{"role":"assistant","content":"我查一下","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},
		{"role":"user","content":"顺便说一句"},
		{"role":"tool","tool_call_id":"call_1","content":"晴 25 度"}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant user]" {
		t.Fatalf("结果与正文必须合并成一条 user：%v", got)
	}
	last, _ := msgs[2].(map[string]any)
	blocks, _ := last["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("合并后的 user 应有 tool_result + text 两块：%v", blocks)
	}
	result, _ := blocks[0].(map[string]any)
	if result["type"] != "tool_result" || result["tool_use_id"] != "call_1" {
		t.Fatalf("tool_result 必须在首位：%v", blocks)
	}
	text, _ := blocks[1].(map[string]any)
	if text["type"] != "text" || text["text"] != "顺便说一句" {
		t.Fatalf("user 正文丢失：%v", blocks)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesMultipleResultsMergeIntoOneUserMessage(t *testing.T) {
	// 一次 assistant 带两个 tool_use、工具结果落成两条独立消息：必须合并成
	// **一条** user（逐条下发会产出连续 user 消息 → 上游 2013）。
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"并行查"},
		{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}},
			{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}
		]},
		{"role":"tool","tool_call_id":"call_1","content":"晴"},
		{"role":"tool","tool_call_id":"call_2","content":"10:00"}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant user]" {
		t.Fatalf("多条结果必须合并成一条 user：%v", got)
	}
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); fmt.Sprint(ids) != "[call_1 call_2]" {
		t.Fatalf("tool_use 丢失：%v", ids)
	}
	if ids := minimaxToolIDs(msgs, "tool_result", "tool_use_id"); fmt.Sprint(ids) != "[call_1 call_2]" {
		t.Fatalf("tool_result 丢失或未合并：%v", ids)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesDuplicateResultsForOneCallStayMerged(t *testing.T) {
	// 同一个 tool_call_id 出现两条结果（客户端重放/重试的畸形历史）：两条都保留，
	// 且必须落在同一条 user 消息里 —— 不能拆成连续 user，也不能当孤儿丢掉。
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"跑一下"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"run","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"call_1","content":"第一次"},
		{"role":"tool","tool_call_id":"call_1","content":"第二次"}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user assistant user]" {
		t.Fatalf("重复结果必须合并成一条 user：%v", got)
	}
	if ids := minimaxToolIDs(msgs, "tool_result", "tool_use_id"); fmt.Sprint(ids) != "[call_1 call_1]" {
		t.Fatalf("重复结果不得被当作孤儿丢弃：%v", ids)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesDropsAssistantWhoseOnlyToolCallIsOrphan(t *testing.T) {
	// 正文为空（content:null）且唯一的 tool_call 无结果 → 整条 assistant 丢弃，
	// 不能留下一个空 content 的消息（上游拒空块），也不能留下孤儿 tool_use。
	msgs := minimaxConvertedMessages(t, `[
		{"role":"user","content":"在吗"},
		{"role":"assistant","content":null,"tool_calls":[{"id":"call_ghost","type":"function","function":{"name":"f","arguments":"{}"}}]}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[user]" {
		t.Fatalf("空 assistant（唯一 tool_call 是孤儿）必须整条丢弃：%v", got)
	}
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); len(ids) != 0 {
		t.Fatalf("孤儿 tool_use 必须剔除：%v", ids)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesResultForLaterAssistantNotPairedToEarlierOne(t *testing.T) {
	// 结果出现在调用**之前**（畸形历史）：它只能配给真正含该 tool_use 的那条
	// assistant —— 绝不能因为「紧跟在前面」就挂到更早的 assistant 上。
	msgs := minimaxConvertedMessages(t, `[
		{"role":"assistant","content":"先说话","tool_calls":[{"id":"call_a","type":"function","function":{"name":"f","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"call_b","content":"B 的结果"},
		{"role":"user","content":"继续"},
		{"role":"assistant","content":"再调用","tool_calls":[{"id":"call_b","type":"function","function":{"name":"g","arguments":"{}"}}]}
	]`)
	if got := minimaxMessageRoles(msgs); fmt.Sprint(got) != "[assistant user assistant user]" {
		t.Fatalf("消息骨架错误：%v", got)
	}
	// call_a 没有结果 → 剔除；call_b 配对成功。
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); fmt.Sprint(ids) != "[call_b]" {
		t.Fatalf("只应保留配好对的 call_b：%v", ids)
	}
	if ids := minimaxToolIDs(msgs, "tool_result", "tool_use_id"); fmt.Sprint(ids) != "[call_b]" {
		t.Fatalf("call_b 的结果必须保留：%v", ids)
	}
	// 关键断言：结果不在紧跟「先说话」的那条 user 里，而在最后一条（紧跟含
	// call_b 的 assistant）。
	middle, _ := msgs[1].(map[string]any)
	middleBlocks, _ := middle["content"].([]any)
	if len(middleBlocks) != 1 {
		t.Fatalf("紧跟「先说话」的 user 只能是正文：%v", middleBlocks)
	}
	first, _ := middleBlocks[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "继续" {
		t.Fatalf("结果被错误地挂到了更早的 assistant 上：%v", middleBlocks)
	}
	owner, _ := msgs[2].(map[string]any)
	ownerBlocks, _ := owner["content"].([]any)
	last, _ := ownerBlocks[len(ownerBlocks)-1].(map[string]any)
	if last["type"] != "tool_use" || last["id"] != "call_b" {
		t.Fatalf("含 call_b 的 assistant 形态错误：%v", ownerBlocks)
	}
	minimaxAssertToolPairing(t, msgs)
}

func TestMinimaxConvertMessagesToolPairingInvariantHolds(t *testing.T) {
	// 通用不变量断言（与上游回归用例同款）：无论历史多脏，输出都必须满足
	// 「tool_result 紧跟产生它的 assistant」且没有孤儿块。
	cases := map[string]string{
		"结果夹在配对之间": `[
			{"role":"user","content":"go"},
			{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},
			{"role":"tool","tool_call_id":"c1","content":"r1"},
			{"role":"tool","tool_call_id":"ghost","content":"孤儿结果"},
			{"role":"assistant","content":"接着说"},
			{"role":"user","content":"再问"}
		]`,
		"结果晚于调用一轮": `[
			{"role":"user","content":"go"},
			{"role":"assistant","content":"调用","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},
			{"role":"assistant","content":"又调用","tool_calls":[{"id":"c2","type":"function","function":{"name":"g","arguments":"{}"}}]},
			{"role":"tool","tool_call_id":"c1","content":"r1"},
			{"role":"tool","tool_call_id":"c2","content":"r2"}
		]`,
		"纯工具消息开路": `[
			{"role":"tool","tool_call_id":"ghost","content":"孤儿"},
			{"role":"user","content":"hi"}
		]`,
		"无 id 的 tool_call 合成 call_0": `[
			{"role":"user","content":"go"},
			{"role":"assistant","content":null,"tool_calls":[{"type":"function","function":{"name":"f","arguments":"{}"}}]},
			{"role":"tool","tool_call_id":"call_0","content":"r0"}
		]`,
		"空名 tool_call 与结果": `[
			{"role":"user","content":"go"},
			{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"","arguments":"{}"}}]},
			{"role":"tool","tool_call_id":"c1","content":"r1"}
		]`,
	}
	for name, messagesJSON := range cases {
		t.Run(name, func(t *testing.T) {
			minimaxAssertToolPairing(t, minimaxConvertedMessages(t, messagesJSON))
		})
	}
	// 合成 id 的既有契约：无 id 的 tool_call 仍是 `call_0`，且与结果配对成功。
	msgs := minimaxConvertedMessages(t, cases["无 id 的 tool_call 合成 call_0"])
	if ids := minimaxToolIDs(msgs, "tool_use", "id"); fmt.Sprint(ids) != "[call_0]" {
		t.Fatalf("合成 id 契约变了：%v", ids)
	}
	if ids := minimaxToolIDs(msgs, "tool_result", "tool_use_id"); fmt.Sprint(ids) != "[call_0]" {
		t.Fatalf("合成 id 的结果必须保留：%v", ids)
	}
	// 空名 tool_call 依旧不产出 tool_use（既有无条件剔除规则），其结果随之成孤儿被丢。
	named := minimaxConvertedMessages(t, cases["空名 tool_call 与结果"])
	if ids := minimaxToolIDs(named, "tool_use", "id"); len(ids) != 0 {
		t.Fatalf("空名 tool_call 不得产出 tool_use：%v", ids)
	}
	if ids := minimaxToolIDs(named, "tool_result", "tool_use_id"); len(ids) != 0 {
		t.Fatalf("无 tool_use 可配对的结果必须丢弃：%v", ids)
	}
}

func TestMinimaxConvertMessagesToolMessageWithoutCallIDStillErrors(t *testing.T) {
	// 既有契约：role:"tool" 缺 tool_call_id 是进站报文错误，必须显式报错，
	// 不能被「孤儿过滤」吞掉。
	body := `{"model":"MiniMax-M3","messages":[{"role":"user","content":"hi"},{"role":"tool","content":"没有 id"}]}`
	if _, err := minimaxBuildRequest(false, []byte(body), "MiniMax-M3"); err == nil {
		t.Fatal("role:\"tool\" 缺 tool_call_id 必须报错（不能被孤儿过滤静默吞掉）")
	}
}

// --- 思考三态判据 ---

func TestMinimaxThinkingPlan(t *testing.T) {
	cases := []struct {
		name       string
		model      string
		effort     string
		wantThink  string
		wantEffort string
	}{
		{"M3.1 forced_on + valid effort", "MiniMax-M3.1-Flash-Preview", "high", "adaptive", "high"},
		{"M3.1 default effort", "MiniMax-M3.1-Flash-Preview", "default", "adaptive", "default"},
		// ⚠️ M3.1 传 disabled 会被服务端硬拒（400/2013）→ 门禁丢弃 → 仍 adaptive。
		{"M3.1 refuses disabled", "MiniMax-M3.1-Flash-Preview", "none", "adaptive", ""},
		{"M3.1 undeclared effort dropped", "MiniMax-M3.1-Flash-Preview", "banana", "adaptive", ""},
		{"M3.1 no effort → adaptive", "MiniMax-M3.1-Flash-Preview", "", "adaptive", ""},
		{"M3 switchable off", "MiniMax-M3", "none", "disabled", ""},
		{"M3 switchable on", "MiniMax-M3", "on", "adaptive", ""},
		{"M3 disabled alias", "MiniMax-M3", "disabled", "disabled", ""},
		// M3 没有档位 ⇒ 真实档位被门禁丢弃 ⇒ 不下发 thinking（实测默认不思考）。
		{"M3 has no grades", "MiniMax-M3", "high", "", ""},
		{"M2.7 forced_on declares nothing", "MiniMax-M2.7", "high", "", ""},
		{"M2.7-highspeed declares nothing", "MiniMax-M2.7-highspeed", "none", "", ""},
		{"unknown model declares nothing", "MiniMax-M9", "high", "", ""},
	}
	for _, tc := range cases {
		thinking, oc := minimaxThinkingPlan(tc.model, tc.effort)
		gotThink := ""
		if thinking != nil {
			gotThink, _ = thinking["type"].(string)
		}
		gotEffort := ""
		if oc != nil {
			gotEffort, _ = oc["effort"].(string)
		}
		if gotThink != tc.wantThink || gotEffort != tc.wantEffort {
			t.Errorf("%s: thinking=%q effort=%q, want thinking=%q effort=%q", tc.name, gotThink, gotEffort, tc.wantThink, tc.wantEffort)
		}
	}
}

func TestMinimaxDeclaredEfforts(t *testing.T) {
	if got := minimaxDeclaredEfforts("MiniMax-M2.7"); got != nil {
		t.Fatalf("forced_on models must declare nothing: %v", got)
	}
	if got := fmt.Sprint(minimaxDeclaredEfforts("MiniMax-M3")); got != "[on none]" {
		t.Fatalf("switchable model declares on/none, got %v", got)
	}
	if got := len(minimaxDeclaredEfforts("MiniMax-M3.1-Flash-Preview")); got != 6 {
		t.Fatalf("M3.1 declares 6 grades, got %d", got)
	}
}

// --- 响应侧：流式转换 ---

func TestMinimaxStreamReaderConvertsAnthropicSSE(t *testing.T) {
	rd := newMinimaxSSEReader(strings.NewReader(minimaxReasoningSSE), true, "MiniMax-M3.1-Flash-Preview")
	out, err := io.ReadAll(rd)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.HasSuffix(text, "data: [DONE]\n\n") {
		t.Fatalf("stream must terminate with [DONE]: %q", text[len(text)-80:])
	}
	if strings.Contains(text, "abc123") {
		t.Fatal("signature_delta must never reach the client (it would inject hex into the answer)")
	}
	if strings.Contains(text, `"type":"content_block`) || strings.Contains(text, "event:") {
		t.Fatal("Anthropic frames must not leak into the OpenAI stream")
	}
	chunks := minimaxParseChunks(t, text)
	if len(chunks) == 0 {
		t.Fatal("no chunks emitted")
	}
	// 首帧必须带 role（Cline 等客户端依赖它建消息）。
	firstDelta, _ := chunks[0]["choices"].([]any)
	{
		c0, _ := firstDelta[0].(map[string]any)
		d, _ := c0["delta"].(map[string]any)
		if d["role"] != "assistant" {
			t.Fatalf("first chunk must carry role=assistant: %v", chunks[0])
		}
	}
	var content, reasoning strings.Builder
	var toolID, toolName, toolArgs string
	finish := ""
	usage := map[string]any{}
	for _, chunk := range chunks {
		choices, _ := chunk["choices"].([]any)
		if u, ok := chunk["usage"].(map[string]any); ok {
			usage = u
		}
		for _, c := range choices {
			cm, _ := c.(map[string]any)
			d, _ := cm["delta"].(map[string]any)
			if s, ok := d["content"].(string); ok {
				content.WriteString(s)
			}
			if s, ok := d["reasoning_content"].(string); ok {
				reasoning.WriteString(s)
			}
			if calls, ok := d["tool_calls"].([]any); ok {
				for _, raw := range calls {
					call, _ := raw.(map[string]any)
					fn, _ := call["function"].(map[string]any)
					if s, ok := call["id"].(string); ok && s != "" {
						toolID = s
					}
					if s, ok := fn["name"].(string); ok && s != "" {
						toolName = s
					}
					if s, ok := fn["arguments"].(string); ok {
						toolArgs += s
					}
				}
			}
			if s, ok := cm["finish_reason"].(string); ok && s != "" {
				finish = s
			}
		}
	}
	if content.String() != "你好" {
		t.Fatalf("content wrong: %q", content.String())
	}
	if reasoning.String() != "先想一下" {
		t.Fatalf("reasoning wrong: %q", reasoning.String())
	}
	if toolID != "toolu_1" || toolName != "get_weather" || toolArgs != `{"city":"北京"}` {
		t.Fatalf("tool call wrong: id=%q name=%q args=%q", toolID, toolName, toolArgs)
	}
	if finish != "tool_calls" {
		t.Fatalf("stop_reason tool_use → finish_reason tool_calls, got %q", finish)
	}
	if usage["prompt_tokens"] != float64(15) { // 12 input + 3 cache_read
		t.Fatalf("prompt_tokens must fold cache counters: %v", usage)
	}
	if usage["completion_tokens"] != float64(42) || usage["total_tokens"] != float64(57) {
		t.Fatalf("completion/total wrong: %v", usage)
	}
	details, _ := usage["completion_tokens_details"].(map[string]any)
	if details["reasoning_tokens"] != float64(7) {
		t.Fatalf("reasoning_tokens must map from thinking_tokens: %v", usage)
	}
}

// 截断流：最后一个 message_delta（带 stop_reason/usage）没有换行结尾也必须被
// 冲刷出来——ref 修过的真实缺陷（症状：max_tokens 被误报成 stop、usage 恒 0）。
func TestMinimaxStreamReaderFlushesTruncatedTail(t *testing.T) {
	truncated := `data: {"type":"message_start","message":{"id":"m","model":"MiniMax-M3","usage":{"input_tokens":5}}}` + "\n\n" +
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n" +
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}` + "\n\n" +
		`data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}`
	rd := newMinimaxSSEReader(strings.NewReader(truncated), true, "MiniMax-M3")
	out, _ := io.ReadAll(rd)
	chunks := minimaxParseChunks(t, string(out))
	finish := ""
	usage := map[string]any{}
	for _, chunk := range chunks {
		choices, _ := chunk["choices"].([]any)
		for _, c := range choices {
			cm, _ := c.(map[string]any)
			if s, ok := cm["finish_reason"].(string); ok && s != "" {
				finish = s
			}
		}
		if u, ok := chunk["usage"].(map[string]any); ok {
			usage = u
		}
	}
	if finish != "length" {
		t.Fatalf("truncated tail must still deliver stop_reason → length, got %q", finish)
	}
	if usage["completion_tokens"] != float64(9) {
		t.Fatalf("truncated tail usage lost: %v", usage)
	}
}

// --- 响应侧：非流式聚合 ---

func TestMinimaxAggregateOpenAIJSON(t *testing.T) {
	body, err := minimaxAggregateSSE(strings.NewReader(minimaxReasoningSSE), true, "MiniMax-M3.1-Flash-Preview")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["object"] != "chat.completion" {
		t.Fatalf("object wrong: %v", parsed["object"])
	}
	choices, _ := parsed["choices"].([]any)
	c0, _ := choices[0].(map[string]any)
	if c0["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason wrong: %v", c0["finish_reason"])
	}
	msg, _ := c0["message"].(map[string]any)
	if msg["content"] != nil && msg["content"] != "" {
		// 有工具调用 + 有文本时 content 是文本；两条分支都允许，但字段必须在。
	}
	if msg["reasoning_content"] != "先想一下" {
		t.Fatalf("reasoning_content wrong: %v", msg["reasoning_content"])
	}
	calls, _ := msg["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls wrong: %v", msg["tool_calls"])
	}
	call0, _ := calls[0].(map[string]any)
	fn, _ := call0["function"].(map[string]any)
	if fn["arguments"] != `{"city":"北京"}` {
		t.Fatalf("aggregated arguments wrong: %v", fn)
	}
	if _, ok := parsed["usage"].(map[string]any); !ok {
		t.Fatal("usage missing")
	}
}

func TestMinimaxAggregateAnthropicJSONDropsThinking(t *testing.T) {
	body, err := minimaxAggregateSSE(strings.NewReader(minimaxReasoningSSE), false, "MiniMax-M3.1-Flash-Preview")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["type"] != "message" || parsed["stop_reason"] != "tool_use" {
		t.Fatalf("Anthropic message shape wrong: %s", body)
	}
	content, _ := parsed["content"].([]any)
	for _, raw := range content {
		block, _ := raw.(map[string]any)
		if block["type"] == "thinking" {
			t.Fatal("unsigned thinking blocks must not be returned (Anthropic requires a signature we deliberately drop)")
		}
	}
	if strings.Contains(string(body), "先想一下") {
		t.Fatal("thinking text must not leak into the Anthropic aggregate")
	}
}

func TestMinimaxAggregateEmptyStreamErrors(t *testing.T) {
	_, err := minimaxAggregateSSE(strings.NewReader("data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\"}}\n\n"), true, "MiniMax-M3")
	if err == nil {
		t.Fatal("a 200 stream with no content block must fail loudly (silent empty replies are worse)")
	}
	if !strings.Contains(err.Error(), "未返回任何内容块") {
		t.Fatalf("error should explain the empty stream: %v", err)
	}
}

// --- 响应侧：拦截器 ---

func TestMinimaxInterceptPassthroughAnthropicStream(t *testing.T) {
	m := newSeedMinimaxManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/messages", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(minimaxReasoningSSE)), Header: http.Header{}}
	out, ms, err := m.minimaxInterceptResponse(req, resp, "MiniMax-M3.1-Flash-Preview", true)
	if err != nil || out != nil || ms != 0 {
		t.Fatalf("Anthropic streaming must pass through untouched (out=%v ms=%d err=%v)", out, ms, err)
	}
}

func TestMinimaxInterceptErrorFrameFailsAttempt(t *testing.T) {
	m := newSeedMinimaxManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	stream := `event: error
data: {"type":"error","error":{"type":"invalid_request_error","message":"requires adaptive thinking (2013)"}}

`
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stream)), Header: http.Header{}}
	_, _, err := m.minimaxInterceptResponse(req, resp, "MiniMax-M3.1-Flash-Preview", true)
	if err == nil || !strings.Contains(err.Error(), "requires adaptive thinking") {
		t.Fatalf("first-frame error must fail the attempt with the upstream message, got %v", err)
	}
}

func TestMinimaxInterceptNonStreamAggregates(t *testing.T) {
	m := newSeedMinimaxManager(t)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(minimaxReasoningSSE)), Header: http.Header{}}
	out, _, err := m.minimaxInterceptResponse(req, resp, "MiniMax-M3.1-Flash-Preview", false)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(out)
	if !strings.Contains(string(body), `"object":"chat.completion"`) {
		t.Fatalf("non-stream client must receive an aggregated chat.completion: %s", body)
	}
	if resp.ContentLength >= 0 {
		t.Fatal("ContentLength must be reset when the body is rewritten")
	}
}

func TestMinimaxRewriteErrorBodyKeepsType(t *testing.T) {
	resp := &http.Response{
		StatusCode:    402,
		Header:        http.Header{"Content-Length": []string{"68"}},
		ContentLength: 68,
		Body:          io.NopCloser(strings.NewReader(`{"type":"error","error":{"type":"insufficient_balance_error","message":"余额不足"}}`)),
	}
	out, _, err := minimaxRewriteErrorBody(resp)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(out)
	// ⚠️ 必须保留原始 type 字符串：代理解析 402 余额耗尽靠 body 里的
	// insufficient_balance（rotation.IsBalanceExhausted），丢了就不会锁 key。
	if !strings.Contains(string(body), "insufficient_balance_error") {
		t.Fatalf("error type must survive the rewrite: %s", body)
	}
	if !strings.Contains(strings.ToLower(string(body)), "insufficient_balance") {
		t.Fatalf("balance detector would miss this body: %s", body)
	}
	if resp.Header.Get("Content-Length") != "" || resp.ContentLength != -1 {
		t.Fatal("rewritten body must not keep the stale Content-Length")
	}
}

// minimaxParseChunks decodes every "data:" frame of an OpenAI SSE body.
func minimaxParseChunks(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			t.Fatalf("invalid chunk %q: %v", payload, err)
		}
		out = append(out, parsed)
	}
	return out
}

var _ = bytes.MinRead
