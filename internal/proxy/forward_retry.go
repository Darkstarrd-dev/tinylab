package proxy

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func (h *Handler) forwardWithRetry(w http.ResponseWriter, r *http.Request, providerID, upstreamModel, path string, bodyBytes []byte, parsed map[string]any, isStream bool, msgCount int, logLabel, providerName string, entryFormat combo.EntryFormat, originalModel string, sessionKey string) (bool, string) {
	state := &retryState{maxRetries: h.maxRetries()}

	// Per-target working copy: combo fallback passes the SAME parsed map to
	// every target's forwardWithRetry, and the loop below rewrites it
	// (model, stream_options, tool_call ids, Gemini thought signatures).
	// Without a copy those rewrites leak into the next target — e.g. a
	// Gemini target's backfilled extra_content would be forwarded to a
	// non-Gemini upstream. The copy is made once per forwardWithRetry call,
	// so retries within this call share it (mutations persist across retries
	// as before). A plain shallow copy would not suffice: the rewrites touch
	// nested maps/slices inside messages.
	if parsed != nil {
		parsed = cloneJSONValue(parsed).(map[string]any)
	}

	// reqID is per-forwardWithRetry (shared across retries) so the console can
	// correlate the REQUEST/SEND/PROXY/error lines of one client request, and the
	// EntryTracker entry reuses the same id across retries.
	reqID := generateRequestID()
	callerTag := requestCallerTag(r)
	// logTag is reqID augmented with the inferred session key (|sess:xxxxxxxx)
	// for console log lines, so concurrent sessions can be told apart. reqID
	// itself stays bare for entry tracking / recordUsage IDs.
	logTag := reqLogTag(reqID, sessionKey)

	cfgProvider, _ := h.providers.GetProvider(providerID)
	dispName := providerID
	if cfgProvider != nil && cfgProvider.Name != "" {
		dispName = cfgProvider.Name
	}
	if isStream && cfgProvider != nil && cfgProvider.InjectStreamOpts {
		if _, ok := parsed["stream_options"]; !ok {
			parsed["stream_options"] = map[string]any{"include_usage": true}
		}
	}

	for {
		sel, err := h.keySel.SelectKey(providerID, upstreamModel, state.excludeKeyIDs)
		if err != nil {
			// All available keys are momentarily unavailable. Before returning an
			// instant 502 (which bursts for every concurrent request during the
			// cooldown window), check whether the unavailable keys are only
			// cooling down — if so, wait for the soonest cooldown to expire (capped)
			// and retry SelectKey once more. Excluded keys are skipped: they
			// already failed this request, waiting for their lock won't help.
			if info, ok := h.cooldown.SonestCooldown(providerID, upstreamModel, state.excludeKeyIDs); ok {
				wait := time.Until(info.Deadline)
				if wait > 30*time.Second {
					wait = 30 * time.Second
				}
				reason := info.Reason
				if reason == "" {
					reason = "上游错误冷却"
				}
				if wait > 0 {
					h.logger.Warn("[%s] %s/%s: 所有可用 key 冷却中（Key %s 原因: %s，%s 后到期）→ 等待恢复后重试", logTag, dispName, upstreamModel, info.KeyName, reason, wait.Round(time.Second))
					select {
					case <-r.Context().Done():
						h.logger.Debug("[%s] client canceled during cooldown wait", logTag)
						return false, ""
					case <-time.After(wait):
					}
				}
				sel, err = h.keySel.SelectKey(providerID, upstreamModel, state.excludeKeyIDs)
			}
			if err != nil {
				if callerTag != "" {
					h.logger.Error("[%s] %s: no available keys for %s/%s（所有 key 已耗尽，返回 502）| %s", logTag, callerTag, dispName, upstreamModel, callerTag)
				} else {
					h.logger.Error("[%s] no available keys for %s/%s（所有 key 已耗尽，返回 502）", logTag, dispName, upstreamModel)
				}
				return false, ""
			}
		}

		// Track in-flight: mark key as in-use immediately after selection.
		keyState := h.keyState.GetKeyState(providerID, sel.Key.ID)
		if keyState != nil {
			keyState.IncInFlight()
		}

		if !state.requestLogged {
			h.logRequest(sel, logLabel, providerName, upstreamModel, originalModel, msgCount, state, reqID, callerTag, sessionKey)
		}

		// NIM min_interval: wait if too soon since last send on this key.
		if cfgProvider != nil && h.nim.IsNIMEnabled(providerID, upstreamModel) {
			if wait := h.nim.WaitNIMInterval(providerID, sel.Key.ID, upstreamModel); wait > 0 {
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
		h.logger.Debug("[%s] SEND %s | %s | body=%dB", logTag, sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.aliases), len(upstreamBody))

		// Create a processing usage entry now that we are about to forward the
		// request. This gives the UI an immediate "request-start" signal so
		// the recent-requests list shows the entry the moment it arrives.
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
			SessionKey:    sessionKey,
			InputTokens:   len(bodyBytes) / 4, // rough estimate for live UI
		}
		upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, path)
		if len(bodyBytes) > 0 {
			rb := bodyBytes
			if !json.Valid(rb) {
				rb, _ = json.Marshal(map[string]string{"raw": string(rb)})
			}
			processingEntry.ReqPayload = append([]byte(nil), rb...)
		}
		processingEntry.ReqHeaders = maskHeaderMap(r.Header)
		processingEntry.UpstreamURL = upstreamURL
		h.EntryTracker.Register(processingEntry)
		h.broadcastRequestStart(reqID, processingEntry)

		// NOTE: a non-streaming keep-alive byte-flush goroutine used to live here.
		// It wrote "\n" + Flush after a 20s grace period, which implicitly committed
		// HTTP 200 and silently broke the 502 status when all keys exhausted (H-8).
		// It was removed: no bytes are written to w until the final response, so
		// writeError's WriteHeader(502) always takes effect. The server's WriteTimeout
		// (config.ServerConfig.WriteTimeoutSec, default 300s) still caps non-streaming
		// responses; clients with short read timeouts must set an adequate timeout.

		startTime := time.Now()
		resp, err := h.forwardUpstream(r.Context(), sel, upstreamBody, r.Header, isStream, path, entryFormat)

		if err != nil {
			h.handleNetworkError(sel, providerID, upstreamModel, err, state, reqID, upstreamBody, r.Header, upstreamURL, originalModel, sessionKey)
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
			h.handle429(resp, sel, providerID, upstreamModel, startTime, state, r, reqID, upstreamBody, upstreamURL, originalModel, sessionKey)
			h.EntryTracker.Remove(reqID)
			if keyState != nil {
				keyState.DecInFlight()
			}
			h.InflightUpdates.Signal()
			continue
		}

		if resp.StatusCode >= 400 {
			written := h.handleUpstreamError(w, resp, sel, providerID, upstreamModel, state, r, reqID, upstreamBody, upstreamURL, startTime, originalModel, sessionKey)
			if written {
				// Pass-through: the upstream 4xx error was already written to the
				// client as-is. Stop retrying and return success-ish so the caller
				// does NOT also writeError(502). The key is healthy — do not lock
				// or exclude it.
				h.EntryTracker.Remove(reqID)
				if keyState != nil {
					keyState.DecInFlight()
				}
				h.InflightUpdates.Signal()
				return true, reqID
			}
			h.EntryTracker.Remove(reqID)
			if keyState != nil {
				keyState.DecInFlight()
			}
			h.InflightUpdates.Signal()
			continue
		}

		// 2xx success
		h.cooldown.ClearError(providerID, sel.Key.ID, upstreamModel)

		// Parse rate-limit headers and update key quota state
		h.parseAndUpdateQuota(sel, providerID, upstreamModel, resp.Header)

		// NIM: track request count and rotate if limit reached.
		if cfgProvider != nil && h.nim.IsNIMEnabled(providerID, upstreamModel) {
			h.nim.OnNIMRequestSuccess(providerID, sel.Key.ID, upstreamModel)
		}

		maskedURL := maskURL(sel.Provider.BaseURL)
		dspModel := resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.aliases)
		h.logger.Info("[%s] PROXY %s | %s | conn=%s | url=%s", logTag, sel.Provider.Name, dspModel, sel.KeyName, maskedURL)

		latencyMs := time.Since(startTime).Milliseconds()

		if isStream {
			h.EntryTracker.SetTTFT(reqID, latencyMs)
			h.broadcastTTFT(reqID, latencyMs)
			normalize := cfgProvider != nil && cfgProvider.NormalizeStreamChunks
			h.streamResponse(w, resp, upstreamModel, sel, latencyMs, bodyBytes, normalize, reqID, r.Header, upstreamURL, entryFormat, originalModel, sessionKey)
		} else {
			h.passThroughResponse(w, resp, upstreamModel, sel, latencyMs, bodyBytes, reqID, r.Header, upstreamURL, originalModel, sessionKey)
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
