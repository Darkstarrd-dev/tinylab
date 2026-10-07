package jethub

// buddy 模型饱和判据的回归（ref 29a42ea / issue：首次用 space-bunny 就报
// 「所有账号均受限」）。
//
// ⚠️ 反向验证：把 buddyIsModelSaturation 强制为 false（= 修复前行为），
// TestBuddyModelSaturationIsNotQuotaExhaustion 与
// TestBuddyInterceptorSkipsSaturation 立刻变红 —— 修复前 14003 会落进通用 429
// 分支，给每个账号写一条兜底冷却标记。

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinylab/tinylab/internal/upstreamerr"
)

// buddySaturationBody 是服务端原话（ref 29a42ea 的实测抓包）。
const buddySaturationBody = `{"code":14003,"msg":"too many requests",` +
	`"displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},` +
	`"displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},` +
	`"actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}`

// TestBuddyModelSaturationDetection 锁「模型级 vs 账号级」的判据边界。
func TestBuddyModelSaturationDetection(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   bool
	}{
		{"14003 原话", 429, buddySaturationBody, true},
		{"14003 字符串码", 429, `{"code":"14003"}`, true},
		{"窄文案：模型繁忙", 429, `{"msg":"模型繁忙"}`, true},
		{"窄文案：请求量饱和", 429, `{"msg":"这个模型请求量饱和"}`, true},
		{"窄文案：model busy", 429, `model busy`, true},
		{"窄文案：currently saturated", 429, `the model is currently saturated`, true},
		// ⚠️ 账号级额度限流（6004）**不得**被判成饱和 —— 它的换号 + 标记
		// 行为必须原样保留。
		{"6004 额度限流", 429, `{"code":6004,"msg":"频率限制，将在 2026-01-01 00:00 重置"}`, false},
		{"无判据的裸 429", 429, `{"code":9999,"msg":"too many requests"}`, false},
		// ⚠️ 泛词不算（模型正文里讨论「服务器繁忙」不得被误判）。
		{"泛词 busy", 429, `server busy`, false},
		{"泛词 saturated", 429, `the cache is saturated`, false},
		{"空 body", 429, ``, false},
		// ⚠️ 状态码 < 400 ⇒ 正常响应，正文里的字样不算错误。
		{"200 正文含字样", 200, `{"choices":[{"message":{"content":"模型繁忙时应当重试"}}]}`, false},
	}
	for _, c := range cases {
		if got := buddyIsModelSaturation(c.status, c.body); got != c.want {
			t.Errorf("%s: buddyIsModelSaturation(%d, …) = %v, want %v", c.name, c.status, got, c.want)
		}
	}
}

// TestBuddyModelSaturationIsNotQuotaExhaustion 锁「14003 同时满足通用 429 分类」
// 这条缺陷成因：判据必须**先于**状态码分支，否则永远走不到。
func TestBuddyModelSaturationIsNotQuotaExhaustion(t *testing.T) {
	// 通用分类对 429 给出 ActionBackoff（= 会走换号/冷却路径）。
	// 本判据必须在它之前把 14003 拦下来。
	if !buddyIsModelSaturation(429, buddySaturationBody) {
		t.Fatal("14003 必须被识别为模型饱和（否则落进通用 429 分支锁死整池）")
	}
	// 反向：账号级额度限流不得被误拦（6004 的换号行为不得回退）。
	if buddyIsModelSaturation(429, `{"code":6004,"msg":"频率限制"}`) {
		t.Fatal("6004 是账号级额度限流，不得被判成模型饱和")
	}
}

// TestBuddyInterceptorSkipsSaturation 锁拦截器的行为：饱和 ⇒ 返回
// ModelSaturationError（不换号、不写锁）；其它错误 ⇒ 原样透传且正文还回。
func TestBuddyInterceptorSkipsSaturation(t *testing.T) {
	m := newTestManager(t).m

	// ① 饱和：必须返回 ModelSaturationError，且 Reason 指向「换模型」。
	resp := &http.Response{
		StatusCode: 429,
		Body:       io.NopCloser(strings.NewReader(buddySaturationBody)),
		Header:     http.Header{},
	}
	_, _, err := m.buddyInterceptResponse(resp, "space-bunny")
	var mse *upstreamerr.ModelSaturationError
	if !errors.As(err, &mse) {
		t.Fatalf("saturation must yield ModelSaturationError, got %v", err)
	}
	if mse.RetryAfter <= 0 {
		t.Fatalf("RetryAfter must be positive, got %v", mse.RetryAfter)
	}
	if !strings.Contains(mse.Reason, "space-bunny") || !strings.Contains(mse.Reason, "换模型") {
		t.Fatalf("Reason must name the model and point at switching model, got %q", mse.Reason)
	}

	// ② 账号级额度限流：不得返回饱和错误，且正文必须**还回**给通用分类。
	quotaBody := `{"code":6004,"msg":"频率限制，将在 2026-01-01 00:00 重置"}`
	resp2 := &http.Response{
		StatusCode: 429,
		Body:       io.NopCloser(strings.NewReader(quotaBody)),
		Header:     http.Header{},
	}
	if _, _, err := m.buddyInterceptResponse(resp2, "space-bunny"); err != nil {
		t.Fatalf("quota 429 must pass through, got %v", err)
	}
	back, _ := io.ReadAll(resp2.Body)
	if string(back) != quotaBody {
		t.Fatalf("non-saturation body must be restored for the generic classifier, got %q", back)
	}

	// ③ 200：拦截器必须不碰（流式正文里的字样不算错误）。
	okResp := &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(`模型繁忙`)),
		Header:     http.Header{},
	}
	if _, _, err := m.buddyInterceptResponse(okResp, "space-bunny"); err != nil {
		t.Fatalf("2xx must be untouched, got %v", err)
	}
}

// TestBuddyInterceptorDispatchedFromManager 锁分派接线：Manager.InterceptResponse
// 对 buddy/workbuddy 走本拦截器（漏接线 = 缺陷原样存在，且不会有任何报错）。
func TestBuddyInterceptorDispatchedFromManager(t *testing.T) {
	m := newTestManager(t).m
	for _, provider := range []string{"buddy", "workbuddy"} {
		resp := &http.Response{
			StatusCode: 429,
			Body:       io.NopCloser(strings.NewReader(buddySaturationBody)),
			Header:     http.Header{},
		}
		_, _, err := m.InterceptResponse(
			httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil),
			resp, ProviderID(provider), "key-1", "space-bunny", false)
		var mse *upstreamerr.ModelSaturationError
		if !errors.As(err, &mse) {
			t.Fatalf("%s: InterceptResponse must dispatch to the buddy hook, got %v", provider, err)
		}
	}
}
