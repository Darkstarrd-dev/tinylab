package jethub

// OfficeAce 余额 / 领取（V11 签名直读云端，不依赖果办客户端）。
//
// 端点（⚠️ **永远打默认域**，不跟随 per-account maasBaseUrl —— V11 是管理面 API，
// 两个 host 都要求 IAM 签名，「为统一」改成 MaaS 域会把余额一起打挂，ref §5.7）：
//
//	GET  {defaultBase}/v1/subscription               余额（套餐桶 skus[].quotas + 活动桶 bonus_skus）
//	POST {defaultBase}/v1/subscription/bonus/claim   每日领取（POST 必带 Content-Type，空 body）
//
// 响应桶与果办界面右上角完全同源（复刻 ref fetchCloudSubscriptionFor 的归一化）：
// 积分**当日作废**（bonus 桶 expired_time = 当天 23:59:59），到期字段走
// DeductionEndTime/ExpiresAt 两字段透传（前端分「长期/临时」两桶）。
//
// ⚠️ 单位是 **token**（ref jet-hub-rpc.ts: `unit: OFFICEACE.quotaUnit` = 'Token'）——
// 前端按 Token + K/M 量级渲染，聚合层（normalizedBalanceUnit）归入 token 桶。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// officeaceSubscriptionPath / officeaceClaimPath are the V11 management endpoints.
const (
	officeaceSubscriptionPath = "/v1/subscription"
	officeaceClaimPath        = "/v1/subscription/bonus/claim"
)

// officeaceSignedV11 performs a V11-signed request and returns the raw body.
// Non-2xx responses surface the status + body snippet (静默空串会把病因藏起来).
func (m *Manager) officeaceSignedV11(ctx context.Context, cred *OfficeAceCredential, method, rawURL, body string) ([]byte, error) {
	signed, err := officeaceSignV11(cred.Access, cred.Secret, cred.SecurityToken, cred.ProjectID, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != "" || strings.EqualFold(method, http.MethodPost) {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, err
	}
	// 签名头集合即出站头集合（Host 由 transport 生成，Go 忽略 Header["Host"]）。
	for k, v := range signed {
		if strings.EqualFold(k, "host") {
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("officeace").Do(req)
	if err != nil {
		return nil, fmt.Errorf("officeace: 管理面请求失败：%w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	return data, nil
}

// officeaceNumber coerces a JSON scalar to float64 (ref Number(...) semantics:
// the API mixes numeric and string-encoded numbers).
func officeaceNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case string:
		var f float64
		if _, err := fmt.Sscanf(strings.TrimSpace(n), "%g", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

// officeaceSubscriptionRaw is the /v1/subscription payload subset.
type officeaceSubscriptionRaw struct {
	Skus []struct {
		SkuName any `json:"sku_name"`
		SkuCode any `json:"sku_code"`
		Quotas  []struct {
			SkuAttrCode  any `json:"sku_attr_code"`
			SkuValue     any `json:"sku_value"`
			CurrentValue any `json:"current_value"`
			ExpiredTime  any `json:"expired_time"`
		} `json:"quotas"`
	} `json:"skus"`
	BonusSkus []struct {
		ActivityID   any `json:"activity_id"`
		ActivityName any `json:"activity_name"`
		Points       any `json:"points"`
		CurrentValue any `json:"current_value"`
		ExpiredTime  any `json:"expired_time"`
	} `json:"bonus_skus"`
}

// parseOfficeaceSubscription is the pure balance parser (split for tests):
// plan quotas with `sku_attr_code == "officeace_points"` plus the bonus
// buckets. Returns nil when the response carries no usable bucket.
func parseOfficeaceSubscription(raw []byte, nowMs int64) *CreditBalance {
	var parsed officeaceSubscriptionRaw
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	out := &CreditBalance{IsCredit: false}
	anyUsable := false
	addGroup := func(pkg CreditPackage, expired bool) {
		anyUsable = true
		if expired {
			out.ExpiredTotal += pkg.Remaining
			return
		}
		out.Total += pkg.Remaining
		out.Packages = append(out.Packages, pkg)
	}
	for _, sku := range parsed.Skus {
		code, _ := sku.SkuCode.(string)
		isTrial := strings.HasSuffix(code, ".trial")
		name, _ := sku.SkuName.(string)
		if name == "" {
			name = "套餐"
		}
		for _, q := range sku.Quotas {
			if attr, _ := q.SkuAttrCode.(string); attr != "officeace_points" {
				continue
			}
			total, ok1 := officeaceNumber(q.SkuValue)
			used, ok2 := officeaceNumber(q.CurrentValue)
			if !ok1 || !ok2 {
				continue
			}
			expiredAt, _ := q.ExpiredTime.(string)
			expired := !isTrial && expiredAt != ""
			if expired {
				if ms, ok := officeaceParseTimeMs(expiredAt); !ok || ms > nowMs {
					expired = false
				}
			}
			pkg := CreditPackage{
				Name:      name,
				Unit:      "token",
				Remaining: officeaceMaxFloat(0, total-used),
				Total:     total,
				Used:      used,
				Active:    !expired,
				ExpiresAt: expiredAt,
			}
			// ⚠️ trial 桶无固定到期（ref: isTrial ⇒ expiresAt = undefined）——
			// 不臆造时刻，让它落「长期」。
			if !isTrial && expiredAt != "" {
				if ms, ok := officeaceParseTimeMs(expiredAt); ok {
					pkg.DeductionEndTime = ms
				}
			}
			addGroup(pkg, expired)
		}
	}
	for _, bonus := range parsed.BonusSkus {
		points, ok := officeaceNumber(bonus.Points)
		if !ok {
			continue
		}
		used, _ := officeaceNumber(bonus.CurrentValue)
		name, _ := bonus.ActivityName.(string)
		if name == "" {
			name = "活动奖励"
		}
		expiredAt, _ := bonus.ExpiredTime.(string)
		expired := false
		if expiredAt != "" {
			if ms, ok := officeaceParseTimeMs(expiredAt); ok && ms <= nowMs {
				expired = true
			}
		}
		pkg := CreditPackage{
			Name:      name,
			Unit:      "token",
			Remaining: officeaceMaxFloat(0, points-used),
			Total:     points,
			Used:      used,
			Active:    !expired,
			ExpiresAt: expiredAt,
		}
		if expiredAt != "" {
			if ms, ok := officeaceParseTimeMs(expiredAt); ok {
				pkg.DeductionEndTime = ms
			}
		}
		addGroup(pkg, expired)
	}
	if !anyUsable {
		return nil
	}
	return out
}

// officeaceMaxFloat is the small helper the parser needs (math.Max NaN semantics are
// not wanted here).
func officeaceMaxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// OfficeaceBalance reads one account's subscription summary (the panel's
// per-account credits row and the Monitor aggregation both land here).
func (m *Manager) OfficeaceBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "officeace" {
		return nil, ErrNotFound
	}
	cred, err := m.officeaceCredential(&acc)
	if err != nil {
		return nil, err
	}
	if cred == nil || cred.Access == "" || cred.SecurityToken == "" {
		return nil, fmt.Errorf("officeace: 账号 %s 的凭据不可用或已过期，请重新登录", accountID)
	}
	raw, err := m.officeaceSignedV11(ctx, cred, http.MethodGet,
		officeaceDefaultBaseURL+officeaceSubscriptionPath, "")
	if err != nil {
		return nil, err
	}
	balance := parseOfficeaceSubscription(raw, nowMillis())
	if balance == nil {
		return nil, fmt.Errorf("officeace: 订阅响应不含任何积分桶（HTTP 200）：%s", accountID)
	}
	return balance, nil
}

// OfficeaceClaimDaily claims the daily bonus (POST, empty body — the endpoint
// takes no input; ⚠️ POST 必带 Content-Type，实测不带是 500 OfficeAce.11020001).
//
// ⚠️ 有意的差异（ref §6 的自动签到）：ref 在**每次余额查询前**自动领取（果办
// 客户端行为，UI 无签到按钮）。本端把领取落在**显式端点/按钮**上 —— GET 余额
// 触发状态变更的 POST 会让 Monitor 聚合每轮隐式发领取请求，副作用不可见。
// 代价是用户不点「领取」会错过当日积分（积分当日作废），已登记为已知差异。
func (m *Manager) OfficeaceClaimDaily(ctx context.Context, accountID string) (ClaimOutcome, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "officeace" {
		return ClaimOutcome{}, ErrNotFound
	}
	cred, err := m.officeaceCredential(&acc)
	if err != nil {
		return ClaimOutcome{}, err
	}
	if cred == nil || cred.Access == "" || cred.SecurityToken == "" {
		return ClaimOutcome{}, fmt.Errorf("officeace: 账号 %s 的凭据不可用或已过期，请重新登录", accountID)
	}
	raw, err := m.officeaceSignedV11(ctx, cred, http.MethodPost,
		officeaceDefaultBaseURL+officeaceClaimPath, "")
	if err != nil {
		return ClaimOutcome{}, err
	}
	var parsed struct {
		BonusSkus []struct {
			ActivityID   any `json:"activity_id"`
			ActivityName any `json:"activity_name"`
			Points       any `json:"points"`
		} `json:"bonus_skus"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ClaimOutcome{}, fmt.Errorf("officeace: 领取响应不是 JSON：%.200s", string(raw))
	}
	var claimed float64
	var names []string
	for _, s := range parsed.BonusSkus {
		points, ok := officeaceNumber(s.Points)
		if !ok {
			continue
		}
		claimed += points
		name, _ := s.ActivityName.(string)
		if name == "" {
			name = "活动奖励"
		}
		names = append(names, fmt.Sprintf("%s +%.0f", name, points))
	}
	if claimed == 0 {
		// 200 但没有新领取的桶：今日已领过（或暂无可领活动）。
		return ClaimOutcome{Kind: "already-claimed", Message: "今日已领取（或暂无可领活动）"}, nil
	}
	return ClaimOutcome{Kind: "claimed", Credit: claimed, Message: strings.Join(names, "；")}, nil
}
