// Package browserlaunch opens a URL in a **chosen** browser installation, with
// an optional private (off-the-record) session or a dedicated persistent
// profile directory.
//
// ## Why this package exists
//
// Free Hub's "+ New Account" flows used to hand the authorization URL to the OS
// shell (`rundll32 url.dll,FileProtocolHandler`, see internal/fsutil), which
// always lands in the **default** browser's **shared** profile. That is wrong
// for two reasons:
//
//   - Multi-account: the browser is usually already signed in to account A, so
//     the "new" account silently re-authenticates A (nothing in the account
//     pool dedupes by provider identity — only by account id).
//   - Choice: users want to pick which browser handles the login, and whether
//     it reuses their existing session.
//
// ## What the OS does and does not offer (measured, 2026-10-05)
//
// There is **no shell/OS API** for "open this URL in a private window" and no
// shell verb that carries extra arguments: Explorer's URL association only ever
// runs `<browser> --single-argument <url>`. Private sessions therefore require
// resolving the browser binary ourselves and appending the family-specific
// switch. The switch names are **not** uniform, and a wrong one degrades
// silently to a normal window (no error, no exit code):
//
//	chrome/chromium/brave/vivaldi  --incognito      (verified on Chrome 141)
//	edge                           --inprivate      (verified on Edge 154;
//	                                                 --incognito opened a NORMAL
//	                                                 window with no diagnostic)
//	opera                          --private
//	firefox                        -private-window
//
// Unknown chromium forks are refused (see ErrUnknownPrivate): guessing would
// present a normal window to the user as a "private" login while quietly
// reusing the shared session — the exact failure this feature must prevent.
//
// Flags survive forwarding to an already-running instance (verified: Chrome
// with a live instance + `--incognito` still landed in off-the-record storage),
// so the common "browser is already open" case behaves identically.
package browserlaunch

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/tinylab/tinylab/internal/fsutil"
)

// Family is the browser engine family — the unit that decides which private
// switch name is correct.
type Family string

const (
	FamilyChrome   Family = "chrome"
	FamilyChromium Family = "chromium"
	FamilyEdge     Family = "edge"
	FamilyBrave    Family = "brave"
	FamilyVivaldi  Family = "vivaldi"
	FamilyOpera    Family = "opera"
	FamilyFirefox  Family = "firefox"
	// FamilyUnknown is any binary whose private-mode switch we cannot name.
	FamilyUnknown Family = "unknown"
)

// exeFamilies maps a normalized executable base name (lowercase, .exe
// stripped) to its family. It covers the Windows names plus the macOS bundle
// binaries ("Google Chrome") and the Linux commands ("google-chrome-stable").
var exeFamilies = map[string]Family{
	"chrome":               FamilyChrome,
	"google chrome":        FamilyChrome,
	"google-chrome":        FamilyChrome,
	"google-chrome-stable": FamilyChrome,
	"chromium":             FamilyChromium,
	"chromium-browser":     FamilyChromium,
	"msedge":               FamilyEdge,
	"microsoft edge":       FamilyEdge,
	"microsoft-edge":       FamilyEdge,
	"brave":                FamilyBrave,
	"brave browser":        FamilyBrave,
	"brave-browser":        FamilyBrave,
	"vivaldi":              FamilyVivaldi,
	"opera":                FamilyOpera,
	"firefox":              FamilyFirefox,
}

// exeLabels maps the same base names to the user-facing product name (used for
// the resolved default browser, which we only know by path).
var exeLabels = map[string]string{
	"chrome":               "Google Chrome",
	"google chrome":        "Google Chrome",
	"google-chrome":        "Google Chrome",
	"google-chrome-stable": "Google Chrome",
	"chromium":             "Chromium",
	"chromium-browser":     "Chromium",
	"msedge":               "Microsoft Edge",
	"microsoft edge":       "Microsoft Edge",
	"microsoft-edge":       "Microsoft Edge",
	"brave":                "Brave",
	"brave browser":        "Brave",
	"brave-browser":        "Brave",
	"vivaldi":              "Vivaldi",
	"opera":                "Opera",
	"firefox":              "Firefox",
}

// privateArgs are the **verified** private-session switches per family.
var privateArgs = map[Family][]string{
	FamilyChrome:   {"--incognito"},
	FamilyChromium: {"--incognito"},
	FamilyEdge:     {"--inprivate"},
	FamilyBrave:    {"--incognito"},
	FamilyVivaldi:  {"--incognito"},
	FamilyOpera:    {"--private"},
	FamilyFirefox:  {"-private-window"},
}

// profileFlagFamilies are the families that accept a dedicated persistent
// user-data-dir. Firefox uses `-profile <dir>` instead, so it is excluded
// rather than silently writing into a directory Firefox ignores.
var profileFlagFamilies = map[Family]bool{
	FamilyChrome:   true,
	FamilyChromium: true,
	FamilyEdge:     true,
	FamilyBrave:    true,
	FamilyVivaldi:  true,
	FamilyOpera:    true,
}

// baseName normalizes an executable path or name for the lookup tables.
func baseName(exePath string) string {
	base := strings.ToLower(filepath.Base(strings.TrimSpace(exePath)))
	return strings.TrimSuffix(base, ".exe")
}

// FamilyOf resolves the engine family of a browser binary. FamilyUnknown means
// "do not claim a private mode for this binary".
func FamilyOf(exePath string) Family {
	if f, ok := exeFamilies[baseName(exePath)]; ok {
		return f
	}
	return FamilyUnknown
}

// LabelOf returns the product name for a browser binary (falls back to the
// file name so the UI never shows an empty label).
func LabelOf(exePath string) string {
	base := baseName(exePath)
	if l, ok := exeLabels[base]; ok {
		return l
	}
	if base == "" {
		return ""
	}
	return filepath.Base(exePath)
}

// PrivateArgs returns the private-session switches for a family. ok is false
// for families whose switch is unknown — callers must refuse rather than open a
// normal window and call it private.
func PrivateArgs(f Family) (args []string, ok bool) {
	a, ok := privateArgs[f]
	if !ok {
		return nil, false
	}
	return append([]string(nil), a...), true
}

// ProfileSupported reports whether the family accepts --user-data-dir.
func ProfileSupported(f Family) bool { return profileFlagFamilies[f] }

// Errors surfaced verbatim to the Free Hub UI (Chinese, like the other
// user-facing login errors in internal/jethub).
var (
	// ErrNoBin: a private/profile launch was requested but no binary was named.
	// The OS shell cannot carry flags, so there is nothing safe to do.
	ErrNoBin = errors.New("browserlaunch: 未指定浏览器，无法使用隐私模式或独立配置（系统默认浏览器接口不支持参数）")
	// ErrUnknownPrivate: the binary's engine family is unknown.
	ErrUnknownPrivate = errors.New("browserlaunch: 无法确认该浏览器的隐私窗口参数（内核未知），请改用其它浏览器或「独立配置」模式")
	// ErrPrivateWithProfile: the two isolation modes are mutually exclusive.
	ErrPrivateWithProfile = errors.New("browserlaunch: 隐私窗口与独立配置目录不能同时使用")
	// ErrProfileUnsupported: the family has no --user-data-dir equivalent.
	ErrProfileUnsupported = errors.New("browserlaunch: 该浏览器不支持独立配置目录")
	// ErrNoDefaultBrowser: the OS default browser could not be resolved.
	ErrNoDefaultBrowser = errors.New("browserlaunch: 无法识别系统默认浏览器，请改为指定浏览器")
)

// Launch describes one browser launch.
type Launch struct {
	// URL is the page to open (the authorization/login page).
	URL string
	// Bin is the browser executable. Empty = hand the URL to the OS shell
	// (default browser, **shared** profile, no flags) — the legacy behavior.
	Bin string
	// Private opens an off-the-record window of Bin.
	Private bool
	// ProfileDir is a dedicated persistent user-data-dir (created by the
	// browser). Relative paths are absolutized: Chrome fails **silently** on a
	// relative --user-data-dir (see docs/webhub-architecture.md §2.3).
	ProfileDir string
}

// BuildArgs builds the browser command line for a launch. Pure (no process, no
// filesystem writes beyond filepath.Abs) so the flag set is testable.
func BuildArgs(l Launch) ([]string, error) {
	if l.Bin == "" {
		if l.Private || l.ProfileDir != "" {
			return nil, ErrNoBin
		}
		return nil, nil
	}
	if l.Private && l.ProfileDir != "" {
		return nil, ErrPrivateWithProfile
	}
	family := FamilyOf(l.Bin)
	var args []string
	if l.Private {
		pa, ok := PrivateArgs(family)
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrUnknownPrivate, filepath.Base(l.Bin))
		}
		args = append(args, pa...)
	}
	if l.ProfileDir != "" {
		if !ProfileSupported(family) {
			return nil, fmt.Errorf("%w: %s", ErrProfileUnsupported, filepath.Base(l.Bin))
		}
		abs, err := filepath.Abs(l.ProfileDir)
		if err != nil {
			return nil, fmt.Errorf("browserlaunch: 独立配置目录必须是绝对路径: %w", err)
		}
		// --no-first-run/--no-default-browser-check only matter for a fresh
		// profile (the dedicated dir): without them Chrome shows the first-run
		// wizard instead of the login page.
		args = append(args,
			"--user-data-dir="+abs,
			"--no-first-run",
			"--no-default-browser-check",
		)
	}
	return append(args, l.URL), nil
}

// startProcess is injectable for tests.
var startProcess = func(bin string, args []string) error {
	cmd := exec.Command(bin, args...)
	prepare(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	// Never Wait: a forwarded launch exits immediately, a cold launch runs for
	// as long as the user keeps the window open, and both are normal. Release
	// frees the handle without blocking.
	return cmd.Process.Release()
}

// Open launches the URL. It returns as soon as the browser process is started;
// it never waits for the window to close and never kills anything.
func Open(l Launch) error {
	args, err := BuildArgs(l)
	if err != nil {
		return err
	}
	if l.Bin == "" {
		return fsutil.OpenInBrowser(l.URL)
	}
	if err := startProcess(l.Bin, args); err != nil {
		return fmt.Errorf("browserlaunch: 启动 %s 失败: %w", filepath.Base(l.Bin), err)
	}
	return nil
}
