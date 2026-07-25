package proxy

import (
	"time"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/keystate"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// Logger abstracts the logging sink the proxy writes to. It is the exact subset
// of *console.Logger that the handler uses, so the proxy no longer depends on
// the concrete console type. *console.Logger satisfies it structurally.
type Logger interface {
	Info(format string, args ...any)
	Error(format string, args ...any)
	Warn(format string, args ...any)
	Debug(format string, args ...any)
}

// KeySelector is the key-picking + failure-feedback capability.
type KeySelector interface {
	SelectKey(providerID, model string, excluded []string) (*rotation.SelectedKey, error)
	OnKeyFailure(providerID, keyID, model string, statusCode int, body string)
}

// NIMProvider is the NVIDIA NIM rate-limiting capability.
type NIMProvider interface {
	IsNIMEnabled(providerID, model string) bool
	WaitNIMInterval(providerID, keyID, model string) time.Duration
	OnNIMRequestSuccess(providerID, keyID, model string)
	MarkNIM429(providerID, keyID, model string) time.Time
}

// CooldownManager is the per-key backoff / error-clear capability.
type CooldownManager interface {
	ClearError(providerID, keyID, model string)
	MarkRateLimited(providerID, keyID, model string, d time.Duration) time.Time
}

// QuotaLocker is the daily-quota / balance-lock capability.
type QuotaLocker interface {
	MarkDailyQuotaLocked(providerID, keyID, model, body string) time.Time
	MarkBalanceLocked(providerID, keyID, model, body string) time.Time
}

// RotationSettings exposes the rotation config snapshot.
type RotationSettings interface {
	Settings() config.RotationConfig
}

// KeyProvider is the full key-management surface the Handler needs; it composes
// the narrow capabilities above. *rotation.Selector satisfies it structurally.
type KeyProvider interface {
	KeySelector
	NIMProvider
	CooldownManager
	QuotaLocker
	RotationSettings
}

// QuickSlotResolver resolves quickslot names.
type QuickSlotResolver interface {
	GetQuickSlotByName(name string) (*config.QuickSlot, bool)
	ListQuickSlots() []config.QuickSlot
}

// ProviderResolver resolves providers by prefix/id and lists them.
type ProviderResolver interface {
	GetProviderByPrefix(prefix string) (*config.Provider, bool)
	GetProvider(id string) (*config.Provider, bool)
	ListProviders() []config.Provider
}

// KeyStateAccessor reads per-key runtime state.
type KeyStateAccessor interface {
	GetKeyState(providerID, keyID string) *keystate.KeyRuntimeState
}

// AliasResolver resolves model aliases.
type AliasResolver interface {
	ResolveModelAlias(providerPrefix, aliasOrModelID string) (modelID string, found bool)
	ResolveModelAliasByID(providerName, modelID string) string
}

// ComboLister lists combos (kept narrow for the listing path).
type ComboLister interface {
	ListCombos() []config.Combo
}

// ModelResolver is the full provider/quickslot/key-state/alias surface the
// Handler needs; it composes the narrow capabilities above. *registry.Registry
// satisfies it structurally.
//
// GetKeyState lives here (rather than on KeyProvider) because the registry is
// the owner of per-key runtime state; the key-selection path only mutates that
// state through the KeyProvider's cooldown methods.
type ModelResolver interface {
	QuickSlotResolver
	ProviderResolver
	KeyStateAccessor
	AliasResolver
	ComboLister
}

// ComboResolver abstracts combo-name resolution. It is the exact subset of
// *combo.Resolver that the handler calls. *combo.Resolver satisfies it
// structurally, so the proxy no longer names the concrete type.
type ComboResolver interface {
	IsComboName(name string) bool
	Resolve(name string, entryFormat combo.EntryFormat) (*combo.ComboPlan, error)
}

// UsageRecorder abstracts usage recording. It mirrors usage.UsageStore, so the
// handler depends on the recording capability rather than *usage.RingBuffer.
type UsageRecorder interface {
	Add(e usage.Entry)
}

// QuotaTracker abstracts quota bookkeeping for UI display. It is the exact
// subset of *usage.QuotaTracker that the handler calls. *usage.QuotaTracker
// satisfies it structurally, so the proxy no longer names the concrete type.
type QuotaTracker interface {
	Update(providerName, model, keyID, keyName string, modelLimit, modelRemaining, activeKeyCount int)
	RemoveKey(providerName, model, keyID string)
}
