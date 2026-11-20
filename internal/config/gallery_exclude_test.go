package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad_LegacyConfigWithoutGalleryExclude(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	legacyYAML := []byte("port: 20128\n")
	if err := os.WriteFile(path, legacyYAML, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load legacy config failed: %v", err)
	}
	if !cfg.GalleryExclude.Enabled {
		t.Errorf("GalleryExclude.Enabled = false, want true when section omitted")
	}
	if cfg.GalleryExclude.Scope != GalleryExcludeScopeTail {
		t.Errorf("GalleryExclude.Scope = %q, want %q", cfg.GalleryExclude.Scope, GalleryExcludeScopeTail)
	}
	if cfg.GalleryExclude.Count != DefaultGalleryExcludeCount {
		t.Errorf("GalleryExclude.Count = %d, want %d", cfg.GalleryExclude.Count, DefaultGalleryExcludeCount)
	}
}

func TestLoad_ExplicitGalleryExcludeDisabledPreserved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	raw := []byte("port: 20128\ngalleryExclude:\n  enabled: false\n")
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.GalleryExclude.Enabled {
		t.Errorf("GalleryExclude.Enabled = true, want false when explicitly disabled")
	}
	if cfg.GalleryExclude.Scope != GalleryExcludeScopeTail {
		t.Errorf("GalleryExclude.Scope = %q, want %q", cfg.GalleryExclude.Scope, GalleryExcludeScopeTail)
	}
	if cfg.GalleryExclude.Count != DefaultGalleryExcludeCount {
		t.Errorf("GalleryExclude.Count = %d, want %d", cfg.GalleryExclude.Count, DefaultGalleryExcludeCount)
	}
}

func TestLoad_InvalidGalleryExcludeValuesNormalized(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	raw := []byte("port: 20128\ngalleryExclude:\n  enabled: true\n  scope: weird\n  count: -3\n")
	if err := os.WriteFile(path, raw, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if cfg.GalleryExclude.Scope != GalleryExcludeScopeTail {
		t.Errorf("GalleryExclude.Scope = %q, want %q", cfg.GalleryExclude.Scope, GalleryExcludeScopeTail)
	}
	if cfg.GalleryExclude.Count != DefaultGalleryExcludeCount {
		t.Errorf("GalleryExclude.Count = %d, want %d", cfg.GalleryExclude.Count, DefaultGalleryExcludeCount)
	}
}

func TestGalleryExclude_SaveLoadRoundTrip(t *testing.T) {
	cases := []GalleryExcludeConfig{
		{Enabled: false, Scope: GalleryExcludeScopeHead, Count: 5},
		{Enabled: true, Scope: GalleryExcludeScopeAll, Count: 10},
	}
	for _, want := range cases {
		path := filepath.Join(t.TempDir(), "config.yaml")
		cfg := DefaultConfig()
		cfg.GalleryExclude = want
		if err := Save(path, cfg); err != nil {
			t.Fatalf("Save: %v", err)
		}
		loaded, err := Load(path)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if loaded.GalleryExclude != want {
			t.Errorf("round-trip got %+v, want %+v", loaded.GalleryExclude, want)
		}
	}
}
