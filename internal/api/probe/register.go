// Package probe provides HTTP handlers for provider model probing.
package probe

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/customheaders"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

// Handler is the HTTP handler for probe-related endpoints.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new probe Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register routes probe endpoints on the given router. These live under the
// /api group (mounted by internal/api/router.go), so paths are relative to /api.
func (h *Handler) Register(r chi.Router) {
	// Single-protocol model probe (provider detail "Test" button per protocol).
	r.Post("/providers/{id}/models/test-proto", h.probeModel)
	// Batch all-keys probe (SSE stream of per-key results).
	r.Post("/providers/{id}/models/test-all", h.probeKey)
}

// ---------------------------------------------------------------------------
// Protocol identifiers
// ---------------------------------------------------------------------------

const (
	probeProtocolOpenAICompat    = "openai-compat"
	probeProtocolOpenAIResponses = "openai-responses"
	probeProtocolAnthropic       = "anthropic"
	probeProtocolOpenAIEmbedding = "openai-embedding"
)

const (
	probeTestPrompt         = "generate 100 tokens self introduction"
	testAllKeysPrompt       = "generate 100 tokens self introduction"
	probeEmbeddingTestInput = "The quick brown fox jumps over the lazy dog near a river at sunset."
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ProbeResult is the outcome of probing a single protocol entry point for a model.
type ProbeResult struct {
	Protocol        string              `json:"protocol"`     // "openai-compat" / "openai-responses" / "anthropic" / "openai-embedding"
	Ok              bool                `json:"ok"`           // resp.StatusCode == 200 and body has no error field
	Status          int                 `json:"status"`       // HTTP status code
	LatencyMs       int64               `json:"latencyMs"`    // round-trip latency in milliseconds
	OutputTokens    int                 `json:"outputTokens"` // extracted or estimated output token count
	TokensPerSec    float64             `json:"tokensPerSec"` // speed in tokens per second
	EmbeddingDim    int                 `json:"embeddingDim"` // embedding vector dimension (only for openai-embedding protocol)
	Error           string              `json:"error"`        // human-readable error (empty on success)
	Request         map[string]any      `json:"request"`      // {method, url, headers, body, bodyRaw}
	ResponseHeaders map[string][]string `json:"responseHeaders"`
	ResponseBody    any                 `json:"responseBody"` // JSON-parsed response body; nil if not parseable
	ResponseBodyRaw string              `json:"responseBodyRaw"`
	Skipped         bool                `json:"skipped"` // true if the probe was skipped (e.g. no key available)
}

// ProbeQuotaHook is invoked (when non-nil) on a successful probe so the caller
// can extract quota info from the response headers.
type ProbeQuotaHook func(model string, resp *http.Response)

// keyTestResult is the per-key outcome of the "test all keys" batch probe.
type keyTestResult struct {
	KeyID        string  `json:"keyId"`
	KeyName      string  `json:"keyName"`
	Ok           bool    `json:"ok"`
	TTFTMs       int64   `json:"ttftMs"`
	LatencyMs    int64   `json:"latencyMs"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	TokensPerSec float64 `json:"tokensPerSec"`
	Status       int     `json:"status"`
	Error        string  `json:"error,omitempty"`
	QuotaRemain  int     `json:"quotaRemain,omitempty"`
	QuotaTotal   int     `json:"quotaTotal,omitempty"`
}

// testProviderModelProtoRequest is the JSON body for POST /api/providers/{id}/models/test-proto.
type testProviderModelProtoRequest struct {
	Model string `json:"model"`
	Proto string `json:"proto"`
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// probeModel probes a single protocol for a given model on a provider.
func (h *Handler) probeModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := h.d.Reg.GetProvider(providerID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	var req testProviderModelProtoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if req.Proto != config.ProtocolOpenAICompat &&
		req.Proto != config.ProtocolOpenAIResponses &&
		req.Proto != config.ProtocolAnthropic &&
		req.Proto != config.ProtocolOpenAIEmbedding {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid proto: must be one of openai-compat, openai-responses, anthropic, openai-embedding")
		return
	}

	key := firstActiveKey(provider)
	if key == nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no active key for this provider")
		return
	}

	client := h.d.ProxyHandler.ManagementClient(*provider)

	ctx, cancel := contextWithOverallTimeout(r, 30*time.Second)
	defer cancel()

	custom := customheaders.Config{Enabled: provider.UseCustomHeaders, Headers: provider.CustomHeaders}
	var res ProbeResult
	switch req.Proto {
	case config.ProtocolOpenAICompat:
		res = h.ProbeOpenAICompat(ctx, client, provider.BaseURL, req.Model, key.Key, custom, nil)
	case config.ProtocolOpenAIResponses:
		res = h.ProbeOpenAIResponses(ctx, client, provider.BaseURL, req.Model, key.Key, custom, nil)
	case config.ProtocolAnthropic:
		res = h.ProbeAnthropic(ctx, client, provider.BaseURL, req.Model, key.Key, custom, nil)
	case config.ProtocolOpenAIEmbedding:
		res = h.ProbeOpenAIEmbedding(ctx, client, provider.BaseURL, req.Model, key.Key, custom, nil)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(probeResultToMap(res))
}

// probeKey tests a model against every active key of a provider (batch probe).
func (h *Handler) probeKey(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := h.d.Reg.GetProvider(providerID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "model required")
		return
	}

	activeKeyCount := 0
	for _, k := range provider.Keys {
		if k.IsActive {
			activeKeyCount++
		}
	}
	if activeKeyCount == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no active key for this provider")
		return
	}

	if r.Header.Get("Accept") == "text/event-stream" {
		h.testProviderModelAllKeysSSE(w, r, providerID, provider, req.Model, activeKeyCount)
		return
	}

	chatURL := urlutil.BuildUpstreamURL(provider.BaseURL, "/v1/chat/completions")
	adapter := rotation.GetAdapter(*provider)

	bodyMap := map[string]any{
		"model": req.Model,
		"messages": []map[string]string{
			{"role": "user", "content": testAllKeysPrompt},
		},
		"max_tokens": 100,
		"stream":     true,
	}
	bodyBytes, _ := json.Marshal(bodyMap)

	results := make([]keyTestResult, 0, activeKeyCount)

	for i := range provider.Keys {
		k := &provider.Keys[i]
		if !k.IsActive {
			continue
		}

		result := keyTestResult{
			KeyID:   k.ID,
			KeyName: k.Name,
		}

		httpReq, err := http.NewRequestWithContext(r.Context(), "POST", chatURL, bytes.NewReader(bodyBytes))
		if err != nil {
			result.Error = err.Error()
			results = append(results, result)
			continue
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+k.Key)
		httpReq.Header.Set("Accept", "text/event-stream")
		customheaders.Apply(httpReq.Header, provider.UseCustomHeaders, provider.CustomHeaders)

		t0 := time.Now()
		resp, err := h.d.TestClient.Do(httpReq)
		if err != nil {
			result.Ok = false
			result.Error = err.Error()
			result.LatencyMs = time.Since(t0).Milliseconds()
			results = append(results, result)
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			errBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			errMsg := strings.TrimSpace(string(errBody))
			if len(errMsg) > 500 {
				errMsg = errMsg[:500]
			}
			result.Ok = false
			result.Status = resp.StatusCode
			result.Error = errMsg
			result.LatencyMs = time.Since(t0).Milliseconds()
			results = append(results, result)
			continue
		}

		var ttftMs int64
		inputTokens := 0
		outputTokens := 0
		buf := make([]byte, 32*1024)
		sb := &sse.SSELineBuffer{}

		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if ttftMs == 0 {
					ttftMs = time.Since(t0).Milliseconds()
				}
				for _, payload := range sse.SSEDataPayloads(sb.Feed(buf[:n])) {
					if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
						inputTokens = in
						outputTokens = out
					}
				}
			}
			if readErr != nil {
				for _, payload := range sse.SSEDataPayloads([]string{sb.Remaining()}) {
					if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
						inputTokens = in
						outputTokens = out
					}
				}
				break
			}
		}
		resp.Body.Close()

		totalMs := time.Since(t0).Milliseconds()
		outputPhaseSec := float64(totalMs-ttftMs) / 1000.0
		var tokensPerSec float64
		if outputPhaseSec > 0 {
			tokensPerSec = float64(outputTokens) / outputPhaseSec
		}

		if snap := adapter.ParseHeaders(resp.Header); snap != nil {
			result.QuotaRemain = snap.ModelRemaining
			result.QuotaTotal = snap.ModelLimit
			if ks := h.d.Reg.GetKeyState(providerID, k.ID); ks != nil {
				ks.UpdateQuota(req.Model, snap.ModelLimit, snap.ModelRemaining, snap.GlobalLimit, snap.GlobalRemaining)
			}
			h.d.QuotaTracker.Update(provider.Name, req.Model, k.ID, k.Name, snap.ModelLimit, snap.ModelRemaining, activeKeyCount)
		}

		result.Ok = true
		result.Status = 200
		result.TTFTMs = ttftMs
		result.LatencyMs = totalMs
		result.InputTokens = inputTokens
		result.OutputTokens = outputTokens
		result.TokensPerSec = tokensPerSec

		results = append(results, result)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"provider": providerID,
		"model":    req.Model,
		"results":  results,
	})
}

// testProviderModelAllKeysSSE streams per-key probe results as SSE events.
func (h *Handler) testProviderModelAllKeysSSE(w http.ResponseWriter, r *http.Request, providerID string, provider *config.Provider, model string, activeKeyCount int) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	ctx := r.Context()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	chatURL := urlutil.BuildUpstreamURL(provider.BaseURL, "/v1/chat/completions")
	adapter := rotation.GetAdapter(*provider)

	bodyMap := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": testAllKeysPrompt},
		},
		"max_tokens": 100,
		"stream":     true,
	}
	bodyBytes, _ := json.Marshal(bodyMap)

	if metaJSON, err := json.Marshal(map[string]int{"total": activeKeyCount}); err == nil {
		fmt.Fprintf(w, "event: meta\ndata: %s\n\n", metaJSON)
		flusher.Flush()
	}

	okCount, failCount := 0, 0
	for i := range provider.Keys {
		k := &provider.Keys[i]
		if !k.IsActive {
			continue
		}
		result := h.probeSingleKey(ctx, providerID, provider, model, k, chatURL, adapter, bodyBytes)

		if result.Ok {
			okCount++
			h.d.Logger.Info("TEST-ALL %s/%s | Key=%s | OK (%dms)", provider.Name, model, k.Name, result.LatencyMs)
		} else {
			failCount++
			h.d.Logger.Warn("TEST-ALL %s/%s | Key=%s | FAIL %d (%dms)", provider.Name, model, k.Name, result.Status, result.LatencyMs)
		}
		if b, err := json.Marshal(result); err == nil {
			fmt.Fprintf(w, "event: key\ndata: %s\n\n", b)
			flusher.Flush()
		}
	}

	if doneJSON, err := json.Marshal(map[string]int{"ok": okCount, "fail": failCount, "total": activeKeyCount}); err == nil {
		fmt.Fprintf(w, "event: done\ndata: %s\n\n", doneJSON)
		flusher.Flush()
	}
}

// probeSingleKey performs a single streaming probe against an upstream model
// endpoint using one specific key, returning the measurement result.
func (h *Handler) probeSingleKey(ctx context.Context, providerID string, provider *config.Provider, model string, k *config.Key, chatURL string, adapter rotation.RatelimitAdapter, bodyBytes []byte) keyTestResult {
	result := keyTestResult{KeyID: k.ID, KeyName: k.Name}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", chatURL, bytes.NewReader(bodyBytes))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+k.Key)
	httpReq.Header.Set("Accept", "text/event-stream")
	customheaders.Apply(httpReq.Header, provider.UseCustomHeaders, provider.CustomHeaders)

	h.d.Logger.Debug("PROBE SEND %s/%s | Key=%s | url=%s | body=%s", provider.Name, model, k.Name, chatURL, util.TruncStr(string(bodyBytes), 200))

	t0 := time.Now()
	resp, err := h.d.ProxyHandler.ManagementClient(*provider).Do(httpReq)
	if err != nil {
		h.d.Logger.Error("PROBE ERR %s/%s | Key=%s | %v", provider.Name, model, k.Name, err)
		result.Ok = false
		result.Error = err.Error()
		result.LatencyMs = time.Since(t0).Milliseconds()
		h.d.ProxyHandler.TraceMgmtCall("probe:singlekey:provider="+providerID+":model="+model+":key="+k.ID, "probe", "probe", model, provider.Name, chatURL, httpReq.Header, bodyBytes, 0, nil, nil, err.Error(), time.Since(t0).Milliseconds())
		return result
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		errMsg := strings.TrimSpace(string(errBody))
		if len(errMsg) > 500 {
			errMsg = errMsg[:500]
		}
		h.d.Logger.Warn("PROBE %d %s/%s | Key=%s | body=%s", resp.StatusCode, provider.Name, model, k.Name, util.TruncStr(errMsg, 200))
		result.Ok = false
		result.Status = resp.StatusCode
		result.Error = errMsg
		result.LatencyMs = time.Since(t0).Milliseconds()
		h.d.ProxyHandler.TraceMgmtCall("probe:singlekey:provider="+providerID+":model="+model+":key="+k.ID, "probe", "probe", model, provider.Name, chatURL, httpReq.Header, bodyBytes, resp.StatusCode, resp.Header, nil, errMsg, time.Since(t0).Milliseconds())
		return result
	}

	var ttftMs int64
	inputTokens := 0
	outputTokens := 0
	var contentChunks int
	var contentBuf strings.Builder
	buf := make([]byte, 32*1024)
	sb := &sse.SSELineBuffer{}

	const minChunks = 10
	const maxStreamSec = 8

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if ttftMs == 0 {
				ttftMs = time.Since(t0).Milliseconds()
				h.d.Logger.Debug("PROBE STREAM %s/%s | Key=%s | TTFT=%dms", provider.Name, model, k.Name, ttftMs)
			}
			for _, payload := range sse.SSEDataPayloads(sb.Feed(buf[:n])) {
				if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
					inputTokens = in
					outputTokens = out
				}
				if text := extractContentFromSSE([]byte(payload)); text != "" {
					contentChunks++
					contentBuf.WriteString(text)
				}
			}
			if contentChunks >= minChunks || time.Since(t0).Seconds() > maxStreamSec {
				break
			}
		}
		if readErr != nil {
			for _, payload := range sse.SSEDataPayloads([]string{sb.Remaining()}) {
				if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
					inputTokens = in
					outputTokens = out
				}
				if text := extractContentFromSSE([]byte(payload)); text != "" {
					contentChunks++
					contentBuf.WriteString(text)
				}
			}
			break
		}
	}
	resp.Body.Close()

	contentText := contentBuf.String()
	h.d.Logger.Debug("PROBE CONTENT %s/%s | Key=%s | chunks=%d | text=%s", provider.Name, model, k.Name, contentChunks, util.TruncStr(contentText, 200))

	totalMs := time.Since(t0).Milliseconds()
	outputPhaseSec := float64(totalMs-ttftMs) / 1000.0
	var tokensPerSec float64
	if outputTokens == 0 && len(contentText) > 0 {
		outputTokens = len(contentText) / 4
		if outputTokens == 0 {
			outputTokens = 1
		}
	}
	if outputPhaseSec > 0 {
		tokensPerSec = float64(outputTokens) / outputPhaseSec
	}
	h.d.Logger.Info("PROBE OK %s/%s | Key=%s | ttft=%dms | total=%dms | in=%d out=%d | %.1f tok/s", provider.Name, model, k.Name, ttftMs, totalMs, inputTokens, outputTokens, tokensPerSec)

	if snap := adapter.ParseHeaders(resp.Header); snap != nil {
		h.d.Logger.Info("PROBE quota %s/%s | Key=%s | remain=%d/%d", provider.Name, model, k.Name, snap.ModelRemaining, snap.ModelLimit)
		result.QuotaRemain = snap.ModelRemaining
		result.QuotaTotal = snap.ModelLimit
		if ks := h.d.Reg.GetKeyState(providerID, k.ID); ks != nil {
			ks.UpdateQuota(model, snap.ModelLimit, snap.ModelRemaining, snap.GlobalLimit, snap.GlobalRemaining)
		}
		activeKeyCount := 0
		for _, kk := range provider.Keys {
			if kk.IsActive {
				activeKeyCount++
			}
		}
		h.d.QuotaTracker.Update(provider.Name, model, k.ID, k.Name, snap.ModelLimit, snap.ModelRemaining, activeKeyCount)
	}

	result.Ok = true
	result.Status = 200
	result.TTFTMs = ttftMs
	result.LatencyMs = totalMs
	result.InputTokens = inputTokens
	result.OutputTokens = outputTokens
	result.TokensPerSec = tokensPerSec
	h.d.ProxyHandler.TraceMgmtCall("probe:singlekey:provider="+providerID+":model="+model+":key="+k.ID, "probe", "probe", model, provider.Name, chatURL, httpReq.Header, bodyBytes, resp.StatusCode, resp.Header, nil, "", time.Since(t0).Milliseconds())
	return result
}

// ---------------------------------------------------------------------------
// Probe helper functions
// ---------------------------------------------------------------------------

// probeEndpoint is a generic probe helper that sends a JSON POST request to the
// given endpoint path and returns a ProbeResult.
func (h *Handler) probeEndpoint(ctx context.Context, client *http.Client, baseURL, model, apiKey, path string, body map[string]any, protocol string, authHeader, authVal string, custom customheaders.Config, onOK ProbeQuotaHook, extraHeaders ...string) ProbeResult {
	url := urlutil.BuildUpstreamURL(baseURL, path)
	return doProbe(ctx, client, protocol, http.MethodPost, url, "application/json", authHeader, authVal, body, custom, onOK, extraHeaders...)
}

// ProbeOpenAICompat sends an /v1/chat/completions probe request (OpenAI Chat
// Completions compatible).
func (h *Handler) ProbeOpenAICompat(ctx context.Context, client *http.Client, baseURL, model, apiKey string, custom customheaders.Config, onOK ProbeQuotaHook) ProbeResult {
	body := map[string]any{
		"model":      model,
		"messages":   []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"max_tokens": 150,
		"stream":     false,
	}
	return h.probeEndpoint(ctx, client, baseURL, model, apiKey, "/v1/chat/completions", body, probeProtocolOpenAICompat, "Authorization", "Bearer "+apiKey, custom, onOK)
}

// ProbeOpenAIResponses sends an /v1/responses probe request (OpenAI Responses API).
func (h *Handler) ProbeOpenAIResponses(ctx context.Context, client *http.Client, baseURL, model, apiKey string, custom customheaders.Config, onOK ProbeQuotaHook) ProbeResult {
	body := map[string]any{
		"model":             model,
		"input":             []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"max_output_tokens": 150,
		"stream":            false,
	}
	return h.probeEndpoint(ctx, client, baseURL, model, apiKey, "/v1/responses", body, probeProtocolOpenAIResponses, "Authorization", "Bearer "+apiKey, custom, onOK)
}

// ProbeAnthropic sends an /v1/messages probe request (Anthropic Messages API).
func (h *Handler) ProbeAnthropic(ctx context.Context, client *http.Client, baseURL, model, apiKey string, custom customheaders.Config, onOK ProbeQuotaHook) ProbeResult {
	body := map[string]any{
		"model":      model,
		"max_tokens": 150,
		"messages":   []map[string]any{{"role": "user", "content": probeTestPrompt}},
		"stream":     false,
	}
	return h.probeEndpoint(ctx, client, baseURL, model, apiKey, "/v1/messages", body, probeProtocolAnthropic, "x-api-key", apiKey, custom, onOK, "anthropic-version", "2023-06-01")
}

// ProbeOpenAIEmbedding sends an /v1/embeddings probe request (OpenAI Embeddings API).
func (h *Handler) ProbeOpenAIEmbedding(ctx context.Context, client *http.Client, baseURL, model, apiKey string, custom customheaders.Config, onOK ProbeQuotaHook) ProbeResult {
	body := map[string]any{
		"model": model,
		"input": probeEmbeddingTestInput,
	}
	res := h.probeEndpoint(ctx, client, baseURL, model, apiKey, "/v1/embeddings", body, probeProtocolOpenAIEmbedding, "Authorization", "Bearer "+apiKey, custom, onOK)
	if res.Ok {
		dim, err := extractEmbeddingDim(res.ResponseBodyRaw)
		if err != "" {
			res.Ok = false
			res.Error = "invalid embedding response: " + err
		} else {
			res.EmbeddingDim = dim
		}
	}
	return res
}

// doProbe performs a single JSON POST probe and normalizes the result into a ProbeResult.
func doProbe(ctx context.Context, client *http.Client, protocol, method, url, contentType, authKey, authVal string, body map[string]any, custom customheaders.Config, onOK ProbeQuotaHook, extraHeaders ...string) ProbeResult {
	res := ProbeResult{Protocol: protocol}

	rawBody, err := json.Marshal(body)
	if err != nil {
		res.Error = "failed to encode request: " + err.Error()
		return res
	}
	rawStr := string(rawBody)

	var parsedReqBody any = rawStr
	if j := map[string]any{}; json.Unmarshal(rawBody, &j) == nil {
		parsedReqBody = j
	}

	req, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(rawStr))
	if err != nil {
		res.Error = "invalid URL: " + err.Error()
		return res
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set(authKey, authVal)
	for i := 0; i+1 < len(extraHeaders); i += 2 {
		req.Header.Set(extraHeaders[i], extraHeaders[i+1])
	}
	// Per-provider custom headers augment the generated auth/content-type
	// headers and may override same-named ones.
	customheaders.Apply(req.Header, custom.Enabled, custom.Headers)

	start := time.Now()
	resp, err := client.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
		res.Status = 0
		safe := redactAuth(req.Header)
		res.Request = map[string]any{
			"method":  method,
			"url":     url,
			"headers": headerToMap(safe),
			"body":    parsedReqBody,
			"bodyRaw": rawStr,
		}
		return res
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	raw := string(respBody)
	var parsedResp any = raw
	if j := map[string]any{}; json.Unmarshal(respBody, &j) == nil {
		parsedResp = j
	}
	res.Status = resp.StatusCode
	res.ResponseHeaders = headerToMap(resp.Header)
	res.ResponseBody = parsedResp
	res.ResponseBodyRaw = raw

	var errMsg string
	statusText := http.StatusText(resp.StatusCode)
	statusCode := strconv.Itoa(resp.StatusCode)
	ok := resp.StatusCode == http.StatusOK
	if !ok {
		errMsg = "upstream returned " + statusText + " (status " + statusCode + ")"
		if e := extractErrorMsg(raw); e != "" {
			errMsg = "upstream returned " + statusText + " (status " + statusCode + "): " + e
		}
	}
	if ok {
		if e := extractErrorMsg(raw); e != "" {
			ok = false
			errMsg = "upstream returned " + statusText + " (status " + statusCode + "): " + e
		}
	}
	res.Ok = ok
	res.Error = errMsg

	if ok {
		res.OutputTokens = extractOutputTokens(raw)
		if res.LatencyMs > 0 && res.OutputTokens > 0 {
			res.TokensPerSec = float64(res.OutputTokens) / (float64(res.LatencyMs) / 1000.0)
		}
		if onOK != nil {
			onOK(protocol, resp)
		}
	}

	safe := redactAuth(req.Header)
	res.Request = map[string]any{
		"method":  method,
		"url":     url,
		"headers": headerToMap(safe),
		"body":    parsedReqBody,
		"bodyRaw": rawStr,
	}
	return res
}

// extractErrorMsg pulls a top-level "error.message" (object or string) from a
// raw JSON response body.
func extractErrorMsg(raw string) string {
	var errResp map[string]any
	if json.Unmarshal([]byte(raw), &errResp) != nil {
		return ""
	}
	if e, ok := errResp["error"].(map[string]any); ok {
		if msg, ok := e["message"].(string); ok {
			return msg
		}
	} else if e, ok := errResp["error"].(string); ok {
		return e
	}
	return ""
}

// redactAuth returns a clone of h with the auth headers removed before logging.
func redactAuth(h http.Header) http.Header {
	safe := h.Clone()
	safe.Del("Authorization")
	safe.Del("X-Api-Key")
	safe.Del("x-api-key")
	return safe
}

// extractOutputTokens parses output token count from an upstream response body.
func extractOutputTokens(raw string) int {
	var resp map[string]any
	if json.Unmarshal([]byte(raw), &resp) != nil {
		return 0
	}
	if usage, ok := resp["usage"].(map[string]any); ok {
		if ct, ok := usage["completion_tokens"].(float64); ok && ct > 0 {
			return int(ct)
		}
		if ot, ok := usage["output_tokens"].(float64); ok && ot > 0 {
			return int(ot)
		}
	}
	text := extractTextFromResponse(resp)
	if len(text) > 0 {
		runes := []rune(text)
		est := int(float64(len(runes)) / 3.5)
		if est < 1 {
			est = 1
		}
		return est
	}
	return 0
}

// extractTextFromResponse tries to extract generated text from OpenAI compat,
// OpenAI responses, or Anthropic response JSONs.
func extractTextFromResponse(resp map[string]any) string {
	var sb strings.Builder
	if choices, ok := resp["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if msg, ok := choice["message"].(map[string]any); ok {
				if content, ok := msg["content"].(string); ok {
					sb.WriteString(content)
				}
			} else if text, ok := choice["text"].(string); ok {
				sb.WriteString(text)
			}
		}
	}
	if output, ok := resp["output"].([]any); ok && len(output) > 0 {
		for _, item := range output {
			if m, ok := item.(map[string]any); ok {
				if content, ok := m["content"].([]any); ok {
					for _, c := range content {
						if cm, ok := c.(map[string]any); ok {
							if text, ok := cm["text"].(string); ok {
								sb.WriteString(text)
							}
						}
					}
				}
			}
		}
	}
	if content, ok := resp["content"].([]any); ok && len(content) > 0 {
		for _, c := range content {
			if cm, ok := c.(map[string]any); ok {
				if text, ok := cm["text"].(string); ok {
					sb.WriteString(text)
				}
			}
		}
	}
	return sb.String()
}

// extractContentFromSSE extracts the text content from a single SSE data chunk JSON payload.
func extractContentFromSSE(body []byte) string {
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		return ""
	}
	choices, ok := resp["choices"].([]any)
	if !ok || len(choices) == 0 {
		return ""
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return ""
	}
	delta, ok := choice["delta"].(map[string]any)
	if !ok {
		return ""
	}
	var sb strings.Builder
	if c, ok := delta["content"].(string); ok {
		sb.WriteString(c)
	}
	if rc, ok := delta["reasoning_content"].(string); ok {
		sb.WriteString(rc)
	}
	return sb.String()
}

// headerToMap converts an http.Header to a map[string][]string,
// preserving multi-value structure without filtering or merging.
func headerToMap(h http.Header) map[string][]string {
	m := make(map[string][]string, len(h))
	for k, v := range h {
		m[k] = v
	}
	return m
}

// extractEmbeddingDim parses the embedding vector dimension from an upstream
// /v1/embeddings response body.
func extractEmbeddingDim(raw string) (int, string) {
	var resp map[string]any
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		return 0, "response is not valid JSON"
	}
	dataArr, ok := resp["data"].([]any)
	if !ok || len(dataArr) == 0 {
		return 0, "missing or empty 'data' array"
	}
	firstObj, ok := dataArr[0].(map[string]any)
	if !ok {
		return 0, "first data element is not an object"
	}
	embeddingArr, ok := firstObj["embedding"].([]any)
	if !ok {
		return 0, "missing or invalid 'embedding' array"
	}
	if len(embeddingArr) == 0 {
		return 0, "embedding array is empty"
	}
	return len(embeddingArr), ""
}

// probeResultToMap converts a ProbeResult into the JSON map shape returned to
// the client.
func probeResultToMap(res ProbeResult) map[string]any {
	return map[string]any{
		"protocol":        res.Protocol,
		"ok":              res.Ok,
		"status":          res.Status,
		"latencyMs":       res.LatencyMs,
		"outputTokens":    res.OutputTokens,
		"tokensPerSec":    res.TokensPerSec,
		"embeddingDim":    res.EmbeddingDim,
		"error":           res.Error,
		"skipped":         res.Skipped,
		"request":         res.Request,
		"responseHeaders": res.ResponseHeaders,
		"responseBody":    res.ResponseBody,
		"responseBodyRaw": res.ResponseBodyRaw,
	}
}

// contextWithOverallTimeout returns a child context bounded by overall.
func contextWithOverallTimeout(r *http.Request, overall time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), overall)
}

// firstActiveKey returns the first active key for a provider, or nil if none found.
func firstActiveKey(provider *config.Provider) *config.Key {
	for i := range provider.Keys {
		if provider.Keys[i].IsActive {
			return &provider.Keys[i]
		}
	}
	return nil
}
