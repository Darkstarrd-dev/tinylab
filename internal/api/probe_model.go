package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// testProviderModelProtoRequest is the JSON body for POST
// /api/providers/{id}/models/test-proto.
type testProviderModelProtoRequest struct {
	Model string `json:"model"`
	Proto string `json:"proto"`
}

// testProviderModelProto probes a single protocol for a given model on a
// provider. It does NOT persist any state — the caller (frontend) decides what
// to do with the result.
//
// Request:  {"model":"<modelId>","proto":"openai-compat"|"openai-responses"|"anthropic"}
// Response: single-probe result (same shape as the per-protocol sub-objects in
// the old /test endpoint).
func (rt *Router) testProviderModelProto(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := rt.reg.GetProvider(providerID)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	var req testProviderModelProtoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if req.Proto != config.ProtocolOpenAICompat &&
		req.Proto != config.ProtocolOpenAIResponses &&
		req.Proto != config.ProtocolAnthropic &&
		req.Proto != config.ProtocolOpenAIEmbedding {
		writeAPIError(w, http.StatusBadRequest, "invalid proto: must be one of openai-compat, openai-responses, anthropic, openai-embedding")
		return
	}

	key := firstActiveKey(provider)
	if key == nil {
		writeAPIError(w, http.StatusBadRequest, "no active key for this provider")
		return
	}

	client := rt.proxyHandler.ManagementClient(*provider)

	ctx, cancel := contextWithOverallTimeout(r, 30*time.Second)
	defer cancel()

	var res ProbeResult
	switch req.Proto {
	case config.ProtocolOpenAICompat:
		res = probeOpenAICompat(ctx, client, provider.BaseURL, req.Model, key.Key, nil)
	case config.ProtocolOpenAIResponses:
		res = probeOpenAIResponses(ctx, client, provider.BaseURL, req.Model, key.Key, nil)
	case config.ProtocolAnthropic:
		res = probeAnthropic(ctx, client, provider.BaseURL, req.Model, key.Key, nil)
	case config.ProtocolOpenAIEmbedding:
		res = probeOpenAIEmbedding(ctx, client, provider.BaseURL, req.Model, key.Key, nil)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(probeResultToMap(res))
}

// contextWithOverallTimeout returns a child context bounded by overall. It
// falls back to r.Context() if that is already shorter.
func contextWithOverallTimeout(r *http.Request, overall time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), overall)
}

// probeResultToMap converts a ProbeResult into the JSON map shape returned to
// the client (request/responseHeaders/responseBody/responseBodyRaw + status).
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
