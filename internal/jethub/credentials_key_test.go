package jethub

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

// TestCredentialStorageWithoutConfigKey is the regression test for the
// reported defect: with no password protection the app passes an EMPTY
// cfg.Security.EncryptionKey, and credential storage used to fail with
// "jethub: no encryption key available for credentials storage" — every
// provider login ended there. The manager now self-provisions {dir}/key.
func TestCredentialStorageWithoutConfigKey(t *testing.T) {
	dir := t.TempDir()
	m, err := NewManager(dir, "", nil) // "" = the default (no password protection)
	if err != nil {
		t.Fatalf("NewManager with empty config key must succeed: %v", err)
	}

	id, ref := NewAccountID("minimax")
	if err := m.AddAccount(Account{ID: id, Provider: "minimax", Nickname: id, Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	// This is the call that used to fail with the reported error.
	if err := m.SetCredential("minimax", ref, []byte(`{"access_token":"tok-1"}`), 123, false); err != nil {
		t.Fatalf("SetCredential without a config key must succeed: %v", err)
	}

	// The key file exists and is a jethub-owned secret.
	if _, err := os.Stat(filepath.Join(dir, "key")); err != nil {
		t.Fatalf("key file must exist: %v", err)
	}

	// Credentials survive a reload (same self-provisioned key).
	reloaded, err := NewManager(dir, "", nil)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	cred, ok := reloaded.Credential("minimax", ref)
	if !ok || string(cred) != `{"access_token":"tok-1"}` {
		t.Fatalf("credential must survive reload, got %q ok=%v", cred, ok)
	}
}

// TestCredentialKeyIsStableAndLocal: repeated construction reuses the same key
// (credentials stay decryptable) and the key is not the config key.
func TestCredentialKeyIsStableAndLocal(t *testing.T) {
	dir := t.TempDir()
	cfgKey, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m1, err := NewManager(dir, cfgKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	m2, err := NewManager(dir, cfgKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m1.key != m2.key {
		t.Fatal("the self-provisioned key must be stable across constructions")
	}
	if m1.key == cfgKey {
		t.Fatal("jethub must not adopt the password-protection key as its own")
	}
}

// TestCredentialMigrationFromConfigKey: credentials written by an older build
// (encrypted with cfg.Security.EncryptionKey) are adopted and re-encrypted
// under the jethub key, so a later password change cannot orphan them.
func TestCredentialMigrationFromConfigKey(t *testing.T) {
	dir := t.TempDir()
	cfgKey, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	// Simulate the legacy on-disk state: the envelope encrypted with cfgKey.
	inner := `{"codearts":{"CODEARTS_ACCOUNT_1":{"access_token":"legacy-tok"}}}`
	enc, err := config.Encrypt(cfgKey, inner)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"),
		[]byte(`{"enc":"`+enc+`"}`), 0600); err != nil {
		t.Fatal(err)
	}

	m, err := NewManager(dir, cfgKey, nil)
	if err != nil {
		t.Fatalf("legacy credentials must load via the config key: %v", err)
	}
	cred, ok := m.Credential("codearts", "CODEARTS_ACCOUNT_1")
	if !ok || string(cred) != `{"access_token":"legacy-tok"}` {
		t.Fatalf("legacy credential not adopted: %q ok=%v", cred, ok)
	}

	// After migration the file must decrypt with the jethub key alone — i.e. a
	// reload WITHOUT the config key still works (password protection may be
	// disabled later, which clears that key).
	reloaded, err := NewManager(dir, "", nil)
	if err != nil {
		t.Fatalf("migrated credentials must load without the config key: %v", err)
	}
	cred2, ok := reloaded.Credential("codearts", "CODEARTS_ACCOUNT_1")
	if !ok || string(cred2) != `{"access_token":"legacy-tok"}` {
		t.Fatalf("migrated credential lost: %q ok=%v", cred2, ok)
	}
}

// TestCredentialMigrationSkippedWhenUndecryptable: a foreign/corrupt envelope
// must fail loudly rather than silently discarding stored credentials.
func TestCredentialMigrationSkippedWhenUndecryptable(t *testing.T) {
	dir := t.TempDir()
	otherKey, err := config.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	enc, err := config.Encrypt(otherKey, `{"codearts":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"),
		[]byte(`{"enc":"`+enc+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewManager(dir, "", nil); err == nil {
		t.Fatal("an undecryptable envelope must surface an error, not be ignored")
	}
}

// TestBrowserOpenerInvoked: login flows auto-open the authorization URL (the
// minimax handler calls OpenURLWithBrowser directly; the others go through
// their Start*Login functions with the same manager hook).
func TestBrowserOpenerInvoked(t *testing.T) {
	env := newTestManager(t)
	got := make(chan string, 1)
	env.m.SetBrowserOpener(func(url string) { got <- url })

	env.m.OpenURLWithBrowser("https://example.com/device?user_code=ABCD")

	select {
	case url := <-got:
		if url != "https://example.com/device?user_code=ABCD" {
			t.Fatalf("opener got %q", url)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("browser opener was not invoked")
	}
}
