package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/util"
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

func (h *Handler) streamResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, normalize bool, reqID string, reqHeaders http.Header, upstreamURL string, entryFormat combo.EntryFormat, originalModel string) {
	defer resp.Body.Close()

	// 仅在需要捕获详情（debugMode 或 playground 来源）时累积 SSE 全量，否则跳过
	captureDetails := h.debugMode() || reqHeaders.Get("X-TinyRouter-Source") == "playground"

	streamStart := time.Now()
	var inflightID int64
	if sel != nil {
		inflightID = h.Inflight.Register(sel.Provider.ID, sel.Key.ID)
		defer h.Inflight.Unregister(inflightID)
	}
	var lastSSEPush time.Time
	firstChunkDone := false

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.logger.Error("streaming not supported by response writer")
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	if sel != nil {
		w.Header().Set("X-TinyRouter-Provider", sel.Provider.Name)
		w.Header().Set("X-TinyRouter-Key", sel.KeyName)
	}
	w.WriteHeader(http.StatusOK)

	// Streaming responses must not be force-terminated by the HTTP server's
	// WriteTimeout. Clear the per-connection write deadline so a long SSE
	// stream (or a long gap between chunks) survives; the downstream request
	// context still cancels the stream if the client disconnects.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	buf := make([]byte, 32*1024)
	totalOutput := 0
	inputTokens := 0
	outputTokens := 0
	sb := &sse.SSELineBuffer{}
	var sseBuf bytes.Buffer
	var contentCharsTotal int
	var lastTokenBroadcast time.Time

	var clientDisconnected bool

	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			var contentChars int
			if normalize {
				for _, line := range sb.Feed(buf[:n]) {
					out := sse.NormalizeSSEChunk(line)
					if _, werr := w.Write([]byte(out + "\n")); werr != nil {
						h.logger.Debug("client disconnected during SSE stream: %v", werr)
						clientDisconnected = true
						break
					}
					totalOutput += len(out) + 1
					if strings.HasPrefix(strings.TrimSpace(line), "data:") {
						payload := strings.TrimSpace(strings.TrimSpace(line)[5:])
						if payload != "[DONE]" {
							if entryFormat == combo.EntryFormatAnthropic {
								// Anthropic streams usage across two events
								// (message_start → input_tokens, message_delta →
								// output_tokens). The OpenAI extractor must NOT
								// run here: it matches anthropic's
								// usage.output_tokens in message_delta and would
								// clobber input_tokens to 0.
								if in, out, ok := parseAnthropicSSEUsage([]byte(payload)); ok {
									if in > 0 {
										inputTokens = in
									}
									if out > 0 {
										outputTokens = out
									}
								}
							} else if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
								inputTokens = in
								outputTokens = out
							}
							if id, sig, ok := extractThoughtSignature([]byte(payload)); ok {
								h.sigCache.Put(id, sig)
							}
							contentChars += sseContentLength([]byte(payload))
						}
					}
					if h.debugMode() && reqID != "" && entryFormat == combo.EntryFormatOpenAI {
						h.parseAndBroadcastChunk(reqID, line, sb)
					}
					if captureDetails {
						sseBuf.WriteString(line)
						sseBuf.WriteByte('\n')
					}
				}
			} else {
				if _, err := w.Write(buf[:n]); err != nil {
					h.logger.Debug("client disconnected during SSE stream: %v", err)
					clientDisconnected = true
					break
				}
				for _, line := range sb.Feed(buf[:n]) {
					line = strings.TrimSpace(line)
					if strings.HasPrefix(line, "data:") {
						payload := strings.TrimSpace(line[5:])
						if payload == "[DONE]" {
							continue
						}
						if entryFormat == combo.EntryFormatAnthropic {
							// Anthropic streams usage across two events
							// (message_start → input_tokens, message_delta →
							// output_tokens). The OpenAI extractor must NOT run
							// here: it matches anthropic's usage.output_tokens in
							// message_delta and would clobber input_tokens to 0.
							if ain, aout, aok := parseAnthropicSSEUsage([]byte(payload)); aok {
								if ain > 0 {
									inputTokens = ain
								}
								if aout > 0 {
									outputTokens = aout
								}
							}
						} else if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
							inputTokens = in
							outputTokens = out
						}
						if id, sig, ok := extractThoughtSignature([]byte(payload)); ok {
							h.sigCache.Put(id, sig)
						}
						contentChars += sseContentLength([]byte(payload))
					}
					if h.debugMode() && reqID != "" && entryFormat == combo.EntryFormatOpenAI {
						h.parseAndBroadcastChunk(reqID, line, sb)
					}
					if captureDetails {
						sseBuf.WriteString(line)
						sseBuf.WriteByte('\n')
					}
				}
			}
			flusher.Flush()
			if inflightID != 0 {
				if !firstChunkDone {
					h.Inflight.SetFirstChunk(inflightID)
					firstChunkDone = true
				}
				if contentChars > 0 {
					h.Inflight.AddBytes(inflightID, contentChars)
				}
				if time.Since(lastSSEPush) > 1500*time.Millisecond {
					h.InflightUpdates.Signal()
					lastSSEPush = time.Now()
				}
			}
			contentCharsTotal += contentChars
			if reqID != "" && time.Since(lastTokenBroadcast) > 1500*time.Millisecond {
				lastTokenBroadcast = time.Now()
				effectiveOutput := outputTokens
				if effectiveOutput == 0 && contentCharsTotal > 0 {
					effectiveOutput = contentCharsTotal / 4
				}
				h.EntryTracker.UpdateTokens(reqID, -1, effectiveOutput)
				h.broadcastTokens(reqID, inputTokens, effectiveOutput)
			}
		}
		if clientDisconnected {
			break
		}
		if err != nil {
			remaining := sb.Remaining()
			if remaining != "" {
				if normalize {
					// normalize 路径未在循环中原样写出过整块，需要在这里写出规范化后的 remaining
					out := sse.NormalizeSSEChunk(remaining)
					if _, werr := w.Write([]byte(out + "\n")); werr != nil {
						h.logger.Debug("client disconnected during SSE stream: %v", werr)
						clientDisconnected = true
						break
					} else {
						totalOutput += len(out) + 1
						remaining = out
					}
				} else {
					// 非 normalize 路径：remaining 已经在循环中通过 w.Write(buf[:n]) 原样发出，
					// 不应重复写出。仅提取 token 计入 totalOutput/usage。
				}
			// 统一提取 token（两个路径都需要）
			line := strings.TrimSpace(remaining)
				if strings.HasPrefix(line, "data:") {
					payload := strings.TrimSpace(line[5:])
					if payload != "[DONE]" {
						if entryFormat == combo.EntryFormatAnthropic {
							// Anthropic usage spans message_start +
							// message_delta; skip the OpenAI extractor (see
							// the per-line branch above for the rationale).
							if in, out, ok := parseAnthropicSSEUsage([]byte(payload)); ok {
								if in > 0 {
									inputTokens = in
								}
								if out > 0 {
									outputTokens = out
								}
							}
						} else if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
							inputTokens = in
							outputTokens = out
						}
						if id, sig, ok := extractThoughtSignature([]byte(payload)); ok {
							h.sigCache.Put(id, sig)
						}
					}
				}
				if h.debugMode() && reqID != "" && entryFormat == combo.EntryFormatOpenAI {
					h.parseAndBroadcastChunk(reqID, line, sb)
				}
				if captureDetails {
					sseBuf.WriteString(line)
					sseBuf.WriteByte('\n')
				}
			}
			break
		}
	}

	if sel == nil {
		h.logger.Warn("stream response with nil selector, skipping usage recording")
		return
	}
	totalLatencyMs := latencyMs + time.Since(streamStart).Milliseconds()
	h.logger.Info("\U0001f4ca [stream] %s | in=%d | out=%d | conn=%s", sel.Provider.Name, inputTokens, outputTokens, sel.KeyName)
	dspModel := resolveDisplayModel(sel.Provider.Name, model, originalModel, h.reg)
	h.logger.Info("\U0001f300 [STREAM] %s | %s | %dms | %d", sel.Provider.Name, dspModel, totalLatencyMs, resp.StatusCode)
	// 非捕获模式下传 nil，recordUsage 内部 respBody 为空即不写 RespPayload
	var sseBody []byte
	if captureDetails {
		sseBody = sseBuf.Bytes()
	}
	status := "success"
	errMsg := ""
	if clientDisconnected {
		status = "error"
		errMsg = "client disconnected"
	}
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, totalLatencyMs, latencyMs, inputTokens, outputTokens, errMsg, reqBody, sseBody, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel)
}

func (h *Handler) passThroughResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, reqID string, reqHeaders http.Header, upstreamURL string, headersFlushed bool, originalModel string) {
	defer resp.Body.Close()

	// If the keep-alive goroutine already flushed headers (committed 200),
	// skip WriteHeader to avoid a superfluous-header warning. The response
	// body is written directly with the already-committed 200 status.
	if !headersFlushed {
		w.Header().Set("Content-Type", "application/json")
		if sel != nil {
			w.Header().Set("X-TinyRouter-Provider", sel.Provider.Name)
			w.Header().Set("X-TinyRouter-Key", sel.KeyName)
		}
		w.WriteHeader(resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		h.logger.Error("failed to read upstream response: %v", err)
		if sel != nil {
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, err.Error(), reqBody, nil, nil, 0, reqHeaders, upstreamURL, originalModel)
		}
		return
	}
	_, werr := w.Write(bodyBytes)

	inputTokens, outputTokens := util.ExtractTokens(bodyBytes)
	if sel == nil {
		h.logger.Warn("pass-through response with nil selector, skipping usage recording")
		return
	}
	status := "success"
	errMsg := ""
	if werr != nil {
		status = "error"
		errMsg = "client disconnected: " + werr.Error()
		h.logger.Warn("client disconnected during pass-through: %v", werr)
	}
	// 仅在需要详情时把 body 传给 recordUsage；否则传 nil 避免写入 ring
	captureDetails := h.debugMode() || reqHeaders.Get("X-TinyRouter-Source") == "playground"
	var respBodyForEntry []byte
	if captureDetails {
		respBodyForEntry = bodyBytes
	}
	h.logger.Info("\U0001f4ca [response] %s | in=%d | out=%d | conn=%s", sel.Provider.Name, inputTokens, outputTokens, sel.KeyName)
	h.logger.Info("\U0001f300 [RESPONSE] %s | %s | %dms | %d", sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, model, originalModel, h.reg), latencyMs, resp.StatusCode)
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, latencyMs, 0, inputTokens, outputTokens, errMsg, reqBody, respBodyForEntry, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel)
}

// parseAndBroadcastChunk extracts delta text from an SSE data: line in debug
// mode and broadcasts request-chunk events through the RequestUpdates
// broadcaster. The line argument is a raw SSE line (e.g. "data: {...}").
// The sb argument is the SSELineBuffer that has already produced this line;
// it is preserved so subsequent calls can continue scanning without losing
// any partial data between calls.
func (h *Handler) parseAndBroadcastChunk(reqID, line string, sb *sse.SSELineBuffer) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return
	}
	payload := strings.TrimSpace(trimmed[5:])
	if payload == "[DONE]" {
		return
	}

	deltas := parseSSEChunkDelta([]byte(payload))
	for _, d := range deltas {
		h.RequestUpdates.Broadcast(RequestEvent{
			Type:    "request-chunk",
			ID:      reqID,
			Section: d.section,
			Delta:   d.delta,
		})
	}
}

// chunkDelta is the per-chunk parse result for a single SSE data payload.
type chunkDelta struct {
	section string // "reasoning" | "assistant" | "usage"
	delta   string
}

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

// extractThoughtSignature scans an OpenAI-format SSE data payload for a Gemini
// thought_signature nested under delta.tool_calls[].extra_content.google.
// It returns the tool_call id (the cache key) and signature on the first match.
// A malformed payload or a payload without a signature returns ok=false.
func extractThoughtSignature(payload []byte) (toolCallID, signature string, ok bool) {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return "", "", false
	}
	choices, okc := obj["choices"].([]any)
	if !okc {
		return "", "", false
	}
	for _, c := range choices {
		choice, okc := c.(map[string]any)
		if !okc {
			continue
		}
		delta, okd := choice["delta"].(map[string]any)
		if !okd {
			continue
		}
		toolCalls, okt := delta["tool_calls"].([]any)
		if !okt {
			continue
		}
		for _, tc := range toolCalls {
			m, okm := tc.(map[string]any)
			if !okm {
				continue
			}
			id, _ := m["id"].(string)
			if id == "" {
				continue
			}
			extra, oke := m["extra_content"].(map[string]any)
			if !oke {
				continue
			}
			google, okg := extra["google"].(map[string]any)
			if !okg {
				continue
			}
			sig, oks := google["thought_signature"].(string)
			if !oks || sig == "" {
				continue
			}
			return id, sig, true
		}
	}
	return "", "", false
}
