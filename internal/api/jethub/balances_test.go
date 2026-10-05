package jethub

// `GET /api/jethub/balances`（Monitor 页 QuotaMonitor 的「Provider · 余额」读数）
// 的路由/形状/守门测试。
//
// ⚠️ 为什么这里只测路由与守门、不测具体数字：数值聚合需要打上游，而本包
// （api 层）拿不到 internal/jethub 的 mock 挂钩（loomyProduct.APIBase 未导出）；
// 逐账号读数与单位聚合的用例在 `internal/jethub/balance_summary_test.go`。
// 本文件守着的是**接线**：路由存在、形状稳定、不可累加的渠道一个都不出现。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// balanceSummaryPayload mirrors the endpoint's response shape.
type balanceSummaryPayload struct {
	Balances map[string]struct {
		Groups []struct {
			Unit  string  `json:"unit"`
			Total float64 `json:"total"`
		} `json:"groups"`
		OKCount     int `json:"okCount"`
		FailedCount int `json:"failedCount"`
	} `json:"balances"`
}

func getBalances(t *testing.T, srv http.Handler) balanceSummaryPayload {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/jethub/balances", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("balances = %d %s", rec.Code, rec.Body.String())
	}
	var payload balanceSummaryPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("balances is not JSON: %v (%s)", err, rec.Body.String())
	}
	if payload.Balances == nil {
		t.Fatalf("balances must be an object (even when empty): %s", rec.Body.String())
	}
	return payload
}

// TestProviderBalancesRouteAndGating：空账号池 ⇒ 200 + `{}`（不是 404/500），
// 且出现的每个渠道都必须「有余额能力 + 可跨账号求和」。
func TestProviderBalancesRouteAndGating(t *testing.T) {
	srv, _ := newStatusHandler(t)
	payload := getBalances(t, srv)
	if len(payload.Balances) != 0 {
		t.Fatalf("no accounts ⇒ no readings, got %+v", payload.Balances)
	}

	capable := map[string]bool{}
	for _, meta := range corejethub.Providers() {
		capable[meta.ID] = meta.HasBalance
	}
	for id, sum := range payload.Balances {
		if !capable[id] {
			t.Errorf("%s: reading returned for a provider whose HasBalance is false", id)
		}
		if nonAggregatableProviders[id] {
			t.Errorf("%s: non-aggregatable provider must never appear", id)
		}
		if len(sum.Groups) == 0 {
			t.Errorf("%s: a reading with no groups must be omitted, not returned empty", id)
		}
	}
}

// TestProviderBalancesSkipsNonAggregatableChannels 锁两条**不显示**的渠道：
//
//   - opencode：有账号、读得到（本地状态、零网络），但单位是「通道」——
//     那不是可累加的余额，不得出现在 Monitor 的余额读数里；
//   - gemini：读数是配额窗口百分比，**不查**（连请求都不发）。
func TestProviderBalancesSkipsNonAggregatableChannels(t *testing.T) {
	srv, m := newStatusHandler(t)
	// 匿名 opencode 账号：零网络即可建，且读数确实读得到（Total=1）。
	if _, _, err := m.AddOpencodeAccount("", "anon", true); err != nil {
		t.Fatalf("seed opencode account: %v", err)
	}
	payload := getBalances(t, srv)
	if _, ok := payload.Balances["opencode"]; ok {
		t.Fatalf("opencode 的「通道」不是可累加余额，必须被略过: %+v", payload.Balances["opencode"])
	}
	if _, ok := payload.Balances["gemini"]; ok {
		t.Fatal("gemini 的百分比窗口不可累加，必须被略过")
	}
}
