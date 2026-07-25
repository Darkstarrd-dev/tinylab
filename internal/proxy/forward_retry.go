package proxy

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

func (h *Handler) forwardWithRetry(w http.ResponseWriter, r *http.Request, providerID, upstreamModel, path string, bodyBytes []byte, parsed map[string]any, isStream bool, msgCount int, logLabel, providerName string, entryFormat combo.EntryFormat, originalModel string) (bool, string) {
	state := &retryState{maxRetries: h.maxRetries()}

	cfgProvider, _ := h.providers.GetProvider(providerID)
	if isStream && cfgProvider != nil && cfgProvider.InjectStreamOpts {
		if _, ok := parsed["stream_options"]; !ok {
			parsed["stream_options"] = map[string]any{"include_usage": true}
		}
	}

	for {
		sel, err := h.keySel.SelectKey(providerID, upstreamModel, state.excludeKeyIDs)
		if err != nil {
			dispName := providerID
			if cfgProvider != nil && cfgProvider.Name != "" {
				dispName = cfgProvider.Name
			}
			h.logger.Error("no available keys for %s/%s: %v", dispName, upstreamModel, err)
			return false, ""
		}

		// Track in-flight: mark key as in-use immediately after selection.
		keyState := h.keyState.GetKeyState(providerID, sel.Key.ID)
		if keyState != nil {
			keyState.IncInFlight()
		}

		if !state.requestLogged {
			h.logRequest(sel, logLabel, providerName, upstreamModel, originalModel, msgCount, state)
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
		h.logger.Debug("SEND %s | %s | body=%dB", sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.aliases), len(upstreamBody))

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
		upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, path)
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
		h.cooldown.ClearError(providerID, sel.Key.ID, upstreamModel)

		// Parse rate-limit headers and update key quota state
		h.parseAndUpdateQuota(sel, providerID, upstreamModel, resp.Header)

		// NIM: track request count and rotate if limit reached.
		if cfgProvider != nil && h.nim.IsNIMEnabled(providerID, upstreamModel) {
			h.nim.OnNIMRequestSuccess(providerID, sel.Key.ID, upstreamModel)
		}

		maskedURL := maskURL(sel.Provider.BaseURL)
		dspModel := resolveDisplayModel(sel.Provider.Name, upstreamModel, originalModel, h.aliases)
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
