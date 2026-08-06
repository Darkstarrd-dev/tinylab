// Package apibase provides shared types and helpers for the internal/api sub-packages.
// It is a separate leaf package to avoid circular imports between internal/api and
// its domain sub-packages (auth, settings, providers, keys, etc.).
package apibase

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/archivetool"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// Deps bundles every dependency and shared runtime state that the API handler
// domains need. Each sub-package's Register function receives a *Deps, and the
// parent internal/api package creates it from its own deps struct.
type Deps struct {
	Reg          *registry.Registry
	ConfigPath   string
	Usage        *usage.RingBuffer
	PgUsage      *usage.RingBuffer // Playground 来源请求专用 ring
	QuotaTracker *usage.QuotaTracker
	Logger       *console.Logger
	ProxyHandler *proxy.Handler
	Selector     *rotation.Selector
	ComboRes     *combo.Resolver
	DownloadMgr  *download.Manager
	Shutdown     context.CancelFunc

	// TestClient is used by the batch key-probe handler.
	TestClient *http.Client
	// DebugMode reflects the live debug flag toggled from settings.
	DebugMode *atomic.Bool
	// QuickSlotOnly reflects the live QuickSlot-only toggle from settings.
	QuickSlotOnly *atomic.Bool
	// LogRequests reflects the live log-requests toggle from settings.
	LogRequests *atomic.Bool

	// The following callbacks are configured after construction via setters.
	RestartFn         func(string)
	ServerCfgFn       func(config.ServerConfig)
	UpstreamTimeoutFn func(int)
	StateSaveFn       func()
	// ArchiveSettingsFn is invoked after an archive settings PATCH to push the
	// merged local config to the archive runner (tool path re-resolution and
	// status cache invalidation). It may be nil when the archive runner is not
	// wired (tests, minimal builds); the settings handler checks before calling.
	ArchiveSettingsFn func(config.ArchiveConfig)
}

// ArchiveRunner is the runtime surface the /api/archive handlers consume. It
// is implemented by *archivetool.Runner; the interface lives here (the shared
// API leaf) so the router can inject the runner without importing the tool
// package directly.
type ArchiveRunner interface {
	Store() *archive.TempStore
	Status(ctx context.Context) archivetool.Status
	List(ctx context.Context, src archive.Source, b archive.Budget) (archive.Manifest, error)
	ReadEntry(ctx context.Context, src archive.Source, identifier string, b archive.Budget) ([]byte, string, error)
	Pack(ctx context.Context, format archive.Format, assets []archive.AssetRef, name string, b archive.Budget) (archive.AssetRef, error)
	ReplaceZIP(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, b archive.Budget) (archive.AssetRef, error)
	ReplaceZIPDeleting(ctx context.Context, src archive.Source, replacements map[string]archive.AssetRef, deletes []string, b archive.Budget) (archive.AssetRef, error)
	UpdateSettings(cfg config.ArchiveConfig)
}

// SaveConfig persists the given config to disk via config.Save. It performs no
// registry reload and is used by handlers whose in-memory changes do not need to
// be re-applied to the running registry (e.g. plain CRUD persistence).
func (d *Deps) SaveConfig(cfg *config.Config) error {
	return config.Save(d.ConfigPath, cfg)
}

// SaveConfigAndReload persists the given config to disk and then reloads it into
// the registry so the running proxy/rotation state reflects the saved changes.
// It is the single convergence point for the "modify cfg -> Save -> Reload"
// pattern.
func (d *Deps) SaveConfigAndReload(cfg *config.Config) error {
	if err := config.Save(d.ConfigPath, cfg); err != nil {
		return err
	}
	d.Reg.Reload(cfg)
	return nil
}

// WriteAPIError writes a JSON error envelope with the given HTTP status.
func WriteAPIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// CheckPortAvailable tests whether a TCP port can be bound on 127.0.0.1.
func CheckPortAvailable(port int) error {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return fmt.Errorf("port %d is not available: %w", port, err)
	}
	_ = ln.Close()
	return nil
}

var idCounter int64

// GenerateID returns a process-unique ID with the given prefix, encoded in
// base36. SyncIDCounter must be called at startup so the counter starts above
// the highest existing ID and avoids collisions across restarts.
func GenerateID(prefix string) string {
	n := atomic.AddInt64(&idCounter, 1)
	return prefix + strconv.FormatInt(n, 36)
}

// SyncIDCounter scans existing IDs in the config and advances idCounter past
// the highest numeric suffix found for each prefix. This must be called once
// at startup, after config is loaded, to prevent ID collisions after restart.
func SyncIDCounter(cfg *config.Config) {
	// Collect all unique prefixes from the config
	seen := make(map[string]int64)

	// Keys within providers
	for _, p := range cfg.Providers {
		for _, k := range p.Keys {
			pfx, rest, ok := strings.Cut(k.ID, "-")
			if !ok {
				continue
			}
			n, err := strconv.ParseInt(rest, 36, 64)
			if err != nil {
				continue
			}
			if n > seen[pfx] {
				seen[pfx] = n
			}
		}
	}

	// Providers
	for _, p := range cfg.Providers {
		pfx, rest, ok := strings.Cut(p.ID, "-")
		if !ok {
			continue
		}
		n, err := strconv.ParseInt(rest, 36, 64)
		if err != nil {
			continue
		}
		if n > seen[pfx] {
			seen[pfx] = n
		}
	}

	// Combos
	for _, c := range cfg.Combos {
		pfx, rest, ok := strings.Cut(c.ID, "-")
		if !ok {
			continue
		}
		n, err := strconv.ParseInt(rest, 36, 64)
		if err != nil {
			continue
		}
		if n > seen[pfx] {
			seen[pfx] = n
		}
	}

	// QuickSlots
	for _, q := range cfg.QuickSlots {
		pfx, rest, ok := strings.Cut(q.ID, "-")
		if !ok {
			continue
		}
		n, err := strconv.ParseInt(rest, 36, 64)
		if err != nil {
			continue
		}
		if n > seen[pfx] {
			seen[pfx] = n
		}
	}

	// Set the counter past the highest seen value
	for _, n := range seen {
		if n > atomic.LoadInt64(&idCounter) {
			atomic.StoreInt64(&idCounter, n)
		}
	}
}

// ValidateBaseURL 校验 provider BaseURL 格式（scheme + hostname），
// 不拦截私网/回环地址（TinyRouter 为纯本地工具，无 SSRF 风险）。
func ValidateBaseURL(baseURL string) error {
	if baseURL == "" {
		return fmt.Errorf("baseUrl is required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return fmt.Errorf("invalid baseUrl: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("baseUrl must use http or https scheme, got: %s", u.Scheme)
	}
	if u.Hostname() == "" {
		return fmt.Errorf("baseUrl must have a valid hostname")
	}
	return nil
}

// IsBlockedSSRFHost reports whether the given host resolves to a private,
// loopback, link-local (unicast or multicast), multicast, or unspecified IP
// address. Used to prevent SSRF via the image proxy and save-image endpoints.
// If DNS resolution fails, the host is blocked (fail-closed).
func IsBlockedSSRFHost(host string) bool {
	ips, err := net.LookupIP(host)
	if err != nil {
		return true
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
			return true
		}
	}
	return false
}
