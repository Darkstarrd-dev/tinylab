package jethub

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tinylab/tinylab/internal/browserlaunch"
	"github.com/tinylab/tinylab/internal/fsutil"
)

// 登录浏览器 / 会话模式（+新建账号 的可选行为）。
//
// ## 为什么需要它（评估结论，2026-10-05 真机实测）
//
// 此前登录页统一交给系统 shell（`importUrl` → `fsutil.OpenInBrowser`，
// rundll32/FileProtocolHandler），也就是**默认浏览器的共享登录态**。对本模块的
// 主用途（同 provider 多账号）这是错的：浏览器通常已登录账号 A，于是「新建」
// 出来的账号会静默复用 A 的身份 —— 账号池只按 `Account.ID` 去重（manager.go
// AddAccount），并不按 provider 身份去重，重复凭据没有任何拦截。
//
// 两条正交的可选维度：
//
//	浏览器轴 Browser："" → 记住的偏好 → 系统默认
//	                  "default" / browserlaunch 检测到的 id / "custom" + BrowserPath
//	会话轴   Session："" → 记住的偏好 → "shared"
//	                  "shared"   共享登录态（默认浏览器时退化为旧的 shell 打开）
//	                  "private"  浏览器隐私窗口（--incognito/--inprivate/…）
//	                  "isolated" 独立持久配置目录（每账号一个 --user-data-dir）
//
// ⚠️ **隐私模式只能靠我们自己解析 exe + 拼参数**：Windows 没有「用默认浏览器
// 打开隐私窗口」的 shell 接口，而 flag 名按内核族不同，写错会**静默退化**成普通
// 窗口（实测 Edge 154 不认识 `--incognito`，无报错、无退出码）。因此内核未知时
// 一律**拒绝**（browserlaunch.ErrUnknownPrivate），绝不让用户以为在隐私窗口里
// 登录、实际却复用了共享会话。
//
// ⚠️ `isolated` 的目录是**持久**的（不是临时目录）：Chrome 对相对
// `--user-data-dir` 会静默失败（webhub 缺陷 21），故一律 absolutize；目录随账号
// 删除做尽力清理（`DeleteAccount`），进程仍开着浏览器时清理失败即放弃 —— 本项目
// 从不杀用户浏览器（webhub LaunchPolicy 同款边界）。

// Browser/session selector values (wire format, shared with the UI).
const (
	// BrowserDefault is the OS default browser (resolved at open time).
	BrowserDefault = "default"
	// BrowserCustom uses OpenOptions.BrowserPath.
	BrowserCustom = "custom"
	// SessionShared reuses the browser's normal profile (its existing logins).
	SessionShared = "shared"
	// SessionPrivate opens an off-the-record window (no saved login state).
	SessionPrivate = "private"
	// SessionIsolated uses a dedicated persistent profile dir per account.
	SessionIsolated = "isolated"
)

// profileRootName is the subdirectory of the jethub data dir that holds the
// dedicated browser profiles of SessionIsolated logins.
const profileRootName = "browser-profiles"

// OpenOptions selects how a login page is opened. The zero value means "the
// remembered preference", which itself falls back to the legacy behavior
// (default browser, shared session).
type OpenOptions struct {
	// Browser is "" | "default" | a browserlaunch id ("chrome"/"edge"/…) | "custom".
	Browser string `json:"browser,omitempty"`
	// BrowserPath is the executable for Browser == "custom".
	BrowserPath string `json:"browserPath,omitempty"`
	// Session is "" | "shared" | "private" | "isolated".
	Session string `json:"session,omitempty"`
	// AccountID keys the dedicated profile dir for Session == "isolated".
	// Never persisted (it belongs to one login attempt).
	AccountID string `json:"-"`
}

// ValidSession reports whether s names a session mode.
func ValidSession(s string) bool {
	switch s {
	case SessionShared, SessionPrivate, SessionIsolated:
		return true
	}
	return false
}

// normalizeOpenOptions fills empty arms from the remembered preference, then
// from the legacy default. It does not validate (see ValidateOpenOptions).
func normalizeOpenOptions(opt, prefs OpenOptions) OpenOptions {
	out := opt
	if out.Browser == "" {
		out.Browser = prefs.Browser
	}
	if out.BrowserPath == "" {
		out.BrowserPath = prefs.BrowserPath
	}
	if out.Browser == "" {
		out.Browser = BrowserDefault
	}
	if out.Session == "" {
		out.Session = prefs.Session
	}
	if out.Session == "" {
		out.Session = SessionShared
	}
	// A path is only meaningful with the custom arm.
	if out.Browser != BrowserCustom {
		out.BrowserPath = ""
	}
	return out
}

// ValidateOpenOptions normalizes the selection and proves it can actually be
// launched (browser resolvable, private switch known for that family), without
// starting a process. The API layer calls it **before** creating the account /
// starting the flow so an unusable selection is a 400 instead of a login that
// silently never opens a page.
func (m *Manager) ValidateOpenOptions(opt OpenOptions) (OpenOptions, error) {
	norm := normalizeOpenOptions(opt, m.LoginOpenPrefs())
	if !ValidSession(norm.Session) {
		return norm, fmt.Errorf("jethub: 未知的会话模式 %q", norm.Session)
	}
	bin, err := ResolveOpenBrowser(norm)
	if err != nil {
		return norm, err
	}
	// Reuse the launcher's own validation for the flag set (single source of
	// truth: private switch known, profile dir supported, arms exclusive).
	probe := browserlaunch.Launch{URL: "http://127.0.0.1/", Bin: bin}
	if norm.Session == SessionPrivate {
		probe.Private = true
	}
	if norm.Session == SessionIsolated {
		probe.ProfileDir = m.IsolatedProfileDir(norm.AccountID)
	}
	if _, err := browserlaunch.BuildArgs(probe); err != nil {
		return norm, err
	}
	return norm, nil
}

// ResolveOpenBrowser resolves the selection to a browser executable. An empty
// result means "hand the URL to the OS shell", which is only correct for the
// default browser with a shared session (the shell cannot pass flags).
//
// ⚠️ default + shared deliberately stays on the shell path: that is byte-for-byte
// the pre-feature behavior, so an existing user who never touches the dialog
// sees no change at all (and an association that is not a plain exe — a launcher
// or a store app — keeps working, since the shell owns the activation).
func ResolveOpenBrowser(opt OpenOptions) (string, error) {
	switch opt.Browser {
	case "", BrowserDefault:
		if opt.Session == SessionShared {
			return "", nil
		}
		d := browserlaunch.DefaultBrowser()
		if d.Path == "" {
			return "", browserlaunch.ErrNoDefaultBrowser
		}
		return d.Path, nil
	case BrowserCustom:
		path := strings.TrimSpace(opt.BrowserPath)
		if path == "" {
			return "", errors.New("jethub: 自定义浏览器未指定可执行文件路径")
		}
		if st, err := os.Stat(path); err != nil || st.IsDir() {
			return "", fmt.Errorf("jethub: 浏览器不存在: %s", path)
		}
		return path, nil
	default:
		b, ok := browserlaunch.Find(opt.Browser)
		if !ok {
			return "", fmt.Errorf("jethub: 未检测到浏览器 %q（可能未安装），请改选已安装的浏览器或指定路径", opt.Browser)
		}
		return b.Path, nil
	}
}

// OpenLoginURL launches the login page with the given selection. It returns as
// soon as the browser process is started (never waits for the window) and never
// kills anything.
func (m *Manager) OpenLoginURL(u string, opt OpenOptions) error {
	if strings.TrimSpace(u) == "" {
		return errors.New("jethub: 登录页地址为空")
	}
	norm := normalizeOpenOptions(opt, m.LoginOpenPrefs())
	if !ValidSession(norm.Session) {
		return fmt.Errorf("jethub: 未知的会话模式 %q", norm.Session)
	}
	bin, err := ResolveOpenBrowser(norm)
	if err != nil {
		return err
	}
	launch := browserlaunch.Launch{URL: u, Bin: bin}
	switch norm.Session {
	case SessionPrivate:
		launch.Private = true
	case SessionIsolated:
		launch.ProfileDir = m.IsolatedProfileDir(norm.AccountID)
	}
	return browserlaunch.Open(launch)
}

// IsolatedProfileDir returns the dedicated browser profile directory of one
// account (absolute). Account ids are generated by NewAccountID, but the value
// is sanitized defensively: it becomes a path segment here.
func (m *Manager) IsolatedProfileDir(accountID string) string {
	key := sanitizeProfileKey(accountID)
	if key == "" {
		key = "default"
	}
	abs, err := filepath.Abs(filepath.Join(m.dir, profileRootName, key))
	if err != nil {
		// Abs only fails when the process CWD is gone; the joined path is still
		// the best answer (and Chrome will refuse it loudly if it is relative).
		return filepath.Join(m.dir, profileRootName, key)
	}
	return abs
}

// sanitizeProfileKey keeps [A-Za-z0-9_-] and replaces everything else (path
// separators, drive colons, dots) so an account id can never escape the root —
// not even as a ".." segment. Generated ids are {provider}-{8hex}; the mapping
// only matters for imported/legacy ids, where a mangled name is harmless.
func sanitizeProfileKey(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '_' || r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// ---------- remembered preference ----------

// loginOpenPrefsFile is the persisted "last used" selection
// ({dir}/login-open.json). It lives beside accounts.json but in its own file:
// a backup import must not reset a local UI preference, and the backup payload
// shape stays byte-compatible with the original plugin.
type loginOpenPrefsFile struct {
	Browser     string `json:"browser,omitempty"`
	BrowserPath string `json:"browserPath,omitempty"`
	Session     string `json:"session,omitempty"`
}

func (m *Manager) loginOpenPath() string { return filepath.Join(m.dir, "login-open.json") }

// LoginOpenPrefs returns the remembered selection (zero value when never set).
func (m *Manager) LoginOpenPrefs() OpenOptions {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.loginOpen
}

// SetLoginOpenPrefs validates and persists the selection (atomic write). An
// unusable selection is rejected so the next +新建账号 cannot silently degrade.
func (m *Manager) SetLoginOpenPrefs(opt OpenOptions) error {
	m.mu.Lock()
	norm := normalizeOpenOptions(opt, m.loginOpen)
	norm.AccountID = ""
	m.mu.Unlock()
	if !ValidSession(norm.Session) {
		return fmt.Errorf("jethub: 未知的会话模式 %q", norm.Session)
	}
	if _, err := ResolveOpenBrowser(norm); err != nil {
		return err
	}
	data, err := json.MarshalIndent(loginOpenPrefsFile{
		Browser: norm.Browser, BrowserPath: norm.BrowserPath, Session: norm.Session,
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(m.loginOpenPath(), data, 0600); err != nil {
		return fmt.Errorf("jethub: 保存登录浏览器偏好: %w", err)
	}
	m.mu.Lock()
	m.loginOpen = norm
	m.mu.Unlock()
	return nil
}

// loadLoginOpenPrefs reads the remembered selection. A missing/corrupt file is
// not fatal (the preference is cosmetic): it degrades to the legacy default.
func (m *Manager) loadLoginOpenPrefs() error {
	data, err := os.ReadFile(m.loginOpenPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("jethub: 读取登录浏览器偏好: %w", err)
	}
	var pf loginOpenPrefsFile
	if err := json.Unmarshal(data, &pf); err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] 登录浏览器偏好文件损坏，已回退默认浏览器: %v", err)
		}
		return nil
	}
	m.loginOpen = OpenOptions{Browser: pf.Browser, BrowserPath: pf.BrowserPath, Session: pf.Session}
	return nil
}

// cleanupIsolatedProfile removes a deleted account's dedicated browser profile
// on a best-effort basis. A running browser keeps its files locked, so failure
// is expected and harmless — the directory is reusable and never shared.
func (m *Manager) cleanupIsolatedProfile(dir string) {
	if dir == "" {
		return
	}
	// Guard: only ever delete inside our own profile root.
	root := filepath.Join(m.dir, profileRootName)
	if !strings.HasPrefix(filepath.Clean(dir), filepath.Clean(root)+string(os.PathSeparator)) {
		return
	}
	if err := os.RemoveAll(dir); err != nil && m.logger != nil {
		m.logger.Info("[jethub] 独立配置目录未清理（浏览器可能仍在运行）: %v", err)
	}
}
