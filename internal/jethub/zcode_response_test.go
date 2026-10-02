package jethub

// ZCode 响应侧测试：业务码分类、3009 退避预算、空流权益判定、SSE 转换。

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

func TestZcodeBusinessCodeClassification(t *testing.T) {
	// 3009 与 1005 都走 429 —— 判据必须按正文业务码（只看状态码会误伤账号）。
	if !zcodeIsConcurrencyLimited(`{"code":3009,"msg":"model concurrency limit exceeded"}`) {
		t.Fatal("3009 must classify as concurrency limited")
	}
	if zcodeIsQuotaExhausted(`{"code":3009,"msg":"model concurrency limit exceeded"}`) {
		t.Fatal("3009 must NEVER classify as quota exhausted (misclassification burns a healthy account)")
	}
	if !zcodeIsQuotaExhausted(`{"code":1005,"msg":"exceed quota limit"}`) {
		t.Fatal("1005 must classify as quota exhausted")
	}
	if !zcodeIsQuotaExhausted(`{"code":1113,"msg":"余额不足或无可用资源包"}`) {
		t.Fatal("1113 must classify as quota exhausted")
	}
	if !zcodeIsCaptchaRejected(`{"code":3007,"msg":"captcha verify failed"}`) {
		t.Fatal("3007 must classify as captcha rejected")
	}
	if !zcodeIsRiskBlocked(`{"code":3012,"msg":"request has been blocked due to unusual activity."}`) {
		t.Fatal("3012 must classify as a risk block")
	}
	if !zcodeIsAuthDead(`{"code":1002,"msg":"invalid token"}`) {
		t.Fatal("1002 must classify as a dead credential")
	}
}

func TestZcodeBusinessCodeOf(t *testing.T) {
	cases := map[string]string{
		`{"code":3007,"msg":"x"}`:          "3007",
		`{"code":"3012"}`:                  "3012",
		`{"error":{"code":1005}}`:          "1005",
		`event: error` + "\n" + `data: {}`: "",
		``:                                 "",
		`{"code":0}`:                       "0",
	}
	for body, want := range cases {
		if got := zcodeBusinessCodeOf(body); got != want {
			t.Fatalf("zcodeBusinessCodeOf(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestZcodeInterceptConcurrencyRetriesThenPassesThrough(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	// 清掉可能残留的计数（包级状态在测试间共享）。
	zcodeConcurrencyState.Lock()
	zcodeConcurrencyState.m = map[string]zcodeConcurrencyEntry{}
	zcodeConcurrencyState.Unlock()
	body := `{"code":3009,"msg":"model concurrency limit exceeded"}`
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	for attempt := 0; attempt < zcodeConcurrencyRetryMax+1; attempt++ {
		resp := &http.Response{StatusCode: 429, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
		out, retryMs, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
		if err != nil || out != nil {
			t.Fatalf("attempt %d: 3009 must be handled internally (out=%v err=%v)", attempt, out, err)
		}
		if retryMs != zcodeConcurrencyRetryDelay.Milliseconds() {
			t.Fatalf("attempt %d: retryMs = %d, want %d (linear backoff, same key)", attempt, retryMs, zcodeConcurrencyRetryDelay.Milliseconds())
		}
	}
	// 预算用尽 → 原样透传（交给代理的 429 处理），不再无限重试。
	resp := &http.Response{StatusCode: 429, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
	out, retryMs, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil || out != nil || retryMs != 0 {
		t.Fatalf("exhausted budget must pass through (out=%v retryMs=%d err=%v)", out, retryMs, err)
	}
}

func TestZcodeInterceptQuotaLocksAccountUntilDayEnd(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 429, Body: io.NopCloser(strings.NewReader(`{"code":1005,"msg":"exceed quota limit"}`)), Header: http.Header{}}
	_, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	var lock *upstreamerr.BillingLockError
	if !errors.As(err, &lock) {
		t.Fatalf("1005 must produce a BillingLockError (mark + switch), got %v", err)
	}
	want := time.UnixMilli(NextUtc8DayStartMs(nowMillis()))
	if diff := lock.Until.Sub(want); diff > time.Second || diff < -time.Second {
		t.Fatalf("lock until %s, want ~%s (UTC+8 next-day midnight)", lock.Until, want)
	}
}

func TestZcodeInterceptRiskBlockStopsWithoutKeyPunishment(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 403, Body: io.NopCloser(strings.NewReader(`{"code":3012,"msg":"request has been blocked due to unusual activity."}`)), Header: http.Header{}}
	out, retryMs, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil || retryMs != 0 {
		t.Fatalf("3012 must not retry (account cooldown penalty): err=%v retryMs=%d", err, retryMs)
	}
	// 归一化为 400 = 代理的 pass-through 通道（不冷却、不切号、不重试）。
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("3012 status normalized to %d, want 400 (pass-through)", resp.StatusCode)
	}
	// 改写落在 resp 本体上（拦截器返回 nil reader = "无额外替换"）。
	if out != nil {
		t.Fatal("rewrite-in-place must not also return a reader")
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "3012") || !strings.Contains(string(body), "冷却惩罚") {
		t.Fatalf("3012 message must warn about the cooldown penalty: %s", body)
	}
	// ⚠️ 改写后的正文不得命中代理的文本分类规则（否则又会冷却 key）。
	for _, trigger := range []string{"rate limit", "too many requests", "quota exceeded", "capacity", "overloaded"} {
		if strings.Contains(strings.ToLower(string(body)), trigger) {
			t.Fatalf("rewritten body contains classifier trigger %q: %s", trigger, body)
		}
	}
}

func TestZcodeInterceptCaptchaRejectedIsActionable(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(`{"code":3007,"msg":"captcha verify failed"}`)), Header: http.Header{}}
	out, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil {
		t.Fatalf("3007 must be surfaced as a client error, not a retryable failure: %v", err)
	}
	if out != nil {
		t.Fatal("rewrite-in-place must not also return a reader")
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "captcha") {
		t.Fatalf("3007 message must explain the captcha demand: %s", body)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("3007 status = %d, want 400", resp.StatusCode)
	}
}

func TestZcodeInterceptEmptyStreamFastLocksAccount(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
	_, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	var lock *upstreamerr.BillingLockError
	if !errors.As(err, &lock) {
		t.Fatalf("a fast empty 200 must be treated as a no-entitlement miss (mark + switch), got %v", err)
	}
	if !strings.Contains(lock.Reason, "空响应") {
		t.Fatalf("lock reason should explain the empty stream: %q", lock.Reason)
	}
}

func TestZcodeInterceptEmptyStreamSlowIsRetryable(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	old := zcodeFastEmptyWindow
	zcodeFastEmptyWindow = time.Millisecond
	defer func() { zcodeFastEmptyWindow = old }()
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(&slowReader{delay: 20 * time.Millisecond}), Header: http.Header{}}
	_, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	var lock *upstreamerr.BillingLockError
	if errors.As(err, &lock) {
		t.Fatal("a slow empty stream is a stuck link, not a no-entitlement miss — it must NOT lock the account")
	}
	if err == nil || !strings.Contains(err.Error(), "空响应") {
		t.Fatalf("slow empty must produce a retryable error, got %v", err)
	}
}

func TestZcodeInterceptPingOnlyStreamIsEmpty(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	stream := "event: ping\ndata: {\"type\":\"ping\"}\n\n"
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stream)), Header: http.Header{}}
	_, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	var lock *upstreamerr.BillingLockError
	if !errors.As(err, &lock) {
		t.Fatalf("a ping-only stream carries no content — must be treated as empty, got %v", err)
	}
}

func TestZcodeInterceptStreamConvertsToOpenAI(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(minimaxReasoningSSE)), Header: http.Header{}}
	out, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil {
		t.Fatal(err)
	}
	if out == nil {
		t.Fatal("OpenAI clients must receive converted chunks")
	}
	raw, _ := io.ReadAll(out)
	text := string(raw)
	if !strings.Contains(text, `"chat.completion.chunk"`) {
		t.Fatalf("expected OpenAI chunks, got: %.300s", text)
	}
	if !strings.Contains(text, "你好") {
		t.Fatalf("stream text lost in conversion: %.300s", text)
	}
	if strings.Contains(text, "[DONE]") && !strings.HasSuffix(strings.TrimSpace(text), "[DONE]") {
		t.Fatal("converter must terminate with [DONE] at the end only")
	}
}

func TestZcodeInterceptAnthropicStreamPassesThrough(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/messages", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(minimaxReasoningSSE)), Header: http.Header{}}
	out, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil || out != nil {
		t.Fatalf("native Anthropic streaming must pass through untouched (out=%v err=%v)", out, err)
	}
}

func TestZcodeInterceptNonStreamAggregates(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(minimaxReasoningSSE)), Header: http.Header{}}
	out, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", false)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(out)
	if !strings.Contains(string(body), `"object":"chat.completion"`) {
		t.Fatalf("non-stream client must get an aggregated chat.completion: %.300s", body)
	}
	if resp.ContentLength >= 0 {
		t.Fatal("ContentLength must be reset when the body is rewritten")
	}
}

func TestZcodeInterceptErrorFrameFailsAttempt(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	stream := "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"overloaded\"}}\n\n"
	resp := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(stream)), Header: http.Header{}}
	_, _, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err == nil || !strings.Contains(err.Error(), "overloaded") {
		t.Fatalf("in-stream error frame must fail the attempt, got %v", err)
	}
}

func TestZcodeInterceptServerErrorPassesThrough(t *testing.T) {
	m := newSeedZcodeManager(t)
	accountID := firstZcodeAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://localhost/v1/chat/completions", nil)
	resp := &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("boom")), Header: http.Header{}}
	out, retryMs, err := m.zcodeInterceptResponse(req, resp, accountID, "GLM-5.3", true)
	if err != nil || out != nil || retryMs != 0 {
		t.Fatalf("5xx must fall through to the proxy's own backoff (out=%v retryMs=%d err=%v)", out, retryMs, err)
	}
	// body 必须已恢复（透传路径还要读它）。
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != "boom" {
		t.Fatalf("pass-through must restore the body, got %q", raw)
	}
}

// slowReader yields EOF after a delay (simulates a stalled upstream that
// eventually ends with an empty stream).
type slowReader struct {
	delay time.Duration
	done  bool
}

func (r *slowReader) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	time.Sleep(r.delay)
	r.done = true
	return 0, io.EOF
}
