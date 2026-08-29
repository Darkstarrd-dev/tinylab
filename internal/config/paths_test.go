package config

import (
	"path/filepath"
	"testing"
)

func TestResolveImageSaveDir(t *testing.T) {
	tests := []struct {
		name         string
		imageSaveDir string
		configDir    string
		want         string
	}{
		{
			name:         "empty imageSaveDir and empty configDir",
			imageSaveDir: "",
			configDir:    "",
			want:         "imgs",
		},
		{
			name:         "empty imageSaveDir with configDir",
			imageSaveDir: "",
			configDir:    "/app/config",
			want:         filepath.Join("/app/config", "imgs"),
		},
		{
			name:         "relative imageSaveDir with configDir",
			imageSaveDir: "custom_imgs",
			configDir:    "/app/config",
			want:         filepath.Join("/app/config", "custom_imgs"),
		},
		{
			name:         "absolute imageSaveDir",
			imageSaveDir: filepath.FromSlash("C:/data/images"),
			configDir:    filepath.FromSlash("C:/app/config"),
			want:         filepath.FromSlash("C:/data/images"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveImageSaveDir(tt.imageSaveDir, tt.configDir)
			if got != tt.want {
				t.Errorf("ResolveImageSaveDir(%q, %q) = %q; want %q", tt.imageSaveDir, tt.configDir, got, tt.want)
			}
		})
	}
}

func TestResolveDocDir(t *testing.T) {
	tests := []struct {
		name      string
		docDir    string
		configDir string
		want      string
	}{
		{
			name:      "empty docDir and empty configDir",
			docDir:    "",
			configDir: "",
			want:      "docs",
		},
		{
			name:      "empty docDir with configDir",
			docDir:    "",
			configDir: "/app/config",
			want:      filepath.Join("/app/config", "docs"),
		},
		{
			name:      "relative docDir with configDir",
			docDir:    "custom_docs",
			configDir: "/app/config",
			want:      filepath.Join("/app/config", "custom_docs"),
		},
		{
			name:      "absolute docDir",
			docDir:    filepath.FromSlash("C:/data/docs"),
			configDir: filepath.FromSlash("C:/app/config"),
			want:      filepath.FromSlash("C:/data/docs"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveDocDir(tt.docDir, tt.configDir)
			if got != tt.want {
				t.Errorf("ResolveDocDir(%q, %q) = %q; want %q", tt.docDir, tt.configDir, got, tt.want)
			}
		})
	}
}

func TestResolveGamesDir(t *testing.T) {
	tests := []struct {
		name      string
		gamesDir  string
		configDir string
		want      string
	}{
		{
			name:      "empty gamesDir and empty configDir",
			gamesDir:  "",
			configDir: "",
			want:      "games",
		},
		{
			name:      "empty gamesDir with configDir",
			gamesDir:  "",
			configDir: "/app/config",
			want:      filepath.Join("/app/config", "games"),
		},
		{
			name:      "relative gamesDir with configDir",
			gamesDir:  "custom_games",
			configDir: "/app/config",
			want:      filepath.Join("/app/config", "custom_games"),
		},
		{
			name:      "absolute gamesDir",
			gamesDir:  filepath.FromSlash("C:/data/games"),
			configDir: filepath.FromSlash("C:/app/config"),
			want:      filepath.FromSlash("C:/data/games"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveGamesDir(tt.gamesDir, tt.configDir)
			if got != tt.want {
				t.Errorf("ResolveGamesDir(%q, %q) = %q; want %q", tt.gamesDir, tt.configDir, got, tt.want)
			}
		})
	}
}
