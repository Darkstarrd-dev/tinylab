//go:build !windows

package terminal

// mergedPathFromRegistry is a no-op on non-Windows: there is no registry, and
// the inherited process environment (os.Environ) is the source of truth for
// the terminal shell. Returning "" makes buildShellEnv a pure
// os.Environ()+TERM pass-through, preserving prior behavior unchanged.
func mergedPathFromRegistry() string { return "" }
