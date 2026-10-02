package proxy

import (
	"io"
	"net/http"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/keystate"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/upstreamerr"
	"github.com/tinylab/tinylab/internal/usage"
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
	// SonestCooldown returns the soonest-expiring ModelLock[model] among the
	// provider's active keys not in excludeKeyIDs that are currently cooling
	// down. Used to wait for a cooldown instead of instantly 502-ing when every
	// available key is only temporarily locked. ok=false ⇒ no such key.
	SonestCooldown(providerID, model string, excludeKeyIDs []string) (rotation.CooldownInfo, bool)
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

// RequestAugmenter allows an owner of bridged providers (e.g. jethub) to
// rewrite the outbound request just before it is sent. The implementation is
// injected via Handler.SetRequestAugmenter; nil implementation = standard
// forwarding. The proxy never imports the augmenter's package — it only knows
// this interface and the APIType=="jethub" marker.
type RequestAugmenter interface {
	// Augment may replace headers of the outbound request (mutations to r's
	// header become the outbound header base) and returns the (possibly
	// rewritten) body. providerID is config.Provider.ID (e.g.
	// jethub-codearts); keyID locates the concrete account credential;
	// upstreamModel is the resolved model id from the request body. Returning
	// an error fails this forwarding attempt (counted like a network error by
	// the retry loop).
	Augment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error)
}

// QuotaTracker abstracts quota bookkeeping for UI display. It is the exact
// subset of *usage.QuotaTracker that the handler calls. *usage.QuotaTracker
// satisfies it structurally, so the proxy no longer names the concrete type.
type QuotaTracker interface {
	Update(providerName, model, keyID, keyName string, modelLimit, modelRemaining, activeKeyCount int)
	RemoveKey(providerName, model, keyID string)
}

// RequestCustomizer is an OPTIONAL richer augment capability: bridged
// providers whose outbound URL is not derivable from the entry path (e.g.
// encrypted-inference endpoints whose full URL comes out of a signing WASM)
// supply it. When the injected augmenter implements this interface, the proxy
// tries Customize FIRST; a returned outURL of "" means "no customization" and
// falls back to the standard BaseURL+path construction (with Augment's header
// mutations still applied).
type RequestCustomizer interface {
	// Customize returns the full outbound URL ("" = default) and the possibly
	// rewritten body. Header mutations follow the Augment contract: mutations
	// on r's header become the outbound header base.
	Customize(r *http.Request, body []byte, providerID, keyID, upstreamModel string) (outURL string, outBody []byte, err error)
}

// ResponseInterceptor is the response-side counterpart of the augmenter: it
// inspects the raw upstream response of a bridged provider BEFORE it reaches
// the client. Implemented by the same injected owner (e.g. jethub); the
// proxy only knows this interface.
type ResponseInterceptor interface {
	// InterceptResponse inspects resp. Outcomes:
	//   - (nil, 0, nil): forward resp unchanged;
	//   - (outBody, 0, nil): forward outBody instead of resp.Body (envelope
	//     stripping / peek readers); the interceptor must NOT close resp.Body;
	//   - (nil, retryAfterMs, nil): transient queue signal — the retry loop
	//     waits retryAfterMs and re-sends with the SAME key;
	//   - (nil, 0, *upstreamerr.SameKeyRetryError): resend immediately with the
	//     SAME key after dropping the named header (the retry loop writes it into
	//     RetryDropHeaderMarker on the client request so the bridge's augmenter
	//     can apply the fix; the bridge's interceptor uses the same marker to
	//     tell "already retried once");
	//   - (nil, 0, err): failed attempt (classified by the retry loop).
	// The interceptor may consume resp.Body; the proxy still owns the Close.
	InterceptResponse(clientReq *http.Request, resp *http.Response, providerID, keyID, upstreamModel string, isStream bool) (outBody io.Reader, retryAfterMs int64, err error)
}

// QueueRetryError asks the retry loop to wait RetryAfter and resend with the
// SAME key (server-specified transient queue delay, e.g. Qoder 10605).
// Defined in the neutral leaf package upstreamerr so the bridge can build it
// without importing proxy (the proxy never imports the augmenter's package).
type QueueRetryError = upstreamerr.QueueRetryError

// BillingLockError reports a per-model quota exhaustion on this key (Qoder:
// UTC+8 day end). Same neutral-package rationale as QueueRetryError.
type BillingLockError = upstreamerr.BillingLockError

// SameKeyRetryError asks the retry loop to resend immediately with the SAME
// key after dropping a rejected header (the bridge applies the fix on the
// resend via RetryDropHeaderMarker). Same neutral-package rationale as
// QueueRetryError.
type SameKeyRetryError = upstreamerr.SameKeyRetryError

// RetryDropHeaderMarker is the loopback-only marker header the retry loop
// writes on the client request when handling a SameKeyRetryError; bridged
// augmenters/interceptors read it. Re-exported for the proxy's own header
// copy guard.
const RetryDropHeaderMarker = upstreamerr.RetryDropHeaderMarker
