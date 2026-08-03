package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// recordUsage records a completed (or errored) request into the usage ring
// buffer, broadcasts a request-done event for the live UI, and signals the
// usage broadcaster. Payload/headers are now always captured so Recent
// Requests are viewable regardless of debug mode; the playground source is
// routed to a dedicated pg ring. Memory is bounded by ring size × body
// size; reqBody is truncated to 64KB, respBody to 512KB.
func (h *Handler) recordUsage(id string, provider, model string, sel *rotation.SelectedKey, status string, latencyMs int64, ttftMs int64, inputTokens, outputTokens int, errMsg string, reqBody []byte, respBody []byte, respHeaders http.Header, respStatus int, reqHeaders http.Header, upstreamURL string, originalModel string, sessionKey string, decision string, provenance string) {
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
	}
	if reqHeaders != nil {
		entry.Source = reqHeaders.Get("X-TinyRouter-Source")
	}
	entry.SessionKey = sessionKey

	// Per-request log file (runtime toggle, mirrors debugMode).
	if h.logRequests() {
		h.writeRequestLog(id, provider, model, sel, status, latencyMs, ttftMs, inputTokens, outputTokens, errMsg, reqBody, respBody, respHeaders, respStatus, reqHeaders, upstreamURL, originalModel, sessionKey, decision, provenance)
	}

	// 分流与门控：
	//   - source == "playground" 的请求写入独立的 pg ring（若已注入），且始终捕获详情；
	//   - 其余请求写入 Recent Requests ring，仅在 debug 开 且 追踪关 时捕获 payload/headers
	//     ——追踪开时完整 body 已落盘 JSONL 文件（由 Log Reader 查看），ring 退化为轻量表
	//     （时间/服务商/模型/密钥/延迟/Tokens），避免 body 在内存与磁盘重复占用。
	// 内存开销由 ring 容量（config.UsageRingSize，默认 500）× 单条 body 大小封顶。
	// reqBody 截断到 64KB，respBody 到 512KB。
	isPlayground := entry.Source == "playground"
	captureDetails := isPlayground || (h.debugMode() && !h.logRequests())
	if captureDetails {
		if len(reqBody) > 0 {
			// reqBody 截断上限，与 respBody 的 512KB 同思路，避免单条过大。
			const maxReqBody = 64 * 1024
			if len(reqBody) > maxReqBody {
				reqBody = reqBody[:maxReqBody]
			}
			if !json.Valid(reqBody) {
				reqBody, _ = json.Marshal(map[string]string{"raw": string(reqBody)})
			}
			entry.ReqPayload = append([]byte(nil), reqBody...)
		}
		if len(respBody) > 0 {
			const maxRespBody = 512 * 1024
			// For image responses, replace base64 data with a placeholder to
			// avoid storing megabytes of useless base64 in the debug panel.
			if len(respBody) > maxRespBody && json.Valid(respBody) {
				var obj map[string]any
				if json.Unmarshal(respBody, &obj) == nil {
					if data, ok := obj["data"].([]any); ok {
						for _, d := range data {
							if dm, ok := d.(map[string]any); ok {
								if b64, ok := dm["b64_json"].(string); ok && len(b64) > 200 {
									dm["b64_json"] = "[truncated: " + strconv.Itoa(len(b64)) + " bytes]"
								}
							}
						}
						if rewritten, err := json.Marshal(obj); err == nil {
							respBody = rewritten
						}
					}
				}
			}
			if len(respBody) > maxRespBody {
				respBody = respBody[:maxRespBody]
			}
			if !json.Valid(respBody) {
				respBody, _ = json.Marshal(map[string]string{"raw": string(respBody)})
			}
			entry.RespPayload = append([]byte(nil), respBody...)
		}
		if len(respHeaders) > 0 {
			entry.RespHeaders = respHeaders.Clone()
		}
		entry.RespStatus = respStatus
		if len(reqHeaders) > 0 {
			entry.ReqHeaders = maskHeaderMap(reqHeaders)
		}
		entry.UpstreamURL = upstreamURL
	}

	// 按 source 分流写入 ring
	if isPlayground && h.pgUsage != nil {
		h.pgUsage.Add(entry)
	} else {
		h.usage.Add(entry)
	}

	raw := MarshalEntryJSON(entry)
	if raw != nil {
		h.RequestUpdates.Broadcast(RequestEvent{
			Type:   "request-done",
			ID:     id,
			Status: status,
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
