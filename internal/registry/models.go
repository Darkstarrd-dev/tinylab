package registry

import (
	"fmt"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

func sanitizeAlias(providerPrefix, providerID, alias string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return ""
	}
	for {
		trimmed := false
		if providerPrefix != "" && strings.HasPrefix(alias, providerPrefix+"/") {
			alias = strings.TrimPrefix(alias, providerPrefix+"/")
			trimmed = true
		}
		if providerID != "" && strings.HasPrefix(alias, providerID+"/") {
			alias = strings.TrimPrefix(alias, providerID+"/")
			trimmed = true
		}
		if !trimmed {
			break
		}
	}
	return alias
}

// ListModels returns the custom model definitions for a provider.
func (r *Registry) ListModels(providerID string) []config.ModelDef {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID == providerID {
			out := make([]config.ModelDef, len(r.config.Providers[i].Models))
			copy(out, r.config.Providers[i].Models)
			return out
		}
	}
	return nil
}

// AddModel appends a model def to the provider if not already present.
// If a model with the same ID already exists, it returns true (idempotent —
// no duplicate is added). Returns false if the provider is not found, or if
// the model's alias conflicts with an existing model ID or alias.
func (r *Registry) AddModel(providerID string, model config.ModelDef) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		p := &r.config.Providers[i]
		model.Alias = sanitizeAlias(p.Prefix, p.ID, model.Alias)
		for _, m := range p.Models {
			if m.ID == model.ID {
				return true // already exists, not an error
			}
			// Reject alias that conflicts with an existing model ID or alias.
			if model.Alias != "" && (m.ID == model.Alias || m.Alias == model.Alias) {
				return false
			}
		}
		p.Models = append(p.Models, model)
		return true
	}
	return false
}

// DeleteModel removes a model def (by ID) from the provider.
func (r *Registry) DeleteModel(providerID, modelID string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		models := r.config.Providers[i].Models
		for j, m := range models {
			if m.ID == modelID {
				r.config.Providers[i].Models = append(models[:j], models[j+1:]...)
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelQuotaType updates the QuotaType for a specific model on a provider.
func (r *Registry) UpdateModelQuotaType(providerID, modelID, quotaType string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].QuotaType = quotaType
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelAlias sets the alias for a specific model on a provider. Returns
// false if the provider or model is not found, or if the alias conflicts with
// an existing model ID or another model's alias in the same provider.
func (r *Registry) UpdateModelAlias(providerID, modelID, alias string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		p := &r.config.Providers[i]
		alias = sanitizeAlias(p.Prefix, p.ID, alias)
		// Check alias uniqueness: must not conflict with existing model IDs or
		// aliases in the same provider (excluding the model being updated).
		if alias != "" {
			for _, m := range p.Models {
				if m.ID == modelID {
					continue // skip the model being updated
				}
				if m.Alias == alias || m.ID == alias {
					return false // conflict with another model's ID or alias
				}
			}
		}
		for j := range p.Models {
			if p.Models[j].ID == modelID {
				p.Models[j].Alias = alias
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelNote sets the note for a specific model on a provider.
func (r *Registry) UpdateModelNote(providerID, modelID, note string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].Note = note
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelNIMOverride sets the NIM override config for a specific model on a provider.
func (r *Registry) UpdateModelNIMOverride(providerID, modelID string, nim config.ModelNIMOverride) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].NIMOver = &nim
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelKind sets the kind (text/image) for a specific model on a provider.
func (r *Registry) UpdateModelKind(providerID, modelID, kind string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].Kind = kind
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelProtocols sets the probed protocol set for a specific model on a
// provider. It performs no value validation (legal-value checks live in
// config/validate.go); it only assigns the given slice. Pass an empty or nil
// slice to clear the protocol set (meaning: probed, supports no known
// protocol). Returns an error if the provider or model is not found.
func (r *Registry) UpdateModelProtocols(providerID, modelID string, protocols []string) error {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].Protocols = protocols
				return nil
			}
		}
		return fmt.Errorf("model %q not found on provider %q", modelID, providerID)
	}
	return fmt.Errorf("provider %q not found", providerID)
}

// UpdateModelImgProtocol sets the image protocol for a specific model on a provider.
func (r *Registry) UpdateModelImgProtocol(providerID, modelID, imgProtocol string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].ImgProtocol = imgProtocol
				return true
			}
		}
		return false
	}
	return false
}

// UpdateModelImgSizes sets the custom size option list for a specific model on
// a provider. Pass nil or an empty slice to clear (fall back to built-in
// defaults in the Playground UI). Each entry is a free-form string such as
// "1024x1024" or "2560x3840".
func (r *Registry) UpdateModelImgSizes(providerID, modelID string, sizes []string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		for j := range r.config.Providers[i].Models {
			if r.config.Providers[i].Models[j].ID == modelID {
				r.config.Providers[i].Models[j].ImgSizes = sizes
				return true
			}
		}
		return false
	}
	return false
}

// ResolveModelAlias returns the real model ID for a given alias on a provider.
// If no model has this alias, it returns the input alias unchanged and false.
func (r *Registry) ResolveModelAlias(providerPrefix, aliasOrModelID string) (modelID string, found bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	p, ok := r.GetProviderByPrefix(providerPrefix)
	if !ok {
		return aliasOrModelID, false
	}
	cleanInput := sanitizeAlias(p.Prefix, p.ID, aliasOrModelID)
	for _, m := range p.Models {
		if m.Alias != "" && (m.Alias == aliasOrModelID || m.Alias == cleanInput) {
			return m.ID, true
		}
	}
	return aliasOrModelID, false
}

// GetModelByAliasOrID returns the ModelDef for a provider that matches either
// the alias or the model ID. Returns the model def and true if found.
func (r *Registry) GetModelByAliasOrID(providerID, aliasOrModel string) (config.ModelDef, bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID != providerID {
			continue
		}
		p := &r.config.Providers[i]
		cleanInput := sanitizeAlias(p.Prefix, p.ID, aliasOrModel)
		for _, m := range p.Models {
			if m.Alias == aliasOrModel || m.Alias == cleanInput || m.ID == aliasOrModel || m.ID == cleanInput {
				return m, true
			}
		}
		return config.ModelDef{}, false
	}
	return config.ModelDef{}, false
}

// ResolveModelAliasByID returns the alias for a given model ID on a provider.
// If the model has no alias, it returns an empty string. The providerName
// parameter is matched against the provider's Name field (not ID).
func (r *Registry) ResolveModelAliasByID(providerName, modelID string) string {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].Name != providerName {
			continue
		}
		for _, m := range r.config.Providers[i].Models {
			if m.ID == modelID {
				return m.Alias
			}
		}
		return ""
	}
	return ""
}
