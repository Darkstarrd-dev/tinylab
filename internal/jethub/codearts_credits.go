package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
)

// CodeArts snap-access ops endpoints (1:1 from ref codearts-credits.ts).
const (
	codeartsOpsDeliveryPath = "/v1/ops/delivery?channel=IDE"
	codeartsOpsClaimPath    = "/v1/ops/claim"
	codeartsOpsConfirmPath  = "/v1/ops/confirm"
	codeartsPackageInfoPath = "/snap-manager/v1/statistics/plugin"
	// Daily check-in activity type (USER_LOGIN only; invite/newcomer/student
	// activities are not daily check-ins).
	codeartsDailyLoginType = "USER_LOGIN"
)

// codeartsSnapBase is the snap-access gateway base URL shared by the
// statistics/ops endpoints (same host as the inference base). Variable to
// allow tests to point it at a mock server.
var codeartsSnapBase = func() string { return "https://snap-access.cn-north-4.myhuaweicloud.com" }

// setSnapBase overrides the snap-access base (test hook).
func setSnapBase(u string) { codeartsSnapBase = func() string { return u } }

// CreditBalance is the provider-agnostic balance snapshot for the UI.
type CreditBalance struct {
	Total    float64         `json:"total"`
	Packages []CreditPackage `json:"packages"`
	IsCredit bool            `json:"isCreditPackage"`
	Detail   map[string]any  `json:"detail,omitempty"`
}

// CreditPackage is one credit package entry.
type CreditPackage struct {
	Name      string  `json:"name"`
	Unit      string  `json:"unit,omitempty"`
	Remaining float64 `json:"remaining"`
	Total     float64 `json:"total"`
	Used      float64 `json:"used"`
	Active    bool    `json:"active"`
}

// ClaimOutcome mirrors the plugin's ClaimOutcome union for the UI.
type ClaimOutcome struct {
	Kind    string  `json:"kind"` // claimed | already-claimed | inactive | failed
	Credit  float64 `json:"credit,omitempty"`
	Message string  `json:"message,omitempty"`
	// CoversToday reports whether this outcome belongs to TODAY'S round
	// (nil = yes). Qoder's daily campaign refreshes at 10:00 UTC+8: before
	// that instant a CLAIMED row / a successful claim belongs to yesterday's
	// round (ref 1b65a5c) — reporting it as "today" makes users miss a whole
	// day's credits.
	CoversToday *bool `json:"coversToday,omitempty"`
}

// codeartsSignedGet performs a signed GET returning the parsed JSON object.
func (m *Manager) codeartsSignedGet(ctx context.Context, cred *CodeArtsCredential, url string, extraUnsigned map[string]string) (map[string]any, error) {
	signed, err := SignHuaweiRequest(cred.AccessKeyID, cred.SecretAccessKey, cred.SecurityToken, "GET", url, nil, nil)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	ApplySignedHeaders(req.Header.Set, signed)
	for k, v := range extraUnsigned {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("codearts").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("jethub: unparsable response: %w", err)
	}
	return out, nil
}

// codeartsSignedPost performs a signed POST with a JSON body.
func (m *Manager) codeartsSignedPost(ctx context.Context, cred *CodeArtsCredential, url, body string) (map[string]any, error) {
	signed, err := SignHuaweiRequest(cred.AccessKeyID, cred.SecretAccessKey, cred.SecurityToken, "POST", url, []byte(body), nil)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strReader(body))
	if err != nil {
		return nil, err
	}
	ApplySignedHeaders(req.Header.Set, signed)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpClient("codearts").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(data)}
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("jethub: unparsable response: %w", err)
	}
	return out, nil
}

// codeartsAccountInfo queries the package info endpoint and reports whether
// the account is credit-billed (the precondition for daily claims).
func (m *Manager) codeartsAccountInfo(ctx context.Context, cred *CodeArtsCredential) (isCredit, isToken bool, metrics any, err error) {
	data, err := m.codeartsSignedGet(ctx, cred, codeartsSnapBase()+codeartsPackageInfoPath, map[string]string{
		"Agent-Type": "PromptCenter", // appended AFTER signing (never inside)
		"X-Language": "zh-cn",
	})
	if err != nil {
		return false, false, nil, err
	}
	pkg, _ := data["package"].(map[string]any)
	isCredit = boolOf(pkg["is_credit_package"])
	isToken = boolOf(pkg["is_token_package"])
	return isCredit, isToken, data["metrics"], nil
}

// ClaimCodeArtsDaily executes the full daily check-in flow for one account:
// 1) account-type gate; 2) activity list; 3) claimable check; 4) claim;
// 5) confirm when the response carries an id. The precheck is the only
// idempotence guard (the protocol has no idempotency key).
func (m *Manager) ClaimCodeArtsDaily(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.credentialForAccount("codearts", accountID)
	if err != nil {
		return nil, err
	}
	isCredit, isToken, _, err := m.codeartsAccountInfo(ctx, cred)
	if err != nil {
		return nil, fmt.Errorf("账户信息查询失败：%v", err)
	}
	if !isCredit {
		msg := "非积分计费账户，不在积分活动范围"
		if isToken {
			msg = "Token 计费账户，不在积分活动范围"
		}
		return &ClaimOutcome{Kind: "inactive", Message: msg}, nil
	}

	activities, err := m.codeartsSignedGet(ctx, cred, codeartsSnapBase()+codeartsOpsDeliveryPath, map[string]string{
		"Agent-Type": "PromptCenter",
		"X-Language": "zh-cn",
	})
	if err != nil {
		return nil, fmt.Errorf("活动列表查询失败：%v", err)
	}
	items, _ := activities["data"].(map[string]any)["items"].([]any)
	var daily map[string]any
	for _, it := range items {
		item, ok := it.(map[string]any)
		if !ok || strOf(item["type"]) != codeartsDailyLoginType {
			continue
		}
		daily = item
		break
	}
	if daily == nil {
		return &ClaimOutcome{Kind: "inactive", Message: "未找到每日签到活动"}, nil
	}
	if !boolOf(daily["claimable"]) {
		status := strOf(daily["status"])
		if status == "CLAIMED" || status == "CONFIRMED" || status == "CONSUMED" {
			return &ClaimOutcome{Kind: "already-claimed", Message: "今天已领取"}, nil
		}
		return &ClaimOutcome{Kind: "inactive", Message: "当前不可领取（status=" + status + "）"}, nil
	}
	campaignID := identifierOf(daily["campaignId"])
	if campaignID == "" {
		return &ClaimOutcome{Kind: "failed", Message: "活动缺少 campaignId，无法领取"}, nil
	}

	claimBody := fmt.Sprintf(`{"campaignId":%q,"channel":"IDE"}`, campaignID)
	claimResult, err := m.codeartsSignedPost(ctx, cred, codeartsSnapBase()+codeartsOpsClaimPath, claimBody)
	if err != nil {
		return nil, err
	}
	// Confirm when the server requires it (benefit.id != null); a confirm
	// failure does NOT fail the claim (credits are already pending).
	if dataMap, _ := claimResult["data"].(map[string]any); dataMap != nil {
		if _, hasID := dataMap["id"]; hasID && dataMap["id"] != nil {
			confirmBody := fmt.Sprintf(`{"campaignId":%q}`, campaignID)
			_, _ = m.codeartsSignedPost(ctx, cred, codeartsSnapBase()+codeartsOpsConfirmPath, confirmBody)
		}
	}
	return &ClaimOutcome{Kind: "claimed", Credit: claimCreditOf(claimResult, daily)}, nil
}

// CodeArtsBalance queries the credit balance for the UI.
func (m *Manager) CodeArtsBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.credentialForAccount("codearts", accountID)
	if err != nil {
		return nil, err
	}
	_, _, metrics, err := m.codeartsAccountInfo(ctx, cred)
	if err != nil {
		return nil, err
	}
	out := &CreditBalance{Packages: []CreditPackage{}}
	items, _ := metrics.([]any)
	var total float64
	saw := false
	for _, it := range items {
		item, ok := it.(map[string]any)
		if !ok {
			continue
		}
		name := strOf(item["name"])
		if name != "usageTotalPackageCredit" && name != "usageBasicPackageCredit" &&
			name != "usageOnDemandPackageCredit" && name != "usageBonusPackageCredit" {
			continue
		}
		saw = true
		remain := numOf(item["package_credit_remain"])
		if name == "usageTotalPackageCredit" {
			total = remain
			continue
		}
		amount := numOf(item["package_credit_amount"])
		if amount <= 0 && remain <= 0 {
			continue
		}
		out.Packages = append(out.Packages, CreditPackage{
			Name: name, Remaining: remain, Total: amount, Used: numOf(item["package_credit_used"]),
		})
	}
	if !saw {
		return nil, fmt.Errorf("jethub: 账户无积分口径")
	}
	out.Total = total
	out.IsCredit = true
	return out, nil
}

// --- small typed readers (JSON numbers arrive as float64) ---

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

func numOf(v any) float64 {
	f, _ := v.(float64)
	return f
}

// identifierOf renders a numeric-or-string campaignId. The server sends a
// NUMBER (实测 campaignId = 1); a string-only reader missed it entirely.
func identifierOf(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
}

// claimCreditOf extracts the granted credit with the documented fallback
// chain (benefitAmount → credit → credits → creditAmount → amount → the
// activity's advertised amount).
func claimCreditOf(claimResult, activity map[string]any) float64 {
	data, _ := claimResult["data"].(map[string]any)
	for _, src := range []map[string]any{data, activity} {
		if src == nil {
			continue
		}
		for _, key := range []string{"benefitAmount", "credit", "credits", "creditAmount", "amount"} {
			if v := numOf(src[key]); v > 0 {
				return v
			}
		}
	}
	return 0
}
