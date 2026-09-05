package proxy

import (
	"bytes"
	"encoding/json"
	"time"
)

// sseContentLength extracts the unescaped character length of incremental
// text fields from an SSE data payload. It matches OpenAI-style
// "content":"..." (choices[].delta.content, incl. translated responses
// chunks), Anthropic-style "text":"..." (content_block_delta delta.text),
// Responses-style top-level "delta":"..." (response.output_text.delta), and
// tool-call argument deltas "arguments":"..." (choices[].delta.tool_calls[].
// function.arguments — pure-toolcall streams carry all post-reasoning output
// here with content:null, so arguments count as CT, not RES). A single
// payload carries at most one of the markers, so the max of all scans is
// returned. Byte search instead of full JSON parsing keeps per-chunk
// overhead minimal. Returns 0 if no field is found.
// NOTE: reasoning/thinking incremental fields are NOT counted here — use
// sseReasoningLength for the RES split so the Recent RES/CT columns stay
// provider-segregated.
func sseContentLength(payload []byte) int {
	maxLen := 0
	for _, marker := range []string{`"content":"`, `"text":"`, `"delta":"`, `"arguments":"`} {
		idx := bytes.Index(payload, []byte(marker))
		if idx < 0 {
			continue
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
		if length > maxLen {
			maxLen = length
		}
	}
	return maxLen
}

// sseReasoningLength extracts the unescaped character length of incremental
// reasoning/thinking fields from an SSE data payload. It matches
// "reasoning_content":"..." (OpenAI-compatible reasoning models incl.
// llama.cpp), "reasoning":"..." (generic providers), and
// "reasoning_text":"..." (Responses reasoning summaries). Kept separate from
// sseContentLength so RES/CT stay segregated end to end. Returns 0 when no
// reasoning field is present.
func sseReasoningLength(payload []byte) int {
	maxLen := 0
	for _, marker := range []string{`"reasoning_content":"`, `"reasoning":"`, `"reasoning_text":"`} {
		idx := bytes.Index(payload, []byte(marker))
		if idx < 0 {
			continue
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
		if length > maxLen {
			maxLen = length
		}
	}
	return maxLen
}

// Mixed-stream dedup: some gateways (opencode.ai) emit each Responses
// increment twice — once as the native event
// (data: {"type":"response.output_text.delta",...,"delta":"..."}), once as an
// already-translated chat chunk (data: {"choices":[{"delta":{"content":"..."}}]}).
// Counting both doubles the live CT/RES estimates (and the SPD derived from
// them). The translated shape wins (it is what the client consumes); native
// Responses event rows are counted only when no translated row has been seen
// in the last mixedSuppressWindow — pure-passthrough upstreams (no
// translation) keep working with zero behavior change.
const mixedSuppressWindow = 2 * time.Second

// isTranslatedChatPayload reports whether payload is an already-translated
// OpenAI chat chunk (the preferred counting source in a mixed stream).
func isTranslatedChatPayload(payload []byte) bool {
	return bytes.Contains(payload, []byte(`"choices"`))
}

// isNativeResponsesPayload reports whether payload is a native Responses
// protocol event row (the suppressed source in a mixed stream).
func isNativeResponsesPayload(payload []byte) bool {
	return bytes.Contains(payload, []byte(`"type":"response.`))
}

// countContentSplit applies the translated-first rule and returns the
// (ct, res) char counts for one payload. lastChatUnixMilli points at the
// stream's last-seen translated-row stamp (UnixMilli, 0 = none yet); it is
// updated when this payload is itself a translated row.
func countContentSplit(payload []byte, nowUnixMilli int64, lastChatUnixMilli *int64) (ct, res int) {
	if isTranslatedChatPayload(payload) {
		*lastChatUnixMilli = nowUnixMilli
		return sseContentLength(payload), sseReasoningLength(payload)
	}
	if isNativeResponsesPayload(payload) && *lastChatUnixMilli != 0 &&
		nowUnixMilli-*lastChatUnixMilli < int64(mixedSuppressWindow/time.Millisecond) {
		return 0, 0
	}
	return sseContentLength(payload), sseReasoningLength(payload)
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
