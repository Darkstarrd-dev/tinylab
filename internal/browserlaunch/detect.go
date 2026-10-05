package browserlaunch

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Browser is one detected browser installation (the browser axis of the Free
// Hub login-mode chooser).
type Browser struct {
	// ID is the stable selector sent back by the UI ("chrome", "edge", …).
	ID string `json:"id"`
	// Label is the product name shown in the chooser.
	Label string `json:"label"`
	// Family is the engine family (decides the private switch name).
	Family string `json:"family"`
	// Path is the resolved absolute executable path.
	Path string `json:"path"`
	// PrivateOK reports whether the private switch is known for this family.
	// false must disable the private option in the UI instead of guessing.
	PrivateOK bool `json:"privateOk"`
	// PrivateFlag is the switch shown to the user (e.g. "--inprivate").
	PrivateFlag string `json:"privateFlag,omitempty"`
	// ProfileOK reports whether a dedicated persistent profile is supported.
	ProfileOK bool `json:"profileOk"`
}

// candidate is one row of the per-OS detection table.
type candidate struct {
	id        string
	label     string
	family    Family
	paths     []string
	pathNames []string
}

// windowsCandidates lists the usual install locations + PATH names per browser.
func windowsCandidates() []candidate {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	la := os.Getenv("LOCALAPPDATA")
	join := func(parts ...string) string {
		nonEmpty := parts[:0:0]
		for _, p := range parts {
			if p != "" {
				nonEmpty = append(nonEmpty, p)
			}
		}
		if len(nonEmpty) == 0 {
			return ""
		}
		return filepath.Join(nonEmpty...)
	}
	return []candidate{
		{id: "chrome", label: "Google Chrome", family: FamilyChrome,
			paths: []string{
				join(pf, "Google", "Chrome", "Application", "chrome.exe"),
				join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
				join(la, "Google", "Chrome", "Application", "chrome.exe"),
			},
			pathNames: []string{"chrome"}},
		{id: "edge", label: "Microsoft Edge", family: FamilyEdge,
			paths: []string{
				join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
				join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
				join(la, "Microsoft", "Edge", "Application", "msedge.exe"),
			},
			pathNames: []string{"msedge"}},
		{id: "chromium", label: "Chromium", family: FamilyChromium,
			paths: []string{
				join(la, "Chromium", "Application", "chrome.exe"),
				join(pf, "Chromium", "Application", "chrome.exe"),
			},
			pathNames: []string{"chromium"}},
		{id: "brave", label: "Brave", family: FamilyBrave,
			paths: []string{
				join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
				join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
				join(la, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			},
			pathNames: []string{"brave"}},
		{id: "vivaldi", label: "Vivaldi", family: FamilyVivaldi,
			paths: []string{
				join(la, "Vivaldi", "Application", "vivaldi.exe"),
				join(pf, "Vivaldi", "Application", "vivaldi.exe"),
			},
			pathNames: []string{"vivaldi"}},
		{id: "opera", label: "Opera", family: FamilyOpera,
			paths: []string{
				join(la, "Programs", "Opera", "opera.exe"),
				join(pf, "Opera", "opera.exe"),
			},
			pathNames: []string{"opera"}},
		{id: "firefox", label: "Firefox", family: FamilyFirefox,
			paths: []string{
				join(pf, "Mozilla Firefox", "firefox.exe"),
				join(pf86, "Mozilla Firefox", "firefox.exe"),
			},
			pathNames: []string{"firefox"}},
	}
}

// darwinCandidates lists the .app bundle binaries (the inner executable must be
// invoked so the private switch is delivered even when the app already runs —
// `open -a … --args` drops the arguments for a live instance).
func darwinCandidates() []candidate {
	app := func(bundle, bin string) string {
		return "/Applications/" + bundle + ".app/Contents/MacOS/" + bin
	}
	return []candidate{
		{id: "chrome", label: "Google Chrome", family: FamilyChrome,
			paths: []string{app("Google Chrome", "Google Chrome")}},
		{id: "edge", label: "Microsoft Edge", family: FamilyEdge,
			paths: []string{app("Microsoft Edge", "Microsoft Edge")}},
		{id: "chromium", label: "Chromium", family: FamilyChromium,
			paths: []string{app("Chromium", "Chromium")}},
		{id: "brave", label: "Brave", family: FamilyBrave,
			paths: []string{app("Brave Browser", "Brave Browser")}},
		{id: "vivaldi", label: "Vivaldi", family: FamilyVivaldi,
			paths: []string{app("Vivaldi", "Vivaldi")}},
		{id: "firefox", label: "Firefox", family: FamilyFirefox,
			paths: []string{app("Firefox", "firefox")}},
	}
}

// linuxCandidates lists the usual package locations + PATH names.
func linuxCandidates() []candidate {
	return []candidate{
		{id: "chrome", label: "Google Chrome", family: FamilyChrome,
			paths:     []string{"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"},
			pathNames: []string{"google-chrome", "google-chrome-stable", "chrome"}},
		{id: "edge", label: "Microsoft Edge", family: FamilyEdge,
			paths:     []string{"/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"},
			pathNames: []string{"microsoft-edge", "microsoft-edge-stable", "msedge"}},
		{id: "chromium", label: "Chromium", family: FamilyChromium,
			paths:     []string{"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium-freeworld"},
			pathNames: []string{"chromium", "chromium-browser"}},
		{id: "brave", label: "Brave", family: FamilyBrave,
			paths:     []string{"/usr/bin/brave-browser", "/usr/bin/brave"},
			pathNames: []string{"brave-browser", "brave"}},
		{id: "vivaldi", label: "Vivaldi", family: FamilyVivaldi,
			paths:     []string{"/usr/bin/vivaldi", "/usr/bin/vivaldi-stable"},
			pathNames: []string{"vivaldi", "vivaldi-stable"}},
		{id: "opera", label: "Opera", family: FamilyOpera,
			paths:     []string{"/usr/bin/opera"},
			pathNames: []string{"opera"}},
		{id: "firefox", label: "Firefox", family: FamilyFirefox,
			paths:     []string{"/usr/bin/firefox", "/usr/bin/firefox-esr"},
			pathNames: []string{"firefox", "firefox-esr"}},
	}
}

// candidates returns the detection table for the running OS.
func candidates() []candidate {
	switch runtime.GOOS {
	case "windows":
		return windowsCandidates()
	case "darwin":
		return darwinCandidates()
	default:
		return linuxCandidates()
	}
}

// Detect returns the installed browsers in table order (stable, so the chooser
// order does not jump between page loads). Missing candidates are skipped.
func Detect() []Browser {
	return detect(candidates(), os.Stat, exec.LookPath)
}

// detect is the injectable core of Detect.
func detect(cands []candidate, stat func(string) (os.FileInfo, error), lookPath func(string) (string, error)) []Browser {
	var out []Browser
	seen := map[string]bool{}
	for _, c := range cands {
		path := ""
		for _, p := range c.paths {
			if p == "" {
				continue
			}
			if st, err := stat(p); err == nil && st != nil && !st.IsDir() {
				path = p
				break
			}
		}
		if path == "" {
			for _, name := range c.pathNames {
				if p, err := lookPath(name); err == nil && p != "" {
					path = p
					break
				}
			}
		}
		if path == "" {
			continue
		}
		key := strings.ToLower(path)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, browserFrom(c.id, c.label, c.family, path))
	}
	return out
}

// browserFrom assembles a Browser row, filling the capability flags from the
// family tables (the UI disables what we cannot guarantee).
func browserFrom(id, label string, family Family, path string) Browser {
	b := Browser{ID: id, Label: label, Family: string(family), Path: path}
	if args, ok := PrivateArgs(family); ok {
		b.PrivateOK = true
		b.PrivateFlag = strings.Join(args, " ")
	}
	b.ProfileOK = ProfileSupported(family)
	return b
}

// Find returns the detected browser with the given id.
func Find(id string) (Browser, bool) {
	for _, b := range Detect() {
		if b.ID == id {
			return b, true
		}
	}
	return Browser{}, false
}

// Describe builds the Browser row for an arbitrary executable path (the
// "custom path" arm of the chooser). Unknown engines come back with
// PrivateOK=false so the UI refuses a private launch instead of guessing.
func Describe(path string) Browser {
	return browserFrom("custom", LabelOf(path), FamilyOf(path), path)
}

// commandExe extracts the executable from a Windows shell "open command"
// template such as
//
//	"C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1
//
// The quoting is not guaranteed (some installers write an unquoted path that
// contains spaces), so an unquoted command resolves to the longest leading
// token join that exists on disk (exists may be nil to skip that probe).
func commandExe(cmdLine string, exists func(string) bool) (string, error) {
	s := strings.TrimSpace(cmdLine)
	if s == "" {
		return "", errors.New("browserlaunch: empty open command")
	}
	if strings.HasPrefix(s, `"`) {
		rest := s[1:]
		if end := strings.Index(rest, `"`); end >= 0 {
			if exe := strings.TrimSpace(rest[:end]); exe != "" {
				return exe, nil
			}
		}
		if exe := strings.TrimSpace(rest); exe != "" {
			return exe, nil // unterminated quote: take the remainder
		}
		return "", errors.New("browserlaunch: empty executable in open command")
	}
	fields := strings.Fields(s)
	best := ""
	if exists != nil {
		for i := 1; i <= len(fields); i++ {
			cand := strings.Join(fields[:i], " ")
			if exists(cand) {
				best = cand
			}
		}
	}
	if best != "" {
		return best, nil
	}
	if len(fields) > 0 {
		return fields[0], nil
	}
	return "", errors.New("browserlaunch: empty open command")
}
