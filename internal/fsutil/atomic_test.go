package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWrite_Normal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")
	data := []byte("hello: world\n")

	if err := AtomicWrite(path, data, 0600); err != nil {
		t.Fatalf("AtomicWrite failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if string(got) != string(data) {
		t.Errorf("content mismatch: got %q, want %q", got, data)
	}

	// .tmp should not exist after successful write
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf(".tmp file should not exist after successful write")
	}
}

func TestAtomicWrite_Overwrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")

	if err := AtomicWrite(path, []byte("first"), 0600); err != nil {
		t.Fatalf("first write failed: %v", err)
	}
	if err := AtomicWrite(path, []byte("second"), 0600); err != nil {
		t.Fatalf("second write failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if string(got) != "second" {
		t.Errorf("content mismatch: got %q, want %q", got, "second")
	}
}

func TestAtomicWrite_Permission(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.yaml")
	data := []byte("key: value\n")

	if err := AtomicWrite(path, data, 0600); err != nil {
		t.Fatalf("AtomicWrite failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	// On Windows, permissions are not enforced the same way, so only check on Unix.
	if os.PathSeparator == '/' {
		if info.Mode().Perm() != 0600 {
			t.Errorf("permission mismatch: got %o, want 0600", info.Mode().Perm())
		}
	}
}

func TestAtomicWrite_NonexistentDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nonexistent", "test.yaml")
	err := AtomicWrite(path, []byte("data"), 0600)
	if err == nil {
		t.Fatal("expected error for nonexistent directory")
	}
}

func TestAtomicWrite_EmptyData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.yaml")

	if err := AtomicWrite(path, []byte{}, 0644); err != nil {
		t.Fatalf("AtomicWrite with empty data failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty file, got %q", got)
	}
}

// TestAtomicWrite_RenameFallbackKeepsTmp verifies that when the rename AND
// the direct-write fallback both fail (here: path is a directory), AtomicWrite
// returns an error and leaves the .tmp crash-recovery copy with the exact
// pending data — the caller can apply it on the next startup via Load.
func TestAtomicWrite_RenameFallbackKeepsTmp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target") // a directory: rename and write both fail
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	data := []byte("pending: data\n")

	err := AtomicWrite(path, data, 0600)
	if err == nil {
		t.Fatal("AtomicWrite should fail when both rename and direct write fail")
	}

	got, readErr := os.ReadFile(path + ".tmp")
	if readErr != nil {
		t.Fatalf(".tmp crash-recovery copy missing after failed write: %v", readErr)
	}
	if string(got) != string(data) {
		t.Errorf(".tmp content mismatch: got %q, want %q", got, data)
	}
}
