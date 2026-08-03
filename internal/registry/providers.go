package registry

import (
	"fmt"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
)

// --- Providers ---

func (r *Registry) ListProviders() []config.Provider {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	out := make([]config.Provider, len(r.config.Providers))
	copy(out, r.config.Providers)
	return out
}

// HasProvider reports whether a provider with the given ID already exists.
func (r *Registry) HasProvider(id string) bool {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID == id {
			return true
		}
	}
	return false
}

func (r *Registry) GetProvider(id string) (*config.Provider, bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID == id {
			p := r.config.Providers[i]
			return &p, true
		}
	}
	return nil, false
}

// GetProviderByPrefix finds a provider by its prefix string.
func (r *Registry) GetProviderByPrefix(prefix string) (*config.Provider, bool) {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].Prefix == prefix {
			p := r.config.Providers[i]
			return &p, true
		}
	}
	return nil, false
}

func (r *Registry) AddProvider(p config.Provider) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config.Providers = append(r.config.Providers, p)

	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	for _, k := range p.Keys {
		r.states[p.ID+"/"+k.ID] = &keystate.KeyRuntimeState{
			ModelLocks:  make(map[string]time.Time),
			ModelStatus: make(map[string]string),
			ModelErrors: make(map[string]string),
		}
	}
}

func (r *Registry) UpdateProvider(id string, updates config.Provider) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID == id {
			r.config.Providers[i].Name = updates.Name
			r.config.Providers[i].Prefix = updates.Prefix
			r.config.Providers[i].BaseURL = updates.BaseURL
			r.config.Providers[i].APIType = updates.APIType
			r.config.Providers[i].IsActive = updates.IsActive
			r.config.Providers[i].RotationStrategy = updates.RotationStrategy
			r.config.Providers[i].StickyLimit = updates.StickyLimit
			r.config.Providers[i].InjectStreamOpts = updates.InjectStreamOpts
			r.config.Providers[i].NormalizeStreamChunks = updates.NormalizeStreamChunks
			r.config.Providers[i].NIMConfig = updates.NIMConfig
			r.config.Providers[i].UseProxy = updates.UseProxy
			// 注意：Keys 和 Models 不在此更新——前者通过 createKey/updateKey/deleteKey
			// API 操作，后者通过 addProviderModel 等 API 操作，避免误覆盖。
			return true
		}
	}
	return false
}

func (r *Registry) DeleteProvider(id string) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i, p := range r.config.Providers {
		if p.ID == id {
			r.config.Providers = append(r.config.Providers[:i], r.config.Providers[i+1:]...)

			r.stateMu.Lock()
			for _, k := range p.Keys {
				delete(r.states, stateKey(id, k.ID))
			}
			r.stateMu.Unlock()

			return true
		}
	}
	return false
}

// UpdateProviderStrategy updates per-provider rotation strategy override.
func (r *Registry) UpdateProviderStrategy(providerID, strategy string, stickyLimit int) bool {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	for i := range r.config.Providers {
		if r.config.Providers[i].ID == providerID {
			r.config.Providers[i].RotationStrategy = strategy
			r.config.Providers[i].StickyLimit = stickyLimit
			return true
		}
	}
	return false
}

// ReorderProvider moves the provider with the given ID to targetIndex (1-indexed).
// Remaining providers shift according to the yield/insertion rule.
func (r *Registry) ReorderProvider(id string, targetIndex int) error {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()

	providers := r.config.Providers
	n := len(providers)
	if targetIndex < 1 || targetIndex > n {
		return fmt.Errorf("target index %d out of range [1, %d]", targetIndex, n)
	}

	oldIdx := -1
	for i, p := range providers {
		if p.ID == id {
			oldIdx = i
			break
		}
	}
	if oldIdx == -1 {
		return fmt.Errorf("provider %s not found", id)
	}

	newIdx := targetIndex - 1
	if oldIdx == newIdx {
		return nil
	}

	targetProv := providers[oldIdx]
	providers = append(providers[:oldIdx], providers[oldIdx+1:]...)
	providers = append(providers[:newIdx], append([]config.Provider{targetProv}, providers[newIdx:]...)...)

	r.config.Providers = providers
	return nil
}
