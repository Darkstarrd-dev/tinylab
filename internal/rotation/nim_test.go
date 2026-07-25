package rotation

import (
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

func setupNIMTest(t *testing.T) (*fakeStore, *Selector) {
	t.Helper()
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID:       "nvidia",
				Name:     "Nvidia",
				BaseURL:  "https://integrate.api.nvidia.com/v1",
				APIType:  "nim",
				IsActive: true,
				Keys: []config.Key{
					{ID: "a", Key: "nv-a", Name: "Key A", Priority: 1, IsActive: true},
					{ID: "b", Key: "nv-b", Name: "Key B", Priority: 1, IsActive: true},
				},
				NIMConfig: &config.NIMSettings{
					RequestCountPerKey: 3,
					MinIntervalMs:      100, // short for test speed
					CooldownLadderMin:  []int{1, 2},
					MaxConcurrent:      1,
				},
			},
		},
		Rotation: config.RotationConfig{
			Strategy:      "failover",
			StickyLimit:   3,
			BackoffMaxSec: 240,
		},
	}
	reg := newFakeStore(cfg)
	sel := New(reg, &cfg.Rotation)
	return reg, sel
}

func TestNIMFailover_RotatesAfterRequestCount(t *testing.T) {
	_, sel := setupNIMTest(t)

	// Send 3 requests on key "a" (RequestCountPerKey=3), then key "b" should be selected.
	var lastID string
	for i := 0; i < 3; i++ {
		sk, err := sel.SelectKey("nvidia", "gpt-4", nil)
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i+1, err)
		}
		lastID = sk.Key.ID
		if lastID != "a" {
			t.Fatalf("call %d: expected key 'a', got %s", i+1, lastID)
		}
		sel.OnNIMRequestSuccess("nvidia", "a", "gpt-4")
	}

	// After 3 successes, key "a" is rotated to back; selecting should get "b".
	sk, err := sel.SelectKey("nvidia", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b' after key 'a' exhausted 3 requests, got %s", sk.Key.ID)
	}
}

func TestNIMFailover_RotateNoCooldown(t *testing.T) {
	_, sel := setupNIMTest(t)

	// Exhaust key "a" by sending 3 requests.
	for i := 0; i < 3; i++ {
		sk, _ := sel.SelectKey("nvidia", "gpt-4", nil)
		if sk.Key.ID != "a" {
			t.Fatalf("expected key 'a', got %s", sk.Key.ID)
		}
		sel.OnNIMRequestSuccess("nvidia", "a", "gpt-4")
	}

	// Exhaust key "b" as well.
	for i := 0; i < 3; i++ {
		sk, _ := sel.SelectKey("nvidia", "gpt-4", nil)
		if sk.Key.ID != "b" {
			t.Fatalf("expected key 'b', got %s", sk.Key.ID)
		}
		sel.OnNIMRequestSuccess("nvidia", "b", "gpt-4")
	}

	// All keys have hit their per-round quota without any 429 cooldown.
	// The design rule is "rotate-to-back without cooldown — a key that has
	// finished its 30 requests is reusable once it naturally reaches the
	// front of the queue": the pool resets the per-round counter and the
	// next pick still works without any cooldown lock being involved.
	sk, err := sel.SelectKey("nvidia", "gpt-4", nil)
	if err != nil {
		t.Fatalf("unexpected error when restarting NIM round: %v", err)
	}
	if sk.Key.ID != "a" && sk.Key.ID != "b" {
		t.Fatalf("expected key 'a' or 'b' after round reset, got %s", sk.Key.ID)
	}

	// Verify no cooldown lock exists for either key (rotation-by-count
	// must never set a ModelLock; only 429 does).
	for _, id := range []string{"a", "b"} {
		state := sel.reg.GetKeyState("nvidia", id)
		state.Lock()
		_, hasLock := state.ModelLocks["gpt-4"]
		state.Unlock()
		if hasLock {
			t.Fatalf("key %s should not have cooldown lock after request-count rotation", id)
		}
	}
}

func TestNIMMark429_CooldownLadder(t *testing.T) {
	_, sel := setupNIMTest(t)

	// First 429: level 1, 1 minute cooldown.
	unlock1 := sel.MarkNIM429("nvidia", "a", "gpt-4")
	if unlock1.IsZero() {
		t.Fatal("expected non-zero unlock time")
	}
	if time.Until(unlock1) < 30*time.Second {
		t.Fatalf("expected unlock at least 1m from now, got %v", time.Until(unlock1))
	}

	state := sel.reg.GetKeyState("nvidia", "a")
	state.Lock()
	if state.NIMCooldownLevel != 1 {
		t.Fatalf("expected NIMCooldownLevel=1, got %d", state.NIMCooldownLevel)
	}
	if state.ModelStatus["gpt-4"] != "cooldown" {
		t.Fatalf("expected model status 'cooldown', got %s", state.ModelStatus["gpt-4"])
	}
	state.Unlock()

	// Second 429: level 2, 2 minute cooldown (capped at ladder[1]=2).
	unlock2 := sel.MarkNIM429("nvidia", "a", "gpt-4")
	if time.Until(unlock2) < time.Until(unlock1) {
		t.Fatal("expected second cooldown to be longer than first")
	}

	state.Lock()
	if state.NIMCooldownLevel != 2 {
		t.Fatalf("expected NIMCooldownLevel=2, got %d", state.NIMCooldownLevel)
	}
	state.Unlock()

	// Third 429: level 3, still 2 minutes (capped at last ladder entry).
	unlock3 := sel.MarkNIM429("nvidia", "a", "gpt-4")
	state.Lock()
	if state.NIMCooldownLevel != 3 {
		t.Fatalf("expected NIMCooldownLevel=3, got %d", state.NIMCooldownLevel)
	}
	state.Unlock()

	// Third should be same duration as second (capped).
	diff := time.Until(unlock3) - time.Until(unlock2)
	if diff > 5*time.Second || diff < -5*time.Second {
		t.Fatalf("expected third and second cooldown durations to be similar, diff=%v", diff)
	}
}

func TestNIMMark429_ResetAfter24h(t *testing.T) {
	_, sel := setupNIMTest(t)

	state := sel.reg.GetKeyState("nvidia", "a")
	state.Lock()
	state.NIMCooldownLevel = 2
	state.NIMLast429Time = time.Now().Add(-25 * time.Hour) // >24h ago
	state.Unlock()

	// A new 429 should reset level to 0 first, then increment to 1.
	sel.MarkNIM429("nvidia", "a", "gpt-4")

	state.Lock()
	if state.NIMCooldownLevel != 1 {
		t.Fatalf("expected NIMCooldownLevel=1 after 24h reset, got %d", state.NIMCooldownLevel)
	}
	state.Unlock()
}

func TestWaitMinInterval(t *testing.T) {
	_, sel := setupNIMTest(t)

	// No previous send → wait should be 0.
	wait := sel.WaitNIMInterval("nvidia", "a", "gpt-4")
	if wait != 0 {
		t.Fatalf("expected wait 0 for first send, got %v", wait)
	}

	// Simulate a recent send.
	state := sel.reg.GetKeyState("nvidia", "a")
	state.Lock()
	state.NIMLastSendTime = time.Now().Add(-50 * time.Millisecond) // 50ms ago, min_interval is 100ms
	state.Unlock()

	wait = sel.WaitNIMInterval("nvidia", "a", "gpt-4")
	if wait <= 0 {
		t.Fatal("expected positive wait when interval not yet elapsed")
	}
	if wait > 100*time.Millisecond {
		t.Fatalf("expected wait <= 100ms, got %v", wait)
	}

	// Wait long enough (>= 100ms).
	state.Lock()
	state.NIMLastSendTime = time.Now().Add(-200 * time.Millisecond)
	state.Unlock()

	wait = sel.WaitNIMInterval("nvidia", "a", "gpt-4")
	if wait != 0 {
		t.Fatalf("expected wait 0 after interval elapsed, got %v", wait)
	}
}

func TestNIMFailover_RequestCountThen429(t *testing.T) {
	_, sel := setupNIMTest(t)

	// Exhaust key "a" via 3 successes.
	for i := 0; i < 3; i++ {
		sk, _ := sel.SelectKey("nvidia", "gpt-4", nil)
		if sk.Key.ID != "a" {
			t.Fatalf("expected key 'a', got %s", sk.Key.ID)
		}
		sel.OnNIMRequestSuccess("nvidia", "a", "gpt-4")
	}

	// Now key "b" should be selected.
	sk, _ := sel.SelectKey("nvidia", "gpt-4", nil)
	if sk.Key.ID != "b" {
		t.Fatalf("expected key 'b', got %s", sk.Key.ID)
	}

	// Key "b" gets a 429, which should put it in cooldown and rotate.
	sel.MarkNIM429("nvidia", "b", "gpt-4")

	// Key "a" is rotated via count, key "b" is in cooldown.
	// All keys exhausted → should go through filterNIMCandidates reset path.
	// After reset, key "a" is available (no cooldown).
	sk, err := sel.SelectKey("nvidia", "gpt-4", nil)
	if err != nil {
		t.Fatalf("expected one key to be available after mixed state, got error: %v", err)
	}
	if sk.Key.ID != "a" {
		t.Fatalf("expected key 'a' after reset, got %s", sk.Key.ID)
	}
}
