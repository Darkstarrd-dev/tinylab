// Package quickslots provides HTTP handlers for the QuickSlot CRUD API.
// QuickSlots share the same CRUD shape as Combos, allowing users to save
// and quickly switch between model slot configurations.
package quickslots

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
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
	r.Patch("/quickslots/{id}/selectedIndex", h.patchQuickSlotSelectedIndex)
	r.Delete("/quickslots/{id}", h.deleteQuickSlot)
	r.Post("/quickslots/cleanup", h.cleanupQuickSlots)
	// QuickSlot Presets
	r.Get("/quickslots/presets", h.listQuickSlotPresets)
	r.Post("/quickslots/presets", h.createQuickSlotPreset)
	r.Post("/quickslots/presets/apply", h.applyQuickSlotPreset)
	r.Delete("/quickslots/presets/{name}", h.deleteQuickSlotPreset)
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
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
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
		if err := h.d.SaveConfigAndReload(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "quickslot not found")
	}
}

// patchQuickSlotSelectedIndex atomically switches the selected model index of
// a quickslot, avoiding the full-PUT race that rapid re-selection can cause
// (a later full PUT could otherwise overwrite a newer SelectedIndex or regress
// it to 0 on an out-of-range index).
// PATCH /api/quickslots/{id}/selectedIndex
func (h *Handler) patchQuickSlotSelectedIndex(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		SelectedIndex int `json:"selectedIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	qs, ok := h.d.Reg.SetQuickSlotSelectedIndex(id, req.SelectedIndex)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "quickslot not found")
		return
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(qs)
}

// deleteQuickSlot deletes a quickslot by ID.
// DELETE /api/quickslots/{id}
func (h *Handler) deleteQuickSlot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if h.d.Reg.DeleteQuickSlot(id) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfigAndReload(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "quickslot not found")
	}
}

// cleanupQuickSlots removes stale quickslot model references (deleted
// providers, models, or combos) and persists the result.
// POST /api/quickslots/cleanup
func (h *Handler) cleanupQuickSlots(w http.ResponseWriter, r *http.Request) {
	removed := h.d.Reg.SweepStaleQuickSlotModels()
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "removed": removed})
}

// --- QuickSlot Presets ---

// listQuickSlotPresets returns all saved QuickSlot presets.
// GET /api/quickslots/presets
func (h *Handler) listQuickSlotPresets(w http.ResponseWriter, r *http.Request) {
	presets := h.d.Reg.ListQuickSlotPresets()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"presets": presets})
}

// createQuickSlotPreset snapshots current QuickSlot configs into a named preset.
// POST /api/quickslots/presets
func (h *Handler) createQuickSlotPreset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Name == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "name is required")
		return
	}
	h.d.Reg.AddQuickSlotPreset(req.Name)
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// applyQuickSlotPreset restores QuickSlot configs from a named preset.
// POST /api/quickslots/presets/apply
func (h *Handler) applyQuickSlotPreset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if !h.d.Reg.ApplyQuickSlotPreset(req.Name) {
		apibase.WriteAPIError(w, http.StatusNotFound, "preset not found")
		return
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// deleteQuickSlotPreset removes a preset by name.
// DELETE /api/quickslots/presets/{name}
func (h *Handler) deleteQuickSlotPreset(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !h.d.Reg.DeleteQuickSlotPreset(name) {
		apibase.WriteAPIError(w, http.StatusNotFound, "preset not found")
		return
	}
	cfg := h.d.Reg.Config()
	if err := h.d.SaveConfigAndReload(&cfg); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
