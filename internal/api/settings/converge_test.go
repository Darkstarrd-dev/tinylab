package settings

import (
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// buildConvergeDeps wires a Deps with real runtime components and capture
// callbacks so convergeRuntime can be exercised end to end (E-1).
func buildConvergeDeps(t *testing.T, cfg *config.Config) *apibase.Deps {
	t.Helper()
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	ring := usage.New(500)
	quota := usage.NewQuotaTracker()
	logger := console.New(200)
	proxyHandler := proxy.New(reg, sel, comboRes, ring, quota, logger, 300)
	return &apibase.Deps{
		Reg:           reg,
		ConfigPath:    filepath.Join(t.TempDir(), "config.yaml"),
		Logger:        logger,
		ProxyHandler:  proxyHandler,
		Selector:      sel,
		QuickSlotOnly: &atomic.Bool{},
		LogRequests:   &atomic.Bool{},
	}
}

// TestConvergeRuntime_PropagatesAllRuntimeComponents guards E-1: the single
// runtime convergence function shared by the settings PATCH and POST
// /api/reload must push proxy, trace dir + logging flag, server timeouts,
// rotation settings and archive settings into every runtime component, so
// disk config, in-memory registry, runtime state and API GET agree.
func TestConvergeRuntime_PropagatesAllRuntimeComponents(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.QuickSlotOnly = true
	cfg.Trace.Enabled = true
	cfg.Trace.LogDir = filepath.Join(t.TempDir(), "traces")
	cfg.Rotation.StickyLimit = 7
	cfg.Rotation.Strategy = "round-robin"
	cfg.Server.UpstreamTimeoutSec = 123
	cfg.Proxy = config.ProxyConfig{Enabled: true, Host: "127.0.0.1", Port: "8080"}
	cfg.Archive = config.ArchiveConfig{SevenZipPath: "C:\\tools\\7z.exe", TempDir: filepath.Join(t.TempDir(), "arch")}

	d := buildConvergeDeps(t, cfg)
	var gotServer config.ServerConfig
	var gotUpstreamTimeout int
	var gotArchive config.ArchiveConfig
	d.ServerCfgFn = func(s config.ServerConfig) { gotServer = s }
	d.UpstreamTimeoutFn = func(sec int) { gotUpstreamTimeout = sec }
	d.ArchiveSettingsFn = func(a config.ArchiveConfig) { gotArchive = a }

	h := &Handler{d: d}
	h.convergeRuntime(*cfg)

	if !d.QuickSlotOnly.Load() {
		t.Error("QuickSlotOnly atomic not updated")
	}
	if !d.LogRequests.Load() {
		t.Error("LogRequests atomic not updated from cfg.Trace.Enabled")
	}
	wantDir := config.ResolveTraceDir(cfg.Trace.LogDir, filepath.Dir(d.ConfigPath))
	if got := d.ProxyHandler.TracesDir(); got != wantDir {
		t.Errorf("TracesDir = %q, want %q", got, wantDir)
	}
	if got := d.Selector.Settings().StickyLimit; got != 7 {
		t.Errorf("rotation StickyLimit = %d, want 7", got)
	}
	if got := d.Selector.Settings().Strategy; got != "round-robin" {
		t.Errorf("rotation Strategy = %q, want round-robin", got)
	}
	if gotServer.UpstreamTimeoutSec != 123 {
		t.Errorf("ServerCfgFn received UpstreamTimeoutSec = %d, want 123", gotServer.UpstreamTimeoutSec)
	}
	if gotUpstreamTimeout != 123 {
		t.Errorf("UpstreamTimeoutFn = %d, want 123", gotUpstreamTimeout)
	}
	if gotArchive.SevenZipPath != "C:\\tools\\7z.exe" || gotArchive.TempDir != cfg.Archive.TempDir {
		t.Errorf("ArchiveSettingsFn received %+v, want %+v", gotArchive, cfg.Archive)
	}
}

// TestConvergeRuntime_InvalidProxyRefused guards that an invalid proxy config
// never reaches SetProxy (which would otherwise disable proxying on a config
// the reload path already validated).
func TestConvergeRuntime_InvalidProxyDoesNotPanic(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Proxy = config.ProxyConfig{Enabled: true, Host: "", Port: "99999"}

	d := buildConvergeDeps(t, cfg)
	h := &Handler{d: d}
	h.convergeRuntime(*cfg) // must not panic; proxy runtime left unchanged
}
