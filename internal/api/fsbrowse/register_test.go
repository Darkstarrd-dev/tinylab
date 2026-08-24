package fsbrowse

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveBrowseInitialDir covers the initial-directory resolution logic.
// The actual native picker dialog can only be exercised interactively on
// Windows, so the HTTP handler itself is compile-level covered only.
func TestResolveBrowseInitialDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := resolveBrowseInitialDir("", "file"); got != "" {
		t.Errorf("empty input: got %q, want empty", got)
	}
	if got := resolveBrowseInitialDir(dir, "directory"); got != dir {
		t.Errorf("dir input: got %q, want %q", got, dir)
	}
	if got := resolveBrowseInitialDir(file, "file"); got != dir {
		t.Errorf("file input: got %q, want parent %q", got, dir)
	}
	missing := filepath.Join(dir, "nested", "sub")
	if got := resolveBrowseInitialDir(missing, "directory"); got != missing {
		t.Errorf("missing path: got %q, want %q", got, missing)
	}
	if _, err := os.Stat(missing); err != nil {
		t.Errorf("missing path was not created: %v", err)
	}
}
