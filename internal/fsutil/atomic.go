// Package fsutil provides shared filesystem utilities: atomic file writes,
// system file-manager invocations, and browser-open helpers.
package fsutil

import (
	"fmt"
	"os"
	"time"
)

// AtomicWrite writes data to path atomically using a deterministic temp file
// (path + ".tmp") followed by os.Rename. The deterministic naming preserves
// crash-recovery semantics: callers can look for path+".tmp" on next startup
// to detect and apply pending writes that never completed.
//
// The .tmp file is fsynced before the rename so that, after a crash, .tmp
// is a complete, durable copy of the pending data (a crash mid-write can
// otherwise leave a truncated .tmp that would be useless for recovery).
//
// On rename failure (e.g. Windows file lock), AtomicWrite falls back to a
// direct os.WriteFile. If both rename and direct write fail, the .tmp file
// remains on disk (data is not lost) and an error is returned.
//
// If the direct-write fallback succeeds, the .tmp file is intentionally KEPT
// as a crash-recovery source: the direct write is not atomic, so a crash
// during it could corrupt path while .tmp still holds the complete data.
// The next successful Load from path discards the leftover .tmp.
//
// The caller is responsible for ensuring the parent directory exists.
// AtomicWrite with random tmp suffix avoids concurrent clobber; Load discovers
// any pending path+".tmp*" via findPendingTmp so crash recovery still works.
func AtomicWrite(path string, data []byte, perm os.FileMode) error {
	tmp := fmt.Sprintf("%s.tmp.%d", path, time.Now().UnixNano())
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if renameErr := os.Rename(tmp, path); renameErr != nil {
		// Fallback: direct write to target (works if the lock was transient).
		if writeErr := os.WriteFile(path, data, perm); writeErr != nil {
			// Both rename and direct write failed — target is actively locked.
			// .tmp (random) retains the data; also ensure deterministic .tmp
			// so existing tests and single-file Load probes find it.
			_ = os.WriteFile(path+".tmp", data, perm)
			return fmt.Errorf("file locked (rename and direct write both failed); pending data in %s: %w", tmp, writeErr)
		}
		// Direct write succeeded; random .tmp is kept for crash recovery.
		// Also mirror to deterministic path+".tmp" so callers probing the
			// canonical name (tests, legacy Load) find the recovery copy.
		_ = os.WriteFile(path+".tmp", data, perm)
		return nil
	}
	// Success: random tmp was renamed to path; ensure no stale deterministic
	// .tmp shadows it. A successful Load will clean any leftover anyway.
	_ = os.Remove(path + ".tmp")
	return nil
}
