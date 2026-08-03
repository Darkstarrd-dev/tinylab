// Code in this file: AI review HTTP handlers (Fix 1 split from register.go). Frontend: gallery-review.js.
package gallery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
)

// startReviewRequest is the request body for starting a review.
type startReviewRequest struct {
	SessionID    string `json:"sessionId"`
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	SystemPrompt string `json:"systemPrompt"`
	UserPrompt   string `json:"userPrompt,omitempty"`
	MatchField   string `json:"matchField,omitempty"`
	Strategy     string `json:"strategy"`
	HeadSize     int    `json:"headSize"`
	TailSize     int    `json:"tailSize"`
	Concurrency  int    `json:"concurrency"`
}

// genPromptRequest is the request body for generating a prompt.
type genPromptRequest struct {
	Provider    string `json:"provider"`
	Model       string `json:"model"`
	JudgeTarget string `json:"judgeTarget"`
}

// galleryStartReview launches an AI review task.
//
// POST /api/gallery/review/start
// Content-Type: application/json
//
//	{
//	    "sessionId": "abc123",
//	    "provider": "openai",
//	    "model": "gpt-4o",
//	    "systemPrompt": "...",
//	    "userPrompt": "...",
//	    "matchField": "match",
//	    "strategy": "all",
//	    "headSize": 5,
//	    "tailSize": 5,
//	    "concurrency": 3
//	}
func (h *Handler) galleryStartReview(w http.ResponseWriter, r *http.Request) {
	var req startReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.SessionID == "" || req.Provider == "" || req.Model == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "sessionId, provider, and model are required")
		return
	}
	if req.Strategy == "" {
		req.Strategy = string(gallerylib.ReviewStrategyAll)
	}
	if req.Concurrency <= 0 {
		req.Concurrency = 3
	}
	if req.Concurrency > 50 {
		req.Concurrency = 50
	}
	if req.HeadSize <= 0 {
		req.HeadSize = 5
	}
	if req.TailSize <= 0 {
		req.TailSize = 5
	}
	if req.UserPrompt == "" {
		req.UserPrompt = gallerylib.DefaultUserPrompt
	}

	// Check if a review is already in progress
	if _, loaded := h.reviews.Load(req.SessionID); loaded {
		apibase.WriteAPIError(w, http.StatusConflict, "review already in progress for this session")
		return
	}

	// Get ZIP session data and pin to prevent eviction
	zipData, ok := h.sessions.get(req.SessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
		return
	}
	h.sessions.pin(req.SessionID)

	// Parse manifest to get entry list
	reader := bytes.NewReader(zipData)
	manifest, err := gallerylib.ListZipEntries(reader, int64(len(zipData)))
	if err != nil {
		h.sessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to list zip entries: "+err.Error())
		return
	}

	if manifest.Total == 0 {
		h.sessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "no image entries found in zip")
		return
	}

	// Select entries to review based on strategy
	indices := selectReviewIndices(manifest.Total, req.Strategy, req.HeadSize, req.TailSize)
	if len(indices) == 0 {
		h.sessions.unpin(req.SessionID)
		apibase.WriteAPIError(w, http.StatusBadRequest, "no entries selected for review")
		return
	}

	// Create review task
	ctx, cancel := context.WithCancel(context.Background())
	task := &reviewTask{
		SessionID:    req.SessionID,
		Status:       gallerylib.ReviewStatusRunning,
		Total:        len(indices),
		Results:      make([]gallerylib.ReviewResult, 0),
		SystemPrompt: req.SystemPrompt,
		UserPrompt:   req.UserPrompt,
		MatchField:   req.MatchField,
		cancel:       cancel,
		done:         make(chan struct{}),
	}

	h.reviews.Store(req.SessionID, task)

	// Start review goroutine
	go h.runReview(ctx, task, zipData, manifest.Entries, indices, req.Provider, req.Model, req.Concurrency)

	h.d.Logger.Info("gallery: started AI review for session %s, %d entries, strategy=%s, provider=%s, model=%s",
		req.SessionID, len(indices), req.Strategy, req.Provider, req.Model)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"total":   len(indices),
	})
}

// galleryReviewStatus returns the status of a review task.
//
// GET /api/gallery/review/status/{sessionId}
func (h *Handler) galleryReviewStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	val, ok := h.reviews.Load(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "review task not found")
		return
	}

	task := val.(*reviewTask)
	task.mu.Lock()
	status := task.Status
	total := task.Total
	processed := task.Processed
	failed := task.Failed
	results := make([]gallerylib.ReviewResult, len(task.Results))
	copy(results, task.Results)
	task.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":    status,
		"total":     total,
		"processed": processed,
		"failed":    failed,
		"results":   results,
	})
}

// galleryCancelReview cancels a review task.
//
// POST /api/gallery/review/cancel/{sessionId}
func (h *Handler) galleryCancelReview(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	val, ok := h.reviews.Load(sessionID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "review task not found")
		return
	}

	task := val.(*reviewTask)
	task.cancel()

	// Wait for the task to finish. A worker can be mid-LLM-call when cancel
	// lands (the per-request budget is 45s); unpinning/deleting before done
	// would orphan a worker still reading the session zip. 50s > 45s/req.
	select {
	case <-task.done:
	case <-time.After(50 * time.Second):
		h.d.Logger.Warn("gallery: review cancel timed out for session %s, forcing task cleanup", sessionID)
	}

	// Delete is idempotent
	h.reviews.Delete(sessionID)
	h.sessions.unpin(sessionID)

	h.d.Logger.Info("gallery: cancelled AI review for session %s", sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
	})
}

// galleryGeneratePrompt generates a review prompt.
//
// POST /api/gallery/review/gen-prompt
// Body: {provider, model, judgeTarget}
// Response: {systemPrompt}
func (h *Handler) galleryGeneratePrompt(w http.ResponseWriter, r *http.Request) {
	var req genPromptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.Provider == "" || req.Model == "" || req.JudgeTarget == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "provider, model, and judgeTarget are required")
		return
	}

	body := map[string]any{
		"model": req.Provider + "/" + req.Model,
		"messages": []any{
			map[string]any{
				"role":    "system",
				"content": gallerylib.PromptGenSystemPrompt,
			},
			map[string]any{
				"role":    "user",
				"content": fmt.Sprintf(gallerylib.PromptGenUserPromptTemplate, req.JudgeTarget),
			},
		},
		"max_tokens":  800,
		"temperature": 0.3,
		"stream":      false,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to marshal request: "+err.Error())
		return
	}
	proxyCtx, proxyCancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer proxyCancel()
	proxyReq, err := http.NewRequestWithContext(proxyCtx, "POST", "/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to build proxy request: "+err.Error())
		return
	}
	proxyReq.Header.Set("Content-Type", "application/json")
	proxyReq.Header.Set("X-TinyRouter-Provenance", "gallery:promptgen")
	rec := httptest.NewRecorder()

	h.proxy.ChatCompletions(rec, proxyReq)

	resp := rec.Result()
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read proxy response: "+err.Error())
		return
	}

	if resp.StatusCode != http.StatusOK {
		apibase.WriteAPIError(w, http.StatusBadGateway, fmt.Sprintf("proxy returned status %d: %s", resp.StatusCode, string(respBody)))
		return
	}

	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &chatResp); err != nil || len(chatResp.Choices) == 0 {
		apibase.WriteAPIError(w, http.StatusBadGateway, "failed to parse proxy response")
		return
	}

	systemPrompt := chatResp.Choices[0].Message.Content

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"systemPrompt": systemPrompt,
	})
}
