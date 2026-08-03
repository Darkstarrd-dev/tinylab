package registry

import "github.com/tinyrouter/tinyrouter/internal/config"

// --- ReviewPresets ---

func (r *Registry) ListReviewPresets() []config.ReviewPreset {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	out := make([]config.ReviewPreset, len(r.config.ReviewPresets))
	copy(out, r.config.ReviewPresets)
	return out
}

func (r *Registry) AddReviewPreset(p config.ReviewPreset) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config.ReviewPresets = append(r.config.ReviewPresets, p)
}

func (r *Registry) UpdateReviewPreset(id string, updates config.ReviewPreset) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.ReviewPresets {
		if r.config.ReviewPresets[i].ID == id {
			r.config.ReviewPresets[i].Name = updates.Name
			r.config.ReviewPresets[i].SystemPrompt = updates.SystemPrompt
			r.config.ReviewPresets[i].UserPrompt = updates.UserPrompt
			return true
		}
	}
	return false
}

func (r *Registry) DeleteReviewPreset(id string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i, p := range r.config.ReviewPresets {
		if p.ID == id {
			r.config.ReviewPresets = append(r.config.ReviewPresets[:i], r.config.ReviewPresets[i+1:]...)
			return true
		}
	}
	return false
}
