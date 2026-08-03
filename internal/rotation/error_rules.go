package rotation

import (
	"strings"
)

// ErrorAction defines the action to take for a classified error.
type ErrorAction int

const (
	ActionBackoff     ErrorAction = iota // exponential backoff (retry another key after backoff)
	ActionCooldown                       // fixed-duration cooldown (key locked N seconds)
	ActionDailyQuota                     // daily quota lock (until next CST 00:05)
	ActionTransient                      // transient cooldown (default 30s)
	ActionPassThrough                    // request-shape client error (4xx): return upstream error to client as-is, do not retry/lock/exclude — key is healthy
)

// ErrorRule defines one error classification rule.
type ErrorRule struct {
	StatusCode  int         // HTTP status code; 0 matches nothing (falls through to default transient)
	StatusMin   int         // inclusive lower bound of a status range; 0 = no range match
	StatusMax   int         // inclusive upper bound of a status range; 0 = no range match
	BodyMatch   string      // case-insensitive substring match on body (empty = skip)
	Action      ErrorAction // action to take
	CooldownSec int         // fixed cooldown seconds (for ActionCooldown)
}

// DefaultErrorRules is the ordered error classification table,
// ported from 9router open-sse/config/errorConfig.js → ERROR_RULES.
// Text rules are checked first (top-to-bottom priority), then status rules.
var DefaultErrorRules = []ErrorRule{
	// --- Text-based rules (checked first, order = priority) ---
	{BodyMatch: "no credentials", Action: ActionCooldown, CooldownSec: 120},
	{BodyMatch: "request not allowed", Action: ActionCooldown, CooldownSec: 5},
	{BodyMatch: "improperly formed request", Action: ActionCooldown, CooldownSec: 120},
	{BodyMatch: "rate limit", Action: ActionBackoff},
	{BodyMatch: "too many requests", Action: ActionBackoff},
	{BodyMatch: "quota exceeded", Action: ActionBackoff},
	{BodyMatch: "capacity", Action: ActionBackoff},
	{BodyMatch: "overloaded", Action: ActionBackoff},
	// Account-level balance exhaustion (e.g. ModelScope 402 insufficient_balance_error).
	// Retrying other keys of the same broke account or waiting is pointless, so treat
	// it as a hard daily lock instead of a transient cooldown.
	{BodyMatch: "insufficient_balance", Action: ActionDailyQuota},
	{BodyMatch: "insufficient balance", Action: ActionDailyQuota},
	// Aggregator (newapi/2api-style) reporting its OWN upstream failed — the
	// request shape was fine, the aggregator's backend transiently errored.
	// Retrying on another key (multi-key) can help, so treat as backoff
	// rather than pass-through. Checked BEFORE the 400/422 status rules so a
	// 400/422 body containing this phrase still retries.
	{BodyMatch: "upstream request failed", Action: ActionBackoff},

	// --- Status-based rules (fallback when text doesn't match) ---
	{StatusCode: 401, Action: ActionCooldown, CooldownSec: 120},
	{StatusCode: 402, Action: ActionCooldown, CooldownSec: 120},
	{StatusCode: 403, Action: ActionCooldown, CooldownSec: 120},
	{StatusCode: 404, Action: ActionCooldown, CooldownSec: 120},
	// 400/422 are request-validation client errors per HTTP semantics: the
	// request is malformed (bad param, invalid value, wrong shape), the KEY is
	// healthy. Retrying the SAME request on ANOTHER key 400s again, and locking
	// the key would punish a healthy key + block all concurrent requests for the
	// cooldown window. Pass the upstream error through to the client as-is.
	// A body matching a text rule above (e.g. "upstream request failed") can
	// still override to a retryable action.
	{StatusCode: 400, Action: ActionPassThrough},
	{StatusCode: 422, Action: ActionPassThrough},
	{StatusCode: 429, Action: ActionBackoff},
	// 5xx (unmapped): short backoff + switch, NOT the 30s transient cooldown.
	// A bare 500/501/504 with no text match used to fall through to
	// ActionTransient and MarkRateLimited(30s) — a single transient upstream
	// 5xx then locked the healthy key for 30s and caused instant "no
	// available keys" 502 bursts for concurrent requests. Exact status rules
	// above win over this range (checked after them).
	{StatusMin: 500, StatusMax: 599, Action: ActionBackoff},
}

// DefaultTransientCooldownSec is the default cooldown for unmatched errors.
const DefaultTransientCooldownSec = 30

// ClassifyError matches an HTTP error (statusCode + body) against DefaultErrorRules.
// Text rules are checked first by order; then status rules.
// Returns the first matching rule, or a transient fallback if no rule matches.
func ClassifyError(statusCode int, body string) ErrorRule {
	lower := strings.ToLower(body)

	for _, rule := range DefaultErrorRules {
		if rule.BodyMatch != "" && strings.Contains(lower, rule.BodyMatch) {
			return rule
		}
	}

	for _, rule := range DefaultErrorRules {
		if rule.StatusCode != 0 && rule.StatusCode == statusCode {
			return rule
		}
	}

	for _, rule := range DefaultErrorRules {
		if rule.StatusMin > 0 && statusCode >= rule.StatusMin && statusCode <= rule.StatusMax {
			return rule
		}
	}

	return ErrorRule{Action: ActionTransient, CooldownSec: DefaultTransientCooldownSec}
}

// IsBalanceExhausted detects an account-level balance exhaustion error.
// ModelScope returns HTTP 402 with type "insufficient_balance_error" when the
// token account runs out of balance. Such keys are dead until recharged, so they
// must be locked (not transient-cooled) and their quota snapshots invalidated.
func IsBalanceExhausted(statusCode int, body string) bool {
	if statusCode != 402 {
		return false
	}
	lower := strings.ToLower(body)
	return strings.Contains(lower, "insufficient_balance") || strings.Contains(lower, "insufficient balance")
}
