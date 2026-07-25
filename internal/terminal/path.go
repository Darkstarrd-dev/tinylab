package terminal

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// buildShellEnv returns the environment block for the terminal shell process.
//
// It starts from os.Environ() so the shell inherits the full parent
// environment (PATH, PATHEXT, PSModulePath, SystemRoot, windir, ...). On
// Windows, if the inherited PATH is missing entries present in the
// registry-derived effective PATH (system PATH from
// HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment appended
// with user PATH from HKCU\Environment), the PATH entry is augmented from the
// registry. This repairs the case where TinyRouter was launched from a context
// whose PATH was stale or incomplete — most notably explorer.exe caches the
// logon-time environment block, so tools installed after logon (git, node,
// python, ...) are unreachable from the inherited env even though they are in
// the registry PATH. On non-Windows, mergedPathFromRegistry is a no-op.
//
// TERM=xterm-256color is appended last, matching the long-standing behavior.
func buildShellEnv() []string {
	return buildShellEnvWith(mergedPathFromRegistry())
}

// buildShellEnvWith is buildShellEnv with an explicit registry PATH, separated
// for testability (the registry read is Windows-only and machine-dependent).
func buildShellEnvWith(regPath string) []string {
	env := os.Environ()
	if regPath != "" {
		env = withAugmentedPath(env, regPath)
	}
	return append(env, "TERM=xterm-256color")
}

// withAugmentedPath replaces the PATH entry in env with the union of regPath
// and the inherited PATH when the inherited PATH is missing entries present in
// regPath. regPath entries come first (preserving the system-then-user
// registry order), followed by any inherited entries not already present
// (deduplicated case-insensitively on Windows). If the inherited PATH already
// contains every regPath entry, env is returned unchanged (no-op when the
// launch context already provides a complete PATH). If env has no PATH entry,
// "PATH="+regPath is prepended. An empty regPath is a no-op.
func withAugmentedPath(env []string, regPath string) []string {
	if regPath == "" {
		return env
	}
	regEntries := splitPathList(regPath)
	regSet := make(map[string]bool, len(regEntries))
	for _, e := range regEntries {
		regSet[normalizePathEntry(e)] = true
	}

	pathIdx := -1
	var inherited string
	for i, kv := range env {
		if strings.EqualFold(envKey(kv), "PATH") {
			pathIdx = i
			inherited = envValue(kv)
			break
		}
	}

	inheritedEntries := splitPathList(inherited)
	inheritedSet := make(map[string]bool, len(inheritedEntries))
	for _, e := range inheritedEntries {
		inheritedSet[normalizePathEntry(e)] = true
	}

	// No-op if the inherited PATH already contains every registry entry.
	complete := true
	for n := range regSet {
		if !inheritedSet[n] {
			complete = false
			break
		}
	}
	if complete {
		return env
	}

	// Merged PATH: registry entries first, then inherited extras not present.
	seen := make(map[string]bool, len(regSet))
	for n := range regSet {
		seen[n] = true
	}
	merged := make([]string, 0, len(regEntries)+len(inheritedEntries))
	merged = append(merged, regEntries...)
	for _, e := range inheritedEntries {
		n := normalizePathEntry(e)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		merged = append(merged, e)
	}
	newPath := strings.Join(merged, string(os.PathListSeparator))

	out := make([]string, len(env))
	copy(out, env)
	if pathIdx >= 0 {
		out[pathIdx] = "PATH=" + newPath
	} else {
		out = append([]string{"PATH=" + newPath}, out...)
	}
	return out
}

// splitPathList splits a PATH-style string on the OS path-list separator,
// dropping empty entries.
func splitPathList(s string) []string {
	parts := strings.Split(s, string(os.PathListSeparator))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// normalizePathEntry returns a comparable form of a PATH entry: cleaned of
// redundant separators and, on Windows (case-insensitive filesystem),
// lowercased. On non-Windows the cleaned entry is returned with its case
// preserved. withAugmentedPath is only exercised with a non-empty regPath on
// Windows (mergedPathFromRegistry returns "" elsewhere), so the case
// difference is irrelevant to the Unix path, which is a no-op.
func normalizePathEntry(e string) string {
	c := filepath.Clean(e)
	if runtime.GOOS == "windows" {
		return strings.ToLower(c)
	}
	return c
}

// envKey returns the name part of a "KEY=VALUE" env entry, or the whole
// string if it contains no '='.
func envKey(kv string) string {
	i := strings.IndexByte(kv, '=')
	if i < 0 {
		return kv
	}
	return kv[:i]
}

// envValue returns the value part of a "KEY=VALUE" env entry, or "" if it
// contains no '='.
func envValue(kv string) string {
	i := strings.IndexByte(kv, '=')
	if i < 0 {
		return ""
	}
	return kv[i+1:]
}
