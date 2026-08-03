// Package models exposes the available model list endpoint (provider models +
// combo strategies) for the admin UI.
package models

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// Handler wires up the /api/models endpoint.
type Handler struct {
	deps *apibase.Deps
}

// NewHandler creates a models Handler with the given shared dependencies.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{deps: d}
}

// Register registers the /models route on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/models", h.listModels)
}

// listModels returns the combined set of selectable models: every active
// provider model plus every combo.
func (h *Handler) listModels(w http.ResponseWriter, r *http.Request) {
	providers := h.deps.Reg.ListProviders()
	combos := h.deps.Reg.ListCombos()

	type modelInfo struct {
		ID          string   `json:"id"`
		RealModelID string   `json:"realModelId,omitempty"`
		Provider    string   `json:"provider"`
		ProviderID  string   `json:"providerId,omitempty"`
		Type        string   `json:"type"`
		Kind        string   `json:"kind,omitempty"`
		ImgProtocol string   `json:"imgProtocol,omitempty"`
		ImgSizes    []string `json:"imgSizes,omitempty"`
		Note        string   `json:"note,omitempty"`
	}

	var models []modelInfo
	for _, p := range providers {
		if !p.IsActive {
			continue
		}
		if len(p.Models) > 0 {
			for _, m := range p.Models {
				displayID := m.ID
				if m.Alias != "" {
					displayID = m.Alias
				}
				models = append(models, modelInfo{
					ID:          p.Prefix + "/" + displayID,
					RealModelID: m.ID,
					Provider:    p.Name,
					ProviderID:  p.ID,
					Type:        "provider",
					Kind:        m.Kind,
					ImgProtocol: m.ImgProtocol,
					ImgSizes:    m.ImgSizes,
					Note:        m.Note,
				})
			}
		} else {
			models = append(models, modelInfo{
				ID:       p.Prefix + "/*",
				Provider: p.Name,
				Type:     "provider",
			})
		}
	}
	for _, c := range combos {
		models = append(models, modelInfo{
			ID:       c.Name,
			Provider: c.Strategy,
			Type:     "combo",
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"models": models})
}
