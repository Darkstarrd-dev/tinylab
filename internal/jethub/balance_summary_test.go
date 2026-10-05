package jethub

// BalanceSummaryOf 聚合 / 单位归一 / TTL 缓存测试。
//
// ⚠️ 用的 mock 渠道是 loomy（既有 newSeedLoomyManager 夹具可打 mock 上游），
// 但被测对象是**渠道无关**的聚合层 —— 换任何一个可 mock 的渠道结论都一样。
// 纯函数（normalizedBalanceUnit / zcodeBalanceToCredit）单独覆盖。

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// resetBalanceCache 清掉包级缓存（测试之间不得互相泄漏读数）。
func resetBalanceCache() {
	InvalidateBalanceSummary("")
}

func TestBalanceSummaryAggregatesPerUnit(t *testing.T) {
	resetBalanceCache()
	m := newSeedLoomyManager(t)
	id := firstLoomyAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000","data":{"balance":15000,"dailyBalance":4992,"availableBalance":19992}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	if sum.OKCount != 1 || sum.FailedCount != 0 {
		t.Fatalf("ok/failed = %d/%d", sum.OKCount, sum.FailedCount)
	}
	if len(sum.Groups) != 1 {
		t.Fatalf("one unit group expected: %+v", sum.Groups)
	}
	if sum.Groups[0].Unit != "credit" {
		t.Fatalf("unit = %q, want credit (loomy 的「积分」必须归一)", sum.Groups[0].Unit)
	}
	if sum.Groups[0].Total != 19992 {
		t.Fatalf("total = %v, want 19992", sum.Groups[0].Total)
	}
	_ = id
}

func TestBalanceSummaryFailedAccountsNotCountedAsZero(t *testing.T) {
	resetBalanceCache()
	m := newSeedLoomyManager(t)
	// 第二个账号：不落凭据 ⇒ **不查也不算失败**（它不是「读数故障」）。
	id2, ref2 := NewAccountID("loomy")
	if err := m.AddAccount(Account{ID: id2, Provider: "loomy", Enabled: true, CredentialRef: ref2}); err != nil {
		t.Fatal(err)
	}
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000","data":{"balance":100,"dailyBalance":0,"availableBalance":100}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	if sum.OKCount != 1 {
		t.Fatalf("only the credentialed account is queried, ok = %d", sum.OKCount)
	}
	if sum.FailedCount != 0 {
		t.Fatalf("credential-less accounts are not failures, failed = %d", sum.FailedCount)
	}
	if sum.Groups[0].Total != 100 {
		t.Fatalf("total = %v, want 100", sum.Groups[0].Total)
	}
}

// TestBalanceSummaryAllFailedCachesBriefly：**全部**账号读不到数时用短 TTL
// （15s）缓存，且**不返回 error**（读数失败是读数的一部分，不是调用错误）。
func TestBalanceSummaryAllFailedCachesBriefly(t *testing.T) {
	resetBalanceCache()
	oldTTL := balanceTTLFailure
	balanceTTLFailure = 50 * time.Millisecond
	t.Cleanup(func() { balanceTTLFailure = oldTTL })

	m := newSeedLoomyManager(t)
	var failedHits int
	bad := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		failedHits++
		w.Write([]byte(`{"code":"000000"}`)) // 缺 balance 字段 ⇒ 形状错误
	})
	restoreLoomyAPIBase(t, bad.URL)

	sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatalf("per-account failures must not surface as an error: %v", err)
	}
	if sum.OKCount != 0 || sum.FailedCount != 1 || len(sum.Groups) != 0 {
		t.Fatalf("all-failed summary wrong: %+v", sum)
	}
	// 失败缓存期内第二次调用不得再打上游。
	if _, err := m.BalanceSummaryOf(context.Background(), "loomy"); err != nil {
		t.Fatal(err)
	}
	if failedHits != 1 {
		t.Fatalf("failure cache must absorb the second call, hits = %d", failedHits)
	}
	// 过期后换好上游 ⇒ 必须重新聚合。
	time.Sleep(80 * time.Millisecond)
	var okHits int
	good := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		okHits++
		w.Write([]byte(`{"code":"000000","data":{"balance":1,"dailyBalance":0,"availableBalance":1}}`))
	})
	restoreLoomyAPIBase(t, good.URL)
	sum, err = m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	if sum.OKCount != 1 || sum.Groups[0].Total != 1 || okHits != 1 {
		t.Fatalf("post-TTL refresh wrong: %+v hits=%d", sum, okHits)
	}
}

func TestBalanceSummarySuccessCacheHits(t *testing.T) {
	resetBalanceCache()
	oldTTL := balanceTTLSuccess
	balanceTTLSuccess = 10 * time.Second
	t.Cleanup(func() { balanceTTLSuccess = oldTTL })

	m := newSeedLoomyManager(t)
	var hits int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"code":"000000","data":{"balance":7,"dailyBalance":0,"availableBalance":7}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	for i := 0; i < 3; i++ {
		sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
		if err != nil {
			t.Fatal(err)
		}
		if sum.Groups[0].Total != 7 {
			t.Fatalf("total = %v", sum.Groups[0].Total)
		}
	}
	if hits != 1 {
		t.Fatalf("success cache must absorb repeat calls, hits = %d", hits)
	}
}

func TestBalanceSummaryNoAccounts(t *testing.T) {
	resetBalanceCache()
	m := newTestManager(t).m
	if _, err := m.BalanceSummaryOf(context.Background(), "loomy"); err == nil {
		t.Fatal("no accounts must error (未桥接的渠道不该出现在 Monitor)")
	}
}

// TestBalanceSummaryCredentialArrivalShowsImmediately 锁住登录流程的时序：
// 登录是「先落账号、后落凭据」，中间那一轮聚合「一个能查的账号都没有」。
// 那个空结果**绝不能入缓存**，否则刚登录成功的渠道在 Monitor 上会空白 120s。
//
// ⚠️ 凭据在这里**绕过 SetCredential 直接写进 map**（同包测试），正是为了排除
// 「靠 SetCredential 的缓存失效兜住」这条旁路 —— 只有「空轮次不入缓存」这一条
// 实现能让下面的断言通过。
func TestBalanceSummaryCredentialArrivalShowsImmediately(t *testing.T) {
	resetBalanceCache()
	m := newTestManager(t).m
	id, ref := NewAccountID("loomy")
	if err := m.AddAccount(Account{ID: id, Provider: "loomy", Nickname: id, Enabled: true, CredentialRef: ref}); err != nil {
		t.Fatal(err)
	}
	sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	if sum.OKCount != 0 || sum.FailedCount != 0 || len(sum.Groups) != 0 {
		t.Fatalf("account without credential is neither ok nor failed: %+v", sum)
	}

	cred := BuildLoomyCredential(strings.Repeat("ab", 16), "123456789012345678", "13011111100", "")
	raw, _ := json.Marshal(cred)
	m.mu.Lock()
	if m.credentials["loomy"] == nil {
		m.credentials["loomy"] = map[string]json.RawMessage{}
	}
	m.credentials["loomy"][ref] = raw
	m.mu.Unlock()

	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000","data":{"balance":4200,"dailyBalance":0,"availableBalance":4200}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)

	sum, err = m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	if sum.OKCount != 1 || len(sum.Groups) != 1 || sum.Groups[0].Total != 4200 {
		t.Fatalf("reading must appear as soon as the credential lands: %+v", sum)
	}
}

// --- 纯函数：单位归一 ---

func TestNormalizedBalanceUnit(t *testing.T) {
	cases := []struct {
		name    string
		balance *CreditBalance
		unit    string
		ok      bool
	}{
		{"zcode token", &CreditBalance{Packages: []CreditPackage{{Unit: "token", Remaining: 30095000}}}, "token", true},
		{"plain credit", &CreditBalance{Packages: []CreditPackage{{Unit: "credit", Remaining: 5}}}, "credit", true},
		{"credits 拼法", &CreditBalance{Packages: []CreditPackage{{Unit: "credits", Remaining: 5}}}, "credit", true},
		{"中文积分", &CreditBalance{Packages: []CreditPackage{{Unit: "积分", Remaining: 5}}}, "credit", true},
		{"空串归积分", &CreditBalance{Packages: []CreditPackage{{Remaining: 5}}}, "credit", true},
		{"gemini 百分比不可累加", &CreditBalance{Packages: []CreditPackage{{Unit: "%", Remaining: 95}}}, "", false},
		{"opencode 通道不可累加", &CreditBalance{Packages: []CreditPackage{{Unit: "通道", Remaining: 1}}}, "", false},
		{"minimax 无包有 Total", &CreditBalance{Total: 800, IsCredit: true}, "credit", true},
		{"zcode 企业版无数字", &CreditBalance{}, "", false},
		{"nil", nil, "", false},
	}
	for _, tc := range cases {
		unit, ok := normalizedBalanceUnit(tc.balance)
		if unit != tc.unit || ok != tc.ok {
			t.Errorf("%s: got (%q,%v), want (%q,%v)", tc.name, unit, ok, tc.unit, tc.ok)
		}
	}
}

func TestZcodeBalanceToCreditKeepsTokenUnit(t *testing.T) {
	result, err := zcodeParseBalance([]byte(zcodeBalanceFixture))
	if err != nil {
		t.Fatal(err)
	}
	out := zcodeBalanceToCredit(result)
	if out.Total != result.Remaining {
		t.Fatalf("total must pass through: %v", out.Total)
	}
	if len(out.Packages) != 2 || out.Packages[0].Unit != "token" {
		t.Fatalf("token unit must be preserved: %+v", out.Packages)
	}
	// expires_at 秒级 ×1000（1970 年缺陷回归锚点）。
	if out.Packages[0].DeductionEndTime != 1790000000*1000 {
		t.Fatalf("deduction end must be ms: %v", out.Packages[0].DeductionEndTime)
	}
}

func TestBalanceSummaryJSONShape(t *testing.T) {
	resetBalanceCache()
	m := newSeedLoomyManager(t)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":"000000","data":{"balance":3000,"dailyBalance":0,"availableBalance":3000}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)
	sum, err := m.BalanceSummaryOf(context.Background(), "loomy")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(sum)
	// 字段名是前端契约（groups/unit/total/okCount/failedCount）。
	for _, fragment := range []string{`"groups"`, `"unit":"credit"`, `"total":3000`, `"okCount":1`, `"failedCount":0`} {
		if !strings.Contains(string(data), fragment) {
			t.Fatalf("JSON missing %s: %s", fragment, data)
		}
	}
}

// TestInvalidateBalanceSummary 清缓存后必须重新打上游。
func TestInvalidateBalanceSummary(t *testing.T) {
	resetBalanceCache()
	oldTTL := balanceTTLSuccess
	balanceTTLSuccess = time.Minute
	t.Cleanup(func() { balanceTTLSuccess = oldTTL })

	m := newSeedLoomyManager(t)
	var hits int
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"code":"000000","data":{"balance":2,"dailyBalance":0,"availableBalance":2}}`))
	})
	restoreLoomyAPIBase(t, srv.URL)
	if _, err := m.BalanceSummaryOf(context.Background(), "loomy"); err != nil {
		t.Fatal(err)
	}
	InvalidateBalanceSummary("loomy")
	if _, err := m.BalanceSummaryOf(context.Background(), "loomy"); err != nil {
		t.Fatal(err)
	}
	if hits != 2 {
		t.Fatalf("invalidate must force a re-query, hits = %d", hits)
	}
}

// 未知 provider / 无账号 ⇒ error（端点据此整体略过该渠道）。
func TestBalanceSummaryUnknownProviderErrors(t *testing.T) {
	resetBalanceCache()
	m := newTestManager(t).m
	if _, err := m.BalanceSummaryOf(context.Background(), "nonexistent"); err == nil {
		t.Fatal("unknown provider must error")
	}
	if _, err := m.BalanceSummaryOf(context.Background(), "loomy"); err == nil {
		t.Fatal("a provider with no account must error")
	}
}
