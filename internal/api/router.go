package api

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/monitor"
	"github.com/tinyrouter/tinyrouter/internal/proxy"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/terminal"
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

	// testClient is used by the batch key-probe handler.
	testClient *http.Client
	// monitorMgr drives the live monitor log stream.
	monitorMgr *monitor.Manager
	// debugMode reflects the live debug flag toggled from settings.
	debugMode atomic.Bool
	// quickSlotOnly reflects the live QuickSlot-only toggle from settings.
	quickSlotOnly atomic.Bool

	// The following callbacks are configured after construction via setters.
	restartFn         func(string)
	serverCfgFn       func(config.ServerConfig)
	upstreamTimeoutFn func(int)
	stateSaveFunc     func()
}

// terminalState holds the websocket terminal session and its guard mutex. It is
// kept separate from deps because it is only touched by the terminal handlers.
type terminalState struct {
	terminalMu sync.Mutex
	activeTerm *terminal.Session
}

// Router wires up HTTP routes for the admin API. It embeds the shared deps and
// terminal state; individual handler methods live in the per-domain files
// (settings.go, providers.go, keys.go, combos.go, quickslots.go, usage.go,
// quota.go, model_keys.go, console_logs.go, sse_events.go, models.go, probe.go).
type Router struct {
	deps
	terminalState
}

// New creates an API Router. The signature is kept stable so existing callers
// (main.go and the package tests) do not need to change.
func New(reg *registry.Registry, cfg *config.Config, configPath string, usageBuf *usage.RingBuffer, pgUsageBuf *usage.RingBuffer, quotaTracker *usage.QuotaTracker, logger *console.Logger, proxyHandler *proxy.Handler, shutdown context.CancelFunc, selector *rotation.Selector, comboRes *combo.Resolver, downloadMgr *download.Manager) *Router {
	return &Router{
		deps: deps{
			reg:          reg,
			configPath:   configPath,
			usage:        usageBuf,
			pgUsage:      pgUsageBuf,
			quotaTracker: quotaTracker,
			logger:       logger,
			proxyHandler: proxyHandler,
			selector:     selector,
			comboRes:     comboRes,
			downloadMgr:  downloadMgr,
			shutdown:     shutdown,
			testClient: &http.Client{
				Timeout: 30 * time.Second,
				CheckRedirect: func(req *http.Request, via []*http.Request) error {
					if len(via) >= 5 {
						return fmt.Errorf("too many redirects")
					}
					if isBlockedSSRFHost(req.URL.Hostname()) {
						return fmt.Errorf("redirect to blocked host: %s", req.URL.Hostname())
					}
					return nil
				},
			},
			monitorMgr: monitor.New(500, cfg.Monitor.MaxLineLength),
		},
	}
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

// Cleanup stops the monitor manager and closes any active terminal session.
// This should be called during graceful shutdown.
func (rt *Router) Cleanup() {
	if err := rt.monitorMgr.Stop(); err != nil {
		rt.logger.Warn("monitor cleanup: %v", err)
	}
	rt.terminalMu.Lock()
	term := rt.activeTerm
	rt.activeTerm = nil
	rt.terminalMu.Unlock()

	if term != nil {
		term.Close()
	}
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
				csp := fmt.Sprintf("default-src 'self'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http: blob:; media-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:%d", port)
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

// Routes returns the root HTTP handler with all routes registered.
func (rt *Router) Routes(proxyHandler *proxy.Handler) http.Handler {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(securityHeaders(rt.reg.Config().Port))
	// Compress responses (brotli/gzip) for compressible content types.
	// SSE responses and pre-compressed binaries are auto-skipped inside.
	r.Use(Compress)

	// CORS preflight for proxy routes only (/v1/*). Management /api/* routes
	// have NO CORS — the admin UI is same-origin and external pages must not
	// be able to read/modify config or steal API keys via cross-origin fetch.
	r.Options("/v1/*", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && isLocalhostOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Expose-Headers", "X-TinyRouter-Provider, X-TinyRouter-Key")
		w.WriteHeader(http.StatusNoContent)
	})

	// Proxy routes (OpenAI-compatible)
	r.Post("/v1/chat/completions", proxyHandler.ChatCompletions)
	r.Post("/v1/completions", proxyHandler.Completions)
	r.Get("/v1/models", proxyHandler.ListModels)
	r.Post("/v1/images/generations", proxyHandler.ImagesGenerations)
	r.Post("/v1/embeddings", proxyHandler.Embeddings)
	// Proxy route (Anthropic protocol). Anthropic /v1/messages has no GET
	// semantics, so only POST is registered. CORS is handled by the
	// path-prefix `/v1/*` OPTIONS handler below — no extra config needed.
	r.Post("/v1/messages", proxyHandler.Messages)
	// Proxy route (OpenAI Responses protocol). POST only; CORS is handled by the
	// path-prefix `/v1/*` OPTIONS handler below — no extra config needed. Transparent
	// passthrough using the standard Authorization: Bearer header.
	r.Post("/v1/responses", proxyHandler.Responses)
	r.Post("/v1/tasks/{taskId}", proxyHandler.PollTask)
	r.Get("/v1/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		taskID := chi.URLParam(r, "taskId")
		modelStr := r.URL.Query().Get("model")
		proxyHandler.TaskGet(w, r, taskID, modelStr)
	})

	// API routes
	r.Route("/api", func(r chi.Router) {
		// 1 MB API request body limit
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
				next.ServeHTTP(w, r)
			})
		})

		// --- Public routes (no auth required) ---
		r.Get("/auth/status", rt.AuthStatusHandler)
		loginLimiter := newLoginRateLimiter()
		r.Post("/auth/login", loginLimiter.Wrap(rt.LoginHandler))

		// --- Protected routes (auth required) ---
		r.Group(func(r chi.Router) {
			r.Use(rt.AuthMiddleware)

			// Settings
			r.Get("/settings", rt.getSettings)
			r.Patch("/settings", rt.updateSettings)
			r.Post("/reload", rt.reload)
			r.Post("/shutdown", rt.handleShutdown)

			// Providers
			r.Get("/providers", rt.listProviders)
			r.Post("/providers", rt.createProvider)
			r.Post("/providers/validate", rt.validateProvider)
			r.Put("/providers/{id}", rt.updateProvider)
			r.Put("/providers/{id}/reorder", rt.reorderProvider)
			r.Delete("/providers/{id}", rt.deleteProvider)

			// Provider testing
			r.Post("/providers/{id}/test", rt.testProviderKey)

			// Provider models
			r.Get("/providers/{id}/models", rt.fetchProviderModels)
			r.Post("/providers/{id}/models", rt.addProviderModel)
			r.Post("/providers/{id}/models/test-proto", rt.testProviderModelProto)
			r.Post("/providers/{id}/models/test-all", rt.testProviderModelAllKeys)
			r.Patch("/providers/{id}/models/quota", rt.updateModelQuota)
			r.Patch("/providers/{id}/models/alias", rt.updateModelAlias)
			r.Patch("/providers/{id}/models/note", rt.updateModelNote)
			r.Patch("/providers/{id}/models/nim", rt.updateModelNIM)
			r.Patch("/providers/{id}/models/kind", rt.updateModelKind)
			r.Patch("/providers/{id}/models/imgProtocol", rt.updateModelImgProtocol)
			r.Patch("/providers/{id}/models/imgSizes", rt.updateModelImgSizes)
			r.Patch("/providers/{id}/models/protocols", rt.updateModelProtocols)
			r.Delete("/providers/{id}/models", rt.deleteProviderModel)

			// Keys
			r.Get("/providers/{id}/keys", rt.listKeys)
			r.Post("/providers/{id}/keys", rt.createKey)
			r.Post("/providers/{id}/keys/bulk", rt.bulkAddKeys)
			r.Put("/providers/{id}/keys/{kid}", rt.updateKey)
			r.Delete("/providers/{id}/keys/{kid}", rt.deleteKey)
			r.Get("/providers/{id}/keys/{kid}/state", rt.getKeyState)

			// Combos
			r.Get("/combos", rt.listCombos)
			r.Post("/combos", rt.createCombo)
			r.Put("/combos/{id}", rt.updateCombo)
			r.Delete("/combos/{id}", rt.deleteCombo)
			r.Post("/combos/{id}/speed-test", rt.speedTestCombo)
			r.Get("/combos/{id}/speed-results", rt.getComboSpeedResults)

			// QuickSlots
			r.Get("/quickslots", rt.listQuickSlots)
			r.Post("/quickslots", rt.createQuickSlot)
			r.Put("/quickslots/{id}", rt.updateQuickSlot)
			r.Delete("/quickslots/{id}", rt.deleteQuickSlot)

			// ReviewPresets
			r.Get("/review-presets", rt.listReviewPresets)
			r.Post("/review-presets", rt.upsertReviewPreset)
			r.Delete("/review-presets/{id}", rt.deleteReviewPreset)

			// Usage
			r.Get("/usage", rt.getUsage)
			r.Get("/usage/playground", rt.getPlaygroundUsage)
			r.Get("/usage/summary", rt.getUsageSummary)
			r.Get("/usage/quotas", rt.getQuotas)
			r.Get("/usage/model-keys", rt.getModelKeys)
			r.Get("/usage/events", rt.streamUsageEvents)
			r.Delete("/usage", rt.clearUsage)
			r.Post("/usage/reset-quota", rt.resetQuota)

			// Image save + same-origin proxy (avoids CORS for browser-side reads)
			r.Post("/save-image", rt.saveImage)
			r.Get("/image-proxy", rt.imageProxy)

			// Console logs
			r.Get("/console-logs", rt.getConsoleLogs)
			r.Get("/console-logs/stream", rt.streamConsoleLogs)
			r.Delete("/console-logs", rt.clearConsoleLogs)

			// Monitor
			r.Get("/monitor/status", rt.getMonitorStatus)
			r.Post("/monitor/start", rt.startMonitor)
			r.Post("/monitor/stop", rt.stopMonitor)
			r.Get("/monitor/stream", rt.streamMonitor)

			// Terminal (debug-mode only)
			r.Get("/terminal/ws", rt.handleTerminalWS)
			r.Post("/terminal/stop", rt.stopTerminal)

			// Auth - logout (requires auth)
			r.Post("/auth/logout", rt.LogoutHandler)

			// Models
			r.Get("/models", rt.listModels)

			// Downloads
			r.Get("/downloads", rt.listDownloads)
			r.Post("/downloads", rt.createDownload)
			r.Get("/downloads/stream", rt.streamDownloadEvents)
			r.Post("/downloads/info", rt.getVideoInfo)
			r.Post("/downloads/playlist-info", rt.getPlaylistInfo)
			r.Post("/downloads/playlist", rt.createPlaylistDownload)
			r.Post("/downloads/clear-completed", rt.clearCompletedDownloads)
			r.Get("/downloads/{id}", rt.getDownload)
			r.Get("/downloads/{id}/log", rt.getDownloadLog)
			r.Get("/downloads/{id}/file", rt.playDownloadFile)
			r.Post("/downloads/{id}/cancel", rt.cancelDownload)
			r.Post("/downloads/{id}/open", rt.openDownloadDir)
			r.Post("/downloads/{id}/retry", rt.retryDownloadTask)
			r.Delete("/downloads/{id}", rt.removeDownload)
			r.Post("/open-url", rt.openExternalURL)
			r.Post("/browse", rt.browseSystemPath)

			// AnySearch
			r.Post("/anysearch/search", rt.anySearchHandler)
			r.Post("/anysearch/subdomains", rt.anySearchSubDomainsHandler)
			r.Post("/anysearch/extract", rt.anySearchExtractHandler)
		})
	})

	// Gallery API routes: outside the /api group so they bypass the 1MB body
	// limit (zip uploads can be up to 500MB) but still require auth, matching
	// the protected /api/* authorization boundary.
	r.Route("/api/gallery", func(r chi.Router) {
		r.Use(rt.AuthMiddleware)
		r.Post("/zip", rt.galleryListZip)
		r.Get("/zip/{sessionId}/*", rt.galleryGetZipEntry)
		r.Delete("/zip/{sessionId}/*", rt.galleryDeleteZipEntry)
		r.Post("/tiff", rt.galleryConvertTiff)
		r.Post("/review/start", rt.galleryStartReview)
		r.Get("/review/status/{sessionId}", rt.galleryReviewStatus)
		r.Post("/review/cancel/{sessionId}", rt.galleryCancelReview)
		r.Post("/review/gen-prompt", rt.galleryGeneratePrompt)
		// Filesystem-backed gallery operations (backend picker, file serving,
		// disk delete, clipboard paste paths).
		r.Post("/open-dir", rt.galleryOpenDir)
		r.Post("/list-dir", rt.galleryListDir)
		r.Get("/file", rt.galleryServeFile)
		r.Delete("/fs", rt.galleryDeleteFs)
		r.Post("/zip-from-path", rt.galleryZipFromPath)
		r.Post("/zip-writeback", rt.galleryZipWriteback)
		r.Post("/paste-paths", rt.galleryPastePaths)
	})

	// Embedded UI (fallback to index.html)
	// Playground static routes: only register when the playground module is
	// compiled into the binary (build tag `playground`). At runtime the flag
	// is a no-op when the binary lacks playground resources.
	if web.PlaygroundCompiled() {
		if pgStatic, err := fs.Sub(web.PlaygroundStatic, "playground/static-pg"); err == nil {
			pgFSRoot := http.FileServer(http.FS(pgStatic))
			noCacheHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
				pgFSRoot.ServeHTTP(w, r)
			})
			r.Get("/playground.css", noCacheHandler)
			r.Get("/vendor/*", noCacheHandler)
			pgJSFiles := []string{
				"playground.js", "pg-i18n.js",
				"pg-core.js", "pg-state.js", "pg-markdown.js",
				"pg-request.js", "pg-stream.js", "pg-render.js",
				"pg-ui.js", "pg-modal.js", "pg-lifecycle.js",
				"pg-autochat.js",
				"pg-setup.js", "pg-director.js", "pg-search.js",
				"gallery-state.js", "gallery-io.js", "gallery-layout.js",
				"gallery-tree.js", "gallery-review.js", "gallery-video.js", "gallery-fullscreen.js",
				"gallery.js",
			}
			for _, f := range pgJSFiles {
				r.Get("/"+f, noCacheHandler)
			}
		}
	}
	r.Get("/*", rt.serveUI)

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
