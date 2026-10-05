package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/tinylab/tinylab/internal/logredact"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

var (
	dataURLImageRegex = regexp.MustCompile(`data:image/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{100,}`)
	b64JSONRegex      = regexp.MustCompile(`"b64_json"\s*:\s*"[A-Za-z0-9+/=]{100,}"`)
)

func maskBase64Images(data []byte) []byte {
	if len(data) < 120 {
		return data
	}
	if !bytesContains(data, "base64") && !bytesContains(data, "b64_json") {
		return data
	}
	data = dataURLImageRegex.ReplaceAllFunc(data, func(m []byte) []byte {
		idx := bytesIndex(m, ";base64,")
		if idx == -1 {
			return m
		}
		prefix := m[:idx+8]
		return []byte(fmt.Sprintf("%s[image omitted: %d bytes]", prefix, len(m)))
	})
	data = b64JSONRegex.ReplaceAllFunc(data, func(m []byte) []byte {
		return []byte(fmt.Sprintf(`"b64_json":"[image omitted: %d bytes]"`, len(m)))
	})
	return data
}

func bytesContains(b []byte, s string) bool {
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return true
		}
	}
	return false
}

func bytesIndex(b []byte, s string) int {
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return i
		}
	}
	return -1
}

// recordUsage records a completed (or errored) request into the usage ring
// buffer, broadcasts a request-done event for the live UI, and signals the
// usage broadcaster. Payloads and headers are captured for every source so
// Recent Requests remains a complete local diagnostic surface; the playground
// source is routed to a dedicated ring.
// recordUsage persists one usage entry and broadcasts request-done. The
// trailing variadic split carries the RES/CT segregated estimates:
// split[0]=reasoning tokens, split[1]=content tokens. Variadic so the ~20
// existing error/retry/pass-through call sites stay untouched (split unset
// = aggregate-only entry).
func (h *Handler) recordUsage(id string, provider, model string, sel *rotation.SelectedKey, status string, latencyMs int64, ttftMs int64, inputTokens, outputTokens int, errMsg string, reqBody []byte, respBody []byte, respHeaders http.Header, respStatus int, reqHeaders http.Header, upstreamURL string, originalModel string, sessionKey string, decision string, provenance string, split ...int) {
	credential := sel.Key.Key
	errMsg = logredact.MaskString(errMsg, credential)
	decision = logredact.MaskString(decision, credential)
	provenance = logredact.MaskString(provenance, credential)
	upstreamURL = redactURL(upstreamURL, credential)
	reqBody = []byte(logredact.MaskString(string(reqBody), credential))
	respBody = []byte(logredact.MaskString(string(respBody), credential))
	entry := usage.Entry{
		ID:            id,
		Timestamp:     time.Now(),
		Provider:      sel.Provider.Name,
		Model:         model,
		OriginalModel: originalModel,
		KeyID:         sel.Key.ID,
		KeyName:       sel.KeyName,
		Status:        status,
		LatencyMs:     latencyMs,
		TTFTMs:        ttftMs,
		InputTokens:   inputTokens,
		OutputTokens:  outputTokens,
		Error:         errMsg,
		Decision:      decision,
		Provenance:    provenance,
	}
	if len(split) > 0 {
		entry.ReasoningTokens = split[0]
	}
	if len(split) > 1 {
		entry.ContentTokens = split[1]
	}
	if reqHeaders != nil {
		entry.Source = reqHeaders.Get("X-TinyLab-Source")
	}
	entry.SessionKey = sessionKey

	// Per-request log file (runtime toggle, mirrors debugMode).
	if h.logRequests() {
		h.writeRequestLog(id, provider, model, sel, status, latencyMs, ttftMs, inputTokens, outputTokens, errMsg, reqBody, respBody, respHeaders, respStatus, reqHeaders, upstreamURL, originalModel, sessionKey, decision, provenance)
	}

	isPlayground := entry.Source == "playground"
	if len(reqBody) > 0 {
		entry.ReqPayload = captureBody(reqBody)
	}
	if len(respBody) > 0 {
		entry.RespPayload = captureBody(respBody)
	}
	if len(respHeaders) > 0 {
		entry.RespHeaders = http.Header(h.maskHeaderMap(respHeaders, credential))
	}
	entry.RespStatus = respStatus
	if len(reqHeaders) > 0 {
		entry.ReqHeaders = http.Header(h.maskHeaderMap(reqHeaders, credential))
	}
	entry.UpstreamURL = upstreamURL

	// 按 source 分流写入 ring
	if isPlayground && h.pgUsage != nil {
		h.pgUsage.Add(entry)
	} else {
		h.usage.Add(entry)
	}

	raw := MarshalEntryJSONLight(entry)
	if raw != nil {
		h.RequestUpdates.Broadcast(RequestEvent{
			Type:   "request-done",
			ID:     id,
			Status: status,
			Entry:  raw,
		})
	}
	h.UsageUpdates.Signal()
	if h.hardLimit != nil {
		h.hardLimit.Reconcile(sel.Provider.ID, id, inputTokens+outputTokens)
	}
}

// recordNoKeyFailure records a terminal proxy-local failure where no key could
// be selected (all keys cooling down / exhausted / inactive). recordUsage
// cannot serve this path — it dereferences the selected key — so this writes
// the same ring entry + request-done broadcast shape with no key identity,
// keeping the request visible in Monitor and Playground with its error.
func (h *Handler) recordNoKeyFailure(id, providerName, model, errMsg string, reqHeaders http.Header, sessionKey string) {
	entry := usage.Entry{
		ID:         id,
		Timestamp:  time.Now(),
		Provider:   providerName,
		Model:      model,
		Status:     "error",
		Error:      errMsg,
		SessionKey: sessionKey,
	}
	if reqHeaders != nil {
		entry.Source = reqHeaders.Get("X-TinyLab-Source")
	}
	if entry.Source == "playground" && h.pgUsage != nil {
		h.pgUsage.Add(entry)
	} else {
		h.usage.Add(entry)
	}
	if raw := MarshalEntryJSONLight(entry); raw != nil {
		h.RequestUpdates.Broadcast(RequestEvent{
			Type:   "request-done",
			ID:     id,
			Status: "error",
			Entry:  raw,
		})
	}
	h.UsageUpdates.Signal()
}

// parseAndUpdateQuota extracts rate-limit info from upstream response headers
// and stores it in the key's runtime state.
func (h *Handler) parseAndUpdateQuota(sel *rotation.SelectedKey, providerID, model string, headers http.Header) {
	adapter := rotation.GetAdapter(sel.Provider)
	snap := adapter.ParseHeaders(headers)
	if snap == nil {
		return
	}
	state := h.keyState.GetKeyState(providerID, sel.Key.ID)
	if state == nil {
		return
	}
	state.UpdateQuota(model, snap.ModelLimit, snap.ModelRemaining, snap.GlobalLimit, snap.GlobalRemaining)
	// Count active keys for total capacity estimation
	activeKeyCount := 0
	for _, k := range sel.Provider.Keys {
		if k.IsActive {
			activeKeyCount++
		}
	}

	// Update the quota tracker for UI display
	h.quotaTracker.Update(sel.Provider.Name, model, sel.Key.ID, sel.Key.Name, snap.ModelLimit, snap.ModelRemaining, activeKeyCount)
}

// maxCapturedBodyBytes caps how much of a request/response body is retained
// in the in-memory observability surfaces (usage rings, EntryTracker). Larger
// bodies are truncated to this prefix and wrapped by marshalTruncatedBody so
// the retained payload stays valid, self-describing JSON (F-06). Full
// untruncated bodies remain available in the JSONL traces when request
// logging is enabled: recordUsage invokes writeRequestLog before captureBody.
const maxCapturedBodyBytes = 256 << 10

func captureBody(body []byte) json.RawMessage {
	body = maskBase64Images(body)
	if len(body) > maxCapturedBodyBytes {
		if isTruncationEnvelope(body) {
			return append(json.RawMessage(nil), body...)
		}
		return json.RawMessage(marshalTruncatedBody(body[:maxCapturedBodyBytes], int64(len(body))))
	}
	if json.Valid(body) {
		return append(json.RawMessage(nil), body...)
	}
	wrapped, err := json.Marshal(map[string]string{"raw": string(body)})
	if err != nil {
		return nil
	}
	return wrapped
}

// isTruncationEnvelope reports whether body is already a marshalTruncatedBody
// envelope. The streaming paths pre-wrap their capped capture buffer before
// recordUsage runs; without this check captureBody would nest a second
// truncation around the envelope and corrupt its totalBytes marker.
func isTruncationEnvelope(body []byte) bool {
	var probe struct {
		Truncated  bool    `json:"truncated"`
		Raw        *string `json:"raw"`
		TotalBytes *int64  `json:"totalBytes"`
	}
	return json.Unmarshal(body, &probe) == nil && probe.Truncated && probe.Raw != nil && probe.TotalBytes != nil
}

// marshalTruncatedBody wraps the retained head of an over-budget body in a
// small valid-JSON envelope carrying the truncation marker. Shared by
// captureBody (non-stream paths, total == observed length) and the streaming
// capture buffer (total == true upstream byte count, head == retained
// prefix). The "raw" field keeps the existing non-JSON wrapper shape so the
// monitor modal renders truncated payloads like any other raw body.
func marshalTruncatedBody(head []byte, total int64) []byte {
	wrapped, err := json.Marshal(map[string]any{
		"raw":            string(head),
		"truncated":      true,
		"truncatedBytes": total - int64(len(head)),
		"totalBytes":     total,
	})
	if err != nil {
		return nil
	}
	return wrapped
}
