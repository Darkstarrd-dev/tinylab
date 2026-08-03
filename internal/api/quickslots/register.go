// Package quickslots provides HTTP handlers for the QuickSlot CRUD API.
// QuickSlots share the same CRUD shape as Combos, allowing users to save
// and quickly switch between model slot configurations.
package quickslots

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Handler wires up QuickSlot routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new QuickSlot handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the QuickSlot routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/quickslots", h.listQuickSlots)
	r.Post("/quickslots", h.createQuickSlot)
	r.Put("/quickslots/{id}", h.updateQuickSlot)
	r.Delete("/quickslots/{id}", h.deleteQuickSlot)
}

// listQuickSlots returns all configured quickslots.
// GET /api/quickslots
func (h *Handler) listQuickSlots(w http.ResponseWriter, r *http.Request) {
	quickslots := h.d.Reg.ListQuickSlots()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"quickslots": quickslots})
}

// createQuickSlot creates a new quickslot.
// POST /api/quickslots
func (h *Handler) createQuickSlot(w http.ResponseWriter, r *http.Request) {
	var qs config.QuickSlot
	if err := json.NewDecoder(r.Body).Decode(&qs); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if qs.ID == "" {
		qs.ID = apibase.GenerateID("qs")
	}
	for h.d.Reg.HasQuickSlot(qs.ID) {
		qs.ID = apibase.GenerateID("qs")
	}
	h.d.Reg.AddQuickSlot(qs)
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfig(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(qs)
}

// updateQuickSlot updates an existing quickslot by ID.
// PUT /api/quickslots/{id}
func (h *Handler) updateQuickSlot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var updates config.QuickSlot
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if h.d.Reg.UpdateQuickSlot(id, updates) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "quickslot not found")
	}
}

// deleteQuickSlot deletes a quickslot by ID.
// DELETE /api/quickslots/{id}
func (h *Handler) deleteQuickSlot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteQuickSlot(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "quickslot not found")
	}
}
