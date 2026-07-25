package proxy

import (
	"bytes"
	"encoding/json"
)

// sseContentLength extracts the unescaped character length of the "content"
// field from an SSE data payload. It uses a lightweight byte search instead
// of full JSON parsing to minimize overhead. Returns 0 if no content field
// is found or the content is empty.
func sseContentLength(payload []byte) int {
	marker := []byte(`"content":"`)
	idx := bytes.Index(payload, marker)
	if idx < 0 {
		return 0
	}
	i := idx + len(marker)
	length := 0
	for i < len(payload) {
		if payload[i] == '\\' {
			i += 2
			length++
			continue
		}
		if payload[i] == '"' {
			break
		}
		length++
		i++
	}
	return length
}

// chunkDelta is the per-chunk parse result for a single SSE data payload.
type chunkDelta struct {
	section string // "reasoning" | "assistant" | "usage"
	delta   string
}

// parseSSEChunkDelta extracts incremental delta fields from an OpenAI-format
// SSE data payload. It returns at most three deltas (one per section) but may
// return zero if the payload contains no relevant fields.
func parseSSEChunkDelta(payload []byte) []chunkDelta {
	var result []chunkDelta

	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return result
	}

	// Extract reasoning_content from choices[].delta
	if choices, ok := obj["choices"].([]any); ok && len(choices) > 0 {
		for _, c := range choices {
			choice, ok := c.(map[string]any)
			if !ok {
				continue
			}
			delta, ok := choice["delta"].(map[string]any)
			if !ok {
				continue
			}
			if v, ok := delta["reasoning_content"].(string); ok && v != "" {
				result = append(result, chunkDelta{section: "reasoning", delta: v})
			}
			if v, ok := delta["content"].(string); ok && v != "" {
				result = append(result, chunkDelta{section: "assistant", delta: v})
			}
		}
	}

	// Extract usage
	if usage, ok := obj["usage"].(map[string]any); ok {
		if in, ok := usage["input_tokens"].(float64); ok && in > 0 {
			result = append(result, chunkDelta{section: "usage", delta: formatTokenDelta("input_tokens", int(in))})
		}
		if out, ok := usage["output_tokens"].(float64); ok && out > 0 {
			result = append(result, chunkDelta{section: "usage", delta: formatTokenDelta("output_tokens", int(out))})
		}
	}

	return result
}

// formatTokenDelta builds a short delta string for usage chunks so the
// frontend can display a readable summary.
func formatTokenDelta(field string, value int) string {
	return field + "=" + itoa(value)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
