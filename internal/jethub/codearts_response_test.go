package jethub

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
