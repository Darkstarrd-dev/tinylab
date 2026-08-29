// Package api provides HTTP handlers for the management REST API.
package api

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/games"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/web"
)

// registerDemoAPIRoutes mounts the /api/games endpoints on the given router.
// The caller must invoke this inside the auth-protected /api group so the
// routes inherit the management middleware and 1 MiB body limit.
func (rt *Router) registerDemoAPIRoutes(r chi.Router, gamesHandler *games.Handler) {
	r.Route("/games", func(r chi.Router) { gamesHandler.Register(r) })
}

// registerDemoStatic seeds the embedded default games into the on-disk games
// directory and mounts the no-store static file server for /games/*.
// Seed semantics (mirrors the pre-split inline block in router.go):
//   - ResolveGamesDir picks the on-disk root (config.GamesDir or {configDir}/games).
//   - os.MkdirAll ensures the directory exists before seeding.
//   - fs.Sub(web.Games, "games") opens the embedded default set; if unavailable
//     we log a warning and continue (disk may already hold games).
//   - games.SeedGames copies each embedded game directory only if the target
//     name does not already exist — never overwriting user content.
// Ordering: must be called before the catch-all serveUI route so the specific
// /games/* pattern wins; keep this helper together with registerDemoAPIRoutes
// so demo concerns stay in one file (P2-07).
func (rt *Router) registerDemoStatic(r chi.Router) {
	gamesDir := config.ResolveGamesDir(rt.reg.Config().GamesDir, filepath.Dir(rt.configPath))
	if err := os.MkdirAll(gamesDir, 0o755); err != nil {
		rt.logger.Warn("router: games: create dir %s failed: %v", gamesDir, err)
	} else if gameFS, ferr := fs.Sub(web.Games, "games"); ferr == nil {
		if seeded, serr := games.SeedGames(gameFS, gamesDir, rt.logger.Warn); serr != nil {
			rt.logger.Warn("router: games: seed failed: %v", serr)
		} else if len(seeded) > 0 {
			rt.logger.Info("router: games: seeded default games: %v", seeded)
		}
	} else {
		rt.logger.Warn("router: games: embedded default set unavailable: %v", ferr)
	}
	gamesStatic := http.StripPrefix("/games/", http.FileServer(http.Dir(gamesDir)))
	r.Get("/games/*", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		gamesStatic.ServeHTTP(w, req)
	})
}
