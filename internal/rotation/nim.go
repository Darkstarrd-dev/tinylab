package rotation

import (
	"fmt"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
)

// getNIMDefaults returns default NIMSettings values.
func getNIMDefaults() (int, int, []int) {
	return 30, 2200, []int{15, 30}
}

// getModelNIMOverride returns the per-model NIM override config if enabled.
// Returns nil if the override is not set or not enabled.
func (s *Selector) getModelNIMOverride(providerID, model string) *config.ModelNIMOverride {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok {
		return nil
	}
	for _, m := range provider.Models {
		if m.ID == model {
			if m.NIMOver != nil && m.NIMOver.Enabled {
				return m.NIMOver
			}
			return nil
		}
	}
	return nil
}

// getEffectiveNIMSettings returns NIM settings, considering per-model override.
// If the model has NIMOverride enabled, use the model's settings (with default
// cooldown ladder). Otherwise, fall back to the provider's NIMConfig.
func (s *Selector) getEffectiveNIMSettings(providerID, model string) (reqCount int, minIntervalMs int, ladderMin []int) {
	// First check model-level override
	if modelNIM := s.getModelNIMOverride(providerID, model); modelNIM != nil {
		reqCount = modelNIM.RequestCountPerKey
		if reqCount <= 0 {
			reqCount = 30
		}
		minIntervalMs = modelNIM.MinIntervalMs
		if minIntervalMs <= 0 {
			minIntervalMs = 2200
		}
		// Model-level override has no cooldown ladder config; use defaults.
		_, _, ladderMin = getNIMDefaults()
		return
	}
	// Fall back to provider level
	return s.getNIMSettings(providerID)
}

// getNIMSettings reads the provider's NIMConfig and returns effective values.
func (s *Selector) getNIMSettings(providerID string) (reqCount int, minIntervalMs int, ladderMin []int) {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok || provider.NIMConfig == nil {
		return getNIMDefaults()
	}
	nc := provider.NIMConfig
	reqCount = nc.RequestCountPerKey
	if reqCount <= 0 {
		reqCount = 30
	}
	minIntervalMs = nc.MinIntervalMs
	if minIntervalMs <= 0 {
		minIntervalMs = 2200
	}
	if len(nc.CooldownLadderMin) > 0 {
		ladderMin = nc.CooldownLadderMin
	} else {
		ladderMin = []int{15, 30}
	}
	return
}

// WaitNIMInterval returns the duration to wait before sending the next request on
// this (key, model) pair to satisfy min_interval. Returns 0 if no wait is needed.
// The model parameter is used to resolve per-model NIM override settings.
func (s *Selector) WaitNIMInterval(providerID, keyID, model string) time.Duration {
	// Read the effective NIM settings (cfgMu RLock, released) BEFORE taking
	// the key-state lock. The NIM paths used to call getEffectiveNIMSettings
	// while holding ks.mu, forming a lock cycle with Reload (cfgMu→stateMu)
	// and SnapshotKeyStates (stateMu→ks.mu): cfgMu→stateMu→ks.mu→cfgMu.
	// Ordering is now cfgMu (read, released) → stateMu (GetKeyState, read,
	// released) → ks.mu, with no overlap.
	_, minIntervalMs, _ := s.getEffectiveNIMSettings(providerID, model)

	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return 0
	}
	state.Lock()
	defer state.Unlock()

	if state.NIMLastSendTime.IsZero() {
		return 0
	}
	elapsed := time.Since(state.NIMLastSendTime)
	interval := time.Duration(minIntervalMs) * time.Millisecond
	if elapsed < interval {
		return interval - elapsed
	}
	return 0
}

// OnNIMRequestSuccess increments the NIM request count for the key and updates
// the last send timestamp. If the count reaches RequestCountPerKey, the key is
// rotated to the back of the queue (count reset, RotatedAt = now).
// The model parameter is used to resolve per-model NIM override settings.
func (s *Selector) OnNIMRequestSuccess(providerID, keyID, model string) {
	// Fetch config first, then lock state (see WaitNIMInterval for the
	// lock-ordering rationale: never hold ks.mu while waiting on cfgMu).
	reqCount, _, _ := s.getEffectiveNIMSettings(providerID, model)

	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return
	}
	state.Lock()
	defer state.Unlock()

	state.NIMRequestCount++
	state.NIMLastSendTime = time.Now()

	if state.NIMRequestCount >= reqCount {
		state.NIMRequestCount = 0
		state.RotatedAt = time.Now()
	}
	if s.onStateChange != nil {
		s.onStateChange()
	}
}

// MarkNIM429 applies the cooldown ladder for a NIM 429 response. It increments
// the cooldown level, computes the lock duration from the ladder (capped at the
// last entry), sets ModelLocks[model], rotates the key to back, and records the
// 429 time for 24h level reset.
// The model parameter is used to resolve per-model NIM override settings.
func (s *Selector) MarkNIM429(providerID, keyID, model string) time.Time {
	// Fetch config first, then lock state (see WaitNIMInterval for the
	// lock-ordering rationale: never hold ks.mu while waiting on cfgMu).
	_, _, ladderMin := s.getEffectiveNIMSettings(providerID, model)

	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return time.Time{}
	}
	state.Lock()
	defer state.Unlock()

	if state.NIMLast429Time.IsZero() || time.Since(state.NIMLast429Time) > 24*time.Hour {
		state.NIMCooldownLevel = 0
	}

	state.NIMCooldownLevel++

	idx := state.NIMCooldownLevel - 1
	if idx >= len(ladderMin) {
		idx = len(ladderMin) - 1
	}
	duration := time.Duration(ladderMin[idx]) * time.Minute
	unlock := time.Now().Add(duration)

	state.ModelLocks[model] = unlock
	state.ModelStatus[model] = "cooldown"
	state.NIMLast429Time = time.Now()
	state.RotatedAt = time.Now()
	state.ModelErrors[model] = fmt.Sprintf("429 NIM cooldown: %v", duration)
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return unlock
}

func isNIMCandidateAvailable(state *keystate.KeyRuntimeState, reqCount int) bool {
	state.Lock()
	defer state.Unlock()
	return state.NIMRequestCount < reqCount
}

func resetNIMRequestCount(state *keystate.KeyRuntimeState) {
	state.Lock()
	defer state.Unlock()
	state.NIMRequestCount = 0
}

// filterNIMCandidates filters the candidate key list for NIM providers: keys
// whose NIMRequestCount has reached RequestCountPerKey are excluded (they
// have been rotated to the back after hitting their per-round quota and must
// wait until they naturally return to the front of the failover queue).
// If all candidates are excluded (i.e. the whole pool has used its
// round quota but no key is in 429 cooldown), all keys are reset to begin
// the next round — this models "rotate-to-back without cooldown": a key that
// has finished its 30 requests is reusable as soon as it naturally reaches
// the front of the queue again.
// The model parameter is used to resolve per-model NIM override settings.
func (s *Selector) filterNIMCandidates(providerID, model string, candidates []config.Key) []config.Key {
	reqCount, _, _ := s.getEffectiveNIMSettings(providerID, model)

	var filtered []config.Key
	for _, k := range candidates {
		state := s.reg.GetKeyState(providerID, k.ID)
		if state == nil {
			continue
		}
		if isNIMCandidateAvailable(state, reqCount) {
			filtered = append(filtered, k)
		}
	}

	if len(filtered) > 0 {
		return filtered
	}

	// All candidates have hit their per-round quota without any of them
	// being in 429 cooldown: start a fresh round for the whole pool.
	for _, k := range candidates {
		state := s.reg.GetKeyState(providerID, k.ID)
		if state == nil {
			continue
		}
		resetNIMRequestCount(state)
	}
	return candidates
}
