package jethub

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/tinylab/tinylab/internal/config"
)

// BridgeDeps is the registry surface the bridge needs (structurally satisfied
// by *registry.Registry). Declared locally so jethub stays a leaf that does
// not import registry (mirrors how rotation depends on narrow registries).
type BridgeDeps interface {
	GetProviderByPrefix(prefix string) (*config.Provider, bool)
	GetProvider(id string) (*config.Provider, bool)
	AddProvider(p config.Provider)
	UpdateProvider(id string, updates config.Provider) bool
	DeleteProvider(id string) bool
	HasProvider(id string) bool
	ListProviders() []config.Provider
}

// prefixRe is the legal prefix charset from the plan §2.3: [a-z0-9-].
var prefixRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// ValidPrefix reports whether a user-supplied prefix is syntactically legal.
func ValidPrefix(prefix string) bool {
	return len(prefix) >= 1 && len(prefix) <= 32 && prefixRe.MatchString(prefix)
}

// ModelTable is the static model list a provider product contributes to the
// bridged config.Provider (P2/P3 fill these per provider).
type ModelTable []config.ModelDef

// Bridge wires jethub accounts into the project's provider registry as
// dynamic config.Provider entries (ID = jethub-{provider}, APIType = jethub).
type Bridge struct {
	m   *Manager
	reg BridgeDeps
	// products maps provider id → its static model table + inference base URL.
	products map[string]Product
}

// Product is the per-provider static configuration the bridge needs to
// register a bridged provider (P2/P3 providers register into this table).
type Product struct {
	// Provider is the short provider id ("codearts", ...).
	Provider string
	// DisplayName is the bridged provider display name.
	DisplayName string
	// BaseURL is the inference endpoint requests are forwarded to.
	BaseURL string
	// Models is the static model table registered on the bridged provider.
	Models ModelTable
}

// NewBridge creates the registry bridge.
func NewBridge(m *Manager, reg BridgeDeps) *Bridge {
	return &Bridge{m: m, reg: reg, products: map[string]Product{}}
}

// RegisterProduct installs/updates a provider's static product config.
// Existing prefixes stay untouched; call SetPrefix to (re)bridge.
func (b *Bridge) RegisterProduct(p Product) {
	b.products[p.Provider] = p
}

// Product returns the registered product config for a provider.
func (b *Bridge) Product(provider string) (Product, bool) {
	p, ok := b.products[provider]
	return p, ok
}

// HasBridgedProvider reports whether the provider currently has a bridged
// provider entry in the registry.
func (b *Bridge) HasBridgedProvider(provider string) bool {
	return b.reg.HasProvider(ProviderID(provider))
}

// product returns the registered product for a provider.
func (b *Bridge) product(provider string) (Product, bool) {
	p, ok := b.products[provider]
	return p, ok
}

// ConflictError marks a prefix collision with an existing provider/quickslot.
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

// SetPrefix validates + persists a user prefix and registers/updates the
// bridged provider in the registry. An empty prefix clears the bridge.
func (b *Bridge) SetPrefix(provider, prefix string) error {
	if !ProviderExists(provider) {
		return fmt.Errorf("jethub: unknown provider %q", provider)
	}
	prefix = strings.TrimSpace(prefix)

	b.m.mu.Lock()
	if prefix != "" {
		if !ValidPrefix(prefix) {
			b.m.mu.Unlock()
			return fmt.Errorf("jethub: prefix must match [a-z0-9-] (1-32 chars)")
		}
		if err := b.checkPrefixConflictLocked(provider, prefix); err != nil {
			b.m.mu.Unlock()
			return err
		}
	}
	old := b.m.accounts.Prefixes[provider]
	b.m.accounts.Prefixes[provider] = prefix
	if err := b.m.saveAccountsLocked(); err != nil {
		b.m.mu.Unlock()
		return err
	}
	b.m.mu.Unlock()

	if old != "" && old != prefix {
		b.removeBridgedProvider(provider)
	}
	if prefix == "" {
		b.removeBridgedProvider(provider)
		return nil
	}
	if err := b.SyncKeys(provider); err != nil {
		// Roll the prefix back so storage and registry stay consistent.
		b.m.mu.Lock()
		b.m.accounts.Prefixes[provider] = old
		_ = b.m.saveAccountsLocked()
		b.m.mu.Unlock()
		return err
	}
	return nil
}

// checkPrefixConflictLocked verifies the prefix is not used by any other
// provider (jethub or normal) in the registry or by another jethub provider's
// stored prefix. Caller must hold m.mu.
func (b *Bridge) checkPrefixConflictLocked(self, prefix string) error {
	for prov, p := range b.m.accounts.Prefixes {
		if prov != self && p == prefix {
			return &ConflictError{Msg: fmt.Sprintf("prefix %q already used by jethub provider %s", prefix, prov)}
		}
	}
	for _, existing := range b.reg.ListProviders() {
		if existing.Prefix == prefix && existing.ID != ProviderID(self) {
			return &ConflictError{Msg: fmt.Sprintf("prefix %q already used by provider %s", prefix, existing.ID)}
		}
	}
	return nil
}

// removeBridgedProvider deletes the bridged provider from the registry if
// present. Best effort: a missing provider is not an error.
func (b *Bridge) removeBridgedProvider(provider string) {
	b.reg.DeleteProvider(ProviderID(provider))
}

// SyncKeys (re)builds the bridged config.Provider from the current account
// state: one Key per enabled account with a stored credential. Called after
// account CRUD and credential refreshes. With zero usable keys the bridged
// provider is removed from the registry entirely (no keys = nothing to
// forward with), while the stored prefix is kept so a later login re-bridges
// automatically.
func (b *Bridge) SyncKeys(provider string) error {
	prod, ok := b.product(provider)
	if !ok {
		return fmt.Errorf("jethub: no product registered for %q", provider)
	}
	// Prefix must be set to bridge.
	if b.m.Prefix(provider) == "" {
		b.removeBridgedProvider(provider)
		return nil
	}

	accounts := b.m.Accounts(provider)
	var keys []config.Key
	for _, a := range accounts {
		if !a.Enabled {
			continue
		}
		cred, ok := b.m.Credential(provider, a.CredentialRef)
		if !ok {
			continue
		}
		token, err := accessTokenOf(provider, cred)
		if err != nil || token == "" {
			continue
		}
		keys = append(keys, config.Key{
			ID:       a.ID,
			Key:      token,
			Name:     accountKeyName(provider, a),
			IsActive: true,
			Account:  a.Nickname,
		})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].ID < keys[j].ID })

	// Zero usable keys: drop the bridged provider entirely. The stored prefix
	// stays so a later login/SetPrefix re-bridges automatically.
	if len(keys) == 0 {
		b.removeBridgedProvider(provider)
		return nil
	}

	id := ProviderID(provider)
	models := make([]config.ModelDef, len(prod.Models))
	copy(models, prod.Models)
	// Apply the model blacklist: hidden models are removed from the registry
	// model list (visibility only — routing is not affected by prefix models).
	disabled := b.m.DisabledModels(provider)
	if len(disabled) > 0 {
		filtered := models[:0]
		for _, md := range models {
			if !disabled[md.ID] {
				filtered = append(filtered, md)
			}
		}
		models = filtered
	}

	p := config.Provider{
		ID:       id,
		Name:     prod.DisplayName,
		Prefix:   b.m.Prefix(provider),
		BaseURL:  prod.BaseURL,
		APIType:  APIType,
		IsActive: len(keys) > 0,
		Keys:     keys,
		Models:   models,
	}

	if existing, ok := b.reg.GetProvider(id); ok {
		// Preserve rotation strategy overrides the user may have set on the
		// bridged provider via the normal settings UI.
		p.RotationStrategy = existing.RotationStrategy
		p.StickyLimit = existing.StickyLimit
		p.InjectStreamOpts = existing.InjectStreamOpts
		p.NormalizeStreamChunks = existing.NormalizeStreamChunks
		p.UseProxy = existing.UseProxy
		p.MaxRetriesOverride = existing.MaxRetriesOverride
		p.RetryIntervalOverrideSec = existing.RetryIntervalOverrideSec
		p.CooldownOverrideSec = existing.CooldownOverrideSec
		b.reg.UpdateProvider(id, p)
		// UpdateProvider does not replace Keys/Models — replace them explicitly
		// via delete+add to keep the registry authoritative (Keys change on
		// every account CRUD; Models on blacklist changes).
		b.reg.DeleteProvider(id)
		b.reg.AddProvider(p)
	} else {
		b.reg.AddProvider(p)
	}
	return nil
}

// accountKeyName builds the rotation-visible key display name.
func accountKeyName(provider string, a Account) string {
	if a.Nickname != "" {
		return a.Nickname
	}
	return provider + "-" + a.ID
}

// accessTokenOf extracts the bearer token from a stored credential JSON.
// Provider-specific credential shapes (P2/P3) register an extractor; the
// generic fallback expects {"access_token": "..."}.
type tokenExtractor func(cred jsonRaw) (string, error)

// jsonRaw aliases the raw credential bytes for extractor signatures.
type jsonRaw = []byte

var tokenExtractors = map[string]tokenExtractor{}

// RegisterTokenExtractor installs a per-provider access-token extractor.
func RegisterTokenExtractor(provider string, fn tokenExtractor) {
	tokenExtractors[provider] = fn
}

func accessTokenOf(provider string, cred jsonRaw) (string, error) {
	if fn, ok := tokenExtractors[provider]; ok {
		return fn(cred)
	}
	var generic struct {
		AccessToken string `json:"access_token"`
	}
	if err := jsonUnmarshal(cred, &generic); err != nil {
		return "", err
	}
	return generic.AccessToken, nil
}

// ClearPrefix removes the provider's prefix and its bridged provider.
func (b *Bridge) ClearPrefix(provider string) error {
	return b.SetPrefix(provider, "")
}
