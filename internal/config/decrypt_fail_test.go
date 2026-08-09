package config

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestLoad_DecryptFailureMarksKeyInactive guards F-20: when an "enc:" API key
// cannot be decrypted (e.g. the EncryptionKey was rotated), Load must record
// the failure, mark the key inactive so rotation never sends the ciphertext
// upstream as a credential, and preserve the "enc:" value on disk so a
// corrected password can still recover it.
func TestLoad_DecryptFailureMarksKeyInactive(t *testing.T) {
	goodKey, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	encrypted, err := Encrypt(goodKey, "sk-live-secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	wrongKey, err := GenerateKey() // different key material → decrypt fails
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	cfg := DefaultConfig()
	cfg.Security.PasswordEnabled = true
	cfg.Security.PasswordEncrypted = "unused"
	cfg.Security.EncryptionKey = wrongKey
	cfg.Providers = []Provider{
		{
			ID: "p1", Prefix: "prov",
			Keys: []Key{{ID: "k1", Key: "enc:" + encrypted, IsActive: true}},
		},
	}

	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := loaded.Providers[0].Keys[0]
	if got.IsActive {
		t.Error("key with undecryptable ciphertext must be marked inactive (never sent upstream)")
	}
	if !strings.HasPrefix(got.Key, "enc:") {
		t.Errorf("ciphertext must be preserved for recovery, got %q", got.Key)
	}
}

// TestLoad_DecryptSuccessKeepsKeyActive guards the happy path: a matching
// EncryptionKey decrypts the key, which stays active and plaintext in memory.
func TestLoad_DecryptSuccessKeepsKeyActive(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	encrypted, err := Encrypt(key, "sk-live-secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	cfg := DefaultConfig()
	cfg.Security.PasswordEnabled = true
	cfg.Security.PasswordEncrypted = "unused"
	cfg.Security.EncryptionKey = key
	cfg.Providers = []Provider{
		{
			ID: "p1", Prefix: "prov",
			Keys: []Key{{ID: "k1", Key: "enc:" + encrypted, IsActive: true}},
		},
	}

	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := Save(path, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := loaded.Providers[0].Keys[0]
	if !got.IsActive {
		t.Error("decryptable key must stay active")
	}
	if got.Key != "sk-live-secret" {
		t.Errorf("Key = %q, want decrypted plaintext", got.Key)
	}
}
