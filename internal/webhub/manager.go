package webhub

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/util"
)

// Logger is the logging surface the manager needs (structurally satisfied by
// *console.Logger).
type Logger interface {
	Info(format string, args ...any)
	Warn(format string, args ...any)
	Error(format string, args ...any)
}

// SiteState is the persisted, per-site user state: the call prefix and the
// last successful probe. Everything else (browser attachment, login state) is
// runtime-only and never persisted — webhub stores no credential.
type SiteState struct {
	// Prefixes maps site domain → user-defined call prefix ("" = not bridged).
	Prefixes map[string]string `json:"prefixes,omitempty"`
	// LastOK maps site domain → unix ms of the last successful probe.
	LastOK map[string]int64 `json:"lastOk,omitempty"`
}

// SiteInfo is the API/UI view of one site: static rule metadata + live state.
type SiteInfo struct {
	// Domain is the site hostname (also the default model id).
	Domain string `json:"id"`
	// DisplayName is a human label (the derived short id, capitalized for
	// display only — routing always uses Domain).
	DisplayName string `json:"displayName"`
	// PresetCount is how many presets the site declares.
	PresetCount int `json:"presetCount"`
	// DefaultPreset is the preset used when the caller pins none.
	DefaultPreset string `json:"defaultPreset"`
	// Prefix is the user's call prefix ("" = not bridged).
	Prefix string `json:"prefix"`
	// Bridged reports whether the provider is currently registered.
	Bridged bool `json:"bridged"`
	// ModelIDs is the full `{prefix}/{modelID}` id list (prefix applied, so
	// the UI can render directly copyable strings).
	ModelIDs []string `json:"modelIds"`
	// Ready reports whether the site looks usable right now: a tab of the
	// site is attached and its input box is present.
	Ready bool `json:"ready"`
	// Connected reports whether any browser is reachable over CDP.
	Connected bool `json:"connected"`
	// TabURL is the attached tab's URL ("" when none).
	TabURL string `json:"tabUrl"`
	// LastOKMs is the unix ms of the last successful probe (0 = never).
	LastOKMs int64 `json:"lastOkMs"`
	// HasSelectors reports whether the default preset declares the minimum
	// selector set (input box + result container). False ⇒ the site cannot be
	// driven and the UI must say so instead of failing mid-request.
	HasSelectors bool `json:"hasSelectors"`
}

// Manager owns the webhub site registry: the persisted prefix mapping, the
// probe history and the browser session manager. It is the object the API
// layer and the bridge talk to.
//
// It is safe for concurrent use.
type Manager struct {
	mu   sync.RWMutex
	dir  string
	path string
	// profileDir is the persistent browser profile dir (login state lives
	// here); Connect launches with it when nothing listens on the port.
	profileDir string
	// state is the persisted user state.
	state SiteState
	// sessions is the browser attachment surface (may be nil when the browser
	// could not be launched; every status then reports connected=false).
	sessions *SessionManager
	// probeFn runs a readiness probe for a site (injected; defaults to
	// Probe). Kept as a field so tests can substitute a fake.
	probeFn func(site string) error
	// ensureMu serializes lazy browser connects (single-flight); lastEnsure/
	// lastEnsureErr throttle repeated attempts when no browser is available.
	ensureMu      sync.Mutex
	lastEnsure    time.Time
	lastEnsureErr error
	// connectFn is the browser bring-up hook (Connect by default; tests
	// inject a stub so unit tests never launch a real browser).
	connectFn func(profileDir string, port int, headless bool) (wsURL string, launched bool, err error)
	logger    Logger
}

// NewManager loads (or creates) the webhub state file under dir.
func NewManager(dir string, logger Logger) (*Manager, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("webhub: data dir: %w", err)
	}
	m := &Manager{
		dir:        dir,
		path:       filepath.Join(dir, "sites.json"),
		profileDir: ResolveProfileDir("", dir),
		sessions:   NewSessionManager(""),
		logger:     logger,
	}
	m.state.Prefixes = map[string]string{}
	m.state.LastOK = map[string]int64{}
	if err := m.load(); err != nil {
		return nil, err
	}
	return m, nil
}

// load reads the state file. A missing file is not an error (first run).
func (m *Manager) load() error {
	raw, err := os.ReadFile(m.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("webhub: read state: %w", err)
	}
	var st SiteState
	if err := json.Unmarshal(raw, &st); err != nil {
		return fmt.Errorf("webhub: parse state: %w", err)
	}
	if st.Prefixes != nil {
		m.state.Prefixes = st.Prefixes
	}
	if st.LastOK != nil {
		m.state.LastOK = st.LastOK
	}
	return nil
}

// saveLocked writes the state file atomically (temp + rename), matching the
// project-wide persistence discipline. Caller must hold m.mu.
func (m *Manager) saveLocked() error {
	raw, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return fmt.Errorf("webhub: marshal state: %w", err)
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("webhub: write state: %w", err)
	}
	if err := os.Rename(tmp, m.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("webhub: rename state: %w", err)
	}
	return nil
}

// Sessions exposes the session manager (API layer uses it for open/status).
func (m *Manager) Sessions() *SessionManager { return m.sessions }

// SetLogger replaces the logger (the app wires *console.Logger).
func (m *Manager) SetLogger(l Logger) {
	m.mu.Lock()
	m.logger = l
	m.mu.Unlock()
}

// SetEndpoint wires (or clears) the CDP endpoint.
func (m *Manager) SetEndpoint(wsURL string) {
	m.mu.Lock()
	m.sessions.SetEndpoint(wsURL)
	m.mu.Unlock()
}

// SetProbeFn overrides the readiness probe implementation.
func (m *Manager) SetProbeFn(fn func(site string) error) {
	m.mu.Lock()
	m.probeFn = fn
	m.mu.Unlock()
}

// browserRetryInterval throttles lazy connect attempts: a machine without a
// usable browser must not launch-start on every status poll.
const browserRetryInterval = 3 * time.Second

// EnsureBrowser brings the CDP endpoint up if it is not up yet. It is the
// lazy counterpart of the app's startup connect: a browser that failed to
// launch at startup (or was closed since) self-heals on the next
// status/open/probe call. Single-flight and throttled.
func (m *Manager) EnsureBrowser() error {
	if m.sessions.Endpoint() != "" {
		return nil
	}
	m.ensureMu.Lock()
	defer m.ensureMu.Unlock()
	if m.sessions.Endpoint() != "" {
		return nil // a concurrent ensure won the race
	}
	if !m.lastEnsure.IsZero() && time.Since(m.lastEnsure) < browserRetryInterval {
		return m.lastEnsureErr
	}
	m.lastEnsure = time.Now()
	connect := m.connectFn
	if connect == nil {
		connect = Connect
	}
	wsURL, launched, err := connect(m.profileDir, DefaultPort, false)
	if err != nil {
		m.lastEnsureErr = err
		if m.logger != nil {
			m.logger.Warn("[webhub] browser unavailable: %v", err)
		}
		return err
	}
	m.lastEnsureErr = nil
	m.SetEndpoint(wsURL)
	if m.logger != nil {
		if launched {
			m.logger.Info("[webhub] browser launched on :%d", DefaultPort)
		} else {
			m.logger.Info("[webhub] attached to the running browser on :%d", DefaultPort)
		}
	}
	return nil
}

// SetConnectFn overrides the browser bring-up hook (tests inject a stub so
// unit tests never launch a real browser).
func (m *Manager) SetConnectFn(fn func(profileDir string, port int, headless bool) (wsURL string, launched bool, err error)) {
	m.mu.Lock()
	m.connectFn = fn
	m.mu.Unlock()
}

// BrowserError returns the last lazy-connect failure ("") when the browser is
// up. The status endpoint surfaces it so the page can explain WHY nothing is
// connected instead of a bare 未连接 (页面可排障).
func (m *Manager) BrowserError() string {
	m.ensureMu.Lock()
	defer m.ensureMu.Unlock()
	if m.sessions.Endpoint() != "" {
		return ""
	}
	if m.lastEnsureErr == nil {
		return ""
	}
	return m.lastEnsureErr.Error()
}

// ResolveSite reports live connectivity for a site: reuses the cached session
// when one exists, and otherwise scans the browser's tabs and attaches the
// site's own tab when present. It never opens or navigates a tab — OpenTab
// (POST .../open, the user's explicit "Open Site" click) is the only path
// that does.
//
// ⚠️ 缺陷 24（2026-10-03 用户要求）：它**不启动浏览器**（不调
// EnsureBrowser）。此前 status 会惰性启动，于是「看一下状态」就把 Chrome
// 拉起来（还弹空白页），也解释了 app 一启动就弹窗（启动路径里另有
// EnsureBrowser，已移除）。浏览器实例现在只由 openSite 触发。
//
// 已连接的浏览器被关掉时：端点失效 ⇒ 清空并报 connected=false（下一次
// open 会重新拉起）。
func (m *Manager) ResolveSite(site string) (connected, attached bool, tabURL string) {
	domain := normalizeDomain(site)
	if m.sessions.Endpoint() == "" {
		return false, false, ""
	}
	if att, url := m.sessions.Status(domain); att {
		return true, true, url
	}
	tab, err := m.sessions.FindTab(context.Background(), domain)
	if err != nil {
		// Endpoint stale (browser closed/restarted): drop it and report
		// disconnected. No relaunch here — see the doc comment.
		m.SetEndpoint("")
		if m.logger != nil {
			m.logger.Warn("[webhub] browser endpoint stale, clearing it: %v", err)
		}
		return false, false, ""
	}
	if tab == nil {
		return true, false, ""
	}
	if _, err := m.sessions.Open(context.Background(), domain); err != nil {
		return true, false, tab.URL
	}
	_, url := m.sessions.Status(domain)
	return true, true, url
}

// probeFnLocked returns the active probe implementation.
func (m *Manager) probeFnLocked() func(site string) error {
	if m.probeFn != nil {
		return m.probeFn
	}
	return func(site string) error { return m.Probe(site) }
}

// Prefix returns the stored call prefix for a site ("" when not bridged).
func (m *Manager) Prefix(site string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.Prefixes[normalizeDomain(site)]
}

// SetPrefix records a site's call prefix. Validation and conflict detection
// live on the Bridge (which owns the registry); this only persists the value
// the Bridge already accepted.
func (m *Manager) SetPrefix(site, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Prefixes == nil {
		m.state.Prefixes = map[string]string{}
	}
	domain := normalizeDomain(site)
	if domain == "" {
		return fmt.Errorf("webhub: empty site")
	}
	m.state.Prefixes[domain] = prefix
	return m.saveLocked()
}

// Prefixes returns a copy of every stored prefix (site → prefix).
func (m *Manager) Prefixes() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.state.Prefixes))
	for k, v := range m.state.Prefixes {
		out[k] = v
	}
	return out
}

// MarkOK records a successful probe for a site.
func (m *Manager) MarkOK(site string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.LastOK == nil {
		m.state.LastOK = map[string]int64{}
	}
	m.state.LastOK[normalizeDomain(site)] = time.Now().UnixMilli()
	_ = m.saveLocked()
}

// LastOK returns the unix ms of a site's last successful probe (0 = never).
func (m *Manager) LastOK(site string) int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.LastOK[normalizeDomain(site)]
}

// Sites returns the API view of every supported site. bridgedFn reports
// whether a site's provider is registered in the registry (supplied by the
// Bridge, which owns that knowledge).
func (m *Manager) Sites(bridgedFn func(site string) bool) []SiteInfo {
	rules := AllSites()
	out := make([]SiteInfo, 0, len(rules))
	for i := range rules {
		r := &rules[i]
		info := SiteInfo{
			Domain:        r.Domain,
			DisplayName:   displayName(r.Domain),
			PresetCount:   len(r.Presets),
			DefaultPreset: r.DefaultPreset,
			Prefix:        m.Prefix(r.Domain),
			ModelIDs:      m.ModelIDs(r.Domain),
			LastOKMs:      m.LastOK(r.Domain),
			HasSelectors:  r.Default().HasSelectors(),
		}
		if bridgedFn != nil {
			info.Bridged = bridgedFn(r.Domain)
		}
		if m.sessions != nil {
			info.Connected = m.sessions.Endpoint() != ""
			if attached, tabURL := m.sessions.Status(r.Domain); attached {
				info.Ready = true
				info.TabURL = tabURL
			}
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Domain < out[j].Domain })
	return out
}

// ModelIDs returns the `{prefix}/{modelID}` strings a site exposes. Without a
// prefix the bare model ids are returned (the site is not callable yet, but
// the UI still shows what the id space looks like).
func (m *Manager) ModelIDs(site string) []string {
	domain := normalizeDomain(site)
	rule := SiteRuleByDomain(domain)
	if rule == nil {
		return nil
	}
	prefix := m.Prefix(domain)
	ids := ModelIDsForSite(domain, rule.PresetNames())
	if prefix == "" {
		return ids
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, prefix+"/"+id)
	}
	return out
}

// displayName renders a UI label for a site domain (the short id, with the
// first letter capitalized). Routing never uses it.
func displayName(domain string) string {
	short := SiteCardID(domain)
	if short == "" {
		return domain
	}
	return strings.ToUpper(short[:1]) + short[1:]
}

// SiteExists reports whether a site domain is supported.
func SiteExists(site string) bool {
	return SiteRuleByDomain(site) != nil
}

// SplitCallModel splits a `{prefix}/{modelID}` caller string into its parts.
// It is the webhub-shaped counterpart of util.SplitModel, kept here so the
// bridge does not re-implement prefix stripping.
func SplitCallModel(model string) (prefix, modelID string) {
	p, rest := util.SplitModel(model)
	return p, rest
}
