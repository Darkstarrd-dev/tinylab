package jethub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestParseRateLimitResetTime: 限流文案里的解禁时刻（ref RESET_TIME_PATTERN）。
//
// ⚠️ 两种句式都必须认（中文 = CodeBuddy 国内版、英文 = WorkBuddy 国际版）：
// 早期只列中文，导致国际版即使判定为限流也只能走兜底时长、丢掉服务端给的真实时刻。
// ⚠️ 时区从文案里**捕获**（`UTC±N`），不是写死 UTC+8。
func TestParseRateLimitResetTime(t *testing.T) {
	// 2026-09-11 18:08:17 UTC+8 == 2026-09-11 10:08:17 UTC
	wantCN := time.Date(2026, 9, 11, 10, 8, 17, 0, time.UTC).UnixMilli()
	got := parseRateLimitResetTime(`{"msg":"您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"}`)
	if got != wantCN {
		t.Fatalf("中文句式: got %d, want %d (%s)", got, wantCN, time.UnixMilli(got).UTC())
	}
	// 英文句式（不带秒）。
	wantEN := time.Date(2026, 9, 17, 1, 9, 36, 0, time.UTC).UnixMilli()
	got = parseRateLimitResetTime(`your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, upgrade`)
	if got != wantEN {
		t.Fatalf("英文句式: got %d, want %d", got, wantEN)
	}
	// 负偏移（UTC-5）：墙钟 12:00 表示 UTC 17:00。
	wantNeg := time.Date(2026, 9, 11, 17, 0, 0, 0, time.UTC).UnixMilli()
	if got = parseRateLimitResetTime(`将在 2026-09-11 12:00:00 UTC-5 重置`); got != wantNeg {
		t.Fatalf("负偏移: got %d, want %d", got, wantNeg)
	}
	// 半时区（UTC+5:30）：墙钟 12:00 表示 UTC 06:30。
	wantHalf := time.Date(2026, 9, 11, 6, 30, 0, 0, time.UTC).UnixMilli()
	if got = parseRateLimitResetTime(`将在 2026-09-11 12:00:00 UTC+5:30 重置`); got != wantHalf {
		t.Fatalf("半时区: got %d, want %d", got, wantHalf)
	}
	// 解析不出来 ⇒ 0（让调用方保持原值，而不是猜一个时刻）。
	for _, msg := range []string{
		`limited`,
		``,
		`将在 2026-09-11 18:08:17 重置`, // 无时区：语义不明确，不猜
		`将在 明天 重置`,
	} {
		if got := parseRateLimitResetTime(msg); got != 0 {
			t.Fatalf("msg %q must yield 0, got %d", msg, got)
		}
	}
}

// TestRetestPushesResetTimeForward: 重测「仍受限」时必须把上游给的**新**解禁时刻
// 写回标记。
//
// 为什么重要：限流是**滚动窗口**，每次撞到都会把解禁时刻往后推。只报「仍受限」
// 而不更新，存储里会一直留着第一次的旧时刻 —— 旧时刻一过期，卡片就不再渲染
// 「限额重置」（前端只显示未来的标记），于是出现「重测弹窗说仍受限、账号卡片却
// 一条都不显示」的矛盾。
//
// 反向验证：把 ratelimits.go 里那段 `parseRateLimitResetTime` + UpdateModelRateLimit
// 删掉，本用例立刻变红。
func TestRetestPushesResetTimeForward(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"msg":"您的使用量已超出频率限制，将在 2026-11-11 18:08:17 UTC+8 重置"}`))
	}))
	defer upstream.Close()

	b, m, accID, _ := newTestBridge(t)
	b.RegisterProduct(Product{Provider: "codearts", DisplayName: "t", BaseURL: upstream.URL})
	// 旧标记（已过期）——正是用户会看到「弹窗说仍受限、卡片却不显示」的起点。
	if err := m.UpdateModelRateLimit(accID, "GLM-5", 123); err != nil {
		t.Fatal(err)
	}
	res, err := b.RetestRateLimits(context.Background(), "codearts", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.ClearedCount != 0 || len(res.Accounts) != 1 {
		t.Fatalf("still-limited retest: %+v", res)
	}
	want := time.Date(2026, 11, 11, 10, 8, 17, 0, time.UTC).UnixMilli()
	acc, _ := m.FindAccount(accID)
	if got := acc.ModelRateLimits["GLM-5"]; got != want {
		t.Fatalf("marker must be pushed forward to the server-provided instant: got %d want %d", got, want)
	}
}

// TestUpdateModelRateLimitKeepsLongerMarker: 同一次限流会在多条路径上被重复上报
// （proxy 的 429 分支 + BillingLockError 分支），写入必须**只延长不缩短** ——
// 否则后到的那条会把解禁时刻往前提，用户按错误的时间等待，白撞一次墙。
func TestUpdateModelRateLimitKeepsLongerMarker(t *testing.T) {
	_, m, accID, _ := newTestBridge(t)
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	if err := m.UpdateModelRateLimit(accID, "GLM-5", future); err != nil {
		t.Fatal(err)
	}
	// 更早的时刻：不改写。
	if err := m.UpdateModelRateLimit(accID, "GLM-5", future-60000); err != nil {
		t.Fatal(err)
	}
	acc, _ := m.FindAccount(accID)
	if acc.ModelRateLimits["GLM-5"] != future {
		t.Fatalf("a shorter marker must not overwrite a longer one: %v", acc.ModelRateLimits)
	}
	// 更晚的时刻：延长。
	later := future + 3600_000
	if err := m.UpdateModelRateLimit(accID, "GLM-5", later); err != nil {
		t.Fatal(err)
	}
	acc, _ = m.FindAccount(accID)
	if acc.ModelRateLimits["GLM-5"] != later {
		t.Fatalf("a later marker must win: %v", acc.ModelRateLimits)
	}
	// 空模型名必须被忽略（会落下一个脏键：`modelRateLimits['']` 在 UI 上就是一条
	// 没有模型名的「限额重置」chip）。
	if err := m.UpdateModelRateLimit(accID, "", later); err != nil {
		t.Fatal(err)
	}
	acc, _ = m.FindAccount(accID)
	if _, ok := acc.ModelRateLimits[""]; ok {
		t.Fatalf("empty model id must be rejected: %v", acc.ModelRateLimits)
	}
	// 非 Free Hub key ⇒ ErrNotFound（proxy 侧的观察者对自配 provider 会走到这里）。
	if err := m.UpdateModelRateLimit("not-a-jethub-key", "m", later); err == nil {
		t.Fatal("unknown account must report ErrNotFound so the caller can ignore it")
	}
}
