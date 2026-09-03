package registry

import "github.com/tinylab/tinylab/internal/config"

// --- Combos ---

func (r *Registry) ListCombos() []config.Combo {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	out := make([]config.Combo, len(r.config.Combos))
	copy(out, r.config.Combos)
	return out
}

func (r *Registry) GetComboByName(name string) (*config.Combo, bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Combos {
		if r.config.Combos[i].Name == name {
			c := r.config.Combos[i]
			return &c, true
		}
	}
	return nil, false
}

// HasCombo reports whether a combo with the given ID already exists.
func (r *Registry) HasCombo(id string) bool {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Combos {
		if r.config.Combos[i].ID == id {
			return true
		}
	}
	return false
}

func (r *Registry) AddCombo(c config.Combo) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config.Combos = append(r.config.Combos, c)
}

func (r *Registry) UpdateCombo(id string, updates config.Combo) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Combos {
		if r.config.Combos[i].ID == id {
			r.config.Combos[i].Name = updates.Name
			r.config.Combos[i].Strategy = updates.Strategy
			r.config.Combos[i].Models = updates.Models
			r.config.Combos[i].Disabled = updates.Disabled
			r.config.Combos[i].DisabledModels = updates.DisabledModels
			return true
		}
	}
	return false
}

func (r *Registry) DeleteCombo(id string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i, c := range r.config.Combos {
		if c.ID == id {
			r.config.Combos = append(r.config.Combos[:i], r.config.Combos[i+1:]...)
			return true
		}
	}
	return false
}

// GetComboByID returns a pointer to the combo with the given ID, or nil if not found.
func (r *Registry) GetComboByID(id string) (*config.Combo, bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Combos {
		if r.config.Combos[i].ID == id {
			c := r.config.Combos[i]
			return &c, true
		}
	}
	return nil, false
}
