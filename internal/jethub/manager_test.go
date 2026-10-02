package jethub

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/tinylab/tinylab/internal/config"
)

// testEnv bundles a manager with its temp dir and AES key for reload tests.
type testEnv struct {
	m   *Manager
	dir string
	key string
}

// newTestManager builds a Manager over a temp dir with a throwaway AES key.
func newTestManager(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	key, err := config.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	m, err := NewManager(dir, key, nil)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	return &testEnv{m: m, dir: dir, key: key}
}

// fakeRegistry is a minimal BridgeDeps implementation for unit tests.
type fakeRegistry struct {
	providers map[string]config.Provider
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{providers: map[string]config.Provider{}}
}

func (f *fakeRegistry) GetProviderByPrefix(prefix string) (*config.Provider, bool) {
	for _, p := range f.providers {
		if p.Prefix == prefix {
			v := p
			return &v, true
		}
	}
	return nil, false
}

func (f *fakeRegistry) GetProvider(id string) (*config.Provider, bool) {
	p, ok := f.providers[id]
	return &p, ok
}

func (f *fakeRegistry) AddProvider(p config.Provider)    { f.providers[p.ID] = p }
func (f *fakeRegistry) UpsertProvider(p config.Provider) { f.providers[p.ID] = p }

func (f *fakeRegistry) UpdateProvider(id string, updates config.Provider) bool {
	if _, ok := f.providers[id]; !ok {
		return false
	}
	f.providers[id] = updates
	return true
}

func (f *fakeRegistry) DeleteProvider(id string) bool {
	if _, ok := f.providers[id]; !ok {
		return false
	}
	delete(f.providers, id)
	return true
}

func (f *fakeRegistry) HasProvider(id string) bool {
	_, ok := f.providers[id]
	return ok
}

func (f *fakeRegistry) ListProviders() []config.Provider {
	out := make([]config.Provider, 0, len(f.providers))
	for _, p := range f.providers {
		out = append(out, p)
	}
	return out
}

func TestProvidersMetadata(t *testing.T) {
	metas := Providers()
	if len(metas) != 13 {
		t.Fatalf("expected 13 providers, got %d", len(metas))
	}
	if !ProviderExists("codearts") || !ProviderExists("minimax") || !ProviderExists("opencode") || !ProviderExists("zcode") {
		t.Fatal("codearts/minimax/opencode/zcode should be known providers")
	}
	if ProviderExists("nope") {
		t.Fatal("unknown provider should not exist")
	}
}

func TestProviderIDRoundTrip(t *testing.T) {
	if got := ProviderID("codearts"); got != "jethub-codearts" {
		t.Fatalf("unexpected provider id %q", got)
	}
	provider, ok := ProviderNameFromID("jethub-codearts")
	if !ok || provider != "codearts" {
		t.Fatalf("round trip failed: %q %v", provider, ok)
	}
	if _, ok := ProviderNameFromID("openai-main"); ok {
		t.Fatal("non-jethub id should not parse")
	}
}

func TestCredentialsRoundTripEncrypted(t *testing.T) {
	env := newTestManager(t)
	m := env.m
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{
		ID: id, Provider: "codearts", Nickname: "acct1",
		Enabled: true, CredentialRef: ref, CreatedAt: 1234,
	}); err != nil {
		t.Fatalf("add account: %v", err)
	}
	cred := []byte(`{"access_token":"tok-123"}`)
	if err := m.SetCredential("codearts", ref, cred, 999, true); err != nil {
		t.Fatalf("set credential: %v", err)
	}
	got, ok := m.Credential("codearts", ref)
	if !ok || string(got) != string(cred) {
		t.Fatalf("credential round trip failed: %q %v", got, ok)
	}

	// File on disk must not contain plaintext credential content.
	data, err := os.ReadFile(filepath.Join(env.dir, "credentials.json"))
	if err != nil {
		t.Fatalf("read credentials file: %v", err)
	}
	if len(data) == 0 || data[0] != '{' {
		t.Fatal("expected JSON envelope")
	}
	var env2 struct{ Enc string }
	if err := json.Unmarshal(data, &env2); err != nil || env2.Enc == "" {
		t.Fatalf("unexpected credentials envelope: %s", data)
	}
	for _, probe := range []string{"tok-123", "access_token"} {
		if containsBytes(data, []byte(probe)) {
			t.Fatalf("plaintext %q leaked into credentials file", probe)
		}
	}

	// Reload from disk keeps the credential.
	m2, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatalf("reload manager: %v", err)
	}
	got2, ok := m2.Credential("codearts", ref)
	if !ok || string(got2) != string(cred) {
		t.Fatalf("credential reload failed: %q %v", got2, ok)
	}
}

func containsBytes(haystack, needle []byte) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(h, n []byte) int {
	for i := 0; i+len(n) <= len(h); i++ {
		match := true
		for j := range n {
			if h[i+j] != n[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func TestAccountsCRUD(t *testing.T) {
	m := newTestManager(t).m
	id, ref := NewAccountID("codearts")
	if err := m.AddAccount(Account{ID: id, Provider: "codearts", Nickname: id, Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	if m.AccountCount("codearts") != 1 || m.EnabledAccountCount("codearts") != 0 {
		t.Fatalf("counts wrong: %d %d", m.AccountCount("codearts"), m.EnabledAccountCount("codearts"))
	}
	if err := m.SetCredential("codearts", ref, []byte(`{"access_token":"x"}`), 0, false); err != nil {
		t.Fatal(err)
	}
	if m.EnabledAccountCount("codearts") != 1 {
		t.Fatalf("enabled count with credential should be 1")
	}
	if err := m.UpdateAccount(id, func(a *Account) { a.Enabled = false; a.Nickname = "renamed" }); err != nil {
		t.Fatal(err)
	}
	acc, ok := m.FindAccount(id)
	if !ok || acc.Enabled || acc.Nickname != "renamed" {
		t.Fatalf("patch failed: %+v %v", acc, ok)
	}
	if m.EnabledAccountCount("codearts") != 0 {
		t.Fatal("disabled account should not count as enabled")
	}
	if err := m.DeleteAccount(id); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.FindAccount(id); ok {
		t.Fatal("account should be gone")
	}
	if _, ok := m.Credential("codearts", ref); ok {
		t.Fatal("credential should be gone with the account")
	}
}

func TestModelBlacklist(t *testing.T) {
	m := newTestManager(t).m
	if err := m.SetModelDisabled("codearts", "GLM-5.2", true); err != nil {
		t.Fatal(err)
	}
	if !m.DisabledModels("codearts")["GLM-5.2"] {
		t.Fatal("model should be disabled")
	}
	if err := m.SetModelDisabled("codearts", "GLM-5.2", false); err != nil {
		t.Fatal(err)
	}
	if len(m.DisabledModels("codearts")) != 0 {
		t.Fatal("blacklist should be empty after re-enable")
	}
}

func TestValidPrefix(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"codearts", true},
		{"a", true},
		{"ab-cd-9", true},
		{"", false},
		{"A", false},
		{"with space", false},
		{"dot.name", false},
		{"中文", false},
	}
	for _, c := range cases {
		if got := ValidPrefix(c.in); got != c.want {
			t.Fatalf("ValidPrefix(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestBridgeSetPrefixRegistersProvider(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)

	id, ref := NewAccountID("codearts")
	_ = m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref})
	_ = m.SetCredential("codearts", ref, []byte(`{"access_token":"tok"}`), 0, false)

	if err := b.SetPrefix("codearts", "codearts"); err != nil {
		t.Fatalf("set prefix: %v", err)
	}
	p, ok := reg.GetProvider("jethub-codearts")
	if !ok {
		t.Fatal("bridged provider not registered")
	}
	if p.APIType != APIType || p.Prefix != "codearts" || len(p.Keys) != 1 || p.Keys[0].Key != "tok" {
		t.Fatalf("bridged provider wrong: %+v", p)
	}
	if len(p.Models) == 0 {
		t.Fatal("bridged provider should carry the static model table")
	}

	// Key sync: disable the account → keys drop to 0, provider deactivates.
	_ = m.UpdateAccount(id, func(a *Account) { a.Enabled = false })
	if err := b.SyncKeys("codearts"); err != nil {
		t.Fatal(err)
	}
	p, _ = reg.GetProvider("jethub-codearts")
	if len(p.Keys) != 0 || p.IsActive {
		t.Fatalf("disabled account should remove keys: %+v", p)
	}
	// ...deleting the account and syncing removes the bridged provider.
	_ = m.DeleteAccount(id)
	if err := b.SyncKeys("codearts"); err != nil {
		t.Fatal(err)
	}
	if reg.HasProvider("jethub-codearts") {
		t.Fatal("bridged provider should be removed with zero keys")
	}
}

func TestBridgeConflictDetection(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	// Simulate an existing user provider with prefix "taken".
	reg.AddProvider(config.Provider{ID: "prov-x", Prefix: "taken"})
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)

	err := b.SetPrefix("codearts", "taken")
	if err == nil {
		t.Fatal("expected conflict error")
	}
	if _, ok := err.(*ConflictError); !ok {
		t.Fatalf("expected *ConflictError, got %T", err)
	}
	// Second jethub provider with the same prefix also conflicts.
	if err := b.SetPrefix("codearts", "c1"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPrefix("qoder", "c1"); err == nil {
		t.Fatal("second jethub provider with same prefix should conflict")
	}
}

func TestBridgeClearPrefixRemovesProvider(t *testing.T) {
	m := newTestManager(t).m
	reg := newFakeRegistry()
	b := NewBridge(m, reg)
	RegisterDefaultProducts(b)
	// Seed one usable account so the bridge has keys to register.
	id, ref := NewAccountID("codearts")
	_ = m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref})
	_ = m.SetCredential("codearts", ref, []byte(`{"access_token":"tok"}`), 0, false)
	if err := b.SetPrefix("codearts", "c1"); err != nil {
		t.Fatal(err)
	}
	if !reg.HasProvider("jethub-codearts") {
		t.Fatal("expected bridged provider")
	}
	if err := b.ClearPrefix("codearts"); err != nil {
		t.Fatal(err)
	}
	if reg.HasProvider("jethub-codearts") {
		t.Fatal("bridged provider should be removed after ClearPrefix")
	}
	if m.Prefix("codearts") != "" {
		t.Fatal("stored prefix should be cleared")
	}
}

func TestBridgeRestoresFromStorage(t *testing.T) {
	env := newTestManager(t)
	m := env.m
	reg1 := newFakeRegistry()
	b1 := NewBridge(m, reg1)
	RegisterDefaultProducts(b1)
	// Seed one usable account so the bridge has keys to register.
	id, ref := NewAccountID("codearts")
	_ = m.AddAccount(Account{ID: id, Provider: "codearts", Enabled: true, CredentialRef: ref})
	_ = m.SetCredential("codearts", ref, []byte(`{"access_token":"tok"}`), 0, false)
	if err := b1.SetPrefix("codearts", "c1"); err != nil {
		t.Fatal(err)
	}
	// New "process": fresh manager over the same dir + fresh registry.
	m2, err := NewManager(env.dir, env.key, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg2 := newFakeRegistry()
	b2 := NewBridge(m2, reg2)
	RegisterDefaultProducts(b2)
	b2.RestoreBridges()
	if !reg2.HasProvider("jethub-codearts") {
		t.Fatal("RestoreBridges should re-register stored prefixes")
	}
	if p, _ := reg2.GetProvider("jethub-codearts"); p.Prefix != "c1" {
		t.Fatalf("restored prefix wrong: %q", p.Prefix)
	}
}

func TestAugmentDispatch(t *testing.T) {
	m := newTestManager(t).m
	called := ""
	m.SetAugmenter("codearts", func(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
		called = providerID + "/" + keyID
		return append(body, []byte(` `)...), nil
	})
	req, _ := http.NewRequest(http.MethodPost, "http://x", nil)
	out, err := m.Augment(req, []byte(`{"a":1}`), "jethub-codearts", "acct", "deepseek-v4-flash")
	if err != nil {
		t.Fatal(err)
	}
	if called != "jethub-codearts/acct" {
		t.Fatalf("augmenter not dispatched: %q", called)
	}
	if string(out) != `{"a":1} ` {
		t.Fatalf("body not passed through: %q", out)
	}
	// Unregistered provider → body unchanged.
	out, err = m.Augment(req, []byte(`{"a":1}`), "jethub-qoder", "acct", "m")
	if err != nil || string(out) != `{"a":1}` {
		t.Fatalf("default dispatch should be identity: %q %v", out, err)
	}
}
