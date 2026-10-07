package jethub

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/browserlaunch"
)

// writeFakeBrowser creates an empty file with a browser-ish name: enough to
// resolve an engine family and validate a profile dir without launching
// anything (a launch would pop a real window on the developer machine).
func writeFakeBrowser(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("fake"), 0o600); err != nil {
		t.Fatalf("write fake browser: %v", err)
	}
	return p
}

func TestValidSession(t *testing.T) {
	for _, ok := range []string{SessionShared, SessionPrivate, SessionIsolated} {
		if !ValidSession(ok) {
			t.Fatalf("%q must be a valid session mode", ok)
		}
	}
	for _, bad := range []string{"", "Shared", "incognito", "private "} {
		if ValidSession(bad) {
			t.Fatalf("%q must not be a valid session mode", bad)
		}
	}
}

// TestNormalizeOpenOptions pins the fallback chain: request → remembered
// preference → legacy default (default browser + shared session). This is what
// keeps an old client posting `{}` behaving exactly as before the feature.
func TestNormalizeOpenOptions(t *testing.T) {
	legacy := normalizeOpenOptions(OpenOptions{}, OpenOptions{})
	if legacy.Browser != BrowserDefault || legacy.Session != SessionShared {
		t.Fatalf("zero selection must fall back to the legacy default, got %+v", legacy)
	}
	prefs := OpenOptions{Browser: "edge", Session: SessionPrivate}
	fromPrefs := normalizeOpenOptions(OpenOptions{}, prefs)
	if fromPrefs.Browser != "edge" || fromPrefs.Session != SessionPrivate {
		t.Fatalf("empty arms must come from the preference, got %+v", fromPrefs)
	}
	partial := normalizeOpenOptions(OpenOptions{Session: SessionIsolated}, prefs)
	if partial.Browser != "edge" || partial.Session != SessionIsolated {
		t.Fatalf("a partial request must merge with the preference, got %+v", partial)
	}
	// A stale custom path must not leak into a named-browser selection.
	stale := normalizeOpenOptions(OpenOptions{Browser: BrowserCustom, BrowserPath: "/x/chrome.exe", Session: SessionShared}, prefs)
	if stale.BrowserPath != "/x/chrome.exe" {
		t.Fatalf("custom path must survive with the custom arm, got %+v", stale)
	}
	dropped := normalizeOpenOptions(OpenOptions{Browser: "chrome", BrowserPath: "/x/chrome.exe"}, prefs)
	if dropped.BrowserPath != "" {
		t.Fatalf("path without the custom arm must be dropped, got %+v", dropped)
	}
}

func TestResolveOpenBrowser(t *testing.T) {
	// Default browser + shared session is the legacy shell path: nothing to
	// resolve, and nothing that may fail (platform-independent).
	bin, err := ResolveOpenBrowser(OpenOptions{Browser: BrowserDefault, Session: SessionShared})
	if err != nil || bin != "" {
		t.Fatalf("default+shared must resolve to the shell path, got %q / %v", bin, err)
	}
	// Unknown browser id.
	if _, err := ResolveOpenBrowser(OpenOptions{Browser: "nope-browser"}); err == nil {
		t.Fatal("an undetected browser id must error")
	}
	// Custom arm: missing path, directory, and a usable file.
	if _, err := ResolveOpenBrowser(OpenOptions{Browser: BrowserCustom}); err == nil {
		t.Fatal("custom without a path must error")
	}
	if _, err := ResolveOpenBrowser(OpenOptions{Browser: BrowserCustom, BrowserPath: filepath.Join(t.TempDir(), "nope.exe")}); err == nil {
		t.Fatal("a missing custom path must error")
	}
	if _, err := ResolveOpenBrowser(OpenOptions{Browser: BrowserCustom, BrowserPath: t.TempDir()}); err == nil {
		t.Fatal("a directory is not a browser")
	}
	exe := writeFakeBrowser(t, "chrome.exe")
	got, err := ResolveOpenBrowser(OpenOptions{Browser: BrowserCustom, BrowserPath: exe})
	if err != nil || got != exe {
		t.Fatalf("custom resolve = %q / %v", got, err)
	}
}

// TestIsolatedProfileDir: the account id becomes a path segment, so it must
// never escape the profile root, and the result must be absolute (a relative
// --user-data-dir makes Chrome fail silently — webhub 缺陷 21).
func TestIsolatedProfileDir(t *testing.T) {
	env := newTestManager(t)
	dir := env.m.IsolatedProfileDir("../../etc/passwd")
	if !filepath.IsAbs(dir) {
		t.Fatalf("profile dir must be absolute, got %q", dir)
	}
	root := filepath.Join(env.dir, profileRootName)
	if !strings.HasPrefix(dir, root+string(os.PathSeparator)) {
		t.Fatalf("profile dir %q must stay under %q", dir, root)
	}
	if strings.Contains(dir, "..") {
		t.Fatalf("path traversal must be stripped, got %q", dir)
	}
	if got := filepath.Base(dir); got == "" || strings.ContainsAny(got, `/\:`) {
		t.Fatalf("the last segment must be a plain name, got %q", got)
	}
	// Two accounts never share a directory.
	a := env.m.IsolatedProfileDir("qoder-1")
	b := env.m.IsolatedProfileDir("qoder-2")
	if a == b {
		t.Fatalf("distinct accounts must get distinct profiles: %q", a)
	}
	// An empty id still yields a usable directory.
	if env.m.IsolatedProfileDir("") == "" {
		t.Fatal("an empty account id must still resolve a directory")
	}
}

// TestValidateOpenOptions: the API layer validates synchronously so an unusable
// choice is a 400 instead of a login that never opens a page.
func TestValidateOpenOptions(t *testing.T) {
	env := newTestManager(t)
	if _, err := env.m.ValidateOpenOptions(OpenOptions{Browser: "nope-browser"}); err == nil {
		t.Fatal("an undetected browser id must fail validation")
	}
	if _, err := env.m.ValidateOpenOptions(OpenOptions{Browser: BrowserCustom, BrowserPath: t.TempDir()}); err == nil {
		t.Fatal("a directory as the browser must fail validation")
	}
	if _, err := env.m.ValidateOpenOptions(OpenOptions{Session: "bogus"}); err == nil {
		t.Fatal("an unknown session mode must fail validation")
	}
	// An unknown engine cannot promise a private window — refuse instead of
	// silently opening a normal window (the measured Edge --incognito trap).
	weird := writeFakeBrowser(t, "mystery-browser.exe")
	_, err := env.m.ValidateOpenOptions(OpenOptions{
		Browser: BrowserCustom, BrowserPath: weird, Session: SessionPrivate,
	})
	if !errors.Is(err, browserlaunch.ErrUnknownPrivate) {
		t.Fatalf("private mode on an unknown engine must be refused, got %v", err)
	}
	// A known engine + isolated session validates (no launch happens here).
	chrome := writeFakeBrowser(t, "chrome.exe")
	opt, err := env.m.ValidateOpenOptions(OpenOptions{
		Browser: BrowserCustom, BrowserPath: chrome, Session: SessionIsolated, AccountID: "qoder-9",
	})
	if err != nil {
		t.Fatalf("isolated session on a known engine must validate: %v", err)
	}
	if opt.Session != SessionIsolated || opt.BrowserPath != chrome {
		t.Fatalf("validation must return the normalized selection, got %+v", opt)
	}
	// Validation must not depend on the accumulated state of the temp dir.
	if _, err := os.Stat(env.m.IsolatedProfileDir("qoder-9")); err == nil {
		t.Fatal("validation must not create the profile directory (the browser does that)")
	}
}

// TestValidateOpenOptionsFillsFromPrefs: the dialog pre-selects the remembered
// choice, so a request with empty arms must validate as that choice.
func TestValidateOpenOptionsFillsFromPrefs(t *testing.T) {
	env := newTestManager(t)
	chrome := writeFakeBrowser(t, "chrome.exe")
	if err := env.m.SetLoginOpenPrefs(OpenOptions{
		Browser: BrowserCustom, BrowserPath: chrome, Session: SessionIsolated,
	}); err != nil {
		t.Fatalf("set prefs: %v", err)
	}
	opt, err := env.m.ValidateOpenOptions(OpenOptions{AccountID: "zcode-1"})
	if err != nil {
		t.Fatal(err)
	}
	if opt.Browser != BrowserCustom || opt.BrowserPath != chrome || opt.Session != SessionIsolated {
		t.Fatalf("empty request must inherit the remembered choice, got %+v", opt)
	}
	if opt.AccountID != "zcode-1" {
		t.Fatalf("the per-attempt account id must be preserved, got %+v", opt)
	}
}

// TestSetLoginOpenPrefsRejectsUnusable: a preference that cannot be launched
// must be rejected up front (otherwise every later dialog silently degrades).
func TestSetLoginOpenPrefsRejectsUnusable(t *testing.T) {
	env := newTestManager(t)
	if err := env.m.SetLoginOpenPrefs(OpenOptions{Browser: "nope-browser"}); err == nil {
		t.Fatal("an undetected browser id must not be persisted")
	}
	if err := env.m.SetLoginOpenPrefs(OpenOptions{Session: "bogus"}); err == nil {
		t.Fatal("an unknown session must not be persisted")
	}
	if got := env.m.LoginOpenPrefs(); got != (OpenOptions{}) {
		t.Fatalf("a rejected preference must not be stored, got %+v", got)
	}
}

// TestLoginOpenPrefsRoundTrip: the remembered choice survives a restart (new
// Manager over the same dir) and never carries the per-attempt account id.
func TestLoginOpenPrefsRoundTrip(t *testing.T) {
	env := newTestManager(t)
	chrome := writeFakeBrowser(t, "chrome.exe")
	if err := env.m.SetLoginOpenPrefs(OpenOptions{
		Browser: BrowserCustom, BrowserPath: chrome, Session: SessionPrivate, AccountID: "must-not-persist",
	}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatalf("reload manager: %v", err)
	}
	got := reloaded.LoginOpenPrefs()
	if got.Browser != BrowserCustom || got.BrowserPath != chrome || got.Session != SessionPrivate {
		t.Fatalf("preference must survive a restart, got %+v", got)
	}
	if got.AccountID != "" {
		t.Fatalf("the per-attempt account id must never be persisted, got %q", got.AccountID)
	}
}

// TestLoginOpenPrefsCorruptFileIsNotFatal: the preference is cosmetic, so a
// damaged file must not break manager construction.
func TestLoginOpenPrefsCorruptFileIsNotFatal(t *testing.T) {
	env := newTestManager(t)
	if err := os.WriteFile(filepath.Join(env.dir, "login-open.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatalf("a corrupt preference file must not fail startup: %v", err)
	}
	if got := m.LoginOpenPrefs(); got != (OpenOptions{}) {
		t.Fatalf("a corrupt preference must degrade to the default, got %+v", got)
	}
}

// TestDeleteAccountCleansIsolatedProfile: the dedicated profile of a deleted
// account is dropped (best-effort, in the background).
func TestDeleteAccountCleansIsolatedProfile(t *testing.T) {
	env := newTestManager(t)
	id := "raccoon-deadbeef"
	if err := env.m.AddAccount(Account{
		ID: id, Provider: "raccoon", Nickname: id, Enabled: true, CredentialRef: "R-" + id,
	}); err != nil {
		t.Fatal(err)
	}
	dir := env.m.IsolatedProfileDir(id)
	if err := os.MkdirAll(filepath.Join(dir, "Default"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := env.m.DeleteAccount(id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the isolated profile of a deleted account must be cleaned up: %s", dir)
}

// TestCleanupIsolatedProfileRefusesForeignPaths: the cleanup must never touch
// anything outside {dir}/browser-profiles.
func TestCleanupIsolatedProfileRefusesForeignPaths(t *testing.T) {
	env := newTestManager(t)
	outside := filepath.Join(env.dir, "keep-me")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	env.m.cleanupIsolatedProfile(outside)
	env.m.cleanupIsolatedProfile(env.dir) // the root itself must survive too
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("a foreign path must never be deleted: %v", err)
	}
	if _, err := os.Stat(env.dir); err != nil {
		t.Fatalf("the data dir must never be deleted: %v", err)
	}
}
