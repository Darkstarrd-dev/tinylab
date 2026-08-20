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

// chatToResponsesBody converts an OpenAI chat body (messages[].content with
// image_url) to the Responses input shape (input[].content with input_image).
// Only the shape needed for vision is handled; unknown fields are dropped.
func chatToResponsesBody(chat map[string]any) map[string]any {
	out := map[string]any{}
	if v, ok := chat["model"]; ok {
		out["model"] = v
	}
	out["store"] = false
	if v, ok := chat["stream"]; ok {
		out["stream"] = v
	}
	msgs, _ := chat["messages"].([]any)
	var input []any
	for _, mm := range msgs {
		m, _ := mm.(map[string]any)
		role, _ := m["role"].(string)
		if role == "tool" {
			continue
		}
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
			if t, _ := p["type"].(string); t == "text" {
				txt, _ := p["text"].(string)
				ic = append(ic, map[string]any{"type": "input_text", "text": txt})
			} else if t == "image_url" {
				iu, _ := p["image_url"].(map[string]any)
				u, _ := iu["url"].(string)
				ic = append(ic, map[string]any{"type": "input_image", "image_url": u})
			}
		}
		if len(ic) > 0 {
			input = append(input, map[string]any{"role": role, "content": ic})
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
