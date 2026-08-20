package proxy

import (
	"encoding/json"
	"strings"
)

// hasImageContent returns true if any message contains an image_url part.
func hasImageContent(parsed map[string]any) bool {
	msgs, _ := parsed["messages"].([]any)
	for _, mm := range msgs {
		m, _ := mm.(map[string]any)
		content := m["content"]
		parts, ok := content.([]any)
		if !ok {
			continue
		}
		for _, p := range parts {
			pp, _ := p.(map[string]any)
			if pp["type"] == "image_url" {
				return true
			}
		}
	}
	return false
}

// isMuseVision returns true for the Muse family on OpenCode Go/Zen (legacy
// narrow switch before the generic ChatResponsesCompat toggle).
func isMuseVision(model string) bool {
	l := strings.ToLower(model)
	return strings.Contains(l, "muse")
}

// When ChatResponsesCompat is enabled, chat→responses is generic (every chat
// request on that provider is rewritten). Otherwise only the narrow
// vision+muse legacy path is rewritten.

// contentToText flattens a chat message content value (plain string or
// []map{type,text} parts, e.g. tool output) into a single string.
func contentToText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var sb strings.Builder
		for _, p := range v {
			pm, ok := p.(map[string]any)
			if !ok {
				continue
			}
			t, _ := pm["text"].(string)
			if t == "" {
				continue
			}
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(t)
		}
		return sb.String()
	}
	return ""
}

// chatToResponsesBody converts an OpenAI chat /v1/chat/completions body to the
// Responses /v1/responses input shape. It handles the full round-trip needs of
// an agent loop, not just vision:
//
//   - tools and tool_choice are converted (chat {type,function{...}} →
//     responses {type,name,description,parameters,strict});
//   - assistant messages with tool_calls become function_call input items
//     (kept in order, so the upstream sees the tool calls the client made);
//   - role=tool messages become function_call_output items keyed to those
//     call_ids — without this an agent's second turn carries a conversation
//     where the model's own tool result is missing (400 / broken context);
//   - assistant text is rendered as output_text, user/system/developer text as
//     input_text, so strict Responses endpoints accept multi-turn history;
//   - image_url parts become input_image (legacy vision path);
//   - max_tokens is mapped to max_output_tokens; temperature/top_p pass through.
func chatToResponsesBody(chat map[string]any) map[string]any {
	out := map[string]any{}
	if v, ok := chat["model"]; ok {
		out["model"] = v
	}
	out["store"] = false
	if v, ok := chat["stream"]; ok {
		out["stream"] = v
	}
	if v, ok := chat["temperature"]; ok {
		out["temperature"] = v
	}
	if v, ok := chat["top_p"]; ok {
		out["top_p"] = v
	}
	// Chat uses max_tokens; Responses uses max_output_tokens.
	if v, ok := chat["max_tokens"]; ok {
		// JSON decode yields float64; in-process map builders may pass int.
		switch f := v.(type) {
		case float64:
			if f > 0 {
				out["max_output_tokens"] = int(f)
			}
		case int:
			if f > 0 {
				out["max_output_tokens"] = f
			}
		}
	}
	// tools: chat is externally tagged [{type:"function",function:{name,...}}],
	// responses is internally tagged [{type:"function",name,...}].
	if tools, ok := chat["tools"].([]any); ok && len(tools) > 0 {
		var rt []any
		for _, t := range tools {
			tm, _ := t.(map[string]any)
			fn, _ := tm["function"].(map[string]any)
			item := map[string]any{"type": "function"}
			if v, ok := fn["name"].(string); ok && v != "" {
				item["name"] = v
			}
			if v, ok := fn["description"].(string); ok && v != "" {
				item["description"] = v
			}
			if v, ok := fn["parameters"]; ok {
				item["parameters"] = v
			}
			if v, ok := fn["strict"]; ok {
				item["strict"] = v
			}
			rt = append(rt, item)
		}
		if len(rt) > 0 {
			out["tools"] = rt
		}
	}
	// tool_choice: string passes through; {type:function,function:{name}} →
	// {type:function,name}.
	if v, ok := chat["tool_choice"]; ok {
		switch tc := v.(type) {
		case string:
			out["tool_choice"] = tc
		case map[string]any:
			if fn, ok := tc["function"].(map[string]any); ok {
				out["tool_choice"] = map[string]any{"type": "function", "name": fn["name"]}
			}
		}
	}

	msgs, _ := chat["messages"].([]any)
	var input []any
	for _, mm := range msgs {
		m, _ := mm.(map[string]any)
		role, _ := m["role"].(string)
		switch role {
		case "tool":
			// Tool result → function_call_output item (replaces the chat
			// "tool" role, which the Responses API does not understand).
			callID, _ := m["tool_call_id"].(string)
			if callID == "" {
				callID = generateToolCallID()
			}
			input = append(input, map[string]any{
				"type":    "function_call_output",
				"call_id": callID,
				"output":  contentToText(m["content"]),
			})
		case "assistant":
			if s := contentToText(m["content"]); s != "" {
				input = append(input, map[string]any{
					"role":    "assistant",
					"content": []any{map[string]any{"type": "output_text", "text": s}},
				})
			}
			if tcs, ok := m["tool_calls"].([]any); ok {
				for _, tc := range tcs {
					tcm, _ := tc.(map[string]any)
					fn, _ := tcm["function"].(map[string]any)
					callID, _ := tcm["id"].(string)
					if callID == "" {
						callID = generateToolCallID()
					}
					name, _ := fn["name"].(string)
					args, _ := fn["arguments"].(string)
					input = append(input, map[string]any{
						"type":      "function_call",
						"call_id":   callID,
						"name":      name,
						"arguments": args,
					})
				}
			}
		default:
			// user / system / developer etc. — text or image parts.
			content := m["content"]
			if s, ok := content.(string); ok && s != "" {
				input = append(input, map[string]any{
					"role":    role,
					"content": []any{map[string]any{"type": "input_text", "text": s}},
				})
				continue
			}
			parts, ok := content.([]any)
			if !ok {
				continue
			}
			var ic []any
			for _, pp := range parts {
				p, _ := pp.(map[string]any)
				switch t, _ := p["type"].(string); t {
				case "text":
					txt, _ := p["text"].(string)
					ic = append(ic, map[string]any{"type": "input_text", "text": txt})
				case "image_url":
					iu, _ := p["image_url"].(map[string]any)
					u, _ := iu["url"].(string)
					ic = append(ic, map[string]any{"type": "input_image", "image_url": u})
				}
			}
			if len(ic) > 0 {
				input = append(input, map[string]any{"role": role, "content": ic})
			}
		}
	}
	out["input"] = input
	return out
}

// maybeRewriteChatVisionToResponses routes through /v1/responses according to
// the provider toggle. When ChatResponsesCompat is on, every chat request on
// that provider is rewritten; otherwise only the legacy vision+muse case is
// rewritten (preserves old behavior for that single hotfix).
func maybeRewriteChatVisionToResponses(body []byte, entryPath string, parsed map[string]any, model string, compat bool) ([]byte, string, bool) {
	if entryPath != "/v1/chat/completions" {
		return body, entryPath, false
	}
	if compat {
		if parsed == nil {
			if err := json.Unmarshal(body, &parsed); err != nil {
				return body, entryPath, false
			}
		}
		rb := chatToResponsesBody(parsed)
		nb, err := json.Marshal(rb)
		if err != nil {
			return body, entryPath, false
		}
		return nb, "/v1/responses", true
	}
	if !isMuseVision(model) {
		return body, entryPath, false
	}
	if parsed == nil {
		if err := json.Unmarshal(body, &parsed); err != nil {
			return body, entryPath, false
		}
	}
	if !hasImageContent(parsed) {
		return body, entryPath, false
	}
	rb := chatToResponsesBody(parsed)
	nb, err := json.Marshal(rb)
	if err != nil {
		return body, entryPath, false
	}
	return nb, "/v1/responses", true
}
