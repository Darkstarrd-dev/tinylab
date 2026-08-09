package procutil

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ValidateExecutable canonicalizes a configured external-tool path and
// verifies it is safe to execute:
//
//   - the value must be an absolute path (relative values are rejected);
//   - it must contain no control characters;
//   - after symlink resolution it must be an existing regular file;
//   - on Windows the file must carry an executable extension
//     (.exe/.com/.bat/.cmd);
//   - on Unix/macOS the executable bit must be set;
//   - the file must not live in the OS temp directory or a directory
//     writable by other users, which would let a local attacker swap the
//     binary for an arbitrary program.
//
// The canonical absolute path is returned.
func ValidateExecutable(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("tool path is empty")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("tool path must be an absolute path, got: %s", path)
	}
	if strings.ContainsAny(path, "\x00\r\n\t") {
		return "", fmt.Errorf("tool path contains control characters")
	}
	canonical, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(canonical); err == nil {
		canonical = resolved
	}
	fi, err := os.Stat(canonical)
	if err != nil {
		return "", fmt.Errorf("tool not found at %s: %w", canonical, err)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("tool path is not a regular file: %s", canonical)
	}
	switch runtime.GOOS {
	case "windows":
		switch strings.ToLower(filepath.Ext(canonical)) {
		case ".exe", ".com", ".bat", ".cmd":
		default:
			return "", fmt.Errorf("tool file is not an executable (.exe/.com/.bat/.cmd): %s", canonical)
		}
	default:
		if fi.Mode().Perm()&0111 == 0 {
			return "", fmt.Errorf("tool file is not executable: %s", canonical)
		}
	}
	if err := rejectUntrustedLocation(canonical); err != nil {
		return "", err
	}
	return canonical, nil
}

// rejectUntrustedLocation rejects tools that live in the OS temp directory or
// in any directory writable by other users (world-writable dirs are a classic
// binary-swap vector).
func rejectUntrustedLocation(path string) error {
	if isUnderTempDir(filepath.Dir(path)) {
		return fmt.Errorf("tool path must not live in the temp directory: %s", path)
	}
	if runtime.GOOS == "windows" {
		// Windows has no meaningful mode bits; the temp check above is the
		// untrusted-location defense.
		return nil
	}
	for d := filepath.Dir(path); ; d = filepath.Dir(d) {
		fi, err := os.Stat(d)
		if err != nil {
			break
		}
		if fi.Mode().Perm()&0002 != 0 {
			return fmt.Errorf("tool path lives in a world-writable directory: %s", path)
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
	}
	return nil
}

func isUnderTempDir(path string) bool {
	tmp := os.TempDir()
	if resolved, err := filepath.EvalSymlinks(tmp); err == nil {
		tmp = resolved
	}
	tmp = filepath.Clean(tmp)
	p := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		t := strings.ToLower(tmp)
		pp := strings.ToLower(p)
		return pp == t || strings.HasPrefix(pp, t+string(filepath.Separator))
	}
	return p == tmp || strings.HasPrefix(p, tmp+string(filepath.Separator))
}
