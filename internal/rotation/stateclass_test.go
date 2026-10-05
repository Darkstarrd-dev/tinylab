package rotation

import (
	"testing"
	"time"
)

// TestStateChangeHookClasses verifies the F-08 persistence-class split at the
// rotation layer: cooldown/failure paths must hit the critical hook
// (onStateChange), while selection counters and failover rotation must hit
// only the stats hook (onStatsChange).
func TestStateChangeHookClasses(t *testing.T) {
	reg, sel := setupTestProvider(t, []int{1, 2}, "fill-first", 3)

	var critical, stats int
	sel.SetStateHook(func() { critical++ })
	sel.SetStatsHook(func() { stats++ })

	// SelectKey: stats-only (LastUsedAt/ConsecCount changed, no lock).
	if _, err := sel.SelectKey("test", "gpt-4", nil); err != nil {
		t.Fatalf("SelectKey: %v", err)
	}
	if stats != 1 || critical != 0 {
		t.Fatalf("SelectKey should call stats hook only, got critical=%d stats=%d", critical, stats)
	}

	// MarkUnavailable: critical (ModelLock + BackoffLevel).
	sel.MarkUnavailable("test", "b", "gpt-4", 500, "server error")
	if critical != 1 || stats != 1 {
		t.Fatalf("MarkUnavailable should call critical hook, got critical=%d stats=%d", critical, stats)
	}

	// ClearError: critical (lock removal + possible level reset).
	sel.ClearError("test", "b", "gpt-4")
	if critical != 2 || stats != 1 {
		t.Fatalf("ClearError should call critical hook, got critical=%d stats=%d", critical, stats)
	}

	// RotateToBack: stats-only (RotatedAt + error note, no lock).
	sel.RotateToBack("test", "b", "gpt-4", 500, "server error")
	if critical != 2 || stats != 2 {
		t.Fatalf("RotateToBack should call stats hook only, got critical=%d stats=%d", critical, stats)
	}

	// MarkRateLimited: critical (fixed-duration lock).
	sel.MarkRateLimited("test", "b", "gpt-4", 60*time.Second)
	if critical != 3 || stats != 2 {
		t.Fatalf("MarkRateLimited should call critical hook, got critical=%d stats=%d", critical, stats)
	}

	// MarkBalanceLocked: critical (daily lock).
	sel.MarkBalanceLocked("test", "b", "gpt-4", "insufficient balance")
	if critical != 4 || stats != 2 {
		t.Fatalf("MarkBalanceLocked should call critical hook, got critical=%d stats=%d", critical, stats)
	}

	// MarkDailyQuotaLocked: critical (daily quota lock).
	sel.MarkDailyQuotaLocked("test", "b", "gpt-4", "daily quota")
	if critical != 5 || stats != 2 {
		t.Fatalf("MarkDailyQuotaLocked should call critical hook, got critical=%d stats=%d", critical, stats)
	}

	reg.GetKeyState("test", "a")
}

// TestSelectKeyNoCriticalWriteUnderLoad is the F-08 core regression: repeated
// successful selections under steady load must never touch the critical hook.
func TestSelectKeyNoCriticalWriteUnderLoad(t *testing.T) {
	_, sel := setupTestProvider(t, []int{1, 2, 3}, "round-robin", 1)

	var critical int
	sel.SetStateHook(func() { critical++ })

	for i := range 100 {
		if _, err := sel.SelectKey("test", "gpt-4", nil); err != nil {
			t.Fatalf("SelectKey iteration %d: %v", i, err)
		}
	}
	if critical != 0 {
		t.Fatalf("steady selection load triggered %d critical persistence writes, want 0", critical)
	}
}
