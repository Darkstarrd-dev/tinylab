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
