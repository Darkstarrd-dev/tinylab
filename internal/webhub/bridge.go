package webhub

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/tinylab/tinylab/internal/config"
)

// BridgeDeps is the registry surface the bridge needs (structurally satisfied
// by *registry.Registry). Declared locally so webhub stays a leaf that does
// not import registry (mirrors how jethub/rotation depend on narrow
// registries).
type BridgeDeps interface {
	GetProviderByPrefix(prefix string) (*config.Provider, bool)
	GetProvider(id string) (*config.Provider, bool)
	AddProvider(p config.Provider)
	UpsertProvider(p config.Provider)
	UpdateProvider(id string, updates config.Provider) bool
	DeleteProvider(id string) bool
	HasProvider(id string) bool
	ListProviders() []config.Provider
}

// prefixRe is the legal prefix charset, matching jethub's rule so the two
// hubs share one namespace and one conflict model: [a-z0-9-]{1,32}.
var prefixRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// ValidPrefix reports whether a user-supplied prefix is syntactically legal.
func ValidPrefix(prefix string) bool {
	return len(prefix) >= 1 && len(prefix) <= 32 && prefixRe.MatchString(prefix)
}

// ConflictError marks a prefix collision with an existing provider or another
// bridged site.
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

// Bridge wires webhub sites into the project's provider registry as dynamic
// config.Provider entries (ID = webhub-{domain}, APIType = webhub).
type Bridge struct {
	m      *Manager
	reg    BridgeDeps
	driver *Driver
}

// NewBridge creates the registry bridge.
func NewBridge(m *Manager, reg BridgeDeps) *Bridge {
	b := &Bridge{m: m, reg: reg}
	if m != nil {
		b.driver = NewDriver(m)
	}
	return b
}

// Driver returns the request driver (tests substitute sessions through it).
func (b *Bridge) Driver() *Driver { return b.driver }

// HasBridgedProvider reports whether a site currently has a registered
// provider entry.
func (b *Bridge) HasBridgedProvider(site string) bool {
	return b.reg.HasProvider(ProviderID(normalizeDomain(site)))
}

// SetPrefix validates + persists a user prefix and registers/updates the
// bridged provider. An empty prefix clears the bridge.
//
// Conflicts are detected against BOTH hubs: a prefix already taken by a
// jethub provider, a normal provider, or another webhub site is rejected with
// *ConflictError (the API layer maps it to HTTP 409).
func (b *Bridge) SetPrefix(site, prefix string) error {
	domain := normalizeDomain(site)
	if domain == "" {
		return fmt.Errorf("webhub: empty site")
	}
	if !SiteExists(domain) {
		return fmt.Errorf("webhub: unknown site %q", site)
	}
	prefix = strings.TrimSpace(prefix)

	old := b.m.Prefix(domain)
	if prefix != "" {
		if !ValidPrefix(prefix) {
			return fmt.Errorf("webhub: prefix must match [a-z0-9-] (1-32 chars)")
		}
		if err := b.checkPrefixConflict(domain, prefix); err != nil {
			return err
		}
	}
	if err := b.m.SetPrefix(domain, prefix); err != nil {
		return err
	}
	if old != "" && old != prefix {
		b.removeBridged(domain)
	}
	if prefix == "" {
		b.removeBridged(domain)
		return nil
	}
	if err := b.SyncProvider(domain); err != nil {
		// Roll back so storage and registry never disagree.
		_ = b.m.SetPrefix(domain, old)
		b.removeBridged(domain)
		return err
	}
	return nil
}

// ClearPrefix removes a site's prefix and its bridged provider.
func (b *Bridge) ClearPrefix(site string) error {
	return b.SetPrefix(site, "")
}

// checkPrefixConflict verifies the prefix is unused by any other provider.
func (b *Bridge) checkPrefixConflict(self, prefix string) error {
	for site, p := range b.m.Prefixes() {
		if p == prefix && site != self {
			return &ConflictError{Msg: fmt.Sprintf("prefix %q already used by webhub site %s", prefix, site)}
		}
	}
	for _, existing := range b.reg.ListProviders() {
		if existing.Prefix == prefix && existing.ID != ProviderID(self) {
			return &ConflictError{Msg: fmt.Sprintf("prefix %q already used by provider %s", prefix, existing.ID)}
		}
	}
	return nil
}

func (b *Bridge) removeBridged(site string) {
	b.reg.DeleteProvider(ProviderID(normalizeDomain(site)))
}

// SyncProvider (re)registers the bridged config.Provider for a site.
//
// ⚠️ BaseURL stays EMPTY on purpose: webhub has no HTTP endpoint. Outbound is
// intercepted by the RequestCustomizer (customize.go), which drives the
// browser instead of dialing anything. Filling a placeholder BaseURL here
// would make the proxy build (and possibly attempt) a bogus request.
//
// The single synthetic Key carries no credential — it exists so rotation has
// one slot to count and usage has an identity to attribute to.
func (b *Bridge) SyncProvider(site string) error {
	domain := normalizeDomain(site)
	rule := SiteRuleByDomain(domain)
	if rule == nil {
		return fmt.Errorf("webhub: unknown site %q", site)
	}
	prefix := b.m.Prefix(domain)
	if prefix == "" {
		b.removeBridged(domain)
		return nil
	}

	ids := ModelIDsForSite(domain, rule.PresetNames())
	models := make([]config.ModelDef, 0, len(ids))
	for _, id := range ids {
		models = append(models, config.ModelDef{ID: id})
	}

	p := config.Provider{
		ID:       ProviderID(domain),
		Name:     displayName(domain) + " (Web Hub)",
		Prefix:   prefix,
		BaseURL:  "", // no endpoint — the customizer intercepts
		APIType:  APIType,
		IsActive: true,
		Keys: []config.Key{{
			ID:       SyntheticKeyID,
			Key:      SyntheticKeyValue,
			Name:     "browser session",
			IsActive: true,
		}},
		Models: models,
	}

	if existing, ok := b.reg.GetProvider(p.ID); ok {
		// Preserve rotation overrides the user may have set via the normal
		// settings UI.
		p.RotationStrategy = existing.RotationStrategy
		p.StickyLimit = existing.StickyLimit
		p.InjectStreamOpts = existing.InjectStreamOpts
		p.NormalizeStreamChunks = existing.NormalizeStreamChunks
		p.MaxRetriesOverride = existing.MaxRetriesOverride
		p.RetryIntervalOverrideSec = existing.RetryIntervalOverrideSec
		p.CooldownOverrideSec = existing.CooldownOverrideSec
		// In-place replace so the registry stays authoritative (Models change
		// when presets change). ⚠️ Must NOT go through DeleteProvider+AddProvider:
		// DeleteProvider fires the stale-reference sweep and would wipe
		// {prefix}/{modelID} refs from combos/quickslots on every sync
		// (regression 2026-10-02).
		b.reg.UpsertProvider(p)
		return nil
	}
	b.reg.AddProvider(p)
	return nil
}

// RestoreBridges re-registers every site that has a stored prefix. Called at
// startup so {prefix}/{modelID} works right after launch, before the user
// opens the UI.
func (b *Bridge) RestoreBridges() {
	for site, prefix := range b.m.Prefixes() {
		if prefix == "" {
			continue
		}
		if err := b.SyncProvider(site); err != nil {
			if b.m.logger != nil {
				b.m.logger.Warn("[webhub] %s restore failed: %v", site, err)
			}
		}
	}
}

// Bridged reports whether a site's provider is registered (used by
// Manager.Sites to fill SiteInfo.Bridged).
func (b *Bridge) Bridged(site string) bool {
	return b.HasBridgedProvider(site)
}
