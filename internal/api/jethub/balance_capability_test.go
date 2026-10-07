package jethub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// balanceRoutes enumerates every GET `…/<provider>/balance` route the panel may
// call, returning `provider → route`.
func balanceRoutes(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	r, ok := h.(*chi.Mux)
	if !ok {
		t.Fatalf("expected *chi.Mux, got %T", h)
	}
	out := map[string]string{}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || !strings.HasSuffix(route, "/balance") {
			return nil
		}
		// `…/jethub/<provider>/balance` 或 `…/jethub/<provider>/balance/…`
		rest := route[strings.Index(route, "/jethub/")+len("/jethub/"):]
		if idx := strings.IndexByte(rest, '/'); idx > 0 {
			out[rest[:idx]] = route
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	return out
}

// TestProviderBalanceCapabilitiesMatchImplementation 是「能力位 ↔ 实现」的
// 双向守卫。
//
// ## 为什么必须双向
//
// `ProviderMeta.HasBalance` 是前端渲染额度行与「刷新积分」按钮的**唯一**门控
// （`provider.hasBalance`，见 web/static/jethub.js）。两类漂移都**不会报错**，
// 只会在界面上静默消失或永远失败：
//
//   - **实现有、标志缺** ⇒ 该渠道**永远不显示额度数字**（真实缺陷：
//     minimax / raccoon / trae / cline 四家的余额后端早就实现且路由已挂，
//     但 `defaultProviders` 漏登记 ⇒ 用户看到的是「这几个渠道没有积分」）。
//     用户报障原文：「Minimax, DSH 里会显示 credits 数字，Tinylab 里不会显示
//     （不止这一个，还有不少也都不显示 credits 数字）」。
//   - **标志有、实现缺** ⇒ 面板挂载时对每个账号发一个必然 404 的请求，
//     卡片永远停在「查询失败」（与 CodeArts 早期形态同因）。
//
// 断言只看路由表（不读 provider 字面量表），故**新增 provider 时自动纳入**：
// 忘了登记标志或忘了挂路由，这条用例立刻报红。
func TestProviderBalanceCapabilitiesMatchImplementation(t *testing.T) {
	srv, _ := newStatusHandler(t)
	routes := balanceRoutes(t, srv)
	if len(routes) < 10 {
		t.Fatalf("walked only %d balance routes (%v) — the enumeration is broken, not the code",
			len(routes), routes)
	}

	capable := map[string]bool{}
	for _, meta := range corejethub.Providers() {
		capable[meta.ID] = meta.HasBalance
	}

	for provider, route := range routes {
		if !capable[provider] {
			t.Errorf("%s: /balance route exists (%s) but ProviderMeta.HasBalance is false — the panel will never show the credits row; register the flag in internal/jethub/manager.go",
				provider, route)
		}
	}
	for provider, has := range capable {
		if !has {
			continue
		}
		if _, ok := routes[provider]; !ok {
			t.Errorf("%s: HasBalance=true but no GET …/%s/balance route — the panel would render a row that can only ever say 查询失败",
				provider, provider)
		}
	}

	// 反向验证的锚点：四家「实现有、标志曾缺」的渠道必须真的在表里，
	// 否则上面两条断言可能因为枚举失效而空转。
	for _, provider := range []string{"minimax", "raccoon", "trae", "cline", "opencode"} {
		if !capable[provider] {
			t.Errorf("%s must be registered as having a balance reading (regression)", provider)
		}
		if _, ok := routes[provider]; !ok {
			t.Errorf("%s must expose a balance route (regression)", provider)
		}
	}
}

// TestRateLimitActionsExempt 锁定「重测/重置按钮对哪些渠道不渲染」。
//
// loomy 是唯一的子类：**根本不返回限流错误**（今日赠送额度用完后静默降级去扣
// 永久积分）⇒ 重测永远测不出东西、重置没有标记可清，按钮只剩白烧额度。
//
// （R3-3 曾把 gemini 也登记在此：它的限流是服务端配额窗口制，重测/重置同样只会
// 白烧配额。R5 删除该渠道后本条只剩 loomy。）
func TestRateLimitActionsExempt(t *testing.T) {
	srv, _ := newStatusHandler(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/providers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("provider list = %d %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Providers []struct {
			ID                string `json:"id"`
			SupportsRateLimit bool   `json:"supportsRateLimit"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("provider list is not JSON: %v", err)
	}
	got := map[string]bool{}
	for _, p := range payload.Providers {
		got[p.ID] = p.SupportsRateLimit
	}
	for provider, want := range map[string]bool{
		"loomy": false, // 根本不返回限流错误
		"qoder": true,  // 会回 429/额度错误，重测/重置有意义
		"zcode": true,
	} {
		value, ok := got[provider]
		if !ok {
			t.Errorf("%s missing from the provider list", provider)
			continue
		}
		if value != want {
			t.Errorf("%s: supportsRateLimit = %v, want %v", provider, value, want)
		}
	}
}

// TestProviderClaimSemantics 锁定「领取」的语义位。
//
// 原版能力矩阵把 `dailyCheckin` 与 `onboardingTasks` 分成**两个彼此独立的位**，
// 不能互相推断：
//   - dailyCheckin：**每天**有收益（面板文案「领取」）；
//   - onboardingTasks：**一次性**（每号只能领一次固定总额）。
//
// 混用是用户可见的错误：把一次性奖励写成「领取」，用户会每天点一次必然
// already-claimed 的请求（raccoon 的每日积分由**服务端按日自动发放**，根本没有
// 可调用的签到端点）。
func TestProviderClaimSemantics(t *testing.T) {
	srv, _ := newStatusHandler(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/providers", nil))
	var payload struct {
		Providers []struct {
			ID                      string `json:"id"`
			HasCredits              bool   `json:"hasCredits"`
			ClaimKind               string `json:"claimKind"`
			SupportsOnboardingTasks bool   `json:"supportsOnboardingTasks"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("provider list is not JSON: %v", err)
	}
	byID := map[string]struct {
		hasCredits bool
		kind       string
		onboarding bool
	}{}
	for _, p := range payload.Providers {
		byID[p.ID] = struct {
			hasCredits bool
			kind       string
			onboarding bool
		}{p.HasCredits, p.ClaimKind, p.SupportsOnboardingTasks}
	}
	for provider, want := range map[string]struct {
		hasCredits bool
		kind       string
		onboarding bool
	}{
		// raccoon：唯一的接口是**一次性**登录奖励 ⇒ 必须是 onboarding，
		// 且**不得**再渲染一个「新手任务」按钮（同一个动作不该出现两次）。
		"raccoon": {true, "onboarding", false},
		// loomy：每日签到 + **另有**一次性新手任务（两个独立按钮）。
		"loomy": {true, "daily", true},
		// workbuddy 国际版：后端无签到接口 ⇒ 不渲染领取按钮。
		"workbuddy": {false, "daily", false},
		"qoder":     {true, "daily", false},
		"codearts":  {true, "daily", false},
	} {
		got, ok := byID[provider]
		if !ok {
			t.Errorf("%s missing from the provider list", provider)
			continue
		}
		if got.hasCredits != want.hasCredits || got.kind != want.kind || got.onboarding != want.onboarding {
			t.Errorf("%s: hasCredits=%v claimKind=%q onboarding=%v, want %v/%q/%v",
				provider, got.hasCredits, got.kind, got.onboarding, want.hasCredits, want.kind, want.onboarding)
		}
	}
}
