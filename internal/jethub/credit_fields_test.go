package jethub

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// 本文件锁的是「账号卡片额度行的**附加信息**」——这些字段原先在本端被解析出来
// 又丢掉（buddy 的 DeductionEndTime、raccoon 的池、trae 的整张包表），导致面板
// 上只有一行合计数字，而上游会显示「长期 X · 临时 Y」「长期 X · 每日 Y」、资源包
// 数量、已失效额度与 hover 明细。

// TestBuddyBalanceCarriesExpiryAndExpiredTotal: 到期字段必须透传（分桶与 hover
// 明细都要它），失效包的额度必须单独给出（不能并进 Total，也不能丢）。
//
// 反向验证：把 `DeductionEndTime: deductionEnd` 那行删掉，或者把
// `out.ExpiredTotal = ...` 改回 `_ = expired`，本用例立刻变红。
func TestBuddyBalanceCarriesExpiryAndExpiredTotal(t *testing.T) {
	// deductionEnd 取自上游实测字段名 `DeductionEndTime`（毫秒）。有效包用远期时刻
	// （实测「Free Plan」的扣费截止在 8 年后），失效包不带到期也无所谓。
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":0,"data":{"Response":{"Data":{"Accounts":[
			{"PackageName":"Bonus Pack","Status":0,"CycleCapacityRemain":100,"CycleCapacitySize":100,
			 "DeductionEndTime":253402214400000,"ExpiredTime":""},
			{"PackageName":"Gone","Status":3,"CycleCapacityRemain":40,"DeductionEndTime":1600000000000,
			 "ExpiredTime":"2026-10-01 00:00:00"}
		]}}}}`))
	})
	defer srv.Close()
	old := buddyProductsMap
	buddyProductsMap = map[string]*BuddyProduct{
		"buddy": {ID: "buddy", Endpoint: srv.URL, APIDomain: "x", ProductCode: "codebuddy", UserAgent: testUA},
	}
	defer func() { buddyProductsMap = old }()

	m := newTestManager(t).m
	id, ref := NewAccountID("buddy")
	_ = m.AddAccount(Account{ID: id, Provider: "buddy", Enabled: true, CredentialRef: ref})
	data, _ := json.Marshal(&BuddyCredential{AccessToken: "t"})
	_ = m.SetCredential("buddy", ref, data, 1, true)

	bal, err := m.BuddyBalance(context.Background(), "buddy", id)
	if err != nil {
		t.Fatal(err)
	}
	if len(bal.Packages) != 2 {
		t.Fatalf("packages = %d, want 2", len(bal.Packages))
	}
	active := bal.Packages[0]
	if active.DeductionEndTime != 253402214400000 {
		t.Fatalf("active package must carry DeductionEndTime (面板的临时/长期分桶靠它), got %d", active.DeductionEndTime)
	}
	expiredPkg := bal.Packages[1]
	if expiredPkg.Active {
		t.Fatal("Status=3 must be inactive")
	}
	if expiredPkg.ExpiresAt != "2026-10-01 00:00:00" {
		t.Fatalf("ExpiredTime must be passed through verbatim, got %q", expiredPkg.ExpiresAt)
	}
	if bal.Total != 100 {
		t.Fatalf("total = %v, want 100（失效包不计入）", bal.Total)
	}
	if bal.ExpiredTotal != 40 {
		t.Fatalf("expiredTotal = %v, want 40（「另有 N 已失效」的唯一数据源；不能并进 total，也不能丢）", bal.ExpiredTotal)
	}
}

// TestTraeBalanceEntitlementPacks: TRAE 的余额来自**顶层**
// `user_entitlement_pack_list`（旧版猜的 data.totalCredits/creditRemain/remain
// 三个键都不存在），且到期是**秒级** `expire_time`。
func TestTraeBalanceEntitlementPacks(t *testing.T) {
	body := map[string]any{
		"user_entitlement_pack_list": []any{
			map[string]any{
				"entitlement_base_info": map[string]any{
					"display_desc": "每月登录赠送",
					"quota":        map[string]any{"credits_limit": float64(500)},
				},
				"usage":       map[string]any{"credits_amount": float64(120)},
				"expire_time": float64(1790783999), // 秒级
			},
			map[string]any{
				"entitlement_base_info": map[string]any{
					"display_desc": "签到奖励",
					"quota":        map[string]any{"credits_limit": float64(100)},
				},
				"usage": map[string]any{"credits_amount": float64(200)}, // 越界：clamp 到 limit
			},
		},
	}
	bal, err := traePackagesFromEntries(traeEntitlementPacks(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(bal.Packages) != 2 {
		t.Fatalf("packages = %d, want 2", len(bal.Packages))
	}
	first := bal.Packages[0]
	if first.Name != "每月登录赠送" {
		t.Fatalf("package name must come from display_desc, got %q", first.Name)
	}
	if first.Remaining != 380 || first.Total != 500 || first.Used != 120 {
		t.Fatalf("credits_limit - credits_amount mismatch: %+v", first)
	}
	if first.DeductionEndTime != 1790783999000 {
		t.Fatalf("expire_time is SECONDS and must be ×1000, got %d", first.DeductionEndTime)
	}
	if bal.Packages[1].Remaining != 0 {
		t.Fatalf("used > limit must clamp to 0 remaining, got %v", bal.Packages[1].Remaining)
	}
	if bal.Total != 380 {
		t.Fatalf("total = %v, want 380", bal.Total)
	}

	// 信封形态（网关包了 data）也要认，否则会得到「0 个包」的假阴性。
	wrapped := map[string]any{"data": body}
	if got := traeEntitlementPacks(wrapped); len(got) != 2 {
		t.Fatalf("enveloped response must be accepted, got %d packs", len(got))
	}
	// 没有任何包 ⇒ 显式报错（不返回一个 total=0 的假余额）。
	if _, err := traePackagesFromEntries(nil); err == nil {
		t.Fatal("no packs must error, not report a 0 balance")
	}
}

// TestRaccoonBalancePools: 各池分开作包（旧的 `balance` 字段根本不存在），
// 「每日积分」必须单独出现 —— 面板靠池名分桶显示「今天有多少会作废」。
func TestRaccoonBalancePools(t *testing.T) {
	bal, err := raccoonBalanceFromPools(map[string]any{
		"available_points": float64(1234),
		"reward_points":    float64(1000),
		"daily_points":     float64(234),
		"monthly_points":   float64(0), // 0 ⇒ 不列（与「字段缺失」区分）
		"topup_points":     float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if bal.Total != 1234 {
		t.Fatalf("total must come from available_points, got %v", bal.Total)
	}
	names := []string{}
	for _, p := range bal.Packages {
		names = append(names, p.Name)
	}
	want := []string{"奖励积分", "每日积分", "充值积分"}
	if len(names) != len(want) {
		t.Fatalf("pools = %v, want %v（会员积分为 0 不列；充值积分字段存在即列）", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("pools = %v, want %v", names, want)
		}
	}
	// 缺 available_points ⇒ 报错（不是显示 0）。
	if _, err := raccoonBalanceFromPools(map[string]any{"daily_points": float64(5)}); err == nil {
		t.Fatal("missing available_points must error (查不到 ≠ 0)")
	}
	// 只有总额没有分项时也要有包，否则面板空列表。
	only, err := raccoonBalanceFromPools(map[string]any{"available_points": float64(7)})
	if err != nil || len(only.Packages) != 1 || only.Packages[0].Name != "可用积分" {
		t.Fatalf("total-only response must synthesize one pool: %+v %v", only, err)
	}
}

// TestExpiringWindowDaysEnv: 窗口天数可由环境变量覆盖，且 `0` 是合法值
// （不能用 `||` 静默换成默认值 —— 那会让「没有临时积分一档」变成 15 天）。
func TestExpiringWindowDaysEnv(t *testing.T) {
	if got := buddyExpiringWindowDays(); got != buddyExpiringWindowDefaultDays {
		t.Fatalf("default = %d, want %d", got, buddyExpiringWindowDefaultDays)
	}
	t.Setenv(buddyExpiringWindowEnv, "31")
	if got := buddyExpiringWindowDays(); got != 31 {
		t.Fatalf("override = %d, want 31", got)
	}
	t.Setenv(buddyExpiringWindowEnv, "0")
	if got := buddyExpiringWindowDays(); got != 0 {
		t.Fatalf("0 must be a legal value (no expiring bucket), got %d", got)
	}
	t.Setenv(buddyExpiringWindowEnv, "not-a-number")
	if got := buddyExpiringWindowDays(); got != buddyExpiringWindowDefaultDays {
		t.Fatalf("illegal value must fall back to the default, got %d", got)
	}
}

// TestQoderPackagesCarryDedicatedExpiry: 专用资源包的 `expiresAt` 必须变成到期
// 时刻（套餐额度/普通资源包没有独立到期 ⇒ 不设，面板显示「长期」而不是编日期）。
func TestQoderPackagesCarryDedicatedExpiry(t *testing.T) {
	withExpiry := qoderToPackage("专用资源包", map[string]any{
		"total": float64(100), "used": float64(10),
		"expiresAt": "2026-10-21T14:54:12.176671Z",
	})
	if withExpiry == nil {
		t.Fatal("package must parse")
	}
	if withExpiry.ExpiresAt != "2026-10-21T14:54:12.176671Z" {
		t.Fatalf("expiresAt must be passed through, got %q", withExpiry.ExpiresAt)
	}
	if withExpiry.DeductionEndTime <= 0 {
		t.Fatalf("a dated package must carry DeductionEndTime, got %d", withExpiry.DeductionEndTime)
	}
	// 快照口径：套餐额度没有到期字段 ⇒ 不设到期（≠ 已过期）。
	plain := qoderToPackage("套餐额度", map[string]any{"total": float64(400), "used": float64(0)})
	if plain.DeductionEndTime != 0 || plain.ExpiresAt != "" {
		t.Fatalf("a package without an expiry must stay dateless (显示「长期」): %+v", plain)
	}
}
