// Package upstreamerr holds the tiny control-flow error types that cross the
// proxy ⇄ bridge boundary (AGENTS.md 纪律：proxy 不得 import jethub —— 这些
// 类型放在中性叶子包里，双方各自 import，接口仍由 proxy 定义、jethub 结构化实现）。
package upstreamerr

import "time"

// QueueRetryError asks the retry loop to wait RetryAfter and resend with the
// SAME key: a server-specified transient delay (Qoder queue business code
// 10605). It is NOT a key failure — no cooldown, no exclusion.
type QueueRetryError struct{ RetryAfter time.Duration }

func (e *QueueRetryError) Error() string {
	return "upstream queue signal: retry after " + e.RetryAfter.String()
}

// BillingLockError reports a per-model quota exhaustion on this key: the
// retry loop locks key+model until Until (Qoder: UTC+8 day end — the server
// settles daily counts in UTC+8) and retries with the next key.
type BillingLockError struct {
	Until  time.Time
	Reason string
}

func (e *BillingLockError) Error() string {
	if e.Reason != "" {
		return e.Reason
	}
	return "upstream billing lock until " + e.Until.Format(time.RFC3339)
}

// RetryDropHeaderMarker is an internal, loopback-only marker header used
// between the retry loop and a bridged provider's own augmenter: when the
// retry loop resends because of a SameKeyRetryError it writes the offending
// header's name here on the shared client request; the provider's augmenter
// reads it (and omits that header) and its interceptor reads it to tell
// "already retried once". The proxy skips this header when copying client
// headers upstream, so it can never leak to an upstream.
const RetryDropHeaderMarker = "X-Tinylab-Internal-Retry-Drop"

// SameKeyRetryError asks the retry loop to resend immediately with the SAME
// key after dropping Header: the fix is applied by the provider's own bridge
// code (e.g. CodeArts drops a signed `maas_type` header once after the
// upstream rejects it with a benefit-not-found error frame), not by switching
// keys. No wait, no cooldown, no exclusion.
type SameKeyRetryError struct {
	// Header is the outbound header to omit on the resend ("" = none).
	Header string
	Reason string
}

func (e *SameKeyRetryError) Error() string {
	if e.Reason != "" {
		return e.Reason
	}
	return "upstream same-key retry (drop header " + e.Header + ")"
}
