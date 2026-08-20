package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

// isResponsesVisionRewrite reports whether the current frame was rewritten from
// chat+image to /v1/responses (muse vision path).
func isResponsesVisionRewrite(entryFormat combo.EntryFormat, effectivePath string) bool {
	return entryFormat == combo.EntryFormatOpenAI && effectivePath == "/v1/responses"
}

func (h *Handler) streamResponsesAsChat(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, reqID string, reqHeaders http.Header, upstreamURL string, originalModel, sessionKey string) {
	defer resp.Body.Close()

	streamStart := time.Now()
	var inflightID int64
	if sel != nil {
		inflightID = h.Inflight.Register(sel.Provider.ID, sel.Key.ID)
		defer h.Inflight.Unregister(inflightID)
	}
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
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	buf := make([]byte, 32*1024)
	sb := sse.NewSSELineBuffer(0, 0)
	var sseBuf bytes.Buffer
	var clientDisconnected bool
	var streamAborted bool
	inputTokens, outputTokens := 0, 0
	contentCharsTotal := 0
	respID := model // fallback
	created := time.Now().Unix()

	emitChatDelta := func(content string, finish string) {
		obj := map[string]any{
			"id":      respID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   model,
			"choices": []any{map[string]any{
				"index":         0,
				"delta":         map[string]any{"content": content},
				"finish_reason": nil,
			}},
		}
		if finish != "" {
			obj["choices"] = []any{map[string]any{
				"index": 0, "delta": map[string]any{},
				"logprobs": nil, "finish_reason": finish,
			}}
		}
		if finish == "" && content == "" {
			return
		}
		b, _ := json.Marshal(obj)
		line := "data: " + string(b)
		_, _ = sseBuf.Write([]byte(line + "\n"))
		if _, err := w.Write([]byte(line + "\n\n")); err != nil {
			clientDisconnected = true
		} else {
			flusher.Flush()
		}
		if finish == "" && content != "" {
			contentCharsTotal += len(content)
		}
	}

	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			_, _ = sseBuf.Write(buf[:n])
			lines, ferr := sb.Feed(buf[:n])
			if ferr != nil {
				h.logger.Error("SSE stream aborted: %v", ferr)
				streamAborted = true
				break
			}
			for _, line := range lines {
				t := strings.TrimSpace(line)
				if !strings.HasPrefix(t, "data:") {
					continue
				}
				payload := strings.TrimSpace(t[5:])
				if payload == "" || payload == "[DONE]" {
					continue
				}
				var ev map[string]any
				if err := json.Unmarshal([]byte(payload), &ev); err != nil {
					continue
				}
				typ, _ := ev["type"].(string)
				switch typ {
				case "response.created", "response.in_progress":
					if r, ok := ev["response"].(map[string]any); ok {
						if id, ok := r["id"].(string); ok && id != "" {
							respID = id
						}
						if ca, ok := r["created_at"].(float64); ok {
							created = int64(ca)
						}
					}
				case "response.output_text.delta":
					delta, _ := ev["delta"].(string)
					if respID == model {
						if id, ok := ev["item_id"].(string); ok && id != "" {
							// keep respID as is; item_id is not the response id
						}
					}
					emitChatDelta(delta, "")
				case "response.completed":
					if r, ok := ev["response"].(map[string]any); ok {
						if u, ok := r["usage"].(map[string]any); ok {
							if v, ok := u["input_tokens"].(float64); ok {
								inputTokens = int(v)
							}
							if v, ok := u["output_tokens"].(float64); ok {
								outputTokens = int(v)
							}
						}
					}
					emitChatDelta("", "stop")
				case "response.incomplete":
					emitChatDelta("", "length")
				case "response.failed":
					emitChatDelta("", "stop")
				}
				if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
					if in > 0 {
						inputTokens = in
					}
					if out > 0 {
						outputTokens = out
					}
				}
			}
		}
		if clientDisconnected {
			break
		}
		if err != nil {
			remaining := sb.Remaining()
			if remaining != "" {
				// best effort: try one more event
			}
			break
		}
	}
	if !streamAborted && !clientDisconnected {
		// Ensure terminal if upstream didn't send completed (coalescing guard already in emit)
		// We always append [DONE] to satisfy the chat SSE contract.
		if _, err := w.Write([]byte("data: [DONE]\n\n")); err == nil {
			flusher.Flush()
		}
	}
	if sel == nil {
		return
	}
	totalLatencyMs := latencyMs + time.Since(streamStart).Milliseconds()
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
	_ = contentCharsTotal
	h.logger.Info("\U0001f4ca [stream] %s | in=%d | out=%d | conn=%s (responses→chat)", sel.Provider.Name, inputTokens, outputTokens, sel.KeyName)
	h.logger.Info("\U0001f300 [STREAM] %s | %s | %dms | %d (responses→chat)", sel.Provider.Name, model, totalLatencyMs, resp.StatusCode)
	h.recordUsage(reqID, sel.Provider.Name, model, sel, status, totalLatencyMs, latencyMs, inputTokens, outputTokens, errMsg, reqBody, sseBody, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, streamDecision, "")
}

func (h *Handler) passThroughResponsesAsChat(w http.ResponseWriter, resp *http.Response, model string, sel *rotation.SelectedKey, latencyMs int64, reqBody []byte, reqID string, reqHeaders http.Header, upstreamURL string, originalModel, sessionKey string) {
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to read upstream response")
		return
	}
	var j map[string]any
	if err := json.Unmarshal(body, &j); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}
	// Responses non-stream shape: {output:[{content:[{type:"output_text",text:"..."}]}]}
	var text string
	var finish = "stop"
	if out, ok := j["output"].([]any); ok && len(out) > 0 {
		if m, ok := out[0].(map[string]any); ok {
			if c, ok := m["content"].([]any); ok && len(c) > 0 {
				if t, ok := c[0].(map[string]any); ok {
					if s, ok := t["text"].(string); ok {
						text = s
					}
				}
			}
			// Some responses put text directly in output[0].content[0].text
			// Alternative path: output[0].content
		}
	}
	// Fallback: scan raw for output_text
	if text == "" {
		if out, ok := j["output"].([]any); ok {
			for _, o := range out {
				if mm, ok := o.(map[string]any); ok {
					if typ, _ := mm["type"].(string); typ == "message" {
						if c, ok := mm["content"].([]any); ok {
							for _, cc := range c {
								if cm, ok := cc.(map[string]any); ok && cm["type"] == "output_text" {
									if s, ok := cm["text"].(string); ok {
										text = s
									}
								}
							}
						}
					}
				}
			}
		}
	}
	if st, _ := j["status"].(string); st == "incomplete" {
		finish = "length"
	}
	if st, _ := j["status"].(string); st == "failed" {
		finish = "stop"
	}
	created := int64(0)
	if v, ok := j["created_at"].(float64); ok {
		created = int64(v)
	}
	if created == 0 {
		created = time.Now().Unix()
	}
	id, _ := j["id"].(string)
	if id == "" {
		id = fmt.Sprintf("chatcmpl_%d", time.Now().UnixNano())
	}
	chat := map[string]any{
		"id": id, "object": "chat.completion", "created": created, "model": model,
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": text}, "finish_reason": finish}},
	}
	if u, ok := j["usage"].(map[string]any); ok {
		chat["usage"] = u
	}
	b, _ := json.Marshal(chat)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(b)
	if sel != nil {
		in, out := util.ExtractTokens(b)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "success", latencyMs, 0, in, out, "", reqBody, b, resp.Header, resp.StatusCode, reqHeaders, upstreamURL, originalModel, sessionKey, "success", "")
	}
}
