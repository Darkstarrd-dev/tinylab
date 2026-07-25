package rotation

import (
	"fmt"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
)

// KeyStateProvider is the subset of *registry.Registry that the Selector needs:
// provider config lookup plus per-key runtime-state access. Depending on this
// capability (rather than on *registry.Registry directly) lets rotation avoid
// importing internal/registry; the concrete registry satisfies it structurally.
type KeyStateProvider interface {
	GetProvider(providerID string) (*config.Provider, bool)
	GetKeyState(providerID, keyID string) *keystate.KeyRuntimeState
}

// KeySelector combines key selection and cooldown management.
// *Selector implements this interface.
type KeySelector interface {
	CooldownManager
	SelectKey(providerID, model string, excludeKeyIDs []string) (*SelectedKey, error)
	OnKeyFailure(providerID, keyID, model string, statusCode int, body string)
	Settings() config.RotationConfig
	IsNIMEnabled(providerID, model string) bool
	WaitNIMInterval(providerID, keyID, model string) time.Duration
	OnNIMRequestSuccess(providerID, keyID, model string)
	MarkNIM429(providerID, keyID, model string) time.Time
}

type Selector struct {
	reg        KeyStateProvider
	settings   *config.RotationConfig
	settingsMu sync.RWMutex

	onStateChange func() // injected by main.go for state persistence
}

func New(reg KeyStateProvider, settings *config.RotationConfig) *Selector {
	return &Selector{reg: reg, settings: settings}
}

// SetStateHook sets a callback that is called when key runtime state changes.
func (s *Selector) SetStateHook(fn func()) {
	s.onStateChange = fn
}

type SelectedKey struct {
	Provider config.Provider
	Key      config.Key
	KeyName  string
}

func (s *Selector) SelectKey(providerID, model string, excludeKeyIDs []string) (*SelectedKey, error) {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok {
		return nil, fmt.Errorf("provider not found: %s", providerID)
	}
	if !provider.IsActive {
		return nil, fmt.Errorf("provider inactive: %s", providerID)
	}
	exclude := make(map[string]bool)
	for _, id := range excludeKeyIDs {
		exclude[id] = true
	}
	var candidates []config.Key
	for _, k := range provider.Keys {
		if !k.IsActive {
			continue
		}
		if exclude[k.ID] {
			continue
		}
		state := s.reg.GetKeyState(provider.ID, k.ID)
		if state == nil {
			continue
		}
		if !s.isKeyAvailable(state, model) {
			continue
		}
		candidates = append(candidates, k)
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("no available keys for provider %s (model %s)", provider.Name, model)
	}
	// Apply NIM per-key request-count filter when NIM throttling is active.
	if s.IsNIMEnabled(providerID, model) {
		candidates = s.filterNIMCandidates(provider.ID, model, candidates)
	}
	var chosen config.Key
	strategy := s.effectiveStrategy(provider)
	var chosenOk bool
	switch strategy {
	case "round-robin":
		chosen, chosenOk = s.selectRoundRobin(provider, candidates, model)
	case "failover":
		chosen, chosenOk = s.selectRotation(provider, candidates)
	default:
		chosen, chosenOk = s.selectFillFirst(candidates)
	}
	if !chosenOk {
		return nil, fmt.Errorf("no available keys for provider %s (model %s)", provider.Name, model)
	}
	state := s.reg.GetKeyState(provider.ID, chosen.ID)
	if state != nil {
		state.Lock()
		state.LastUsedAt = time.Now()
		state.ConsecCount++
		state.Unlock()
	}
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return &SelectedKey{Provider: *provider, Key: chosen, KeyName: chosen.Name}, nil
}

// OnKeyFailure handles a key failure in a strategy-aware manner. For the "failover"
// strategy it rotates the key to the back of the queue (no cooldown lock). For other
// strategies it applies exponential backoff cooldown via MarkUnavailable.
func (s *Selector) OnKeyFailure(providerID, keyID, model string, statusCode int, body string) {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok {
		s.MarkUnavailable(providerID, keyID, model, statusCode, body)
		return
	}
	// NIM 429 uses NIM-specific cooldown ladder, not exponential backoff.
	if statusCode == 429 && s.IsNIMEnabled(providerID, model) {
		s.MarkNIM429(providerID, keyID, model)
		return
	}
	if s.effectiveStrategy(provider) == "failover" {
		s.RotateToBack(providerID, keyID, model, statusCode, body)
		return
	}
	s.MarkUnavailable(providerID, keyID, model, statusCode, body)
}

// RotateToBack marks a key as rotated to the back of the failover queue by setting
// RotatedAt to now. Does not set a ModelLock, so the key remains eligible and will be
// retried once it naturally returns to the front of the queue.
func (s *Selector) RotateToBack(providerID, keyID, model string, statusCode int, body string) {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return
	}
	state.Lock()
	defer state.Unlock()
	state.RotatedAt = time.Now()
	state.ModelErrors[model] = fmt.Sprintf("%d: %s", statusCode, truncate(body, 200))
	if s.onStateChange != nil {
		s.onStateChange()
	}
}

func (s *Selector) Settings() config.RotationConfig {
	s.settingsMu.RLock()
	defer s.settingsMu.RUnlock()
	return *s.settings
}

func (s *Selector) UpdateSettings(newSettings config.RotationConfig) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	*s.settings = newSettings
}

// IsNIMEnabled reports whether NIM throttling should be applied for this
// (provider, model) combination. Returns true if the provider is NIM or
// if the model has NIMOverride enabled.
func (s *Selector) IsNIMEnabled(providerID, model string) bool {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok {
		return false
	}
	if provider.IsNIM() {
		return true
	}
	modelNIM := s.getModelNIMOverride(providerID, model)
	return modelNIM != nil && modelNIM.Enabled
}

// Compile-time interface checks.
var _ KeySelector = (*Selector)(nil)
