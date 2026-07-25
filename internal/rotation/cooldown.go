package rotation

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/keystate"
)

// CooldownManager manages key cooldown, backoff, and daily quota locks.
// *Selector implements this interface.
type CooldownManager interface {
	MarkUnavailable(providerID, keyID, model string, statusCode int, body string) time.Time
	ClearError(providerID, keyID, model string)
	MarkDailyQuotaLocked(providerID, keyID, model string, body string) time.Time
	MarkRateLimited(providerID, keyID, model string, duration time.Duration) time.Time
	MarkBalanceLocked(providerID, keyID, model, body string) time.Time
}

func (s *Selector) MarkUnavailable(providerID, keyID, model string, statusCode int, body string) time.Time {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return time.Time{}
	}
	state.Lock()
	defer state.Unlock()

	if state.BackoffLevel < 15 {
		state.BackoffLevel++
	}
	backoff := time.Duration(math.Pow(2, float64(state.BackoffLevel))) * time.Second
	maxBackoff := time.Duration(s.Settings().BackoffMaxSec) * time.Second
	if maxBackoff == 0 {
		maxBackoff = 300 * time.Second
	}
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	unlock := time.Now().Add(backoff)
	state.ModelLocks[model] = unlock
	state.ModelStatus[model] = "cooldown"
	state.ModelErrors[model] = fmt.Sprintf("%d: %s", statusCode, truncate(body, 200))
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return unlock
}

func (s *Selector) ClearError(providerID, keyID, model string) {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return
	}
	state.Lock()
	defer state.Unlock()

	delete(state.ModelLocks, model)
	delete(state.ModelStatus, model)
	delete(state.ModelErrors, model)
	if len(state.ModelLocks) == 0 {
		state.BackoffLevel = 0
	}
	if s.onStateChange != nil {
		s.onStateChange()
	}
}

func (s *Selector) isKeyAvailable(state *keystate.KeyRuntimeState, model string) bool {
	state.Lock()
	defer state.Unlock()

	now := time.Now()

	if unlock, ok := state.ModelLocks[model]; ok {
		if now.Before(unlock) {
			return false
		}
		delete(state.ModelLocks, model)
	}

	for m, unlock := range state.ModelLocks {
		if !now.Before(unlock) {
			delete(state.ModelLocks, m)
			delete(state.ModelStatus, m)
			delete(state.ModelErrors, m)
		}
	}

	return true
}

// BackoffSequence returns the backoff delay in seconds for the nth retry (1-indexed).
// Sequence: 1, 2, 4, 8, 10, 15, 15, 15, 15, 15 (max 10 retries)
func BackoffSequence(n int) int {
	switch {
	case n <= 0:
		return 0
	case n == 1:
		return 1
	case n == 2:
		return 2
	case n == 3:
		return 4
	case n == 4:
		return 8
	case n == 5:
		return 10
	default:
		return 15
	}
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "..."
}

func IsDailyQuota429(body string, model string) bool {
	if body == "" || model == "" {
		return false
	}
	return strings.Contains(strings.ToLower(body), strings.ToLower(model))
}

func nextCSTMidnight05() time.Time {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	now := time.Now().In(loc)
	target := time.Date(now.Year(), now.Month(), now.Day(), 0, 5, 0, 0, loc)
	if now.Before(target) {
		return target
	}
	return target.Add(24 * time.Hour)
}

func (s *Selector) MarkDailyQuotaLocked(providerID, keyID, model string, body string) time.Time {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return time.Time{}
	}
	state.Lock()
	defer state.Unlock()

	unlock := nextCSTMidnight05()
	state.ModelLocks[model] = unlock
	state.ModelStatus[model] = "locked"
	state.ModelErrors[model] = fmt.Sprintf("429 daily quota: %s", truncate(body, 200))
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return unlock
}

// MarkBalanceLocked marks a key as permanently unusable for a model due to an
// account-level balance exhaustion error (e.g. ModelScope 402 insufficient_balance_error).
// Unlike a transient cooldown, this persists until next CST 00:05 — retrying or switching
// to another key of the same broke account is futile.
func (s *Selector) MarkBalanceLocked(providerID, keyID, model, body string) time.Time {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return time.Time{}
	}
	state.Lock()
	defer state.Unlock()

	unlock := nextCSTMidnight05()
	state.ModelLocks[model] = unlock
	state.ModelStatus[model] = "locked"
	state.ModelErrors[model] = fmt.Sprintf("402 insufficient balance: %s", truncate(body, 200))
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return unlock
}

// MarkRateLimited applies a fixed-duration cooldown for a key+model without
// incrementing the exponential backoff level. Used for SenseNova rpm/tpm 429s
// where the limit is per-account with a ~60s sliding window.
func (s *Selector) MarkRateLimited(providerID, keyID, model string, duration time.Duration) time.Time {
	state := s.reg.GetKeyState(providerID, keyID)
	if state == nil {
		return time.Time{}
	}
	state.Lock()
	defer state.Unlock()

	unlock := time.Now().Add(duration)
	state.ModelLocks[model] = unlock
	state.ModelStatus[model] = "cooldown"
	state.ModelErrors[model] = fmt.Sprintf("rate limited: %s (%v)", model, duration)
	if s.onStateChange != nil {
		s.onStateChange()
	}
	return unlock
}

// Compile-time interface checks.
var _ CooldownManager = (*Selector)(nil)
