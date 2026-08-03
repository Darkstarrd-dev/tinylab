package config

import (
	"bytes"
	"fmt"
	"os"

	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"gopkg.in/yaml.v3"
)

// Load reads config from path, or creates a default config there if not found.
//
// A .tmp file (path + ".tmp") is a crash-recovery source: fsutil.AtomicWrite
// leaves one behind whenever a rename or the direct-write fallback cannot
// complete, so it may hold the most recent saved config. Load uses it as
// follows:
//   - If path is missing or cannot be parsed, .tmp is tried FIRST, regardless
//     of its mtime — a newer-but-corrupt path (e.g. a crash during the
//     direct-write fallback) must never cause the complete .tmp copy to be
//     discarded.
//   - If path loads successfully but .tmp is newer, .tmp holds a pending save
//     whose rename AND direct write both failed last time; it is applied in
//     preference to path.
//   - .tmp is deleted only after a successful load from path (when it is
//     older residue from a completed direct-write fallback, or an abandoned
//     write that has been superseded).
func Load(path string) (*Config, error) {
	tmp := path + ".tmp"

	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			// Path exists but cannot be read — .tmp is the only recovery source.
			if recovered, ok := tryRecoverFromTmp(tmp, path); ok {
				return recovered, nil
			}
			return nil, err
		}
		// Path does not exist; a leftover .tmp would be a pending first-ever save.
		if recovered, ok := tryRecoverFromTmp(tmp, path); ok {
			return recovered, nil
		}
		cfg := DefaultConfig()
		if saveErr := Save(path, cfg); saveErr != nil {
			return nil, fmt.Errorf("create default config: %w", saveErr)
		}
		return cfg, nil
	}

	var cfg Config
	migrated, err := decodeConfig(data, &cfg)
	if err != nil {
		// Main path is corrupt — .tmp is a recovery source regardless of mtime.
		if recovered, ok := tryRecoverFromTmp(tmp, path); ok {
			return recovered, nil
		}
		return nil, fmt.Errorf("parse config: %w", err)
	}
	finalized := finalizeConfig(&cfg, data)
	if migrated {
		_ = Save(path, finalized)
	}

	// Path loaded successfully; discard leftover .tmp — UNLESS it is newer
	// than path, which means it holds a pending save whose rename AND direct
	// write both failed last time; apply it in preference to path.
	if tmpInfo, tmpErr := os.Stat(tmp); tmpErr == nil {
		if pathInfo, pathErr := os.Stat(path); pathErr == nil && tmpInfo.ModTime().After(pathInfo.ModTime()) {
			if recovered, ok := tryRecoverFromTmp(tmp, path); ok {
				return recovered, nil
			}
		}
		_ = os.Remove(tmp)
	}
	return finalized, nil
}

// tryRecoverFromTmp applies a leftover .tmp file over path and returns the
// resulting config. Application order:
//  1. os.Rename(tmp → path) — succeeds when the lock is gone.
//  2. overwrite path with tmp data — succeeds when the lock was transient.
//  3. parse tmp data directly — last resort so the user's pending changes
//     are visible in the running instance even if path is still locked.
//     In this case the .tmp file is left on disk for the next restart to retry.
//
// ok is false when there is no usable .tmp (absent, or neither apply nor
// parse succeeded). After a successful rename or overwrite, the config is
// parsed from path with the same strict decoder (incl. deprecated-field
// migration) as a normal load.
func tryRecoverFromTmp(tmp, path string) (*Config, bool) {
	if _, err := os.Stat(tmp); err != nil {
		return nil, false
	}
	if os.Rename(tmp, path) == nil {
		return loadAfterTmpApply(path)
	}
	tmpData, readErr := os.ReadFile(tmp)
	if readErr != nil {
		return nil, false
	}
	if os.WriteFile(path, tmpData, 0600) == nil {
		_ = os.Remove(tmp)
		return loadAfterTmpApply(path)
	}
	// Both rename and direct write failed — parse the pending data directly.
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(tmpData))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, false
	}
	return finalizeConfig(&cfg, tmpData), true
}

// loadAfterTmpApply re-reads and parses path after .tmp has been applied to
// it (via rename or direct write). It mirrors the strict-decode path used for
// a normal Load.
func loadAfterTmpApply(path string) (*Config, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cfg Config
	migrated, err := decodeConfig(data, &cfg)
	if err != nil {
		return nil, false
	}
	finalized := finalizeConfig(&cfg, data)
	if migrated {
		_ = Save(path, finalized)
	}
	return finalized, true
}

// deprecatedFieldPaths lists YAML field paths (each a sequence of map keys)
// that have been removed from the current schema. When the strict decoder
// rejects a config, Load strips these paths and retries so legacy config.yaml
// files auto-migrate instead of blocking startup. A genuinely unknown field
// (e.g. a typo like "portt") is not in this list, so the strict error surfaces
// unchanged — preserving the typo-catching intent of KnownFields(true).
//
// "monitor" was removed when the terminal/monitor features were deleted.
// "download.proxy" was removed when the download proxy feature was deleted.
var deprecatedFieldPaths = [][]string{
	{"download", "proxy"},
	{"monitor"},
}

// decodeConfig strictly decodes YAML data into cfg. If the strict decoder
// rejects the data, it strips known-deprecated field paths, re-marshals, and
// retries the strict decode. The migrated flag is true when a deprecated
// field was stripped so the caller can persist the cleaned config. A strict
// failure that is NOT explained by a deprecated field (e.g. a typo) returns
// the original strict error.
func decodeConfig(data []byte, cfg *Config) (migrated bool, err error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if derr := dec.Decode(cfg); derr == nil {
		return false, nil
	} else {
		// Strict failed. Parse into a generic map (lenient) so we can strip
		// deprecated fields without touching anything else.
		var root map[string]any
		ldec := yaml.NewDecoder(bytes.NewReader(data))
		ldec.KnownFields(false)
		if merr := ldec.Decode(&root); merr != nil {
			return false, derr
		}
		if !stripPaths(root, deprecatedFieldPaths) {
			// No deprecated field present — the strict error is a genuine
			// mistake (typo); surface it unchanged.
			return false, derr
		}
		cleaned, merr := yaml.Marshal(root)
		if merr != nil {
			return false, derr
		}
		sdec := yaml.NewDecoder(bytes.NewReader(cleaned))
		sdec.KnownFields(true)
		if serr := sdec.Decode(cfg); serr != nil {
			// Still failing after stripping — a non-deprecated unknown field
			// remains; surface that error.
			return false, serr
		}
		return true, nil
	}
}

// stripPaths removes each dot-path from root, returning whether any path was
// present and removed.
func stripPaths(root map[string]any, paths [][]string) bool {
	changed := false
	for _, p := range paths {
		if stripPath(root, p) {
			changed = true
		}
	}
	return changed
}

// stripPath removes the leaf key identified by path from a nested map tree.
func stripPath(root map[string]any, path []string) bool {
	m := root
	for i, k := range path {
		if i == len(path)-1 {
			if _, ok := m[k]; ok {
				delete(m, k)
				return true
			}
			return false
		}
		v, ok := m[k]
		if !ok {
			return false
		}
		mm, ok := v.(map[string]any)
		if !ok {
			return false
		}
		m = mm
	}
	return false
}

// Save writes config to path atomically (temp file + rename) via fsutil.AtomicWrite.
//
// On Windows the target file may be locked by another process or a stale
// handle, causing os.Rename to fail. AtomicWrite then falls back to a direct
// write; the .tmp crash-recovery copy is kept in both fallback outcomes and
// applied on the next startup via Load (or discarded after a clean load).
// If both rename and direct write fail, Save returns an error and the pending
// changes live only in .tmp until Load applies them.
func Save(path string, cfg *Config) error {
	marshalCfg := cfg
	if cfg.Security.PasswordEnabled && cfg.Security.EncryptionKey != "" {
		var err error
		marshalCfg, err = encryptKeysCopy(cfg)
		if err != nil {
			return err
		}
	}
	data, err := yaml.Marshal(marshalCfg)
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(path, data, 0600); err != nil {
		return fmt.Errorf("config file is locked (both rename and direct write failed); pending changes saved to %s.tmp and will be applied on next restart", path)
	}
	return nil
}
