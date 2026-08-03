package config

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.Port != 20128 {
		t.Fatalf("Port = %d, want 20128", cfg.Port)
	}
	if cfg.ConsoleLogMaxLines != 200 {
		t.Fatalf("ConsoleLogMaxLines = %d, want 200", cfg.ConsoleLogMaxLines)
	}
	if cfg.UsageRingSize != 500 {
		t.Fatalf("UsageRingSize = %d, want 500", cfg.UsageRingSize)
	}
	if !cfg.EnablePlayground {
		t.Fatal("EnablePlayground should be true")
	}
	if cfg.Rotation.Strategy != "fill-first" {
		t.Fatalf("Rotation.Strategy = %q, want fill-first", cfg.Rotation.Strategy)
	}
	if cfg.Rotation.StickyLimit != 3 {
		t.Fatalf("Rotation.StickyLimit = %d, want 3", cfg.Rotation.StickyLimit)
	}
	if cfg.Rotation.MaxRetries != 5 {
		t.Fatalf("Rotation.MaxRetries = %d, want 5", cfg.Rotation.MaxRetries)
	}
	if cfg.Rotation.RetryDelaySec != 5 {
		t.Fatalf("Rotation.RetryDelaySec = %d, want 5", cfg.Rotation.RetryDelaySec)
	}
	if cfg.Rotation.BackoffMaxSec != 300 {
		t.Fatalf("Rotation.BackoffMaxSec = %d, want 300", cfg.Rotation.BackoffMaxSec)
	}
	if !cfg.Rotation.StatePersist {
		t.Fatal("Rotation.StatePersist should be true")
	}
	if cfg.Rotation.StatePath != "state.yaml" {
		t.Fatalf("Rotation.StatePath = %q, want state.yaml", cfg.Rotation.StatePath)
	}
	if cfg.Providers == nil {
		t.Fatal("Providers should be non-nil")
	}
	if cfg.Combos == nil {
		t.Fatal("Combos should be non-nil")
	}
	if len(cfg.Providers) != 0 {
		t.Fatalf("len(Providers) = %d, want 0", len(cfg.Providers))
	}
	if len(cfg.Combos) != 0 {
		t.Fatalf("len(Combos) = %d, want 0", len(cfg.Combos))
	}
	if cfg.Trace.Enabled {
		t.Fatal("Trace.Enabled should be false by default")
	}
	if cfg.Trace.RetainDays != 2 {
		t.Fatalf("Trace.RetainDays = %d, want 2", cfg.Trace.RetainDays)
	}
	if cfg.Trace.MaxDiskMB != 500 {
		t.Fatalf("Trace.MaxDiskMB = %d, want 500", cfg.Trace.MaxDiskMB)
	}
}

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	orig := &Config{
		Port:               3000,
		ConsoleLogMaxLines: 100,
		UsageRingSize:      1000,
		EnablePlayground:   false,
		Rotation: RotationConfig{
			Strategy:      "round-robin",
			StickyLimit:   5,
			MaxRetries:    3,
			RetryDelaySec: 2,
			BackoffMaxSec: 120,
			StatePersist:  false,
			StatePath:     "custom_state.yaml",
		},
		Providers: []Provider{
			{
				ID:       "deepseek",
				Name:     "DeepSeek",
				Prefix:   "ds",
				BaseURL:  "https://api.deepseek.com",
				APIType:  "openai",
				IsActive: true,
				Keys: []Key{
					{ID: "k1", Key: "sk-xxx", Name: "Key 1", Priority: 1, IsActive: true},
				},
				Models: []ModelDef{
					{ID: "deepseek-chat", QuotaType: "unlimited"},
				},
				NIMConfig: nil,
			},
		},
		Combos: []Combo{
			{ID: "fast", Name: "Fast Model", Strategy: "fallback", Models: []string{"deepseek-chat"}},
		},
		Trace: TraceConfig{
			Enabled:    true,
			RetainDays: 2,
			MaxDiskMB:  500,
		},
	}

	if err := Save(path, orig); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if loaded.Port != orig.Port {
		t.Fatalf("Port = %d, want %d", loaded.Port, orig.Port)
	}
	if loaded.ConsoleLogMaxLines != orig.ConsoleLogMaxLines {
		t.Fatalf("ConsoleLogMaxLines = %d, want %d", loaded.ConsoleLogMaxLines, orig.ConsoleLogMaxLines)
	}
	if loaded.UsageRingSize != orig.UsageRingSize {
		t.Fatalf("UsageRingSize = %d, want %d", loaded.UsageRingSize, orig.UsageRingSize)
	}
	if loaded.EnablePlayground != orig.EnablePlayground {
		t.Fatalf("EnablePlayground = %v, want %v", loaded.EnablePlayground, orig.EnablePlayground)
	}

	if loaded.Rotation.Strategy != orig.Rotation.Strategy {
		t.Fatalf("Rotation.Strategy = %q, want %q", loaded.Rotation.Strategy, orig.Rotation.Strategy)
	}
	if loaded.Rotation.StickyLimit != orig.Rotation.StickyLimit {
		t.Fatalf("Rotation.StickyLimit = %d, want %d", loaded.Rotation.StickyLimit, orig.Rotation.StickyLimit)
	}
	if loaded.Rotation.MaxRetries != orig.Rotation.MaxRetries {
		t.Fatalf("Rotation.MaxRetries = %d, want %d", loaded.Rotation.MaxRetries, orig.Rotation.MaxRetries)
	}
	if loaded.Rotation.RetryDelaySec != orig.Rotation.RetryDelaySec {
		t.Fatalf("Rotation.RetryDelaySec = %d, want %d", loaded.Rotation.RetryDelaySec, orig.Rotation.RetryDelaySec)
	}
	if loaded.Rotation.BackoffMaxSec != orig.Rotation.BackoffMaxSec {
		t.Fatalf("Rotation.BackoffMaxSec = %d, want %d", loaded.Rotation.BackoffMaxSec, orig.Rotation.BackoffMaxSec)
	}
	if loaded.Rotation.StatePersist != orig.Rotation.StatePersist {
		t.Fatalf("Rotation.StatePersist = %v, want %v", loaded.Rotation.StatePersist, orig.Rotation.StatePersist)
	}
	if loaded.Rotation.StatePath != orig.Rotation.StatePath {
		t.Fatalf("Rotation.StatePath = %q, want %q", loaded.Rotation.StatePath, orig.Rotation.StatePath)
	}

	if len(loaded.Providers) != 1 {
		t.Fatalf("len(Providers) = %d, want 1", len(loaded.Providers))
	}
	p := loaded.Providers[0]
	if p.ID != "deepseek" || p.Name != "DeepSeek" || p.BaseURL != "https://api.deepseek.com" {
		t.Fatalf("Provider mismatch: %+v", p)
	}
	if len(p.Keys) != 1 || p.Keys[0].Key != "sk-xxx" {
		t.Fatalf("Key mismatch: %+v", p.Keys)
	}
	if len(p.Models) != 1 || p.Models[0].ID != "deepseek-chat" || p.Models[0].QuotaType != "unlimited" {
		t.Fatalf("Model mismatch: %+v", p.Models)
	}

	if len(loaded.Combos) != 1 {
		t.Fatalf("len(Combos) = %d, want 1", len(loaded.Combos))
	}
	if loaded.Combos[0].ID != "fast" || loaded.Combos[0].Strategy != "fallback" {
		t.Fatalf("Combo mismatch: %+v", loaded.Combos[0])
	}
	if !loaded.Trace.Enabled {
		t.Fatal("Trace.Enabled should be true (explicit user setting round-trips)")
	}
	if loaded.Trace.RetainDays != 2 {
		t.Fatalf("Trace.RetainDays = %d, want 2", loaded.Trace.RetainDays)
	}
	if loaded.Trace.MaxDiskMB != 500 {
		t.Fatalf("Trace.MaxDiskMB = %d, want 500", loaded.Trace.MaxDiskMB)
	}
}

func TestLoad_NonExistentFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.yaml")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load non-existent file: %v", err)
	}

	if cfg.Port != 20128 {
		t.Fatalf("Port = %d, want 20128", cfg.Port)
	}
	if cfg.Providers == nil {
		t.Fatal("Providers should be non-nil")
	}
	if cfg.Combos == nil {
		t.Fatal("Combos should be non-nil")
	}

	stat, err := os.Stat(path)
	if err != nil {
		t.Fatalf("expected config file to be created, got error: %v", err)
	}
	if stat.Size() == 0 {
		t.Fatal("created config file is empty")
	}
}

func TestLoad_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.yaml")

	if err := os.WriteFile(path, []byte(": : : invalid"), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for invalid YAML")
	}
	if !strings.Contains(err.Error(), "parse config") {
		t.Fatalf("error should mention parse config, got: %v", err)
	}
}

func TestSave_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg := DefaultConfig()
	if err := Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}

	stat, err := os.Stat(path)
	if err != nil {
		t.Fatalf("target file should exist: %v", err)
	}
	if stat.Size() == 0 {
		t.Fatal("target file is empty")
	}

	tmpPath := path + ".tmp"
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatal("temporary .tmp file should have been cleaned up after rename")
	}
}

func TestIsNIM(t *testing.T) {
	tests := []struct {
		name   string
		prefix string
		base   string
		apiT   string
		want   bool
	}{
		{name: "apiType_nim", apiT: "nim", base: "https://example.com", want: true},
		{name: "baseURL_nvidia", apiT: "openai", base: "https://nvidia.com/api", want: true},
		{name: "baseURL_NVIDIA_case", apiT: "openai", base: "https://NVIDIA.com/api", want: true},
		{name: "baseURL_nvidia_substr", apiT: "openai", base: "https://api.nvidia.com/v1", want: true},
		{name: "both_nim", apiT: "nim", base: "https://api.nvidia.com", want: true},
		{name: "neither", apiT: "openai", base: "https://api.deepseek.com", want: false},
		{name: "empty_fields", apiT: "", base: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := Provider{APIType: tt.apiT, BaseURL: tt.base}
			got := p.IsNIM()
			if got != tt.want {
				t.Errorf("IsNIM() = %v, want %v (apiType=%q, baseURL=%q)", got, tt.want, tt.apiT, tt.base)
			}
		})
	}
}

func TestIsCline(t *testing.T) {
	tests := []struct {
		name string
		base string
		want bool
	}{
		{name: "host_root", base: "https://api.cline.bot", want: true},
		{name: "path_bearing", base: "https://api.cline.bot/api/v1", want: true},
		{name: "case_insensitive", base: "https://API.CLINE.BOT", want: true},
		{name: "subdomain_other", base: "https://www.cline.bot", want: false},
		{name: "unrelated", base: "https://api.openai.com/v1", want: false},
		{name: "empty", base: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := Provider{BaseURL: tt.base}
			got := p.IsCline()
			if got != tt.want {
				t.Errorf("IsCline() = %v, want %v (baseURL=%q)", got, tt.want, tt.base)
			}
		})
	}
}

func TestEnablePlaygroundDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	yamlContent := []byte("port: 3000\n")
	if err := os.WriteFile(path, yamlContent, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if !cfg.EnablePlayground {
		t.Fatal("EnablePlayground should default to true when not specified in YAML")
	}
}

func TestLoad_EmptyQuotaTypeDefaulted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	yamlContent := []byte(`
providers:
  - id: test
    name: Test
    baseUrl: https://api.test.com
    isActive: true
    keys:
      - id: k1
        key: sk-test
    models:
      - id: test-model
`)
	if err := os.WriteFile(path, yamlContent, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(cfg.Providers) != 1 {
		t.Fatalf("len(Providers) = %d, want 1", len(cfg.Providers))
	}
	if len(cfg.Providers[0].Models) != 1 {
		t.Fatalf("len(Models) = %d, want 1", len(cfg.Providers[0].Models))
	}
	if cfg.Providers[0].Models[0].QuotaType != "limited" {
		t.Fatalf("QuotaType = %q, want limited", cfg.Providers[0].Models[0].QuotaType)
	}
}

func TestLoad_ModelDefScalar(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	yamlContent := []byte(`
providers:
  - id: test
    name: Test
    baseUrl: https://api.test.com
    isActive: true
    keys:
      - id: k1
        key: sk-test
    models:
      - gpt-4
      - claude-3
`)
	if err := os.WriteFile(path, yamlContent, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(cfg.Providers[0].Models) != 2 {
		t.Fatalf("len(Models) = %d, want 2", len(cfg.Providers[0].Models))
	}
	if cfg.Providers[0].Models[0].ID != "gpt-4" || cfg.Providers[0].Models[0].QuotaType != "limited" {
		t.Fatalf("Model[0] = %+v, want {gpt-4 limited}", cfg.Providers[0].Models[0])
	}
	if cfg.Providers[0].Models[1].ID != "claude-3" || cfg.Providers[0].Models[1].QuotaType != "limited" {
		t.Fatalf("Model[1] = %+v, want {claude-3 limited}", cfg.Providers[0].Models[1])
	}
}

// TestSave_ReturnsNilAndLeavesTmpWhenPathLocked simulates the Windows
// "config.yaml is locked" scenario by making path read-only so that
// the rename fallback (direct WriteFile) also fails. Save should return
// an error (so the caller knows the change is not yet applied to path)
// and the .tmp file should remain for the next Load to recover.
//
// Note: on Windows a read-only attribute blocks both Rename and WriteFile.
// On POSIX, root can bypass file permissions, but these tests run as the
// normal user so the permission check works.
func TestSave_ReturnsNilAndLeavesTmpWhenPathLocked(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	// Create the target file first and make it read-only.
	if err := os.WriteFile(path, []byte("port: 9999\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0444); err != nil {
		t.Skipf("cannot chmod (not relevant on this platform): %v", err)
	}
	defer os.Chmod(path, 0644) // restore so TempDir cleanup works

	cfg := DefaultConfig()
	cfg.Port = 5555
	err := Save(path, cfg)
	// Save 在 rename + direct-write 双失败时返回 error（P2.6），以便调用方
	// 知道状态未立即落盘到 path；pending 改动仍保留在 .tmp，待下次 Load 应用。
	if err == nil {
		t.Fatalf("Save returned nil on locked path (expected error, P2.6 changed behavior)")
	}

	// The .tmp file should exist (it could not rename or overwrite path).
	tmpPath := path + ".tmp"
	if _, err := os.Stat(tmpPath); err != nil {
		t.Fatalf(".tmp file should exist after failed rename+write: %v", err)
	}

	// Restore permissions so Load can work.
	_ = os.Chmod(path, 0644)

	// Ensure .tmp mtime is strictly newer than path (so P2.7 applies it).
	now := time.Now()
	_ = os.Chtimes(tmpPath, now.Add(time.Second), now.Add(time.Second))

	// Load should apply the .tmp file.
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Port != 5555 {
		t.Fatalf("Port = %d, want 5555 (from pending .tmp)", loaded.Port)
	}

	// After successful Load, .tmp should be gone (either renamed or removed).
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf(".tmp file should be cleaned up after successful Load: %v", err)
	}
}

// captureStderr runs fn while capturing everything written to os.Stderr.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	pipeR, pipeW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = pipeW
	fn()
	pipeW.Close()
	os.Stderr = orig
	var buf strings.Builder
	if _, err := io.Copy(&buf, pipeR); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

func TestValidate_ProviderModelProtocols_UnknownValue(t *testing.T) {
	cfg := &Config{
		Providers: []Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com", IsActive: true,
				Models: []ModelDef{{ID: "m1", QuotaType: "limited", Protocols: []string{"openai-compat", "bogus-proto"}}},
			},
		},
	}
	out := captureStderr(t, func() { validateProviders(cfg) })
	if !strings.Contains(out, "unknown protocol") {
		t.Fatalf("expected warning about unknown protocol, got: %q", out)
	}
	if !strings.Contains(out, "bogus-proto") {
		t.Fatalf("warning should name the offending value bogus-proto, got: %q", out)
	}
}

func TestValidate_ProviderModelProtocols_LegalValues(t *testing.T) {
	cfg := &Config{
		Providers: []Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com", IsActive: true,
				Models: []ModelDef{{
					ID: "m1", QuotaType: "limited",
					Protocols: []string{ProtocolOpenAICompat, ProtocolOpenAIResponses, ProtocolAnthropic},
				}},
			},
		},
	}
	out := captureStderr(t, func() { validateProviders(cfg) })
	if strings.Contains(out, "unknown protocol") {
		t.Fatalf("legal protocol values should not warn, got: %q", out)
	}
}

func TestLoad_ModelDefProtocolsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	yamlContent := []byte(`
providers:
  - id: test
    name: Test
    baseUrl: https://api.test.com
    isActive: true
    keys:
      - id: k1
        key: sk-test
    models:
      - id: test-model
        protocols:
          - openai-compat
          - anthropic
`)
	if err := os.WriteFile(path, yamlContent, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := cfg.Providers[0].Models[0].Protocols
	if len(got) != 2 || got[0] != "openai-compat" || got[1] != "anthropic" {
		t.Fatalf("Protocols = %v, want [openai-compat anthropic]", got)
	}

	// Backward compatibility: a model without the protocols key loads with nil.
	legacy := []byte(`
providers:
  - id: test
    name: Test
    baseUrl: https://api.test.com
    isActive: true
    keys:
      - id: k1
        key: sk-test
    models:
      - id: legacy-model
`)
	path2 := filepath.Join(dir, "legacy.yaml")
	if err := os.WriteFile(path2, legacy, 0644); err != nil {
		t.Fatal(err)
	}
	cfg2, err := Load(path2)
	if err != nil {
		t.Fatalf("Load legacy: %v", err)
	}
	if cfg2.Providers[0].Models[0].Protocols != nil {
		t.Fatalf("legacy model Protocols = %v, want nil", cfg2.Providers[0].Models[0].Protocols)
	}
}

// TestLoad_PendingTmpApplied verifies that a leftover .tmp file from a
// previous run is applied on Load when rename succeeds.
func TestLoad_PendingTmpApplied(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	tmpPath := path + ".tmp"

	// Write a stale config to path.
	stale := []byte("port: 1111\nenablePlayground: false\n")
	if err := os.WriteFile(path, stale, 0644); err != nil {
		t.Fatal(err)
	}

	// .tmp must be strictly newer than path (P2.7 mtime comparison).
	time.Sleep(15 * time.Millisecond)

	// Write a newer config to .tmp (simulating a previous Save that
	// could not rename).
	newer := []byte("port: 2222\nenablePlayground: false\n")
	if err := os.WriteFile(tmpPath, newer, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 2222 {
		t.Fatalf("Port = %d, want 2222 (from pending .tmp)", cfg.Port)
	}

	// .tmp should be gone after Load applied it.
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf(".tmp file should be removed after Load: %v", err)
	}
}

// TestLoad_PendingTmpFallbackDirectWrite verifies that when rename fails
// but the target file is writable, Load falls back to overwriting path
// with .tmp content.
func TestLoad_PendingTmpFallbackDirectWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	tmpPath := path + ".tmp"

	// The "rename fails" path is tested by TestSave_ReturnsNilAndLeavesTmpWhenPathLocked.
	//
	// This test verifies that when both .tmp and path exist and .tmp has
	// newer mtime, Load prefers .tmp (via either rename or direct-write fallback).

	stale := []byte("port: 1111\nenablePlayground: false\n")
	if err := os.WriteFile(path, stale, 0644); err != nil {
		t.Fatal(err)
	}

	// Brief sleep so .tmp mtime strictly > path mtime (P2.7 uses After()).
	time.Sleep(15 * time.Millisecond)

	newer := []byte("port: 3333\nenablePlayground: false\n")
	if err := os.WriteFile(tmpPath, newer, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 3333 {
		t.Fatalf("Port = %d, want 3333 (from .tmp)", cfg.Port)
	}
}

// TestLoad_StaleTmpIsDiscarded verifies that if .tmp is OLDER than path
// (e.g. a leftover from a crashed prior run that has since been superseded),
// Load does NOT roll back to .tmp; it deletes the stale .tmp and uses path.
func TestLoad_StaleTmpIsDiscarded(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	tmpPath := path + ".tmp"

	// Write path (newer)
	fresh := []byte("port: 7777\nenablePlayground: false\n")
	if err := os.WriteFile(path, fresh, 0644); err != nil {
		t.Fatal(err)
	}

	// Write stale .tmp (older mtime)
	stale := []byte("port: 1111\nenablePlayground: false\n")
	if err := os.WriteFile(tmpPath, stale, 0644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-1 * time.Hour)
	_ = os.Chtimes(tmpPath, past, past)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 7777 {
		t.Fatalf("Port = %d, want 7777 (path should win over stale .tmp)", cfg.Port)
	}
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("stale .tmp should be removed: %v", err)
	}
}

// TestLoad_RecoversFromTmpWhenPathCorrupt verifies that a .tmp recovery
// source is applied even when path is NEWER but corrupt (e.g. a crash during
// the AtomicWrite direct-write fallback truncated path). The old mtime-based
// logic would have treated the older-but-complete .tmp as stale and deleted
// it, losing the pending data.
func TestLoad_RecoversFromTmpWhenPathCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	tmpPath := path + ".tmp"

	// Corrupt path written first so its mtime is NEWER than .tmp.
	if err := os.WriteFile(path, []byte(": : : invalid"), 0644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)

	// Complete config in .tmp, then backdate it — the stale-mtime case.
	if err := os.WriteFile(tmpPath, []byte("port: 4242\nenablePlayground: false\n"), 0644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-1 * time.Hour)
	_ = os.Chtimes(tmpPath, past, past)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load should recover from .tmp when path is corrupt: %v", err)
	}
	if cfg.Port != 4242 {
		t.Fatalf("Port = %d, want 4242 (recovered from older .tmp)", cfg.Port)
	}
}

func TestFinalizeConfig_NormalizesPasswordEnabledWithoutPassword(t *testing.T) {
	// PasswordEnabled=true with empty PasswordEncrypted should be normalized to false.
	cfg := &Config{
		Security: SecurityConfig{
			PasswordEnabled:   true,
			PasswordEncrypted: "",
			EncryptionKey:     "",
		},
	}
	stderr := captureStderr(t, func() {
		finalizeConfig(cfg, nil)
	})
	if cfg.Security.PasswordEnabled {
		t.Error("expected PasswordEnabled to be normalized to false")
	}
	if !strings.Contains(stderr, "passwordEnabled is true but no password is set") {
		t.Error("expected stderr warning about passwordEnabled inconsistency")
	}
}

func TestFinalizeConfig_KeepsPasswordEnabledWithPassword(t *testing.T) {
	// PasswordEnabled=true with a non-empty PasswordEncrypted and EncryptionKey stays true.
	cfg := &Config{
		Security: SecurityConfig{
			PasswordEnabled:   true,
			PasswordEncrypted: "some-encrypted-value",
			EncryptionKey:     "some-key",
		},
	}
	finalizeConfig(cfg, nil)
	if !cfg.Security.PasswordEnabled {
		t.Error("expected PasswordEnabled to remain true when password is stored")
	}
}
