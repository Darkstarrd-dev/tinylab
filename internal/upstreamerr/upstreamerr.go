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

// ModelSaturationError reports that the MODEL (not the account) is saturated:
// every account hits the same wall, so switching keys is useless and writing a
// per-key rate-limit lock is actively harmful (it would lock the whole pool for
// the fallback cooldown). The retry loop keeps the SAME key, waits RetryAfter,
// and retries a bounded number of times; on exhaustion it fails with a message
// that points at "switch model", never "account quota".
//
// 上游实例（ref 29a42ea / issue：buddy 首次用 space-bunny 就报「所有账号均受限」）：
// buddy 的模型饱和业务码 `14003` 也是 **HTTP 429**，报文自证是模型级
// （`actions: ["SWITCH_MODEL", …]`，**没有**换号选项；`displayMsg.zh` =
// 「模型繁忙，请换模型或稍后重试」）。修复前它落进通用 429 分支 ⇒ 给**每个**
// 账号写一条兜底冷却标记（报文无「将在…重置」）⇒ 整池被锁。
type ModelSaturationError struct {
	// RetryAfter is how long to wait before retrying the SAME key.
	RetryAfter time.Duration
	// Reason is the user-facing explanation (must name the model).
	Reason string
}

func (e *ModelSaturationError) Error() string {
	if e.Reason != "" {
		return e.Reason
	}
	return "upstream model saturated: retry after " + e.RetryAfter.String()
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
