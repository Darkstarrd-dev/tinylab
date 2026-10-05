package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/logredact"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/urlutil"
	"github.com/tinylab/tinylab/internal/usage"
)

// errNoKeysAvailable is the terminal outcome when SelectKey has exhausted
// every candidate key for this request: forwardWithRetry already recorded the
// visible failure (recordNoKeyFailure) and the caller writes the final 502.
var errNoKeysAvailable = errors.New("no available keys")

// attemptOutcome tells the retry loop how to proceed after one attempt.
type attemptOutcome int

const (
	// outcomeRetry: the attempt was fully cleaned up; select the next key
	// (the attempt may already have waited / cooled / excluded before
	// returning this).
	outcomeRetry attemptOutcome = iota
	// outcomeStop: stop retrying — the caller decides the final response
	// based on result.written / result.terminal.
	outcomeStop
	// outcomeAbort: the client is gone (context canceled) — exit silently;
	// the caller must not write anything.
	outcomeAbort
)

// attemptResult is the three-state contract of one retry-loop attempt (F-04).
type attemptResult struct {
	next attemptOutcome
	// written marks a response (2xx success, upstream pass-through 4xx, or a
	// terminal 500/503 written by the loop itself) as already committed to
	// the client; the caller must not write anything on top of it.
	written bool
	// terminal carries the terminal error for the caller when the loop stops
	// without having written a response (currently errNoKeysAvailable only).
	terminal error
}

// attemptContext bundles everything one retry-loop attempt needs: the
// per-forwardWithRetry inputs (F-04: the former 14-parameter thread-through),
// the shared per-call state, and the per-attempt inject/strip dance flags.
type attemptContext struct {
	h *Handler

	// immutable per forwardWithRetry call
	providerID    string
	upstreamModel string
	path          string
	bodyBytes     []byte
	parsed        map[string]any
	isStream      bool
	msgCount      int
	logLabel      string
	providerName  string
	entryFormat   combo.EntryFormat
	originalModel string
	sessionKey    string
	reqID         string
	logTag        string
	callerTag     string
	dispName      string
	cfgProvider   *config.Provider

	// mutable across attempts
	state *retryState
	// injectedStreamOpts/streamOptsStripped implement the include_usage
	// inject-once / strip-once dance (see forwardWithRetry preamble).
	injectedStreamOpts bool
	streamOptsStripped bool
}

// forwardWithRetry resolves one provider/model target to a client response,
// retrying across keys until success, terminal failure, or client cancel.
//
// Return contract (three states, F-04):
//   - (true, reqID): a response was written to w (2xx pass/stream, upstream
//     pass-through 4xx, or an internal terminal 500/503 written by the loop
//     itself) — the caller must not write anything else.
//   - (false, ""): the client is gone; stay silent (no 502, no further work).
//   - (false, reqID): all keys were exhausted (the loop already recorded the
//     visible no-key failure); the caller writes the final 502.
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
	defer h.clearAttemptCount(reqID)
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

	at := &attemptContext{
		h:             h,
		providerID:    providerID,
		upstreamModel: upstreamModel,
		path:          path,
		bodyBytes:     bodyBytes,
		parsed:        parsed,
		isStream:      isStream,
		msgCount:      msgCount,
		logLabel:      logLabel,
		providerName:  providerName,
		entryFormat:   entryFormat,
		originalModel: originalModel,
		sessionKey:    sessionKey,
		reqID:         reqID,
		logTag:        logTag,
		callerTag:     callerTag,
		dispName:      dispName,
		cfgProvider:   cfgProvider,
		state:         state,
	}

	// Inject stream_options.include_usage so upstreams that support it report
	// real token usage at stream end — without it the Recent output column
	// stays 0 for gateways that only emit usage in the terminal chunk.
	// OpenAI-format streams get it by default (most gateways accept it); the
	// provider-level InjectStreamOpts flag forces it for any format. If the
	// upstream rejects the injected field with 400/422, it is stripped and the
	// request retried once without it (see the 400 branch in forwardAttempt).
	if isStream && cfgProvider != nil && (cfgProvider.InjectStreamOpts || entryFormat == combo.EntryFormatOpenAI) {
		if _, ok := parsed["stream_options"]; !ok {
			parsed["stream_options"] = map[string]any{"include_usage": true}
			at.injectedStreamOpts = true
		}
	}

	for {
		// Client cancellation is not a key failure (F-01): exit silently —
		// no cooldown, no exclusion, no spurious error record. Nothing is
		// held between attempts: forwardAttempt releases the key in-flight
		// counter and the entry tracker slot via defer on every exit path.
		if r.Context().Err() != nil {
			h.logger.Debug("[%s] client canceled, stop retry loop", logTag)
			return false, ""
		}
		res := h.forwardAttempt(at, w, r)
		switch res.next {
		case outcomeRetry:
			continue
		case outcomeAbort:
			return false, ""
		case outcomeStop:
			if res.written {
				// Response already on the wire (2xx, pass-through 4xx, or the
				// loop's own terminal 500/503) — report success so callers
				// (combo fallback, handleProxy) neither retry the next target
				// nor stack a 502 on the committed response.
				return true, reqID
			}
			if errors.Is(res.terminal, errNoKeysAvailable) {
				return false, reqID
			}
			// Unreachable by construction; fail loudly rather than hang.
			h.logger.Error("[%s] attempt stopped without a response: %v", logTag, res.terminal)
			writeProxyError(w, reqID, nil, http.StatusBadGateway, "internal retry state error")
			return false, reqID
		}
	}
}

// selectKey picks a key for this attempt, waiting out the soonest cooldown
// (capped) once when every candidate is only cooling down. Returns nil sel
// with a terminal result when the request must end: silent abort on client
// cancel during the wait, or the recorded no-key failure on exhaustion.
func (at *attemptContext) selectKey(r *http.Request) (*rotation.SelectedKey, attemptResult) {
	sel, err := at.h.keySel.SelectKey(at.providerID, at.upstreamModel, at.state.excludeKeyIDs)
	if err == nil {
		return sel, attemptResult{next: outcomeRetry}
	}
	// All available keys are momentarily unavailable. Before returning an
	// instant 502 (which bursts for every concurrent request during the
	// cooldown window), check whether the unavailable keys are only
	// cooling down — if so, wait for the soonest cooldown to expire (capped)
	// and retry SelectKey once more. Excluded keys are skipped: they
	// already failed this request, waiting for their lock won't help.
	if info, ok := at.h.cooldown.SonestCooldown(at.providerID, at.upstreamModel, at.state.excludeKeyIDs); ok {
		wait := time.Until(info.Deadline)
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
		reason := info.Reason
		if reason == "" {
			reason = "上游错误冷却"
		}
		if wait > 0 {
			at.h.logger.Warn("[%s] %s/%s: 所有可用 key 冷却中（Key %s 原因: %s，%s 后到期）→ 等待恢复后重试", at.logTag, at.dispName, at.upstreamModel, info.KeyName, reason, wait.Round(time.Second))
			select {
			case <-r.Context().Done():
				at.h.logger.Debug("[%s] client canceled during cooldown wait", at.logTag)
				return nil, attemptResult{next: outcomeAbort}
			case <-time.After(wait):
			}
		}
		sel, err = at.h.keySel.SelectKey(at.providerID, at.upstreamModel, at.state.excludeKeyIDs)
	}
	if err != nil {
		if at.callerTag != "" {
			at.h.logger.Error("[%s] %s: no available keys for %s/%s（所有 key 已耗尽，返回 502）| %s", at.logTag, at.callerTag, at.dispName, at.upstreamModel, at.callerTag)
		} else {
			at.h.logger.Error("[%s] no available keys for %s/%s（所有 key 已耗尽，返回 502）", at.logTag, at.dispName, at.upstreamModel)
		}
		// Record the terminal failure so the request stays visible in
		// Monitor/Playground (with its error) instead of leaving only a
		// bare 502 body. No key was selected, so the entry carries no
		// key identity; the response still advertises the request ID.
		at.h.recordNoKeyFailure(at.reqID, at.dispName, at.upstreamModel, "no available keys (all keys exhausted)", r.Header, at.sessionKey)
		return nil, attemptResult{next: outcomeStop, terminal: errNoKeysAvailable}
	}
	return sel, attemptResult{next: outcomeRetry}
}

// forwardAttempt performs exactly one retry-loop attempt: key selection,
// request shaping, the upstream call, and full response/error handling.
// The per-attempt resources (key in-flight counter, EntryTracker entry) are
// released by a single defer — every return path below is leak-free by
// construction (F-04: the former ten hand-written Remove+DecInFlight+Signal
// triples, one of which — the marshal-failure branch — was missing its
// DecInFlight entirely).
func (h *Handler) forwardAttempt(at *attemptContext, w http.ResponseWriter, r *http.Request) attemptResult {
	sel, res := at.selectKey(r)
	if sel == nil {
		return res
	}
	keyState := at.h.keyState.GetKeyState(at.providerID, sel.Key.ID)
	if keyState != nil {
		keyState.IncInFlight()
	}
	// F-04: unified per-attempt finalization. Runs after the synchronous
	// stream/pass-through handling on success, and on every early return —
	// including the pre-entry-registration paths, where Remove is a no-op.
	defer func() {
		at.h.EntryTracker.Remove(at.reqID)
		if keyState != nil {
			keyState.DecInFlight()
		}
		at.h.InflightUpdates.Signal()
	}()

	if !at.state.requestLogged {
		at.h.logRequest(sel, at.logLabel, at.providerName, at.upstreamModel, at.originalModel, at.msgCount, at.state, at.reqID, at.callerTag, at.sessionKey)
	}

	// Provider hard limit: sliding-window RPM/TPM throttling before send.
	if at.cfgProvider != nil && at.cfgProvider.HardLimit != nil {
		hl := at.cfgProvider.HardLimit
		var rpm, tpm int
		if hl.RPMEnabled && hl.RPM > 0 {
			rpm = hl.RPM
		}
		if hl.TPMEnabled && hl.TPM > 0 {
			tpm = hl.TPM
		}
		if rpm > 0 || tpm > 0 {
			est := len(at.bodyBytes) / 4 // same rough estimate as processingEntry.InputTokens
			if !at.h.hardLimit.WaitAndReserve(r.Context(), at.providerID, at.reqID, rpm, tpm, est) {
				at.h.logger.Debug("[%s] client canceled during hard-limit wait", at.logTag)
				// Entry not yet registered at this point (registered after
				// hardLimit/NIM) — the defer only releases the key counter.
				return attemptResult{next: outcomeAbort}
			}
		}
	}

	// NIM min_interval: wait if too soon since last send on this key.
	if at.cfgProvider != nil && at.h.nim.IsNIMEnabled(at.providerID, at.upstreamModel) {
		if wait := at.h.nim.WaitNIMInterval(at.providerID, sel.Key.ID, at.upstreamModel); wait > 0 {
			at.h.logger.Debug("NIM min_interval wait %v for key %s", wait, sel.Key.Name)
			select {
			case <-r.Context().Done():
				at.h.logger.Debug("client canceled during NIM wait")
				return attemptResult{next: outcomeAbort}
			case <-time.After(wait):
			}
		}
	}

	at.parsed["model"] = at.upstreamModel
	ensureToolCallIDs(at.parsed)
	if at.cfgProvider != nil && at.cfgProvider.IsGeminiOpenAICompat() {
		backfillThoughtSignatures(at.parsed, at.h.sigCache)
	}
	upstreamBody := at.bodyBytes
	effectivePath := at.path
	effectiveFormat := at.entryFormat
	compat := false
	if at.cfgProvider != nil {
		for _, mm := range at.cfgProvider.Models {
			if mm.ID == at.upstreamModel && mm.ChatResponsesCompat {
				compat = true
				break
			}
		}
	}
	if rewritten, rp, ok := maybeRewriteChatVisionToResponses(nil, at.path, at.parsed, at.upstreamModel, compat); ok {
		upstreamBody = rewritten
		effectivePath = rp
		if rp == "/v1/responses" {
			effectiveFormat = combo.EntryFormatOpenAIResponses
		}
	} else {
		// Not rewritten — marshal the (possibly tool-call-patched) parsed body.
		// This must happen even when bodyBytes is nil (programmatic callers
		// in tests pass parsed only), otherwise an empty upstream body is sent.
		if at.parsed != nil {
			nb, err := json.Marshal(at.parsed)
			if err != nil {
				at.h.logger.Error("failed to marshal upstream body: %v", err)
				// Internal defect, not a key failure: write the terminal 500
				// here (written=true) so the caller neither retries the next
				// combo target nor stacks a 502 on the committed response.
				writeProxyError(w, at.reqID, sel, http.StatusInternalServerError, "internal marshalling error")
				return attemptResult{next: outcomeStop, written: true}
			}
			upstreamBody = nb
		}
	}
	at.h.logger.Debug("[%s] SEND %s | %s | body=%dB", at.logTag, sel.Provider.Name, resolveDisplayModel(sel.Provider.Name, at.upstreamModel, at.originalModel, at.h.aliases), len(upstreamBody))

	// Create a processing usage entry now that we are about to forward the
	// request. This gives the UI an immediate "request-start" signal so
	// the recent-requests list shows the entry the moment it arrives.
	processingEntry := usage.Entry{
		ID:            at.reqID,
		Timestamp:     time.Now(),
		Provider:      sel.Provider.Name,
		ProviderID:    sel.Provider.ID,
		Model:         at.upstreamModel,
		OriginalModel: at.originalModel,
		KeyID:         sel.Key.ID,
		KeyName:       sel.KeyName,
		Status:        "processing",
		Source:        r.Header.Get("X-TinyLab-Source"),
		SessionKey:    at.sessionKey,
		InputTokens:   len(at.bodyBytes) / 4, // rough estimate for live UI
	}
	upstreamURL := urlutil.BuildUpstreamURL(sel.Provider.BaseURL, effectivePath)
	credential := sel.Key.Key
	if len(at.bodyBytes) > 0 {
		rb := []byte(logredact.MaskString(string(at.bodyBytes), credential))
		processingEntry.ReqPayload = captureBody(rb)
	}
	processingEntry.ReqHeaders = http.Header(at.h.maskHeaderMap(r.Header, credential))
	processingEntry.UpstreamURL = redactURL(upstreamURL, credential)
	at.h.EntryTracker.Register(processingEntry)
	at.h.broadcastRequestStart(at.reqID, processingEntry)

	// NOTE: a non-streaming keep-alive byte-flush goroutine used to live here.
	// It wrote "\n" + Flush after a 20s grace period, which implicitly committed
	// HTTP 200 and silently broke the 502 status when all keys exhausted (H-8).
	// It was removed: no bytes are written to w until the final response, so
	// writeError's WriteHeader(502) always takes effect. The server's WriteTimeout
	// (config.ServerConfig.WriteTimeoutSec, default 300s) still caps non-streaming
	// responses; clients with short read timeouts must set an adequate timeout.

	startTime := time.Now()
	// Carry the original client request through the context so the bridged
	// provider augmenter (APIType=="jethub") can read client headers inside
	// forwardUpstream without changing its signature.
	fwdCtx := WithClientRequest(r.Context(), r)
	resp, err := at.h.forwardUpstream(fwdCtx, sel, upstreamBody, r.Header, at.isStream, effectivePath, effectiveFormat, at.upstreamModel)
	// Bridged providers may override the outbound URL (Manager.Customize —
	// WASM-computed encrypted endpoints, provider-private inference paths).
	// net/http records the request that produced the response, so use it
	// for the trace/monitor URL: otherwise the recorded URL is the
	// pre-Customize guess that was never actually requested (the raccoon
	// 405 / minimax 404 traces showed a fabricated URL, which cost a
	// diagnosis round).
	if resp != nil && resp.Request != nil && resp.Request.URL != nil && resp.Request.URL.Host != "" {
		upstreamURL = resp.Request.URL.String()
	}
	if err != nil {
		// Client cancellation surfaces here as a Do error (context
		// canceled). It says nothing about key health (F-01): silent exit —
		// no cooldown, no exclusion, no error record; the defer releases
		// the key and the entry.
		if r.Context().Err() != nil {
			at.h.logger.Debug("[%s] client canceled, upstream request aborted", at.logTag)
			return attemptResult{next: outcomeAbort}
		}
		// Server-specified queue delay (e.g. Qoder 10605): wait and resend
		// with the SAME key. Not a key failure — no cooldown, no
		// exclusion. Attempts are capped (10s cap × 180 ≈ 30min).
		var qre *QueueRetryError
		if errors.As(err, &qre) {
			at.state.queueAttempts++
			if at.state.queueAttempts > maxQueueAttempts {
				writeProxyError(w, at.reqID, sel, http.StatusServiceUnavailable, fmt.Sprintf("upstream queue timeout (%d attempts)", maxQueueAttempts))
				// Our retry budget is exhausted: this 503 is the final
				// response (written=true) — the caller must not add a 502.
				return attemptResult{next: outcomeStop, written: true}
			}
			wait := qre.RetryAfter
			if wait <= 0 {
				wait = time.Second
			}
			at.h.logger.Warn("[%s] %s/%s: 排队中（服务端要求等 %s，第 %d 次）→ 等待后重试同一 Key", at.logTag, at.dispName, at.upstreamModel, wait, at.state.queueAttempts)
			select {
			case <-r.Context().Done():
				at.h.logger.Debug("[%s] client canceled during queue wait", at.logTag)
				return attemptResult{next: outcomeAbort}
			case <-time.After(wait):
			}
			return attemptResult{next: outcomeRetry}
		}
		// Bridge-applied same-key retry (e.g. CodeArts 4004.200: drop the
		// rejected `maas_type` header once and resend). The error carries
		// the header name; write it into the loopback marker on the shared
		// client request so the bridge's augmenter omits it on the next
		// attempt (and its interceptor can tell "already retried").
		// Immediate, same key, no exclusion.
		var skre *SameKeyRetryError
		if errors.As(err, &skre) {
			at.state.sameKeyRetries++
			if at.state.sameKeyRetries > maxSameKeyRetries {
				at.h.logger.Error("[%s] %s/%s: same-key retry limit exceeded (%d)", at.logTag, at.dispName, at.upstreamModel, maxSameKeyRetries)
				writeProxyError(w, at.reqID, sel, http.StatusServiceUnavailable, fmt.Sprintf("upstream retry limit exceeded (%d attempts)", maxSameKeyRetries))
				return attemptResult{next: outcomeStop, written: true}
			}
			if skre.Header != "" {
				r.Header.Set(RetryDropHeaderMarker, skre.Header)
			}
			at.h.logger.Warn("[%s] %s/%s: 上游拒绝后同 Key 重发（丢弃 %s，第 %d 次）: %s", at.logTag, at.dispName, at.upstreamModel, skre.Header, at.state.sameKeyRetries, skre.Reason)
			return attemptResult{next: outcomeRetry}
		}
		// Per-model quota exhaustion on this key (e.g. Qoder billing 110):
		// lock key+model until the business-defined instant (UTC+8 day end
		// for Qoder) and switch to the next key.
		var ble *BillingLockError
		if errors.As(err, &ble) {
			until := ble.Until
			if until.IsZero() {
				until = time.Now().Add(time.Hour)
			}
			at.h.logger.Warn("[%s] %s/%s: Key %s 额度受限（%s）→ 标记至 %s 后切换", at.logTag, at.dispName, at.upstreamModel, sel.KeyName, ble.Error(), until.Format("15:04:05"))
			at.h.cooldown.MarkRateLimited(at.providerID, sel.Key.ID, at.upstreamModel, time.Until(until))
			at.state.excludeKeyIDs = append(at.state.excludeKeyIDs, sel.Key.ID)
			return attemptResult{next: outcomeRetry}
		}
		at.h.handleNetworkError(sel, at.providerID, at.upstreamModel, err, at.state, at.reqID, upstreamBody, r.Header, upstreamURL, at.originalModel, at.sessionKey)
		return attemptResult{next: outcomeRetry}
	}

	if resp.StatusCode == 429 {
		at.h.handle429(resp, sel, at.providerID, at.upstreamModel, startTime, at.state, r, at.reqID, upstreamBody, upstreamURL, at.originalModel, at.sessionKey)
		return attemptResult{next: outcomeRetry}
	}

	if resp.StatusCode >= 400 {
		// Fallback: some upstreams (older OpenAI-compat gateways) reject an
		// injected stream_options.include_usage with 400/422. When we injected
		// it and the upstream rejects the request format, strip the field and
		// retry once before classifying the error — the injected option is a
		// measurement aid, not worth failing the request over.
		if at.injectedStreamOpts && !at.streamOptsStripped && (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity) {
			delete(at.parsed, "stream_options")
			at.streamOptsStripped = true
			at.h.logger.Debug("[%s] upstream rejected injected stream_options (%d) → stripped and retrying once", at.logTag, resp.StatusCode)
			return attemptResult{next: outcomeRetry}
		}
		written := at.h.handleUpstreamError(w, resp, sel, at.providerID, at.upstreamModel, at.state, r, at.reqID, upstreamBody, upstreamURL, startTime, at.originalModel, at.sessionKey)
		if written {
			// Pass-through: the upstream 4xx error was already written to the
			// client as-is. Stop retrying; the key is healthy — do not lock
			// or exclude it.
			return attemptResult{next: outcomeStop, written: true}
		}
		return attemptResult{next: outcomeRetry}
	}

	// 2xx success
	at.h.cooldown.ClearError(at.providerID, sel.Key.ID, at.upstreamModel)

	// Parse rate-limit headers and update key quota state
	at.h.parseAndUpdateQuota(sel, at.providerID, at.upstreamModel, resp.Header)

	// NIM: track request count and rotate if limit reached.
	if at.cfgProvider != nil && at.h.nim.IsNIMEnabled(at.providerID, at.upstreamModel) {
		at.h.nim.OnNIMRequestSuccess(at.providerID, sel.Key.ID, at.upstreamModel)
	}

	maskedURL := logredact.MaskURL(sel.Provider.BaseURL, sel.Key.Key)
	dspModel := resolveDisplayModel(sel.Provider.Name, at.upstreamModel, at.originalModel, at.h.aliases)
	at.h.logger.Info("[%s] PROXY %s | %s | conn=%s | url=%s", at.logTag, sel.Provider.Name, dspModel, sel.KeyName, maskedURL)

	latencyMs := time.Since(startTime).Milliseconds()

	if at.isStream {
		at.h.EntryTracker.SetTTFT(at.reqID, latencyMs)
		at.h.broadcastTTFT(at.reqID, latencyMs)
		if isChatToResponsesRewrite(at.entryFormat, effectivePath) {
			at.h.streamResponsesAsChat(w, resp, at.upstreamModel, sel, latencyMs, at.bodyBytes, at.reqID, r.Header, upstreamURL, at.originalModel, at.sessionKey)
		} else {
			normalize := at.cfgProvider != nil && at.cfgProvider.NormalizeStreamChunks
			at.h.streamResponse(w, resp, at.upstreamModel, sel, latencyMs, at.bodyBytes, normalize, at.reqID, r.Header, upstreamURL, at.entryFormat, at.originalModel, at.sessionKey)
		}
	} else {
		if isChatToResponsesRewrite(at.entryFormat, effectivePath) {
			at.h.passThroughResponsesAsChat(w, resp, at.upstreamModel, sel, latencyMs, at.bodyBytes, at.reqID, r.Header, upstreamURL, at.originalModel, at.sessionKey)
		} else {
			at.h.passThroughResponse(w, resp, at.upstreamModel, sel, latencyMs, at.bodyBytes, at.reqID, r.Header, upstreamURL, at.originalModel, at.sessionKey)
		}
	}
	// The client response completed synchronously above; the defer releases
	// the key counter and the entry on the way out.
	return attemptResult{next: outcomeStop, written: true}
}

func (h *Handler) broadcastRequestStart(id string, entry usage.Entry) {
	raw := MarshalEntryJSONLight(entry)
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

// broadcastTokens pushes a live token update for a processing request. The
// firstContentMs carries the server-side UnixMilli of the first content
// chunk (0 = unknown / no content yet); the frontend prefers it as the GT
// anchor and falls back to ts+ttft when absent, so GT no longer depends on
// the provider emitting usage/timings chunks.
// broadcastTokensSplit is the RES/CT-segregated variant: res/ct carry the
// live per-split estimates (chars/4 caliber or upstream-exact), output stays
// the aggregate. broadcastTokens wraps it for aggregate-only callers.
func (h *Handler) broadcastTokensSplit(id string, input, output, res, ct int, firstContentMs int64) {
	raw, err := json.Marshal(struct {
		InputTokens     int   `json:"inputTokens"`
		OutputTokens    int   `json:"outputTokens"`
		ReasoningTokens int   `json:"reasoningTokens,omitempty"`
		ContentTokens   int   `json:"contentTokens,omitempty"`
		FirstContentMs  int64 `json:"firstContentMs,omitempty"`
	}{input, output, res, ct, firstContentMs})
	if err != nil {
		return
	}
	h.RequestUpdates.Broadcast(RequestEvent{
		Type:  "request-tokens",
		ID:    id,
		Entry: raw,
	})
}

// broadcastTokens is the aggregate-only wrapper kept for the non-split
// paths (Anthropic usage deltas, error paths). RES/CT arrive as 0.
func (h *Handler) broadcastTokens(id string, input, output int, firstContentMs ...int64) {
	var fcm int64
	if len(firstContentMs) > 0 {
		fcm = firstContentMs[0]
	}
	h.broadcastTokensSplit(id, input, output, 0, 0, fcm)
}
