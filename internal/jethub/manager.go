package jethub

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/fsutil"
)

// ProviderMeta describes one jethub provider (static metadata only — no
// account state). It feeds the Free Hub UI provider list and the bridge's
// product registry.
type ProviderMeta struct {
	// ID is the short provider name (e.g. "codearts"). It is also the
	// credential/account namespace key.
	ID string `json:"id"`
	// DisplayName is the human readable name shown in the UI.
	DisplayName string `json:"displayName"`
	// Description is a one-line capability summary.
	Description string `json:"description,omitempty"`
	// HasCredits reports whether the provider supports credit claim (签到).
	HasCredits bool `json:"hasCredits"`
	// HasBalance reports whether the provider exposes a credit balance query.
	HasBalance bool `json:"hasBalance"`
	// LoginModes lists the login flows this provider supports ("url" / "sms" / "qr").
	LoginModes []string `json:"loginModes,omitempty"`
}

// defaultProviders is the 11-provider registry from the migration plan §1.1.
// P2/P3 fill in per-provider behavior; the metadata list is stable from P1.
var defaultProviders = []ProviderMeta{
	{ID: "codearts", DisplayName: "CodeArts Agent", Description: "华为云 CodeArts", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	{ID: "buddy", DisplayName: "CodeBuddy", Description: "腾讯 CodeBuddy（中国版）", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	{ID: "workbuddy", DisplayName: "WorkBuddy", Description: "腾讯 WorkBuddy（国际版）", HasBalance: true, LoginModes: []string{"url"}},
	{ID: "lobsterai", DisplayName: "LobsterAI", Description: "有道 LobsterAI", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	{ID: "qoder", DisplayName: "Qoder", Description: "阿里系 Qoder（国际版）", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	{ID: "qodercn", DisplayName: "Qoder 中国版", Description: "阿里系 Qoder（中国版）", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	{ID: "trae", DisplayName: "TRAE", Description: "字节跳动 TRAE", HasCredits: true, LoginModes: []string{"url"}},
	{ID: "cline", DisplayName: "Cline", Description: "Cline API", LoginModes: []string{"url"}},
	{ID: "loomy", DisplayName: "Loomy", Description: "讯飞 Loomy", HasCredits: true, HasBalance: true, LoginModes: []string{"sms", "qr"}},
	{ID: "raccoon", DisplayName: "Raccoon", Description: "商汤小浣熊", HasCredits: true, LoginModes: []string{"url", "qr"}},
	{ID: "minimax", DisplayName: "MiniMax Code", Description: "MiniMax（Anthropic 协议族）", HasCredits: true, LoginModes: []string{"url"}},
}

// Providers returns the static provider metadata list (a copy).
func Providers() []ProviderMeta {
	out := make([]ProviderMeta, len(defaultProviders))
	copy(out, defaultProviders)
	return out
}

// ProviderExists reports whether the given provider id is known.
func ProviderExists(id string) bool {
	for _, p := range defaultProviders {
		if p.ID == id {
			return true
		}
	}
	return false
}

// accountEntry mirrors the original plugin's ProviderAccountEntry (§1.5 backup
// compatibility): id/provider/nickname/enabled/credentialRef/createdAt plus the
// runtime display fields (expiresAt/refreshable/modelRateLimits).
type accountEntry struct {
	ID            string            `json:"id"`
	Provider      string            `json:"provider"`
	Nickname      string            `json:"nickname"`
	Enabled       bool              `json:"enabled"`
	CredentialRef string            `json:"credentialRef"`
	CreatedAt     int64             `json:"createdAt"`
	ExpiresAt     int64             `json:"expiresAt,omitempty"`
	Refreshable   bool              `json:"refreshable"`
	// ModelRateLimits maps model id → reset timestamp (ms since epoch).
	// 0/absent = not rate limited.
	ModelRateLimits map[string]int64 `json:"modelRateLimits,omitempty"`
}

// accountsFile is the persisted shape of accounts.json: account index +
// model blacklist + prefix mapping + permanent-credit locks. It intentionally
// mirrors the original JetHubConfig semantics (§1.5) so backup import/export
// stays compatible.
type accountsFile struct {
	Accounts []accountEntry `json:"accounts"`
	DisabledModels map[string]map[string]bool `json:"disabledModels,omitempty"`
	// Prefixes maps provider id → user-defined call prefix ("" = not bridged).
	Prefixes map[string]string `json:"prefixes,omitempty"`
	// PermanentLocks marks providers whose selection should only consume
	// soon-expiring credits (原版「锁定永久积分」provider 级开关；备份里的
	// permanentLocks 表)。Only true values are meaningful.
	PermanentLocks map[string]bool `json:"permanentLocks,omitempty"`
	// ProxyEnabled marks providers whose login/credits/inference outbound
	// calls route through the global upstream proxy (per-provider Use Proxy
	// toggle; absent = direct).
	ProxyEnabled map[string]bool `json:"proxyEnabled,omitempty"`
}

// Account is the public view of one account entry.
type Account struct {
	ID            string            `json:"id"`
	Provider      string            `json:"provider"`
	Nickname      string            `json:"nickname"`
	Enabled       bool              `json:"enabled"`
	CredentialRef string            `json:"credentialRef"`
	CreatedAt     int64             `json:"createdAt"`
	ExpiresAt     int64             `json:"expiresAt,omitempty"`
	Refreshable   bool              `json:"refreshable"`
	ModelRateLimits map[string]int64 `json:"modelRateLimits,omitempty"`
	HasCredential bool              `json:"hasCredential"`
}

// Manager owns the jethub account/credential storage and the provider bridge.
// It is safe for concurrent use.
type Manager struct {
	mu sync.RWMutex

	dir string
	// key is the jethub-owned AES key for credentials.json (always present;
	// created on first use under {dir}/key). NOT cfg.Security.EncryptionKey —
	// that one belongs to password protection and can be cleared/rotated.
	key string
	// legacyKey is the config-provided key, used ONLY to migrate credentials
	// written by an older build that encrypted with it (may be "").
	legacyKey string

	accounts accountsFile
	// credentials maps provider → accountID → credential JSON value.
	// Stored encrypted at rest; the in-memory form is the decrypted map.
	credentials map[string]map[string]json.RawMessage

	// augmenters holds per-provider RequestAugmenter implementations (P2/P3
	// adapters register here; Augment dispatches by provider).
	augmenters map[string]RequestAugmenterFunc
	// onAccountCredentialed fires after a credential write so the app can
	// re-sync bridged keys (wired to Bridge.SyncKeys).
	onAccountCredentialed func(provider string)
	// browserOpener opens a URL in the default browser (wired to
	// fsutil.OpenInBrowser); login flows invoke it with the login URL.
	browserOpener func(url string)

	// sharedClients lazily-built outbound clients (direct + proxy-routed).
	sharedClients jethubClients
	// proxyURL is the global upstream proxy for jethub outbound calls (wired
	// from config by the app; nil = direct). Immutable once set.
	proxyURL *url.URL

	logger Logger
}

// Logger is the logging surface the manager needs (structurally satisfied by
// *console.Logger).
type Logger interface {
	Info(format string, args ...any)
	Warn(format string, args ...any)
	Error(format string, args ...any)
}

// NewManager creates a Manager rooted at dir (resolved by
// config.ResolveJetHubDir). Missing directories/files are created lazily on
// first save; a fresh manager starts with an empty state.
//
// ⚠️ Credential encryption key (real defect): the key used to be
// cfg.Security.EncryptionKey, whose lifecycle belongs to **password
// protection** — disabling that feature clears it, and setting a password
// rotates it. Every user without password protection (the default) therefore
// could never store a credential: the first successful login ended with
// "jethub: no encryption key available for credentials storage". The manager
// now owns its key in {dir}/key (0600, same AES-256-GCM primitive);
// legacyKey (the config key, possibly "") is only used to migrate credentials
// that an older build encrypted with it.
func NewManager(dir, legacyKey string, logger Logger) (*Manager, error) {
	m := &Manager{
		dir:       dir,
		legacyKey: legacyKey,
		logger:    logger,
		credentials: map[string]map[string]json.RawMessage{},
		augmenters:  map[string]RequestAugmenterFunc{},
		accounts: accountsFile{
			DisabledModels: map[string]map[string]bool{},
			Prefixes:       map[string]string{},
		},
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("jethub: create dir: %w", err)
	}
	key, err := m.loadOrCreateKey()
	if err != nil {
		return nil, err
	}
	m.key = key
	if err := m.loadAccounts(); err != nil {
		return nil, err
	}
	if err := m.loadCredentials(); err != nil {
		return nil, err
	}
	if m.accounts.PermanentLocks == nil {
		m.accounts.PermanentLocks = map[string]bool{}
	}
	if m.accounts.ProxyEnabled == nil {
		m.accounts.ProxyEnabled = map[string]bool{}
	}
	return m, nil
}

// keyPath is the jethub-owned credential encryption key file.
func (m *Manager) keyPath() string { return filepath.Join(m.dir, "key") }

// loadOrCreateKey reads {dir}/key, generating and persisting one on first use.
// The file is created 0600 (workspace-local secret; never travels in backups).
func (m *Manager) loadOrCreateKey() (string, error) {
	if data, err := os.ReadFile(m.keyPath()); err == nil {
		if key := strings.TrimSpace(string(data)); key != "" {
			return key, nil
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("jethub: read key: %w", err)
	}
	key, err := config.GenerateKey()
	if err != nil {
		return "", fmt.Errorf("jethub: generate credential key: %w", err)
	}
	if err := fsutil.AtomicWrite(m.keyPath(), []byte(key), 0600); err != nil {
		return "", fmt.Errorf("jethub: write key: %w", err)
	}
	return key, nil
}

func (m *Manager) accountsPath() string { return filepath.Join(m.dir, "accounts.json") }
func (m *Manager) credentialsPath() string {
	return filepath.Join(m.dir, "credentials.json")
}

func (m *Manager) loadAccounts() error {
	data, err := os.ReadFile(m.accountsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("jethub: read accounts: %w", err)
	}
	var af accountsFile
	if err := json.Unmarshal(data, &af); err != nil {
		return fmt.Errorf("jethub: parse accounts: %w", err)
	}
	if af.DisabledModels == nil {
		af.DisabledModels = map[string]map[string]bool{}
	}
	if af.Prefixes == nil {
		af.Prefixes = map[string]string{}
	}
	if af.PermanentLocks == nil {
		af.PermanentLocks = map[string]bool{}
	}
	if af.ProxyEnabled == nil {
		af.ProxyEnabled = map[string]bool{}
	}
	m.accounts = af
	return nil
}

func (m *Manager) loadCredentials() error {
	data, err := os.ReadFile(m.credentialsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("jethub: read credentials: %w", err)
	}
	// Envelope: {"enc": "<base64 AES-GCM of the inner JSON>"} — identical
	// primitive to config.Security password encryption.
	var env struct {
		Enc string `json:"enc"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("jethub: parse credentials envelope: %w", err)
	}
	if env.Enc == "" {
		return nil
	}
	plain, err := config.Decrypt(m.key, env.Enc)
	migrated := false
	if err != nil && m.legacyKey != "" {
		// Older builds encrypted with cfg.Security.EncryptionKey. If that key
		// still decrypts the file, adopt the data and re-encrypt under the
		// jethub-owned key (one-way migration; a later password change can no
		// longer orphan the credentials).
		if legacyPlain, legacyErr := config.Decrypt(m.legacyKey, env.Enc); legacyErr == nil {
			plain, err = legacyPlain, nil
			migrated = true
		}
	}
	if err != nil {
		return fmt.Errorf("jethub: decrypt credentials: %w", err)
	}
	var creds map[string]map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &creds); err != nil {
		return fmt.Errorf("jethub: parse credentials: %w", err)
	}
	m.credentials = creds
	if migrated {
		if m.logger != nil {
			m.logger.Info("[jethub] 凭据已从 config 加密密钥迁移到 Free Hub 自持密钥")
		}
		if err := m.saveCredentialsLocked(); err != nil {
			return fmt.Errorf("jethub: migrate credentials: %w", err)
		}
	}
	return nil
}

func (m *Manager) saveAccountsLocked() error {
	data, err := json.MarshalIndent(&m.accounts, "", "  ")
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(m.accountsPath(), data, 0600); err != nil {
		return fmt.Errorf("jethub: write accounts: %w", err)
	}
	return nil
}

func (m *Manager) saveCredentialsLocked() error {
	plain, err := json.Marshal(m.credentials)
	if err != nil {
		return err
	}
	if m.key == "" {
		// Unreachable since the key is self-provisioned at construction
		// (NewManager → loadOrCreateKey); kept as a defensive guard.
		return fmt.Errorf("jethub: no encryption key available for credentials storage")
	}
	enc, err := config.Encrypt(m.key, string(plain))
	if err != nil {
		return fmt.Errorf("jethub: encrypt credentials: %w", err)
	}
	data, err := json.MarshalIndent(map[string]string{"enc": enc}, "", "  ")
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(m.credentialsPath(), data, 0600); err != nil {
		return fmt.Errorf("jethub: write credentials: %w", err)
	}
	return nil
}

// Accounts lists accounts of one provider (HasCredential filled in).
func (m *Manager) Accounts(provider string) []Account {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Account
	for _, a := range m.accounts.Accounts {
		if a.Provider != provider {
			continue
		}
		acc := Account{
			ID: a.ID, Provider: a.Provider, Nickname: a.Nickname,
			Enabled: a.Enabled, CredentialRef: a.CredentialRef,
			CreatedAt: a.CreatedAt, ExpiresAt: a.ExpiresAt,
			Refreshable: a.Refreshable, ModelRateLimits: a.ModelRateLimits,
		}
		_, acc.HasCredential = m.credentials[provider][a.CredentialRef]
		out = append(out, acc)
	}
	return out
}

// AddAccount appends a new account entry (login flows call this after
// generating the id/credentialRef pair).
func (m *Manager) AddAccount(a Account) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Idempotent guard: duplicate ids are rejected.
	for _, existing := range m.accounts.Accounts {
		if existing.ID == a.ID {
			return fmt.Errorf("jethub: account %s already exists", a.ID)
		}
	}
	m.accounts.Accounts = append(m.accounts.Accounts, accountEntryFromAccount(a))
	return m.saveAccountsLocked()
}

// FindAccount locates one account by id (any provider).
func (m *Manager) FindAccount(id string) (Account, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, a := range m.accounts.Accounts {
		if a.ID == id {
			return a.toAccount(), true
		}
	}
	return Account{}, false
}

// AccountCount returns the number of accounts registered for a provider.
func (m *Manager) AccountCount(provider string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n := 0
	for _, a := range m.accounts.Accounts {
		if a.Provider == provider {
			n++
		}
	}
	return n
}

// EnabledAccountCount returns the number of enabled accounts with a
// credential present for a provider (the bridge Keys source).
func (m *Manager) EnabledAccountCount(provider string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n := 0
	for _, a := range m.accounts.Accounts {
		if a.Provider != provider || !a.Enabled {
			continue
		}
		if _, ok := m.credentials[provider][a.CredentialRef]; ok {
			n++
		}
	}
	return n
}

// ErrNotFound is returned when an account id does not resolve.
var ErrNotFound = fmt.Errorf("jethub: account not found")

// UpdateAccount patches nickname/enabled/expiresAt/refreshable of an account.
func (m *Manager) UpdateAccount(id string, patch func(*Account)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].ID != id {
			continue
		}
		a := m.accounts.Accounts[i].toAccount()
		patch(&a)
		m.accounts.Accounts[i] = accountEntryFromAccount(a)
		return m.saveAccountsLocked()
	}
	return ErrNotFound
}

// DeleteAccount removes an account entry and its credential.
func (m *Manager) DeleteAccount(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, a := range m.accounts.Accounts {
		if a.ID != id {
			continue
		}
		if perProvider, ok := m.credentials[a.Provider]; ok {
			delete(perProvider, a.CredentialRef)
		}
		m.accounts.Accounts = append(m.accounts.Accounts[:i], m.accounts.Accounts[i+1:]...)
		return m.saveAccountsLocked()
	}
	return ErrNotFound
}

// SetCredential stores the credential JSON for an account ref and refreshes
// the account's expiresAt/refreshable display fields.
func (m *Manager) SetCredential(provider, credentialRef string, credentialJSON []byte, expiresAt int64, refreshable bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.credentials[provider] == nil {
		m.credentials[provider] = map[string]json.RawMessage{}
	}
	m.credentials[provider][credentialRef] = json.RawMessage(credentialJSON)
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].Provider == provider && m.accounts.Accounts[i].CredentialRef == credentialRef {
			m.accounts.Accounts[i].ExpiresAt = expiresAt
			m.accounts.Accounts[i].Refreshable = refreshable
		}
	}
	if err := m.saveCredentialsLocked(); err != nil {
		return err
	}
	if err := m.saveAccountsLocked(); err != nil {
		return err
	}
	// Fire the credential hook outside the storage path concern: the app
	// wires it to Bridge.SyncKeys so bridged keys pick up the new token.
	if m.onAccountCredentialed != nil {
		go m.onAccountCredentialed(provider)
	}
	return nil
}

// Credential resolves the stored credential JSON for one account.
func (m *Manager) Credential(provider, credentialRef string) (json.RawMessage, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.credentials[provider][credentialRef]
	return v, ok
}

// Prefix returns the configured call prefix for a provider ("" = none).
func (m *Manager) Prefix(provider string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.accounts.Prefixes[provider]
}

// SetModelDisabled adds/removes one model on the provider blacklist.
func (m *Manager) SetModelDisabled(provider, modelID string, disabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	perProvider := m.accounts.DisabledModels[provider]
	if perProvider == nil {
		perProvider = map[string]bool{}
	}
	if disabled {
		perProvider[modelID] = true
	} else {
		delete(perProvider, modelID)
	}
	if len(perProvider) == 0 {
		delete(m.accounts.DisabledModels, provider)
	} else {
		m.accounts.DisabledModels[provider] = perProvider
	}
	return m.saveAccountsLocked()
}

// DisabledModels returns the blacklist snapshot for a provider (model id → true).
func (m *Manager) DisabledModels(provider string) map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]bool{}
	for id, v := range m.accounts.DisabledModels[provider] {
		if v {
			out[id] = true
		}
	}
	return out
}

// UpdateModelRateLimit records a per-account/per-model rate-limit reset time.
func (m *Manager) UpdateModelRateLimit(accountID, modelID string, resetAtMs int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].ID != accountID {
			continue
		}
		if m.accounts.Accounts[i].ModelRateLimits == nil {
			m.accounts.Accounts[i].ModelRateLimits = map[string]int64{}
		}
		m.accounts.Accounts[i].ModelRateLimits[modelID] = resetAtMs
		return m.saveAccountsLocked()
	}
	return ErrNotFound
}

// ClearAccountModelRateLimit removes one rate-limit marker from an account.
func (m *Manager) ClearAccountModelRateLimit(accountID, modelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].ID != accountID {
			continue
		}
		if m.accounts.Accounts[i].ModelRateLimits == nil {
			return nil
		}
		delete(m.accounts.Accounts[i].ModelRateLimits, modelID)
		return m.saveAccountsLocked()
	}
	return ErrNotFound
}

// ClearModelRateLimits removes every rate-limit marker of a provider's
// accounts (accountID "" = all accounts), skipping internal bookkeeping keys
// (isBookkeepingRateLimitKey). Returns the number of cleared markers.
func (m *Manager) ClearModelRateLimits(provider, accountID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cleared := 0
	for i := range m.accounts.Accounts {
		e := &m.accounts.Accounts[i]
		if e.Provider != provider {
			continue
		}
		if accountID != "" && e.ID != accountID {
			continue
		}
		if len(e.ModelRateLimits) == 0 {
			continue
		}
		for modelID := range e.ModelRateLimits {
			if !isBookkeepingRateLimitKey(modelID) {
				cleared++
			}
		}
		e.ModelRateLimits = nil
	}
	if cleared == 0 {
		return 0, nil
	}
	return cleared, m.saveAccountsLocked()
}

// PermanentLocked reports whether a provider's permanent-credit lock is on
// (原版「锁定永久积分」开关，仅 {loomy, buddy, workbuddy} 暴露该能力).
func (m *Manager) PermanentLocked(provider string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.accounts.PermanentLocks[provider] == true
}

// PermanentLocksSnapshot returns a sanitized copy of the lock table (only
// true entries — matching the original's sanitizePermanentLocks backup form).
func (m *Manager) PermanentLocksSnapshot() map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]bool{}
	for p, v := range m.accounts.PermanentLocks {
		if v {
			out[p] = true
		}
	}
	return out
}

// SetPermanentLocked toggles a provider's permanent-credit lock and persists it.
func (m *Manager) SetPermanentLocked(provider string, locked bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if locked {
		m.accounts.PermanentLocks[provider] = true
	} else {
		delete(m.accounts.PermanentLocks, provider)
	}
	return m.saveAccountsLocked()
}

// ClearDisabledModels resets a provider's model blacklist (原版「恢复默认」：
// 所有模型重新显示并回到桥接供应商的模型列表).
func (m *Manager) ClearDisabledModels(provider string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts.DisabledModels[provider]; !ok {
		return nil
	}
	delete(m.accounts.DisabledModels, provider)
	return m.saveAccountsLocked()
}

// SetModelsDisabled applies the blacklist flag to many models in one write
// (batch delete/restore) and persists once.
func (m *Manager) SetModelsDisabled(provider string, modelIDs []string, disabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(modelIDs) == 0 {
		return nil
	}
	perProvider := m.accounts.DisabledModels[provider]
	if perProvider == nil {
		perProvider = map[string]bool{}
	}
	changed := false
	for _, id := range modelIDs {
		if id == "" {
			continue
		}
		if disabled {
			if !perProvider[id] {
				perProvider[id] = true
				changed = true
			}
		} else if perProvider[id] {
			delete(perProvider, id)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	if len(perProvider) == 0 {
		delete(m.accounts.DisabledModels, provider)
	} else {
		m.accounts.DisabledModels[provider] = perProvider
	}
	return m.saveAccountsLocked()
}

// toAccount / accountEntryFromAccount convert between the storage and public
// shapes (kept as methods to make field additions explicit).
func (e accountEntry) toAccount() Account {
	return Account{
		ID: e.ID, Provider: e.Provider, Nickname: e.Nickname,
		Enabled: e.Enabled, CredentialRef: e.CredentialRef,
		CreatedAt: e.CreatedAt, ExpiresAt: e.ExpiresAt,
		Refreshable: e.Refreshable, ModelRateLimits: e.ModelRateLimits,
	}
}

func accountEntryFromAccount(a Account) accountEntry {
	return accountEntry{
		ID: a.ID, Provider: a.Provider, Nickname: a.Nickname,
		Enabled: a.Enabled, CredentialRef: a.CredentialRef,
		CreatedAt: a.CreatedAt, ExpiresAt: a.ExpiresAt,
		Refreshable: a.Refreshable, ModelRateLimits: a.ModelRateLimits,
	}
}
