package registry

import (
	"sync"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

func crudTestConfig() *config.Config {
	return &config.Config{
		Providers: []config.Provider{
			{
				ID: "p1", Name: "P1", Prefix: "p1", BaseURL: "https://example.com",
				IsActive: true,
				Keys: []config.Key{
					{ID: "k1", Key: "sk-1", Name: "K1", IsActive: true, Priority: 1},
				},
				Models: []config.ModelDef{{ID: "m1", QuotaType: "limited"}},
			},
		},
		Combos: []config.Combo{
			{ID: "c1", Name: "C1", Strategy: "fallback", Models: []string{"p1/m1"}},
		},
	}
}

func TestAddProvider(t *testing.T) {
	r := New(crudTestConfig())
	p := config.Provider{ID: "p2", Name: "P2", Prefix: "p2", BaseURL: "https://example.org", IsActive: true,
		Keys: []config.Key{{ID: "k2", Key: "sk-2", Name: "K2"}}}
	r.AddProvider(p)

	if !r.HasProvider("p2") {
		t.Fatal("HasProvider(p2) = false after AddProvider")
	}
	got, ok := r.GetProvider("p2")
	if !ok {
		t.Fatal("GetProvider(p2) not found")
	}
	if got.Name != "P2" {
		t.Errorf("provider name = %q, want P2", got.Name)
	}
	// Key state should be initialized.
	if ks := r.GetKeyState("p2", "k2"); ks == nil {
		t.Error("expected key state for p2/k2 after AddProvider")
	}
}

func TestGetProviderReturnsCopy(t *testing.T) {
	r := New(crudTestConfig())
	got, ok := r.GetProvider("p1")
	if !ok {
		t.Fatal("GetProvider(p1) not found")
	}
	// Mutating the returned copy must not affect the registry.
	got.Name = "MUTATED"
	got2, _ := r.GetProvider("p1")
	if got2.Name != "P1" {
		t.Errorf("mutation of returned provider leaked into registry: name = %q", got2.Name)
	}
}

func TestAddKeyAndHasKey(t *testing.T) {
	r := New(crudTestConfig())
	if r.HasKey("p1", "k1") != true {
		t.Error("HasKey(p1,k1) should be true")
	}
	k := config.Key{ID: "k2", Key: "sk-2", Name: "K2", IsActive: true}
	if !r.AddKey("p1", k) {
		t.Fatal("AddKey failed")
	}
	if !r.HasKey("p1", "k2") {
		t.Error("HasKey(p1,k2) should be true after AddKey")
	}
	// Missing provider -> AddKey returns false.
	if r.AddKey("nope", k) {
		t.Error("AddKey on missing provider should return false")
	}
}

func TestDeleteKey(t *testing.T) {
	r := New(crudTestConfig())
	if !r.DeleteKey("p1", "k1") {
		t.Fatal("DeleteKey(p1,k1) should return true")
	}
	if r.HasKey("p1", "k1") {
		t.Error("key should be gone after DeleteKey")
	}
	if ks := r.GetKeyState("p1", "k1"); ks != nil {
		t.Error("key state should be removed after DeleteKey")
	}
	// Deleting a non-existent key returns false.
	if r.DeleteKey("p1", "k1") {
		t.Error("DeleteKey on missing key should return false")
	}
}

func TestDeleteProvider(t *testing.T) {
	r := New(crudTestConfig())
	if !r.DeleteProvider("p1") {
		t.Fatal("DeleteProvider(p1) should return true")
	}
	if r.HasProvider("p1") {
		t.Error("provider should be gone after DeleteProvider")
	}
	// Key states must be cleaned up.
	if ks := r.GetKeyState("p1", "k1"); ks != nil {
		t.Error("key state should be removed after DeleteProvider")
	}
	// Deleting a non-existent provider returns false.
	if r.DeleteProvider("p1") {
		t.Error("DeleteProvider on missing provider should return false")
	}
}

func TestUpdateProvider(t *testing.T) {
	r := New(crudTestConfig())
	updates := config.Provider{
		Name: "P1-New", Prefix: "p1", BaseURL: "https://new.example.com",
		APIType: "openai-compatible", IsActive: false, RotationStrategy: "round-robin",
		StickyLimit: 7, InjectStreamOpts: true, NormalizeStreamChunks: true,
		UseProxy: true,
	}
	if !r.UpdateProvider("p1", updates) {
		t.Fatal("UpdateProvider(p1) should return true")
	}
	got, _ := r.GetProvider("p1")
	if got.Name != "P1-New" {
		t.Errorf("Name = %q, want P1-New", got.Name)
	}
	if got.APIType != "openai-compatible" {
		t.Errorf("APIType = %q, want openai-compatible", got.APIType)
	}
	if got.IsActive {
		t.Error("IsActive should be false")
	}
	if got.RotationStrategy != "round-robin" || got.StickyLimit != 7 {
		t.Errorf("rotation fields not updated: strategy=%q sticky=%d", got.RotationStrategy, got.StickyLimit)
	}
	if !got.InjectStreamOpts || !got.NormalizeStreamChunks {
		t.Error("InjectStreamOpts/NormalizeStreamChunks not updated")
	}
	if !got.UseProxy {
		t.Error("UseProxy should be true after UpdateProvider")
	}

	// Toggling UseProxy back to false must also persist.
	if !r.UpdateProvider("p1", config.Provider{Name: "P1-New", UseProxy: false}) {
		t.Fatal("UpdateProvider(p1) toggle UseProxy off should return true")
	}
	got2, _ := r.GetProvider("p1")
	if got2.UseProxy {
		t.Error("UseProxy should be false after second UpdateProvider")
	}

	// Updating a non-existent provider returns false.
	if r.UpdateProvider("ghost", updates) {
		t.Error("UpdateProvider on missing provider should return false")
	}
}

func TestUpdateKey(t *testing.T) {
	r := New(crudTestConfig())
	updates := config.Key{Name: "K1-New", IsActive: false, Priority: 9}
	if !r.UpdateKey("p1", "k1", updates) {
		t.Fatal("UpdateKey(p1,k1) should return true")
	}
	p, _ := r.GetProvider("p1")
	if p.Keys[0].Name != "K1-New" || p.Keys[0].Priority != 9 || p.Keys[0].IsActive {
		t.Errorf("key not updated: %+v", p.Keys[0])
	}
	if r.UpdateKey("p1", "ghost", updates) {
		t.Error("UpdateKey on missing key should return false")
	}
}

func TestAddComboGetCombo(t *testing.T) {
	r := New(crudTestConfig())
	c := config.Combo{ID: "c2", Name: "C2", Strategy: "round-robin", Models: []string{"p1/m1"}}
	r.AddCombo(c)
	if got, ok := r.GetComboByName("C2"); !ok || got.Name != "C2" {
		t.Errorf("GetComboByName(C2) failed: %+v", got)
	}
	if !r.HasCombo("c2") {
		t.Error("HasCombo(c2) should be true")
	}
	if r.DeleteCombo("c2") && r.HasCombo("c2") {
		t.Error("combo should be gone after DeleteCombo")
	}
	if r.DeleteCombo("c2") {
		t.Error("DeleteCombo on missing combo should return false")
	}
}

func TestConcurrentCRUD(t *testing.T) {
	r := New(crudTestConfig())
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := "pk" + string(rune('a'+n%26)) + string(rune('0'+n/26))
			r.AddProvider(config.Provider{ID: id, Name: id, Prefix: id, BaseURL: "https://example.com", IsActive: true,
				Keys: []config.Key{{ID: "k", Key: "sk", Name: "K"}}})
			_, _ = r.GetProvider("p1")
			_ = r.HasProvider(id)
			r.DeleteProvider(id)
		}(i)
	}
	wg.Wait()
	// No panic is the assertion. Verify p1 still intact.
	if !r.HasProvider("p1") {
		t.Error("p1 should survive concurrent CRUD")
	}
}

func TestGetProviderByPrefix(t *testing.T) {
	r := New(crudTestConfig())
	p, ok := r.GetProviderByPrefix("p1")
	if !ok {
		t.Fatal("GetProviderByPrefix(p1) not found")
	}
	if p.ID != "p1" {
		t.Errorf("unexpected provider: %+v", p)
	}
	if _, ok := r.GetProviderByPrefix("ghost"); ok {
		t.Error("GetProviderByPrefix(ghost) should not be found")
	}
}

func TestGetKeyStateNil(t *testing.T) {
	r := New(crudTestConfig())
	// Non-existent key returns nil without panic.
	if ks := r.GetKeyState("p1", "ghost"); ks != nil {
		t.Error("GetKeyState on missing key should return nil")
	}
	if ks := r.GetKeyState("ghost", "k1"); ks != nil {
		t.Error("GetKeyState on missing provider should return nil")
	}
	// Existing key returns a live state pointer.
	ks := r.GetKeyState("p1", "k1")
	if ks == nil {
		t.Fatal("GetKeyState(p1,k1) should return a state")
	}
	// IncInFlight locks internally; do NOT double-lock the same non-reentrant mutex.
	ks.IncInFlight()
	if ks.InFlight != 1 {
		t.Errorf("expected InFlight=1 after IncInFlight, got %d", ks.InFlight)
	}
	ks.DecInFlight()
}

func TestKeyRuntimeState_Quota(t *testing.T) {
	r := New(crudTestConfig())
	ks := r.GetKeyState("p1", "k1")
	if ks == nil {
		t.Fatal("key state nil")
	}
	if ks.GetQuota("m1") != nil {
		t.Error("expected no quota before UpdateQuota")
	}
	ks.UpdateQuota("m1", 100, 80, 200, 150)
	q := ks.GetQuota("m1")
	if q == nil {
		t.Fatal("expected quota after UpdateQuota")
	}
	if q.ModelLimit != 100 || q.ModelRemaining != 80 {
		t.Errorf("quota = %+v", q)
	}
}

func TestSnapshotAndRestoreKeyStates(t *testing.T) {
	r := New(crudTestConfig())
	ks := r.GetKeyState("p1", "k1")
	if ks == nil {
		t.Fatal("key state nil")
	}
	ks.Lock()
	ks.ModelLocks["m1"] = time.Now().Add(time.Hour)
	ks.Unlock()

	snap := r.SnapshotKeyStates()
	// Snapshot keys use the "providerID::keyID" format (convertKey).
	if _, ok := snap["p1::k1"]; !ok {
		t.Fatal("snapshot missing p1::k1")
	}

	// Restore into a fresh registry.
	r2 := New(crudTestConfig())
	if err := r2.RestoreKeyState("p1", "k1", snap["p1::k1"]); err != nil {
		t.Fatalf("RestoreKeyState error: %v", err)
	}
	ks2 := r2.GetKeyState("p1", "k1")
	if ks2 == nil {
		t.Fatal("restored key state nil")
	}
	ks2.Lock()
	_, ok := ks2.ModelLocks["m1"]
	ks2.Unlock()
	if !ok {
		t.Error("restored ModelLocks[m1] missing")
	}

	// Restore into a missing key should error.
	if err := r2.RestoreKeyState("p1", "ghost", snap["p1::k1"]); err == nil {
		t.Error("RestoreKeyState on missing key should error")
	}
}

func TestReorderProvider(t *testing.T) {
	cfg := config.Config{
		Providers: []config.Provider{
			{ID: "p1", Name: "P1"},
			{ID: "p2", Name: "P2"},
			{ID: "p3", Name: "P3"},
			{ID: "p4", Name: "P4"},
		},
	}
	r := New(&cfg)

	// Invalid index
	if err := r.ReorderProvider("p1", 0); err == nil {
		t.Error("expected error for index 0")
	}
	if err := r.ReorderProvider("p1", 5); err == nil {
		t.Error("expected error for index 5")
	}
	// Non-existent provider
	if err := r.ReorderProvider("ghost", 2); err == nil {
		t.Error("expected error for non-existent provider")
	}

	// Move p1 (1-indexed: 1) to targetIndex 3 -> expected order: P2, P3, P1, P4
	if err := r.ReorderProvider("p1", 3); err != nil {
		t.Fatalf("ReorderProvider failed: %v", err)
	}
	list := r.ListProviders()
	expected := []string{"p2", "p3", "p1", "p4"}
	for i, exp := range expected {
		if list[i].ID != exp {
			t.Errorf("at index %d expected %s, got %s", i, exp, list[i].ID)
		}
	}

	// Move p4 (4) to targetIndex 1 -> expected order: P4, P2, P3, P1
	if err := r.ReorderProvider("p4", 1); err != nil {
		t.Fatalf("ReorderProvider failed: %v", err)
	}
	list = r.ListProviders()
	expected = []string{"p4", "p2", "p3", "p1"}
	for i, exp := range expected {
		if list[i].ID != exp {
			t.Errorf("at index %d expected %s, got %s", i, exp, list[i].ID)
		}
	}
}

func TestAliasAndQuickSlotSanitization(t *testing.T) {
	r := New(crudTestConfig())
	// p1 has prefix "p1"
	if !r.UpdateModelAlias("p1", "m1", "p1/my-alias") {
		t.Fatal("UpdateModelAlias failed")
	}
	// Verify that the prefix "p1/" was automatically stripped
	if realID, ok := r.ResolveModelAlias("p1", "my-alias"); !ok || realID != "m1" {
		t.Errorf("expected ResolveModelAlias(my-alias) = m1, got (%s, %v)", realID, ok)
	}
	// Verify that querying with redundant prefix still resolves properly
	if realID, ok := r.ResolveModelAlias("p1", "p1/my-alias"); !ok || realID != "m1" {
		t.Errorf("expected ResolveModelAlias(p1/my-alias) = m1, got (%s, %v)", realID, ok)
	}

	// Test quickslot sanitization
	qs := config.QuickSlot{
		ID:     "qs1",
		Name:   "QS1",
		Models: []string{"p1/p1/m1", "p1/p1/my-alias"},
	}
	r.AddQuickSlot(qs)
	gotQS, ok := r.GetQuickSlot("qs1")
	if !ok {
		t.Fatal("GetQuickSlot failed")
	}
	if gotQS.Models[0] != "p1/m1" || gotQS.Models[1] != "p1/my-alias" {
		t.Errorf("quickslot models not properly sanitized, got: %v", gotQS.Models)
	}
}
