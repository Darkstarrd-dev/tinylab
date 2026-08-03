// Package review_presets provides HTTP handlers for the ReviewPresets CRUD API.
package review_presets

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Handler wires up review-preset routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new review-presets Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the review-preset routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/review-presets", h.listReviewPresets)
	r.Post("/review-presets", h.upsertReviewPreset)
	r.Delete("/review-presets/{id}", h.deleteReviewPreset)
}

// listReviewPresets returns all review presets.
// GET /api/review-presets
func (h *Handler) listReviewPresets(w http.ResponseWriter, r *http.Request) {
	presets := h.d.Reg.ListReviewPresets()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"presets": presets})
}

// upsertReviewPreset handles both create (no ID) and update (with ID) operations.
// POST /api/review-presets
func (h *Handler) upsertReviewPreset(w http.ResponseWriter, r *http.Request) {
	var p config.ReviewPreset
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if p.ID == "" {
		// Create
		p.ID = apibase.GenerateID("rp")
		h.d.Reg.AddReviewPreset(p)
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"preset": p})
	} else {
		// Update
		if h.d.Reg.UpdateReviewPreset(p.ID, p) {
			cfg := h.d.Reg.Config()
			if err := h.d.SaveConfig(&cfg); err != nil {
				apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		} else {
			apibase.WriteAPIError(w, http.StatusNotFound, "review preset not found")
		}
	}
}

// deleteReviewPreset deletes a review preset by ID.
// DELETE /api/review-presets/{id}
func (h *Handler) deleteReviewPreset(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteReviewPreset(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "review preset not found")
	}
}
