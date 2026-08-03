//go:build windows

package fsutil

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// TestAtomicWrite_RenameFailsDirectWriteSucceeds_KeepsTmp verifies the
// direct-write fallback path of AtomicWrite on Windows: when the target file
// is open without FILE_SHARE_DELETE, os.Rename fails with a sharing violation
// while a direct write still succeeds. The .tmp crash-recovery copy must be
// KEPT after the fallback — it is only discarded by the next successful Load
// from path (a crash during the non-atomic direct write could otherwise
// corrupt path with no recovery source left).
func TestAtomicWrite_RenameFailsDirectWriteSucceeds_KeepsTmp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "locked.yaml")

	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// Open without FILE_SHARE_DELETE (blocks rename) but WITH FILE_SHARE_WRITE
	// (allows the direct-write fallback).
	h, err := windows.CreateFile(name,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile lock handle: %v", err)
	}
	defer windows.CloseHandle(h)

	newData := []byte("new\n")
	if err := AtomicWrite(path, newData, 0600); err != nil {
		t.Fatalf("AtomicWrite fallback should succeed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(newData) {
		t.Errorf("path content = %q, want %q (direct-write fallback)", got, newData)
	}

	tmpData, err := os.ReadFile(path + ".tmp")
	if err != nil {
		t.Fatalf(".tmp crash-recovery copy should be KEPT after direct-write fallback: %v", err)
	}
	if string(tmpData) != string(newData) {
		t.Errorf(".tmp content = %q, want %q", tmpData, newData)
	}
}
