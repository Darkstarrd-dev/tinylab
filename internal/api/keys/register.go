// Package keys provides HTTP handlers for the API key CRUD operations.
package keys

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Handler wires up key routes.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new keys Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers the key routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/providers/{id}/keys", h.listKeys)
	r.Post("/providers/{id}/keys", h.createKey)
	r.Post("/providers/{id}/keys/bulk", h.bulkAddKeys)
	r.Put("/providers/{id}/keys/{kid}", h.updateKey)
	r.Delete("/providers/{id}/keys/{kid}", h.deleteKey)
	r.Get("/providers/{id}/keys/{kid}/state", h.getKeyState)
}

// listKeys returns all keys for a provider.
// GET /api/providers/{id}/keys
func (h *Handler) listKeys(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	provider, ok := h.d.Reg.GetProvider(providerID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"keys": provider.Keys})
}

// createKey creates a new key for a provider.
// POST /api/providers/{id}/keys
func (h *Handler) createKey(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var k config.Key
	if err := json.NewDecoder(r.Body).Decode(&k); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if k.ID == "" {
		k.ID = apibase.GenerateID("key")
	}
	for h.d.Reg.HasKey(providerID, k.ID) {
		k.ID = apibase.GenerateID("key")
	}
	k.IsActive = true
	if k.Name == "" {
		if provider, ok := h.d.Reg.GetProvider(providerID); ok {
			k.Name = "Key-" + strconv.Itoa(len(provider.Keys)+1)
		}
	}
	if h.d.Reg.AddKey(providerID, k) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(k)
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "provider not found")
	}
}

// bulkAddKeys adds multiple keys at once.
// POST /api/providers/{id}/keys/bulk
func (h *Handler) bulkAddKeys(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Keys []struct {
			Name     string `json:"name"`
			Key      string `json:"key"`
			Priority int    `json:"priority"`
			Account  string `json:"account"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	added := 0
	var errors []map[string]any

	// Capture current key count for auto-naming offset
	offset := 0
	if provider, ok := h.d.Reg.GetProvider(providerID); ok {
		offset = len(provider.Keys)
	}

	for i, k := range req.Keys {
		if k.Key == "" {
			errors = append(errors, map[string]any{"index": i, "error": "empty key"})
			continue
		}
		name := k.Name
		if name == "" {
			name = "Key-" + strconv.Itoa(offset+i+1)
		}
		priority := k.Priority
		if priority == 0 {
			priority = 1
		}
		newKey := config.Key{
			ID:       apibase.GenerateID("key"),
			Key:      k.Key,
			Name:     name,
			Priority: priority,
			IsActive: true,
			Account:  k.Account,
		}
		if h.d.Reg.AddKey(providerID, newKey) {
			added++
		} else {
			errors = append(errors, map[string]any{"index": i, "error": "provider not found"})
		}
	}

	cfg := h.d.Reg.Config()
	saveErr := h.d.SaveConfig(&cfg)
	w.Header().Set("Content-Type", "application/json")
	if saveErr != nil {
		json.NewEncoder(w).Encode(map[string]any{
			"added":   added,
			"errors":  errors,
			"warning": "keys added in memory but failed to persist: " + saveErr.Error(),
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{
		"added":  added,
		"errors": errors,
	})
}

// updateKey updates an existing key.
// PUT /api/providers/{id}/keys/{kid}
func (h *Handler) updateKey(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	keyID := chi.URLParam(r, "kid")
	var updates config.Key
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if h.d.Reg.UpdateKey(providerID, keyID, updates) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "key not found")
	}
}

// deleteKey deletes a key.
// DELETE /api/providers/{id}/keys/{kid}
func (h *Handler) deleteKey(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	keyID := chi.URLParam(r, "kid")
	if h.d.Reg.DeleteKey(providerID, keyID) {
		cfg := h.d.Reg.Config()
		if err := h.d.SaveConfig(&cfg); err != nil {
			apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		apibase.WriteAPIError(w, http.StatusNotFound, "key not found")
	}
}

// getKeyState returns the current state of a key (locks, backoff, etc.).
// GET /api/providers/{id}/keys/{kid}/state
func (h *Handler) getKeyState(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	keyID := chi.URLParam(r, "kid")
	state := h.d.Reg.GetKeyState(providerID, keyID)
	if state == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "key state not found")
		return
	}
	state.Lock()
	defer state.Unlock()
	locks := make(map[string]string)
	statuses := make(map[string]string)
	errors := make(map[string]string)
	now := time.Now()
	active := true
	for m, t := range state.ModelLocks {
		locks[m] = t.Format("2006-01-02T15:04:05Z07:00")
		st := state.ModelStatus[m]
		if st == "" {
			st = "cooldown"
		}
		statuses[m] = st
		if now.Before(t) {
			active = false
		}
		if err, ok := state.ModelErrors[m]; ok {
			errors[m] = err
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":       map[bool]string{true: "active", false: "cooldown"}[active],
		"backoffLevel": state.BackoffLevel,
		"modelLocks":   locks,
		"modelStatus":  statuses,
		"modelErrors":  errors,
		"lastUsedAt":   state.LastUsedAt.Format("2006-01-02T15:04:05Z07:00"),
		"consecCount":  state.ConsecCount,
		"lastError":    "",
	})
}
