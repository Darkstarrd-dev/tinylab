package jethub

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// CodeArts 的响应侧判据回归 —— 直接来自用户实测的三条 trace。
//
// ⚠️ 背景：codearts 用 **HTTP 200 + 流内 `error_code`** 表达限流/排队/权益错误，
// 而没有响应侧判据时客户端只看到**空回复**（正文空、finish 帧也没了），真正的
// 错误被静默吞掉（trace r28I5xUHpjJs-2 / r28I5xdd3XRo-3）。
func newCodeartsTestManager(t *testing.T) *Manager {
	t.Helper()
	return newTestManager(t).m
}

func codeartsResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// TestCodeartsSSERateLimitRetriesSameKey: trace r28I5xUHpjJs-2 的真实帧
// （`InferHub.ModelArts.81114.429` + "Too many requests…"）必须按**排队**处理：
// 等 10s 用同一个 Key 重发（ref isSseQueueErrorCode 的 429 分支），而不是当成功。
func TestCodeartsSSERateLimitRetriesSameKey(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81114.429","error_msg":"Too many requests, the rate limit is 500000 tokens per minute."}` + "\n\n"
	_, retryMs, err := m.codeartsInterceptResponse(nil, codeartsResp(200, body), "deepseek-v4-flash", true)
	if err != nil {
		t.Fatalf("queue retry must not fail the attempt: %v", err)
	}
	if retryMs != 10_000 {
		t.Fatalf("retryAfter = %dms, want 10000 (ref QUEUE_RETRY_DELAY_MS)", retryMs)
	}
}

// TestCodeartsBenefitNotFoundDropsHeaderOnce: trace r28I5xdd3XRo-3 的真实帧。
// ⚠️ 首次（无回环标记）⇒ SameKeyRetryError：去掉 `maas_type: benefit` 同 Key
// 重发一次（ref 3bf2be7：积分制账号不带该头可正常出流）；已经去过头仍报同一码
// ⇒ 显式失败并带上错误码与文案（不与真实失败互相掩盖）。
func TestCodeartsBenefitNotFoundDropsHeaderOnce(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found","details":[{"error_code":"InferHub.4004.200","error_msg":"modelId: deepseek-v4.1-flash"}]}` + "\n\n"

	first := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	_, retryMs, err := m.codeartsInterceptResponse(first, codeartsResp(200, body), "deepseek-v4.1-flash", true)
	if retryMs != 0 {
		t.Fatalf("drop-header retry is not a queue wait, got retryAfter=%dms", retryMs)
	}
	var skre *upstreamerr.SameKeyRetryError
	if !errors.As(err, &skre) || skre.Header != "maas_type" {
		t.Fatalf("first 4004.200 must ask for a same-key retry without maas_type, got %v", err)
	}

	second := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	second.Header.Set(upstreamerr.RetryDropHeaderMarker, "maas_type")
	_, _, err = m.codeartsInterceptResponse(second, codeartsResp(200, body), "deepseek-v4.1-flash", true)
	if err == nil || !strings.Contains(err.Error(), "InferHub.4004.200") || !strings.Contains(err.Error(), "benefit not found") {
		t.Fatalf("second 4004.200 (header already dropped) must surface the real error, got %v", err)
	}
	var again *upstreamerr.SameKeyRetryError
	if errors.As(err, &again) {
		t.Fatal("the drop-header retry must happen at most once")
	}
}

// TestCodeartsBenefitNotFoundOnNonBenefitModelSurfaces: 非 benefit 模型收到
// 4004.200（罕见形态）⇒ 不触发去头重试，直接显式失败。
func TestCodeartsBenefitNotFoundOnNonBenefitModelSurfaces(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found"}` + "\n\n"
	_, _, err := m.codeartsInterceptResponse(nil, codeartsResp(200, body), "GLM-5.2", true)
	if err == nil {
		t.Fatal("expected the real error to surface")
	}
	var skre *upstreamerr.SameKeyRetryError
	if errors.As(err, &skre) {
		t.Fatalf("non-benefit model must not trigger the header-drop retry, got %v", err)
	}
}

// TestCodeartsConcurrencyLimitRetriesSameKey: trace r28I5xoCTGFY-4 的真实 400
// （`TM.00001041` "并发会话数已达上限(3个)"）必须按排队处理（ref isQueueError）。
func TestCodeartsConcurrencyLimitRetriesSameKey(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。"}`
	_, retryMs, err := m.codeartsInterceptResponse(nil, codeartsResp(400, body), "glm-5.3-flash", true)
	if err != nil {
		t.Fatalf("queue error must not surface as an error: %v", err)
	}
	if retryMs != 10_000 {
		t.Fatalf("retryAfter = %dms, want 10000", retryMs)
	}
}

// TestCodeartsPlainBodyQueueWording: ref 的文案兜底（peak usage / try again after
// / high demand / too many requests）同样算排队。
func TestCodeartsPlainBodyQueueWording(t *testing.T) {
	m := newCodeartsTestManager(t)
	for _, body := range []string{
		`{"message":"Service is under high demand, please try again after 30 seconds"}`,
		`{"message":"too many requests"}`,
		`service in peak usage hours`,
	} {
		if _, retryMs, _ := m.codeartsInterceptResponse(nil, codeartsResp(400, body), "GLM-5.2", true); retryMs != 10_000 {
			t.Errorf("%q must be treated as a queue error (retryAfter=%d)", body, retryMs)
		}
	}
}

// TestCodeartsOtherErrorsPassThrough: 其它错误原样透传（代理统一分类），且 body
// 必须**完整还给下游**（peek/读取不能吞掉它）。
func TestCodeartsOtherErrorsPassThrough(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `{"error_code":"InferHub.9999.500","error_msg":"boom"}`
	resp := codeartsResp(500, body)
	out, retryMs, err := m.codeartsInterceptResponse(nil, resp, "GLM-5.2", false)
	if err != nil || retryMs != 0 || out != nil {
		t.Fatalf("non-queue errors pass through unchanged, got out=%v retry=%d err=%v", out, retryMs, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != body {
		t.Fatalf("error body must stay readable by the proxy, got %q", raw)
	}
}

// TestCodeartsNormalStreamIsByteIdentical: 正常 SSE 流经 peek 后必须**一个字节都
// 不丢**（peek 的字节要接回去），且不能误判成错误。
func TestCodeartsNormalStreamIsByteIdentical(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := "data:{\"text\":\"你\"}\n\ndata:{\"text\":\"好\"}\n\ndata:{\"text\":\"[DONE]\"}\n\n"
	out, retryMs, err := m.codeartsInterceptResponse(nil, codeartsResp(200, body), "GLM-5.2", true)
	if err != nil || retryMs != 0 {
		t.Fatalf("normal stream must pass through: retry=%d err=%v", retryMs, err)
	}
	raw, _ := io.ReadAll(out)
	if string(raw) != body {
		t.Fatalf("stream altered by peek:\n got %q\nwant %q", raw, body)
	}
}

// TestCodeartsErrorFramePredicate: `error_code` 非空才算错误帧（正常帧只有 text，
// 终止帧是 {"text":"[DONE]"} 且**没有** error_code）。
func TestCodeartsErrorFramePredicate(t *testing.T) {
	cases := []struct {
		payload  string
		wantOK   bool
		wantCode string
	}{
		{`{"text":"hi"}`, false, ""},
		{`{"text":"[DONE]"}`, false, ""},
		{`{"text":"","error_code":""}`, false, ""},
		{`{"error_code":"TM.00001041","error_msg":"x"}`, true, "TM.00001041"},
		{`not json`, false, ""},
	}
	for _, tc := range cases {
		code, _, ok := codeartsErrorFrame(tc.payload)
		if ok != tc.wantOK || code != tc.wantCode {
			t.Errorf("%q → (%q, %v), want (%q, %v)", tc.payload, code, ok, tc.wantCode, tc.wantOK)
		}
	}
}

// ── R3-1（ref 784210d / ae0c9b0，2026-10-04 上游同步）──────────────────────────

// TestCodeartsQuotaExhaustedIsBillingLockNotQueue: 真实额度帧
// （HTTP 200 + SSE `InferHub.4291.200` "insufficient quota"）必须判为**额度用尽**
// （BillingLockError，锁 key+model 至 UTC+8 当日 24:00），而不是可重试的排队——
// 旧正则的裸 `429` 子串会命中 `4291` 前缀，把确定性失败送进 10s×180 次
// （30 分钟）静默重试循环、界面零输出（上游真实报障，ref 784210d）。
func TestCodeartsQuotaExhaustedIsBillingLockNotQueue(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `data:{"text":"[DONE]","error_code":"InferHub.4291.200","error_msg":"insufficient quota","details":[{"modelId":"deepseek-v4.1-flash"}]}` + "\n\n"
	_, retryMs, err := m.codeartsInterceptResponse(nil, codeartsResp(200, body), "deepseek-v4.1-flash", true)
	if retryMs != 0 {
		t.Fatalf("quota exhaustion must NOT be a queue wait, got retryAfter=%dms", retryMs)
	}
	ble, ok := err.(*upstreamerr.BillingLockError)
	if !ok {
		t.Fatalf("quota exhaustion must surface as BillingLockError, got %T: %v", err, err)
	}
	if ble.Until.Before(time.Now()) {
		t.Fatalf("billing lock Until must be in the future (UTC+8 midnight), got %v", ble.Until)
	}
	// Until 必须落在「下一个 UTC+8 自然日 24:00」：把 Until 平移 +8h 后
	// 应正好是某个 UTC 日的 00:00（整点），且在 1~24 小时之间。
	utc8 := ble.Until.UTC().Add(8 * time.Hour)
	if utc8.Hour() != 0 || utc8.Minute() != 0 || utc8.Second() != 0 {
		t.Fatalf("Until must be UTC+8 midnight, got %v (+8h = %v)", ble.Until, utc8)
	}
}

// TestCodeartsQuotaExhaustedNonSSEChannel: 上游同样可能以 4xx 下发额度错误——
// 两条通道都接（ref 784210d「AGENTS.md 铁律」），按报文语义而不是状态码分类。
func TestCodeartsQuotaExhaustedNonSSEChannel(t *testing.T) {
	m := newCodeartsTestManager(t)
	body := `{"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}`
	_, retryMs, err := m.codeartsInterceptResponse(nil, codeartsResp(400, body), "deepseek-v4.1-flash", true)
	if retryMs != 0 {
		t.Fatalf("4xx quota error must not queue-retry, got retryAfter=%dms", retryMs)
	}
	if _, ok := err.(*upstreamerr.BillingLockError); !ok {
		t.Fatalf("4xx quota error must be BillingLockError, got %T: %v", err, err)
	}
}

// TestCodeartsQuotaExhaustedMessageFallback: 万一上游换码值，`insufficient quota`
// 文案兜底仍要命中（ref 同款，与 zcode/qoder 既有做法一致）。
func TestCodeartsQuotaExhaustedMessageFallback(t *testing.T) {
	if !isCodeArtsSSEQuotaExhausted("InferHub.SomeNew.777", "Insufficient_Quota for today") {
		t.Fatal("message fallback must catch insufficient-quota wording regardless of code")
	}
	if isCodeArtsSSEQuotaExhausted("TM.00001041", "并发会话数已达上限") {
		t.Fatal("queue errors must not classify as quota exhaustion")
	}
}

// TestCodearts429BoundaryAnchoring: `429` 判据必须锚定为**独立数字**——
// `…81114.429`（结尾）与 `429 `（后接空格）命中，`4291` 不命中。
// ⚠️ 反向验证：把 codeartsSSEQueueCodeRe 的 `(^|[^0-9])429([^0-9]|$)` 改回裸
// `429` 本测试必须变红（只靠调用点顺序兜不住边界——end-to-end 用例不会红，
// 边界就成了没人守的装饰，ref 784210d 的原话）。
func TestCodearts429BoundaryAnchoring(t *testing.T) {
	matches := func(code string) bool { return isCodeArtsSSEQueueCode(code) }
	for _, code := range []string{
		"InferHub.ModelArts.81114.429", // 结尾（真实 trace）
		"InferHub.429 x",               // 后接空格
		"429",                          // 全等
		"x429",                         // 前面是字母（[^0-9] 边界）
	} {
		if !matches(code) {
			t.Errorf("%q must still classify as queue/rate-limit", code)
		}
	}
	for _, code := range []string{
		"InferHub.4291.200", // 额度耗尽：不得命中排队正则
		"1429",              // 4291 同型：数字边界内不命中
	} {
		if matches(code) {
			t.Errorf("%q must NOT match the queue regex (429 is a standalone number)", code)
		}
	}
}
