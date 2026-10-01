package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- expires_at：非 JWT token ⇒ 必须从 expires_in 自算 ---

func TestMinimaxExpiresAtMsUnits(t *testing.T) {
	// 毫秒值直读。
	if got := MinimaxExpiresAtMs(&MinimaxCredential{ExpiresAt: "1800000000000"}); got != 1800000000000 {
		t.Fatalf("ms: %d", got)
	}
	// ⚠️ 秒值换算（不兼容会把秒值当 1970 → 恒判过期 → 无谓续期）。
	if got := MinimaxExpiresAtMs(&MinimaxCredential{ExpiresAt: "1800000000"}); got != 1800000000000 {
		t.Fatalf("sec → ms: %d", got)
	}
	// 非纯数字非法 → 0（JWT 兜底当前恒不命中）。
	if got := MinimaxExpiresAtMs(&MinimaxCredential{ExpiresAt: " 123 "}); got != 0 {
		t.Fatalf("non-numeric illegal: %d", got)
	}
	// JWT 形态兜底（上游将来改发 JWT 时仍工作）。
	tok := mustJWT(t, map[string]any{"exp": 2000000000.0})
	if got := MinimaxExpiresAtMs(&MinimaxCredential{AccessToken: tok}); got != 2000000000000 {
		t.Fatalf("JWT fallback: %d", got)
	}
}

// --- token grant 硬校验（scope 必须含 agent.default） ---

func TestParseMinimaxTokenGrantValidations(t *testing.T) {
	now := nowMillis()
	cred, err := parseMinimaxTokenGrant(map[string]any{
		"access_token": "mmoat_" + strings.Repeat("a", 54), "refresh_token": "mmort_" + strings.Repeat("r", 54),
		"token_type": "Bearer", "expires_in": 3600.0, "scope": "agent.default other.scope",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cred.AccessToken, "mmoat_") {
		t.Fatalf("token preserved: %q", cred.AccessToken)
	}
	// expires_at 以 expires_in 自算（token 非 JWT，无别处可取）。
	if got := MinimaxExpiresAtMs(cred); got < now+3600*1000-2000 || got > now+3600*1000+2000 {
		t.Fatalf("expires_in-based: %d", got)
	}

	// token_type 非 Bearer → 拒绝。
	if _, err := parseMinimaxTokenGrant(map[string]any{
		"access_token": "x", "refresh_token": "y", "token_type": "MAC", "expires_in": 60.0, "scope": "agent.default",
	}, ""); err == nil {
		t.Fatal("non-bearer token_type must be rejected")
	}
	// scope 缺 agent.default → 无效凭据。
	if _, err := parseMinimaxTokenGrant(map[string]any{
		"access_token": "x", "refresh_token": "y", "token_type": "Bearer", "expires_in": 60.0, "scope": "other",
	}, ""); err == nil || !strings.Contains(err.Error(), "agent.default") {
		t.Fatalf("scope validation: %v", err)
	}
	// refresh_token 缺失 → 回退 previous。
	cred2, err := parseMinimaxTokenGrant(map[string]any{
		"access_token": "x", "token_type": "Bearer", "expires_in": 60.0, "scope": "agent.default",
	}, "prev-rt")
	if err != nil || cred2.RefreshToken != "prev-rt" {
		t.Fatalf("refresh fallback: %v %+v", err, cred2)
	}
}

// --- 设备码响应解析（interval 缺省 5 秒；verification_url 别名） ---

func TestParseMinimaxDeviceAuthorization(t *testing.T) {
	grant := parseMinimaxDeviceAuthorization(map[string]any{
		"device_code": "dc", "user_code": "uc", "verification_url": "https://v",
		"expires_in": 300.0,
	})
	if grant == nil {
		t.Fatal("verification_url alias must be accepted")
	}
	if grant.IntervalSec != 5 {
		t.Fatalf("interval default 5s: %v", grant.IntervalSec)
	}
	// 三字段缺一即无效。
	if parseMinimaxDeviceAuthorization(map[string]any{"device_code": "dc"}) != nil {
		t.Fatal("missing fields must reject")
	}
}

// --- 轮询双形态（MiniMax 用 200+status=pending！非标准 400+error） ---

func TestPollMinimaxDeviceTokenDualForm(t *testing.T) {
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			// ⚠️ MiniMax 形态一：HTTP 200 + status=pending（标准是 400+error）。
			// 若只认标准形态，这里会被当成 grant 成功而存下空凭据。
			w.Write([]byte(`{"status":"pending"}`))
		case 2:
			w.Write([]byte(`{"status":"slow_down"}`))
		default:
			w.Write([]byte(`{"access_token":"mmoat_x","refresh_token":"mmort_y","token_type":"Bearer","expires_in":3600,"scope":"agent.default"}`))
		}
	})
	restoreMinimaxAccountHost(t, srv.URL)

	grant := &minimaxDeviceAuthorization{DeviceCode: "dc", CodeVerifier: "cv", VerificationURI: "u", IntervalSec: 1, ExpiresInSec: 60}
	m := newTestManager(t).m
	cred, err := m.PollMinimaxDeviceToken(context.Background(), grant)
	if err != nil {
		t.Fatal(err)
	}
	if cred.AccessToken != "mmoat_x" || cred.RefreshToken != "mmort_y" {
		t.Fatalf("tokens wrong: %+v", cred)
	}
	if calls < 3 {
		t.Fatalf("pending/slow_down must keep polling: %d", calls)
	}
	// 表单体必须带 device_code + code_verifier + grant_type。
}

func TestPollMinimaxDeniedTerminal(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"denied"}`))
	})
	restoreMinimaxAccountHost(t, srv.URL)
	grant := &minimaxDeviceAuthorization{DeviceCode: "dc", VerificationURI: "u", IntervalSec: 1, ExpiresInSec: 60}
	m := newTestManager(t).m
	_, err := m.PollMinimaxDeviceToken(context.Background(), grant)
	if err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("denied is terminal: %v", err)
	}
}

func TestPollMinimaxStandardErrorForm(t *testing.T) {
	var calls int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			// 形态二：OAuth 标准 400 + error=authorization_pending。
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"authorization_pending"}`))
			return
		}
		w.Write([]byte(`{"access_token":"mmoat_x","refresh_token":"mmort_y","token_type":"Bearer","expires_in":60,"scope":"agent.default"}`))
	})
	restoreMinimaxAccountHost(t, srv.URL)
	grant := &minimaxDeviceAuthorization{DeviceCode: "dc", VerificationURI: "u", IntervalSec: 1, ExpiresInSec: 60}
	m := newTestManager(t).m
	if _, err := m.PollMinimaxDeviceToken(context.Background(), grant); err != nil {
		t.Fatalf("standard error form must keep polling: %v", err)
	}
}

// --- 签到面板解析（7 天硬约束 + 最多 1 可领/1 今日） ---

func buildPanelDay(dayNo int, status int, points string, isToday bool) map[string]any {
	return map[string]any{"day_no": float64(dayNo), "status": float64(status), "points": points, "is_today": isToday, "bonus_points": "400"}
}

func TestParseMinimaxSigninPanelConstraints(t *testing.T) {
	days := []any{}
	for i := 1; i <= 7; i++ {
		st := int64(minimaxStatusClaimed)
		if i == 7 {
			st = minimaxStatusClaimable
		}
		days = append(days, buildPanelDay(i, int(st), "800", i == 7))
	}
	panel := map[string]any{"scene": float64(minimaxSceneActive), "days": days}
	parsed, scene := parseMinimaxSigninPanel(panel)
	if parsed == nil || scene != minimaxSceneActive {
		t.Fatalf("valid panel rejected: %v %v", parsed, scene)
	}
	// 8 条 → 拒绝。
	days = append(days, buildPanelDay(8, minimaxStatusClaimed, "800", false))
	if p, _ := parseMinimaxSigninPanel(map[string]any{"scene": float64(2), "days": days}); p != nil {
		t.Fatal("8 days must be rejected")
	}
	// 2 条 Claimable → 拒绝（asar 硬约束）。
	days7 := days[:7]
	days7[5] = buildPanelDay(6, minimaxStatusClaimable, "800", false)
	if p, _ := parseMinimaxSigninPanel(map[string]any{"scene": float64(2), "days": days7}); p != nil {
		t.Fatal("two claimable days must be rejected")
	}
	// 非法 status → 拒绝。
	days7[5] = buildPanelDay(6, 99, "800", false)
	if p, _ := parseMinimaxSigninPanel(map[string]any{"scene": float64(2), "days": days7}); p != nil {
		t.Fatal("status 99 must be rejected")
	}
}

// --- CheckinStatus 映射：dailyCredit=points（不相加 bonus）；active 恒 true ---

func TestMinimaxPanelToStatus(t *testing.T) {
	days := []any{}
	for i := 1; i <= 7; i++ {
		st := int64(minimaxStatusClaimed)
		if i == 7 {
			st = minimaxStatusClaimable
		}
		days = append(days, buildPanelDay(i, int(st), "800", i == 7))
	}
	parsed, _ := parseMinimaxSigninPanel(map[string]any{"scene": float64(2), "days": days})
	status := minimaxPanelToStatus(parsed)
	if !status.Active {
		t.Fatal("⚠️ active 恒 true（不按「有可领项」判——否则把已领误报成活动未开启）")
	}
	if status.TodayCheckedIn {
		t.Fatal("today is claimable, not claimed")
	}
	// dailyCredit = points（800），不是 points+bonus（1200）。
	if status.DailyCredit != 800 {
		t.Fatalf("dailyCredit = points: %v", status.DailyCredit)
	}
	if status.StreakDays != 6 {
		t.Fatalf("streak from day6 back: %v", status.StreakDays)
	}
	// 今日已领 → TodayCredit = points。
	for i := range days {
		days[i] = buildPanelDay(i+1, minimaxStatusClaimed, "800", i == 6)
	}
	parsed2, _ := parseMinimaxSigninPanel(map[string]any{"scene": float64(3), "days": days})
	status2 := minimaxPanelToStatus(parsed2)
	if !status2.TodayCheckedIn || status2.TodayCredit != 800 || status2.StreakDays != 7 {
		t.Fatalf("all-claimed panel: %+v", status2)
	}
}

// --- 领取：claim_result 幂等判据（不是 HTTP 状态） ---

func TestClaimMinimaxDailyIdempotent(t *testing.T) {
	m := newSeedMinimaxManager(t)
	id := firstMinimaxAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "timezone_id=") {
			t.Error("⚠️ timezone_id 是必填 query 参数")
		}
		w.Write([]byte(`{"claim_result":2,"base_resp":{"status_code":0}}`))
	})
	restoreMinimaxAPIHost(t, srv.URL)
	outcome, err := m.ClaimMinimaxDaily(context.Background(), id, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "already-claimed" {
		t.Fatalf("⚠️ claim_result=2 → already-claimed（重复领取同样 200）: %+v", outcome)
	}
}

func TestClaimMinimaxDailySuccess(t *testing.T) {
	m := newSeedMinimaxManager(t)
	id := firstMinimaxAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"claim_result":1,"points":800,"base_resp":{"status_code":0}}`))
	})
	restoreMinimaxAPIHost(t, srv.URL)
	outcome, err := m.ClaimMinimaxDaily(context.Background(), id, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 800 {
		t.Fatalf("claimed +800: %+v", outcome)
	}
}

// --- 余额：total_count 是条数不是余额！（生产数据推翻的误读） ---

func TestMinimaxBalanceRemainingAmountSum(t *testing.T) {
	m := newSeedMinimaxManager(t)
	id := firstMinimaxAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// 平铺响应（无 data 键）；remaining_amount 是字符串。
		w.Write([]byte(`{"details":[{"remaining_amount":"800.00","consumed_amount":"0.00","granted_amount":"800.00","credit_type":2,"granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],"total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}`))
	})
	restoreMinimaxAPIHost(t, srv.URL)
	bal, err := m.MinimaxBalance(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	// ⚠️ total_count=1 是条数；真实余额是 remaining_amount=800。
	if bal.Total != 800 {
		t.Fatalf("balance = Σ remaining_amount: %v (total_count 是条数不是余额！)", bal.Total)
	}
}

func TestMinimaxBalanceMissingDetailsIsZero(t *testing.T) {
	m := newSeedMinimaxManager(t)
	id := firstMinimaxAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		// details 缺失 → 余额 0（真的为 0），不是失败。
		w.Write([]byte(`{"total_count":0,"base_resp":{"status_code":0}}`))
	})
	restoreMinimaxAPIHost(t, srv.URL)
	bal, err := m.MinimaxBalance(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 0 {
		t.Fatalf("missing details ⇒ 0 (truly zero): %v", bal.Total)
	}
}

// --- augment：Anthropic 原生透传（无 anthropic-version——实测不需要） ---

func TestMinimaxAugmentHeaders(t *testing.T) {
	m := newSeedMinimaxManager(t)
	id := firstMinimaxAccount(t, m)
	req, _ := http.NewRequest(http.MethodPost, "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages", nil)
	out, err := m.minimaxAugment(req, []byte(`{"model":"MiniMax-M3","messages":[]}`), "jethub-minimax", id, "MiniMax-M3")
	if err != nil {
		t.Fatal(err)
	}
	// 进站 Anthropic（/v1/messages 结尾，探针也走这条）→ body 原样透传，只补
	// stream:true：上游只实现了流式分支，而 Anthropic 的 stream 缺省是 false。
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["model"] != "MiniMax-M3" || parsed["stream"] != true {
		t.Fatalf("Anthropic native body must pass through with stream:true, got %s", out)
	}
	if _, ok := parsed["messages"]; !ok {
		t.Fatalf("messages must be preserved: %s", out)
	}
	if req.Header.Get("Authorization") != "Bearer mmoat_tok" {
		t.Fatalf("bearer wrong: %q", req.Header.Get("Authorization"))
	}
	// ⚠️ 不加 anthropic-version（实测 2026-09-29 不需要——加未经验证的头是猜测）。
	if req.Header.Get("anthropic-version") != "" {
		t.Fatal("anthropic-version must NOT be added (unverified guess)")
	}
	if req.Header.Get("Accept") != "text/event-stream" {
		t.Fatal("SSE accept expected")
	}
}

// --- 续期 mock ---

func TestRefreshMinimaxMock(t *testing.T) {
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"access_token":"mmoat_new","refresh_token":"mmort_new","token_type":"Bearer","expires_in":7200,"scope":"agent.default"}`))
	})
	restoreMinimaxAccountHost(t, srv.URL)
	m := newTestManager(t).m
	refreshed, err := m.RefreshMinimaxCredential(context.Background(), &MinimaxCredential{AccessToken: "old", RefreshToken: "old-rt"})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "mmoat_new" || refreshed.RefreshToken != "mmort_new" {
		t.Fatalf("refreshed wrong: %+v", refreshed)
	}
}

// --- 测试基建 ---

func restoreMinimaxAccountHost(t *testing.T, mockURL string) {
	t.Helper()
	old := minimaxProduct.AccountHost
	minimaxProduct.AccountHost = mockURL
	t.Cleanup(func() { minimaxProduct.AccountHost = old })
}

func restoreMinimaxAPIHost(t *testing.T, mockURL string) {
	t.Helper()
	old := minimaxProduct.APIHost
	minimaxProduct.APIHost = mockURL
	t.Cleanup(func() { minimaxProduct.APIHost = old })
}

func newSeedMinimaxManager(t *testing.T) *Manager {
	t.Helper()
	m := newTestManager(t).m
	id, ref := NewAccountID("minimax")
	if err := m.AddAccount(Account{ID: id, Provider: "minimax", Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	cred := &MinimaxCredential{AccessToken: "mmoat_tok", RefreshToken: "mmort_rt", ExpiresAt: "2099-01-01T00:00:00Z"}
	cred.ExpiresAt = "4000000000000"
	data, _ := json.Marshal(cred)
	if err := m.SetCredential("minimax", ref, data, MinimaxExpiresAtMs(cred), true); err != nil {
		t.Fatal(err)
	}
	return m
}

func firstMinimaxAccount(t *testing.T, m *Manager) string {
	t.Helper()
	accounts := m.Accounts("minimax")
	if len(accounts) == 0 {
		t.Fatal("no seeded minimax account")
	}
	return accounts[0].ID
}
