package settings

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/config"
)

// TestRotationPatchPreservesStatePersist guards the audit fix for the
// rotation PATCH endpoint: a partial rotation update (the 5 frontend-managed
// fields strategy/stickyLimit/maxRetries/retryDelaySec/backoffMaxSec) must
// never wipe RotationConfig.StatePersist/StatePath, which gate the
// state.Manager persistence layer (internal/app/app.go).
func TestRotationPatchPreservesStatePersist(t *testing.T) {
	var updates struct {
		Rotation *rotationPatch `json:"rotation"`
	}
	payload := `{"rotation":{"strategy":"failover","stickyLimit":5,"maxRetries":3,"retryDelaySec":5,"backoffMaxSec":300}}`
	if err := json.Unmarshal([]byte(payload), &updates); err != nil {
		t.Fatalf("decode PATCH payload: %v", err)
	}
	if updates.Rotation == nil {
		t.Fatal("rotation patch not decoded")
	}

	cfg := config.DefaultConfig()
	cfg.Rotation.StatePersist = true
	cfg.Rotation.StatePath = "state.yaml"

	applyRotationUpdates(cfg, updates.Rotation)

	if cfg.Rotation.Strategy != "failover" {
		t.Errorf("Strategy = %q, want failover", cfg.Rotation.Strategy)
	}
	if cfg.Rotation.StickyLimit != 5 || cfg.Rotation.MaxRetries != 3 ||
		cfg.Rotation.RetryDelaySec != 5 || cfg.Rotation.BackoffMaxSec != 300 {
		t.Errorf("rotation fields not applied: %+v", cfg.Rotation)
	}
	if !cfg.Rotation.StatePersist {
		t.Error("StatePersist was wiped by rotation PATCH")
	}
	if cfg.Rotation.StatePath != "state.yaml" {
		t.Errorf("StatePath = %q, want state.yaml (wiped by rotation PATCH)", cfg.Rotation.StatePath)
	}

	// Persistence round-trip: Save must keep StatePersist/StatePath on disk.
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.Rotation.StatePersist {
		t.Error("StatePersist lost after Save/Load round-trip")
	}
	if loaded.Rotation.StatePath != "state.yaml" {
		t.Errorf("StatePath = %q after round-trip, want state.yaml", loaded.Rotation.StatePath)
	}
}

// TestRotationPatchPartialUpdate verifies a single-field patch leaves the
// other rotation fields (and StatePersist) at their existing values.
func TestRotationPatchPartialUpdate(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Rotation.Strategy = "sticky"
	cfg.Rotation.StickyLimit = 42
	cfg.Rotation.StatePersist = true

	applyRotationUpdates(cfg, &rotationPatch{Strategy: strPtr("round-robin")})

	if cfg.Rotation.Strategy != "round-robin" {
		t.Errorf("Strategy = %q, want round-robin", cfg.Rotation.Strategy)
	}
	if cfg.Rotation.StickyLimit != 42 {
		t.Errorf("StickyLimit = %d, want 42 (untouched)", cfg.Rotation.StickyLimit)
	}
	if !cfg.Rotation.StatePersist {
		t.Error("StatePersist wiped by single-field patch")
	}
}

// TestThemePatchPersistsStyle verifies that a partial theme PATCH updates the
// style dimension without wiping the other persisted theme preferences.
func TestThemePatchPersistsStyle(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Theme.DarkVariant = "dracula"
	cfg.Theme.LightVariant = "cream"
	cfg.Theme.Style = "default"

	applyThemeUpdates(cfg, &config.ThemeConfig{Style: "soft"})

	if cfg.Theme.Style != "soft" {
		t.Errorf("Style = %q, want soft", cfg.Theme.Style)
	}
	if cfg.Theme.DarkVariant != "dracula" {
		t.Errorf("DarkVariant = %q, want dracula", cfg.Theme.DarkVariant)
	}
	if cfg.Theme.LightVariant != "cream" {
		t.Errorf("LightVariant = %q, want cream", cfg.Theme.LightVariant)
	}
}

func strPtr(s string) *string { return &s }

// TestArchivePatchPresenceAware verifies the archive settings PATCH contract:
// partial updates leave untouched fields at their existing values, an explicit
// empty string clears a field back to zero (environment/PATH resolution), and
// Save/Load round-trips the archive block.
func TestArchivePatchPresenceAware(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Download.YtDlpPath = "/keep/yt-dlp"
	cfg.Trace.RetainDays = 9
	cfg.Archive.SevenZipPath = "/keep/7z"
	cfg.Archive.TempDir = "/keep/tmp"

	// Partial patch: only rarPath sent. Other archive fields (and unrelated
	// config sections) must survive untouched.
	var partial struct {
		Archive *archivePatch `json:"archive"`
	}
	if err := json.Unmarshal([]byte(`{"archive":{"rarPath":"C:\\tools\\unrar.exe"}}`), &partial); err != nil {
		t.Fatalf("decode partial archive patch: %v", err)
	}
	applyArchiveUpdates(cfg, partial.Archive)
	if cfg.Archive.RarPath != `C:\tools\unrar.exe` {
		t.Errorf("RarPath = %q, want C:\\tools\\unrar.exe", cfg.Archive.RarPath)
	}
	if cfg.Archive.SevenZipPath != "/keep/7z" {
		t.Errorf("SevenZipPath = %q, want /keep/7z (wiped by partial patch)", cfg.Archive.SevenZipPath)
	}
	if cfg.Archive.TempDir != "/keep/tmp" {
		t.Errorf("TempDir = %q, want /keep/tmp (wiped by partial patch)", cfg.Archive.TempDir)
	}
	if cfg.Download.YtDlpPath != "/keep/yt-dlp" || cfg.Trace.RetainDays != 9 {
		t.Error("unrelated config sections wiped by archive patch")
	}

	// Explicit clear: empty string resets the field to zero value.
	var clear struct {
		Archive *archivePatch `json:"archive"`
	}
	if err := json.Unmarshal([]byte(`{"archive":{"sevenZipPath":""}}`), &clear); err != nil {
		t.Fatalf("decode clear archive patch: %v", err)
	}
	applyArchiveUpdates(cfg, clear.Archive)
	if cfg.Archive.SevenZipPath != "" {
		t.Errorf("SevenZipPath = %q after explicit clear, want empty", cfg.Archive.SevenZipPath)
	}
	if cfg.Archive.RarPath != `C:\tools\unrar.exe` {
		t.Errorf("RarPath = %q, want preserved after clearing sevenZipPath", cfg.Archive.RarPath)
	}

	// Persistence round-trip keeps the archive block on disk.
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Archive.RarPath != `C:\tools\unrar.exe` {
		t.Errorf("RarPath = %q after round-trip, want C:\\tools\\unrar.exe", loaded.Archive.RarPath)
	}
	if loaded.Archive.TempDir != "/keep/tmp" {
		t.Errorf("TempDir = %q after round-trip, want /keep/tmp", loaded.Archive.TempDir)
	}
}

// TestArchivePatchNilLeavesConfig verifies a nil archive block in a PATCH
// payload never touches cfg.Archive.
func TestArchivePatchNilLeavesConfig(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Archive.SevenZipPath = "/keep/7z"
	applyArchiveUpdates(cfg, nil)
	if cfg.Archive.SevenZipPath != "/keep/7z" {
		t.Errorf("SevenZipPath = %q, want /keep/7z (nil patch mutated config)", cfg.Archive.SevenZipPath)
	}
}

// TestAssistantPatchModelAndActions verifies the presence-aware assistant
// patch: the model alone can change without touching actions, actions are
// replaced wholesale when sent, and the block survives a Save/Load round-trip.
func TestAssistantPatchModelAndActions(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Assistant.Model = "openai/old"
	cfg.Assistant.Actions = []config.AssistantAction{
		{Name: "idle", SpritesheetPath: "/keep/idle.png", Cols: 4, Rows: 2, FrameStart: 0, FrameEnd: 7, Fps: 8},
	}

	// Model-only patch must not touch the action list.
	var modelOnly struct {
		Assistant *assistantPatch `json:"assistant"`
	}
	if err := json.Unmarshal([]byte(`{"assistant":{"model":"openai/new"}}`), &modelOnly); err != nil {
		t.Fatalf("decode model-only patch: %v", err)
	}
	applyAssistantUpdates(cfg, modelOnly.Assistant)
	if cfg.Assistant.Model != "openai/new" {
		t.Errorf("Model = %q, want openai/new", cfg.Assistant.Model)
	}
	if len(cfg.Assistant.Actions) != 1 || cfg.Assistant.Actions[0].Name != "idle" {
		t.Errorf("actions mutated by model-only patch: %+v", cfg.Assistant.Actions)
	}

	// Actions patch replaces the list wholesale.
	var withActions struct {
		Assistant *assistantPatch `json:"assistant"`
	}
	if err := json.Unmarshal([]byte(`{"assistant":{"actions":[{"name":"walk","spritesheetPath":"C:\\s\\w.png","cols":3,"rows":3,"frameStart":2,"frameEnd":5,"fps":10}]}}`), &withActions); err != nil {
		t.Fatalf("decode actions patch: %v", err)
	}
	applyAssistantUpdates(cfg, withActions.Assistant)
	if len(cfg.Assistant.Actions) != 1 || cfg.Assistant.Actions[0].Name != "walk" {
		t.Fatalf("actions = %+v, want single walk action", cfg.Assistant.Actions)
	}
	a := cfg.Assistant.Actions[0]
	if a.SpritesheetPath != `C:\s\w.png` || a.Cols != 3 || a.Rows != 3 || a.FrameStart != 2 || a.FrameEnd != 5 || a.Fps != 10 {
		t.Errorf("walk action fields wrong after patch: %+v", a)
	}

	// Persistence round-trip keeps the actions block on disk.
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Assistant.Model != "openai/new" || len(loaded.Assistant.Actions) != 1 || loaded.Assistant.Actions[0].Fps != 10 {
		t.Errorf("assistant block lost in round-trip: %+v", loaded.Assistant)
	}
}

func TestGalleryExcludeSettingsGetAndPartialPatch(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.GalleryExclude = config.GalleryExcludeConfig{
		Enabled: true,
		Scope:   config.GalleryExcludeScopeHead,
		Count:   7,
	}
	d := buildConvergeDeps(t, cfg)
	if err := config.Save(d.ConfigPath, cfg); err != nil {
		t.Fatalf("Save initial config: %v", err)
	}

	h := NewHandler(d)
	r := chi.NewRouter()
	h.Register(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 1. GET /settings exposes galleryExclude.
	getResp, err := http.Get(srv.URL + "/settings")
	if err != nil {
		t.Fatalf("GET /settings: %v", err)
	}
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /settings status = %d, want 200", getResp.StatusCode)
	}
	var gotSettings struct {
		GalleryExclude config.GalleryExcludeConfig `json:"galleryExclude"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&gotSettings); err != nil {
		t.Fatalf("decode GET /settings: %v", err)
	}
	if gotSettings.GalleryExclude != cfg.GalleryExclude {
		t.Fatalf("GET galleryExclude = %+v, want %+v", gotSettings.GalleryExclude, cfg.GalleryExclude)
	}

	// 2. Partial PATCH toggling enabled=false preserves scope & count.
	patchReq, _ := http.NewRequest(http.MethodPatch, srv.URL+"/settings", bytes.NewBufferString(`{"galleryExclude":{"enabled":false}}`))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatalf("PATCH /settings: %v", err)
	}
	patchResp.Body.Close()
	if patchResp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /settings status = %d, want 200", patchResp.StatusCode)
	}
	cur := d.Reg.Config().GalleryExclude
	if cur.Enabled || cur.Scope != config.GalleryExcludeScopeHead || cur.Count != 7 {
		t.Fatalf("after partial PATCH got %+v, want {Enabled:false Scope:head Count:7}", cur)
	}

	// 3. Invalid scope and count return 400.
	for _, body := range []string{
		`{"galleryExclude":{"scope":"middle"}}`,
		`{"galleryExclude":{"count":0}}`,
		`{"galleryExclude":{"count":100001}}`,
	} {
		badReq, _ := http.NewRequest(http.MethodPatch, srv.URL+"/settings", bytes.NewBufferString(body))
		badReq.Header.Set("Content-Type", "application/json")
		badResp, err := http.DefaultClient.Do(badReq)
		if err != nil {
			t.Fatalf("bad PATCH: %v", err)
		}
		badResp.Body.Close()
		if badResp.StatusCode != http.StatusBadRequest {
			t.Errorf("PATCH %s status = %d, want 400", body, badResp.StatusCode)
		}
	}
}
