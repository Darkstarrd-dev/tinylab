// Package app wires together TinyRouter's runtime components and owns the
// process lifecycle (start, host loop, graceful shutdown). main.go stays tiny:
// it only parses CLI flags and delegates to app.New / app.Run.
package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/api"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/state"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// HostLoopFunc blocks until the host (console signal, tray, webview) requests
// shutdown, then returns. It is supplied by package main because the concrete
// implementation is build-tag-gated (systray, webview2, …); the app package
// never imports package main, so it cannot reference runHostLoop directly.
type HostLoopFunc func(*HostContext)

// App owns the running process: it holds every runtime component and drives the
// start / shutdown sequence. It is intentionally NOT a god object — New builds
// components via the focused buildComponents helper, and Run/Shutdown only
// orchestrate the lifecycle.
type App struct {
	cfg        *config.Config
	configPath string
	configDir  string
	addr       string

	logger       *console.Logger
	usageBuf     *usage.RingBuffer
	pgUsageBuf   *usage.RingBuffer // Playground 来源请求专用 ring
	quotaTracker *usage.QuotaTracker
	reg          *registry.Registry
	selector     *rotation.Selector
	comboRes     *combo.Resolver
	proxyHandler *proxy.Handler
	downloadMgr  *download.Manager
	apiRouter    *api.Router
	stateManager *state.Manager
	statePath    string
	sm           *ServerManager

	// shutdownCtx is cancelled by the API layer (POST /api/shutdown) and by the
	// host loop, signalling the app to begin graceful shutdown.
	shutdownCtx     context.Context
	triggerShutdown context.CancelFunc

	// lockFile / lockPath implement the single-instance lock, held for the
	// process lifetime and released on Shutdown.
	lockFile *os.File
	lockPath string
}

// New loads the config (creating config.yaml on first run), acquires the
// single-instance lock, and constructs every runtime component. It does NOT
// start the HTTP server or restore persisted state — that happens in Run.
func New(configPath string) (*App, error) {
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// Single-instance check: use OS-level file locking on .tinyrouter.lock.
	// Unlike file-existence checks (O_EXCL), OS file locks are automatically
	// released when the process exits (even on crash/kill), so a stale lock file
	// left on disk by a killed process never prevents the next startup. The file
	// may already exist; we open it read/write and re-acquire the lock.
	configDir := filepath.Dir(configPath)
	lockPath := filepath.Join(configDir, ".tinyrouter.lock")
	lockFile, lockErr := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if lockErr != nil {
		err := fmt.Errorf("failed to open lock file: %w", lockErr)
		return nil, err
	}
	if err := tryLockFile(lockFile); err != nil {
		lockFile.Close()
		msg := "另一个 TinyRouter 实例已在运行。请先关闭它后重试。"
		return nil, fmt.Errorf("%s", msg)
	}
	// Write PID for diagnostic purposes (not used for locking logic).
	lockFile.Truncate(0)
	lockFile.Seek(0, 0)
	fmt.Fprintf(lockFile, "%d\n", os.Getpid())
	// Sync ID counter with existing IDs to prevent collisions after restart.
	apibase.SyncIDCounter(cfg)

	configDir = filepath.Dir(configPath)
	a := &App{
		cfg:             cfg,
		configPath:      configPath,
		configDir:       configDir,
		addr:            fmt.Sprintf("127.0.0.1:%d", cfg.Port),
		lockFile:        lockFile,
		lockPath:        lockPath,
		shutdownCtx:     context.Background(),
		triggerShutdown: func() {},
	}
	a.shutdownCtx, a.triggerShutdown = context.WithCancel(context.Background())

	if err := a.buildComponents(); err != nil {
		lockFile.Close()
		os.Remove(lockPath)
		return nil, err
	}
	return a, nil
}

// buildComponents constructs every runtime component in dependency order.
// It is called once from New; Run later starts the HTTP server and restores
// persisted state.
func (a *App) buildComponents() error {
	cfg := a.cfg

	a.logger = console.New(cfg.ConsoleLogMaxLines)
	a.usageBuf = usage.New(cfg.UsageRingSize)
	// Playground 请求量由用户主动发起，可控；独立 ring 容量 50 足够，且始终捕获详情
	a.pgUsageBuf = usage.New(50)
	a.quotaTracker = usage.NewQuotaTracker()

	a.reg = registry.New(cfg)
	a.selector = rotation.New(a.reg, &cfg.Rotation)
	a.comboRes = combo.New(a.reg)
	a.comboRes.SetLogger(a.logger)

	a.proxyHandler = proxy.New(a.reg, a.selector, a.comboRes, a.usageBuf, a.quotaTracker, a.logger, cfg.Server.UpstreamTimeoutSec)
	a.proxyHandler.SetPgUsage(a.pgUsageBuf)
	if err := a.proxyHandler.SetProxy(cfg.Proxy.Enabled, cfg.Proxy.Host, cfg.Proxy.Port); err != nil {
		a.logger.Warn("invalid upstream proxy config: %v", err)
	}

	// Download manager.
	downloadSettings := download.RuntimeSettings{
		DownloadDir:         cfg.Download.DefaultDir,
		YtDlpPath:           cfg.Download.YtDlpPath,
		FfmpegPath:          cfg.Download.FfmpegPath,
		ConcurrentFragments: cfg.Download.ConcurrentFragments,
		MaxConcurrent:       cfg.Download.MaxConcurrent,
		Proxy:               config.ResolveDownloadProxy(cfg),
		BrowserCookies:      cfg.Download.BrowserCookies,
		CookiesPath:         cfg.Download.CookiesPath,
	}
	a.downloadMgr = download.NewManager(downloadSettings, a.logger)
	// Always start the download manager. The HTTP routes for /api/downloads are
	// unconditionally registered, so returning 503 from createDownload when
	// download.enabled is false (or absent and defaulted) is confusing. If a
	// future need arises to truly disable downloads, the route registration in
	// internal/api/router.go should be made conditional instead.
	a.downloadMgr.Start()
	a.logger.Info("download manager started (concurrent=%d, fragments=%d)",
		cfg.Download.MaxConcurrent, cfg.Download.ConcurrentFragments)

	// State persistence setup. Restore is performed at the start of Run, before
	// the HTTP server is started, so the runtime state (key/combo cooldowns and
	// rotation indices) is in place before any request is served.
	a.statePath = cfg.Rotation.StatePath
	if a.statePath == "" {
		a.statePath = "state.yaml"
	}
	if cfg.Rotation.StatePersist {
		a.stateManager = state.NewManager(a.statePath, a.logger,
			state.WithKeyStateProvider(a.reg.SnapshotKeyStates, a.reg.RestoreKeyState),
			state.WithComboStateProvider(a.comboRes.SnapshotComboStates, a.comboRes.RestoreComboState),
			state.WithProbeStateProvider(a.reg.SnapshotProbeRecords, a.reg.RestoreProbeRecord),
		)
		a.selector.SetStateHook(a.stateManager.ScheduleWrite)
		a.comboRes.SetStateHook(a.stateManager.ScheduleWrite)
	}

	// API router + UI handler. Shutdown is triggered by POST /api/shutdown.
	a.apiRouter = api.New(a.reg, cfg, a.configPath, a.usageBuf, a.pgUsageBuf, a.quotaTracker, a.logger, a.proxyHandler, a.triggerShutdown, a.selector, a.comboRes, a.downloadMgr)
	a.proxyHandler.SetDebugModeProvider(a.apiRouter.DebugMode)
	a.proxyHandler.SetLogRequestsProvider(a.apiRouter.LogRequests)
	a.proxyHandler.SetRequestLogDir(config.ResolveTraceDir(cfg.Trace.LogDir, a.configDir))
	a.proxyHandler.SetQuickSlotOnlyProvider(a.apiRouter.QuickSlotOnly)

	// Start the trace retention sweep goroutine. It runs every hour
	// and deletes trace files older than RetainDays, enforcing MaxDiskMB.
	// The goroutine stops when the app shutdown context is cancelled.
	go a.proxyHandler.SweepTraces(a.shutdownCtx, cfg.Trace.RetainDays, cfg.Trace.MaxDiskMB)

	// HTTP server (not started until Run).
	a.sm = NewServerManager(a.apiRouter.Routes(a.proxyHandler), a.addr, a.logger, cfg.Server)
	a.sm.SetConfigDir(a.configDir)
	return nil
}

// Run restores persisted state, starts the HTTP server, opens a browser on
// console hosts, and blocks in the supplied host loop until shutdown is
// requested (OS signal, UI request, or tray quit). After the host loop returns
// it performs a graceful shutdown of all components.
//
// Lifecycle order:
//  1. restore persisted (key/combo) state
//  2. start the HTTP server
//  3. wire live callbacks (restart, server config, upstream timeout, state save)
//  4. open the browser (console host)
//  5. enter the host loop
//  6. graceful shutdown
func (a *App) Run(hostLoop HostLoopFunc) error {
	if a.sm == nil {
		return fmt.Errorf("app not initialized")
	}

	// Restore persisted state (key/combo runtime state) before starting the
	// server, so the cooldown/rotation state is in place before any request is
	// served.
	if a.stateManager != nil {
		if snapshot, err := state.Load(a.statePath); err != nil {
			a.logger.Warn("failed to load state: %v", err)
		} else if len(snapshot.Keys) > 0 || len(snapshot.Combos) > 0 {
			if err := a.stateManager.Restore(snapshot); err != nil {
				a.logger.Warn("failed to restore state: %v", err)
			} else {
				a.logger.Info("restored state: %d keys, %d combos", len(snapshot.Keys), len(snapshot.Combos))
			}
		}
	}

	// Start the HTTP server and wire the live callbacks.
	a.sm.Start()
	// Clear any stale error log from a previous failed launch.
	clearErrorLog(a.configDir)
	a.apiRouter.SetRestartFunc(a.sm.Restart)
	a.apiRouter.SetServerConfigFunc(a.sm.SetServerConfig)
	a.apiRouter.SetUpstreamTimeoutFunc(a.proxyHandler.SetUpstreamTimeout)
	if a.stateManager != nil {
		a.apiRouter.SetStateSaveFunc(a.stateManager.ScheduleWrite)
	}

	// Auto-open browser on the default (console) host; tray/webview hosts
	// override openBrowserOnStart to false so the tray/window is the entry point.
	if openBrowserOnStart() {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := OpenBrowser(fmt.Sprintf("http://%s", a.addr)); err != nil {
				a.logger.Info("failed to open browser: %v", err)
			}
		}()
	}

	// Block on the host loop until shutdown is requested (signal or UI or tray quit).
	// runHostLoop (and its shutdown wiring) is implemented per build tag in host_*.go.
	hctx := &HostContext{
		Logger:     a.logger,
		ConsoleURL: fmt.Sprintf("http://%s", a.addr),
		SM:         a.sm,
		Quit:       a.shutdownCtx.Done,
	}
	hostLoop(hctx)

	// Graceful HTTP server shutdown.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return a.Shutdown(ctx)
}

// Shutdown stops the HTTP server, flushes persisted state, cleans up the API
// router (downloads), and releases the single-instance lock. It is safe to
// call once.
//
// Shutdown is "power-cut": the HTTP server is given at most a short drain
// window, then forcibly closed (listener + all active connections dropped)
// regardless of in-flight requests. It never returns an error, so a shutdown
// timeout can never surface as a startup-failure dialog.
func (a *App) Shutdown(_ context.Context) error {
	if a.sm != nil {
		// Best-effort graceful drain; ignore any error and never surface it.
		shortCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		if err := a.sm.Shutdown(shortCtx); err != nil {
			a.logger.Warn("graceful http drain incomplete: %v", err)
		}
		cancel()
		// Force-close: drop the listener and kill all active connections now.
		a.sm.ForceClose()
	}
	if a.stateManager != nil {
		if err := a.stateManager.FlushSync(); err != nil {
			a.logger.Warn("failed to flush state: %v", err)
		}
	}
	if a.apiRouter != nil {
		a.apiRouter.Cleanup()
	}
	a.logger.Info("stopped")

	if a.lockFile != nil {
		a.lockFile.Close()
		_ = os.Remove(a.lockPath)
	}

	// Tray/webview builds force-exit to prevent zombie processes (message
	// loops can resist termination); the default console host returns normally.
	forceExitIfNeeded()

	return nil
}
