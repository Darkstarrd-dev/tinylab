package jethub

// ZCode 营销投放（`/api/v1/marketing/touch`）：活动签发入口。
//
// ## 为什么必须有这条来源（R10，用户报障 2026-10-23）
//
// 「1024 程序员节 5 亿 token」活动**不在** `billing/preview`：本机实测 4 个账号
// 的 preview `data.plans` 恒为 `[]`，活动只出现在营销投放的
// banner 按钮 `claim_zcode_plan{plan_id}` 里。只查 preview 时它与「今天没活动」
// **同形**（没有任何报错）⇒ 用户永远领不到。
//
// ## 版本门控（两个端点都成立）
//
// 同一账号、其余头完全相同：
//
//	X-ZCode-App-Version: 3.14.3 → deliveries [] / claim 400+1004 no permission
//	                      3.16.3 → deliveries 有 / claim 200+code 0
//
// ⇒ 营销查询与**领取**都必须按请求覆盖版本（zcodeGatedAppVersion）。
// 只抬查询不抬领取 = 「看得到、领不到」，而 1004 看起来像账号没资格。
//
// ## 领取成功后必须回报 confirm
//
// 不回报的后果不是「少了记账」，而是服务端继续重复投放同一 campaign ⇒ 每轮
// 签到都为已领 plan 再 mint 一次 captcha（设备级配额，每小时 150 次）。
// **只在成功/已领取后回报**：失败时回报等于告诉服务端「别再给我看了」，
// 用户会白丢一次机会（cancel 语义，本实现从不发送）。

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// zcodeMarketingTouchURL 是营销投放查询端点（只读）。
	zcodeMarketingTouchURL = zcodeOrigin + "/api/v1/marketing/touch"
	// zcodeMarketingActionURL 是营销动作回执端点（confirm / cancel）。
	zcodeMarketingActionURL = zcodeOrigin + "/api/v1/marketing/touch/action"
	// zcodeMarketingScanMaxDepth bounds the recursive scan: the delivery is
	// server-controlled arbitrary JSON (same rule as captcha assets).
	zcodeMarketingScanMaxDepth = 8
)

// zcodeMarketingPlanMeta is one plan description mirrored into a delivery's
// asset slots (banner background / success popup hero / ...).
type zcodeMarketingPlanMeta struct {
	Name       string
	Priority   float64
	HasPrio    bool
	GrantUnits float64
	UnitType   string
	HasGrant   bool
}

// zcodeJSONNumber accepts JSON numbers and numeric strings; missing values are
// distinguished from 0 (jsonNumberField would collapse them).
func zcodeJSONNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

// zcodeMarketingGrantSum sums `entitlements[].grant_units` of the SAME unit
// type (1024 plan has two: 3亿 Flash + 2亿 base = 5亿; preview only reported
// the first ⇒ 少报 2 亿).
func zcodeMarketingGrantSum(record map[string]any) (units float64, unitType string, ok bool) {
	raw, _ := record["entitlements"].([]any)
	saw := false
	for _, item := range raw {
		entry, isMap := item.(map[string]any)
		if !isMap {
			continue
		}
		value, hasValue := zcodeJSONNumber(entry["grant_units"])
		if !hasValue {
			continue
		}
		typ, _ := entry["unit_type"].(string)
		if unitType == "" && typ != "" {
			unitType = typ
		}
		// 单位不同不混加（宁可少报，也不把 token 与积分加成一个数）。
		if typ != unitType {
			continue
		}
		units += value
		saw = true
	}
	return units, unitType, saw
}

// zcodeCollectMarketingPlanMetas recursively indexes every plan-shaped object
// by `plan_id` (the same plan is mirrored into several asset slots; hardcoding
// one path breaks on the next campaign redesign).
func zcodeCollectMarketingPlanMetas(root any) map[string]*zcodeMarketingPlanMeta {
	out := map[string]*zcodeMarketingPlanMeta{}
	var visit func(node any, depth int)
	visit = func(node any, depth int) {
		if depth > zcodeMarketingScanMaxDepth || node == nil {
			return
		}
		switch value := node.(type) {
		case []any:
			for _, item := range value {
				visit(item, depth+1)
			}
		case map[string]any:
			if planID, _ := value["plan_id"].(string); strings.TrimSpace(planID) != "" {
				meta := out[planID]
				if meta == nil {
					meta = &zcodeMarketingPlanMeta{}
					out[planID] = meta
				}
				if name, _ := value["name"].(string); name != "" {
					meta.Name = name
				}
				if priority, ok := zcodeJSONNumber(value["priority"]); ok && !meta.HasPrio {
					meta.Priority = priority
					meta.HasPrio = true
				}
				if units, unitType, ok := zcodeMarketingGrantSum(value); ok {
					meta.GrantUnits = units
					meta.UnitType = unitType
					meta.HasGrant = true
				}
			}
			for _, child := range value {
				visit(child, depth+1)
			}
		}
	}
	visit(root, 0)
	return out
}

// zcodeMarketingButtonsOf collects every button of a delivery: banner,
// banner.success_popup, and popup (official schema allows one resource position
// plus the banner's success popup).
func zcodeMarketingButtonsOf(delivery map[string]any) []map[string]any {
	var out []map[string]any
	push := func(raw any) {
		list, _ := raw.([]any)
		for _, item := range list {
			if button, ok := item.(map[string]any); ok {
				out = append(out, button)
			}
		}
	}
	if banner, ok := delivery["banner"].(map[string]any); ok {
		push(banner["buttons"])
		if popup, ok := banner["success_popup"].(map[string]any); ok {
			push(popup["buttons"])
		}
	}
	if popup, ok := delivery["popup"].(map[string]any); ok {
		push(popup["buttons"])
	}
	return out
}

// zcodeClaimablePlansFromDeliveries extracts plans whose button action is
// `{type:"claim_zcode_plan", args:{plan_id}}`. Every other action (close /
// open_url / navigate / copy_text) is NOT a claim — treating `close` as one
// would fire a request with an empty plan id.
func zcodeClaimablePlansFromDeliveries(deliveries any) []zcodeClaimablePlan {
	list, _ := deliveries.([]any)
	var plans []zcodeClaimablePlan
	seen := map[string]bool{}
	for _, item := range list {
		delivery, ok := item.(map[string]any)
		if !ok {
			continue
		}
		campaignID, _ := delivery["campaign_id"].(string)
		metas := zcodeCollectMarketingPlanMetas(delivery)
		fallbackPriority, _ := zcodeJSONNumber(delivery["priority"])
		for _, button := range zcodeMarketingButtonsOf(delivery) {
			action, ok := button["action"].(map[string]any)
			if !ok {
				continue
			}
			if typ, _ := action["type"].(string); typ != "claim_zcode_plan" {
				continue
			}
			args, _ := action["args"].(map[string]any)
			planID, _ := args["plan_id"].(string)
			if strings.TrimSpace(planID) == "" || seen[planID] {
				continue
			}
			seen[planID] = true
			meta := metas[planID]
			plan := zcodeClaimablePlan{PlanID: planID, Priority: fallbackPriority}
			if meta != nil {
				if meta.Name != "" {
					plan.Name = meta.Name
				}
				if meta.HasPrio {
					plan.Priority = meta.Priority
				}
				if meta.HasGrant {
					plan.GrantUnits = meta.GrantUnits
					plan.UnitType = meta.UnitType
				}
			}
			if campaignID != "" {
				plan.MarketingCampaignID = campaignID
			}
			plans = append(plans, plan)
		}
	}
	return plans
}

// zcodeMergeClaimablePlans merges preview ∪ marketing by plan id, keeping the
// preview entry (its reward accounting is the measured one) but borrowing the
// marketing campaign id so the claim reports confirm. Sorted by priority desc.
func zcodeMergeClaimablePlans(preview, marketing []zcodeClaimablePlan) []zcodeClaimablePlan {
	byID := map[string]zcodeClaimablePlan{}
	order := make([]string, 0, len(preview)+len(marketing))
	for _, plan := range preview {
		if _, ok := byID[plan.PlanID]; ok {
			continue
		}
		byID[plan.PlanID] = plan
		order = append(order, plan.PlanID)
	}
	for _, plan := range marketing {
		existing, ok := byID[plan.PlanID]
		if !ok {
			byID[plan.PlanID] = plan
			order = append(order, plan.PlanID)
			continue
		}
		if existing.MarketingCampaignID == "" {
			existing.MarketingCampaignID = plan.MarketingCampaignID
			byID[plan.PlanID] = existing
		}
	}
	out := make([]zcodeClaimablePlan, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	zcodeSortPlansByPriority(out)
	return out
}

// zcodeSortPlansByPriority sorts descending (official: claim high priority first).
func zcodeSortPlansByPriority(plans []zcodeClaimablePlan) {
	sort.SliceStable(plans, func(i, j int) bool { return plans[i].Priority > plans[j].Priority })
}

// FetchZcodeMarketingPlans queries the marketing deliveries (read-only).
// Failure degrades to an empty slice — marketing is a supplement, never the
// main path (preview must still work).
func (m *Manager) FetchZcodeMarketingPlans(ctx context.Context, cred *ZcodeCredential) []zcodeClaimablePlan {
	// 20s cap: this is an auxiliary source inside the claim flow.
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	endpoint := zcodeMarketingTouchURL + "?seq=0"
	status, raw, err := m.zcodeGetVersion(fetchCtx, cred, endpoint, cred.zcodeGatedAppVersion(), nil)
	if err != nil || status < 200 || status >= 300 {
		return nil
	}
	var parsed struct {
		Data *struct {
			Deliveries any `json:"deliveries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil {
		return nil
	}
	return zcodeClaimablePlansFromDeliveries(parsed.Data.Deliveries)
}

// zcodeReportMarketingAction reports confirm/cancel (best-effort write).
// Returns true only for `{"code":0}` (official z.literal(0) idiom).
func (m *Manager) zcodeReportMarketingAction(ctx context.Context, cred *ZcodeCredential, campaignID, actionType string) bool {
	if strings.TrimSpace(campaignID) == "" || actionType == "" {
		return false
	}
	payload, _ := json.Marshal(map[string]any{"campaign_id": campaignID, "action_type": actionType})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, zcodeMarketingActionURL, bytes.NewReader(payload))
	if err != nil {
		return false
	}
	for k, v := range zcodeHeaders(cred, true, nil) {
		req.Header.Set(k, v)
	}
	resp, err := m.zcodeClientFor().Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	var parsed struct {
		Code any `json:"code"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false
	}
	code, ok := zcodeJSONNumber(parsed.Code)
	return ok && code == 0
}
