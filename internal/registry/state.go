package registry

import (
	"fmt"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/keystate"
	"github.com/tinyrouter/tinyrouter/internal/state"
)

// GetKeyState returns the runtime state for a key, or nil if not found.
func (r *Registry) GetKeyState(providerID, keyID string) *keystate.KeyRuntimeState {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()
	return r.states[stateKey(providerID, keyID)]
}

// probeRecordKey builds the in-memory probe record map key "providerID::modelID".
func probeRecordKey(providerID, modelID string) string {
	return providerID + "::" + modelID
}

// UpdateProbeRecord stores (or replaces) the latest probe record for a model.
// The record is keyed by "providerID::modelID". It is safe to call concurrently.
func (r *Registry) UpdateProbeRecord(providerID, modelID string, rec state.ProbeRecord) {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.probeRecords[probeRecordKey(providerID, modelID)] = &rec
}

// GetProbeRecord returns the latest probe record for a model, or nil if none.
func (r *Registry) GetProbeRecord(providerID, modelID string) *state.ProbeRecord {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()
	return r.probeRecords[probeRecordKey(providerID, modelID)]
}

// SnapshotProbeRecords returns a copy of all known probe records keyed by
// "providerID::modelID", suitable for persistence into state.yaml.
func (r *Registry) SnapshotProbeRecords() map[string]*state.ProbeRecord {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()
	out := make(map[string]*state.ProbeRecord, len(r.probeRecords))
	for k, v := range r.probeRecords {
		cp := *v
		out[k] = &cp
	}
	return out
}

// RestoreProbeRecord restores a probe record from a snapshot. Errors (e.g. the
// provider/model no longer existing) are returned so the caller can skip it.
func (r *Registry) RestoreProbeRecord(providerID, modelID string, rec state.ProbeRecord) error {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.probeRecords[probeRecordKey(providerID, modelID)] = &rec
	return nil
}

// SnapshotKeyStates returns a map of key snapshot data for all known keys.
// The map key is "providerID::keyID".
func (r *Registry) SnapshotKeyStates() map[string]state.KeySnapshot {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()

	result := make(map[string]state.KeySnapshot, len(r.states))
	for sk, ks := range r.states {
		s := snapshotKeyState(ks)
		// Convert internal key format "providerID/keyID" to "providerID::keyID"
		result[convertKey(sk)] = s
	}
	return result
}

func snapshotKeyState(ks *keystate.KeyRuntimeState) state.KeySnapshot {
	ks.Lock()
	defer ks.Unlock()
	s := state.KeySnapshot{
		BackoffLevel:     ks.BackoffLevel,
		RotatedAt:        ks.RotatedAt,
		ConsecCount:      ks.ConsecCount,
		LastUsedAt:       ks.LastUsedAt,
		NIMRequestCount:  ks.NIMRequestCount,
		NIMLastSendTime:  ks.NIMLastSendTime,
		NIMCooldownLevel: ks.NIMCooldownLevel,
		NIMLast429Time:   ks.NIMLast429Time,
	}
	if len(ks.ModelLocks) > 0 {
		s.ModelLocks = make(map[string]time.Time, len(ks.ModelLocks))
		for k, v := range ks.ModelLocks {
			s.ModelLocks[k] = v
		}
	}
	if len(ks.ModelStatus) > 0 {
		s.ModelStatus = make(map[string]string, len(ks.ModelStatus))
		for k, v := range ks.ModelStatus {
			s.ModelStatus[k] = v
		}
	}
	if len(ks.ModelQuotas) > 0 {
		for m, q := range ks.ModelQuotas {
			if q != nil && q.ModelLimit > 0 && q.ModelRemaining == 0 {
				if s.ExhaustedModelLimits == nil {
					s.ExhaustedModelLimits = make(map[string]int, len(ks.ModelQuotas))
				}
				s.ExhaustedModelLimits[m] = q.ModelLimit
			}
		}
	}
	return s
}

// convertKey converts registry internal key format "a/b" to "a::b".
// All "/" are replaced with "::" to avoid ambiguity when provider or key
// IDs contain "/".
func convertKey(internal string) string {
	return strings.ReplaceAll(internal, "/", "::")
}

// RestoreKeyState restores a key's runtime state from a snapshot. Returns an
// error if the provider/key combination does not exist in the current config.
func (r *Registry) RestoreKeyState(providerID, keyID string, s state.KeySnapshot) error {
	state := r.GetKeyState(providerID, keyID)
	if state == nil {
		return fmt.Errorf("key not found: %s/%s", providerID, keyID)
	}
	state.Lock()
	defer state.Unlock()

	state.BackoffLevel = s.BackoffLevel
	state.RotatedAt = s.RotatedAt
	state.ConsecCount = s.ConsecCount
	state.LastUsedAt = s.LastUsedAt
	state.NIMRequestCount = s.NIMRequestCount
	state.NIMLastSendTime = s.NIMLastSendTime
	state.NIMCooldownLevel = s.NIMCooldownLevel
	state.NIMLast429Time = s.NIMLast429Time
	if len(s.ModelLocks) > 0 {
		if state.ModelLocks == nil {
			state.ModelLocks = make(map[string]time.Time, len(s.ModelLocks))
		}
		for k, v := range s.ModelLocks {
			state.ModelLocks[k] = v
		}
	}
	if len(s.ModelStatus) > 0 {
		if state.ModelStatus == nil {
			state.ModelStatus = make(map[string]string, len(s.ModelStatus))
		}
		for k, v := range s.ModelStatus {
			state.ModelStatus[k] = v
		}
	}
	if len(s.ExhaustedModelLimits) > 0 {
		if state.ModelQuotas == nil {
			state.ModelQuotas = make(map[string]*keystate.QuotaInfo, len(s.ExhaustedModelLimits))
		}
		for m, lim := range s.ExhaustedModelLimits {
			// Only restore if not already present (a fresh probe during this session
			// may have already populated a live ModelQuotas entry — don't clobber it).
			if state.ModelQuotas[m] == nil {
				state.ModelQuotas[m] = &keystate.QuotaInfo{
					ModelLimit:     lim,
					ModelRemaining: 0, // restored as exhausted
					LastUpdated:    time.Time{}, // zero — signals "stale, from snapshot"
				}
			}
		}
	}
	return nil
}

// ResetAllCooldowns clears all cooldown/lock timers on every key, making all
// keys immediately available for selection. Does not affect rotation strategy
// state (LastUsedAt, ConsecCount, RotatedAt) or NIM request counts.
func (r *Registry) ResetAllCooldowns() {
	r.stateMu.RLock()
	defer r.stateMu.RUnlock()
	for _, ks := range r.states {
		ks.Lock()
		ks.ModelLocks = make(map[string]time.Time)
		ks.ModelStatus = make(map[string]string)
		ks.ModelErrors = make(map[string]string)
		ks.BackoffLevel = 0
		ks.NIMCooldownLevel = 0
		ks.NIMLast429Time = time.Time{}
		ks.Unlock()
	}
}
