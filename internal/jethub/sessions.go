package jethub

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// loginSessionGracePeriod is how long a settled session stays observable
// before the pump reaps it (several poll intervals; session state is tiny).
const loginSessionGracePeriod = 30 * time.Second

// reapAfterGrace removes the session entry once the UI poll had a chance to
// observe the settled outcome (several poll intervals; entries are tiny).
func reapAfterGrace(id string) {
	go func() {
		<-time.After(loginSessionGracePeriod)
		TakeLoginSession(id)
	}()
}

// newJethubTransport builds the outbound transport for jethub management calls
// (login/token/credits/renewal/probe).
//
// ⚠️ 强制 HTTP/1.1（`ForceAttemptHTTP2:false` + 空的 `TLSNextProto`）：
// 参考实现（Node undici 的 fetch，即 DSH 插件）默认只讲 HTTP/1.1，而 Go 会经
// ALPN 协商 h2。用户实测环境里 Go 侧对同一对端出现间歇性异常——TLS handshake
// timeout → 2xx 空体 → 400 无 error 码——而 Node/浏览器全部正常；中间层对 h2
// 的处理是首要嫌疑（浏览器走系统代理，undici 走 1.1）。管理类调用负载极小，
// 退回 1.1 没有实际损失，且与「已验证可用的参考实现」在协议层对齐。
func newJethubTransport(proxyURL *url.URL) *http.Transport {
	tr := &http.Transport{
		ForceAttemptHTTP2: false,
		// 非 nil 的空 map = 禁止 h2 自动升级（net/http 的约定）。
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
	if proxyURL != nil {
		tr.Proxy = http.ProxyURL(proxyURL)
	}
	return tr
}

// jethubClients bundles the two lazily-built outbound clients: direct and
// proxy-routed. One pair per Manager keeps timeouts consistent across
// providers; httpClient(provider) picks by the per-provider Use Proxy toggle.
type jethubClients struct {
	direct *http.Client
	proxy  *http.Client
}

// directClientLocked lazily builds the direct outbound client.
func (m *Manager) directClientLocked() *http.Client {
	if m.sharedClients.direct == nil {
		m.sharedClients.direct = &http.Client{Timeout: 30 * time.Second, Transport: newJethubTransport(nil)}
	}
	return m.sharedClients.direct
}

// proxyClientLocked lazily builds the proxy-routed outbound client. Without
// a configured proxy URL it degrades to the direct client (toggle on +
// no proxy configured = the toggle cannot route anywhere).
func (m *Manager) proxyClientLocked() *http.Client {
	if m.sharedClients.proxy == nil {
		if u := m.proxyURL; u != nil {
			m.sharedClients.proxy = &http.Client{
				Timeout:   30 * time.Second,
				Transport: newJethubTransport(u),
			}
		} else {
			m.sharedClients.proxy = m.directClientLocked()
		}
	}
	return m.sharedClients.proxy
}

// httpClient(provider) returns the outbound client for one provider's
// login/credits/renewal calls: proxy-routed when the provider's Use Proxy
// toggle is on (and a global proxy URL is configured), direct otherwise.
//
// ⚠️ Proxy awareness (real defects, cline login): the transport defaults to
// http.ProxyFromEnvironment, which only honors HTTP(S)_PROXY env vars — and
// those are empty for the app process. A user whose machine reaches these
// upstreams through the local routing proxy (Windows system proxy on
// 127.0.0.1:2080, mirrored into config.yaml proxy.enabled) gets TLS
// handshake timeouts from the Go app while browser/DSH-undici flows through
// the proxy just fine. The manager therefore carries an explicit proxy URL
// (wired from config by the app, SetProxyURL), and the per-provider toggle
// picks between the two clients.
func (m *Manager) httpClient(provider string) *http.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.accounts.ProxyEnabled[provider] {
		return m.proxyClientLocked()
	}
	return m.directClientLocked()
}

// httpClientForAccount is httpClient plus the account's **own** egress proxy
// (currently only opencode's `opencodeProxy`): per-account 优先于 provider 级
// 开关 —— 账号自己的出口是更具体的意图。
//
// ⚠️ 未设置 per-account 代理时**直接返回 httpClient 的结果**（同一个 *http.Client
// 实例），故既有路径的行为与性能都不变。
// ⚠️ 非法代理串**忽略并回落**（用户手输的值不该让账号变成不可用）—— 与
// proxy.keyProxyClientsFor 的判据一致。
func (m *Manager) httpClientForAccount(provider, accountID string) *http.Client {
	raw := m.accountProxy(accountID)
	if raw == "" {
		return m.httpClient(provider)
	}
	pu, err := url.Parse(raw)
	if err != nil || pu.Host == "" || (pu.Scheme != "http" && pu.Scheme != "https") {
		return m.httpClient(provider)
	}
	m.keyProxyMu.Lock()
	defer m.keyProxyMu.Unlock()
	if c, ok := m.keyProxyClients[raw]; ok {
		return c
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = func(*http.Request) (*url.URL, error) { return pu, nil }
	c := &http.Client{Transport: tr, Timeout: 60 * time.Second}
	if m.keyProxyClients == nil {
		m.keyProxyClients = map[string]*http.Client{}
	}
	m.keyProxyClients[raw] = c
	return c
}

// accountProxy returns an account's own egress proxy ("" = none).
func (m *Manager) accountProxy(accountID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for i := range m.accounts.Accounts {
		if m.accounts.Accounts[i].ID == accountID {
			return strings.TrimSpace(m.accounts.Accounts[i].OpencodeProxy)
		}
	}
	return ""
}

// SetAccountProxy stores an account's own egress proxy ("" clears it).
//
// ⚠️ 空串是**合法值**（用户显式清除了代理，回到「与其它无代理账号共享本机出口」），
// 不可用 falsy 判据把它与「未设置」混为一谈 —— 那会让面板上的「清除代理」点了没
// 反应（ref ProviderAccountEntry.opencodeProxy 的同款注释）。
func (m *Manager) SetAccountProxy(accountID, raw string) error {
	raw = strings.TrimSpace(raw)
	if raw != "" {
		pu, err := url.Parse(raw)
		if err != nil || pu.Host == "" || (pu.Scheme != "http" && pu.Scheme != "https") {
			return fmt.Errorf("jethub: 代理地址必须是 http(s)://host:port 形式，收到 %q", raw)
		}
	}
	err := m.UpdateAccount(accountID, func(a *Account) { a.OpencodeProxy = raw })
	if err != nil {
		return err
	}
	// 让下一次出站立刻按新出口走（缓存的 transport 是按代理串索引的，清掉即可）。
	m.keyProxyMu.Lock()
	m.keyProxyClients = nil
	m.keyProxyMu.Unlock()
	return nil
}

// ProxyEnabled reports the provider's Use Proxy toggle.
func (m *Manager) ProxyEnabled(provider string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.accounts.ProxyEnabled[provider]
}

// SetProxyEnabled flips the provider's Use Proxy toggle (persisted; travels
// in accounts.json like prefixes/locks).
func (m *Manager) SetProxyEnabled(provider string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.accounts.ProxyEnabled == nil {
		m.accounts.ProxyEnabled = map[string]bool{}
	}
	m.accounts.ProxyEnabled[provider] = enabled
	return m.saveAccountsLocked()
}

// SetProxyURL configures the global upstream proxy URL for the proxy-routed
// client (wired from config.Proxy by the app). Pass "" to disable. Resets the
// lazily-built pair so the next outbound call picks up the new routing.
func (m *Manager) SetProxyURL(raw string) error {
	raw = strings.TrimSpace(raw)
	m.mu.Lock()
	defer m.mu.Unlock()
	if raw == "" {
		m.proxyURL = nil
		m.sharedClients = jethubClients{}
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("jethub: invalid proxy URL %q: %w", raw, err)
	}
	m.proxyURL = u
	m.sharedClients = jethubClients{} // rebuild lazily with the proxy transport
	return nil
}

// strReader is a tiny strings.NewReader alias for readability.
func strReader(s string) *strings.Reader { return strings.NewReader(s) }

// NewLoginSessionID generates a random session id for in-flight login flows.
func NewLoginSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	return hex.EncodeToString(b[:])
}

// loginSessions is the process-local registry of in-flight login flows
// (guarded; entries removed when settled).
var (
	loginMu       sync.Mutex
	loginSessions = map[string]*LoginSession{}
)

// registerLoginSession tracks a flow; the API status endpoint polls it.
func registerLoginSession(id string, s *LoginSession) {
	loginMu.Lock()
	defer loginMu.Unlock()
	s.Key = id
	loginSessions[id] = s
}

// TakeLoginSession removes a settled flow.
func TakeLoginSession(id string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	delete(loginSessions, id)
}

// PeekLoginSession reads a flow without removing it.
func PeekLoginSession(id string) (*LoginSession, bool) {
	loginMu.Lock()
	defer loginMu.Unlock()
	s, ok := loginSessions[id]
	return s, ok
}

// RegisterLoginSession is the exported alias (API layer calls this).
func RegisterLoginSession(id string, s *LoginSession) { registerLoginSession(id, s) }

// loginSession is one in-flight OAuth flow (codearts; P3 providers reuse the
// shape via their own start functions).
//
// ⚠️ Single-consumer discipline: the pump goroutine started by the login
// handler is the ONLY reader of Started.Result (via SettleAndCleanup); the
// UI status poll reads the recorded state through SessionStatus. Two direct
// channel readers would race for the single buffered outcome and one side
// would hang forever.
type LoginSession struct {
	// Key is the registry id (assigned by registerLoginSession; used by
	// SettleAndCleanup to remove the entry exactly once).
	Key string
	// Manager, when set, lets SettleAndCleanup delete the placeholder
	// account when the flow fails (no credential-less leftovers).
	Manager *Manager
	Started *StartedLogin
	Account string
	// Extra carries provider-specific flow state that the public login page
	// must be able to reach by loginId (currently the loomy WeChat QR flow:
	// uuid/rcode/msgid live host-side only). nil for every other provider.
	Extra any

	// recorded outcome (guarded by settleMu; written only by
	// SettleAndCleanup, read by SessionStatus).
	settleMu   sync.Mutex
	settled    bool
	settledOK  bool
	settledErr error
}

// SessionStatus is the non-blocking UI poll: reports whether the flow has
// settled and, if so, its recorded outcome.
func SessionStatus(s *LoginSession) (done, success bool, errMsg string) {
	s.settleMu.Lock()
	defer s.settleMu.Unlock()
	if !s.settled {
		return false, false, ""
	}
	msg := ""
	if s.settledErr != nil {
		msg = s.settledErr.Error()
	}
	return true, s.settledOK, msg
}

// SettleAndCleanup is the pump: it blocks until the flow delivers exactly one
// outcome, records it (SessionStatus turns visible), removes the session and:
//   - on failure deletes the placeholder account — without this a timed-out /
//     canceled login leaves a credential-less entry that renders as a
//     usable-looking card and can never work;
//   - on success hands the credential JSON to complete (provider-specific
//     persistence). Flows that already persist internally pass nil here.
//
// ⚠️ Call sites MUST NOT wire the flow itself to the HTTP request context:
// the login handler returns long before the user finishes authorization, and
// net/http cancels the request context right after — every flow bound to
// r.Context() aborted the moment its handler responded (the "+新建账号
// placeholder appears, credential never lands" defect: raccoon/cline/trae/
// lobsterai/buddy/minimax all polled on r.Context(); qoder was the only one
// that documented and avoided it).
func SettleAndCleanup(sess *LoginSession, complete func(LoginOutcome) error) {
	outcome := <-sess.Started.Result
	sess.settleMu.Lock()
	if sess.settled { // defensive: never run twice
		sess.settleMu.Unlock()
		return
	}
	sess.settled = true
	sess.settledOK = outcome.Err == nil
	sess.settledErr = outcome.Err
	sess.settleMu.Unlock()

	// Reap only after a grace period: the UI polls every ~2s, so removing
	// the entry immediately would make the poller's next request 404 and the
	// "done" transition would never be observed — the dialog would hang on
	// "waiting" even though the login finished (real defect recorded).
	reapAfterGrace(sess.Key)
	if outcome.Err != nil {
		if sess.Manager != nil {
			_ = sess.Manager.DeleteAccount(sess.Account)
		}
		return
	}
	if complete != nil && outcome.CredentialJSON != nil {
		if err := complete(outcome); err != nil {
			if sess.Manager != nil {
				_ = sess.Manager.DeleteAccount(sess.Account)
			}
		}
	}
}
