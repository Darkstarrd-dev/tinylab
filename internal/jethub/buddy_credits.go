package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Buddy credits (ref credits.ts): check-in status / daily claim / balance.
// All three endpoints are POST-with-empty-body on the product endpoint with
// the checkin header family.
const (
	buddyCheckinStatusPath = "/v2/billing/meter/checkin-activity-status"
	buddyDailyCheckinPath  = "/v2/billing/meter/daily-checkin"
	buddyUserResourcePath  = "/v2/billing/meter/get-user-resource"

	buddyCodeAlreadyClaimed    = 10001
	buddyCodeAlreadyClaimedAlt = 1001
	buddyCodeNoQualification   = 1002
	buddyCodeActivityEnded     = 1003
	buddyPackageStatusExpired  = 3
)

// buddyCheckinHeaders builds the checkin/balance request headers. X-Domain
// takes the PRODUCT value first (credential.domain is a stale snapshot).
func buddyCheckinHeaders(cred *BuddyCredential, p *BuddyProduct) map[string]string {
	headers := map[string]string{
		"Authorization":        "Bearer " + cred.AccessToken,
		"Accept":               "application/json",
		"Content-Type":         "application/json",
		buddyHeaderDomain:      firstNonEmpty(p.APIDomain, cred.Domain),
		buddyHeaderProduct:     buddyDeploymentType,
		buddyHeaderProductCode: p.ProductCode,
		"User-Agent":           p.UserAgent,
	}
	if cred.UserID != "" {
		headers["X-User-Id"] = cred.UserID
	}
	if cred.EnterpriseID != "" {
		headers[buddyHeaderEnterpriseID] = cred.EnterpriseID
		headers[buddyHeaderTenantID] = cred.EnterpriseID
	}
	return headers
}

// buddyPostCredit performs a signed-in POST and returns the parsed body.
// Non-JSON responses (gateway HTML error pages on expired credentials) are
// reported with the HTTP status so "re-login" surfaces clearly.
func (m *Manager) buddyPostCredit(ctx context.Context, cred *BuddyCredential, p *BuddyProduct, path string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.Endpoint+path, strReader("{}"))
	if err != nil {
		return nil, err
	}
	for k, v := range buddyCheckinHeaders(cred, p) {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient(p.ID).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("凭据已失效（HTTP %d），请重新登录该账号", resp.StatusCode)
		}
		snippet := strings.Join(strings.Fields(string(data[:minInt(len(data), 80)])), " ")
		return nil, fmt.Errorf("服务端返回了非 JSON 响应（HTTP %d）：%s", resp.StatusCode, snippet)
	}
	return parsed, nil
}

// minInt returns the smaller of two ints.
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ClaimBuddyDaily executes the daily check-in claim for a buddy-family
// account. Judgement order: business-code non-fatal classes first, then
// success, then failed — the response body code is authoritative (duplicate
// claims arrive as HTTP 400).
func (m *Manager) ClaimBuddyDaily(ctx context.Context, provider, accountID string) (*ClaimOutcome, error) {
	p, ok := BuddyProducts()[provider]
	if !ok {
		return nil, fmt.Errorf("jethub: unknown buddy product %q", provider)
	}
	cred, err := m.buddyCredentialFor(provider, accountID)
	if err != nil {
		return nil, err
	}
	body, err := m.buddyPostCredit(ctx, cred, p, buddyDailyCheckinPath)
	if err != nil {
		return nil, err
	}
	code := int(bodyCode(body))
	message := jsonStringField(body, "msg")
	switch {
	case code == buddyCodeAlreadyClaimed || code == buddyCodeAlreadyClaimedAlt:
		return &ClaimOutcome{Kind: "already-claimed", Message: firstNonEmpty(message, "今天已签到")}, nil
	case code == buddyCodeNoQualification || code == buddyCodeActivityEnded:
		return &ClaimOutcome{Kind: "inactive", Message: firstNonEmpty(message, "当前无领取资格")}, nil
	case code != 0:
		return &ClaimOutcome{Kind: "failed", Message: firstNonEmpty(message, "领取失败")}, nil
	}
	data := bodyData(body)
	if data == nil {
		return &ClaimOutcome{Kind: "failed", Message: "领取响应缺少 data 字段"}, nil
	}
	out := &ClaimOutcome{
		Kind:   "claimed",
		Credit: jsonNumberField(data, "credit"),
	}
	if delayed := jsonStringField(data, "message"); delayed != "" {
		out.Message = delayed
	}
	return out, nil
}

// BuddyBalance queries the credit balance (get-user-resource). The data is
// double-nested: data.Response.Data.Accounts[].
func (m *Manager) BuddyBalance(ctx context.Context, provider, accountID string) (*CreditBalance, error) {
	p, ok := BuddyProducts()[provider]
	if !ok {
		return nil, fmt.Errorf("jethub: unknown buddy product %q", provider)
	}
	cred, err := m.buddyCredentialFor(provider, accountID)
	if err != nil {
		return nil, err
	}
	body, err := m.buddyPostCredit(ctx, cred, p, buddyUserResourcePath)
	if err != nil {
		return nil, err
	}
	if int(bodyCode(body)) != 0 {
		return nil, fmt.Errorf("jethub: buddy balance code=%d: %s", bodyCode(body), bodyMessage(body))
	}
	outer := bodyData(body)
	if outer == nil {
		return nil, fmt.Errorf("jethub: buddy balance missing data")
	}
	response, _ := outer["Response"].(map[string]any)
	if response == nil {
		return nil, fmt.Errorf("jethub: buddy balance missing data.Response")
	}
	inner, _ := response["Data"].(map[string]any)
	if inner == nil {
		return nil, fmt.Errorf("jethub: buddy balance missing data.Response.Data")
	}
	accounts, _ := inner["Accounts"].([]any)
	out := &CreditBalance{Packages: []CreditPackage{}}
	var total, expired float64
	for _, item := range accounts {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := firstNonEmpty(
			jsonStringField(entry, "PackageName"),
			jsonStringField(entry, "SubProductName"),
			jsonStringField(entry, "PackageCode"),
		)
		status := int(jsonNumberField(entry, "Status"))
		deductionEnd := int64(jsonNumberField(entry, "DeductionEndTime"))
		expiredTime := jsonStringField(entry, "ExpiredTime")
		expiredAt := parseISOTime(strings.Replace(expiredTime, " ", "T", 1))
		active := status != buddyPackageStatusExpired &&
			!(expiredAt > 0 && time.Now().UnixMilli() >= expiredAt) &&
			!(deductionEnd > 0 && time.Now().UnixMilli() >= deductionEnd)
		pkg := CreditPackage{
			Name:      name,
			Unit:      firstNonEmpty(jsonStringField(entry, "CapacityUnit"), jsonStringField(entry, "OriginUnit")),
			Remaining: readPreciseNumber(entry, "CycleCapacityRemain"),
			Total:     readPreciseNumber(entry, "CycleCapacitySize"),
			Used:      readPreciseNumber(entry, "CycleCapacityUsed"),
			Active:    active,
		}
		out.Packages = append(out.Packages, pkg)
		if active {
			total += pkg.Remaining
		} else {
			expired += pkg.Remaining
		}
	}
	out.Total = roundCredits(total)
	out.IsCredit = true
	_ = expired // surfaced via package list; total only counts active packages
	return out, nil
}

// buddyCredentialFor resolves + parses a buddy-family credential.
func (m *Manager) buddyCredentialFor(provider, accountID string) (*BuddyCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != provider {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential(provider, acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred BuddyCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse %s credential %s: %w", provider, accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// roundCredits normalizes to two decimals.
func roundCredits(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

// readPreciseNumber prefers the `Precise` string variant (IDE shows two
// decimals: "247.87"); falls back to the integer field for old responses.
// 实测：CycleCapacityRemain=247（截断）、CycleCapacityRemainPrecise="247.87"。
func readPreciseNumber(source map[string]any, baseKey string) float64 {
	if p, ok := source[baseKey+"Precise"].(string); ok {
		if f, err := strconv.ParseFloat(strings.TrimSpace(p), 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f
		}
	}
	if f, ok := source[baseKey+"Precise"].(float64); ok {
		return f
	}
	return jsonNumberField(source, baseKey)
}
