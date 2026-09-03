package assistant

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/assistant"
)

// getJobs handles GET /api/assistant/jobs
func (h *Handler) getJobs(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	ast := h.ast
	h.mu.RUnlock()

	var jobs []assistant.Job
	if ast != nil && ast.Scheduler() != nil {
		jobs = ast.Scheduler().Jobs()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jobs":  jobs,
		"count": len(jobs),
	})
}

// createJob handles POST /api/assistant/jobs
func (h *Handler) createJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		IntervalSec int    `json:"intervalSec"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" || req.IntervalSec <= 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "name and positive intervalSec required")
		return
	}

	h.mu.RLock()
	ast := h.ast
	h.mu.RUnlock()

	if ast == nil || ast.Scheduler() == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "scheduler not available")
		return
	}

	job := assistant.Job{Name: req.Name, IntervalSec: req.IntervalSec}
	ast.Scheduler().RegisterJob(job)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":  true,
		"job": job,
	})
}

// deleteJob handles DELETE /api/assistant/jobs/{name}
func (h *Handler) deleteJob(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing job name")
		return
	}

	h.mu.RLock()
	ast := h.ast
	h.mu.RUnlock()

	if ast == nil || ast.Scheduler() == nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "scheduler not available")
		return
	}

	if !ast.Scheduler().Has(name) {
		apibase.WriteAPIError(w, http.StatusNotFound, "job not found")
		return
	}

	ast.Scheduler().RemoveJob(name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
