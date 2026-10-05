package jethub

import (
	"encoding/json"
	"fmt"
	"net/http"
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
	// ⚠️ HasBalance 必须与「余额实现 + `/balance` 路由」同步 —— 它是前端
	// 渲染额度行与「刷新积分」按钮的**唯一**门控（`provider.hasBalance`）。
	// 漏登记不会报错，只会让该渠道**永远不显示额度数字**（用户可见损失，
	// 且从后端看不出任何异常）。`TestProviderBalanceCapabilitiesMatchImplementation`
	// 守住本表与实现不漂移。
	{ID: "trae", DisplayName: "TRAE", Description: "字节跳动 TRAE", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	// Cline 只有余额、**没有签到**（后端无签到接口；`HasCredits` 必须保持 false，
	// 否则面板会渲染一个必然失败的「一键领取积分」）。
	{ID: "cline", DisplayName: "Cline", Description: "Cline API", HasBalance: true, LoginModes: []string{"url"}},
	{ID: "loomy", DisplayName: "Loomy", Description: "讯飞 Loomy", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	// raccoon 的「领取」是**一次性登录奖励**（`onboardingTasks` 语义），不是每日
	// 签到 —— 后端无签到端点，服务端按日自动发放每日积分。
	{ID: "raccoon", DisplayName: "Raccoon", Description: "商汤小浣熊", HasCredits: true, HasBalance: true, LoginModes: []string{"url", "qr"}},
	{ID: "minimax", DisplayName: "MiniMax Code", Description: "MiniMax（Anthropic 协议族）", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	// R1-7: OpenCode Zen — the first non-browser login (pasted API key) plus a
	// zero-key anonymous channel (`public`, free models only).
	//
	// ⚠️ 它的「余额」不是远端数字：Zen 没有公开的余额 API（实测 15 条候选路径
	// 全 404）。本端如实展示**真正测得到的东西** —— 通道当前是否可用、是否处于
	// 限额冷却，数据全部来自本地状态、零网络请求（OpencodeChannelBalance）。
	{ID: "opencode", DisplayName: "OpenCode Zen", Description: "OpenCode Zen（匿名免费 + API Key）", HasBalance: true, LoginModes: []string{"apikey"}},
	// R2: ZCode (智谱 z.ai 免费额度通道) — Anthropic Messages 协议 + 官方
	// CLI 设备授权登录；额度按 token 计（billing/balance 的桶）。
	{ID: "zcode", DisplayName: "ZCode", Description: "智谱 z.ai（Anthropic 协议族；CLI 设备授权）", HasCredits: true, HasBalance: true, LoginModes: []string{"url"}},
	// R3-3: Gemini Code Assist（Google Cloud Code Assist 免费线）— 双层信封
	// 协议 + Google OAuth 浏览器回调登录；配额是 5 小时/周两个窗口的百分比
	//（不是积分，故不提供签到）。
	{ID: "gemini", DisplayName: "Gemini Code Assist", Description: "Google Cloud Code Assist（OAuth 浏览器回调；配额窗口制）", HasBalance: true, LoginModes: []string{"url"}},
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
	ID            string `json:"id"`
	Provider      string `json:"provider"`
	Nickname      string `json:"nickname"`
	Enabled       bool   `json:"enabled"`
	CredentialRef string `json:"credentialRef"`
	CreatedAt     int64  `json:"createdAt"`
	ExpiresAt     int64  `json:"expiresAt,omitempty"`
	Refreshable   bool   `json:"refreshable"`
	// ModelRateLimits maps model id → reset timestamp (ms since epoch).
	// 0/absent = not rate limited.
	ModelRateLimits map[string]int64 `json:"modelRateLimits,omitempty"`
	// OpencodeFingerprintGeneration is the opencode fingerprint generation
	// (ref ProviderAccountEntry.opencodeFingerprintGeneration).
	//
	// 只存**整数代次**而不是指纹本体：project id 由 `(identity, 代次)` 唯一决定，
	// 用户点「轮换指纹」时 +1 即可整体换一份新的 project id。
	OpencodeFingerprintGeneration int `json:"opencodeFingerprintGeneration,omitempty"`
	// OpencodeProxy is the account's egress proxy (ref
	// ProviderAccountEntry.opencodeProxy)。
	//
	// ⚠️ 本端**仅原样保留**（备份双向兼容：原版导出的条目带这个字段，丢掉就是
	// 静默的数据损失），尚未接线 —— 本端没有 per-account 出口，出站走 provider
	// 级的 Use Proxy 开关（见 docs/jethub-upstream-sync.md §5 的有意差异条目）。
	OpencodeProxy string `json:"opencodeProxy,omitempty"`
}

// accountsFile is the persisted shape of accounts.json: account index +
// model blacklist + prefix mapping + permanent-credit locks. It intentionally
// mirrors the original JetHubConfig semantics (§1.5) so backup import/export
// stays compatible.
type accountsFile struct {
	Accounts       []accountEntry             `json:"accounts"`
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
	ID              string           `json:"id"`
	Provider        string           `json:"provider"`
	Nickname        string           `json:"nickname"`
	Enabled         bool             `json:"enabled"`
	CredentialRef   string           `json:"credentialRef"`
	CreatedAt       int64            `json:"createdAt"`
	ExpiresAt       int64            `json:"expiresAt,omitempty"`
	Refreshable     bool             `json:"refreshable"`
	ModelRateLimits map[string]int64 `json:"modelRateLimits,omitempty"`
	HasCredential   bool             `json:"hasCredential"`
	// RotationOrder 是**生效的选号优先级**（0 起，越小越先被选中），由池内顺序
	// 算出，**不持久化**（顺序本身就是真相）。
	//
	// ⚠️ 它不等于池内下标：桥接时匿名通道恒殿后（见 Bridge.SyncKeys），故面板上
	// 的序号必须用这个字段，而不是列表下标 —— 否则用户看到的序号与实际的选号
	// 次序不一致（拖到第一位却仍最后一个被选中，正是最难排查的那类误解）。
	RotationOrder int `json:"rotationOrder"`

	// OpencodeFingerprintGeneration / OpencodeProxy are the per-account opencode
	// dimensions (ref ProviderAccountEntry 的同名字段)：指纹代次可轮换，
	// 出口代理原样保留（尚未接线，见 accountEntry 的注释）。
	OpencodeFingerprintGeneration int    `json:"opencodeFingerprintGeneration,omitempty"`
	OpencodeProxy                 string `json:"opencodeProxy,omitempty"`
	// Anonymous marks the provider's anonymous channel (opencode 的 `public`).
	// 面板据此打「匿名」标签并解释「额度按出口 IP 计」。
	//
	// ⚠️ 它由**凭据内容**判定（昵称可被用户改，改了不该改变它是匿名通道这个事实），
	// 与 ref 的 `opencode-anon-` id 前缀判据等价 —— 本端的账号 id 是
	// `{provider}-{8hex}`，不带 anon 段，故前缀判据在这里**永远不命中**。
	Anonymous bool `json:"anonymous,omitempty"`
	// AccountName / Phone 是从**凭据**现读出来的展示值（ref
	// ProviderAccountStatus.accountName / phone）：账号池条目不存它们（凭据可能在
	// 别处被更新），故属于「状态」而非「存储」。
	//
	// ⚠️ 取不到就不设字段（宁可不显示，也不猜）：zcode 的手机号由 17 位 user_id
	// 的前 11 位派生（上游从不下发手机号字段），前缀不像手机号时手机号为空。
	AccountName string `json:"accountName,omitempty"`
	Phone       string `json:"phone,omitempty"`

	// anonymous marks the provider's anonymous channel (opencode 的 `public`).
	// Unexported: it only feeds RotationOrder's computation and must never be
	// serialized (凭据内容不是对外契约的一部分).
	anonymous bool
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
	// inferURLs holds per-provider FULL inference endpoints declared by the
	// product table (Product.InferURL). Customize returns them verbatim —
	// without this, `urlutil.BuildUpstreamURL(BaseURL, 进站路径)` produces the
	// wrong path for every product whose BaseURL is a host root (the raccoon
	// 405 / minimax 404 defect family).
	inferURLs map[string]string
	// onAccountCredentialed fires after a credential write so the app can
	// re-sync bridged keys (wired to Bridge.SyncKeys).
	onAccountCredentialed func(provider string)
	// browserOpener opens a login URL in the browser/session chosen for this
	// request (wired by internal/app to Manager.OpenLoginURL). nil (unit tests)
	// = no browser is launched at all.
	browserOpener func(url string, opt OpenOptions)
	// loginOpen is the remembered browser/session selection — the +新建账号
	// dialog pre-selects it. Persisted in {dir}/login-open.json (its own file:
	// a backup import must not reset a local UI preference).
	loginOpen OpenOptions

	// codeartsRefreshLocks serializes credential renewals per credentialRef
	// (ref cf5edab): concurrent refreshes would consume the same refresh_token
	// and Huawei STS invalidates the old one on success, so a concurrent loser
	// reads a spurious invalid_grant.
	codeartsRefreshLocks sync.Map

	// sharedClients lazily-built outbound clients (direct + proxy-routed).
	sharedClients jethubClients
	// proxyURL is the global upstream proxy for jethub outbound calls (wired
	// from config by the app; nil = direct). Immutable once set.
	proxyURL *url.URL
	// keyProxyMu guards keyProxyClients: per-account egress proxy clients, built
	// on first use (see httpClientForAccount). 空 map = 没有任何账号设过自己的
	// 出口，此时出站走 provider 级开关（与加这个能力之前完全一致）。
	keyProxyMu      sync.Mutex
	keyProxyClients map[string]*http.Client

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
		dir:         dir,
		legacyKey:   legacyKey,
		logger:      logger,
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
	// Cosmetic preference: a missing/corrupt file degrades to the legacy
	// default browser rather than failing startup.
	if err := m.loadLoginOpenPrefs(); err != nil && logger != nil {
		logger.Warn("[jethub] %v", err)
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
//
// ⚠️ **返回顺序 = 池内顺序 = 选号优先级**（用户拖拽排序的结果）。面板按这个
// 顺序渲染卡片，桥接按同一个顺序分配 `Priority` —— 顺序是唯一真相，不存在第二份
// 「排序表」。
func (m *Manager) Accounts(provider string) []Account {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Account
	for _, a := range m.accounts.Accounts {
		if a.Provider != provider {
			continue
		}
		// ⚠️ 用 toAccount() 而不是手写字段列表：手写会随字段增加而**静默漏拷**
		// （真实踩过：新增 per-account 出口代理后这里没跟着加，于是面板显示已设置、
		// 桥接的 key 上却是空的 —— 看起来生效、实际没生效）。
		acc := a.toAccount()
		_, acc.HasCredential = m.credentials[provider][a.CredentialRef]
		acc.anonymous = m.isAnonymousAccountLocked(provider, a.CredentialRef)
		acc.Anonymous = acc.anonymous
		acc.AccountName, acc.Phone = m.credentialDisplayLocked(provider, a.CredentialRef)
		out = append(out, acc)
	}
	return withRotationOrder(out)
}

// isAnonymousAccountLocked reports whether the credential behind ref is the
// provider product's anonymous channel key (opencode: the literal `public`).
// Must be called with m.mu held.
func (m *Manager) isAnonymousAccountLocked(provider, ref string) bool {
	anon := anonymousKeyFor(provider)
	if anon == "" {
		return false
	}
	raw, ok := m.credentials[provider][ref]
	if !ok || len(raw) == 0 {
		return false
	}
	var cred struct {
		APIKey string `json:"api_key"`
	}
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return false
	}
	return cred.APIKey == anon
}

// credentialDisplayLocked derives the display-only values a card can show from
// the credential itself (accountName / masked phone). Must be called with m.mu
// held. Returns ("", "") when the provider has nothing extra to show.
//
// ⚠️ 刻意**只做 zcode**：其余渠道的凭据里没有比 `nickname` 更好的展示值
// （登录时已经写了可读标签），凭空多读一份凭据只会多一条无用分支。
func (m *Manager) credentialDisplayLocked(provider, ref string) (accountName, phone string) {
	if provider != "zcode" {
		return "", ""
	}
	raw, ok := m.credentials[provider][ref]
	if !ok || len(raw) == 0 {
		return "", ""
	}
	var cred ZcodeCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return "", ""
	}
	// AccountLabel 优先（登录时写的可读标签），其次 AccountName。
	return firstNonEmpty(cred.AccountLabel, cred.AccountName), cred.Phone
}

// anonymousKeyFor returns the provider's anonymous-channel key literal, or ""
// when the provider has no anonymous channel (the product registry owns the
// value; this is the one place the account layer needs it).
func anonymousKeyFor(provider string) string {
	if provider == "opencode" {
		return opencodeAnonymousKey
	}
	return ""
}

// withRotationOrder fills RotationOrder for a provider's account list: keyed
// accounts take 0..n-1 in pool order, anonymous ones follow (100+) — the same
// rule Bridge.SyncKeys applies to the rotation keys, so the number shown on the
// card is the number the selector actually uses.
func withRotationOrder(accounts []Account) []Account {
	if len(accounts) == 0 {
		return accounts
	}
	order := 0
	anonOrder := anonymousKeyPriorityBase
	for i := range accounts {
		if accounts[i].anonymous {
			accounts[i].RotationOrder = anonOrder
			anonOrder++
			continue
		}
		accounts[i].RotationOrder = order
		order++
	}
	return accounts
}

// ReorderAccounts rewrites the pool order of one provider's accounts to match
// ids. The order **is** the rotation priority (桥接时按位置分配 Priority），故这
// 是「拖拽调整选号顺序」的唯一写入口。
//
// ⚠️ 严格校验集合相等：ids 必须**恰好**是该 provider 的全部账号（不重不漏）。
// 宽松处理（只搬给定的那几个、其余追加在后）会让一次不完整的拖拽把用户排好的
// 顺序**部分**打乱，且无法察觉 —— 宁可明确报错。
func (m *Manager) ReorderAccounts(provider string, ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := map[string]*accountEntry{}
	count := 0
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].Provider != provider {
			continue
		}
		current[m.accounts.Accounts[i].ID] = &m.accounts.Accounts[i]
		count++
	}
	if count == 0 {
		return fmt.Errorf("jethub: provider %q 没有账号", provider)
	}
	if len(ids) != count {
		return fmt.Errorf("jethub: 顺序表必须包含全部 %d 个账号（收到 %d 个）", count, len(ids))
	}
	seen := map[string]bool{}
	reordered := make([]accountEntry, 0, len(ids))
	for _, id := range ids {
		entry, ok := current[id]
		if !ok {
			return fmt.Errorf("jethub: 账号 %q 不属于 %s", id, provider)
		}
		if seen[id] {
			return fmt.Errorf("jethub: 顺序表里有重复的账号 %q", id)
		}
		seen[id] = true
		reordered = append(reordered, *entry)
	}
	// 保持其它 provider 的相对位置：把它们插回原来的槽位上。
	out := make([]accountEntry, 0, len(m.accounts.Accounts))
	next := 0
	for _, existing := range m.accounts.Accounts {
		if existing.Provider != provider {
			out = append(out, existing)
			continue
		}
		out = append(out, reordered[next])
		next++
	}
	m.accounts.Accounts = out
	return m.saveAccountsLocked()
}

// AddAccount appends a new account entry (login flows call this after
// generating the id/credentialRef pair).
func (m *Manager) AddAccount(a Account) error {
	// 账号集变化 ⇒ 渠道级余额合计（Monitor 用）失效。⚠️ 必须在取状态锁**之前**
	// 调用：balanceMu 与 m.mu 不得嵌套获取（见 InvalidateBalanceSummary 的锁序注释）。
	InvalidateBalanceSummary("")
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
	// enabled 开关直接改变「哪些账号参与余额合计」⇒ 合计失效（锁序同 AddAccount）。
	InvalidateBalanceSummary("")
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

// DeleteAccount removes an account entry and its credential. The account's
// dedicated browser profile (Session == "isolated" logins) is dropped on a
// best-effort basis afterwards — never while holding the state lock, and never
// by killing a browser (a running one keeps its files locked; the directory is
// left behind in that case, which is harmless).
func (m *Manager) DeleteAccount(id string) error {
	profileDir := m.IsolatedProfileDir(id)
	if err := m.deleteAccountEntry(id); err != nil {
		return err
	}
	go m.cleanupIsolatedProfile(profileDir)
	return nil
}

// deleteAccountEntry is the locked half of DeleteAccount.
func (m *Manager) deleteAccountEntry(id string) error {
	// 账号集变化 ⇒ 余额合计失效（同 AddAccount 的锁序要求）。
	InvalidateBalanceSummary("")
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
	// 新凭据 = 该账号第一次「查得到余额」（登录流程先落账号、后落凭据）⇒ 合计
	// 失效，让 Monitor 立刻显示读数而不是等满 120s（锁序同 AddAccount）。
	InvalidateBalanceSummary("")
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
//
// ⚠️ 已有**更长（或等长）**的标记时直接返回、不改写：限流是**滚动窗口**，同一次
// 限流会在多个路径上被重复上报（proxy 的 429 分支 + BillingLockError 分支），
// 每次都写会把解禁时刻往后推、并做一次无意义的原子写盘。语义与 ref
// account-pool.ts 的 `updateModelRateLimit`（「已有更长的限流标记」跳过）一致。
//
// ⚠️ 调用方是 proxy 的限流锁观察者（见 rotation.Selector.SetRateLimitObserver），
// 对**非 Free Hub** 的 key 会拿到 ErrNotFound —— 那是正常路径，调用方忽略即可。
func (m *Manager) UpdateModelRateLimit(accountID, modelID string, resetAtMs int64) error {
	if modelID == "" {
		// 空模型名会落下一个脏键（ref account-pool.ts:51 记的同型坑）。
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].ID != accountID {
			continue
		}
		if existing, ok := m.accounts.Accounts[i].ModelRateLimits[modelID]; ok && existing >= resetAtMs {
			return nil
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
		OpencodeFingerprintGeneration: e.OpencodeFingerprintGeneration,
		OpencodeProxy:                 e.OpencodeProxy,
	}
}

func accountEntryFromAccount(a Account) accountEntry {
	return accountEntry{
		ID: a.ID, Provider: a.Provider, Nickname: a.Nickname,
		Enabled: a.Enabled, CredentialRef: a.CredentialRef,
		CreatedAt: a.CreatedAt, ExpiresAt: a.ExpiresAt,
		Refreshable: a.Refreshable, ModelRateLimits: a.ModelRateLimits,
		OpencodeFingerprintGeneration: a.OpencodeFingerprintGeneration,
		OpencodeProxy:                 a.OpencodeProxy,
	}
}
