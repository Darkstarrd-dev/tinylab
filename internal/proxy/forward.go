package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/usage"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

// resolveDisplayModel returns the best display name for console logs:
// prefer alias from registry, fall back to originalModel, then upstreamModel.
func resolveDisplayModel(providerName, upstreamModel, originalModel string, reg ModelResolver) string {
	if alias := reg.ResolveModelAliasByID(providerName, upstreamModel); alias != "" {
		return alias
	}
	if originalModel != "" && originalModel != upstreamModel {
		return originalModel
	}
	return upstreamModel
}

// generateToolCallID creates a unique tool_call id compatible with the
// OpenAI tool-call format (e.g. "call_<hex>"). This is used as a defensive
// fallback when an upstream provider returns an empty tool_call id.
func generateToolCallID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Fallback: timestamp-based, practically unique.
		return fmt.Sprintf("call_%x", time.Now().UnixNano())
	}
	return "call_" + hex.EncodeToString(buf[:])
}

// ensureToolCallIDs scans the parsed request body for tool-call messages
// with empty identifiers and fills in random ones, ensuring that assistant
// tool_calls[].id and the corresponding tool message's tool_call_id match.
//
// Some upstream providers (e.g. Google AI Studio via OpenRouter) return
// empty tool_call ids in SSE deltas, which causes the client's subsequent
// tool messages to carry empty tool_call_id and triggers 400 "Tool message
// must have either name or tool_call_id" errors. This function is a
// defense-in-depth measure that runs for every request, regardless of
// provider. It maintains consistency by pairing tool messages with their
// preceding assistant message's tool calls by position.
func ensureToolCallIDs(parsed map[string]any) {
	msgs, ok := parsed["messages"].([]any)
	if !ok {
		return
	}

	// Pending tool call IDs from the last assistant message, consumed by
	// subsequent tool messages in order. This handles the common case
	// where tool results are returned in the same order as tool calls.
	var pendingIDs []string

	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)

		switch role {
		case "assistant":
			toolCalls, ok := msg["tool_calls"].([]any)
			if !ok {
				continue
			}
			pendingIDs = make([]string, 0, len(toolCalls))
			for _, tc := range toolCalls {
				tcm, ok := tc.(map[string]any)
				if !ok {
					pendingIDs = append(pendingIDs, "")
					continue
				}
				id, _ := tcm["id"].(string)
				if id == "" {
					id = generateToolCallID()
					tcm["id"] = id
				}
				pendingIDs = append(pendingIDs, id)
			}

		case "tool":
			toolCallID, _ := msg["tool_call_id"].(string)
			if toolCallID != "" {
				continue
			}
			// Consume the next pending ID from the preceding assistant message.
			if len(pendingIDs) > 0 {
				msg["tool_call_id"] = pendingIDs[0]
				pendingIDs = pendingIDs[1:]
			} else {
				msg["tool_call_id"] = generateToolCallID()
			}
		}
	}
}

func (h *Handler) handleProxy(w http.ResponseWriter, r *http.Request, path string, entryFormat combo.EntryFormat) {
	defer r.Body.Close()
	// 32 MB 代理请求体上限（LLM prompt 可能很大，32MB 足够）
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	modelStr, _ := parsed["model"].(string)
	if modelStr == "" {
		writeError(w, http.StatusBadRequest, "missing 'model' field")
		return
	}

	isStream := false
	if s, ok := parsed["stream"].(bool); ok {
		isStream = s
	}

	msgCount := 0
	if msgs, ok := parsed["messages"].([]any); ok {
		msgCount = len(msgs)
	}

	if h.comboRes.IsComboName(modelStr) {
		h.handleCombo(w, r, modelStr, bodyBytes, parsed, isStream, msgCount, path, entryFormat)
		return
	}

	if qs, ok := h.reg.GetQuickSlotByName(modelStr); ok {
		models := qs.Models
		idx := qs.SelectedIndex
		if idx < 0 || idx >= len(models) {
			idx = 0
		}
		if idx < len(models) {
			modelStr = models[idx]
		} else {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("quickslot %s has no models", modelStr))
			return
		}
	}

	if h.comboRes.IsComboName(modelStr) {
		h.handleCombo(w, r, modelStr, bodyBytes, parsed, isStream, msgCount, path, entryFormat)
		return
	}

	providerID, upstreamModel := util.SplitModel(modelStr)
	if providerID == "" {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid model format: %s (expected provider/model)", modelStr))
		return
	}

	// Resolve prefix to actual provider ID
	provider, ok := h.reg.GetProviderByPrefix(providerID)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown provider prefix: %s", providerID))
		return
	}
	providerID = provider.ID

	// Clean up potential duplicate provider prefix/ID in upstreamModel
	for {
		trimmed := false
		if provider.Prefix != "" && strings.HasPrefix(upstreamModel, provider.Prefix+"/") {
			upstreamModel = strings.TrimPrefix(upstreamModel, provider.Prefix+"/")
			trimmed = true
		}
		if provider.ID != "" && strings.HasPrefix(upstreamModel, provider.ID+"/") {
			upstreamModel = strings.TrimPrefix(upstreamModel, provider.ID+"/")
			trimmed = true
		}
		if !trimmed {
			break
		}
	}

	// NOTE: entry-format ↔ provider protocol matching was removed. TinyRouter
	// fronts aggregating proxies (e.g. newapi / 2api) that serve multiple
	// protocols from the same provider, and capabilities are per-model rather
	// than per-provider. Whatever protocol the client requests, the proxy
	// forwards it upstream; rejection (if any) is the upstream's call, not ours.
	// The anthropic vs OpenAI upstream construction is still chosen by
	// entryFormat (see forwardUpstream), so proto routing continues to work.

	// Resolve alias to real model ID: if the user specified an alias, find
	// the actual model ID before forwarding to the upstream.
	originalModel := upstreamModel
	if realID, found := h.reg.ResolveModelAlias(provider.Prefix, upstreamModel); found {
		upstreamModel = realID
	}

	// NIM providers must not participate in Combo routing: the model name
	// carries a nv/* prefix and never matches a combo name, so no combo
	// resolution is attempted for them — fall through to the forward path.
	if ok, _ := h.forwardWithRetry(w, r, providerID, upstreamModel, path, bodyBytes, parsed, isStream, msgCount, "", provider.Name, entryFormat, originalModel); !ok {
		writeError(w, http.StatusBadGateway, "all keys exhausted")
	}
}

func (h *Handler) handleCombo(w http.ResponseWriter, r *http.Request, comboName string, bodyBytes []byte, parsed map[string]any, isStream bool, msgCount int, path string, entryFormat combo.EntryFormat) {
	plan, err := h.comboRes.Resolve(comboName, entryFormat)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if plan == nil || len(plan.Targets) == 0 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("combo not found or empty: %s", comboName))
		return
	}

	comboLabel := fmt.Sprintf("[combo:%s] ", comboName)
	switch plan.Strategy {
	case "fallback":
		for _, target := range plan.Targets {
			if ok, _ := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, ""); ok {
				return
			}
		}
		writeError(w, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
	case "round-robin":
		target := plan.Targets[0]
		if ok, _ := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, ""); !ok {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
		}
	case "greedy-squirrel":
		for _, target := range plan.Targets {
			if ok, _ := h.forwardWithRetry(w, r, target.ProviderID, target.Model, path, bodyBytes, parsed, isStream, msgCount, comboLabel, "", entryFormat, ""); ok {
				return
			}
		}
		writeError(w, http.StatusBadGateway, fmt.Sprintf("all keys exhausted for combo: %s", comboName))
	default:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown combo strategy: %s", plan.Strategy))
	}
}

func (h *Handler) forwardWithRetry(w http.ResponseWriter, r *http.Request, providerID, upstreamModel, path string, bodyBytes []byte, parsed map[string]any, isStream bool, msgCount int, logLabel, providerName string, entryFormat combo.EntryFormat, originalModel string) (bool, string) {
	state := &retryState{maxRetries: h.maxRetries()}

	cfgProvider, _ := h.reg.GetProvider(providerID)
	if isStream && cfgProvider != nil && cfgProvider.InjectStreamOpts {
		if _, ok := parsed["stream_options"]; !ok {
			parsed["stream_options"] = map[string]any{"include_usage": true}
		}
	}

	for {
		sel, err := h.selector.SelectKey(providerID, upstreamModel, state.excludeKeyIDs)
		if err != nil {
			dispName := providerID
			if cfgProvider != nil && cfgProvider.Name != "" {
				dispName = cfgProvider.Name
			}
			h.logger.Error("no available keys for %s/%s: %v", dispName, upstreamModel, err)
			return false, ""
		}

		// Track in-flight: mark key as in-use immediately after selection.
		keyState := h.reg.GetKeyState(providerID, sel.Key.ID)
		if keyState != nil {
			keyState.IncInFlight()
		}

		if !state.requestLogged {
			h.logRequest(sel, logLabel, providerName, upstreamModel, originalModel, msgCount, state)
		}

		// NIM min_interval: wait if too soon since last send on this key.
		if cfgProvider != nil && h.selector.IsNIMEnabled(providerID, upstreamModel) {
			if wait := h.selector.WaitNIMInterval(providerID, sel.Key.ID, upstreamModel); wait > 0 {
				h.logger.Debug("NIM min_interval wait %v for key %s", wait, sel.Key.Name)
				select {
				case <-r.Context().Done():
					h.logger.Debug("client canceled during NIM wait")
					return false, ""
				case <-time.After(wait):
				}
			}
		}

		parsed["model"] = upstreamModel
		ensureToolCallIDs(parsed)
		if cfgProvider != nil && cfgProvider.IsGeminiOpenAICompat() {
			backfillThoughtSignatures(parsed, h.sigCache)
		}
		upstreamBody, err := json.Marshal(parsed)
		if err != nil {
			h.logger.Error("failed to marshal upstream body: %v", err)
			writeError(w, http.StatusInternalServerError, "internal marshalling error")
			return false, ""
		}
		h.logger.Debug("SEND %s | %s | body=%dB", sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.reg), len(upstreamBody))

		// Create a processing usage entry now that we are about to forward the
		// request. This gives the UI an immediate "request-start" signal so
		// the recent-requests list shows the entry the moment it arrives.
		reqID := generateRequestID()
		processingEntry := usage.Entry{
			ID:            reqID,
			Timestamp:     time.Now(),
			Provider:      sel.Provider.Name,
			Model:         upstreamModel,
			OriginalModel: originalModel,
			KeyID:         sel.Key.ID,
			KeyName:       sel.KeyName,
			Status:        "processing",
			Source:        r.Header.Get("X-TinyRouter-Source"),
			InputTokens:   len(bodyBytes) / 4, // rough estimate for live UI
		}
		upstreamURL := BuildUpstreamURL(sel.Provider.BaseURL, path)
		if len(bodyBytes) > 0 {
			rb := bodyBytes
			if !json.Valid(rb) {
				rb, _ = json.Marshal(map[string]string{"raw": string(rb)})
			}
			processingEntry.ReqPayload = append([]byte(nil), rb...)
		}
		processingEntry.ReqHeaders = r.Header.Clone()
		processingEntry.UpstreamURL = upstreamURL
		h.EntryTracker.Register(processingEntry)
		h.broadcastRequestStart(reqID, processingEntry)

		// Delayed keep-alive: for non-streaming requests, only start flushing
		// whitespace bytes after a grace period (keepAliveDelay). This allows
		// quick failures (429, 5xx, network errors) to return the correct HTTP
		// status code. If the upstream takes longer than the grace period, the
		// keep-alive bytes commit a 200 status and subsequent errors are written
		// in the body (acceptable trade-off for genuinely long-running requests).
		keepAliveDelay := 20 * time.Second
		keepAliveInterval := 5 * time.Second
		keepAliveDone := make(chan struct{})
		keepAliveStopped := make(chan struct{})
		if !isStream {
			go func() {
				defer close(keepAliveStopped)
				timer := time.NewTimer(keepAliveDelay)
				defer timer.Stop()
				ticker := time.NewTicker(keepAliveInterval)
				defer ticker.Stop()
				flusher, _ := w.(http.Flusher)
				for {
					select {
					case <-keepAliveDone:
						return
					case <-r.Context().Done():
						return
					case <-timer.C:
						// Grace period elapsed: flush headers + first keep-alive byte.
						if !state.headersFlushed {
							state.headersFlushed = true
							w.Header().Set("Content-Type", "application/json")
							if sel != nil {
								w.Header().Set("X-TinyRouter-Provider", sel.Provider.Name)
								w.Header().Set("X-TinyRouter-Key", sel.KeyName)
							}
							w.Write([]byte("\n"))
							if flusher != nil {
								flusher.Flush()
							}
						}
					case <-ticker.C:
						if state.headersFlushed {
							if _, err := w.Write([]byte(" ")); err != nil {
								return
							}
							if flusher != nil {
								flusher.Flush()
							}
						}
					}
				}
			}()
		}

		startTime := time.Now()
		resp, err := h.forwardUpstream(r.Context(), sel, upstreamBody, r.Header, isStream, path, entryFormat)

		// Stop the keep-alive goroutine and wait for it to exit before writing
		// the response body, to avoid concurrent writes to the ResponseWriter.
		if !isStream {
			close(keepAliveDone)
			<-keepAliveStopped
		}

		if err != nil {
			h.handleNetworkError(sel, providerID, upstreamModel, err, state, reqID, upstreamBody, r.Header, upstreamURL, originalModel)
			h.EntryTracker.Remove(reqID)
			// DecInFlight before continue — cannot use defer in for loop (would
			// accumulate across retry iterations).
			if keyState != nil {
				keyState.DecInFlight()
			}
			h.InflightUpdates.Signal()
			continue
		}

		if resp.StatusCode == 429 {
			h.handle429(resp, sel, providerID, upstreamModel, startTime, state, r, reqID, upstreamBody, upstreamURL, originalModel)
			h.EntryTracker.Remove(reqID)
			if keyState != nil {
				keyState.DecInFlight()
			}
			h.InflightUpdates.Signal()
			continue
		}

		if resp.StatusCode >= 400 {
			h.handleUpstreamError(resp, sel, providerID, upstreamModel, state, r, reqID, upstreamBody, upstreamURL, startTime, originalModel)
			h.EntryTracker.Remove(reqID)
			if keyState != nil {
				keyState.DecInFlight()
			}
			h.InflightUpdates.Signal()
			continue
		}

		// 2xx success
		h.selector.ClearError(providerID, sel.Key.ID, upstreamModel)

		// Parse rate-limit headers and update key quota state
		h.parseAndUpdateQuota(sel, providerID, upstreamModel, resp.Header)

		// NIM: track request count and rotate if limit reached.
		if cfgProvider != nil && h.selector.IsNIMEnabled(providerID, upstreamModel) {
			h.selector.OnNIMRequestSuccess(providerID, sel.Key.ID, upstreamModel)
		}

		maskedURL := maskURL(sel.Provider.BaseURL)
		dspModel := resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.reg)
		h.logger.Info("PROXY %s | %s | conn=%s | url=%s", sel.Provider.Name, dspModel, sel.KeyName, maskedURL)

		latencyMs := time.Since(startTime).Milliseconds()

		if isStream {
			h.EntryTracker.SetTTFT(reqID, latencyMs)
			h.broadcastTTFT(reqID, latencyMs)
			normalize := cfgProvider != nil && cfgProvider.NormalizeStreamChunks
			h.streamResponse(w, resp, upstreamModel, sel, latencyMs, bodyBytes, normalize, reqID, r.Header, upstreamURL, entryFormat, originalModel)
		} else {
			h.passThroughResponse(w, resp, upstreamModel, sel, latencyMs, bodyBytes, reqID, r.Header, upstreamURL, state.headersFlushed, originalModel)
		}
		h.EntryTracker.Remove(reqID)
		// DecInFlight after the synchronous response handling completes — this
		// key is no longer "in-use". Cannot use defer (see above).
		if keyState != nil {
			keyState.DecInFlight()
		}
		h.InflightUpdates.Signal()
		return true, reqID
	}
}

func (h *Handler) broadcastRequestStart(id string, entry usage.Entry) {
	raw := MarshalEntryJSON(entry)
	if raw == nil {
		return
	}
	h.RequestUpdates.Broadcast(RequestEvent{
		Type:  "request-start",
		ID:    id,
		Entry: raw,
	})
}

func (h *Handler) broadcastTTFT(id string, ttftMs int64) {
	raw, err := json.Marshal(struct {
		TTFTMs int64 `json:"ttftMs"`
	}{ttftMs})
	if err != nil {
		return
	}
	h.RequestUpdates.Broadcast(RequestEvent{
		Type:  "request-ttft",
		ID:    id,
		Entry: raw,
	})
}

func (h *Handler) broadcastTokens(id string, input, output int) {
	raw, err := json.Marshal(struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	}{input, output})
	if err != nil {
		return
	}
	h.RequestUpdates.Broadcast(RequestEvent{
		Type:  "request-tokens",
		ID:    id,
		Entry: raw,
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "proxy_error",
		},
	})
}

func maskURL(url string) string {
	if len(url) <= 20 {
		return url
	}
	return url[:20] + "..."
}

// backfillThoughtSignatures injects the cached Gemini thought_signature into
// assistant tool_calls that are missing it, keyed by tool_call id. Google
// rejects tool-call round trips whose tool_calls lack the signature that was
// returned in the prior response; the proxy caches those signatures as it
// streams the first response and replays them here. Existing signatures are
// never overwritten; cache misses are silently skipped (best-effort).
func backfillThoughtSignatures(parsed map[string]any, cache SignatureCacheProvider) {
	msgs, ok := parsed["messages"].([]any)
	if !ok {
		return
	}
	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		if role != "assistant" {
			continue
		}
		toolCalls, ok := msg["tool_calls"].([]any)
		if !ok || len(toolCalls) == 0 {
			continue
		}
		for _, tc := range toolCalls {
			tcm, ok := tc.(map[string]any)
			if !ok {
				continue
			}
			id, _ := tcm["id"].(string)
			if id == "" {
				continue
			}
			if hasThoughtSignature(tcm) {
				continue
			}
			sig, ok := cache.Get(id)
			if !ok || sig == "" {
				continue
			}
			tcm["extra_content"] = map[string]any{
				"google": map[string]any{
					"thought_signature": sig,
				},
			}
		}
	}
}

func hasThoughtSignature(tc map[string]any) bool {
	extra, ok := tc["extra_content"].(map[string]any)
	if !ok {
		return false
	}
	google, ok := extra["google"].(map[string]any)
	if !ok {
		return false
	}
	sig, ok := google["thought_signature"].(string)
	return ok && sig != ""
}
