package jethub

// ZCode 营销投放解析测试（纯函数，无网络）。

import (
	"strings"
	"testing"
)

// 实测形态（2026-10-23）：1024 活动只在 marketing/touch 的 banner 按钮里；
// 同一份 plan 元数据被镜像到 banner.background.args 与 success_popup.hero.args。
const zcodeMarketingFixture = `[{
  "campaign_id":"2113475573403824128",
  "priority":5,
  "banner":{
    "background":{"type":"image","args":{
      "plan_id":"zcode-v3-start-plan-1024","name":"1024 程序员节","priority":101,
      "entitlements":[
        {"show_name":"GLM-5.3-Flash","unit_type":"token","grant_units":300000000},
        {"show_name":"GLM-5.3","unit_type":"token","grant_units":200000000}
      ]
    }},
    "buttons":[
      {"text":"了解详情","action":{"type":"close","args":null}},
      {"text":"立即领取","action":{"type":"claim_zcode_plan","args":{"plan_id":"zcode-v3-start-plan-1024"}}}
    ],
    "success_popup":{"hero":{"args":{"plan_id":"zcode-v3-start-plan-1024"}},"buttons":[
      {"action":{"type":"claim_zcode_plan","args":{"plan_id":"zcode-v3-start-plan-1024"}}}
    ]}
  },
  "popup":{"buttons":[{"action":{"type":"open_url","args":{"url":"https://x"}}}]}
},{
  "campaign_id":"c2",
  "banner":{"buttons":[{"action":{"type":"claim_zcode_plan","args":{"plan_id":"plan-small"}}}]}
}]`

func TestZcodeClaimablePlansFromMarketingDeliveries(t *testing.T) {
	var deliveries any
	if err := jsonUnmarshal([]byte(zcodeMarketingFixture), &deliveries); err != nil {
		t.Fatal(err)
	}
	plans := zcodeClaimablePlansFromDeliveries(deliveries)
	if len(plans) != 2 {
		t.Fatalf("plans = %d, want 2 (dedupe mirrors; close/open_url are not claims): %#v", len(plans), plans)
	}
	first := plans[0]
	if first.PlanID != "zcode-v3-start-plan-1024" {
		t.Fatalf("plan id = %q", first.PlanID)
	}
	if first.GrantUnits != 500000000 || first.UnitType != "token" {
		t.Fatalf("grant = %v %q, want 500000000 token (3亿+2亿; 只取第一条会少报 2 亿)", first.GrantUnits, first.UnitType)
	}
	if first.Priority != 101 {
		t.Fatalf("priority = %v, want 101 (metadata wins over delivery priority)", first.Priority)
	}
	if first.Name != "1024 程序员节" {
		t.Fatalf("name = %q", first.Name)
	}
	if first.MarketingCampaignID != "2113475573403824128" {
		t.Fatalf("campaign = %q", first.MarketingCampaignID)
	}
	// 第二个没有 plan 元数据：priority 回落 delivery 的 0（不存在 ⇒ 0），无额度。
	if plans[1].PlanID != "plan-small" || plans[1].GrantUnits != 0 || plans[1].MarketingCampaignID != "c2" {
		t.Fatalf("fallback plan wrong: %#v", plans[1])
	}

	// 非数组 / 畸形输入不抛。
	if got := zcodeClaimablePlansFromDeliveries(nil); len(got) != 0 {
		t.Fatalf("nil deliveries = %#v", got)
	}
	if got := zcodeClaimablePlansFromDeliveries(map[string]any{"x": 1}); len(got) != 0 {
		t.Fatalf("object deliveries = %#v", got)
	}
	// close 的 args=null 不得产出空 plan。
	onlyClose := []any{map[string]any{"banner": map[string]any{"buttons": []any{
		map[string]any{"action": map[string]any{"type": "close", "args": nil}},
	}}}}
	if got := zcodeClaimablePlansFromDeliveries(onlyClose); len(got) != 0 {
		t.Fatalf("close must never be a claim: %#v", got)
	}
}

func TestZcodeMarketingGrantSumUnitMixing(t *testing.T) {
	record := map[string]any{"entitlements": []any{
		map[string]any{"unit_type": "token", "grant_units": float64(100)},
		map[string]any{"unit_type": "credit", "grant_units": float64(999)},
		map[string]any{"unit_type": "token", "grant_units": "50"},
		map[string]any{"unit_type": "token"},
	}}
	units, unitType, ok := zcodeMarketingGrantSum(record)
	if !ok || units != 150 || unitType != "token" {
		t.Fatalf("sum = %v %q ok=%v, want 150 token (不同单位不混加)", units, unitType, ok)
	}
	if _, _, ok := zcodeMarketingGrantSum(map[string]any{}); ok {
		t.Fatal("missing entitlements must report ok=false (0 is a valid grant)")
	}
}

func TestZcodeMergeClaimablePlans(t *testing.T) {
	preview := []zcodeClaimablePlan{
		{PlanID: "daily", Priority: 10, Name: "每日", GrantUnits: 100000000, UnitType: "token"},
		{PlanID: "shared", Priority: 20, Name: "preview 版本"},
	}
	marketing := []zcodeClaimablePlan{
		{PlanID: "shared", Priority: 99, Name: "marketing 版本", GrantUnits: 500000000, UnitType: "token", MarketingCampaignID: "camp-1"},
		{PlanID: "1024", Priority: 101, Name: "1024", GrantUnits: 500000000, UnitType: "token", MarketingCampaignID: "camp-2"},
	}
	merged := zcodeMergeClaimablePlans(preview, marketing)
	if len(merged) != 3 {
		t.Fatalf("merged = %d, want 3", len(merged))
	}
	if merged[0].PlanID != "1024" || merged[1].PlanID != "shared" || merged[2].PlanID != "daily" {
		t.Fatalf("order = %v,%v,%v (priority desc)", merged[0].PlanID, merged[1].PlanID, merged[2].PlanID)
	}
	// preview 那份优先（额度口径已实测），只借 campaign id。
	shared := merged[1]
	if shared.Name != "preview 版本" || shared.Priority != 20 || shared.MarketingCampaignID != "camp-1" {
		t.Fatalf("preview entry must win with campaign id borrowed: %#v", shared)
	}
	// 营销独有的 plan 进入列表。
	if merged[0].MarketingCampaignID != "camp-2" {
		t.Fatalf("marketing-only plan lost its campaign id: %#v", merged[0])
	}
}

func TestZcodeParseClaimablePlansReadsEntitlements(t *testing.T) {
	fixture := `{"code":0,"data":{"plans":[{"plan_id":"p1","priority":3,"name":"每日",` +
		`"entitlements":[{"show_name":"GLM-5.3","unit_type":"token","grant_units":100000000}]}]}}`
	plans := zcodeParseClaimablePlans([]byte(fixture))
	if len(plans) != 1 {
		t.Fatalf("plans = %d", len(plans))
	}
	if plans[0].GrantUnits != 100000000 || plans[0].UnitType != "token" {
		t.Fatalf("preview entitlement not read (面板会显示 +0): %#v", plans[0])
	}
	// plan 顶层没有额度字段 ⇒ 保持 0（不猜）。
	bare := zcodeParseClaimablePlans([]byte(`{"data":{"plans":[{"plan_id":"p2"}]}}`))
	if len(bare) != 1 || bare[0].GrantUnits != 0 {
		t.Fatalf("bare plan = %#v", bare)
	}
}

// TestZcodeConfirmOnlyAfterSuccess 记录语义：confirm 只对营销来源、且只在
// outcome.OK 后发送；失败 / 无 campaign 一律不发。这是纯判据，接线在
// zcodeClaimOnePlan（见实现注释）。
func TestZcodeConfirmOnlyAfterSuccess(t *testing.T) {
	cases := []struct {
		name       string
		ok         bool
		campaignID string
		want       bool
	}{
		{"success+marketing", true, "camp-1", true},
		{"already-claimed+marketing", true, "camp-2", true},
		{"failed+marketing", false, "camp-3", false},
		{"success+preview-only", true, "", false},
	}
	for _, tc := range cases {
		if got := tc.ok && strings.TrimSpace(tc.campaignID) != ""; got != tc.want {
			t.Fatalf("%s: confirm = %v, want %v", tc.name, got, tc.want)
		}
	}
}
