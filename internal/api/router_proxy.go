// Package api provides HTTP handlers for the management REST API.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
)

// registerProxyRoutes mounts all OpenAI-compatible proxy endpoints and the
// CORS preflight handler for /v1/*. Kept separate from the management /api
// backbone so proxy concerns can evolve without touching core routing.
func (rt *Router) registerProxyRoutes(r chi.Router, proxyHandler *proxy.Handler) {
	// CORS preflight for proxy routes only (/v1/*). Management /api/* routes
	// have NO CORS — the admin UI is same-origin and external pages must not
	// be able to read/modify config or steal API keys via cross-origin fetch.
	r.Options("/v1/*", func(w http.ResponseWriter, req *http.Request) {
		origin := req.Header.Get("Origin")
		if origin != "" && isLocalhostOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Expose-Headers", "X-TinyRouter-Provider, X-TinyRouter-Key")
		w.WriteHeader(http.StatusNoContent)
	})

	// Proxy routes (OpenAI-compatible)
	r.Post("/v1/chat/completions", proxyHandler.ChatCompletions)
	r.Post("/v1/completions", proxyHandler.Completions)
	r.Get("/v1/models", proxyHandler.ListModels)
	r.Post("/v1/images/generations", proxyHandler.ImagesGenerations)
	r.Post("/v1/images/edits", proxyHandler.ImagesEdits)
	r.Post("/v1/embeddings", proxyHandler.Embeddings)
	// Proxy route (Anthropic protocol). Anthropic /v1/messages has no GET
	// semantics, so only POST is registered. CORS is handled by the
	// path-prefix `/v1/*` OPTIONS handler above — no extra config needed.
	r.Post("/v1/messages", proxyHandler.Messages)
	// Proxy route (OpenAI Responses protocol). POST only; CORS is handled by the
	// path-prefix `/v1/*` OPTIONS handler above — no extra config needed. Transparent
	// passthrough using the standard Authorization: Bearer header.
	r.Post("/v1/responses", proxyHandler.Responses)
	// Proxy route (Google native generateContent protocol). POST only; CORS is handled by the
	// path-prefix `/v1/*` OPTIONS handler above — no extra config needed. Transparent
	// passthrough using x-goog-api-key and model-in-path URL.
	r.Post("/v1/generateContent", proxyHandler.GenerateContent)
	r.Post("/v1/tasks/{taskId}", proxyHandler.PollTask)
	r.Get("/v1/tasks/{taskId}", func(w http.ResponseWriter, req *http.Request) {
		taskID := chi.URLParam(req, "taskId")
		modelStr := req.URL.Query().Get("model")
		proxyHandler.TaskGet(w, req, taskID, modelStr)
	})
}
