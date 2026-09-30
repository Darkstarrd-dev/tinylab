package jethub

import (
	"net/http"
)

// CHAT_API_BASE is the CodeArts inference endpoint (P2 uses the same base for
// its product registration; the value lives here so P1 can already register
// the product table for bridge smoke tests).
const codeartsBaseURL = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2"

// codeartsModels is the static model table (P2.5, populated already so the
// P1 bridge verification can register a bridged provider whose models appear
// in /v1/models). Context windows are recorded in Note for the UI.
var codeartsModels = ModelTable{
	{ID: "GLM-5.2", QuotaType: "limited", Note: "ctx 202752"},
	{ID: "GLM-5.1", QuotaType: "limited"},
	{ID: "GLM-5", QuotaType: "limited"},
	{ID: "glm-5.3-flash", QuotaType: "unlimited", Note: "ctx 1048576; benefit"},
	{ID: "openpangu-2.0-flash", QuotaType: "limited"},
	{ID: "openpangu-2.0-pro", QuotaType: "limited"},
	{ID: "deepseek-v4-flash", QuotaType: "unlimited", Note: "ctx 1048576"},
	{ID: "deepseek-v4-pro", QuotaType: "unlimited", Note: "ctx 1048576"},
	{ID: "deepseek-v4.1-flash", QuotaType: "unlimited", Note: "ctx 1000000; benefit"},
}

// RegisterDefaultProducts installs every provider's static product config.
// P2/P3 extend this list; unregistered products simply cannot be bridged yet
// (SetPrefix rejects them with "no product registered").
func RegisterDefaultProducts(b *Bridge) {
	b.RegisterProduct(Product{
		Provider:    "codearts",
		DisplayName: "CodeArts Agent (Free Hub)",
		BaseURL:     codeartsBaseURL,
		Models:      codeartsModels,
	})
}

// RestoreBridges re-registers every stored prefix found in accounts.json.
// Called at app startup so a restart after bridging keeps {prefix}/{model}
// callable without touching the Free Hub UI.
func (b *Bridge) RestoreBridges() {
	for provider := range b.m.prefixSnapshot() {
		if b.m.Prefix(provider) == "" {
			continue
		}
		if err := b.SyncKeys(provider); err != nil {
			continue
		}
	}
}

// prefixSnapshot returns a copy of the stored prefix map.
func (m *Manager) prefixSnapshot() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.accounts.Prefixes))
	for k, v := range m.accounts.Prefixes {
		out[k] = v
	}
	return out
}

// Augment implements proxy.RequestAugmenter for bridged providers. P1 ships
// the identity bridge: the body is forwarded unchanged (the registry already
// carries the account token via Key.Key, so the standard Bearer header is
// correct for providers whose upstream is OpenAI-compatible). Provider
// adapters (P2/P3) replace this with per-provider header/body rewriting by
// registering a RequestAugmenterFunc.
func (m *Manager) Augment(r *http.Request, body []byte, providerID, keyID string) ([]byte, error) {
	provider, ok := ProviderNameFromID(providerID)
	if !ok {
		return body, nil
	}
	m.mu.RLock()
	fn := m.augmenters[provider]
	m.mu.RUnlock()
	if fn == nil {
		return body, nil
	}
	return fn(r, body, providerID, keyID)
}

// RequestAugmenterFunc is a provider-specific augment hook.
type RequestAugmenterFunc func(r *http.Request, body []byte, providerID, keyID string) ([]byte, error)

// SetAugmenter registers a provider-specific augment implementation (called
// by P2/P3 adapter wiring at app startup).
func (m *Manager) SetAugmenter(provider string, fn RequestAugmenterFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.augmenters == nil {
		m.augmenters = map[string]RequestAugmenterFunc{}
	}
	m.augmenters[provider] = fn
}
