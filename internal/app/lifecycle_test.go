//go:build !tray

package app

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/console"
)

func TestVersion(t *testing.T) {
	if Version == "" {
		t.Fatal("Version should not be empty")
	}
	// Verify it looks like a semver (digits.digits.digits)
	if !regexp.MustCompile(`^\d+\.\d+\.\d+`).MatchString(Version) {
		t.Fatalf("Version %q doesn't look like semver", Version)
	}
}

func TestShutdown_CleansUpLockFile(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, ".test.lock")
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("failed to create lock file: %v", err)
	}

	a := &App{
		lockFile: lockFile,
		lockPath: lockPath,
		logger:   console.New(100),
	}

	if err := a.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Errorf("lock file should be removed after shutdown, got err=%v", err)
	}
}

func TestTryLockFile_DoubleAcquisitionFails(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, ".test.lock")

	f1, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("open f1: %v", err)
	}
	defer f1.Close()

	if err := tryLockFile(f1); err != nil {
		t.Fatalf("first lock should succeed: %v", err)
	}

	f2, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("open f2: %v", err)
	}
	defer f2.Close()

	if err := tryLockFile(f2); err == nil {
		t.Error("second lock should fail, but it succeeded")
	}
}
