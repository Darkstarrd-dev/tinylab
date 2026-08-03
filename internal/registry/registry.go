package registry

import (
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
	"github.com/tinyrouter/tinyrouter/internal/state"
)

// Registry provides thread-safe access to providers, keys, combos, and runtime key states.
type Registry struct {
	cfgMu   sync.RWMutex
	config  *config.Config
	stateMu sync.RWMutex
	states  map[string]*keystate.KeyRuntimeState
	// probeRecords holds the latest lightweight probe detail per (provider, model).
	// Key format is "providerID::modelID". Guarded by stateMu.
	probeRecords map[string]*state.ProbeRecord
}

// New creates a Registry from the given config.
func New(cfg *config.Config) *Registry {
	r := &Registry{
		config:       cfg,
		states:       make(map[string]*keystate.KeyRuntimeState),
		probeRecords: make(map[string]*state.ProbeRecord),
	}
	r.reloadStatesLocked()
	return r
}

func (r *Registry) reloadStatesLocked() {
	// 锁顺序：调用方已持有 cfgMu，此处只需 stateMu。
	r.stateMu.Lock()
	defer r.stateMu.Unlock()

	// 保留仍存在的 key 的旧运行时状态，仅增减。
	// 这样 API 写操作（createProvider / updateProvider / createKey / deleteKey 等）
	// 不会清空其他 key 已经累积的冷却/锁定/退避状态。
	newStates := make(map[string]*keystate.KeyRuntimeState)
	for _, p := range r.config.Providers {
		for _, k := range p.Keys {
			key := p.ID + "/" + k.ID
			if existing, ok := r.states[key]; ok {
				// 保留既有运行时状态（冷却/锁定/退避/NIM 计数等）
				newStates[key] = existing
			} else {
				// 新 key：初始化空状态
				newStates[key] = &keystate.KeyRuntimeState{
					ModelLocks:  make(map[string]time.Time),
					ModelStatus: make(map[string]string),
					ModelErrors: make(map[string]string),
				}
			}
		}
	}
	r.states = newStates
}

func stateKey(providerID, keyID string) string {
	return providerID + "/" + keyID
}

// Config returns a copy of the current configuration.
func (r *Registry) Config() config.Config {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	return *r.config
}

// Reload replaces the config and reinitializes runtime states.
func (r *Registry) Reload(cfg *config.Config) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config = cfg
	r.reloadStatesLocked()
}
