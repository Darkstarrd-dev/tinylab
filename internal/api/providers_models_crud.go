package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// --- Provider Model CRUD ---

// addProviderModel adds a custom model ID to a provider.
// Request: {model}
func (rt *Router) addProviderModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}

	// Check provider existence first so we can return the correct status.
	if _, ok := rt.reg.GetProvider(providerID); !ok {
		writeAPIError(w, http.StatusNotFound, "provider not found")
		return
	}

	if rt.reg.AddModel(providerID, config.ModelDef{ID: req.Model}) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusConflict, "model or alias already exists")
	}
}

// updateModelQuota updates the quotaType of a single model on a provider.
// Request: {"model": "model-id", "quotaType": "unlimited|limited|paid"}
func (rt *Router) updateModelQuota(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model     string `json:"model"`
		QuotaType string `json:"quotaType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.QuotaType {
	case "unlimited", "limited", "paid":
	default:
		writeAPIError(w, http.StatusBadRequest, "invalid quotaType, must be unlimited | limited | paid")
		return
	}
	if rt.reg.UpdateModelQuotaType(providerID, req.Model, req.QuotaType) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelAlias updates the alias of a single model on a provider.
// Request: {"model": "model-id", "alias": "some-alias"}
func (rt *Router) updateModelAlias(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Alias string `json:"alias"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if rt.reg.UpdateModelAlias(providerID, req.Model, req.Alias) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		// UpdateModelAlias returns false when provider/model not found OR when
		// the alias conflicts with an existing model ID/alias. Try to
		// distinguish via GetModelByAliasOrID check.
		if _, ok := rt.reg.GetModelByAliasOrID(providerID, req.Model); ok {
			writeAPIError(w, http.StatusBadRequest, "alias conflicts with existing model ID or alias in this provider")
		} else {
			writeAPIError(w, http.StatusNotFound, "model not found on provider")
		}
	}
}

// updateModelNote updates the note of a single model on a provider.
// Request: {"model": "model-id", "note": "some note text"}
func (rt *Router) updateModelNote(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Note  string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if rt.reg.UpdateModelNote(providerID, req.Model, req.Note) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelKind updates the kind (text/image/embedding) of a single model on a provider.
// Request: {"model": "model-id", "kind": "text|image|embedding"}
func (rt *Router) updateModelKind(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string `json:"model"`
		Kind  string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.Kind {
	case "text", "image", "embedding":
	default:
		writeAPIError(w, http.StatusBadRequest, "invalid kind, must be text | image | embedding")
		return
	}
	if rt.reg.UpdateModelKind(providerID, req.Model, req.Kind) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelImgProtocol updates the image protocol of a single model on a provider.
// Request: {"model": "model-id", "imgProtocol": "gpt|xai|modelscope"}
func (rt *Router) updateModelImgProtocol(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model       string `json:"model"`
		ImgProtocol string `json:"imgProtocol"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	switch req.ImgProtocol {
	case "gpt", "xai", "modelscope":
	default:
		writeAPIError(w, http.StatusBadRequest, "invalid imgProtocol, must be gpt | xai | modelscope")
		return
	}
	if rt.reg.UpdateModelImgProtocol(providerID, req.Model, req.ImgProtocol) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelImgSizes updates the custom size option list for a single model on a provider.
// Request: {"model": "model-id", "imgSizes": ["1024x1024", "2560x3840", ...]}
// Pass an empty array to clear the list and fall back to built-in defaults.
func (rt *Router) updateModelImgSizes(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model    string   `json:"model"`
		ImgSizes []string `json:"imgSizes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	// Normalize: trim spaces, drop duplicates, drop empties, enforce a sane upper bound.
	seen := make(map[string]struct{})
	cleaned := make([]string, 0, len(req.ImgSizes))
	for _, s := range req.ImgSizes {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		cleaned = append(cleaned, s)
		if len(cleaned) >= 200 {
			break
		}
	}
	if rt.reg.UpdateModelImgSizes(providerID, req.Model, cleaned) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "imgSizes": cleaned})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// updateModelProtocols sets the probed protocol set for a single model on a
// provider. Request: {"model": "model-id", "protocols": ["openai-compat",
// "openai-responses", "anthropic"]}. An empty array is valid and clears the
// protocol set (meaning: probed, supports no known protocol). This is a pure
// metadata update, so only saveConfig (no reload) is used.
func (rt *Router) updateModelProtocols(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model     string   `json:"model"`
		Protocols []string `json:"protocols"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if err := rt.reg.UpdateModelProtocols(providerID, req.Model, req.Protocols); err != nil {
		writeAPIError(w, http.StatusNotFound, err.Error())
		return
	}
	cfg := rt.reg.Config()
	if err := rt.saveConfig(&cfg); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	// Read back the persisted value so the response reflects what is stored
	// (e.g. nil vs empty slice normalization).
	updated := req.Protocols
	if m, ok := rt.reg.GetModelByAliasOrID(providerID, req.Model); ok {
		updated = m.Protocols
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocols": updated})
}
// Request: {"model": "model-id", "nim": {"enabled": true, "request_count_per_key": 30, "min_interval_ms": 2000}}
func (rt *Router) updateModelNIM(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	var req struct {
		Model string                  `json:"model"`
		NIM   config.ModelNIMOverride `json:"nim"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Model == "" {
		writeAPIError(w, http.StatusBadRequest, "model required")
		return
	}
	if rt.reg.UpdateModelNIMOverride(providerID, req.Model, req.NIM) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found on provider")
	}
}

// deleteProviderModel removes a custom model ID from a provider.
func (rt *Router) deleteProviderModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "id")
	modelID := r.URL.Query().Get("model")

	if rt.reg.DeleteModel(providerID, modelID) {
		cfg := rt.reg.Config()
		if err := rt.saveConfig(&cfg); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "failed to save config")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
	} else {
		writeAPIError(w, http.StatusNotFound, "model not found")
	}
}
