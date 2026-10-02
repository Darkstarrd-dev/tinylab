package jethub

// ZCode 上游 HTTP：额度余额 / 模型目录 / captcha 配置 / 活跃上报 / 领取。
//
// 端点鉴权矩阵（ref src/zcode-upstream.ts，实测）：
//
//	GET  /zcode-plan/billing/balance   需要 Authorization（缺→401）+ X-Device-Mid（缺→400 code 3001）
//	GET  /zcode-plan/billing/preview   不需要 Authorization，但需要 X-Device-Mid
//	POST /api/v1/event/report          不需要 Authorization（活跃信号：不补则 preview 恒空）
//	POST /zcode-plan/billing/claim     需要 Authorization + X-Device-Mid + captcha 头
//	GET  /api/v1/client/configs        captcha 配置与模型目录（platform 必须是 `unknown`）
//
// ⚠️ 额度桶的单位是 **token**（`unit_type: "token"`，实测 1 亿），界面按 M 量级
// 显示；桶的 show_name 就是模型名 ⇒ 逐模型额度来自同一个端点。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// zcodeBalanceBucket is one `data.balances[]` entry.
type zcodeBalanceBucket struct {
	PlanID         string
	ShowName       string
	UnitType       string
	Meter          string
	TotalUnits     float64
	UsedUnits      float64
	RemainingUnits float64
	AvailableUnits float64
	HasAvailable   bool
	ExpiresAt      int64
}

// zcodeBalanceResult is the aggregated balance.
type zcodeBalanceResult struct {
	Enterprise bool
	Buckets    []zcodeBalanceBucket
	Remaining  float64
	Total      float64
	ExpiresAt  int64
	PlanName   string
}

// zcodeRemoteModel is one upstream catalog entry (builtinModels).
type zcodeRemoteModel struct {
	ID            string
	Name          string
	ContextWindow int
	MaxTokens     int
	SupportsImage bool
	Levels        []string
	DefaultLevel  string
}

// zcodeClaimablePlan is one `data.plans[]` entry.
type zcodeClaimablePlan struct {
	PlanID   string
	Priority float64
	Name     string
}

// zcodeClaimOutcome is one claim attempt.
type zcodeClaimOutcome struct {
	PlanID         string
	Code           int
	OK             bool
	AlreadyClaimed bool
	HTTPStatus     int
	Message        string
}

// zcodeGet performs a GET with the zcode header family.
func (m *Manager) zcodeGet(ctx context.Context, cred *ZcodeCredential, endpoint string, captcha *zcodeCaptchaParam) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, err
	}
	for k, v := range zcodeHeaders(cred, false, captcha) {
		req.Header.Set(k, v)
	}
	resp, err := m.zcodeClientFor().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, raw, nil
}

// FetchZcodeBalance queries the per-model token buckets.
func (m *Manager) FetchZcodeBalance(ctx context.Context, cred *ZcodeCredential) (*zcodeBalanceResult, error) {
	status, raw, err := m.zcodeGet(ctx, cred, zcodeBillingBalanceURL, nil)
	if err != nil {
		return nil, fmt.Errorf("zcode: 查询额度失败：%w", err)
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("zcode: 查询额度失败（HTTP %d）：%.200s", status, string(raw))
	}
	return zcodeParseBalance(raw)
}

// zcodeParseBalance is the pure parse step (split out for tests).
func zcodeParseBalance(raw []byte) (*zcodeBalanceResult, error) {
	var parsed struct {
		Data *struct {
			DisplayMode string `json:"displayMode"`
			Balances    []struct {
				PlanID         string   `json:"plan_id"`
				ShowName       string   `json:"show_name"`
				UnitType       string   `json:"unit_type"`
				Meter          string   `json:"meter"`
				TotalUnits     *float64 `json:"total_units"`
				UsedUnits      *float64 `json:"used_units"`
				RemainingUnits *float64 `json:"remaining_units"`
				AvailableUnits *float64 `json:"available_units"`
				ExpiresAt      *float64 `json:"expires_at"`
			} `json:"balances"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil {
		return nil, fmt.Errorf("zcode: 额度响应无法解析")
	}
	result := &zcodeBalanceResult{}
	if parsed.Data.DisplayMode == "enterprise" {
		// 企业版不下发额度数字 —— 显示成 0 是错的（0 是"已用光"的语义）。
		result.Enterprise = true
		return result, nil
	}
	for _, item := range parsed.Data.Balances {
		bucket := zcodeBalanceBucket{
			PlanID:   item.PlanID,
			ShowName: item.ShowName,
			UnitType: item.UnitType,
			Meter:    item.Meter,
		}
		if item.TotalUnits != nil {
			bucket.TotalUnits = *item.TotalUnits
		}
		if item.UsedUnits != nil {
			bucket.UsedUnits = *item.UsedUnits
		}
		if item.RemainingUnits != nil {
			bucket.RemainingUnits = *item.RemainingUnits
		}
		if item.AvailableUnits != nil {
			bucket.AvailableUnits = *item.AvailableUnits
			bucket.HasAvailable = true
		}
		if item.ExpiresAt != nil {
			bucket.ExpiresAt = int64(*item.ExpiresAt)
		}
		result.Buckets = append(result.Buckets, bucket)
		// 优先用 available（若给了），否则用 remaining（ref 聚合口径）。
		if bucket.HasAvailable {
			result.Remaining += bucket.AvailableUnits
		} else {
			result.Remaining += bucket.RemainingUnits
		}
		result.Total += bucket.TotalUnits
		if bucket.ExpiresAt > 0 && (result.ExpiresAt == 0 || bucket.ExpiresAt < result.ExpiresAt) {
			result.ExpiresAt = bucket.ExpiresAt
		}
	}
	if len(result.Buckets) > 0 {
		result.PlanName = result.Buckets[0].ShowName
	}
	return result, nil
}

// FetchZcodeCaptchaConfig fetches the Aliyun captcha init params (60s TTL in
// the reference; config-fetch failure must not block anything → fallback).
// ⚠️ platform 必须是 `unknown`（实测其他取值一律 400 code 3001）。
func (m *Manager) FetchZcodeCaptchaConfig(ctx context.Context, cred *ZcodeCredential) zcodeCaptchaConfig {
	endpoint := zcodeClientConfigsURL + "?app_version=" + url.QueryEscape(cred.zcodeAppVersion()) + "&platform=unknown"
	status, raw, err := m.zcodeGet(ctx, cred, endpoint, nil)
	if err != nil || status < 200 || status >= 300 {
		return zcodeCaptchaFallback
	}
	var parsed struct {
		Data *struct {
			Configs *struct {
				Captcha *struct {
					Region  string `json:"region"`
					Prefix  string `json:"prefix"`
					SceneID string `json:"sceneId"`
				} `json:"captcha"`
			} `json:"configs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil || parsed.Data.Configs == nil ||
		parsed.Data.Configs.Captcha == nil {
		return zcodeCaptchaFallback
	}
	captcha := parsed.Data.Configs.Captcha
	if captcha.Region == "" || captcha.Prefix == "" || captcha.SceneID == "" {
		return zcodeCaptchaFallback
	}
	return zcodeCaptchaConfig{Region: captcha.Region, Prefix: captcha.Prefix, SceneID: captcha.SceneID}
}

// FetchZcodeModels fetches the upstream model catalog (builtinModels is an
// OBJECT keyed by ordinal strings — an Array.isArray test yields a false
// "0 models"). Returns nil when the fetch fails or the catalog is empty.
func (m *Manager) FetchZcodeModels(ctx context.Context, cred *ZcodeCredential) []zcodeRemoteModel {
	endpoint := zcodeClientConfigsURL + "?app_version=" + url.QueryEscape(cred.zcodeAppVersion()) + "&platform=unknown"
	status, raw, err := m.zcodeGet(ctx, cred, endpoint, nil)
	if err != nil || status < 200 || status >= 300 {
		return nil
	}
	return zcodeParseModels(raw)
}

// zcodeParseModels is the pure parse step.
//
// ⚠️ `data.builtinModels` 有**两种实测形状**：参考实现记录的是「对象（键为
// 序号字串）」`{"0":{…}}`，而本端 2026-10-02 对真实端点抓到的却是**数组**
// `[{…},{…}]`。两种都必须接受（ref 自己也是 `Array.isArray ? raw :
// Object.values(raw)`）—— 只认一种会得到"0 个模型"的假阴性。
func zcodeParseModels(raw []byte) []zcodeRemoteModel {
	var parsed struct {
		Data *struct {
			BuiltinModels json.RawMessage `json:"builtinModels"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil {
		return nil
	}
	entries := decodeZcodeCatalogEntries(parsed.Data.BuiltinModels)
	var models []zcodeRemoteModel
	for _, item := range entries {
		id := item.ModelID
		if id == "" {
			id = item.ID
		}
		if id == "" {
			continue
		}
		name := item.Name
		if name == "" {
			name = id
		}
		contextWindow := int(item.ContextWindow)
		if contextWindow <= 0 {
			contextWindow = 200_000
		}
		maxTokens := int(item.MaxCompletionTokens)
		if maxTokens <= 0 {
			maxTokens = int(item.MaxTokens)
		}
		if maxTokens <= 0 {
			maxTokens = 32_768
		}
		model := zcodeRemoteModel{
			ID:            id,
			Name:          name,
			ContextWindow: contextWindow,
			MaxTokens:     maxTokens,
			SupportsImage: item.Capabilities.Vision,
			DefaultLevel:  item.Reasoning.DefaultLevel,
		}
		if len(item.Reasoning.Levels) > 0 {
			keys := make([]string, 0, len(item.Reasoning.Levels))
			for key := range item.Reasoning.Levels {
				keys = append(keys, key)
			}
			model.Levels = zcodeOrderReasoningLevels(keys)
		}
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models
}

// zcodeCatalogEntry is one `builtinModels` entry.
type zcodeCatalogEntry struct {
	ModelID             string  `json:"modelId"`
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	ContextWindow       float64 `json:"contextWindow"`
	MaxCompletionTokens float64 `json:"maxCompletionTokens"`
	MaxTokens           float64 `json:"maxTokens"`
	Capabilities        struct {
		Vision bool `json:"vision"`
	} `json:"capabilities"`
	Reasoning struct {
		Levels       map[string]any `json:"levels"`
		DefaultLevel string         `json:"defaultLevel"`
	} `json:"reasoning"`
}

// decodeZcodeCatalogEntries accepts both catalog shapes: the live endpoint
// serves an ARRAY (2026-10-02 capture) while the reference implementation
// recorded an OBJECT keyed by ordinal strings — ref itself does
// `Array.isArray(raw) ? raw : Object.values(raw)`.
func decodeZcodeCatalogEntries(raw json.RawMessage) []zcodeCatalogEntry {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var list []zcodeCatalogEntry
	if err := json.Unmarshal(raw, &list); err == nil {
		return list
	}
	byKey := map[string]zcodeCatalogEntry{}
	if err := json.Unmarshal(raw, &byKey); err != nil {
		return nil
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]zcodeCatalogEntry, 0, len(byKey))
	for _, key := range keys {
		out = append(out, byKey[key])
	}
	return out
}

// zcodeOrderReasoningLevels sorts levels into the IDE display order
// (upstream's raw insertion order is low,max,high; the IDE shows low,high,max).
func zcodeOrderReasoningLevels(keys []string) []string {
	order := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}
	seen := map[string]bool{}
	out := make([]string, 0, len(keys))
	for _, level := range order {
		for _, key := range keys {
			if key == level {
				out = append(out, key)
				seen[key] = true
			}
		}
	}
	for _, key := range keys {
		if !seen[key] {
			out = append(out, key)
		}
	}
	return out
}

// ReportZcodeActivation posts the two client-activity events. ⚠️ 不补这两条，
// `preview` 恒为空 plans[] —— 用户会以为签到坏了（实测）。幂等（服务端按
// device_mid + 日期去重），失败不阻塞。
func (m *Manager) ReportZcodeActivation(ctx context.Context, cred *ZcodeCredential) {
	for _, event := range []string{"app_launch", "app_daily_active"} {
		payload, _ := json.Marshal(map[string]any{
			"event":       event,
			"device_mid":  cred.DeviceMid,
			"platform":    "win32",
			"app_version": cred.zcodeAppVersion(),
		})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, zcodeEventReportURL, bytes.NewReader(payload))
		if err != nil {
			continue
		}
		for k, v := range zcodeHeaders(cred, true, nil) {
			req.Header.Set(k, v)
		}
		resp, err := m.zcodeClientFor().Do(req)
		if err != nil {
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}
}

// FetchZcodeClaimablePlans lists the plans the account can claim right now
// (sorted by priority descending, matching the reference).
func (m *Manager) FetchZcodeClaimablePlans(ctx context.Context, cred *ZcodeCredential) ([]zcodeClaimablePlan, error) {
	endpoint := zcodeBillingPreviewURL + "?app_version=" + url.QueryEscape(cred.zcodeAppVersion()) + "&platform=win32"
	status, raw, err := m.zcodeGet(ctx, cred, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("zcode: 查询可领活动失败：%w", err)
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("zcode: 查询可领活动失败（HTTP %d）：%.200s", status, string(raw))
	}
	return zcodeParseClaimablePlans(raw), nil
}

// zcodeParseClaimablePlans is the pure parse step.
func zcodeParseClaimablePlans(raw []byte) []zcodeClaimablePlan {
	var parsed struct {
		Data *struct {
			Plans []struct {
				PlanID   string  `json:"plan_id"`
				Priority float64 `json:"priority"`
				Name     string  `json:"name"`
			} `json:"plans"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Data == nil {
		return nil
	}
	plans := make([]zcodeClaimablePlan, 0, len(parsed.Data.Plans))
	for _, item := range parsed.Data.Plans {
		if strings.TrimSpace(item.PlanID) == "" {
			continue
		}
		plans = append(plans, zcodeClaimablePlan{PlanID: item.PlanID, Priority: item.Priority, Name: item.Name})
	}
	sort.SliceStable(plans, func(i, j int) bool { return plans[i].Priority > plans[j].Priority })
	return plans
}

// ClaimZcodePlan claims one plan. ⚠️ captcha 是一次性的：每个 plan 都必须
// **现产一个新 param**（复用同一 param 在索要验证的窗口里必得 3007）。
func (m *Manager) ClaimZcodePlan(ctx context.Context, cred *ZcodeCredential, planID string, captcha zcodeCaptchaParam) (*zcodeClaimOutcome, error) {
	payload, _ := json.Marshal(map[string]any{"plan_id": planID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, zcodeBillingClaimURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	for k, v := range zcodeHeaders(cred, true, &captcha) {
		req.Header.Set(k, v)
	}
	resp, err := m.zcodeClientFor().Do(req)
	if err != nil {
		return &zcodeClaimOutcome{PlanID: planID, Message: err.Error()}, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed struct {
		Code    *float64 `json:"code"`
		Msg     string   `json:"msg"`
		Message string   `json:"message"`
	}
	outcome := &zcodeClaimOutcome{PlanID: planID, HTTPStatus: resp.StatusCode}
	if err := json.Unmarshal(raw, &parsed); err == nil {
		if parsed.Code != nil {
			outcome.Code = int(*parsed.Code)
		}
		outcome.Message = parsed.Msg
		if outcome.Message == "" {
			outcome.Message = parsed.Message
		}
	} else {
		outcome.Message = string(raw)
	}
	// 1003 = 已领取过（幂等成功，不是错误）。
	outcome.AlreadyClaimed = outcome.Code == 1003
	outcome.OK = resp.StatusCode >= 200 && resp.StatusCode < 300 && (outcome.Code == 0 || outcome.AlreadyClaimed)
	return outcome, nil
}

// zcodeDescribeClaimCode renders the claim business codes into Chinese
// (ref src/zcode-upstream.ts:345-355 的表).
func zcodeDescribeClaimCode(code int) string {
	switch code {
	case 0:
		return "领取成功"
	case 1001:
		return "plan 不存在"
	case 1002:
		return "活动已结束"
	case 1003:
		return "已领取过（幂等）"
	case 1004:
		return "不符合条件"
	case 1005:
		return "名额用完"
	case 3007:
		return "captcha 校验失败（param 无效或已用）"
	default:
		return fmt.Sprintf("未知业务码 %d", code)
	}
}

// ZcodeBalance queries the balance of one account (by id).
func (m *Manager) ZcodeBalance(ctx context.Context, accountID string) (*zcodeBalanceResult, error) {
	cred, err := m.zcodeCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	return m.FetchZcodeBalance(ctx, cred)
}

// ZcodeModels fetches the upstream catalog of one account (nil when the
// account has no usable credential or the fetch fails — callers fall back to
// the static table).
func (m *Manager) ZcodeModels(ctx context.Context, accountID string) []zcodeRemoteModel {
	cred, err := m.zcodeCredentialFor(accountID)
	if err != nil {
		return nil
	}
	return m.FetchZcodeModels(ctx, cred)
}
