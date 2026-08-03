package proxy

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

// maxStreamCaptureBytes caps the SSE stream body captured for trace/debug.
// The ring truncates respBody to 512KB from the FRONT; this keeps the TAIL,
// which for a stream carries the final usage event. The full stream still
// flows to the client — only the captured copy is bounded, so a multi-hour
// stream cannot balloon memory.
const maxStreamCaptureBytes = 512 * 1024

// boundedSSEBuffer retains only the last maxStreamCaptureBytes of the streamed
// SSE body, trimmed at a line boundary so the captured JSONL stays readable.
// It compacts only when well over the cap so a long stream does not memmove
// the whole tail on every chunk.
type boundedSSEBuffer struct {
	buf []byte
}

func (b *boundedSSEBuffer) WriteString(s string) {
	b.append([]byte(s))
}

func (b *boundedSSEBuffer) WriteByte(c byte) error {
	b.append([]byte{c})
	return nil
}

func (b *boundedSSEBuffer) append(p []byte) {
	b.buf = append(b.buf, p...)
	if len(b.buf) > 2*maxStreamCaptureBytes {
		excess := len(b.buf) - maxStreamCaptureBytes
		tail := b.buf[excess:]
		if i := bytes.IndexByte(tail, '\n'); i >= 0 {
			tail = tail[i+1:]
		}
		b.buf = append([]byte(nil), tail...)
	}
}

func (b *boundedSSEBuffer) Bytes() []byte { return b.buf }

func (h *Handler) streamResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, normalize bool, reqID string, reqHeaders http.Header, upstreamURL string, entryFormat combo.EntryFormat, originalModel, sessionKey string) {
	defer resp.Body.Close()

	// 任一消费者需要即累积 SSE 全量：追踪（logRequests，落盘 JSONL）/ debug ring（非 playground）/
	// playground（始终）。追踪的响应体捕获由此独立于 debug 模式。SSE 仍照常转发给客户端。
	isPlayground := reqHeaders != nil && reqHeaders.Get("X-TinyRouter-Source") == "playground"
	captureDetails := h.logRequests() || isPlayground || h.debugMode()

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
	var sseBuf boundedSSEBuffer
	var contentCharsTotal int
	var lastTokenBroadcast time.Time
	var lastEntryRefresh time.Time

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
			if now := time.Now(); now.Sub(lastEntryRefresh) >= time.Second {
				h.EntryTracker.Refresh(reqID)
				lastEntryRefresh = now
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
	dspModel := resolveDisplayModel(sel.Provider.Name, model, originalModel, h.aliases)
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
	streamDecision := "success"
	if status == "error" {
		streamDecision = "client disconnected"
	}
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, totalLatencyMs, latencyMs, inputTokens, outputTokens, errMsg, reqBody, sseBody, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, streamDecision, "")
}

func (h *Handler) passThroughResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, reqID string, reqHeaders http.Header, upstreamURL string, originalModel, sessionKey string) {
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	if sel != nil {
		w.Header().Set("X-TinyRouter-Provider", sel.Provider.Name)
		w.Header().Set("X-TinyRouter-Key", sel.KeyName)
	}
	w.WriteHeader(resp.StatusCode)

	// Read the FULL upstream body and write it to the client unmodified: the
	// old io.LimitReader(64MB) silently truncated large non-stream responses.
	// Client disconnect is handled by the write error path / request context,
	// NOT by pre-truncating the payload. Only the usage-capture copy below is
	// capped (recordUsage bounds it to 512KB anyway).
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		h.logger.Error("failed to read upstream response: %v", err)
		if sel != nil {
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, err.Error(), reqBody, nil, nil, 0, reqHeaders, upstreamURL, originalModel, sessionKey, "network error", "")
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
	// 任一消费者需要即把 body 传给 recordUsage（追踪 / debug ring / playground），见 streamResponse 同门。
	isPlayground := reqHeaders != nil && reqHeaders.Get("X-TinyRouter-Source") == "playground"
	captureDetails := h.logRequests() || isPlayground || h.debugMode()
	var respBodyForEntry []byte
	if captureDetails {
		// Cap ONLY the usage-capture copy; the client write above is unbounded.
		const maxPTRespBody = 512 * 1024
		if len(bodyBytes) > maxPTRespBody {
			respBodyForEntry = bodyBytes[:maxPTRespBody]
		} else {
			respBodyForEntry = bodyBytes
		}
	}
	h.logger.Info("\U0001f4ca [response] %s | in=%d | out=%d | conn=%s", sel.Provider.Name, inputTokens, outputTokens, sel.KeyName)
	h.logger.Info("\U0001f300 [RESPONSE] %s | %s | %dms | %d", sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, model, originalModel, h.aliases), latencyMs, resp.StatusCode)
	ptDecision := "success"
	if status == "error" {
		ptDecision = "client disconnected"
	}
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, latencyMs, 0, inputTokens, outputTokens, errMsg, reqBody, respBodyForEntry, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, ptDecision, "")
}
