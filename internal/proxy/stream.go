package proxy

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

func (h *Handler) streamResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, normalize bool, reqID string, reqHeaders http.Header, upstreamURL string, entryFormat combo.EntryFormat, originalModel, sessionKey string) {
	defer resp.Body.Close()

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
	sb := sse.NewSSELineBuffer(0, 0)
	var sseBuf bytes.Buffer
	var contentCharsTotal int
	var lastTokenBroadcast time.Time
	var lastEntryRefresh time.Time

	var clientDisconnected bool
	// streamAborted records a controlled abort caused by an over-budget SSE
	// line (F-14): the upstream is emitting garbage beyond the line/buffer
	// cap, so the stream is closed and usage is recorded with an error.
	var streamAborted bool
	// Terminal-marker tracking: some upstreams (notably opencode.ai's
	// /v1/chat/completions) stream content but never emit the standard
	// finish_reason chunk or data: [DONE] sentinel - the connection just
	// closes after an empty usage chunk. Chat clients block forever on that,
	// so we synthesize the missing terminator at stream end (see below).
	var streamSawDone bool
	var streamSawFinish bool
	noteChunk := func(payload string) {
		if payload == "[DONE]" {
			streamSawDone = true
		} else if strings.Contains(payload, `"finish_reason":"`) {
			// A quoted string value means a real terminal reason
			// ("stop"|"length"|"content_filter"|"tool_calls"); the common
			// "finish_reason":null in mid-stream chunks must NOT count.
			streamSawFinish = true
		}
	}
	var respID string
	extractStringField := func(s, field string) string {
		i := strings.Index(s, field)
		if i < 0 {
			return ""
		}
		rest := s[i+len(field):]
		j := strings.IndexByte(rest, '"')
		if j <= 0 {
			return ""
		}
		return rest[:j]
	}
	// patchOpenAIChunk backfills "id":"" / "model":"" on opencode.ai chat
	// chunks with the real response id and model, so strict clients that
	// drop empty-id chunks still receive content and the finish signals.
	patchOpenAIChunk := func(line, payload string) string {
		if respID == "" {
			if v := extractStringField(payload, `"id":"`); v != "" && v != "null" {
				respID = v
			}
		}
		changed := false
		if respID != "" && strings.Contains(payload, `"id":""`) {
			payload = strings.Replace(payload, `"id":""`, `"id":"`+respID+`"`, 1)
			changed = true
		}
		if strings.Contains(payload, `"model":""`) {
			payload = strings.Replace(payload, `"model":""`, `"model":"`+model+`"`, 1)
			changed = true
		}
		if !changed {
			return line
		}
		return "data: " + payload
	}
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			_, _ = sseBuf.Write(buf[:n])
			var contentChars int
			if normalize {
				lines, ferr := sb.Feed(buf[:n])
				if ferr != nil {
					h.logger.Error("SSE stream aborted: %v", ferr)
					streamAborted = true
					break
				}
				for _, line := range lines {
					out := sse.NormalizeSSEChunk(line)
					if _, werr := w.Write([]byte(out + "\n")); werr != nil {
						h.logger.Debug("client disconnected during SSE stream: %v", werr)
						clientDisconnected = true
						break
					}
					totalOutput += len(out) + 1
					if strings.HasPrefix(strings.TrimSpace(line), "data:") {
						payload := strings.TrimSpace(strings.TrimSpace(line)[5:])
						noteChunk(payload)
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
				}
			} else {
				// OpenAI chat chunks are patched per line so empty "id"/"model"
				// fields (opencode.ai emits them as "") get backfilled with the
				// real response id — strict clients drop empty-id chunks, which
				// would silently erase both content and the terminal signals.
				// All other entry formats keep the raw byte-forward path so
				// their SSE fabric is untouched.
				rawForward := entryFormat != combo.EntryFormatOpenAI
				if rawForward {
					if _, err := w.Write(buf[:n]); err != nil {
						h.logger.Debug("client disconnected during SSE stream: %v", err)
						clientDisconnected = true
						break
					}
				}
				lines, ferr := sb.Feed(buf[:n])
				if ferr != nil {
					h.logger.Error("SSE stream aborted: %v", ferr)
					streamAborted = true
					break
				}
				for _, line := range lines {
					orig := line
					line = strings.TrimSpace(line)
					if strings.HasPrefix(line, "data:") {
						payload := strings.TrimSpace(line[5:])
						noteChunk(payload)
						if !rawForward {
							out := line
							if payload != "[DONE]" {
								out = patchOpenAIChunk(line, payload)
							}
							if _, werr := w.Write([]byte(out + "\n")); werr != nil {
								h.logger.Debug("client disconnected during SSE stream: %v", werr)
								clientDisconnected = true
								break
							}
							if payload == "[DONE]" {
								continue
							}
						} else if payload == "[DONE]" {
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
					} else if !rawForward {
						// Preserve non-data SSE fields (event:..., : comments,
						// blank separators) byte-for-byte.
						if _, werr := w.Write([]byte(orig + "\n")); werr != nil {
							h.logger.Debug("client disconnected during SSE stream: %v", werr)
							clientDisconnected = true
							break
						}
					}
					if h.debugMode() && reqID != "" && entryFormat == combo.EntryFormatOpenAI {
						h.parseAndBroadcastChunk(reqID, line, sb)
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
				} else if entryFormat == combo.EntryFormatOpenAI {
					// Patched per-line path: this trailing partial line was NOT
					// written yet — flush it (with id/model backfill).
					out := remaining
					if tr := strings.TrimSpace(remaining); strings.HasPrefix(tr, "data:") {
						pl := strings.TrimSpace(tr[5:])
						out = patchOpenAIChunk(remaining, pl)
					}
					if _, werr := w.Write([]byte(out + "\n")); werr != nil {
						h.logger.Debug("client disconnected during SSE stream: %v", werr)
					}
				} else {
					// 非 normalize / non-OpenAI 路径：remaining 已经在循环中通过
					// w.Write(buf[:n]) 原样发出，不应重复写出。仅提取 token 计入
					// totalOutput/usage。
				}
				// 统一提取 token（两个路径都需要）
				line := strings.TrimSpace(remaining)
				if strings.HasPrefix(line, "data:") {
					payload := strings.TrimSpace(line[5:])
					noteChunk(payload)
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
			}
			break
		}
	}

	// opencode.ai's /v1/chat/completions (OpenCode Go / Zen) streams real
	// content deltas but never emits the standard terminal markers — no
	// finish_reason chunk, no "data: [DONE]" — the connection just closes
	// after an empty usage / "cost" chunk. OpenAI-spec chat clients (OMP,
	// desktop apps, AI SDK) block forever waiting for that terminator, so a
	// stream that looks "responsive" never finishes. Synthesize the missing
	// terminal here; it is harmless when the upstream did send one (we only
	// fill the gap: no finish chunk if a finish_reason was seen, no [DONE]
	// if one already flowed).
	if !streamAborted && !clientDisconnected && sel != nil && entryFormat == combo.EntryFormatOpenAI && !streamSawDone {
		var synth strings.Builder
		synth.WriteString(`data: {"id":`)
		synth.WriteString(strconv.Quote(respID))
		synth.WriteString(`,"object":"chat.completion.chunk","created":`)
		synth.WriteString(strconv.FormatInt(time.Now().Unix(), 10))
		synth.WriteString(`,"model":`)
		synth.WriteString(strconv.Quote(model))
		synth.WriteString(`,"choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}`)
		if !streamSawFinish {
			// Beware: SSE requires a blank line after each event (the upstream
			// nonstandard stream may otherwise coalesce the synthetic finish
			// chunk and [DONE] into one frame, which strict clients parse as a
			// single malformed event and reject).
			if _, werr := w.Write([]byte(synth.String() + "\n\n")); werr != nil {
				h.logger.Debug("client disconnected during SSE finish synthesis: %v", werr)
			}
		}
		if _, werr := w.Write([]byte("data: [DONE]\n\n")); werr == nil {
			flusher.Flush()
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
	sseBody := sseBuf.Bytes()
	status := "success"
	errMsg := ""
	if streamAborted {
		status = "error"
		errMsg = "SSE stream exceeded line buffer budget"
	} else if clientDisconnected {
		status = "error"
		errMsg = "client disconnected"
	}
	streamDecision := "success"
	switch {
	case streamAborted:
		streamDecision = "line buffer exceeded"
	case status == "error":
		streamDecision = "client disconnected"
	}
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, totalLatencyMs, latencyMs, inputTokens, outputTokens, errMsg, reqBody, sseBody, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, streamDecision, "")
}

// maxPassThroughBodyBytes caps a non-streaming upstream response buffered for
// pass-through. Unlike the old io.LimitReader (which silently truncated), an
// over-budget response is refused with a controlled 502 error before any
// header is committed, so the client never receives a corrupt partial body.
// The usage/trace capture copy contains the complete response; the client
// transport budget remains separate (F-14).
const maxPassThroughBodyBytes = 256 << 20

func (h *Handler) passThroughResponse(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, reqID string, reqHeaders http.Header, upstreamURL string, originalModel, sessionKey string) {
	defer resp.Body.Close()

	// Read the FULL upstream body with an explicit budget, and only commit
	// the upstream status AFTER the read succeeds: an over-budget or failed
	// read must surface as a controlled error instead of an empty/truncated
	// response body. The old io.LimitReader silently truncated large bodies;
	// the client-facing budget errors out instead (F-14).
	budget := h.maxPassThroughBody
	if budget <= 0 {
		budget = maxPassThroughBodyBytes
	}
	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, budget+1))
	if err != nil {
		h.logger.Error("failed to read upstream response: %v", err)
		if sel != nil {
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, err.Error(), reqBody, nil, nil, 0, reqHeaders, upstreamURL, originalModel, sessionKey, "network error", "")
		}
		writeError(w, http.StatusBadGateway, "failed to read upstream response")
		return
	}
	if int64(len(bodyBytes)) > budget {
		h.logger.Error("upstream response exceeds %d bytes, refusing pass-through", budget)
		if sel != nil {
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, "upstream response exceeds maximum size", reqBody, nil, nil, 0, reqHeaders, upstreamURL, originalModel, sessionKey, "response too large", "")
		}
		writeError(w, http.StatusBadGateway, "upstream response exceeds maximum size")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if sel != nil {
		w.Header().Set("X-TinyRouter-Provider", sel.Provider.Name)
		w.Header().Set("X-TinyRouter-Key", sel.KeyName)
	}
	w.WriteHeader(resp.StatusCode)

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
	respBodyForEntry := bodyBytes
	h.logger.Info("\U0001f4ca [response] %s | in=%d | out=%d | conn=%s", sel.Provider.Name, inputTokens, outputTokens, sel.KeyName)
	h.logger.Info("\U0001f300 [RESPONSE] %s | %s | %dms | %d", sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, model, originalModel, h.aliases), latencyMs, resp.StatusCode)
	ptDecision := "success"
	if status == "error" {
		ptDecision = "client disconnected"
	}
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, latencyMs, 0, inputTokens, outputTokens, errMsg, reqBody, respBodyForEntry, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, ptDecision, "")
}
