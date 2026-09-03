// Package api provides HTTP handlers for the management REST API.
package api

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/games"
	"github.com/tinylab/tinylab/internal/config"
)

// registerDemoAPIRoutes mounts the /api/games endpoints on the given router.
// The caller must invoke this inside the auth-protected /api group so the
// routes inherit the management middleware and 1 MiB body limit.
func (rt *Router) registerDemoAPIRoutes(r chi.Router, gamesHandler *games.Handler) {
	r.Route("/games", func(r chi.Router) { gamesHandler.Register(r) })
}

// registerDemoStatic ensures the on-disk games directory exists and mounts
// the no-store static file server for /games/*. The embedded default set is
// NOT auto-seeded on startup — the user creates example units on demand via
// POST /api/games/seed (Designer "Example Unit" button).
// Ordering: must be called before the catch-all serveUI route so the specific
// /games/* pattern wins.
func (rt *Router) registerDemoStatic(r chi.Router) {
	gamesDir := config.ResolveGamesDir(rt.reg.Config().GamesDir, filepath.Dir(rt.configPath))
	if err := os.MkdirAll(gamesDir, 0o755); err != nil {
		rt.logger.Warn("router: games: create dir %s failed: %v", gamesDir, err)
	}
	gamesStatic := http.StripPrefix("/games/", http.FileServer(http.Dir(gamesDir)))
	r.Get("/games/*", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		gamesStatic.ServeHTTP(w, req)
	})
}
