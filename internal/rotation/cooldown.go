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
	// SonestCooldown returns the soonest-expiring ModelLock[model] among the
	// provider's active keys that are NOT in excludeKeyIDs and are currently
	// locked (lock in the future). Used by the proxy to wait for a cooldown to
	// expire instead of instantly returning 502 when every available key is
	// merely cooling down (e.g. a concurrent 429 locked the only key). Returns
	// ok=false when no such locked key exists (keys are absent, all excluded,
	// or genuinely available — SelectKey should already have returned one).
	SonestCooldown(providerID, model string, excludeKeyIDs []string) (CooldownInfo, bool)
}

// CooldownInfo describes the soonest-expiring cooldown among a provider's keys.
type CooldownInfo struct {
	Deadline time.Time // when ModelLock[model] expires
	KeyID    string
	KeyName  string
	Reason   string // ModelErrors[model] ("%d: <body>"), empty if none recorded
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
	lower := strings.ToLower(body)
	if !strings.Contains(lower, strings.ToLower(model)) {
		return false
	}
	// The body must indicate actual daily-quota exhaustion, not a transient
	// rate limit. A plain 429 whose body merely names the model (OpenAI
	// "Rate limit reached for gpt-4o-mini ... Please try again in ...",
	// Anthropic "rate_limit_error ... model: claude-...", Zhipu
	// "rate limit exceeded for model ...") used to lock the key until the
	// next CST 00:05, turning one transient 429 into an all-day 502 for
	// single-key providers. Require a quota keyword plus a daily/exhaustion
	// marker, and exclude duration-style retry hints.
	if !strings.Contains(lower, "quota") {
		return false
	}
	if !(strings.Contains(lower, "exceeded") || strings.Contains(lower, "daily") ||
		strings.Contains(lower, "today") || strings.Contains(lower, "tomorrow")) {
		return false
	}
	// "please try again in 14h59m43s" / "try again in 20s" names a transient
	// window, not a daily wall. Deliberately do NOT exclude "please try
	// again" on its own: Zhipu's genuine daily-quota body is "...exceeded
	// today's quota ... please try again tomorrow", where "tomorrow" IS the
	// daily marker and the quota keyword + markers already disambiguate.
	if strings.Contains(lower, "try again in") {
		return false
	}
	return true
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

// SonestCooldown returns the soonest-expiring ModelLock[model] among the
// provider's active keys that are NOT in excludeKeyIDs and are currently
// locked (the lock deadline is in the future). It lets the proxy wait for a
// cooldown to expire instead of instantly 502-ing when every available key is
// only temporarily cooling down (e.g. a concurrent 429 locked the only key).
//
// A key whose lock has already expired is treated as available (and skipped
// here) — SelectKey would have returned it. Keys in excludeKeyIDs are skipped:
// they already failed this request, waiting for their lock won't help. Returns
// ok=false when no qualifying locked key exists.
func (s *Selector) SonestCooldown(providerID, model string, excludeKeyIDs []string) (CooldownInfo, bool) {
	provider, ok := s.reg.GetProvider(providerID)
	if !ok {
		return CooldownInfo{}, false
	}
	exclude := make(map[string]bool, len(excludeKeyIDs))
	for _, id := range excludeKeyIDs {
		exclude[id] = true
	}
	now := time.Now()
	var best CooldownInfo
	found := false
	for _, k := range provider.Keys {
		if !k.IsActive || exclude[k.ID] {
			continue
		}
		state := s.reg.GetKeyState(provider.ID, k.ID)
		if state == nil {
			continue
		}
		state.Lock()
		unlock, locked := state.ModelLocks[model]
		reason := state.ModelErrors[model]
		state.Unlock()
		if !locked || !now.Before(unlock) {
			continue
		}
		if !found || unlock.Before(best.Deadline) {
			best = CooldownInfo{Deadline: unlock, KeyID: k.ID, KeyName: k.Name, Reason: reason}
			found = true
		}
	}
	return best, found
}

// Compile-time interface checks.
var _ CooldownManager = (*Selector)(nil)
