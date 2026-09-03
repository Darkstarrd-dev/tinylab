package procutil

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// F-08: configured external-tool paths must be canonical regular executables
// in trusted locations. Relative paths, directories, missing files, temp-dir
// homes and world-writable homes are rejected.

func TestValidateExecutableRejects(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "tool.bin")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		path string
		want string // error substring
	}{
		{"empty", "", "empty"},
		{"relative", "ffmpeg", "absolute path"},
		{"control-char", dir + "\x00tool", "control"},
		{"missing", filepath.Join(dir, "nope.exe"), "not found"},
		{"directory", dir, "not a regular file"},
	}
	for _, c := range cases {
		if _, err := ValidateExecutable(c.path); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want error containing %q", c.name, err, c.want)
		}
	}

	// A regular file with no executable bit is rejected on Unix; on Windows
	// an extensionless file is rejected.
	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateExecutable(plain); err == nil {
		t.Error("non-executable plain file must be rejected")
	}
	// A file inside the OS temp directory is rejected on every platform.
	tempTool := filepath.Join(os.TempDir(), "tinylab-evil-tool"+extForTest())
	if err := os.WriteFile(tempTool, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tempTool)
	if _, err := ValidateExecutable(tempTool); err == nil || !strings.Contains(err.Error(), "temp") {
		t.Errorf("temp-dir tool: got %v, want temp-directory rejection", err)
	}
}

// extForTest returns an executable extension on Windows, "" elsewhere.
func extForTest() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

func TestValidateExecutableAccepts(t *testing.T) {
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cache, "tinylab-procutil-test")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tool := filepath.Join(dir, "tool"+extForTest())
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := ValidateExecutable(tool)
	if err != nil {
		t.Fatalf("executable tool rejected: %v", err)
	}
	if got != tool {
		t.Fatalf("expected canonical %s, got %s", tool, got)
	}
}
