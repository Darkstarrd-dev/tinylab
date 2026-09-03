package rotation

import (
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
)

func setupTestProvider(t *testing.T, priorities []int, strategy string, stickyLimit int) (*fakeStore, *Selector) {
	t.Helper()
	keys := make([]config.Key, len(priorities))
	for i, p := range priorities {
		keys[i] = config.Key{
			ID:       string(rune('a' + i)),
			Key:      "sk-test-" + string(rune('a'+i)),
			Name:     "Key " + string(rune('a'+i)),
			Priority: p,
			IsActive: true,
		}
	}
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID:       "test",
				Name:     "Test",
				BaseURL:  "https://api.example.com",
				IsActive: true,
				Keys:     keys,
			},
		},
		Rotation: config.RotationConfig{
			Strategy:      strategy,
			StickyLimit:   stickyLimit,
			BackoffMaxSec: 240,
		},
	}
	reg := newFakeStore(cfg)
	sel := New(reg, &cfg.Rotation)
	return reg, sel
}

func TestSelectFillFirst_PicksLowestPriority(t *testing.T) {
	_, sel := setupTestProvider(t, []int{3, 1, 2}, "fill-first", 3)
	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' (priority 1), got %s (priority %d)", sk.Key.ID, sk.Key.Priority)
	}
}

func TestSelectFillFirst_ExcludesKeys(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	sk, err := sel.SelectKey("test", "gpt-4", []string{"a"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' (priority 2), got %s (priority %d)", sk.Key.ID, sk.Key.Priority)
	}
}

func TestSelectFillFirst_SkipsInactiveKeys(t *testing.T) {
	reg, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	reg.UpdateKey("test", "a", config.Key{ID: "a", Key: "sk-test-a", Name: "Key a", Priority: 1, IsActive: false})
	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' (priority 2), got %s (priority %d)", sk.Key.ID, sk.Key.Priority)
	}
}

func TestSelectFillFirst_SkipsCooldownKeys(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	sel.MarkUnavailable("test", "a", "gpt-4", 500, "server error")
	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' (priority 2), got %s (priority %d)", sk.Key.ID, sk.Key.Priority)
	}
}

func TestSelectRoundRobin_StickyUntilLimit(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "round-robin", 3)

	first, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 0; i < 2; i++ {
		sk, err := sel.SelectKey("test", "gpt-4", nil)
		if err != nil {
			t.Fatalf("unexpected error on call %d: %v", i+2, err)
		}
		if sk.Key.ID != first.Key.ID {
			t.Fatalf("call %d: expected sticky key %s, got %s", i+2, first.Key.ID, sk.Key.ID)
		}
	}

	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error on call 4: %v", err)
	}
	if sk.Key.ID == first.Key.ID {
		t.Fatalf("expected switch to different key after sticky limit, but got %s again", sk.Key.ID)
	}
}

func TestSelectRoundRobin_SwitchesToLRU(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "round-robin", 3)

	keyA, _ := sel.SelectKey("test", "gpt-4", nil)

	for i := 0; i < 2; i++ {
		sel.SelectKey("test", "gpt-4", nil)
	}

	keyB, _ := sel.SelectKey("test", "gpt-4", nil)

	if keyA.Key.ID == keyB.Key.ID {
		t.Fatal("expected switch to other key after exhausting sticky limit on key A")
	}

	for i := 0; i < 2; i++ {
		sel.SelectKey("test", "gpt-4", nil)
	}

	keyC, _ := sel.SelectKey("test", "gpt-4", nil)

	if keyC.Key.ID != keyA.Key.ID {
		t.Fatalf("expected switch back to key %s (LRU), got %s", keyA.Key.ID, keyC.Key.ID)
	}
}

func TestSelectRoundRobin_FirstUsePicksFirstKey(t *testing.T) {
	_, sel := setupTestProvider(t, []int{2, 1}, "round-robin", 3)

	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if sk.Key.ID != "a" {
		t.Fatalf("expected first key 'a' (all unused), got %s", sk.Key.ID)
	}
}

func TestSelectRoundRobin_SwitchesOnExhaustedSticky_ThreeKeys(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "round-robin", 2)

	used := make(map[string]int)
	for i := 0; i < 6; i++ {
		sk, err := sel.SelectKey("test", "gpt-4", nil)
		if err != nil {
			t.Fatalf("call %d: %v", i+1, err)
		}
		used[sk.Key.ID]++
	}

	if len(used) < 2 {
		t.Fatalf("expected at least 2 different keys across 6 calls, got %d: %v", len(used), used)
	}
}

func TestSelectFailover_PicksLowestPriorityOnFirstCall(t *testing.T) {
	_, sel := setupTestProvider(t, []int{2, 1}, "failover", 3)

	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' (priority 1, never rotated), got %s (priority %d)", sk.Key.ID, sk.Key.Priority)
	}
}

func TestSelectFailover_RotatesToBackOnFailure(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "failover", 3)

	sk1, _ := sel.SelectKey("test", "gpt-4", nil)
	if sk1.Key.ID != "a" {
		t.Fatalf("expected key 'a', got %s", sk1.Key.ID)
	}

	sel.OnKeyFailure("test", sk1.Key.ID, "gpt-4", 500, "server error")

	sk2, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk2.Key.ID != "b" {
		t.Fatalf("expected key 'b' after rotating 'a' to back, got %s", sk2.Key.ID)
	}
}

func TestSelectFailover_QueueCycles(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "failover", 3)

	sk1, _ := sel.SelectKey("test", "gpt-4", nil)
	sk1ID := sk1.Key.ID

	sel.OnKeyFailure("test", "a", "gpt-4", 500, "error")
	sel.OnKeyFailure("test", "b", "gpt-4", 500, "error")

	sk2, _ := sel.SelectKey("test", "gpt-4", nil)
	if sk2.Key.ID != sk1ID {
		t.Fatalf("expected key '%s' to come back to front after both rotated, got %s", sk1ID, sk2.Key.ID)
	}
}

func TestSelectFailover_FillFirstStillUsesMarkUnavailable(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "fill-first", 3)

	sel.OnKeyFailure("test", "a", "gpt-4", 500, "server error")

	state := sel.reg.GetKeyState("test", "a")
	if state == nil {
		t.Fatal("expected state for key a")
	}
	state.Lock()
	hasLock := false
	if _, ok := state.ModelLocks["gpt-4"]; ok {
		hasLock = true
	}
	state.Unlock()
	if !hasLock {
		t.Fatal("expected ModelLocks to be set for fill-first strategy (MarkUnavailable path), indicating cooldown")
	}
}

func TestSonestCooldown_PicksEarliestLock(t *testing.T) {
	reg, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	// Lock key 'a' for gpt-4 in 2s, key 'c' in 500ms. Key 'b' stays available.
	_ = reg
	soon := time.Now().Add(500 * time.Millisecond)
	later := time.Now().Add(2 * time.Second)
	sa := sel.reg.GetKeyState("test", "a")
	sa.Lock()
	sa.ModelLocks["gpt-4"] = later
	sa.ModelErrors["gpt-4"] = "429: rate limited"
	sa.Unlock()
	sc := sel.reg.GetKeyState("test", "c")
	sc.Lock()
	sc.ModelLocks["gpt-4"] = soon
	sc.ModelErrors["gpt-4"] = "500: internal"
	sc.Unlock()

	info, ok := sel.SonestCooldown("test", "gpt-4", nil)
	if !ok {
		t.Fatal("expected ok=true with locked keys")
	}
	if info.KeyID != "c" {
		t.Fatalf("expected soonest key 'c', got %s", info.KeyID)
	}
	if info.Reason != "500: internal" {
		t.Fatalf("expected reason from key c, got %q", info.Reason)
	}
}

func TestSonestCooldown_SkipsExcluded(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "fill-first", 2)
	// Lock key 'a' soon, key 'b' later. Exclude 'a' (already failed this req).
	soon := time.Now().Add(400 * time.Millisecond)
	later := time.Now().Add(2 * time.Second)
	sa := sel.reg.GetKeyState("test", "a")
	sa.Lock()
	sa.ModelLocks["gpt-4"] = soon
	sa.Unlock()
	sb := sel.reg.GetKeyState("test", "b")
	sb.Lock()
	sb.ModelLocks["gpt-4"] = later
	sb.Unlock()

	info, ok := sel.SonestCooldown("test", "gpt-4", []string{"a"})
	if !ok {
		t.Fatal("expected ok=true (key b is locked and not excluded)")
	}
	if info.KeyID != "b" {
		t.Fatalf("expected soonest non-excluded key 'b', got %s", info.KeyID)
	}
}

func TestSonestCooldown_NoLockedKey(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2}, "fill-first", 2)
	// No key is locked → not ok.
	if _, ok := sel.SonestCooldown("test", "gpt-4", nil); ok {
		t.Fatal("expected ok=false when no key is locked")
	}
}

func TestSonestCooldown_ExpiredLockIgnored(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1}, "fill-first", 1)
	// Lock in the past → key is actually available → not counted.
	sa := sel.reg.GetKeyState("test", "a")
	sa.Lock()
	sa.ModelLocks["gpt-4"] = time.Now().Add(-1 * time.Second)
	sa.Unlock()
	if _, ok := sel.SonestCooldown("test", "gpt-4", nil); ok {
		t.Fatal("expected ok=false when lock already expired")
	}
}

func TestSelectKey_ManualPinOverridesStrategy(t *testing.T) {
	for _, strategy := range []string{"fill-first", "round-robin", "failover"} {
		_, sel := setupTestProvider(t, []int{1, 2, 3}, strategy, 3)
		sel.SetManualKey("test", "c")
		sk, err := sel.SelectKey("test", "gpt-4", nil)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", strategy, err)
		}
		if sk.Key.ID != "c" {
			t.Fatalf("%s: expected pinned key 'c', got %s", strategy, sk.Key.ID)
		}
	}
}

func TestSelectKey_ManualPinFallsBackWhenExcluded(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	sel.SetManualKey("test", "c")
	// Pinned key already failed this request (excluded) → strategy picks 'a'.
	sk, err := sel.SelectKey("test", "gpt-4", []string{"c"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "a" {
		t.Fatalf("expected fallback key 'a', got %s", sk.Key.ID)
	}
}

func TestSelectKey_ManualPinFallsBackWhenLocked(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	sel.SetManualKey("test", "a")
	// Pinned key 'a' is cooldown-locked for gpt-4 → strategy picks 'b'.
	sel.MarkUnavailable("test", "a", "gpt-4", 500, "server error")
	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected fallback key 'b', got %s", sk.Key.ID)
	}
}

func TestSelectKey_ManualPinCleared(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "fill-first", 3)
	sel.SetManualKey("test", "c")
	sel.SetManualKey("test", "")
	if pin := sel.ManualKey("test"); pin != "" {
		t.Fatalf("expected pin cleared, got %q", pin)
	}
	sk, err := sel.SelectKey("test", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "a" {
		t.Fatalf("expected strategy pick 'a' after clearing pin, got %s", sk.Key.ID)
	}
}
