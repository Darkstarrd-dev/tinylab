// Package combos provides HTTP handlers for combo CRUD and speed-test endpoints.
package combos

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/customheaders"
	"github.com/tinyrouter/tinyrouter/internal/sse"
	"github.com/tinyrouter/tinyrouter/internal/urlutil"
	"github.com/tinyrouter/tinyrouter/internal/util"
)

const (
	speedTestPrompt    = "请写一篇约1000字的短篇小说"
	speedTestMaxTokens = 1200
	speedTestMinChunks = 60 // early-stop: enough chunks for a meaningful speed measurement
	speedTestMaxSec    = 30 // early-stop: max streaming seconds per model
)

var comboSpeedCache = struct {
	mu      sync.RWMutex
	results map[string][]comboSpeedTestResult
}{results: make(map[string][]comboSpeedTestResult)}

// comboSpeedTestInput is a resolved probe input for a single model in the combo.
type comboSpeedTestInput struct {
	fullId   string // "prefix/modelId"
	provider *config.Provider
	modelId  string // resolved real model ID (from ModelDef.ID or the original)
	key      *config.Key
}

// comboSpeedTestResult is the measurement result for one model, streamed to the
// frontend as a JSON-serialized SSE event payload.
type comboSpeedTestResult struct {
	FullId       string  `json:"fullId"`
	ProviderId   string  `json:"providerId"`
	Ok           bool    `json:"ok"`
	TTFTMs       int64   `json:"ttftMs"`
	LatencyMs    int64   `json:"latencyMs"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	TokensPerSec float64 `json:"tokensPerSec"`
	Score        float64 `json:"score"`
	Status       int     `json:"status"`
	Error        string  `json:"error,omitempty"`
}

// Handler implements HTTP handlers for the combos API.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new combos Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers all combo routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/combos", h.listCombos)
	r.Post("/combos", h.createCombo)
	r.Put("/combos/{id}", h.updateCombo)
	r.Delete("/combos/{id}", h.deleteCombo)
	r.Post("/combos/{id}/speed-test", h.speedTestCombo)
	r.Get("/combos/{id}/speed-results", h.getComboSpeedResults)
}

// --- Combos ---

func (h *Handler) listCombos(w http.ResponseWriter, r *http.Request) {
	combos := h.d.Reg.ListCombos()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"combos": combos})
}

func (h *Handler) createCombo(w http.ResponseWriter, r *http.Request) {
	var c config.Combo
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if c.ID == "" {
		c.ID = apibase.GenerateID("combo")
	}
	for h.d.Reg.HasCombo(c.ID) {
		c.ID = apibase.GenerateID("combo")
	}
	h.d.Reg.AddCombo(c)
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(c)
}

func (h *Handler) updateCombo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var updates config.Combo
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if h.d.Reg.UpdateCombo(id, updates) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "combo not found")
	}
}

func (h *Handler) deleteCombo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteCombo(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "combo not found")
	}
}

// speedTestCombo is an SSE-streaming handler that measures the output speed of every
// model in a combo concurrently, reorders the Models list from fastest to slowest
// (failures at the end), and persists the new order to config.yaml.
func (h *Handler) speedTestCombo(w http.ResponseWriter, r *http.Request) {
	comboID := chi.URLParam(r, "id")
	combo, ok := h.d.Reg.GetComboByID(comboID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "combo not found")
		return
	}

	// Collect all models to probe — including disabled models.
	allModels := make([]string, 0, len(combo.Models)+len(combo.DisabledModels))
	allModels = append(allModels, combo.Models...)
	allModels = append(allModels, combo.DisabledModels...)
	if len(allModels) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "combo has no models to test")
		return
	}

	// Resolve each model string to a probe input.
	inputs := make([]comboSpeedTestInput, 0, len(allModels))
	providers := h.d.Reg.ListProviders()

	for _, m := range allModels {
		prefix, modelId, found := strings.Cut(m, "/")
		if !found {
			// Malformed model string — no "/" separator.
			inputs = append(inputs, comboSpeedTestInput{
				fullId:  m,
				modelId: m,
			})
			continue
		}

		// Find the provider by prefix.
		var provider *config.Provider
		for i := range providers {
			if providers[i].Prefix == prefix {
				provider = &providers[i]
				break
			}
		}
		if provider == nil {
			inputs = append(inputs, comboSpeedTestInput{
				fullId:  m,
				modelId: modelId,
			})
			continue
		}

		// Resolve alias: if the modelId matches a ModelDef.Alias, use the real ID.
		realModelId := modelId
		for _, md := range provider.Models {
			if md.ID == modelId || md.Alias == modelId {
				realModelId = md.ID
				break
			}
		}

		// Pick the first active key.
		key := firstActiveKey(provider)
		if key == nil {
			inputs = append(inputs, comboSpeedTestInput{
				fullId:   m,
				provider: provider,
				modelId:  realModelId,
			})
			continue
		}

		inputs = append(inputs, comboSpeedTestInput{
			fullId:   m,
			provider: provider,
			modelId:  realModelId,
			key:      key,
		})
	}

	// --- SSE stream setup ---
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// meta event
	if metaJSON, err := json.Marshal(map[string]int{"total": len(inputs)}); err == nil {
		fmt.Fprintf(w, "event: meta\ndata: %s\n\n", metaJSON)
		flusher.Flush()
	}

	// All models are probed concurrently. Use a timeout context so no single
	// slow model can hold the stream open indefinitely.
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	type resultWithIndex struct {
		idx    int
		result comboSpeedTestResult
	}
	ch := make(chan resultWithIndex, len(inputs))

	var wg sync.WaitGroup
	for i, in := range inputs {
		if in.provider == nil || in.key == nil {
			// No provider or no key — immediate failure.
			res := comboSpeedTestResult{
				FullId:     in.fullId,
				ProviderId: "",
				Ok:         false,
				Error:      "no provider or no active key",
			}
			ch <- resultWithIndex{idx: i, result: res}
			continue
		}
		wg.Add(1)
		go func(idx int, input comboSpeedTestInput) {
			defer wg.Done()
			chatURL := urlutil.BuildUpstreamURL(input.provider.BaseURL, "/v1/chat/completions")
			res := probeComboModel(ctx, h, input, chatURL)
			ch <- resultWithIndex{idx: idx, result: res}
		}(i, in)
	}

	// Close the channel when all goroutines finish.
	go func() {
		wg.Wait()
		close(ch)
	}()

	// Collect results in order.
	results := make([]comboSpeedTestResult, len(inputs))
	okCount, failCount := 0, 0
	for rwi := range ch {
		results[rwi.idx] = rwi.result
		// Push a model event as soon as each result arrives.
		if b, err := json.Marshal(rwi.result); err == nil {
			fmt.Fprintf(w, "event: model\ndata: %s\n\n", b)
			flusher.Flush()
		}
	}

	// Count ok/fail after all results are collected.
	for _, res := range results {
		if res.Ok {
			okCount++
		} else {
			failCount++
		}
	}

	// Sort: ok models by composite Score desc, then TokensPerSec desc, then LatencyMs asc; failures at the end.
	sort.SliceStable(results, func(i, j int) bool {
		ri, rj := results[i], results[j]
		if ri.Ok != rj.Ok {
			return ri.Ok
		}
		if !ri.Ok {
			return false
		}
		if ri.Score != rj.Score {
			return ri.Score > rj.Score
		}
		if ri.TokensPerSec != rj.TokensPerSec {
			return ri.TokensPerSec > rj.TokensPerSec
		}
		return ri.LatencyMs < rj.LatencyMs
	})

	// Cache the full sorted results for the GET endpoint.
	comboSpeedCache.mu.Lock()
	comboSpeedCache.results[comboID] = append([]comboSpeedTestResult{}, results...)
	comboSpeedCache.mu.Unlock()

	// Split sorted results into enabled/disabled, preserving each model's original
	// disabled flag. Both groups are sorted by measured speed (failures at the end
	// within each group), so the relative order of enabled vs disabled is preserved
	// while each group is reordered by speed.
	disabledSet := make(map[string]bool, len(combo.DisabledModels))
	for _, m := range combo.DisabledModels {
		disabledSet[m] = true
	}
	newModels := make([]string, 0, len(combo.Models))
	newDisabledModels := make([]string, 0, len(combo.DisabledModels))
	for _, res := range results {
		if !res.Ok {
			newDisabledModels = append(newDisabledModels, res.FullId)
		} else {
			newModels = append(newModels, res.FullId)
		}
	}

	// Persist: update combo and save config.
	h.d.Reg.UpdateCombo(comboID, config.Combo{
		Name:           combo.Name,
		Strategy:       combo.Strategy,
		Models:         newModels,
		Disabled:       combo.Disabled,
		DisabledModels: newDisabledModels,
	})
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		saveErr := fmt.Sprintf("speed test completed but failed to persist: %v", err)
		h.d.Logger.Error("SPEED-TEST %s | %s", combo.Name, saveErr)
		// Push a partial error event so the frontend knows the order was not saved.
		if doneJSON, jErr := json.Marshal(map[string]any{
			"ok":          okCount,
			"fail":        failCount,
			"total":       len(results),
			"results":     results,
			"newOrder":    fullSortedOrder(results),
			"newModels":   newModels,
			"newDisabled": newDisabledModels,
			"warning":     saveErr,
		}); jErr == nil {
			fmt.Fprintf(w, "event: done\ndata: %s\n\n", doneJSON)
			flusher.Flush()
		}
		return
	}

	h.d.Logger.Info("SPEED-TEST %s | ok=%d fail=%d total=%d | saved %d models", combo.Name, okCount, failCount, len(results), len(newModels))

	// done event
	if doneJSON, err := json.Marshal(map[string]any{
		"ok":          okCount,
		"fail":        failCount,
		"total":       len(results),
		"results":     results,
		"newOrder":    fullSortedOrder(results),
		"newModels":   newModels,
		"newDisabled": newDisabledModels,
	}); err == nil {
		fmt.Fprintf(w, "event: done\ndata: %s\n\n", doneJSON)
		flusher.Flush()
	}
}

func (h *Handler) getComboSpeedResults(w http.ResponseWriter, r *http.Request) {
	comboID := chi.URLParam(r, "id")
	comboSpeedCache.mu.RLock()
	results, ok := comboSpeedCache.results[comboID]
	comboSpeedCache.mu.RUnlock()
	if !ok || len(results) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"results": nil})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"results": results})
}

// fullSortedOrder returns the full sorted FullId list (enabled followed by
// disabled), preserving the speed-test ordering computed by speedTestCombo.
func fullSortedOrder(results []comboSpeedTestResult) []string {
	out := make([]string, len(results))
	for i, r := range results {
		out[i] = r.FullId
	}
	return out
}

// probeComboModel performs a single streaming probe against one model, measuring
// its output speed. It follows the same SSE-streaming pattern as probeSingleKey
// (internal/api/probe_keys.go:254-383) but uses different early-stop thresholds
// and does not parse quota headers.
func probeComboModel(ctx context.Context, h *Handler, input comboSpeedTestInput, chatURL string) comboSpeedTestResult {
	res := comboSpeedTestResult{
		FullId:     input.fullId,
		ProviderId: input.provider.ID,
	}

	bodyMap := map[string]any{
		"model": input.modelId,
		"messages": []map[string]string{
			{"role": "user", "content": speedTestPrompt},
		},
		"max_tokens": speedTestMaxTokens,
		"stream":     true,
	}
	bodyBytes, _ := json.Marshal(bodyMap)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", chatURL, bytes.NewReader(bodyBytes))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+input.key.Key)
	httpReq.Header.Set("Accept", "text/event-stream")
	customheaders.Apply(httpReq.Header, input.provider.UseCustomHeaders, input.provider.CustomHeaders)

	h.d.Logger.Debug("SPEED-TEST SEND %s/%s | url=%s", input.provider.Name, input.modelId, chatURL)

	t0 := time.Now()
	resp, err := h.d.ProxyHandler.ManagementClient(*input.provider).Do(httpReq)
	if err != nil {
		h.d.Logger.Error("SPEED-TEST ERR %s/%s | %v", input.provider.Name, input.modelId, err)
		res.Error = err.Error()
		res.LatencyMs = time.Since(t0).Milliseconds()
		return res
	}
	h.d.ProxyHandler.TraceMgmtCall("probe:combo:provider="+input.provider.ID+":model="+input.modelId+":key="+input.key.ID, "probe", "probe", input.modelId, input.provider.Name, chatURL, httpReq.Header, bodyBytes, 0, nil, nil, err.Error(), time.Since(t0).Milliseconds())

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		errMsg := strings.TrimSpace(string(errBody))
		if len(errMsg) > 500 {
			errMsg = errMsg[:500]
		}
		h.d.Logger.Warn("SPEED-TEST %d %s/%s | body=%s", resp.StatusCode, input.provider.Name, input.modelId, util.TruncStr(errMsg, 200))
		res.Status = resp.StatusCode
		res.Error = errMsg
		res.LatencyMs = time.Since(t0).Milliseconds()
		return res
	}
	h.d.ProxyHandler.TraceMgmtCall("probe:combo:provider="+input.provider.ID+":model="+input.modelId+":key="+input.key.ID, "probe", "probe", input.modelId, input.provider.Name, chatURL, httpReq.Header, bodyBytes, resp.StatusCode, resp.Header, nil, "", time.Since(t0).Milliseconds())

	var ttftMs int64
	inputTokens := 0
	outputTokens := 0
	var contentChunks int
	var contentBuf strings.Builder
	buf := make([]byte, 32*1024)
	sb := &sse.SSELineBuffer{}

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if ttftMs == 0 {
				ttftMs = time.Since(t0).Milliseconds()
				h.d.Logger.Debug("SPEED-TEST STREAM %s/%s | TTFT=%dms", input.provider.Name, input.modelId, ttftMs)
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
			// Early termination: enough content chunks or streamed long enough
			if contentChunks >= speedTestMinChunks || time.Since(t0).Seconds() > speedTestMaxSec {
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

	h.d.Logger.Info("SPEED-TEST %s/%s | OK | ttft=%dms out=%d | %.1f tok/s", input.provider.Name, input.modelId, ttftMs, outputTokens, tokensPerSec)

	res.Ok = true
	res.Status = 200
	res.TTFTMs = ttftMs
	res.LatencyMs = totalMs
	res.InputTokens = inputTokens
	res.OutputTokens = outputTokens
	res.TokensPerSec = tokensPerSec
	h.d.ProxyHandler.TraceMgmtCall("probe:combo:provider="+input.provider.ID+":model="+input.modelId+":key="+input.key.ID, "probe", "probe", input.modelId, input.provider.Name, chatURL, httpReq.Header, bodyBytes, resp.StatusCode, resp.Header, nil, "", time.Since(t0).Milliseconds())
	res.Score = tokensPerSec / (1 + float64(ttftMs)/1500.0)
	return res
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

// extractContentFromSSE extracts the text content (both delta.content and
// delta.reasoning_content) from a single SSE data chunk JSON payload.
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
