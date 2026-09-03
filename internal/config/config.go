// Package config defines the TinyLab configuration structures and handles
// loading, saving, validation, and default-filling of config.yaml, plus the
// AES-256-GCM encryption helpers used to protect API keys at rest.
//
// The package is split across several files by responsibility:
//   - types.go:        struct/type definitions and their methods.
//   - defaults.go:     default config construction and finalizeConfig.
//   - persistence.go:  Load/Save and atomic file I/O.
//   - validate.go:     best-effort config validation.
//   - crypto.go:       AES-256-GCM key encryption helpers and encryptKeysCopy.
package config
