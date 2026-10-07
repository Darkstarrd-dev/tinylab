package rotation

import (
	"testing"
)

func TestClassifyError_TextMatchPriority(t *testing.T) {
	// "rate limit" body -> ActionBackoff (text rule takes priority over status).
	r := ClassifyError(500, `{"error":"rate limit exceeded"}`)
	if r.Action != ActionBackoff {
		t.Errorf("status=500 body='rate limit' -> action=%v, want ActionBackoff", r.Action)
	}
}

func TestClassifyError_BalanceDailyQuota(t *testing.T) {
	// insufficient_balance in body -> ActionDailyQuota regardless of status.
	r := ClassifyError(402, `{"error":"insufficient_balance_error"}`)
	if r.Action != ActionDailyQuota {
		t.Errorf("402 insufficient_balance -> action=%v, want ActionDailyQuota", r.Action)
	}
}

func TestClassifyError_StatusCodeFallback(t *testing.T) {
	// 401 with no recognizable body -> ActionRotateOnly (status 401 rule).
	// ⚠️ R5（ref 0abaf1a）：认证失败**只换号、不写冷却** —— 网关侧授权校验
	// 故障会对全池回 401，写冷却会把整池封死（上游实测 6 个号各封 24h）。
	r := ClassifyError(401, `{"error":"unauthorized"}`)
	if r.Action != ActionRotateOnly {
		t.Errorf("401 unauthorized -> action=%v, want ActionRotateOnly", r.Action)
	}
	if r.CooldownSec != 0 {
		t.Errorf("401 must carry NO cooldown, got %d", r.CooldownSec)
	}
}

func TestClassifyError_5xxUnmappedBackoff(t *testing.T) {
	// Unrecognized 5xx with no matching text -> ActionBackoff (short backoff
	// + switch), NOT the 30s ActionTransient cooldown that locked a healthy
	// key for 30s on a transient upstream 5xx.
	for _, code := range []int{500, 501, 503, 504, 599} {
		r := ClassifyError(code, `{"error":"some unknown upstream failure"}`)
		if r.Action != ActionBackoff {
			t.Errorf("%d unknown -> action=%v, want ActionBackoff", code, r.Action)
		}
	}
	// Unmapped 4xx still falls through to ActionTransient.
	r := ClassifyError(418, `{"error":"teapot"}`)
	if r.Action != ActionTransient {
		t.Errorf("418 -> action=%v, want ActionTransient", r.Action)
	}
}

func TestClassifyError_RequestNotAllowed(t *testing.T) {
	// "request not allowed" -> ActionCooldown 5s (per rule table).
	r := ClassifyError(400, `{"error":"request not allowed"}`)
	if r.Action != ActionCooldown || r.CooldownSec != 5 {
		t.Errorf("'request not allowed' -> action=%v cooldown=%d, want ActionCooldown/5", r.Action, r.CooldownSec)
	}
}

func TestClassifyError_400PassThrough(t *testing.T) {
	// 400 with a request-validation body and no transient text match must
	// pass through to the client (key is healthy, request is the problem).
	r := ClassifyError(400, `{"error":{"message":"invalid reasoning value: 'minimal'","type":"invalid_request_error"}}`)
	if r.Action != ActionPassThrough {
		t.Errorf("400 invalid_request_error -> action=%v, want ActionPassThrough", r.Action)
	}
}

func TestClassifyError_422PassThrough(t *testing.T) {
	// 422 unprocessable entity is a request-shape error → pass through.
	r := ClassifyError(422, `{"error":{"message":"bad param"}}`)
	if r.Action != ActionPassThrough {
		t.Errorf("422 -> action=%v, want ActionPassThrough", r.Action)
	}
}

func TestClassifyError_400AggregatorTransientRetries(t *testing.T) {
	// A 400 whose body indicates the aggregator's OWN upstream failed is
	// transient at the aggregator (request shape was fine), so the text rule
	// overrides the 400 status rule → ActionBackoff (retry another key).
	r := ClassifyError(400, `{"error":"upstream request failed"}`)
	if r.Action != ActionBackoff {
		t.Errorf("400 'upstream request failed' -> action=%v, want ActionBackoff", r.Action)
	}
}

// TestClassifyError_AuthRotatesWithoutCooldown 锁「换号与写冷却是两件事」：
// 401/403 必须只换号、**不写冷却**（ref 0abaf1a 的 2026-10-06 全池被封事故）。
//
// 反向验证：把 401/403 规则改回 ActionCooldown，本用例立刻变红。
func TestClassifyError_AuthRotatesWithoutCooldown(t *testing.T) {
	// 401 is a key/auth problem → ActionRotateOnly (NOT pass-through, NOT cooldown).
	r := ClassifyError(401, `{"error":"invalid api key"}`)
	if r.Action != ActionRotateOnly || r.CooldownSec != 0 {
		t.Errorf("401 -> action=%v cooldown=%d, want ActionRotateOnly/0", r.Action, r.CooldownSec)
	}
	// 403 同款：网关侧授权故障（如 raccoon 的 200003 authorization_verify_error）。
	r403 := ClassifyError(403, `{"code":"200003","message":"authorization_verify_error"}`)
	if r403.Action != ActionRotateOnly || r403.CooldownSec != 0 {
		t.Errorf("403 -> action=%v cooldown=%d, want ActionRotateOnly/0", r403.Action, r403.CooldownSec)
	}
}
