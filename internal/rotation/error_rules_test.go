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
	// 401 with no recognizable body -> ActionCooldown (status 401 rule).
	r := ClassifyError(401, `{"error":"unauthorized"}`)
	if r.Action != ActionCooldown {
		t.Errorf("401 unauthorized -> action=%v, want ActionCooldown", r.Action)
	}
	if r.CooldownSec != 120 {
		t.Errorf("401 cooldown = %d, want 120", r.CooldownSec)
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

func TestClassifyError_401StillCooldown(t *testing.T) {
	// 401 is a key/auth problem → ActionCooldown 120s (NOT pass-through).
	r := ClassifyError(401, `{"error":"invalid api key"}`)
	if r.Action != ActionCooldown || r.CooldownSec != 120 {
		t.Errorf("401 -> action=%v cooldown=%d, want ActionCooldown/120", r.Action, r.CooldownSec)
	}
}
