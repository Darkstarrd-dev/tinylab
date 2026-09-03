package archivetool

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// toolTestDir returns a private, non-temp directory for test tool binaries:
// procutil.ValidateExecutable rejects tool paths inside the OS temp dir or
// world-writable directories (binary-swap defense), so valid fakes must live
// elsewhere. The dir is removed when the test finishes.
func toolTestDir(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := filepath.Join(cwd, ".testbin-"+strconv.Itoa(os.Getpid())+"-"+strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ' ' {
			return '_'
		}
		return r
	}, t.Name()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir testbin: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// writeTool writes a fake tool executable into dir with the given name and
// returns its absolute path.
func writeTool(t *testing.T, dir, name string) string {
	t.Helper()
	content := "fake tool"
	if runtime.GOOS == "windows" {
		content = "@echo off\r\necho fake\r\n"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write tool %s: %v", name, err)
	}
	return path
}

func TestValidateTool_MissingPath(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	_, err := r.validateTool(filepath.Join(toolTestDir(t), "no-such-7z.exe"))
	if err == nil {
		t.Fatal("missing tool must be rejected")
	}
	var te *ToolError
	if !asToolError(err, &te) || te.Kind != ErrToolMissing {
		t.Fatalf("expected ErrToolMissing, got %v", err)
	}
}

func TestValidateTool_DirectoryRejected(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	dir := toolTestDir(t)
	_, err := r.validateTool(dir)
	if err == nil {
		t.Fatal("directory must be rejected as a tool path")
	}
}

func TestValidateTool_TempDirRejected(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	name := "fake-tool"
	if runtime.GOOS == "windows" {
		name += ".bat"
	}
	path := writeTool(t, t.TempDir(), name) // inside the OS temp dir
	_, err := r.validateTool(path)
	if err == nil || !strings.Contains(err.Error(), "temp directory") {
		t.Fatalf("temp-dir tool must be rejected with a temp-directory diagnostic, got %v", err)
	}
}

func TestValidateTool_ControlCharsRejected(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	path := filepath.Join(toolTestDir(t), "7z\x00x.exe")
	_, err := r.validateTool(path)
	if err == nil || !strings.Contains(err.Error(), "control characters") {
		t.Fatalf("control-char path must be rejected, got %v", err)
	}
}

func TestValidateTool_ValidExecutable(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	name := "7z"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := writeTool(t, toolTestDir(t), name)
	got, err := r.validateTool(path)
	if err != nil {
		t.Fatalf("valid tool rejected: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("validateTool must return an absolute path, got %q", got)
	}
	if filepath.Clean(got) != filepath.Clean(path) {
		t.Fatalf("validateTool = %q, want %q", got, path)
	}
}

func TestValidateTool_RelativeResolvesViaAbs(t *testing.T) {
	r := NewResolver(config.ArchiveConfig{})
	name := "7z"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := writeTool(t, toolTestDir(t), name)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.validateTool(rel)
	if err != nil {
		t.Fatalf("relative tool rejected: %v", err)
	}
	if filepath.Clean(got) != filepath.Clean(path) {
		t.Fatalf("validateTool(rel) = %q, want %q", got, path)
	}
}

func TestValidateTool_WorldWritableRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no meaningful mode bits; the temp check is the untrusted-location defense")
	}
	r := NewResolver(config.ArchiveConfig{})
	dir := toolTestDir(t)
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	path := writeTool(t, dir, "7z")
	_, err := r.validateTool(path)
	if err == nil || !strings.Contains(err.Error(), "world-writable") {
		t.Fatalf("world-writable tool must be rejected, got %v", err)
	}
}

// asToolError unwraps err into te and reports whether it is a *ToolError.
func asToolError(err error, te **ToolError) bool {
	for err != nil {
		if e, ok := err.(*ToolError); ok {
			*te = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
