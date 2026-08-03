package config

import (
	"os"
	"testing"
)

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	plaintext := "hello, world!"
	ciphertext, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	decrypted, err := Decrypt(key, ciphertext)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != plaintext {
		t.Fatalf("Decrypt = %q, want %q", decrypted, plaintext)
	}
}

func TestDecrypt_InvalidKey(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	plaintext := "secret data"
	ciphertext, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	wrongKey, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	_, err = Decrypt(wrongKey, ciphertext)
	if err == nil {
		t.Fatal("expected error decrypting with wrong key")
	}
}

func TestDecrypt_InvalidCiphertext(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	_, err = Decrypt(key, "not-valid-base64!!")
	if err == nil {
		t.Fatal("expected error for invalid base64 ciphertext")
	}
}

func TestEncrypt_DifferentNonces(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	plaintext := "same plaintext"
	c1, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	c2, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if c1 == c2 {
		t.Fatal("ciphertexts should differ due to random nonce")
	}
}

func TestGenerateKey(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if key == "" {
		t.Fatal("key should not be empty")
	}
	plaintext := "test"
	ciphertext, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt with generated key: %v", err)
	}
	decrypted, err := Decrypt(key, ciphertext)
	if err != nil {
		t.Fatalf("Decrypt with generated key: %v", err)
	}
	if decrypted != plaintext {
		t.Fatalf("Decrypt = %q, want %q", decrypted, plaintext)
	}
}

func TestDecrypt_EmptyKey(t *testing.T) {
	_, err := Decrypt("", "some-ciphertext")
	if err == nil {
		t.Fatal("expected error for empty key")
	}
}

func TestEncrypt_EmptyPlaintext(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	ciphertext, err := Encrypt(key, "")
	if err != nil {
		t.Fatalf("Encrypt empty string: %v", err)
	}
	decrypted, err := Decrypt(key, ciphertext)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != "" {
		t.Fatalf("Decrypt = %q, want empty string", decrypted)
	}
}

// TestSave_RejectsBadEncryptionKey verifies that a corrupt EncryptionKey
// causes Save to FAIL instead of silently writing plaintext API keys to disk:
// with password protection enabled, key-at-rest encryption is mandatory.
func TestSave_RejectsBadEncryptionKey(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.yaml"

	cfg := DefaultConfig()
	cfg.Security.PasswordEnabled = true
	cfg.Security.PasswordEncrypted = "some-ciphertext"
	cfg.Security.EncryptionKey = "not-base64!!!"
	cfg.Providers = []Provider{{
		ID:      "p1",
		Prefix:  "p1",
		BaseURL: "https://api.example.com/v1",
		Keys:    []Key{{ID: "k1", Key: "sk-plaintext-should-never-hit-disk"}},
	}}

	err := Save(path, cfg)
	if err == nil {
		t.Fatal("Save should reject a corrupt EncryptionKey")
	}
	// No config file may be written when encryption fails.
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("config file must not be written after failed encryption: %v", statErr)
	}
}

// TestSave_RejectsWrongLengthKey covers the AES-key-length failure mode
// (valid base64 that decodes to a non-32-byte key).
func TestSave_RejectsWrongLengthKey(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.yaml"

	cfg := DefaultConfig()
	cfg.Security.PasswordEnabled = true
	cfg.Security.PasswordEncrypted = "some-ciphertext"
	cfg.Security.EncryptionKey = "c2hvcnQ=" // base64("short") — not a valid AES key size
	cfg.Providers = []Provider{{
		ID:      "p1",
		Prefix:  "p1",
		BaseURL: "https://api.example.com/v1",
		Keys:    []Key{{ID: "k1", Key: "sk-plaintext"}},
	}}

	if err := Save(path, cfg); err == nil {
		t.Fatal("Save should reject an AES key of invalid length")
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("config file must not be written after failed encryption: %v", statErr)
	}
}
