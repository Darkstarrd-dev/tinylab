package fsutil

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PathGuard verifies that target is inside root using canonical Abs+Clean+HasPrefix.
// It returns the cleaned absolute target or an error if outside.
func PathGuard(root, target string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	cleanRoot := filepath.Clean(absRoot)
	cleanTarget := filepath.Clean(absTarget)
	if cleanTarget == cleanRoot {
		return cleanTarget, nil
	}
	if !strings.HasPrefix(cleanTarget, cleanRoot+string(os.PathSeparator)) {
		return "", fmt.Errorf("path outside allowed root: %s", target)
	}
	return cleanTarget, nil
}
