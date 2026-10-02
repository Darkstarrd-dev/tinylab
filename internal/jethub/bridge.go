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
	UpsertProvider(p config.Provider)
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
	// InferURL is the FULL inference endpoint (scheme+host+path) for providers
	// whose real endpoint is NOT "BaseURL + 进站路径".
	//
	// ⚠️ 这是**整族真实缺陷**的收敛点（用户实测 raccoon 405 / minimax 404）：
	// 出站 URL 由 `urlutil.BuildUpstreamURL(BaseURL, 进站路径)` 构造，而多数
	// 产品的 BaseURL 只能填 host 根（目录/积分等端点共用它），真实推理路径又是
	// provider 私有的（`/api/web/llm/v2/chat/completions`、`/v2/chat/completions`、
	// `/api/agent/v3/llm_utils_chat`…），于是拼出来必然是错的（404/405），
	// 而且**带路径的 BaseURL 也救不了** —— urlutil 会先剥掉已知端点后缀再拼。
	// 非空时 Manager.Customize 原样返回它（qoder 族例外：URL 由 WASM 算出）。
	//
	// 空值 = 该产品的端点确实等于 BaseURL + 进站路径（codearts / loomy）。
	InferURL string
	// Models is the static model table registered on the bridged provider.
	Models ModelTable
	// AnonymousKey (optional) marks the credential value of the product's
	// anonymous channel (opencode: the literal `public`). Keys carrying it are
	// registered with a higher Priority so fill-first tries real accounts
	// first — the anonymous channel only serves free models, so a paid-model
	// request that starts there always burns one failed attempt.
	AnonymousKey string
	// ModelFilter (optional) narrows the registered model list using live
	// manager state (opencode: paid models are hidden while no keyed account
	// exists — the anonymous channel cannot serve them, ref listModels).
	ModelFilter func(m *Manager, provider string, models []config.ModelDef) []config.ModelDef
}

// NewBridge creates the registry bridge.
func NewBridge(m *Manager, reg BridgeDeps) *Bridge {
	return &Bridge{m: m, reg: reg, products: map[string]Product{}}
}

// RegisterProduct installs/updates a provider's static product config.
// Existing prefixes stay untouched; call SetPrefix to (re)bridge.
//
// ⚠️ InferURL 会被登记到 Manager（`Customize` 用它覆盖出站 URL），故产品表是
// 端点真相的**单一来源** —— 改这里即改推理端点，测试 `TestInferenceEndpoints`
// 逐 provider 与参考实现比对。
func (b *Bridge) RegisterProduct(p Product) {
	b.products[p.Provider] = p
	// 总是发布（空值 = 撤销声明）：产品表的最后一次登记即端点真相，避免
	// 「重新登记一个不带 InferURL 的产品」留下过期端点。
	b.m.SetInferURL(p.Provider, p.InferURL)
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
		priority := 0
		if prod.AnonymousKey != "" && token == prod.AnonymousKey {
			// 匿名槽殿后（只是位置，不是特权降级）：fill-first 按 priority ASC
			// 取第一个可用 key —— 账号槽优先，收费模型才不会先撞一次必然 401
			// 的匿名尝试。
			priority = 100
		}
		keys = append(keys, config.Key{
			ID:       a.ID,
			Key:      token,
			Name:     accountKeyName(provider, a),
			IsActive: true,
			Account:  a.Nickname,
			Priority: priority,
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
	// Provider-specific visibility (opencode: hide paid models without a keyed
	// account — the anonymous channel only serves free models).
	if prod.ModelFilter != nil {
		models = prod.ModelFilter(b.m, provider, models)
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
		// Use Proxy follows the Free Hub per-provider toggle (the same flag
		// routes login/credits outbound calls) — the proxy pipeline then
		// honors it for inference (clientFor checks p.UseProxy).
		UseProxy: b.m.ProxyEnabled(provider),
	}

	if existing, ok := b.reg.GetProvider(id); ok {
		// Preserve rotation strategy overrides the user may have set on the
		// bridged provider via the normal settings UI. ⚠️ UseProxy is NOT
		// preserved: the Free Hub toggle is the single source of truth
		// (SyncKeys writes it above).
		p.RotationStrategy = existing.RotationStrategy
		p.StickyLimit = existing.StickyLimit
		p.InjectStreamOpts = existing.InjectStreamOpts
		p.NormalizeStreamChunks = existing.NormalizeStreamChunks
		p.MaxRetriesOverride = existing.MaxRetriesOverride
		p.RetryIntervalOverrideSec = existing.RetryIntervalOverrideSec
		p.CooldownOverrideSec = existing.CooldownOverrideSec
		// In-place replace so the registry stays authoritative (Keys change on
		// every account CRUD; Models on blacklist changes). ⚠️ Must NOT go
		// through DeleteProvider+AddProvider: DeleteProvider fires the
		// stale-reference sweep and would wipe {prefix}/{model} refs from
		// combos/quickslots on every sync (regression 2026-10-02).
		b.reg.UpsertProvider(p)
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
