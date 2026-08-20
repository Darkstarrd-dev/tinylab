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

// isChatToResponsesRewrite reports whether the current frame was rewritten from
// /v1/chat/completions to /v1/responses (chat-responses compat / muse vision
// path). Such frames translate the upstream Responses stream back into chat
// SSE for the client.
func isChatToResponsesRewrite(entryFormat combo.EntryFormat, effectivePath string) bool {
	return entryFormat == combo.EntryFormatOpenAI && effectivePath == "/v1/responses"
}

// toolCallDelta accumulates one function call across Responses stream events so
// the client receives chat tool_calls delta chunks with stable indices.
type toolCallDelta struct {
	idx  int
	id   string
	name string
	args strings.Builder
}

// finishFromStatus maps a Responses response status to the chat finish_reason
// clients use to decide the next step (e.g. run tool calls vs stop).
func finishFromStatus(status string) string {
	switch status {
	case "requires_action":
		return "tool_calls"
	case "incomplete":
		return "length"
	default:
		return "stop"
	}
}

// responsesToChatState is a pure state machine folding Responses API SSE
// events into chat.completion.chunk payloads. Keeping it separate from the
// HTTP loop makes the translation unit-testable without a server.
type responsesToChatState struct {
	respID      string
	created     int64
	model       string
	done        bool                      // a terminal finish chunk was already emitted
	usageInput  int                       // usage pulled from response.completed
	usageOutput int                       //
	toolCalls   []*toolCallDelta          // order of appearance → chat index
	toolByID    map[string]*toolCallDelta // responses item_id → call
}

func newResponsesToChatState(model string) *responsesToChatState {
	return &responsesToChatState{
		respID:   model, // fallback until response.created carries a real id
		created:  time.Now().Unix(),
		model:    model,
		toolByID: map[string]*toolCallDelta{},
	}
}

// contentDelta builds a chat chunk carrying a text delta, or a terminal chunk
// (empty delta + finish_reason) when finish != "". Returns nil for a no-op.
func (s *responsesToChatState) contentDelta(content, finish string) []byte {
	if content == "" && finish == "" {
		return nil
	}
	obj := map[string]any{
		"id": s.respID, "object": "chat.completion.chunk", "created": s.created, "model": s.model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": content}, "finish_reason": nil}},
	}
	if finish != "" {
		obj["choices"] = []any{map[string]any{
			"index": 0, "delta": map[string]any{}, "logprobs": nil, "finish_reason": finish,
		}}
	}
	b, _ := json.Marshal(obj)
	return b
}

// toolChunk builds a chat chunk carrying one tool_calls delta frame. When
// announce is true the frame declares a fresh tool call (id + name + empty
// arguments) — the shape chat clients use to start assembling a call.
func (s *responsesToChatState) toolChunk(tc *toolCallDelta, announce bool) []byte {
	delta := map[string]any{}
	var fn map[string]any
	if announce {
		fn = map[string]any{"name": tc.name, "arguments": ""}
	} else {
		fn = map[string]any{"arguments": tc.args.String()}
	}
	frame := map[string]any{"index": tc.idx, "type": "function", "function": fn}
	if tc.id != "" {
		frame["id"] = tc.id
	}
	delta["tool_calls"] = []any{frame}
	obj := map[string]any{
		"id": s.respID, "object": "chat.completion.chunk", "created": s.created, "model": s.model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}},
	}
	b, _ := json.Marshal(obj)
	return b
}

// toolArgsChunk builds a chat tool_calls chunk carrying exactly the fragment
// that just arrived (not the cumulative buffer). The cumulative buffer is
// still tracked in tc.args so a recovery path can replay it if needed.
func (s *responsesToChatState) toolArgsChunk(tc *toolCallDelta, fragment string) []byte {
	delta := map[string]any{
		"tool_calls": []any{map[string]any{
			"index": tc.idx, "type": "function",
			"function": map[string]any{"arguments": fragment},
		}},
	}
	obj := map[string]any{
		"id": s.respID, "object": "chat.completion.chunk", "created": s.created, "model": s.model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}},
	}
	b, _ := json.Marshal(obj)
	return b
}

// toolAdded registers a newly announced function_call item and returns a chat
// chunk declaring it (or nil when nothing concrete is known yet).
func (s *responsesToChatState) toolAdded(itemID, callID, name string) []byte {
	tc := &toolCallDelta{idx: len(s.toolCalls), id: callID, name: name}
	s.toolCalls = append(s.toolCalls, tc)
	if itemID != "" {
		s.toolByID[itemID] = tc
	}
	if callID == "" && name == "" {
		return nil
	}
	return s.toolChunk(tc, true)
}

// toolByItem resolves a function_call item by its responses id, falling back to
// the most recently announced call when the id is absent (nonstandard streams).
func (s *responsesToChatState) toolByItem(itemID string) *toolCallDelta {
	if itemID != "" {
		if tc, ok := s.toolByID[itemID]; ok {
			return tc
		}
	}
	if n := len(s.toolCalls); n > 0 {
		return s.toolCalls[n-1]
	}
	return nil
}

// toolArgs appends an arguments fragment to the call and returns a chat chunk
// carrying that fragment.
func (s *responsesToChatState) toolArgs(itemID, fragment string) []byte {
	tc := s.toolByItem(itemID)
	if tc == nil || fragment == "" {
		return nil
	}
	tc.args.WriteString(fragment)
	return s.toolArgsChunk(tc, fragment)
}

// OnEvent folds one parsed Responses SSE event into chat SSE payloads (the JSON
// after "data: "). Multiple payloads can be returned for a single upstream
// event.
func (s *responsesToChatState) OnEvent(ev map[string]any) [][]byte {
	var out [][]byte
	typ, _ := ev["type"].(string)
	switch typ {
	case "response.created", "response.in_progress":
		if r, ok := ev["response"].(map[string]any); ok {
			if id, ok := r["id"].(string); ok && id != "" {
				s.respID = id
			}
			if ca, ok := r["created_at"].(float64); ok {
				s.created = int64(ca)
			}
		}
	case "response.output_item.added":
		item, _ := ev["item"].(map[string]any)
		if item == nil {
			return nil
		}
		if it, _ := item["type"].(string); it == "function_call" {
			itemID, _ := item["id"].(string)
			callID, _ := item["call_id"].(string)
			name, _ := item["name"].(string)
			if c := s.toolAdded(itemID, callID, name); c != nil {
				out = append(out, c)
			}
			// Some endpoints include the full arguments on the item itself.
			if args, _ := item["arguments"].(string); args != "" {
				if c := s.toolArgs(itemID, args); c != nil {
					out = append(out, c)
				}
			}
		}
	case "response.output_text.delta":
		delta, _ := ev["delta"].(string)
		if c := s.contentDelta(delta, ""); c != nil {
			out = append(out, c)
		}
	case "response.function_call_arguments.delta":
		itemID, _ := ev["item_id"].(string)
		delta, _ := ev["delta"].(string)
		if c := s.toolArgs(itemID, delta); c != nil {
			out = append(out, c)
		}
	case "response.completed", "response.incomplete", "response.failed":
		status := ""
		if r, ok := ev["response"].(map[string]any); ok {
			if st, _ := r["status"].(string); st != "" {
				status = st
			}
			if u, ok := r["usage"].(map[string]any); ok {
				if v, ok := u["input_tokens"].(float64); ok {
					s.usageInput = int(v)
				}
				if v, ok := u["output_tokens"].(float64); ok {
					s.usageOutput = int(v)
				}
			}
			// Drain function_calls that a nonstandard stream never announced in
			// output_item.added (items already streamed are skipped by id).
			if outs, ok := r["output"].([]any); ok {
				for _, o := range outs {
					om, _ := o.(map[string]any)
					if om == nil {
						continue
					}
					if it, _ := om["type"].(string); it == "function_call" {
						itemID, _ := om["id"].(string)
						if _, known := s.toolByID[itemID]; known {
							continue
						}
						callID, _ := om["call_id"].(string)
						name, _ := om["name"].(string)
						if c := s.toolAdded(itemID, callID, name); c != nil {
							out = append(out, c)
						}
						if args, _ := om["arguments"].(string); args != "" {
							if c := s.toolArgs(itemID, args); c != nil {
								out = append(out, c)
							}
						}
					}
				}
			}
		}
		if typ == "response.incomplete" {
			status = "incomplete"
		}
		if typ == "response.failed" {
			status = "failed"
		}
		if !s.done {
			if c := s.contentDelta("", finishFromStatus(status)); c != nil {
				out = append(out, c)
			}
			s.done = true
		}
	}
	return out
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
	conv := newResponsesToChatState(model)

	writeChunk := func(b []byte) {
		line := "data: " + string(b)
		_, _ = sseBuf.Write([]byte(line + "\n\n"))
		if _, err := w.Write([]byte(line + "\n\n")); err != nil {
			clientDisconnected = true
		} else {
			flusher.Flush()
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
				for _, c := range conv.OnEvent(ev) {
					writeChunk(c)
				}
				if conv.usageInput > 0 {
					inputTokens = conv.usageInput
				}
				if conv.usageOutput > 0 {
					outputTokens = conv.usageOutput
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
			break
		}
	}

	// Terminal contract: chat streams must end with a finish chunk + [DONE].
	// When the upstream closed without response.completed (its stream fabric
	// can drop terminal events), synthesize a "stop" finish so strict clients
	// don't hang; [DONE] always follows.
	if !streamAborted && !clientDisconnected {
		if !conv.done {
			writeChunk(conv.contentDelta("", "stop"))
		}
		line := "data: [DONE]"
		_, _ = sseBuf.Write([]byte(line + "\n\n"))
		if _, err := w.Write([]byte(line + "\n\n")); err == nil {
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
	// Responses non-stream shape:
	// {output:[{type:"message",content:[{type:"output_text",text:"..."}]},
	//          {type:"function_call",call_id,name,arguments}], status:...}
	var text string
	var toolCalls []any
	if out, ok := j["output"].([]any); ok {
		for _, o := range out {
			om, _ := o.(map[string]any)
			if om == nil {
				continue
			}
			switch typ, _ := om["type"].(string); typ {
			case "message":
				if c, ok := om["content"].([]any); ok {
					for _, cc := range c {
						cm, _ := cc.(map[string]any)
						if cm == nil {
							continue
						}
						if t, _ := cm["type"].(string); t == "output_text" {
							if sv, _ := cm["text"].(string); sv != "" {
								if text != "" {
									text += "\n"
								}
								text += sv
							}
						}
					}
				}
			case "function_call":
				callID, _ := om["call_id"].(string)
				name, _ := om["name"].(string)
				args, _ := om["arguments"].(string)
				toolCalls = append(toolCalls, map[string]any{
					"id": callID, "type": "function",
					"function": map[string]any{"name": name, "arguments": args},
				})
			}
		}
	}
	if text == "" {
		if sv, ok := j["output_text"].(string); ok {
			text = sv
		}
	}
	status, _ := j["status"].(string)
	finish := finishFromStatus(status)
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
	message := map[string]any{"role": "assistant", "content": text}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	chat := map[string]any{
		"id": id, "object": "chat.completion", "created": created, "model": model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
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
