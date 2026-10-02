package jethub

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// R1-3（ref 1b65a5c B1）：Qoder 每日活动 **10:00（UTC+8）** 才刷新 ——
// 刷新前看到的 CLAIMED 属于**昨天**那一轮；判成「今天已领」会让当天额度整天
// 漏领（真实损失 100 Credits/天，且用户不可见）。

// pinQoderNow fixes the campaign-window clock (the claim path reads it).
func pinQoderNow(t *testing.T, ms int64) {
	t.Helper()
	old := qoderNowMs
	qoderNowMs = func() int64 { return ms }
	t.Cleanup(func() { qoderNowMs = old })
}

// utc8Ms returns a fixed instant on 2026-10-02 at the given UTC+8 wall time
// (timezone-independent by construction).
func utc8Ms(hour, minute int) int64 {
	return time.Date(2026, 10, 2, hour-8, minute, 0, 0, time.UTC).UnixMilli()
}

func TestHasQoderCampaignRefreshedToday(t *testing.T) {
	if hasQoderCampaignRefreshedToday(utc8Ms(9, 59)) {
		t.Fatal("09:59 UTC+8 is before the 10:00 refresh")
	}
	if !hasQoderCampaignRefreshedToday(utc8Ms(10, 0)) {
		t.Fatal("10:00 UTC+8 must count as refreshed")
	}
	if !hasQoderCampaignRefreshedToday(utc8Ms(23, 30)) {
		t.Fatal("late evening must count as refreshed")
	}
	if hasQoderCampaignRefreshedToday(utc8Ms(0, 30)) {
		t.Fatal("00:30 UTC+8 is before the refresh")
	}
}

// TestClaimQoderBeforeRefreshNotRefreshed: 刷新前看到 CLAIMED 行 ⇒
// **inactive + 「尚未刷新」提示**（不是 already-claimed）；同一响应在刷新后
// 才是「今天已领取」。
func TestClaimQoderBeforeRefreshNotRefreshed(t *testing.T) {
	m := newSeedQoderManager(t)
	id := firstQoderAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"showCampaign":false,"claimable":false,"campaigns":[{"campaignId":"c-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMED"}]}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)

	pinQoderNow(t, utc8Ms(9, 0))
	outcome, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "inactive" || !strings.Contains(outcome.Message, "尚未刷新") {
		t.Fatalf("before 10:00 UTC+8 a CLAIMED row is yesterday's — must report 未刷新, got %+v", outcome)
	}
	if outcome.CoversToday == nil || *outcome.CoversToday {
		t.Fatalf("CoversToday must be false before the refresh, got %v", outcome.CoversToday)
	}

	pinQoderNow(t, utc8Ms(12, 0))
	outcome2, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome2.Kind != "already-claimed" || outcome2.Message != "今天已领取" {
		t.Fatalf("after the refresh the same row means today is claimed, got %+v", outcome2)
	}
	if outcome2.CoversToday != nil {
		t.Fatalf("after the refresh CoversToday must be unset (defaults to today), got %v", *outcome2.CoversToday)
	}
}

// TestClaimQoderBeforeRefreshClaimedCoversTodayFalse: 刷新前领到的是**昨日**
// 那条补领 —— 如实报「领取成功」但标 coversToday=false。
func TestClaimQoderBeforeRefreshClaimedCoversTodayFalse(t *testing.T) {
	m := newSeedQoderManager(t)
	id := firstQoderAccount(t, m)
	srv := newMockServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/campaigns") {
			w.Write([]byte(`{"showCampaign":true,"claimable":true,"campaigns":[{"campaignId":"c-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":100}}]}`))
			return
		}
		w.Write([]byte(`{"status":"CLAIMED","replayed":false,"benefit":{"amount":100}}`))
	})
	restoreQoderOpenAPIBase(t, srv.URL)

	pinQoderNow(t, utc8Ms(9, 0))
	outcome, err := m.ClaimQoderDailyCheckin(context.Background(), "qoder", id)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Kind != "claimed" || outcome.Credit != 100 {
		t.Fatalf("claim must still report success, got %+v", outcome)
	}
	if outcome.CoversToday == nil || *outcome.CoversToday {
		t.Fatalf("a pre-refresh claim is yesterday's round: CoversToday=false expected, got %v", outcome.CoversToday)
	}
	if !strings.Contains(outcome.Message, "昨日") {
		t.Fatalf("message must say the credit belongs to yesterday, got %q", outcome.Message)
	}
}
