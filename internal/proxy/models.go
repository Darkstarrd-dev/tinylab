package proxy

import (
	"encoding/json"
	"net/http"
)

func (h *Handler) ListModels(w http.ResponseWriter, r *http.Request) {
	providers := h.providers.ListProviders()
	combos := h.comboList.ListCombos()

	type modelObj struct {
		ID          string `json:"id"`
		Object      string `json:"object"`
		OwnedBy     string `json:"owned_by"`
		Kind        string `json:"kind,omitempty"`
		ImgProtocol string `json:"imgProtocol,omitempty"`
		Note        string `json:"note,omitempty"`
		Provider    string `json:"provider,omitempty"`
	}

	var models []modelObj = []modelObj{}

	// quickSlotOnly 模式：仅返回 quickslot 中的模型，不返回 provider/combo 模型
	if h.quickSlotOnly() {
		for _, qs := range h.quickSlots.ListQuickSlots() {
			if qs.Disabled {
				continue
			}
			models = append(models, modelObj{
				ID:      qs.Name,
				Object:  "model",
				OwnedBy: "quickslot",
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data":   models,
		})
		return
	}

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
				models = append(models, modelObj{
					ID:          p.Prefix + "/" + displayID,
					Object:      "model",
					OwnedBy:     p.Name,
					Kind:        m.Kind,
					ImgProtocol: m.ImgProtocol,
					Note:        m.Note,
					Provider:    p.Name,
				})
			}
		} else {
			models = append(models, modelObj{
				ID:       p.Prefix + "/*",
				Object:   "model",
				OwnedBy:  p.Name,
				Provider: p.Name,
			})
		}
	}
	for _, c := range combos {
		if c.Disabled {
			continue
		}
		models = append(models, modelObj{
			ID:      c.Name,
			Object:  "model",
			OwnedBy: "combo",
		})
	}
	for _, qs := range h.quickSlots.ListQuickSlots() {
		if qs.Disabled {
			continue
		}
		models = append(models, modelObj{
			ID:      qs.Name,
			Object:  "model",
			OwnedBy: "quickslot",
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data":   models,
	})
}
