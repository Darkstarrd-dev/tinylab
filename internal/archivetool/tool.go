package archivetool

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

// toolInfo is the result of resolving and probing one external tool.
type toolInfo struct {
	Path    string // absolute path of the resolved executable
	Version string // banner version, e.g. "24.08" or "7.10"
	Read    bool   // can list/read archives of its native format
	Write   bool   // can create archives of its native format
	Err     error  // resolution or probe failure (nil when usable)
	// Banner-derived RAR identity (only meaningful after probe).
	bannerSaysRar    bool
	bannerSaysUnrar  bool
	basenameLooksRar bool
}

// toolErrKind classifies tool failures into stable machine codes for the API
// (archive_compatibility_plan.md §5.3: distinguishable errors for missing
// tools, encrypted/volumed/corrupt archives, etc.).
type toolErrKind string

const (
	ErrToolMissing toolErrKind = "archive.tool-missing" // no usable tool for the format
	ErrToolTimeout toolErrKind = "archive.tool-timeout"
	ErrToolFailed  toolErrKind = "archive.tool-failed" // non-zero exit, unclassified
	ErrReadOnly    toolErrKind = "archive.read-only"   // write requested, tool cannot write
	ErrEncrypted   toolErrKind = "archive.encrypted"   // encrypted archives unsupported
	ErrMultiVolume toolErrKind = "archive.multivolume"
	ErrCorrupt     toolErrKind = "archive.corrupt"
)

// ToolError is the structured external-tool error surfaced by the API.
type ToolError struct {
	Kind   toolErrKind
	Tool   string
	Detail string
	Err    error
}

func (e *ToolError) Error() string {
	if e.Detail != "" {
		return e.Kind.String() + ": " + e.Detail
	}
	if e.Err != nil {
		return e.Kind.String() + ": " + e.Err.Error()
	}
	return string(e.Kind)
}

func (e *ToolError) Unwrap() error { return e.Err }

func (k toolErrKind) String() string { return string(k) }

// Resolver resolves 7z/rar executables with the plan §5.1 priority:
// configured path → dedicated env var → PATH lookup, then runs a capability
// probe (banner parse; RAR write requires the rar binary, not unrar). Results
// are cached for statusCacheTTL so repeated status polls do not spawn
// processes; UpdateSettings invalidates the cache immediately.
type Resolver struct {
	mu  sync.Mutex
	cfg config.ArchiveConfig

	seven       toolInfo
	sevenProbed bool
	sevenAt     time.Time

	rar       toolInfo
	rarProbed bool
	rarAt     time.Time

	// lookupPath is overridable in tests; defaults to exec.LookPath.
	lookupPath func(file string) (string, error)
}

// NewResolver creates a resolver from the given archive config.
func NewResolver(cfg config.ArchiveConfig) *Resolver {
	return &Resolver{
		cfg:        cfg,
		lookupPath: execLookPath,
	}
}

// UpdateSettings swaps the active config and drops every cached probe so the
// next Status/List/Read/Pack re-resolves tool paths.
func (r *Resolver) UpdateSettings(cfg config.ArchiveConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cfg = cfg
	r.seven = toolInfo{}
	r.sevenProbed = false
	r.rar = toolInfo{}
	r.rarProbed = false
}

// SevenZip resolves and probes the 7z/7zz executable (read+write).
func (r *Resolver) SevenZip(ctx context.Context) toolInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sevenProbed && time.Since(r.sevenAt) < statusCacheTTL {
		return r.seven
	}
	r.seven = r.resolveSevenZipLocked(ctx)
	r.sevenAt = time.Now()
	r.sevenProbed = true
	return r.seven
}

// RAR resolves and probes the rar/unrar executable. Read capability also
// covers the 7z fallback: when no rar/unrar binary exists but 7z is
// available, RAR archives can still be listed/read through 7z (Write stays
// false — only a verified rar binary writes).
func (r *Resolver) RAR(ctx context.Context) toolInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rarProbed && time.Since(r.rarAt) < statusCacheTTL {
		return r.rar
	}
	r.rar = r.resolveRarLocked(ctx)
	r.rarAt = time.Now()
	r.rarProbed = true
	return r.rar
}

func (r *Resolver) resolveSevenZipLocked(ctx context.Context) toolInfo {
	candidates := r.candidates(r.cfg.SevenZipPath, "SEVENZIP_PATH", "7z", "7zz")
	for _, c := range candidates {
		path, err := r.validateTool(c)
		if err != nil {
			return toolInfo{Path: c, Err: err}
		}
		info := r.probe(ctx, path)
		if info.Err != nil {
			return info
		}
		// 7z/7zz always read and write their native format.
		info.Read = true
		info.Write = true
		return info
	}
	return toolInfo{Err: missingToolError(candidates, "7z")}
}

func (r *Resolver) resolveRarLocked(ctx context.Context) toolInfo {
	candidates := r.candidates(r.cfg.RarPath, "RAR_PATH", "unrar", "rar")
	for _, c := range candidates {
		path, err := r.validateTool(c)
		if err != nil {
			return toolInfo{Path: c, Err: err}
		}
		info := r.probe(ctx, path)
		if info.Err != nil {
			return info
		}
		info.Read = true
		info.Write = info.bannerSaysRar && !info.bannerSaysUnrar && info.basenameLooksRar
		return info
	}
	// 7z fallback: a usable 7z can list/read RAR archives (write stays false).
	if r.sevenProbed && r.seven.Err == nil && r.seven.Read {
		info := r.seven
		info.Path = ""
		info.Write = false
		return info
	}
	sz := r.resolveSevenZipLocked(ctx)
	if sz.Err == nil && sz.Read {
		info := sz
		info.Path = ""
		info.Write = false
		return info
	}
	return toolInfo{Err: missingToolError(candidates, "rar")}
}

// candidates yields (configured, env, PATH names) non-empty candidates.
func (r *Resolver) candidates(configured, envName string, names ...string) []string {
	var out []string
	if configured != "" {
		out = append(out, configured)
	}
	if v := os.Getenv(envName); v != "" {
		out = append(out, v)
	}
	out = append(out, names...)
	return out
}

// validateTool turns a candidate into an absolute path to a regular file.
// Configured paths that are not found are a diagnostic error (the API reports
// them); they never silently fall through to PATH resolution, so a typo is
// visible instead of being masked by a different tool.
func (r *Resolver) validateTool(c string) (string, error) {
	path := c
	if !filepath.IsAbs(path) {
		if lp, err := r.lookupPath(path); err == nil {
			path = lp
		}
	}
	if !filepath.IsAbs(path) {
		var err error
		path, err = filepath.Abs(path)
		if err != nil {
			return "", err
		}
	}
	fi, err := os.Stat(path)
	if err != nil {
		// A missing/unreadable candidate is the "tool missing" case, not an
		// internal error: wrap it so the API maps it to 503 archive.tool-missing
		// (docs §5) and the status endpoint surfaces the same diagnostic.
		return "", &ToolError{Kind: ErrToolMissing, Tool: path, Detail: err.Error(), Err: err}
	}
	if !fi.Mode().IsRegular() {
		return "", errNotRegular(path)
	}
	return path, nil
}

// probe runs the tool bare and parses its banner. 7z/7zz/rar/unrar all print
// their version header when invoked without arguments.
func (r *Resolver) probe(ctx context.Context, path string) toolInfo {
	out, errTail, err := runTool(ctx, path, probeTimeout, probeMaxBytes)
	if err != nil {
		return toolInfo{Path: path, Err: err}
	}
	banner := string(out) + "\n" + errTail
	low := strings.ToLower(banner)
	return toolInfo{
		Path:            path,
		Version:         parseToolVersion(banner),
		bannerSaysRar:   strings.Contains(low, "rar"),
		bannerSaysUnrar: strings.Contains(low, "unrar"),
		basenameLooksRar: strings.Contains(strings.ToLower(filepath.Base(path)), "rar") &&
			!strings.Contains(strings.ToLower(filepath.Base(path)), "unrar"),
	}
}

// probeTimeout caps the no-arg banner probe.
const probeTimeout = 15 * time.Second

// probeMaxBytes bounds the banner probe output.
const probeMaxBytes = 4 << 10

func missingToolError(candidates []string, tool string) error {
	return &ToolError{Kind: ErrToolMissing, Tool: tool, Detail: "no usable " + tool + " executable (configured path, env, or PATH)"}
}

func errNotRegular(path string) error {
	return &ToolError{Kind: ErrToolMissing, Tool: path, Detail: "not a regular executable file"}
}

func execLookPath(file string) (string, error) {
	return exec.LookPath(file)
}

// parseToolVersion extracts the first dotted version number at or after a
// tool banner keyword ("7-Zip", "7zz", "RAR", "UNRAR"). Returns "" when no
// banner matched.
func parseToolVersion(banner string) string {
	low := strings.ToLower(banner)
	for _, kw := range []string{"7-zip", "7zip", "7zz", "unrar", "rar"} {
		idx := strings.Index(low, kw)
		if idx < 0 {
			continue
		}
		rest := banner[idx+len(kw):]
		i := 0
		for i < len(rest) && !(rest[i] >= '0' && rest[i] <= '9') {
			i++
		}
		j := i
		for j < len(rest) && ((rest[j] >= '0' && rest[j] <= '9') || rest[j] == '.') {
			j++
		}
		v := strings.TrimSuffix(rest[i:j], ".")
		if v != "" {
			return v
		}
	}
	return ""
}
