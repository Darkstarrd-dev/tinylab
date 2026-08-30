// Package games implements the disk-based game plugins: the /api/games HTTP
// surface (list + per-game JSON state) and startup seeding of the embedded
// default game set.
//
// Plugin contract:
//   - Each game is one subdirectory of the games directory ({configDir}/games
//     by default, see config.ResolveGamesDir). Its content is served verbatim
//     under /games/* without auth, so changing game code never requires a
//     recompile or restart.
//   - A game directory contains game.json: {"id","title","version","entry"}
//     where entry is the classic-script path (relative to the game directory)
//     the frontend loads. Manifests that are missing, carry an id that does
//     not match the directory name, lack a title, or point at a missing entry
//     file are skipped (with a warning) when listing.
//   - Each game persists its save state through GET/PUT /api/games/{id}/state,
//     backed by an atomic JSON file under {configDir}/gamedata/{id}.json.
//   - SeedGames copies the embedded default set into the games directory at
//     startup; directories already present are left untouched forever.
package games

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
)

// ctxKeySrcFS is the context key for injecting an fs.FS in tests.
type ctxKey string

const ctxKeySrcFS ctxKey = "games-src-fs"

// CtxWithSrcFS returns a context carrying src as the seed source.
func CtxWithSrcFS(ctx context.Context, src fs.FS) context.Context {
	return context.WithValue(ctx, ctxKeySrcFS, src)
}

// embeddedGames is the production embedded games FS, set once at startup via
// SetEmbeddedGames. Tests inject their own FS via CtxWithSrcFS.
var embeddedGames fs.FS

// SetEmbeddedGames registers the production embedded games FS (web.Games).
func SetEmbeddedGames(src fs.FS) { embeddedGames = src }

// SeedFromEmbedded seeds the embedded games into gamesDir using the
// production embedded FS. No-op if none registered.
func SeedFromEmbedded(gamesDir string, warnf func(string, ...any)) ([]string, error) {
	if embeddedGames == nil {
		return nil, nil
	}
	return SeedGames(embeddedGames, gamesDir, warnf)
}

// gameIDRe bounds a game id to URL-safe tokens: 1-64 alphanumerics, dash,
// underscore. It is applied before any path use so a state file can never
// escape {configDir}/gamedata.
var gameIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// gameManifest is the game.json shape every game directory must provide.
type gameManifest struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Version string `json:"version"`
	Entry   string `json:"entry"`
}

// gameSummary is one entry in the GET /api/games listing.
type gameSummary struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Version string `json:"version"`
	Entry   string `json:"entry"`
	V       int64  `json:"v"` // entry file mtime in Unix milliseconds
}

// Handler provides HTTP handlers for the games plugins.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a games Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// chiRouter is the chi router surface the games package needs, decoupled so
// tests can mount the routes without importing chi.
type chiRouter interface {
	Get(string, http.HandlerFunc)
	Put(string, http.HandlerFunc)
	Post(string, http.HandlerFunc)
}

// Register wires up the games routes on the given router. The caller is
// expected to mount it inside the auth-gated, 1 MiB-capped /api group.
func (h *Handler) Register(r chiRouter) {
	r.Get("/", h.listGames)
	r.Post("/seed", h.seedExamples)
	r.Get("/{id}/state", h.getState)
	r.Put("/{id}/state", h.putState)
}

// gamesDir resolves the configured games directory to an absolute path.
func (h *Handler) gamesDir() string {
	gamesDir := "games"
	if h != nil && h.d != nil {
		cfg := h.d.Reg.Config()
		configDir := ""
		if h.d.ConfigPath != "" {
			configDir = filepath.Dir(h.d.ConfigPath)
		}
		gamesDir = config.ResolveGamesDir(cfg.GamesDir, configDir)
	}
	abs, err := filepath.Abs(gamesDir)
	if err != nil {
		return gamesDir
	}
	return abs
}

// gameDataDir resolves the per-game state directory to an absolute path. It
// always lives at {configDir}/gamedata (no config option).
func (h *Handler) gameDataDir() string {
	configDir := ""
	if h != nil && h.d != nil && h.d.ConfigPath != "" {
		configDir = filepath.Dir(h.d.ConfigPath)
	}
	dir := filepath.Join(configDir, "gamedata")
	abs, err := filepath.Abs(dir)
	if err != nil {
		return dir
	}
	return abs
}

// listGames returns every valid game under the games directory, each with its
// manifest fields and the entry file mtime (v) so the frontend can reload when
// game code changes. Invalid manifests are skipped with a warning.
func (h *Handler) listGames(w http.ResponseWriter, r *http.Request) {
	gamesDir := h.gamesDir()
	entries, err := os.ReadDir(gamesDir)
	if err != nil {
		// Not yet seeded/created: an empty games directory is a valid state.
		if os.IsNotExist(err) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"games": []gameSummary{}})
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read games dir failed: "+err.Error())
		return
	}
	games := make([]gameSummary, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if g, ok := h.loadManifest(filepath.Join(gamesDir, e.Name()), e.Name()); ok {
			games = append(games, g)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"games": games})
}

// loadManifest reads and validates one game's game.json. An invalid manifest
// is warned about and reported as skipped (ok=false).
func (h *Handler) loadManifest(gameDir, id string) (gameSummary, bool) {
	raw, err := os.ReadFile(filepath.Join(gameDir, "game.json"))
	if err != nil {
		h.d.Logger.Warn("games: %s: no readable game.json: %v", id, err)
		return gameSummary{}, false
	}
	var m gameManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		h.d.Logger.Warn("games: %s: invalid game.json: %v", id, err)
		return gameSummary{}, false
	}
	if m.ID != id {
		h.d.Logger.Warn("games: %s: manifest id %q does not match directory name", id, m.ID)
		return gameSummary{}, false
	}
	if m.Title == "" || m.Entry == "" {
		h.d.Logger.Warn("games: %s: manifest missing title or entry", id)
		return gameSummary{}, false
	}
	entry := filepath.Join(gameDir, filepath.FromSlash(m.Entry))
	if !withinDir(gameDir, entry) {
		h.d.Logger.Warn("games: %s: entry %q escapes the game directory", id, m.Entry)
		return gameSummary{}, false
	}
	info, err := os.Stat(entry)
	if err != nil || info.IsDir() {
		h.d.Logger.Warn("games: %s: entry file %q not found", id, m.Entry)
		return gameSummary{}, false
	}
	return gameSummary{
		ID:      m.ID,
		Title:   m.Title,
		Version: m.Version,
		Entry:   m.Entry,
		V:       info.ModTime().UnixMilli(),
	}, true
}

// withinDir reports whether path is strictly inside root.
func withinDir(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// getState returns the raw saved JSON state of a game ({"a":1} verbatim).
func (h *Handler) getState(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !gameIDRe.MatchString(id) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid game id")
		return
	}
	data, err := os.ReadFile(filepath.Join(h.gameDataDir(), id+".json"))
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "state not found")
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read state failed: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

// putState atomically persists a game's JSON state to {gamedata}/{id}.json.
func (h *Handler) putState(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !gameIDRe.MatchString(id) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid game id")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "read body failed: "+err.Error())
		return
	}
	if !json.Valid(body) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	dir := h.gameDataDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "mkdir gamedata failed: "+err.Error())
		return
	}
	if err := fsutil.AtomicWrite(filepath.Join(dir, id+".json"), body, 0o644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "write state failed: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// seedExamples copies every embedded game directory that is not already on
// disk into the games directory. POST /api/games/seed, auth-gated. Existing
// directories are skipped (never overwritten). Returns
// {"seeded":[...],"skipped":[...] }.
func (h *Handler) seedExamples(w http.ResponseWriter, r *http.Request) {
	gamesDir := h.gamesDir()
	if err := os.MkdirAll(gamesDir, 0o755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "create games dir failed: "+err.Error())
		return
	}
	// Collect existing top-level dirs to report skipped.
	existing := map[string]bool{}
	if entries, err := os.ReadDir(gamesDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				existing[e.Name()] = true
			}
		}
	}
	// Source is the embedded default set; if the build has no embedded games
	// we simply return an empty result (no error) so the call is idempotent.
	// The embed lives in package web; import it here would create a cycle
	// web->api/games->web, so the caller provides the FS. Instead we open
	// the in-process embedded FS via an indirection: try to load the global
	// web.Games through a helper. Keep the handler testable by accepting
	// src via context — tests set r.Context with the src FS; production
	// falls back to the embedded FS registered via SetEmbeddedGames.
	src := embeddedGames
	if v := r.Context().Value(ctxKeySrcFS); v != nil {
		if f, ok := v.(fs.FS); ok {
			src = f
		}
	}
	if src == nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"seeded": []string{}, "skipped": keysOf(existing)})
		return
	}
	seeded, err := SeedGames(src, gamesDir, h.d.Logger.Warn)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "seed failed: "+err.Error())
		return
	}
	// Re-collect skipped (those that existed before this call and were not seeded).
	skipped := []string{}
	for k := range existing {
		skipped = append(skipped, k)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"seeded": seeded, "skipped": skipped})
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// SeedGames copies every game directory from src (an embedded FS whose top
// level contains one directory per game) into gamesDir. A destination
// directory that already exists is skipped entirely and never overwritten. Non-
// fatal per-game failures are reported through warnf (may be nil) and the
// failed game is skipped; the returned slice lists the directories that were
// copied successfully. Files are written 0600 then made 0644, mirroring the
// project's temp-file + rename write discipline.
func SeedGames(src fs.FS, gamesDir string, warnf func(string, ...any)) (seeded []string, err error) {
	entries, err := fs.ReadDir(src, ".")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		target := filepath.Join(gamesDir, name)
		if _, err := os.Stat(target); err == nil {
			// Already on disk: keep the user's copy untouched.
			continue
		} else if !os.IsNotExist(err) {
			if warnf != nil {
				warnf("games: seed %s: stat failed: %v", name, err)
			}
			continue
		}
		if err := copyGameDir(src, name, target); err != nil {
			_ = os.RemoveAll(target) // leave no half-copied game for a later run
			if warnf != nil {
				warnf("games: seed %s: copy failed: %v", name, err)
			}
			continue
		}
		seeded = append(seeded, name)
	}
	return seeded, nil
}

// copyGameDir recursively copies the directory name inside src to target,
// creating nested subdirectories and copying regular files 0600 → 0644.
func copyGameDir(src fs.FS, name, target string) error {
	return fs.WalkDir(src, name, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(name, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(target, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil // skip symlinks/devices/sockets
		}
		f, err := src.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, f); err != nil {
			out.Close()
			_ = os.Remove(dest)
			return err
		}
		if err := out.Close(); err != nil {
			_ = os.Remove(dest)
			return err
		}
		return os.Chmod(dest, 0o644)
	})
}
