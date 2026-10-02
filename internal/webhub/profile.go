package webhub

import (
	"path/filepath"
)

// ResolveProfileDir resolves the persistent browser profile directory webhub
// launches Chrome with. An empty dir falls back to {configDir}/webhub/profile
// (or "webhub/profile" when configDir is empty); a relative path is joined
// with configDir; an absolute path is used verbatim.
//
// ⚠️ Persistence is a hard requirement, not an implementation detail: the
// login state lives in this directory. Pointing it at a temp dir makes the
// user re-authenticate on every process start.
func ResolveProfileDir(dir, configDir string) string {
	if dir == "" {
		if configDir == "" {
			return filepath.Join("webhub", "profile")
		}
		return filepath.Join(configDir, "webhub", "profile")
	}
	if filepath.IsAbs(dir) {
		return dir
	}
	if configDir != "" {
		return filepath.Join(configDir, dir)
	}
	return dir
}
