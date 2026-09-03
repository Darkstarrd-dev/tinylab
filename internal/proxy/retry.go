package proxy

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/util"
)

// retryState holds mutable state across retry iterations.
type retryState struct {
	excludeKeyIDs  []string
	temp429Retries int
	tpmWaitRetries int
	consecutive5xx int
	maxRetries     int
	requestLogged  bool
}

// requestHeaders safely extracts request headers, returning nil when the
// request is nil (e.g. in tests or non-request contexts).
func requestHeaders(r *http.Request) http.Header {
	if r == nil {
		return nil
	}
	return r.Header
}

// maxRetries returns the configured max retry count with a default fallback.
func (h *Handler) maxRetries() int {
	mr := h.rotSet.Settings().MaxRetries
	if mr <= 0 {
		return 5
	}
	return mr
}

// maxRetriesFor returns the effective max retry count for a provider:
// MaxRetriesOverride wins (clamped 1..20), otherwise the global Rotation
// MaxRetries with the ≤0→5 fallback.
func (h *Handler) maxRetriesFor(providerID string) int {
	if p, ok := h.providers.GetProvider(providerID); ok && p.MaxRetriesOverride != nil {
		return clampInt(*p.MaxRetriesOverride, 1, 20)
	}
	return h.maxRetries()
}

// providerRetryOverride returns the provider's MaxRetriesOverride and
// RetryIntervalOverrideSec pointers (both nil when the provider is missing or
// no override is configured). A uniform retry interval is applied in the
// generic 429/5xx backoff paths only when both overrides are set.
func (h *Handler) providerRetryOverride(providerID string) (*int, *int) {
	p, ok := h.providers.GetProvider(providerID)
	if !ok {
		return nil, nil
	}
	return p.MaxRetriesOverride, p.RetryIntervalOverrideSec
}

// clampInt bounds v to [min, max].
func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// logRequest logs the initial request line (only once per forwardWithRetry call).
// reqID and callerTag thread requester identity into the console so concurrent
// clients can be told apart.
func (h *Handler) logRequest(sel *rotation.SelectedKey, logLabel, providerName, upstreamModel, originalModel string, msgCount int, state *retryState, reqID, callerTag, sessionKey string) {
	dspName := sel.Provider.Name
	if providerName != "" {
		dspName = providerName
	}
	dspModel := resolveDisplayModel(dspName, upstreamModel, originalModel, h.aliases)
	tag := reqLogTag(reqID, sessionKey)
	if callerTag != "" {
		h.logger.Info("[%s] REQUEST %s%s | %s | %d msgs | Key %s | %s", tag, logLabel, dspName, dspModel, msgCount, sel.Key.Name, callerTag)
	} else {
		h.logger.Info("[%s] REQUEST %s%s | %s | %d msgs | Key %s", tag, logLabel, dspName, dspModel, msgCount, sel.Key.Name)
	}
	state.requestLogged = true
}

func (h *Handler) handleNetworkError(sel *rotation.SelectedKey, providerID, model string, err error, state *retryState, reqID string, reqBody []byte, reqHeaders http.Header, upstreamURL string, originalModel, sessionKey string) {
	tag := reqLogTag(reqID, sessionKey)
	h.logger.Error("[%s] upstream error: %v", tag, err)
	h.logger.Warn("[%s] %s: 网络错误（%v）→ 退避后切换", tag, sel.Key.Name, err)
	h.keySel.OnKeyFailure(providerID, sel.Key.ID, model, 0, err.Error())
	state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
	h.recordUsage(reqID, providerID, model, sel, "error", 0, 0, 0, 0, err.Error(), reqBody, nil, nil, 0, reqHeaders, upstreamURL, originalModel, sessionKey, "network error → backoff, switch key", "")
	state.temp429Retries = 0
	state.tpmWaitRetries = 0
}

// handle429 processes HTTP 429 responses. Distinguishes daily quota locks from temporary rate limits.
func (h *Handler) handle429(resp *http.Response, sel *rotation.SelectedKey, providerID, model string, startTime time.Time, state *retryState, r *http.Request, reqID string, reqBody []byte, upstreamURL string, originalModel, sessionKey string) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		h.logger.Warn("failed to read upstream 429 body: %v", err)
	}
	resp.Body.Close()
	bodyStr := string(body)
	latencyMs := time.Since(startTime).Milliseconds()

	// Provider-level retry overrides replace the exponential backoff with a
	// fixed count + uniform interval in the generic sections below. NIM
	// ladder, daily-quota locks and SenseNova fixed segments keep their
	// dedicated handling and are never overridden.
	ovMax, ovInterval := h.providerRetryOverride(providerID)

	// NIM 429: use NIM-specific cooldown ladder.
	if h.nim.IsNIMEnabled(providerID, model) {
		h.nim.MarkNIM429(providerID, sel.Key.ID, model)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		state.tpmWaitRetries = 0
		h.logger.Warn("429 NIM: key %s cooled ladder, rotating", sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 NIM cooldown ladder, rotate", "")
		return
	}

	// Parse rate-limit headers from the 429 response (ModelScope returns them even on 429)
	adapter := rotation.GetAdapter(sel.Provider)
	snap := adapter.ParseHeaders(resp.Header)
	if snap != nil {
		// Update quota state from the 429 response headers
		keyState := h.keyState.GetKeyState(providerID, sel.Key.ID)
		if keyState != nil {
			keyState.UpdateQuota(model, snap.ModelLimit, snap.ModelRemaining, snap.GlobalLimit, snap.GlobalRemaining)
		}
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

	// If adapter detected quota exhaustion (ModelRemaining == 0), lock the key for this model
	if snap != nil && snap.ModelExhausted() {
		h.quotaLock.MarkDailyQuotaLocked(providerID, sel.Key.ID, model, bodyStr)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.logger.Warn("429 quota exhausted: %s | locked Key %s until next CST day", util.TruncStr(bodyStr, 200), sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 quota exhausted → daily lock", "")
		return
	}

	// If adapter has quota info but not exhausted, use progressive backoff sequence
	if snap != nil && snap.HasQuota() && !snap.ModelExhausted() {
		maxBackoffRetries := 10
		if ovMax != nil {
			maxBackoffRetries = clampInt(*ovMax, 1, 20)
		}
		if state.temp429Retries < maxBackoffRetries {
			state.temp429Retries++
			delay := rotation.BackoffSequence(state.temp429Retries)
			if ovMax != nil && ovInterval != nil {
				delay = clampInt(*ovInterval, 0, 60)
			}
			h.logger.Warn("429: %s | retrying in %ds (attempt %d/%d) [Key %s]",
				util.TruncStr(bodyStr, 200), delay, state.temp429Retries, maxBackoffRetries, sel.Key.Name)
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 backoff "+strconv.Itoa(delay)+"s", "")
			select {
			case <-r.Context().Done():
				h.logger.Debug("client canceled during 429 backoff")
				return
			case <-time.After(time.Duration(delay) * time.Second):
			}
			return
		}
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.keySel.OnKeyFailure(providerID, sel.Key.ID, model, 429, bodyStr)
		h.logger.Warn("429 retries exhausted for Key %s, switching", sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 retries exhausted → switch", "")
		return
	}

	// SenseNova plan-entitlement exhaustion: the account's token plan is used up.
	// This is neither an rpm nor a tpm window — the account is done for the day,
	// so cool the key for 300 minutes instead of the 60s sliding-window cooldown.
	if isSenseNovaEntitlementExhausted(sel.Provider.BaseURL, bodyStr) {
		h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, 300*time.Minute)
		h.excludeSameAccountKeys(sel, state)
		state.temp429Retries = 0
		h.logger.Warn("429 entitlement exhausted: %s | Key %s cooled 300m, switching account", util.TruncStr(bodyStr, 200), sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 entitlement exhausted → cool 300m, switch account", "")
		return
	}

	// SenseNova-style 429: no rate-limit headers, but body is classifiable into rpm/tpm.
	// Both are per-account per-model with ~60s sliding window, but need different strategies:
	//   - rpm (request count): switching to a fresh account always works (count resets)
	//   - tpm (token count): if the request itself is large, any account will 429 immediately;
	//     switching keys causes a cascade that locks all keys. So tpm waits and retries the
	//     same key instead of switching.
	if snType := classifySenseNova429(bodyStr); snType != sn429Unknown {
		switch snType {
		case sn429RPM:
			// rpm exhausted: per-account. Cool current key+model 60s, exclude same-account
			// keys, switch to a different account immediately.
			h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, 60*time.Second)
			h.excludeSameAccountKeys(sel, state)
			state.temp429Retries = 0
			h.logger.Warn("429 rpm: %s | Key %s cooled 60s, switching account", util.TruncStr(bodyStr, 200), sel.Key.Name)
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 rpm → cool 60s, switch account", "")
		case sn429TPM:
			// tpm exceeded: per-account. Do NOT switch keys (a large request will 429 on any
			// account). Wait 15s and retry the same key once; if still 429, cool 60s and fail.
			if state.tpmWaitRetries < 1 {
				state.tpmWaitRetries++
				h.logger.Warn("429 tpm: %s | Key %s waiting 15s, retrying same key (attempt %d/1)",
					util.TruncStr(bodyStr, 200), sel.Key.Name, state.tpmWaitRetries)
				h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 tpm → wait 15s retry same key", "")
				select {
				case <-r.Context().Done():
					h.logger.Debug("client canceled during TPM wait")
					return
				case <-time.After(15 * time.Second):
				}
				return
			}
			h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, 60*time.Second)
			state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
			state.tpmWaitRetries = 0
			h.logger.Warn("429 tpm: %s | Key %s cooled 60s after retry exhausted", util.TruncStr(bodyStr, 200), sel.Key.Name)
			h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 tpm cooled 60s after retry exhausted", "")
		}
		return
	}

	// Fallback: use ClassifyError for generic error classification, then original logic
	rule := rotation.ClassifyError(429, bodyStr)
	switch rule.Action {
	case rotation.ActionDailyQuota:
		h.quotaLock.MarkDailyQuotaLocked(providerID, sel.Key.ID, model, bodyStr)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.logger.Warn("429 daily quota: %s | locked Key %s until next CST day", util.TruncStr(bodyStr, 200), sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 daily quota lock", "")
		return
	case rotation.ActionCooldown:
		h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, time.Duration(rule.CooldownSec)*time.Second)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.logger.Warn("429: %s | Key %s cooled %ds", util.TruncStr(bodyStr, 200), sel.Key.Name, rule.CooldownSec)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 cooldown "+strconv.Itoa(rule.CooldownSec)+"s", "")
		return
	case rotation.ActionTransient:
		h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, time.Duration(rotation.DefaultTransientCooldownSec)*time.Second)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.logger.Warn("429: %s | Key %s cooled %ds (transient)", util.TruncStr(bodyStr, 200), sel.Key.Name, rotation.DefaultTransientCooldownSec)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 transient cooldown", "")
		return
	case rotation.ActionBackoff:
		// fall through to existing retry logic
	}

	if rotation.IsDailyQuota429(bodyStr, model) {
		h.quotaLock.MarkDailyQuotaLocked(providerID, sel.Key.ID, model, bodyStr)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		state.temp429Retries = 0
		h.logger.Warn("429 daily quota: %s | locked Key %s until next CST day", util.TruncStr(bodyStr, 200), sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 daily quota lock", "")
		return
	}

	maxRetries := state.maxRetries
	if ovMax != nil {
		maxRetries = h.maxRetriesFor(providerID)
	}
	if state.temp429Retries < maxRetries {
		state.temp429Retries++
		delay := rotation.BackoffSequence(state.temp429Retries)
		if ovMax != nil && ovInterval != nil {
			delay = clampInt(*ovInterval, 0, 60)
		}
		h.logger.Warn("429: %s | retrying in %ds (attempt %d/%d) [Key %s]",
			util.TruncStr(bodyStr, 200), delay, state.temp429Retries, maxRetries, sel.Key.Name)
		h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 backoff "+strconv.Itoa(delay)+"s", "")
		select {
		case <-r.Context().Done():
			h.logger.Debug("client canceled during 429 backoff")
			return
		case <-time.After(time.Duration(delay) * time.Second):
		}
		return
	}

	state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
	state.temp429Retries = 0
	h.keySel.OnKeyFailure(providerID, sel.Key.ID, model, 429, bodyStr)
	h.logger.Warn("429 retries exhausted for Key %s, switching", sel.Key.Name)
	h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "429 retries exhausted → switch", "")
}

// handleUpstreamError processes HTTP 5xx and 4xx (non-429) responses.
// Returns true when the upstream error has already been written to the client
// as a pass-through response (request-shape 4xx) and the retry loop must STOP
// (and return success-ish so the caller does NOT also writeError 502). Returns
// false to continue the retry/switch-key loop as before.
//
// Uses ClassifyError to determine the appropriate action, then switches to the
// next key. For 5xx errors, applies a short backoff (500ms-5s) before the next
// retry to avoid hammering the upstream (P3.14).
func (h *Handler) handleUpstreamError(w http.ResponseWriter, resp *http.Response, sel *rotation.SelectedKey, providerID, model string, state *retryState, r *http.Request, reqID string, reqBody []byte, upstreamURL string, startTime time.Time, originalModel, sessionKey string) bool {
	tag := reqLogTag(reqID, sessionKey)
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		h.logger.Warn("[%s] failed to read upstream error body: %v", tag, err)
	}
	resp.Body.Close()
	bodyStr := string(body)

	latencyMs := time.Since(startTime).Milliseconds()
	h.recordUsage(reqID, sel.Provider.Name, model, sel, "error", latencyMs, 0, 0, 0, bodyStr, reqBody, body, resp.Header, resp.StatusCode, requestHeaders(r), upstreamURL, originalModel, sessionKey, "upstream error", "")

	// Provider-level retry overrides also normalize the 5xx backoff below into
	// a uniform interval when both overrides are set.
	ovMax, ovInterval := h.providerRetryOverride(providerID)

	// Account-level balance exhaustion (ModelScope 402 insufficient_balance_error):
	// lock the key for this model, invalidate its stale quota snapshot so the quota
	// monitor stops showing misleading "remaining" numbers, then switch.
	if rotation.IsBalanceExhausted(resp.StatusCode, bodyStr) {
		h.quotaLock.MarkBalanceLocked(providerID, sel.Key.ID, model, bodyStr)
		h.quotaTracker.RemoveKey(sel.Provider.Name, model, sel.Key.ID)
		state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
		h.logger.Error("[%s] upstream %d (balance exhausted) for Key %s (%s), body=%s | locked", tag, resp.StatusCode, sel.Key.Name, sel.Provider.Name, util.TruncStr(bodyStr, 500))
		h.logger.Warn("[%s] %s: 账户余额耗尽 → 锁至次日 CST 00:05 后切换", tag, sel.Key.Name)
		state.temp429Retries = 0
		state.tpmWaitRetries = 0
		return false
	}

	rule := rotation.ClassifyError(resp.StatusCode, bodyStr)

	// Pass-through: the request itself is malformed (400/422 request-validation).
	// The key is healthy — retrying the SAME request on another key 400s again, and
	// locking the key would punish a healthy key + block all concurrent requests
	// for the cooldown window. Forward the upstream error to the client as-is and
	// stop retrying. (A body matching a transient text rule, e.g. an aggregator
	// reporting "upstream request failed", overrides this to a retryable action.)
	if rule.Action == rotation.ActionPassThrough {
		ct := resp.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		if !strings.Contains(tag, "src=playground") {
			h.logger.Warn("[%s] %s: 上游返回 %d（请求格式错误：%s）→ 直接返回客户端，不冷却 key", tag, sel.Key.Name, resp.StatusCode, util.TruncStr(bodyStr, 500))
		}
		state.temp429Retries = 0
		state.tpmWaitRetries = 0
		state.consecutive5xx = 0
		return true
	}

	var consequence string
	switch rule.Action {
	case rotation.ActionBackoff:
		h.keySel.OnKeyFailure(providerID, sel.Key.ID, model, resp.StatusCode, bodyStr)
		consequence = "→ 指数退避后切换"
	case rotation.ActionCooldown:
		h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, time.Duration(rule.CooldownSec)*time.Second)
		consequence = fmt.Sprintf("→ 冷却 %ds 后切换", rule.CooldownSec)
	case rotation.ActionDailyQuota:
		h.quotaLock.MarkDailyQuotaLocked(providerID, sel.Key.ID, model, bodyStr)
		consequence = "→ 锁至次日 CST 00:05"
	case rotation.ActionTransient:
		h.cooldown.MarkRateLimited(providerID, sel.Key.ID, model, time.Duration(rotation.DefaultTransientCooldownSec)*time.Second)
		consequence = fmt.Sprintf("→ 冷却 %ds 后切换", rotation.DefaultTransientCooldownSec)
	}

	state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
	h.logger.Error("[%s] upstream %d for Key %s (%s), body=%s | switching", tag, resp.StatusCode, sel.Key.Name, sel.Provider.Name, util.TruncStr(bodyStr, 500))
	h.logger.Warn("[%s] %s: %s", tag, sel.Key.Name, consequence)
	state.temp429Retries = 0
	state.tpmWaitRetries = 0
	if resp.StatusCode < 500 {
		// Non-5xx (client errors) are not transient; reset the 5xx streak.
		state.consecutive5xx = 0
	}

	// 5xx short backoff to avoid hammering the upstream (P3.14).
	if resp.StatusCode >= 500 {
		state.consecutive5xx++
		backoff := time.Duration(500+(state.consecutive5xx-1)*500) * time.Millisecond
		if backoff > 5*time.Second {
			backoff = 5 * time.Second
		}
		if ovMax != nil && ovInterval != nil {
			backoff = time.Duration(clampInt(*ovInterval, 0, 60)) * time.Second
		}
		h.logger.Debug("[%s] 5xx backoff: waiting %v before next retry (consecutive5xx=%d)", tag, backoff, state.consecutive5xx)
		if r != nil {
			select {
			case <-r.Context().Done():
				h.logger.Debug("[%s] client canceled during 5xx backoff", tag)
				return false
			case <-time.After(backoff):
			}
		} else {
			time.Sleep(backoff)
		}
	}
	return false
}

// senseNova429Type classifies SenseNova 429 responses by body content.
type senseNova429Type int

const (
	sn429Unknown senseNova429Type = iota
	sn429RPM                      // {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}
	sn429TPM                      // {"message":"rate limit exceeded on dimension: tpm","type":"invalid_request_error","code":"429001"}
)

// classifySenseNova429 inspects the 429 body to determine if it's an rpm or tpm limit.
// Returns sn429Unknown if the body doesn't match SenseNova patterns.
func classifySenseNova429(body string) senseNova429Type {
	lower := strings.ToLower(body)
	if strings.Contains(lower, "rpm exhausted") {
		return sn429RPM
	}
	if strings.Contains(lower, "tpm") {
		return sn429TPM
	}
	return sn429Unknown
}

// isSenseNovaEntitlementExhausted detects SenseNova's plan-level quota error:
// 429 {"error":{"message":"token plan entitlement exhausted","type":"quota_exceeded_error","code":"8"}}.
// Only applies to SenseNova providers (BaseURL contains "sensenova") to avoid
// mis-classifying the same body text from unrelated upstreams.
func isSenseNovaEntitlementExhausted(baseURL, body string) bool {
	if !strings.Contains(strings.ToLower(baseURL), "sensenova") {
		return false
	}
	return strings.Contains(strings.ToLower(body), "token plan entitlement exhausted")
}

// excludeSameAccountKeys adds the current key and all keys with the same non-empty
// Account to the exclusion list. This prevents switching to another key of the same
// account when the rate limit is per-account (e.g., SenseNova rpm/tpm).
func (h *Handler) excludeSameAccountKeys(sel *rotation.SelectedKey, state *retryState) {
	state.excludeKeyIDs = append(state.excludeKeyIDs, sel.Key.ID)
	if sel.Key.Account == "" {
		return
	}
	for _, k := range sel.Provider.Keys {
		if k.ID != sel.Key.ID && k.Account == sel.Key.Account {
			state.excludeKeyIDs = append(state.excludeKeyIDs, k.ID)
		}
	}
}
