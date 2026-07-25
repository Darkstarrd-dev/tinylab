package proxy

import "encoding/json"

// parseAnthropicSSEUsage extracts token usage from a single Anthropic-format
// SSE data payload. Anthropic streams usage in two events:
//
//   - event: message_start → data.message.usage.input_tokens
//   - event: message_delta → data.usage.output_tokens
//
// It returns the token counts and ok=true only when the payload carries a
// recognized usage field; other event types return ok=false. Parse failures
// are treated as ok=false (best-effort, never an error).
func parseAnthropicSSEUsage(payload []byte) (inputTokens, outputTokens int, ok bool) {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return 0, 0, false
	}
	eventType, _ := obj["type"].(string)
	switch eventType {
	case "message_start":
		msg, ok := obj["message"].(map[string]any)
		if !ok {
			return 0, 0, false
		}
		usage, ok := msg["usage"].(map[string]any)
		if !ok {
			return 0, 0, false
		}
		if in, ok := usage["input_tokens"].(float64); ok {
			return int(in), 0, true
		}
	case "message_delta":
		usage, ok := obj["usage"].(map[string]any)
		if !ok {
			return 0, 0, false
		}
		if out, ok := usage["output_tokens"].(float64); ok {
			return 0, int(out), true
		}
	}
	return 0, 0, false
}
