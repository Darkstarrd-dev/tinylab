package rotation

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/config"
)

func setupTest(t *testing.T) (*fakeStore, *Selector) {
	t.Helper()
	cfg := &config.Config{
		Providers: []config.Provider{
			{
				ID:       "test",
				Name:     "Test",
				BaseURL:  "https://api.example.com",
				IsActive: true,
				Keys: []config.Key{
					{ID: "a", Key: "sk-a", Name: "Key A", Priority: 1, IsActive: true},
					{ID: "b", Key: "sk-b", Name: "Key B", Priority: 2, IsActive: true},
				},
			},
		},
		Rotation: config.RotationConfig{
			Strategy:      "fill-first",
			StickyLimit:   3,
			BackoffMaxSec: 240,
		},
	}
	reg := newFakeStore(cfg)
	sel := New(reg, &cfg.Rotation)
	return reg, sel
}

func TestMarkUnavailable_ExponentialBackoff(t *testing.T) {
	reg, sel := setupTest(t)
	state := reg.GetKeyState("test", "a")

	state.Lock()
	initialLevel := state.BackoffLevel
	state.Unlock()

	unlock1 := sel.MarkUnavailable("test", "a", "gpt-4", 500, "internal error")

	state.Lock()
	if state.BackoffLevel != initialLevel+1 {
		t.Fatalf("expected BackoffLevel %d, got %d", initialLevel+1, state.BackoffLevel)
	}
	state.Unlock()

	if unlock1.IsZero() {
		t.Fatal("expected non-zero unlock time")
	}

	expectedBackoff := 1 * time.Second
	if time.Until(unlock1) < expectedBackoff-100*time.Millisecond {
		t.Fatalf("expected unlock at least %v from now, got %v", expectedBackoff, time.Until(unlock1))
	}

	unlock2 := sel.MarkUnavailable("test", "a", "gpt-4", 500, "internal error")

	state.Lock()
	if state.BackoffLevel != initialLevel+2 {
		t.Fatalf("expected BackoffLevel %d, got %d", initialLevel+2, state.BackoffLevel)
	}
	state.Unlock()

	if time.Until(unlock2) < time.Until(unlock1) {
		t.Fatal("expected second backoff to be longer than first")
	}
}

func TestMarkUnavailable_429Backoff(t *testing.T) {
	reg, sel := setupTest(t)
	state := reg.GetKeyState("test", "a")

	state.Lock()
	state.BackoffLevel = 3
	state.Unlock()

	unlock := sel.MarkUnavailable("test", "a", "gpt-4", 429, "rate limit exceeded")

	state.Lock()
	if state.BackoffLevel != 4 {
		t.Fatalf("expected BackoffLevel 4, got %d", state.BackoffLevel)
	}
	if state.ModelStatus["gpt-4"] != "cooldown" {
		t.Fatalf("expected model status 'cooldown', got %s", state.ModelStatus["gpt-4"])
	}
	state.Unlock()

	if unlock.IsZero() {
		t.Fatal("expected non-zero unlock time")
	}

	expectedBackoff := time.Duration(math.Pow(2, 3)) * time.Second
	if time.Until(unlock) < expectedBackoff-100*time.Millisecond {
		t.Fatalf("expected unlock at least %v from now, got %v", expectedBackoff, time.Until(unlock))
	}
}

func TestClearError_ClearsModelLock(t *testing.T) {
	reg, sel := setupTest(t)
	sel.MarkUnavailable("test", "a", "gpt-4", 500, "error")
	state := reg.GetKeyState("test", "a")

	state.Lock()
	if _, ok := state.ModelLocks["gpt-4"]; !ok {
		t.Fatal("expected model lock to exist before ClearError")
	}
	if state.BackoffLevel == 0 {
		t.Fatal("expected BackoffLevel > 0 before ClearError")
	}
	state.Unlock()

	sel.ClearError("test", "a", "gpt-4")

	state.Lock()
	if _, ok := state.ModelLocks["gpt-4"]; ok {
		t.Fatal("expected model lock to be removed after ClearError")
	}
	if state.BackoffLevel != 0 {
		t.Fatalf("expected BackoffLevel reset to 0, got %d", state.BackoffLevel)
	}
	if _, ok := state.ModelStatus["gpt-4"]; ok {
		t.Fatalf("expected model status 'gpt-4' to be removed, got %s", state.ModelStatus["gpt-4"])
	}
	state.Unlock()
}

func TestClearError_KeepsOtherModelLocks(t *testing.T) {
	reg, sel := setupTest(t)
	sel.MarkUnavailable("test", "a", "gpt-4", 500, "error")
	sel.MarkUnavailable("test", "a", "claude-3", 500, "error")
	state := reg.GetKeyState("test", "a")

	sel.ClearError("test", "a", "gpt-4")

	state.Lock()
	if _, ok := state.ModelLocks["gpt-4"]; ok {
		t.Fatal("expected gpt-4 lock to be removed")
	}
	if _, ok := state.ModelLocks["claude-3"]; !ok {
		t.Fatal("expected claude-3 lock to remain")
	}
	if state.BackoffLevel == 0 {
		t.Fatal("expected BackoffLevel > 0 because other locks remain")
	}
	state.Unlock()
}

func TestIsKeyAvailable_ExpiredLockCleaned(t *testing.T) {
	reg, sel := setupTest(t)
	state := reg.GetKeyState("test", "a")

	state.Lock()
	state.ModelLocks["gpt-4"] = time.Now().Add(-time.Hour)
	state.ModelLocks["claude-3"] = time.Now().Add(1 * time.Hour)
	state.Unlock()

	if !sel.isKeyAvailable(state, "gpt-4") {
		t.Fatal("expected key to be available for gpt-4 (expired lock)")
	}

	state.Lock()
	if _, ok := state.ModelLocks["gpt-4"]; ok {
		t.Fatal("expected expired gpt-4 lock to be removed")
	}
	if _, ok := state.ModelLocks["claude-3"]; !ok {
		t.Fatal("expected claude-3 lock to remain")
	}
	state.Unlock()

	if sel.isKeyAvailable(state, "claude-3") {
		t.Fatal("expected key to be unavailable for claude-3 (active lock)")
	}
}

func TestIsDailyQuota429(t *testing.T) {
	tests := []struct {
		body  string
		model string
		want  bool
	}{
		// Positive: genuine daily-quota bodies must lock until next CST 00:05.
		{`{"error":{"message":"You have exceeded today's quota for model ZhipuAI/GLM-5.2, please try again tomorrow"}}`, "ZhipuAI/GLM-5.2", true},
		{`{"error":{"message":"You have reached today's quota for model gpt-4o-mini"}}`, "gpt-4o-mini", true},
		// Negative: transient rate-limit bodies name the model but must NOT
		// trigger the daily-quota lock (the pre-fix bug: single-key providers
		// went all-day 502 from one transient 429).
		{`{"error":{"message":"Rate limit reached for gpt-4o-mini in organization org-abc on requests per day (RPD): Limit 10000, Used 9999, Requested 1. Please try again in 14h59m43s. See https://platform.openai.com/docs/guides/rate-limits"}}`, "gpt-4o-mini", false},
		{`{"type":"error","error":{"type":"rate_limit_error","message":"rate limit reached for model: claude-sonnet-4-20250514 with max_tokens 8192, please retry after 2026-01-01T00:00:00Z"}}`, "claude-sonnet-4-20250514", false},
		{`{"error":{"code":"1110","message":"Rate limit exceeded for model ZhipuAI/GLM-5.2, please try again later"}}`, "ZhipuAI/GLM-5.2", false},
		// Negative: a quota-worded body with a duration retry hint is a
		// transient window, not a daily wall.
		{`{"error":{"message":"Quota exceeded for model gpt-4o, please try again in 20 seconds"}}`, "gpt-4o", false},
		{`{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan"}}`, "ZhipuAI/GLM-5.2", false},
		{"", "gpt-4", false},
		{"rate limit exceeded", "", false},
		{"rate limit exceeded", "gpt-4", false},
	}
	for _, tt := range tests {
		got := IsDailyQuota429(tt.body, tt.model)
		if got != tt.want {
			t.Errorf("IsDailyQuota429(%q, %q) = %v, want %v", tt.body, tt.model, got, tt.want)
		}
	}
}

func TestMarkDailyQuotaLocked(t *testing.T) {
	reg, sel := setupTest(t)
	state := reg.GetKeyState("test", "a")

	unlock := sel.MarkDailyQuotaLocked("test", "a", "gpt-4", "daily quota exceeded for gpt-4")

	state.Lock()
	if state.ModelStatus["gpt-4"] != "locked" {
		t.Fatalf("expected model status 'locked', got %s", state.ModelStatus["gpt-4"])
	}
	if _, ok := state.ModelLocks["gpt-4"]; !ok {
		t.Fatal("expected model lock to exist")
	}
	state.Unlock()

	if unlock.IsZero() {
		t.Fatal("expected non-zero unlock time")
	}

	loc, _ := time.LoadLocation("Asia/Shanghai")
	midnight := time.Date(time.Now().In(loc).Year(), time.Now().In(loc).Month(), time.Now().In(loc).Day()+1, 0, 5, 0, 0, loc)
	if time.Until(unlock) > time.Until(midnight)+time.Minute {
		t.Fatalf("expected unlock around next CST midnight+5min, got %v, diff=%v", unlock, time.Until(unlock))
	}
}

func TestMarkBalanceLocked(t *testing.T) {
	reg, sel := setupTest(t)
	state := reg.GetKeyState("test", "a")

	unlock := sel.MarkBalanceLocked("test", "a", "gpt-4", `{"error":{"http_code":"402","message":"insufficient balance (1008)","type":"insufficient_balance_error"}}`)

	state.Lock()
	if state.ModelStatus["gpt-4"] != "locked" {
		t.Fatalf("expected model status 'locked', got %s", state.ModelStatus["gpt-4"])
	}
	if _, ok := state.ModelLocks["gpt-4"]; !ok {
		t.Fatal("expected model lock to exist")
	}
	if !strings.Contains(state.ModelErrors["gpt-4"], "insufficient balance") {
		t.Fatalf("expected last error to mention insufficient balance, got %q", state.ModelErrors["gpt-4"])
	}
	state.Unlock()

	if unlock.IsZero() {
		t.Fatal("expected non-zero unlock time")
	}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	midnight := time.Date(time.Now().In(loc).Year(), time.Now().In(loc).Month(), time.Now().In(loc).Day()+1, 0, 5, 0, 0, loc)
	if time.Until(unlock) > time.Until(midnight)+time.Minute {
		t.Fatalf("expected unlock around next CST midnight+5min, got %v", unlock)
	}
}

func TestIsBalanceExhausted(t *testing.T) {
	tests := []struct {
		status int
		body   string
		want   bool
	}{
		{402, `{"error":{"http_code":"402","message":"insufficient balance (1008)","type":"insufficient_balance_error"}}`, true},
		{402, `{"error":{"message":"Insufficient Balance"}}`, true},
		{402, `{"error":{"message":"rate limit exceeded"}}`, false},
		{429, `{"error":{"type":"insufficient_balance_error"}}`, false},
		{200, `{"error":{"type":"insufficient_balance_error"}}`, false},
		{402, ``, false},
	}
	for _, tt := range tests {
		got := IsBalanceExhausted(tt.status, tt.body)
		if got != tt.want {
			t.Errorf("IsBalanceExhausted(%d, %q) = %v, want %v", tt.status, tt.body, got, tt.want)
		}
	}
}

func TestNextCSTMidnight05(t *testing.T) {
	unlock := nextCSTMidnight05()
	loc, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Now().In(loc)

	if unlock.Before(now) {
		t.Fatal("expected unlock in the future")
	}

	target := time.Date(now.Year(), now.Month(), now.Day(), 0, 5, 0, 0, loc)
	if now.Before(target) {
		if unlock.Sub(target) > time.Second {
			t.Fatalf("expected unlock around today 00:05 CST, got %v", unlock)
		}
	} else {
		expected := target.Add(24 * time.Hour)
		if unlock.Sub(expected) > time.Second {
			t.Fatalf("expected unlock around tomorrow 00:05 CST, got %v", unlock)
		}
	}
}

func TestBackoffSequence(t *testing.T) {
	expected := []int{0, 1, 2, 4, 8, 10, 15, 15, 15, 15, 15}
	for n, want := range expected {
		got := BackoffSequence(n)
		if got != want {
			t.Errorf("BackoffSequence(%d) = %d, want %d", n, got, want)
		}
	}
}
