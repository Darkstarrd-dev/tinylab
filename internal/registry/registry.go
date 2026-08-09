package registry

import (
	"encoding/json"
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

// Config returns a full deep copy of the current configuration. Every slice
// and map (Providers/Keys/Models, Combos, QuickSlots, Shortcuts, custom
// headers, NIM overrides, text-review nodes/patterns, ...) is independent of
// the registry-owned copy, so a handler can hold the result and marshal or
// mutate it without racing concurrent CRUD/Reload writers.
func (r *Registry) Config() config.Config {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	return cloneConfig(*r.config)
}

// cloneConfig deep-copies a Config via a JSON round trip. All Config fields
// carry json tags and every nested type is JSON-marshalable, so the round trip
// is lossless and automatically covers newly added config fields. A JSON
// round trip cannot fail for config values; the fallback (shallow copy) is
// unreachable in practice and kept only to avoid a panic.
func cloneConfig(cfg config.Config) config.Config {
	data, err := json.Marshal(&cfg)
	if err == nil {
		var out config.Config
		if err := json.Unmarshal(data, &out); err == nil {
			return out
		}
	}
	return cfg
}

// Reload replaces the config and reinitializes runtime states.
func (r *Registry) Reload(cfg *config.Config) {
	r.cfgMu.Lock()
	defer r.cfgMu.Unlock()
	r.config = cfg
	r.reloadStatesLocked()
}

// RotationSettings returns a value copy of the current global rotation
// settings. The struct contains no slice/map contents, so a plain copy is
// safe to hand out without cloning.
func (r *Registry) RotationSettings() config.RotationConfig {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	return r.config.Rotation
}
