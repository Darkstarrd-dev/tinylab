// Package keystate defines the per-key runtime state types used by the
// rotation/cooldown selection path and by the registry's in-memory state map.
//
// It holds only the type definitions and their pure, self-contained methods.
// The owning map, snapshot/restore, and reload-merge semantics live in
// internal/registry (the in-memory backend). internal/rotation depends on
// these types and on a small lookup interface (rotation.KeyStateProvider)
// instead of on internal/registry, breaking the prior rotation -> registry
// reverse edge without introducing a new one.
package keystate

import (
	"sync"
	"time"
)

// QuotaInfo holds the latest known quota snapshot for a model.
type QuotaInfo struct {
	ModelLimit      int
	ModelRemaining  int
	GlobalLimit     int
	GlobalRemaining int
	LastUpdated     time.Time
}

// KeyRuntimeState holds mutable per-key runtime state (not persisted to YAML).
type KeyRuntimeState struct {
	mu           sync.Mutex
	BackoffLevel int
	// ModelLocks holds per-model cooldown/unlock times. A key is unavailable for
	// a model only while ModelLocks[model] is in the future.
	ModelLocks map[string]time.Time
	// ModelStatus holds per-model status: "active" | "cooldown" | "locked".
	// Status is derived per model, never shared globally.
	ModelStatus map[string]string
	// ModelErrors holds the last error message per model.
	ModelErrors map[string]string
	LastUsedAt  time.Time
	ConsecCount int
	RotatedAt   time.Time
	ModelQuotas map[string]*QuotaInfo

	// InFlight tracks the number of in-flight requests currently using this key.
	InFlight int

	// NIM-specific fields (only used when provider.APIType == "nim").
	NIMRequestCount  int       // Requests sent this rotation cycle
	NIMLastSendTime  time.Time // Last successful send time, for min_interval
	NIMCooldownLevel int       // 429 cooldown level (0=no cooldown)
	NIMLast429Time   time.Time // Last 429 time, for 24h level reset
}

// IncInFlight atomically increments the in-flight counter.
func (s *KeyRuntimeState) IncInFlight() { s.Lock(); s.InFlight++; s.Unlock() }

// DecInFlight atomically decrements the in-flight counter (clamped at 0).
func (s *KeyRuntimeState) DecInFlight() {
	s.Lock()
	if s.InFlight > 0 {
		s.InFlight--
	}
	s.Unlock()
}

// GetInFlight atomically returns the current in-flight count.
func (s *KeyRuntimeState) GetInFlight() int { s.Lock(); defer s.Unlock(); return s.InFlight }

// Lock acquires the state's mutex.
func (s *KeyRuntimeState) Lock() { s.mu.Lock() }

// Unlock releases the state's mutex.
func (s *KeyRuntimeState) Unlock() { s.mu.Unlock() }

// UpdateQuota stores the latest quota snapshot for a model on this key.
func (s *KeyRuntimeState) UpdateQuota(model string, modelLimit, modelRemaining, globalLimit, globalRemaining int) {
	s.Lock()
	defer s.Unlock()
	if s.ModelQuotas == nil {
		s.ModelQuotas = make(map[string]*QuotaInfo)
	}
	s.ModelQuotas[model] = &QuotaInfo{
		ModelLimit:      modelLimit,
		ModelRemaining:  modelRemaining,
		GlobalLimit:     globalLimit,
		GlobalRemaining: globalRemaining,
		LastUpdated:     time.Now(),
	}
}

// GetQuota returns the latest quota snapshot for a model, or nil.
func (s *KeyRuntimeState) GetQuota(model string) *QuotaInfo {
	s.Lock()
	defer s.Unlock()
	return s.ModelQuotas[model]
}
