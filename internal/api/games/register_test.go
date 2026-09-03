package games

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
)

// setupGameRouter builds a Handler over a temp config dir, with GamesDir
// pointing at gamesRoot. It returns the mux and the config dir (parent of the
// auto-created gamedata dir).
func setupGameRouter(t *testing.T, gamesRoot string) (*chi.Mux, string) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.GamesDir = gamesRoot
	configDir := t.TempDir()
	reg := registry.New(cfg)
	deps := &apibase.Deps{
		Reg:        reg,
		ConfigPath: filepath.Join(configDir, "config.yaml"),
		Logger:     console.New(100),
	}
	h := NewHandler(deps)
	r := chi.NewRouter()
	r.Route("/api/games", func(sub chi.Router) { h.Register(sub) })
	return r, configDir
}

// writeGame creates a game directory with the given game.json content plus
// optional entry files (each entry is written as an empty file).
func writeGame(t *testing.T, gamesRoot, id, manifest string, entries ...string) {
	t.Helper()
	dir := filepath.Join(gamesRoot, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "game.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		p := filepath.Join(dir, entry)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("// "+id), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func getGames(t *testing.T, r *chi.Mux) []map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/games", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/games: expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Games []map[string]any `json:"games"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	return resp.Games
}

func TestListGames_Empty(t *testing.T) {
	r, _ := setupGameRouter(t, filepath.Join(t.TempDir(), "games"))
	games := getGames(t, r)
	if len(games) != 0 {
		t.Fatalf("expected empty games list, got %v", games)
	}
}

func TestListGames_Valid(t *testing.T) {
	gamesRoot := filepath.Join(t.TempDir(), "games")
	r, _ := setupGameRouter(t, gamesRoot)
	writeGame(t, gamesRoot, "demo",
		`{"id":"demo","title":"Demo Game","version":"1.2.0","entry":"main.js"}`,
		"main.js")
	writeGame(t, gamesRoot, "other",
		`{"id":"other","title":"Other","version":"0.1","entry":"js/main.js"}`,
		"js/main.js")

	games := getGames(t, r)
	if len(games) != 2 {
		t.Fatalf("expected 2 games, got %d: %v", len(games), games)
	}
	byID := map[string]map[string]any{}
	for _, g := range games {
		byID[g["id"].(string)] = g
	}
	demo, ok := byID["demo"]
	if !ok {
		t.Fatalf("missing demo game: %v", games)
	}
	if demo["title"] != "Demo Game" || demo["version"] != "1.2.0" || demo["entry"] != "main.js" {
		t.Errorf("unexpected manifest fields: %v", demo)
	}
	if v, ok := demo["v"].(float64); !ok || v <= 0 {
		t.Errorf("expected v > 0, got %v", demo["v"])
	}
	other, ok := byID["other"]
	if !ok {
		t.Fatalf("missing other game: %v", games)
	}
	if other["entry"] != "js/main.js" {
		t.Errorf("nested entry not preserved: %v", other["entry"])
	}
}

func TestListGames_SkipsInvalid(t *testing.T) {
	gamesRoot := filepath.Join(t.TempDir(), "games")
	r, _ := setupGameRouter(t, gamesRoot)
	// game.json present but id mismatches the directory name.
	writeGame(t, gamesRoot, "mismatch",
		`{"id":"someother","title":"Mismatch","version":"1","entry":"main.js"}`, "main.js")
	// game.json valid but the entry file does not exist.
	writeGame(t, gamesRoot, "noentry",
		`{"id":"noentry","title":"No Entry","version":"1","entry":"missing.js"}`)
	// No game.json at all.
	writeGame(t, gamesRoot, "nomanifest", `{}`)

	games := getGames(t, r)
	if len(games) != 0 {
		t.Fatalf("expected 0 games (all invalid skipped), got %d: %v", len(games), games)
	}
}

func TestListGames_MixedValidInvalid(t *testing.T) {
	gamesRoot := filepath.Join(t.TempDir(), "games")
	r, _ := setupGameRouter(t, gamesRoot)
	writeGame(t, gamesRoot, "good",
		`{"id":"good","title":"Good","version":"1","entry":"main.js"}`, "main.js")
	writeGame(t, gamesRoot, "mismatch",
		`{"id":"someother","title":"Mismatch","version":"1","entry":"main.js"}`, "main.js")

	games := getGames(t, r)
	if len(games) != 1 || games[0]["id"] != "good" {
		t.Fatalf("expected only the valid game, got %v", games)
	}
}

func TestState(t *testing.T) {
	r, configDir := setupGameRouter(t, filepath.Join(t.TempDir(), "games"))

	// GET before any save → 404.
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/games/demo/state", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing state, got %d: %s", rr.Code, rr.Body.String())
	}

	// PUT a valid JSON state.
	state := []byte(`{"hp":100,"kills":3,"over":false}`)
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodPut, "/api/games/demo/state",
		strings.NewReader(string(state))))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on PUT, got %d: %s", rr.Code, rr.Body.String())
	}
	var okResp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &okResp); err != nil {
		t.Fatalf("invalid PUT response: %v", err)
	}
	if okResp["ok"] != true {
		t.Fatalf("expected ok:true, got %v", okResp)
	}

	// File is on disk, byte-identical, in {configDir}/gamedata.
	statePath := filepath.Join(configDir, "gamedata", "demo.json")
	onDisk, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	if string(onDisk) != string(state) {
		t.Fatalf("state file mismatch: got %q want %q", onDisk, state)
	}

	// GET returns the exact bytes with application/json.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/games/demo/state", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on GET, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("expected application/json content type, got %q", ct)
	}
	if rr.Body.String() != string(state) {
		t.Errorf("GET returned %q, want %q", rr.Body.String(), state)
	}

	// PUT invalid JSON → 400.
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodPut, "/api/games/demo/state",
		strings.NewReader("not json")))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON, got %d: %s", rr.Code, rr.Body.String())
	}
}

// callStateHandler drives getState/putState directly with a chi route context
// so the id validation guard (including path-unfriendly ids that chi's
// {id} pattern would never route to) is exercised.
func callStateHandler(h *Handler, method, id, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/games/x/state", strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	if method == http.MethodGet {
		h.getState(rr, req)
	} else {
		h.putState(rr, req)
	}
	return rr
}

func TestStateIDValidation(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.GamesDir = filepath.Join(t.TempDir(), "games")
	configDir := t.TempDir()
	deps := &apibase.Deps{
		Reg:        registry.New(cfg),
		ConfigPath: filepath.Join(configDir, "config.yaml"),
		Logger:     console.New(100),
	}
	h := NewHandler(deps)

	for _, id := range []string{"a/../b", "a/b", "..", "sp ace", "x" + strings.Repeat("y", 64)} {
		rr := callStateHandler(h, http.MethodGet, id, "")
		if rr.Code != http.StatusBadRequest {
			t.Errorf("GET id %q: expected 400, got %d", id, rr.Code)
		}
		rr = callStateHandler(h, http.MethodPut, id, `{"a":1}`)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("PUT id %q: expected 400, got %d", id, rr.Code)
		}
	}

	// A valid id still works through the guard.
	rr := callStateHandler(h, http.MethodPut, "demo_ok-1", `{"a":1}`)
	if rr.Code != http.StatusOK {
		t.Errorf("valid id: expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestSeedGames(t *testing.T) {
	src := fstest.MapFS{
		"alpha/game.json":    &fstest.MapFile{Data: []byte(`{"id":"alpha","title":"Alpha","version":"1","entry":"main.js"}`)},
		"alpha/main.js":      &fstest.MapFile{Data: []byte("console.log('alpha')")},
		"alpha/audio/t.wav":  &fstest.MapFile{Data: []byte("WAV")},
		"beta/game.json":     &fstest.MapFile{Data: []byte(`{"id":"beta","title":"Beta","version":"1","entry":"src/run.js"}`)},
		"beta/src/run.js":    &fstest.MapFile{Data: []byte("console.log('beta')")},
		"readme.txt":         &fstest.MapFile{Data: []byte("not a game")},
	}
	gamesDir := filepath.Join(t.TempDir(), "games")
	if err := os.MkdirAll(gamesDir, 0o755); err != nil {
		t.Fatal(err)
	}

	seeded, err := SeedGames(src, gamesDir, nil)
	if err != nil {
		t.Fatalf("SeedGames failed: %v", err)
	}
	if len(seeded) != 2 || seeded[0] != "alpha" || seeded[1] != "beta" {
		t.Fatalf("expected [alpha beta], got %v", seeded)
	}

	checks := []struct {
		rel, want string
	}{
		{"alpha/main.js", "console.log('alpha')"},
		{"alpha/audio/t.wav", "WAV"},
		{"beta/src/run.js", "console.log('beta')"},
	}
	for _, c := range checks {
		got, err := os.ReadFile(filepath.Join(gamesDir, c.rel))
		if err != nil {
			t.Fatalf("missing copied file %s: %v", c.rel, err)
		}
		if string(got) != c.want {
			t.Errorf("%s: got %q want %q", c.rel, got, c.want)
		}
	}
	// Files land 0644 (0600 → 0644 during copy).
	info, err := os.Stat(filepath.Join(gamesDir, "alpha", "main.js"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows only honors the read-only bit in Chmod, so accept the
	// creation-time default 0666 there.
	if perm := info.Mode().Perm(); perm != 0o644 && runtime.GOOS != "windows" {
		t.Errorf("expected 0644 perm, got %o", perm)
	}
	// Top-level non-directory entries are not games and are ignored.
	if _, err := os.Stat(filepath.Join(gamesDir, "readme.txt")); !os.IsNotExist(err) {
		t.Errorf("readme.txt should not have been copied, stat err = %v", err)
	}
}

func TestSeedGames_SkipsExisting(t *testing.T) {
	src := fstest.MapFS{
		"exist/game.json": &fstest.MapFile{Data: []byte(`{"id":"exist","title":"Exist","version":"1","entry":"main.js"}`)},
		"exist/main.js":   &fstest.MapFile{Data: []byte("fresh copy")},
	}
	gamesDir := filepath.Join(t.TempDir(), "games")
	if err := os.MkdirAll(filepath.Join(gamesDir, "exist"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-exist the game directory with different content the seed must keep.
	if err := os.WriteFile(filepath.Join(gamesDir, "exist", "main.js"), []byte("user edited"), 0o644); err != nil {
		t.Fatal(err)
	}

	seeded, err := SeedGames(src, gamesDir, nil)
	if err != nil {
		t.Fatalf("SeedGames failed: %v", err)
	}
	if len(seeded) != 0 {
		t.Fatalf("expected nothing seeded, got %v", seeded)
	}
	got, err := os.ReadFile(filepath.Join(gamesDir, "exist", "main.js"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "user edited" {
		t.Errorf("existing game was overwritten: got %q", got)
	}
	if _, err := os.Stat(filepath.Join(gamesDir, "exist", "game.json")); !os.IsNotExist(err) {
		t.Errorf("game.json should not have been added to a skipped dir, stat err = %v", err)
	}
}