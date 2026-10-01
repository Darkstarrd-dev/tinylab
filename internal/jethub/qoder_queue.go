package jethub

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
)

// Qoder queue/billing error parsing — 1:1 from ref model-queue.ts. Shared by
// the HTTP 403 branch and the SSE in-stream frame branch (ONE implementation,
// two call sites — forking them is how the SSE channel got missed the first
// time).

// QueueBusinessCode = 10605 (client mRA) → model_queued; 110 = billing
// daily count exceeded → NOT retryable.
const (
	QueueBusinessCode   = "10605"
	BillingBusinessCode = "110"
	// QueueMaxDelay caps ONE queue wait at 10s (user rule: <10s follows the
	// server, ≥10s clamps — avoids a 30s UI freeze that cannot be told apart
	// from a hang).
	QueueMaxDelayMS = 10_000
	// QueueMaxAttempts: 180 × 10s = 30 minutes (CodeArts convention).
	QueueMaxAttempts = 180
	// QoderBillingUTCOffset: billing day boundary is FIXED UTC+8 (the server
	// settles daily counts in UTC+8 — the daily campaign description says so
	// verbatim). Local timezone would compute a wrong unlock moment.
	QoderBillingUTCOffsetMS = 8 * 3_600_000
	// Day length.
	qoderDayMS = 86_400_000
)

// QueueInfo is the parsed queue error payload (client PJa trimmed).
type QueueInfo struct {
	IsQueued          *bool
	ModelKey          string
	QueueType         string
	ServiceAvailable  *bool
	QueueCount        int64
	RetryAfterSeconds int64
	WaitTime          int64
	RetryAfterMs      int64 // retry_after_ms / retryAfterMs (ms-first priority)
	HasDelay          bool
}

// IsBillingBusinessCode: string or number encoding.
func IsBillingBusinessCode(code any) bool {
	if s, ok := code.(string); ok {
		return s == BillingBusinessCode
	}
	if f, ok := code.(float64); ok {
		return f == 110
	}
	return false
}

// LooksLikeBillingError: TEXT fallback for the billing code (the code value
// is NOT hardcoded client-side — the server can change it). ⚠️ Keywords are
// deliberately NARROW: balance/quota catch-alls would misfire on ordinary
// model prose discussing balances.
var billingErrorRe = regexp.MustCompile(`(?i)billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error`)

func LooksLikeBillingError(text string) bool { return billingErrorRe.MatchString(text) }

// NextUtc8DayStartMs computes "UTC+8 today 24:00" as a UTC ms timestamp
// (strictly > nowMs). Arithmetic only — Date.setHours operates in the LOCAL
// timezone and is wrong on non-UTC+8 machines.
func NextUtc8DayStartMs(nowMs int64) int64 {
	shifted := nowMs + QoderBillingUTCOffsetMS
	msIntoDay := ((shifted % qoderDayMS) + qoderDayMS) % qoderDayMS
	return nowMs + (qoderDayMS - msIntoDay)
}

// isQueueBusinessCode: string or number.
func isQueueBusinessCode(code any) bool {
	if s, ok := code.(string); ok {
		return s == QueueBusinessCode
	}
	if f, ok := code.(float64); ok {
		return f == 10605
	}
	return false
}

// ParseQueueError extracts queue info from a response body / error-frame
// message. ⚠️ BOTH input shapes must be supported:
//  1. outer envelope {"code":"10605","message":"{…}"} — HTTP 403 branch;
//  2. inner message {"isQueued":true,…} — SSE frame data.message (NO code!).
//
// Requiring the code would silently disable shape 2 (the first fix's
// regression — the sleep probe showed 0 waits). Judgement: code hit OR
// queue-marker fields present. ⚠️ isQueued===true must NOT be required:
// transient queueing measures isQueued:false, serviceAvailable:true,
// retryAfterSeconds:2 (the "one retry suffices" report) — requiring true
// falls back to the 1s default instead of the server's 2s.
func ParseQueueError(body any) *QueueInfo {
	var root any = body
	if s, ok := body.(string); ok {
		if err := json.Unmarshal([]byte(s), &root); err != nil {
			return nil
		}
	}
	// Breadth-first expansion over data/result/message/body (client lFc keys);
	// STRING values get a JSON.parse retry (the message-is-a-JSON-string trap).
	// ⚠️ No cycle dedupe needed: every node came from json.Unmarshal (acyclic
	// by construction); a depth cap alone bounds the walk.
	var queue []any
	queue = append(queue, root)
	var nodes []map[string]any
	for len(queue) > 0 && len(nodes) < 64 {
		node := queue[0]
		queue = queue[1:]
		if node == nil {
			continue
		}
		record, ok := node.(map[string]any)
		if !ok {
			continue
		}
		nodes = append(nodes, record)
		for _, key := range []string{"data", "result", "message", "body"} {
			value, present := record[key]
			if !present || value == nil {
				continue
			}
			switch v := value.(type) {
			case map[string]any, []any:
				queue = append(queue, v)
			case string:
				if v != "" {
					var inner any
					if json.Unmarshal([]byte(v), &inner) == nil {
						queue = append(queue, inner)
					}
				}
			}
		}
	}
	// First node carrying a queue marker.
	var info map[string]any
	for _, n := range nodes {
		if _, has := n["isQueued"]; has {
			info = n
			break
		}
		if _, has := n["serviceAvailable"]; has {
			info = n
			break
		}
	}
	if info == nil {
		return nil
	}
	codeHit := false
	for _, n := range nodes {
		if isQueueBusinessCode(n["code"]) {
			codeHit = true
			break
		}
	}
	if !codeHit {
		if _, has := info["isQueued"]; !has {
			return nil
		}
	}
	out := &QueueInfo{}
	if b, ok := info["isQueued"].(bool); ok {
		out.IsQueued = &b
	}
	out.ModelKey = jsonStringField(info, "modelKey")
	out.QueueType = jsonStringField(info, "queueType")
	if b, ok := info["serviceAvailable"].(bool); ok {
		out.ServiceAvailable = &b
	}
	for _, key := range []string{"queueCount", "retryAfterSeconds", "waitTime", "retry_after_ms", "retryAfterMs"} {
		if f, ok := info[key].(float64); ok && !isInf(f) {
			v := int64(f)
			switch key {
			case "queueCount":
				out.QueueCount = v
			case "retryAfterSeconds":
				out.RetryAfterSeconds = v
			case "waitTime":
				out.WaitTime = v
			case "retry_after_ms", "retryAfterMs":
				if !out.HasDelay {
					out.RetryAfterMs = v
					out.HasDelay = true
				}
			}
		}
	}
	return out
}

func isInf(f float64) bool { return f != f || f > 1e308 || f < -1e308 }

// QueueDelayMS computes the wait for one queue round (ms); nil ⇒ caller
// backoff. Priority: retry_after_ms → retryAfterMs → retryAfterSeconds×1000,
// then clamp to QueueMaxDelayMS. ⚠️ ILLEGAL values are IGNORED, not treated
// as 0 (0 would burn the chance in a busy loop — client W7c() fails on
// non-finite/negative).
func QueueDelayMS(info *QueueInfo) (int64, bool) {
	if info == nil {
		return 0, false
	}
	var raw int64 = -1
	if info.HasDelay && info.RetryAfterMs >= 0 {
		raw = info.RetryAfterMs
	} else if info.RetryAfterSeconds >= 0 && (info.RetryAfterSeconds > 0 || info.HasDelay) {
		raw = info.RetryAfterSeconds * 1000
	}
	if raw < 0 {
		return 0, false
	}
	if raw > QueueMaxDelayMS {
		raw = QueueMaxDelayMS
	}
	return raw, true
}

// fmtQueueCode renders a business code for error suffixes.
func fmtQueueCode(code any) string {
	switch v := code.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return ""
	}
}

// unused guard.
var _ = fmt.Sprintf
