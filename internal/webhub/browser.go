package webhub

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ErrNoBrowser is returned when no Chromium-based browser can be located. The
// page surfaces it verbatim — the user must install Chrome/Edge, since webhub
// cannot work without a real browser (it drives a page, it is not a client).
var ErrNoBrowser = errors.New("webhub: no chromium-based browser found (install Chrome/Edge/Brave)")

// DefaultPort is the CDP remote-debugging port webhub launches its browser on.
// 9333 deliberately avoids 9222 (used by universal-web-api) so a running UWA
// instance and TinyLab can coexist.
const DefaultPort = 9333

// defaultBrowserNames are the PATH lookups attempted after the candidate paths
// fail, in priority order.
var defaultBrowserNames = []string{"chrome", "google-chrome", "chromium", "msedge"}

// candidateChromiumPaths lists the usual install locations for Chromium-based
// browsers, most specific first. It mirrors what universal-web-api probes for,
// plus the Windows/mac/Linux paths a desktop install actually uses.
func candidateChromiumPaths() []string {
	var out []string
	switch runtime.GOOS {
	case "windows":
		pf := os.Getenv("ProgramFiles")
		pf86 := os.Getenv("ProgramFiles(x86)")
		la := os.Getenv("LOCALAPPDATA")
		out = []string{
			filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(la, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		}
	case "darwin":
		out = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	default:
		out = []string{
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
		}
	}
	return out
}

// FindChromium returns the first existing Chromium binary among the platform
// candidate paths, falling back to PATH lookups. It returns ErrNoBrowser when
// nothing is found.
//
// The candidate list and the PATH lookup are injected in tests (see
// findChromium) so the resolution logic is verifiable without a real browser.
func FindChromium() (string, error) {
	return findChromium(candidateChromiumPaths(), exec.LookPath)
}

// findChromium is the injectable core of FindChromium: it stats each candidate
// path (skipping empty ones, e.g. unset %ProgramFiles(x86)%) and then tries
// each PATH name via lookPath.
func findChromium(candidates []string, lookPath func(string) (string, error)) (string, error) {
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	for _, name := range defaultBrowserNames {
		if p, err := lookPath(name); err == nil && p != "" {
			return p, nil
		}
	}
	return "", ErrNoBrowser
}

// LaunchSpec describes one browser launch.
type LaunchSpec struct {
	// Bin is the browser executable (from FindChromium).
	Bin string
	// ProfileDir is the persistent user-data-dir. It MUST be a fixed directory
	// ({configDir}/webhub/profile): the whole point is that the user signs in
	// once and the login survives process restarts. A temp dir would force a
	// re-login on every start (P0 prototype mistake).
	ProfileDir string
	// Port is the remote debugging port (DefaultPort when 0).
	Port int
	// Headless runs with --headless=new. Login flows need it off: the user has
	// to actually see and sign into the page.
	Headless bool
}

// LaunchArgs builds the browser command line for spec. Exported so tests can
// assert the flag set without starting a process.
func LaunchArgs(spec LaunchSpec) []string {
	port := spec.Port
	if port == 0 {
		port = DefaultPort
	}
	args := []string{
		fmt.Sprintf("--remote-debugging-port=%d", port),
		"--user-data-dir=" + spec.ProfileDir,
		"--no-first-run",
		"--no-default-browser-check",
		// Removes the navigator.webdriver flag most sites sniff for.
		"--disable-blink-features=AutomationControlled",
	}
	if spec.Headless {
		args = append(args, "--headless=new")
	}
	return args
}

// Connect brings up the CDP endpoint: it first checks whether a browser is
// already listening on the debug port (the user's own Chrome with
// --remote-debugging-port, or a previous TinyLab launch) and attaches to it;
// otherwise it launches one on the persistent profile.
//
// ⚠️ It NEVER kills a browser: if the user is running Chrome we attach rather
// than restart, and a browser we launched ourselves is left running on
// shutdown (killing it would discard the user's tabs and, worse, could take
// down a session they are using for something else).
//
// It returns the ws:// endpoint to hand to SessionManager.SetEndpoint.
func Connect(profileDir string, port int, headless bool) (wsURL string, launched bool, err error) {
	if port <= 0 {
		port = DefaultPort
	}
	// Already listening? Attach (this is also the fast path across app
	// restarts — the browser stays up, the login state stays valid).
	if existing, err := FetchEndpoint(port); err == nil && existing != "" {
		return existing, false, nil
	}
	bin, err := FindChromium()
	if err != nil {
		return "", false, err
	}
	if _, err := Launch(LaunchSpec{Bin: bin, ProfileDir: profileDir, Port: port, Headless: headless}); err != nil {
		return "", false, err
	}
	if err := WaitForDevTools(port, devtoolsReadyTimeout); err != nil {
		return "", false, err
	}
	ws, err := FetchEndpoint(port)
	return ws, true, err
}

// FetchEndpoint reads the browser's CDP websocket endpoint from its
// /json/version HTTP endpoint. Returns "" when nothing is listening.
func FetchEndpoint(port int) (string, error) {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port)) // #nosec G107 -- loopback, int port
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("webhub: devtools HTTP %d", resp.StatusCode)
	}
	var info struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", err
	}
	if info.WebSocketDebuggerURL == "" {
		return "", fmt.Errorf("webhub: devtools returned no websocket URL")
	}
	return info.WebSocketDebuggerURL, nil
}

// The caller owns the process (kill it on shutdown, or leave it alone — see
// LaunchPolicy). It does not wait for the DevTools endpoint; use
// WaitForDevTools for that.
func Launch(spec LaunchSpec) (*exec.Cmd, error) {
	if spec.Bin == "" {
		return nil, errors.New("webhub: empty browser binary")
	}
	if spec.ProfileDir == "" {
		return nil, errors.New("webhub: empty profile dir (login state must be persistent)")
	}
	if err := os.MkdirAll(spec.ProfileDir, 0o755); err != nil {
		return nil, fmt.Errorf("webhub: profile dir: %w", err)
	}
	cmd := exec.Command(spec.Bin, LaunchArgs(spec)...)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("webhub: start %s: %w", spec.Bin, err)
	}
	return cmd, nil
}
