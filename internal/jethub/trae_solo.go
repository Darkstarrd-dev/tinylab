package jethub

import (
	"encoding/json"
	"fmt"
	"strings"
)

// cloneJSONMap deep-copies a JSON value tree (shared with jethub only).
func cloneJSONValue(v any) any {
	switch val := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			out[k] = cloneJSONValue(item)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = cloneJSONValue(item)
		}
		return out
	default:
		return v
	}
}

// OpenAI → SOLO body conversion (ref trae.ts transformToSOLOBody, aligned
// with Go bridge payload.go:PrepareBody):
//  1. messages.content string → [{type:"text",text:...}] (arrays pass
//     through — tool history keeps tool_calls);
//  2. stream forced true (non-streaming is aggregated server-side);
//  3. model → config_name + model (dual field), __dev suffix stripped;
//  4. function = the model's channel (a model is CALLABLE ONLY in a channel
//     that lists it — same account, different channel sets);
//  5. tool_choice normalized (none deletes tools; auto/required kept;
//     {type:function} extracts name);
//  6. assistant tool_calls function → function_call (SOLO field name), and
//     ⚠️ assistant messages with content=null but tool_calls must NOT be
//     dropped (the trae silent-failure trap);
//  7. tools[].function.parameters object → JSON string (SOLO requirement).
func transformToSOLOBody(openaiBody map[string]any, channel string) (map[string]any, error) {
	if openaiBody == nil {
		return nil, fmt.Errorf("jethub: trae 空 body")
	}
	body := cloneJSONValue(openaiBody).(map[string]any)
	body["stream"] = true
	body["function"] = firstNonEmpty(channel, traeProduct.Function)

	// messages 转换。
	if msgs, ok := body["messages"].([]any); ok {
		out := make([]any, 0, len(msgs))
		for _, msg := range msgs {
			m, ok := msg.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, transformSOLOMessage(m))
		}
		body["messages"] = out
	}

	// model → config_name + model（__dev 后缀剥除）。
	model, _ := body["model"].(string)
	base := model
	if idx := strings.Index(model, "__"); idx >= 0 {
		base = model[:idx]
	}
	configName := firstNonEmpty(base, traeDefaultModel)
	body["config_name"] = configName
	body["model"] = configName

	normalizeTraeToolChoice(body)
	normalizeTraeTools(body)
	return body, nil
}

var traeDefaultModel = "glm-5.2"

// transformSOLOMessage converts one message.
func transformSOLOMessage(msg map[string]any) map[string]any {
	result := cloneJSONValue(msg).(map[string]any)
	if role, _ := result["role"].(string); role == "assistant" {
		if tcs, ok := result["tool_calls"].([]any); ok {
			kept := make([]any, 0, len(tcs))
			for _, tc := range tcs {
				t, ok := tc.(map[string]any)
				if !ok {
					continue
				}
				// function → function_call (SOLO field name).
				if fn, ok := t["function"].(map[string]any); ok {
					t["function_call"] = fn
					delete(t, "function")
				}
				fc, _ := t["function_call"].(map[string]any)
				if fc == nil {
					continue
				}
				name, _ := fc["name"].(string)
				if trimSpaces(name) == "" {
					continue // nameless tool_calls are dropped
				}
				kept = append(kept, t)
			}
			if len(kept) > 0 {
				result["tool_calls"] = kept
			} else {
				delete(result, "tool_calls")
			}
		}
	}
	// content: string → [{type:"text",text}]; arrays pass through (multimodal);
	// null content (tool_calls-only assistant) is skipped — KEPT, not dropped:
	// dropping it makes the model blind to its own calls (trae trap).
	if content, has := result["content"]; has {
		if s, isStr := content.(string); isStr {
			result["content"] = []any{map[string]any{"type": "text", "text": s}}
		}
	}
	return result
}

// normalizeTraeToolChoice converts the OpenAI tool_choice shapes to SOLO.
func normalizeTraeToolChoice(body map[string]any) {
	tc, present := body["tool_choice"]
	if !present {
		return
	}
	suppress := func() {
		delete(body, "tools")
		delete(body, "functions")
	}
	switch v := tc.(type) {
	case string:
		if trimSpaces(strings.ToLower(v)) == "none" {
			delete(body, "tool_choice")
			suppress()
		}
	case map[string]any:
		typ := trimSpaces(strings.ToLower(jsonStringField(v, "type")))
		switch typ {
		case "none":
			delete(body, "tool_choice")
			suppress()
		case "auto", "required":
			body["tool_choice"] = typ
		case "function":
			fn, _ := v["function"].(map[string]any)
			name := ""
			if fn != nil {
				name = jsonStringField(fn, "name")
			}
			if name == "" {
				name = jsonStringField(v, "name")
			}
			if trimSpaces(name) != "" {
				body["tool_choice"] = trimSpaces(name)
			} else {
				body["tool_choice"] = "auto"
			}
		default:
			delete(body, "tool_choice")
		}
	default:
		delete(body, "tool_choice")
	}
}

// normalizeTraeTools serializes parameters objects to JSON strings.
func normalizeTraeTools(body map[string]any) {
	raw, ok := body["tools"].([]any)
	if !ok || len(raw) == 0 {
		return
	}
	out := make([]any, 0, len(raw))
	for _, item := range raw {
		t, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := t["function"].(map[string]any)
		if !ok {
			continue
		}
		if params, ok := fn["parameters"].(map[string]any); ok {
			data, err := json.Marshal(params)
			if err == nil {
				fn["parameters"] = string(data)
			}
		}
		out = append(out, t)
	}
	if len(out) > 0 {
		body["tools"] = out
	} else {
		delete(body, "tools")
	}
}

// --- SOLO → OpenAI SSE 转换（ref parseTraeSSELine / aggregateTraeSSE） ---

// traeSSEEvent is one parsed SOLO event.
type traeSSEEvent struct {
	Event            string
	Response         string
	ReasoningContent string
	ToolCalls        []any
	Usage            map[string]any
	FinishReason     string
	ErrorCode        float64
	ErrorMessage     string
}

// parseTraeSSELine parses one SOLO event (event: X / data: {json}).
func parseTraeSSELine(eventName, dataLine string) *traeSSEEvent {
	event := trimSpaces(eventName)
	ev := &traeSSEEvent{Event: event}
	if dataLine == "" {
		return ev
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(dataLine), &raw); err != nil {
		return ev
	}
	switch event {
	case "output":
		ev.Response = jsonStringField(raw, "response")
		ev.ReasoningContent = jsonStringField(raw, "reasoning_content")
		if calls, ok := raw["tool_calls"].([]any); ok && len(calls) > 0 {
			ev.ToolCalls = normalizeTraeToolCallsWire(calls)
		}
	case "token_usage":
		ev.Usage = raw
	case "done":
		ev.FinishReason = jsonStringField(raw, "finish_reason")
	case "error":
		ev.ErrorCode = jsonNumberField(raw, "code")
		ev.ErrorMessage = jsonStringField(raw, "message")
	}
	return ev
}

// normalizeTraeToolCallsWire maps function_call → function and strips SOLO
// exclusive fields (namespace/partial_arguments) — the reverse of the request
// transform (Go solosse.go:277-279).
func normalizeTraeToolCallsWire(calls []any) []any {
	out := make([]any, 0, len(calls))
	for _, call := range calls {
		c, ok := call.(map[string]any)
		if !ok {
			out = append(out, call)
			continue
		}
		c = cloneJSONValue(c).(map[string]any)
		if fc, ok := c["function_call"].(map[string]any); ok {
			c["function"] = fc
			delete(c, "function_call")
		}
		if fn, ok := c["function"].(map[string]any); ok {
			delete(fn, "namespace")
			delete(fn, "partial_arguments")
		}
		out = append(out, c)
	}
	return out
}

// traeAggregated aggregates a full SOLO SSE stream (non-streaming mode).
type traeAggregated struct {
	Content          string
	ReasoningContent string
	ToolCalls        []any
	FinishReason     string
	Usage            map[string]any
	ErrCode          float64
	ErrMsg           string
	HasError         bool
}

// aggregateTraeSSE parses an SSE line series into one OpenAI-shaped result.
func aggregateTraeSSE(lines []string) *traeAggregated {
	result := &traeAggregated{FinishReason: "stop"}
	var curEvent, curData string
	flush := func() {
		if curEvent == "" && curData == "" {
			return
		}
		ev := parseTraeSSELine(curEvent, curData)
		curEvent, curData = "", ""
		if ev == nil {
			return
		}
		switch ev.Event {
		case "output":
			result.Content += ev.Response
			result.ReasoningContent += ev.ReasoningContent
			result.ToolCalls = append(result.ToolCalls, ev.ToolCalls...)
		case "token_usage":
			result.Usage = ev.Usage
		case "done":
			if ev.FinishReason != "" {
				result.FinishReason = ev.FinishReason
			}
		case "error":
			result.ErrCode = ev.ErrorCode
			result.ErrMsg = ev.ErrorMessage
			result.HasError = true
		}
	}
	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r\n")
		switch {
		case line == "":
			flush()
			curEvent, curData = "", ""
		case strings.HasPrefix(line, "event:"):
			curEvent = trimSpaces(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			curData += line[len("data:"):]
		}
	}
	return result
}
