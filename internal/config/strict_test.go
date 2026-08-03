package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLoad_UnknownFieldStillErrors verifies that strict-mode yaml parsing is
// still active for genuinely unknown fields (e.g. a typo). This guards the
// design intent of KnownFields(true) — catching configuration mistakes —
// while known-deprecated fields are handled by the auto-migration list.
func TestLoad_UnknownFieldStillErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	// "portt" is a typo of "port" — strict mode must reject it.
	badYAML := []byte(`portt: 20128
`)
	if err := os.WriteFile(path, badYAML, 0644); err != nil {
		t.Fatal(err)
	}

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected strict-mode error for unknown field 'portt'")
	}
	if !strings.Contains(err.Error(), "portt") {
		t.Fatalf("error should mention the unknown field 'portt', got: %v", err)
	}
}
