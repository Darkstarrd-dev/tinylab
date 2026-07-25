//go:build windows

package terminal

import (
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// mergedPathFromRegistry reads the effective PATH from the Windows registry:
// the system PATH from
// HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment appended
// with the user PATH from HKCU\Environment (Windows semantics: system first,
// user appended). REG_EXPAND_SZ references such as %SystemRoot% are expanded
// against the current process environment.
//
// It returns the merged PATH joined by ";", or "" on any failure (key/value
// missing or unreadable). On failure the caller falls back to the inherited
// process PATH from os.Environ(), so a registry read error never degrades the
// terminal below its prior behavior.
func mergedPathFromRegistry() string {
	sysRaw, err := readRegistryPath(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`)
	if err != nil {
		return ""
	}
	// User PATH is optional; many accounts have no per-user PATH. Ignore a
	// missing value and proceed with the system PATH alone.
	userRaw, _ := readRegistryPath(registry.CURRENT_USER, `Environment`)

	sysPath := os.ExpandEnv(sysRaw)
	userPath := os.ExpandEnv(userRaw)

	parts := make([]string, 0, 2)
	if sysPath != "" {
		parts = append(parts, sysPath)
	}
	if userPath != "" {
		parts = append(parts, userPath)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, ";")
}

// readRegistryPath reads the raw (unexpanded) PATH string value from the given
// registry root and subkey. Both REG_SZ and REG_EXPAND_SZ are returned as-is;
// expansion is performed by the caller via os.ExpandEnv.
func readRegistryPath(root registry.Key, subkey string) (string, error) {
	k, err := registry.OpenKey(root, subkey, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer k.Close()
	v, _, err := k.GetStringValue("PATH")
	if err != nil {
		return "", err
	}
	return v, nil
}
