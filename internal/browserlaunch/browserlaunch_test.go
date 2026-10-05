package browserlaunch

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeInfo is a minimal os.FileInfo for the injected stat.
type fakeInfo struct{ dir bool }

func (f fakeInfo) Name() string       { return "fake" }
func (f fakeInfo) Size() int64        { return 1 }
func (f fakeInfo) Mode() os.FileMode  { return 0 }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.dir }
func (f fakeInfo) Sys() any           { return nil }

// TestPrivateArgsPerFamily pins the measured switch table. The Edge row is a
// regression guard: `--incognito` on Edge 154 opens a NORMAL window with no
// error/exit code, so a single shared flag would silently defeat the feature.
func TestPrivateArgsPerFamily(t *testing.T) {
	cases := map[Family]string{
		FamilyChrome:   "--incognito",
		FamilyChromium: "--incognito",
		FamilyBrave:    "--incognito",
		FamilyVivaldi:  "--incognito",
		FamilyEdge:     "--inprivate",
		FamilyOpera:    "--private",
		FamilyFirefox:  "-private-window",
	}
	for family, want := range cases {
		got, ok := PrivateArgs(family)
		if !ok {
			t.Fatalf("%s: private switch must be known", family)
		}
		if len(got) != 1 || got[0] != want {
			t.Fatalf("%s: private args = %v, want [%s]", family, got, want)
		}
	}
	if args, ok := PrivateArgs(FamilyEdge); ok && args[0] == "--incognito" {
		t.Fatal("edge must NOT use --incognito (silently opens a normal window)")
	}
	if _, ok := PrivateArgs(FamilyUnknown); ok {
		t.Fatal("an unknown family must not claim a private switch")
	}
}

func TestFamilyOf(t *testing.T) {
	cases := map[string]Family{
		`C:\Program Files\Google\Chrome\Application\chrome.exe`:        FamilyChrome,
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`: FamilyEdge,
		"msedge":                        FamilyEdge,
		"/usr/bin/google-chrome-stable": FamilyChrome,
		"/usr/bin/brave-browser":        FamilyBrave,
		"/usr/bin/vivaldi":              FamilyVivaldi,
		"/usr/bin/opera":                FamilyOpera,
		"/usr/bin/firefox-esr":          FamilyUnknown, // "-esr" suffix is not in the table
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": FamilyChrome,
		"/opt/weird-fork/weird.exe":                                    FamilyUnknown,
	}
	for path, want := range cases {
		if got := FamilyOf(path); got != want {
			t.Fatalf("FamilyOf(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestBuildArgsPrivate(t *testing.T) {
	args, err := BuildArgs(Launch{URL: "https://example.com/a", Bin: `C:\Edge\msedge.exe`, Private: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[0] != "--inprivate" || args[1] != "https://example.com/a" {
		t.Fatalf("args = %v", args)
	}
}

// TestBuildArgsProfileDirAbsolute: a relative --user-data-dir makes Chrome fail
// SILENTLY (docs/webhub-architecture.md §2.3), so it must be absolutized here.
func TestBuildArgsProfileDirAbsolute(t *testing.T) {
	args, err := BuildArgs(Launch{
		URL:        "http://127.0.0.1:1/login",
		Bin:        `C:\Chrome\chrome.exe`,
		ProfileDir: "rel" + string(os.PathSeparator) + "profile",
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--user-data-dir=rel") {
		t.Fatalf("relative profile dir must be absolutized, got %v", args)
	}
	for _, want := range []string{"--user-data-dir=", "--no-first-run", "--no-default-browser-check"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %v", want, args)
		}
	}
	if args[len(args)-1] != "http://127.0.0.1:1/login" {
		t.Fatalf("the URL must come last, got %v", args)
	}
}

func TestBuildArgsRefusals(t *testing.T) {
	if _, err := BuildArgs(Launch{URL: "u", Bin: `C:\fork\whatever.exe`, Private: true}); !errors.Is(err, ErrUnknownPrivate) {
		t.Fatalf("unknown family + private must refuse, got %v", err)
	}
	if _, err := BuildArgs(Launch{URL: "u", Private: true}); !errors.Is(err, ErrNoBin) {
		t.Fatalf("shell open cannot carry a private flag, got %v", err)
	}
	if _, err := BuildArgs(Launch{URL: "u", ProfileDir: "/tmp/p"}); !errors.Is(err, ErrNoBin) {
		t.Fatalf("shell open cannot carry a profile dir, got %v", err)
	}
	if _, err := BuildArgs(Launch{URL: "u", Bin: `C:\Chrome\chrome.exe`, Private: true, ProfileDir: "/tmp/p"}); !errors.Is(err, ErrPrivateWithProfile) {
		t.Fatalf("private + profile must be mutually exclusive, got %v", err)
	}
	if _, err := BuildArgs(Launch{URL: "u", Bin: "/usr/bin/firefox", ProfileDir: "/tmp/p"}); !errors.Is(err, ErrProfileUnsupported) {
		t.Fatalf("firefox uses -profile, not --user-data-dir; got %v", err)
	}
	// Shell open with no flags stays legal (the legacy default-browser path).
	args, err := BuildArgs(Launch{URL: "https://x"})
	if err != nil || args != nil {
		t.Fatalf("plain shell open must build no args, got %v / %v", args, err)
	}
}

// TestCommandExe: the Windows URL association template must yield the exe only.
func TestCommandExe(t *testing.T) {
	quoted := `"C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1`
	exe, err := commandExe(quoted, nil)
	if err != nil {
		t.Fatal(err)
	}
	if exe != `C:\Program Files\Google\Chrome\Application\chrome.exe` {
		t.Fatalf("quoted exe = %q", exe)
	}
	exists := func(p string) bool { return p == `C:\Program Files\Edge\msedge.exe` }
	exe, err = commandExe(`C:\Program Files\Edge\msedge.exe --single-argument %1`, exists)
	if err != nil {
		t.Fatal(err)
	}
	if exe != `C:\Program Files\Edge\msedge.exe` {
		t.Fatalf("unquoted exe with spaces = %q", exe)
	}
	exe, err = commandExe(`chrome.exe %1`, nil)
	if err != nil || exe != "chrome.exe" {
		t.Fatalf("single token = %q / %v", exe, err)
	}
	if _, err := commandExe("   ", nil); err == nil {
		t.Fatal("an empty command must error")
	}
}

// TestDetectInjected: table order is preserved, missing entries are skipped,
// the PATH fallback is used, and duplicates collapse.
func TestDetectInjected(t *testing.T) {
	cands := []candidate{
		{id: "chrome", label: "Google Chrome", family: FamilyChrome,
			paths: []string{`C:\missing\chrome.exe`}, pathNames: []string{"chrome"}},
		{id: "edge", label: "Microsoft Edge", family: FamilyEdge,
			paths: []string{`C:\Edge\msedge.exe`}},
		{id: "firefox", label: "Firefox", family: FamilyFirefox,
			paths: []string{`C:\nope\firefox.exe`}},
		{id: "brave", label: "Brave", family: FamilyBrave,
			paths: []string{`C:\Edge\msedge.exe`}}, // duplicate path
	}
	stat := func(p string) (os.FileInfo, error) {
		if p == `C:\Edge\msedge.exe` {
			return fakeInfo{}, nil
		}
		return nil, os.ErrNotExist
	}
	lookPath := func(name string) (string, error) {
		if name == "chrome" {
			return `C:\Chrome\chrome.exe`, nil
		}
		return "", os.ErrNotExist
	}
	got := detect(cands, stat, lookPath)
	if len(got) != 2 {
		t.Fatalf("want chrome (PATH fallback) + edge (deduped), got %+v", got)
	}
	if got[0].ID != "chrome" || got[0].Path != `C:\Chrome\chrome.exe` {
		t.Fatalf("first row = %+v", got[0])
	}
	if got[1].ID != "edge" || !got[1].PrivateOK || got[1].PrivateFlag != "--inprivate" {
		t.Fatalf("edge row = %+v", got[1])
	}
	if !got[0].ProfileOK {
		t.Fatal("chrome must support a dedicated profile dir")
	}
}

// TestDetectRealTableIsWellFormed: the per-OS table has unique ids and every
// family in it has a usable capability answer.
func TestDetectRealTableIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range candidates() {
		if c.id == "" || c.label == "" || c.family == "" {
			t.Fatalf("incomplete candidate: %+v", c)
		}
		if seen[c.id] {
			t.Fatalf("duplicate candidate id %q", c.id)
		}
		seen[c.id] = true
	}
	if len(seen) < 6 {
		t.Fatalf("expected the full browser table, got %v", seen)
	}
}

// TestDescribeCustomPath: an unknown engine must come back PrivateOK=false so
// the chooser can refuse instead of guessing a switch.
func TestDescribeCustomPath(t *testing.T) {
	known := Describe(`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`)
	if !known.PrivateOK || known.PrivateFlag != "--inprivate" || known.ID != "custom" {
		t.Fatalf("edge describe = %+v", known)
	}
	unknown := Describe(`C:\forks\mystery-browser.exe`)
	if unknown.PrivateOK {
		t.Fatalf("an unknown engine must not advertise a private mode: %+v", unknown)
	}
	if unknown.Label != "mystery-browser.exe" {
		t.Fatalf("label must fall back to the file name, got %q", unknown.Label)
	}
}

// TestOpenWithoutBinRefusesPrivate: the shell path cannot take flags, so Open
// must fail before spawning anything.
func TestOpenWithoutBinRefusesPrivate(t *testing.T) {
	spawned := false
	orig := startProcess
	startProcess = func(string, []string) error { spawned = true; return nil }
	defer func() { startProcess = orig }()

	if err := Open(Launch{URL: "https://x", Private: true}); !errors.Is(err, ErrNoBin) {
		t.Fatalf("want ErrNoBin, got %v", err)
	}
	if spawned {
		t.Fatal("no process may be spawned for a refused launch")
	}
}

// TestOpenSpawnsWithBuiltArgs: Open hands the exact command line to the OS.
func TestOpenSpawnsWithBuiltArgs(t *testing.T) {
	var gotBin string
	var gotArgs []string
	orig := startProcess
	startProcess = func(bin string, args []string) error { gotBin, gotArgs = bin, args; return nil }
	defer func() { startProcess = orig }()

	bin := `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
	if err := Open(Launch{URL: "https://login.example/x", Bin: bin, Private: true}); err != nil {
		t.Fatal(err)
	}
	if gotBin != bin {
		t.Fatalf("bin = %q", gotBin)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "--inprivate" || gotArgs[1] != "https://login.example/x" {
		t.Fatalf("args = %v", gotArgs)
	}
}

// TestDefaultBrowserShape: the resolver either yields a usable path or an empty
// one — never a half-filled record the caller could mistake for success.
func TestDefaultBrowserShape(t *testing.T) {
	d := DefaultBrowser()
	if d.Path == "" {
		if d.PrivateOK || d.Family != "" {
			t.Fatalf("unresolved default browser must be empty, got %+v", d)
		}
		return
	}
	if d.Family == "" {
		t.Fatalf("a resolved default browser must carry a family: %+v", d)
	}
	if d.PrivateOK && d.PrivateFlag == "" {
		t.Fatalf("PrivateOK without a flag: %+v", d)
	}
	if runtime.GOOS != "windows" {
		t.Fatal("only windows can resolve the default browser")
	}
}
