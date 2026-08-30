// Package api provides HTTP handlers for the management REST API.
package api

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/pprof"
	"net/url"
		"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/tinyrouter/tinyrouter/internal/api/anysearch"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	archiveapi "github.com/tinyrouter/tinyrouter/internal/api/archive"
	assistantapi "github.com/tinyrouter/tinyrouter/internal/api/assistant"
	"github.com/tinyrouter/tinyrouter/internal/api/auth"
	"github.com/tinyrouter/tinyrouter/internal/api/combos"
	"github.com/tinyrouter/tinyrouter/internal/api/comfyui"
	"github.com/tinyrouter/tinyrouter/internal/api/compress"
	"github.com/tinyrouter/tinyrouter/internal/api/console_logs"
	apidownload "github.com/tinyrouter/tinyrouter/internal/api/download"
	"github.com/tinyrouter/tinyrouter/internal/api/editor"
	"github.com/tinyrouter/tinyrouter/internal/api/fsbrowse"
	"github.com/tinyrouter/tinyrouter/internal/api/gallery"
	"github.com/tinyrouter/tinyrouter/internal/api/games"
	"github.com/tinyrouter/tinyrouter/internal/api/music"
	"github.com/tinyrouter/tinyrouter/internal/api/image"
	apimagebatch "github.com/tinyrouter/tinyrouter/internal/api/imagebatch"
	"github.com/tinyrouter/tinyrouter/internal/api/keys"
	"github.com/tinyrouter/tinyrouter/internal/api/models"
	apimonitor "github.com/tinyrouter/tinyrouter/internal/api/monitor"
	playgroundapi "github.com/tinyrouter/tinyrouter/internal/api/playground"
	"github.com/tinyrouter/tinyrouter/internal/api/probe"
	"github.com/tinyrouter/tinyrouter/internal/api/providers"
	"github.com/tinyrouter/tinyrouter/internal/api/quickslots"
	"github.com/tinyrouter/tinyrouter/internal/api/review_presets"
	"github.com/tinyrouter/tinyrouter/internal/api/settings"
	"github.com/tinyrouter/tinyrouter/internal/api/sse"
	"github.com/tinyrouter/tinyrouter/internal/api/textreview"
	"github.com/tinyrouter/tinyrouter/internal/api/trace"
	"github.com/tinyrouter/tinyrouter/internal/assistant"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/feature"
	"github.com/tinyrouter/tinyrouter/internal/filetransfer"
	domainimagebatch "github.com/tinyrouter/tinyrouter/internal/imagebatch"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
	"github.com/tinyrouter/tinyrouter/web"
)

// deps bundles every dependency and shared runtime state that the API handler
// domains need. It is embedded into Router so handler code stays terse
// (rt.reg, rt.logger, rt.proxyHandler, ...) while the Router struct itself no
// longer carries ~20 unrelated top-level fields.
type deps struct {
	reg          *registry.Registry
	configPath   string
	usage        *usage.RingBuffer
	pgUsage      *usage.RingBuffer // Playground 来源请求专用 ring
	quotaTracker *usage.QuotaTracker
	logger       *console.Logger
	proxyHandler *proxy.Handler
	selector     *rotation.Selector
	comboRes     *combo.Resolver
	downloadMgr  *download.Manager
	shutdown     context.CancelFunc

	// assistantHandler handles the assistant REST / SSE endpoints.
	assistantHandler *assistantapi.Handler

	// testClient is used by the batch key-probe handler.
	testClient *http.Client
	// debugMode reflects the live debug flag toggled from settings.
	debugMode atomic.Bool
	// quickSlotOnly reflects the live QuickSlot-only toggle from settings.
	quickSlotOnly atomic.Bool
	// logRequests reflects the live trace toggle from settings.
	logRequests atomic.Bool
	restartFn   func(string)

	// archiveRunner is the shared archive capability (ZIP/7z/RAR) wired by the
	// app after construction; nil disables the /api/archive endpoints with a
	// diagnostic 503.
	archiveRunner apibase.ArchiveRunner

	serverCfgFn       func(config.ServerConfig)
	upstreamTimeoutFn func(int)
	stateSaveFunc     func()
}

// Router wires up HTTP routes for the admin API. It embeds the shared deps and
// handler methods live in the per-domain files that have not yet been extracted
// to sub-packages (settings.go, providers.go, keys.go, combos.go, quickslots.go,
// usage.go, quota.go, model_keys.go, probe.go).
type Router struct {
	deps
}

// New creates an API Router. The signature is kept stable so existing callers
// (main.go and the package tests) do not need to change.
func New(reg *registry.Registry, cfg *config.Config, configPath string, usageBuf *usage.RingBuffer, pgUsageBuf *usage.RingBuffer, quotaTracker *usage.QuotaTracker, logger *console.Logger, proxyHandler *proxy.Handler, shutdown context.CancelFunc, selector *rotation.Selector, comboRes *combo.Resolver, downloadMgr *download.Manager) *Router {
	contract, _ := assistant.LoadContract()
	events := assistantapi.NewEventBroadcaster()
	todos := assistantapi.NewTodoStore()
	astHandler := assistantapi.NewHandler(nil, nil, contract, events, todos)
	// Per-preset assistant persona + memory (separate from config.yaml, under {configDir}/assistant/).
	assistantDir := config.ResolveAssistantDir("", filepath.Dir(configPath))
	presetStore := assistant.LoadPresets(filepath.Join(assistantDir, "model-presets.json"))
	chatSessions := assistant.NewChatSessions()
	memMgr := &assistant.MemoryManager{
		Dir:  filepath.Join(assistantDir, "memory"),
		Idle: 10 * time.Minute,
	}
	memMgr.History = chatSessions.Get
	memMgr.Logf = func(format string, args ...any) {
		if logger != nil {
			logger.Warn(format, args...)
		}
	}
	memMgr.Summarize = func(ctx context.Context, preset assistant.ModelPreset, transcript, existing string) (string, error) {
		// Resolve model: per-preset override → main assistant.model.
		model := preset.MemoryModel
		if model == "" && reg != nil {
			model = reg.Config().Assistant.Model
		}
		if model == "" {
			return "", fmt.Errorf("no model for summarization")
		}
		// Resolve addr from live config port.
		port := 0
		if reg != nil {
			port = reg.Config().Port
		}
		if port <= 0 {
			port = 20128
		}
		addr := fmt.Sprintf("http://127.0.0.1:%d", port)
		msgs := []assistant.ChatMessage{
			{Role: "system", Content: assistant.SummarizeSystemPrompt},
			{Role: "user", Content: "【既有记忆】\n" + func() string {
				if strings.TrimSpace(existing) == "" {
					return "（空）"
				}
				return existing
			}() + "\n\n【新对话记录】\n" + transcript},
		}
		client := &assistant.ChatClient{Addr: addr, Model: model}
		return client.Chat(ctx, msgs, nil)
	}
	astHandler.SetChatDeps(presetStore, memMgr, chatSessions)

	rt := &Router{
		deps: deps{
			reg:              reg,
			configPath:       configPath,
			usage:            usageBuf,
			pgUsage:          pgUsageBuf,
			quotaTracker:     quotaTracker,
			logger:           logger,
			proxyHandler:     proxyHandler,
			selector:         selector,
			comboRes:         comboRes,
			downloadMgr:      downloadMgr,
			shutdown:         shutdown,
			assistantHandler: astHandler,
			testClient: &http.Client{
				Timeout: 30 * time.Second,
				CheckRedirect: func(req *http.Request, via []*http.Request) error {
					if len(via) >= 5 {
						return fmt.Errorf("too many redirects")
					}
					if apibase.IsBlockedSSRFHost(req.URL.Hostname()) {
						return fmt.Errorf("redirect to blocked host: %s", req.URL.Hostname())
					}
					return nil
				},
			},
		},
	}
	rt.deps.logRequests.Store(cfg.Trace.Enabled)
	return rt
}

// AssistantHandler returns the assistant HTTP handler.
func (rt *Router) AssistantHandler() *assistantapi.Handler {
	return rt.assistantHandler
}

// SetRestartFunc configures a callback that will gracefully restart the HTTP
// server on a new address. Used by updateSettings when the port changes.
func (rt *Router) SetRestartFunc(fn func(string)) {
	rt.restartFn = fn
}

// SetServerConfigFunc configures a callback that pushes updated server timeout
// settings to the live ServerManager so a subsequent restart applies them.
func (rt *Router) SetServerConfigFunc(fn func(config.ServerConfig)) {
	rt.serverCfgFn = fn
}

// SetUpstreamTimeoutFunc configures a callback that pushes the updated
// upstream timeout to the live proxy handler so non-streaming requests
// pick up the new value without a restart.
func (rt *Router) SetUpstreamTimeoutFunc(fn func(int)) {
	rt.upstreamTimeoutFn = fn
}

// SetStateSaveFunc configures a callback that triggers a debounced state
// persistence write (state.yaml). Used by the reset-quota endpoint.
func (rt *Router) SetStateSaveFunc(fn func()) {
	rt.stateSaveFunc = fn
}

// SetArchiveRunner wires the archive runner built by the app. It must be
// called before Routes() so the /api/archive handlers and the settings
// runtime callback are populated.
func (rt *Router) SetArchiveRunner(runner apibase.ArchiveRunner) {
	rt.archiveRunner = runner
}

func (rt *Router) DebugMode() bool {
	return rt.debugMode.Load()
}

func (rt *Router) SetDebugMode(on bool) {
	rt.debugMode.Store(on)
}

func (rt *Router) QuickSlotOnly() bool {
	return rt.quickSlotOnly.Load()
}

func (rt *Router) SetQuickSlotOnly(on bool) {
	rt.quickSlotOnly.Store(on)
}

func (rt *Router) LogRequests() bool {
	return rt.deps.logRequests.Load()
}

func (rt *Router) SetLogRequests(on bool) {
	rt.deps.logRequests.Store(on)
}

// Cleanup stops the download manager.
// This should be called during graceful shutdown.
func (rt *Router) Cleanup() {
	if rt.downloadMgr != nil {
		rt.downloadMgr.Stop()
	}
}

// securityHeaders applies security-related HTTP headers to all responses
// except proxy routes (/v1/*) which transparently pass through upstream headers.
func securityHeaders(port int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/v1/") {
				csp := fmt.Sprintf("default-src 'self'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http: blob:; media-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https://api.jamendo.com https://api.bilibili.com ws://127.0.0.1:%d ws://127.0.0.1:*", port)
				w.Header().Set("Content-Security-Policy", csp)
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("X-Frame-Options", "SAMEORIGIN")
				w.Header().Set("X-XSS-Protection", "1; mode=block")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// isLocalhostOrigin reports whether the given Origin URL has a localhost host.
// Only localhost origins are allowed for /v1/* CORS — external websites must
// not be able to probe or abuse the local proxy via cross-origin requests.
func isLocalhostOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func (rt *Router) Routes(proxyHandler *proxy.Handler) http.Handler {
	// Sync the one genuinely tag-gated surface (the `playground` static embed)
	// into the feature manifest. Every other feature is registered compiled by
	// default because no feature_* build tags exist yet — their Go packages
	// compile unconditionally. The gates below are the single drop point where
	// future feature_* tags flip the manifest (docs/archive_compatibility_plan.md
	// §11/P5); in the default build every gate passes, so no route changes.
	feature.SetCompiled(feature.Playground, web.PlaygroundCompiled())
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(securityHeaders(rt.reg.Config().Port))
	// Compress responses (brotli/gzip) for compressible content types.
	r.Use(compress.Compress)

	rt.registerProxyRoutes(r, proxyHandler)

	// Profiling endpoints (/debug/pprof/*)
	r.Mount("/debug/pprof", pprofRouter())

	// Build the shared Deps for sub-packages.
	apiDeps := &apibase.Deps{
		Reg:               rt.reg,
		ConfigPath:        rt.configPath,
		Usage:             rt.usage,
		PgUsage:           rt.pgUsage,
		QuotaTracker:      rt.quotaTracker,
		Logger:            rt.logger,
		ProxyHandler:      rt.proxyHandler,
		Selector:          rt.selector,
		ComboRes:          rt.comboRes,
		DownloadMgr:       rt.downloadMgr,
		Shutdown:          rt.shutdown,
		TestClient:        rt.testClient,
		DebugMode:         &rt.debugMode,
		QuickSlotOnly:     &rt.quickSlotOnly,
		LogRequests:       &rt.logRequests,
		RestartFn:         rt.restartFn,
		ServerCfgFn:       rt.serverCfgFn,
		UpstreamTimeoutFn: rt.upstreamTimeoutFn,
		StateSaveFn:       rt.stateSaveFunc,
		ArchiveSettingsFn: func(cfg config.ArchiveConfig) {
			if rt.archiveRunner != nil {
				rt.archiveRunner.UpdateSettings(cfg)
			}
		},
	}
	authHandler := auth.NewHandler(apiDeps)
	anysearchHandler := anysearch.NewHandler(apiDeps)
	combosHandler := combos.NewHandler(apiDeps)
	sseHandler := sse.NewHandler(apiDeps)
	consoleLogsHandler := console_logs.NewHandler(apiDeps)
	editorHandler := editor.NewHandler(apiDeps)
	textReviewHandler := textreview.NewHandler(apiDeps)
	reviewPresetsHandler := review_presets.NewHandler(apiDeps)
	keysHandler := keys.NewHandler(apiDeps)
	modelsHandler := models.NewHandler(apiDeps)
	comfyuiHandler := comfyui.NewHandler(apiDeps)
	quickslotsHandler := quickslots.NewHandler(apiDeps)
	imageHandler := image.NewHandler(apiDeps)
	settingsHandler := settings.NewHandler(apiDeps)
	providersHandler := providers.NewHandler(apiDeps)
	monitorHandler := apimonitor.NewHandler(apiDeps)
	downloadHandler := apidownload.NewHandler(apiDeps)
	fsbrowseHandler := fsbrowse.NewHandler()
	galleryHandler := gallery.NewHandler(apiDeps)
	fileTransferHandler := filetransfer.NewHandler()
	imageBatchHandler := func() *apimagebatch.Handler {
		root := config.ResolveImageSaveDir(rt.reg.Config().ImageSaveDir, filepath.Dir(rt.configPath))
		store, err := domainimagebatch.NewProjectStore(root)
		if err != nil {
			return apimagebatch.NewHandler(apiDeps, nil)
		}
		remote := domainimagebatch.NewRemoteGenerator(rt.proxyHandler)
		generator := domainimagebatch.NewProtocolGenerator(remote)
		manager := domainimagebatch.NewManager(store, generator)
		return apimagebatch.NewHandler(apiDeps, manager)
	}()
	traceHandler := trace.NewHandler(apiDeps)
	probeHandler := probe.NewHandler(apiDeps)
	gamesHandler := games.NewHandler(apiDeps)
	musicHandler := music.NewHandler(apiDeps)
	archiveHandler := archiveapi.NewHandler(apiDeps, rt.archiveRunner)
	playgroundHandler := playgroundapi.NewHandler(apiDeps)
	// Gallery resolves registered archive sources through the /api/archive
	// bridge (sourceId-based items); nil bridge keeps the legacy in-memory
	// zip session flow working.
	if rt.archiveRunner != nil {
		galleryHandler.SetArchive(archiveHandler)
	}
	rt.assistantHandler.SetDeps(apiDeps)

	// API routes
	r.Route("/api", func(r chi.Router) {
		// 1 MB API request body limit
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Music transcode carries raw audio bytes (up to 200 MiB), not JSON — the
				// global 1 MiB cap would make it unusable. Bypass here; the handler
				// enforces its own 200 MiB MaxBytesReader.
				if r.URL.Path == "/api/music/transcode" || strings.HasPrefix(r.URL.Path, "/api/music/transcode?") {
					next.ServeHTTP(w, r)
					return
				}
				r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
				next.ServeHTTP(w, r)
			})
		})

		// --- Public routes + auth middleware ---
		authMW := authHandler.Register(r)

		// --- Protected routes (auth required) ---
		r.Group(func(r chi.Router) {
			r.Use(authMW)

			settingsHandler.Register(r)

			// Providers
			providersHandler.Register(r)
			// Probe
			probeHandler.Register(r)

			// Combos
			combosHandler.Register(r)

			// Keys
			keysHandler.Register(r)
			// QuickSlots
			quickslotsHandler.Register(r)

			// ReviewPresets
			reviewPresetsHandler.Register(r)

			// Monitor
			monitorHandler.Register(r)
			sseHandler.Register(r)

			// Console logs
			consoleLogsHandler.Register(r)

			// Models
			modelsHandler.Register(r)

			// Assistant
			r.Route("/assistant", rt.assistantHandler.Register)

			// Downloads (feature_download)
			if feature.Enabled(feature.Download) {
				downloadHandler.Register(r)
			}

			// AnySearch (Playground Search backend). Its Go package compiles
			// unconditionally today — no feature_* tag exists yet (P5 blocker),
			// so this registration is intentionally NOT gated on Playground:
			// gating it would drop the routes from default builds.
			anysearchHandler.Register(r)
			// Generic OS file/directory picker, shared by assistant/gallery/
			// download frontends — intentionally NOT gated on feature.Download.
			fsbrowseHandler.Register(r)
			// Traces
			r.Route("/traces", traceHandler.Register)

			rt.registerDemoAPIRoutes(r, gamesHandler)

			// Music (local playback + Jamendo/online; no extra feature gate)
			r.Route("/music", func(r chi.Router) { musicHandler.Register(r) })
		})
	})

	rt.registerPlaygroundRoutes(r, authHandler, imageHandler, playgroundHandler, comfyuiHandler, imageBatchHandler)

	rt.registerUtilityRoutes(r, authHandler, editorHandler, textReviewHandler, galleryHandler, fileTransferHandler, archiveHandler)


	rt.registerPlaygroundStatic(r)

	rt.registerDemoStatic(r)
	r.Get("/*", rt.serveUI)

	// Walk routes to dynamically build the assistant contract-backed router
	routeSet := make(map[string]bool)
	_ = chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		p := assistant.NormalizePath(route)
		if !strings.HasPrefix(p, "/v1/") && !strings.HasPrefix(p, "/api/") {
			return nil
		}
		if method == http.MethodOptions || method == http.MethodHead {
			return nil
		}
		routeSet[method+" "+p] = true
		return nil
	})
	if contract, err := assistant.LoadContract(); err == nil {
		ast, _ := contract.BuildAssistant(routeSet, true)
		rt.assistantHandler.SetAssistant(ast)
	}

	return r
}

// serveUI serves the embedded admin UI, choosing between the full (playground)
// and no-playground index.html based on the EnablePlayground flag.
func (rt *Router) serveUI(w http.ResponseWriter, r *http.Request) {
	staticFS, err := fs.Sub(web.Static, "static")
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Serve static files (no cache for local deployment/updates)
	if r.URL.Path != "/" {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		f := http.FileServer(http.FS(staticFS))
		f.ServeHTTP(w, r)
		return
	}

	// Root: choose index.html variant based on EnablePlayground flag AND whether
	// the playground module was compiled into this binary.
	// Path matrix:
	//   PlaygroundCompiled==false:  serve index-nopg.html always (no playground resources)
	//   PlaygroundCompiled==true && EnablePlayground:  serve index.html (full)
	//   PlaygroundCompiled==true && !EnablePlayground: serve index-nopg.html
	indexFile := "index-nopg.html"
	if web.PlaygroundCompiled() && rt.reg.Config().EnablePlayground {
		indexFile = "index.html"
	}
	data, err := fs.ReadFile(staticFS, indexFile)
	if err != nil {
		http.Error(w, indexFile+" not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Write(data)
}

func pprofRouter() chi.Router {
	r := chi.NewRouter()
	r.HandleFunc("/", pprof.Index)
	r.HandleFunc("/cmdline", pprof.Cmdline)
	r.HandleFunc("/profile", pprof.Profile)
	r.HandleFunc("/symbol", pprof.Symbol)
	r.HandleFunc("/trace", pprof.Trace)
	r.HandleFunc("/allocs", pprof.Handler("allocs").ServeHTTP)
	r.HandleFunc("/block", pprof.Handler("block").ServeHTTP)
	r.HandleFunc("/goroutine", pprof.Handler("goroutine").ServeHTTP)
	r.HandleFunc("/heap", pprof.Handler("heap").ServeHTTP)
	r.HandleFunc("/mutex", pprof.Handler("mutex").ServeHTTP)
	r.HandleFunc("/threadcreate", pprof.Handler("threadcreate").ServeHTTP)
	return r
}
