package rotation

import (
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
)

// fakeStore is a test double for the KeyStateProvider interface. It holds a
// mutable config copy and a per-key runtime-state map, mirroring the subset
// of *registry.Registry that the Selector exercises (GetProvider / GetKeyState,
// plus UpdateKey for the inactive-key selection test). It exists so the
// rotation package's tests do not import internal/registry, keeping the
// rotation -> registry edge broken even in test code.
type fakeStore struct {
	cfg    *config.Config
	states map[string]*keystate.KeyRuntimeState
}

func newFakeStore(cfg *config.Config) *fakeStore {
	f := &fakeStore{
		cfg:    cfg,
		states: make(map[string]*keystate.KeyRuntimeState),
	}
	for _, p := range cfg.Providers {
		for _, k := range p.Keys {
			f.states[p.ID+"/"+k.ID] = &keystate.KeyRuntimeState{
				ModelLocks:  make(map[string]time.Time),
				ModelStatus: make(map[string]string),
				ModelErrors: make(map[string]string),
			}
		}
	}
	return f
}

func (f *fakeStore) GetProvider(providerID string) (*config.Provider, bool) {
	for i := range f.cfg.Providers {
		if f.cfg.Providers[i].ID == providerID {
			p := f.cfg.Providers[i]
			return &p, true
		}
	}
	return nil, false
}

func (f *fakeStore) GetKeyState(providerID, keyID string) *keystate.KeyRuntimeState {
	return f.states[providerID+"/"+keyID]
}

// UpdateKey replaces the matched key within the provider (simplified
// test-double semantics; sufficient for the SkipsInactiveKeys test which only
// flips IsActive). Returns false if the provider or key is not found.
func (f *fakeStore) UpdateKey(providerID, keyID string, updates config.Key) bool {
	for i := range f.cfg.Providers {
		if f.cfg.Providers[i].ID != providerID {
			continue
		}
		for j, k := range f.cfg.Providers[i].Keys {
			if k.ID == keyID {
				f.cfg.Providers[i].Keys[j] = updates
				return true
			}
		}
	}
	return false
}
