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

// KeyProvider abstracts key selection and the per-key cooldown / error / quota
// bookkeeping the proxy drives. It is the exact subset of rotation.KeySelector
// (and its embedded CooldownManager) that the handler calls. *rotation.Selector
// satisfies it structurally, so the proxy no longer names the concrete type.
type KeyProvider interface {
	SelectKey(providerID, model string, excluded []string) (*rotation.SelectedKey, error)
	IsNIMEnabled(providerID, model string) bool
	WaitNIMInterval(providerID, keyID, model string) time.Duration
	ClearError(providerID, keyID, model string)
	OnNIMRequestSuccess(providerID, keyID, model string)
	Settings() config.RotationConfig
	OnKeyFailure(providerID, keyID, model string, statusCode int, body string)
	MarkNIM429(providerID, keyID, model string) time.Time
	MarkDailyQuotaLocked(providerID, keyID, model, body string) time.Time
	MarkRateLimited(providerID, keyID, model string, d time.Duration) time.Time
	MarkBalanceLocked(providerID, keyID, model, body string) time.Time
}

// ModelResolver abstracts provider / quickslot lookup, key runtime-state access
// and model listing. It is the exact subset of *registry.Registry that the
// handler reads from. *registry.Registry satisfies it structurally, so the proxy
// no longer names the concrete type.
//
// GetKeyState lives here (rather than on KeyProvider) because the registry is
// the owner of per-key runtime state; the key-selection path only mutates that
// state through the KeyProvider's cooldown methods.
type ModelResolver interface {
	GetQuickSlotByName(name string) (*config.QuickSlot, bool)
	GetProviderByPrefix(prefix string) (*config.Provider, bool)
	GetProvider(id string) (*config.Provider, bool)
	GetKeyState(providerID, keyID string) *keystate.KeyRuntimeState
	ListProviders() []config.Provider
	ListCombos() []config.Combo
	ListQuickSlots() []config.QuickSlot
	ResolveModelAlias(providerPrefix, aliasOrModelID string) (modelID string, found bool)
	ResolveModelAliasByID(providerName, modelID string) string
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
