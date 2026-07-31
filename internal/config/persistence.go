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
// If a pending .tmp file exists (from a previous Save whose rename failed),
// Load attempts to apply it in order of preference:
//  1. os.Rename(tmp → path)          — succeeds when the lock is gone.
//  2. overwrite path with tmp data    — succeeds when the lock was transient.
//  3. parse tmp data directly         — last resort so user's pending changes
//     are visible in the running instance even if path is still locked.
//
// In case 3 the .tmp file is left on disk for the next restart to retry.
func Load(path string) (*Config, error) {
	tmp := path + ".tmp"
	if tmpInfo, err := os.Stat(tmp); err == nil {
		pathInfo, pathErr := os.Stat(path)
		applyTmp := true
		if pathErr == nil && pathInfo != nil && tmpInfo != nil {
			// 只当 .tmp 比 path 更新时才恢复；否则 .tmp 为过期残留，删除它。
			applyTmp = tmpInfo.ModTime().After(pathInfo.ModTime())
		}
		if applyTmp {
			if renameErr := os.Rename(tmp, path); renameErr != nil {
				tmpData, readErr := os.ReadFile(tmp)
				if readErr == nil {
					if writeErr := os.WriteFile(path, tmpData, 0600); writeErr == nil {
						_ = os.Remove(tmp)
					} else {
						var cfg Config
						dec := yaml.NewDecoder(bytes.NewReader(tmpData))
						dec.KnownFields(true)
						if err := dec.Decode(&cfg); err != nil {
							return nil, fmt.Errorf("parse pending config (.tmp): %w", err)
						}
						return finalizeConfig(&cfg, tmpData), nil
					}
				}
			}
		} else {
			// .tmp 比 path 旧，可能是过时残留，删除它。
			_ = os.Remove(tmp)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := DefaultConfig()
			if saveErr := Save(path, cfg); saveErr != nil {
				return nil, fmt.Errorf("create default config: %w", saveErr)
			}
			return cfg, nil
		}
		return nil, err
	}
	var cfg Config
	migrated, err := decodeConfig(data, &cfg)
	if err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	finalized := finalizeConfig(&cfg, data)
	// Auto-migrate: if the on-disk YAML carried fields no longer in the
	// schema (e.g. a removed download.proxy), the strict decoder fails and
	// decodeConfig falls back to a lenient decode. Persist the normalized
	// config back to disk so the deprecated fields are dropped and the next
	// startup is clean. Best-effort: a write failure does not block loading.
	if migrated {
		_ = Save(path, finalized)
	}
	return finalized, nil
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
// write; if that also fails the .tmp file remains on disk and will be applied
// on the next startup via Load.
func Save(path string, cfg *Config) error {
	marshalCfg := cfg
	if cfg.Security.PasswordEnabled && cfg.Security.EncryptionKey != "" {
		marshalCfg = encryptKeysCopy(cfg)
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
