package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// LobsterAI credits (ref lobsterai-credits.ts): the check-in is a THREE-step
// flow (slot → context → check_in) with strict state classification; balance
// uses profile-summary (NOT /quota — that one misses activity credits).
const (
	lobsteraiCheckInAction      = "check_in"
	lobsteraiSlotAvailableState = "available"
)

// lobsteraiGet performs an authenticated request and returns the parsed body.
// Non-JSON responses (gateway HTML) report the HTTP status for re-login.
func (m *Manager) lobsteraiRequest(ctx context.Context, cred *LobsteraiCredential, path, method, body string) (map[string]any, error) {
	var reader io.Reader
	if body != "" {
		reader = strReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, lobsteraiProduct.Endpoint+path, reader)
	if err != nil {
		return nil, err
	}
	for k, v := range lobsteraiAuthHeaders(cred, "application/json") {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("lobsterai").Do(req)
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

// lobsteraiActivitySlot is the slot query result.
type lobsteraiActivitySlot struct {
	SlotState      string
	ActivityCode   string
	ConfigRevision float64
}

// fetchLobsteraiSlot queries the activity slot (failed ⇒ error, distinct
// from "no activity available" which is an inactive outcome).
func (m *Manager) fetchLobsteraiSlot(ctx context.Context, cred *LobsteraiCredential) (*lobsteraiActivitySlot, error) {
	q := urlValues{
		"placement":          lobsteraiSlotPlacement,
		"clientVersion":      lobsteraiProduct.ClientVersion,
		"containerApiVersion": lobsteraiSlotAPIVersion,
		"platform":           lobsteraiSlotPlatform,
	}
	body, err := m.lobsteraiRequest(ctx, cred, lobsteraiSlotPath+"?"+q.encode(), http.MethodGet, "")
	if err != nil {
		return nil, err
	}
	data, _, msg, ok := lobsteraiEnvelope(body)
	if !ok {
		return nil, fmt.Errorf("slot 信封异常：%s", msg)
	}
	activity, _ := data["activity"].(map[string]any)
	if activity == nil {
		activity = map[string]any{}
	}
	return &lobsteraiActivitySlot{
		SlotState:      jsonStringField(data, "slotState"),
		ActivityCode:   jsonStringField(activity, "activityCode"),
		ConfigRevision: jsonNumberField(activity, "configRevision"),
	}, nil
}

// ClaimLobsteraiDaily runs the full three-step check-in. The seven-step
// judgement keeps business states distinct from real failures.
func (m *Manager) ClaimLobsteraiDaily(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.lobsteraiCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	slot, err := m.fetchLobsteraiSlot(ctx, cred)
	if err != nil {
		return nil, fmt.Errorf("活动槽位查询失败：%w", err)
	}
	if slot.SlotState != lobsteraiSlotAvailableState || slot.ActivityCode == "" {
		return &ClaimOutcome{Kind: "inactive", Message: fmt.Sprintf("无可用活动（slotState=%s）", slot.SlotState)}, nil
	}

	// 活动上下文：claimedToday / 可用动作。
	q := urlValues{"configRevision": fmt.Sprintf("%v", int64(slot.ConfigRevision))}
	ctxBody, err := m.lobsteraiRequest(ctx, cred,
		lobsteraiActivitiesPath+"/"+url.PathEscape(slot.ActivityCode)+"/context?"+q.encode(),
		http.MethodGet, "")
	if err != nil {
		return nil, fmt.Errorf("活动上下文查询失败：%w", err)
	}
	ctxData, _, msg, ok := lobsteraiEnvelope(ctxBody)
	if !ok {
		return nil, fmt.Errorf("活动上下文失败：%s", msg)
	}
	state, _ := ctxData["state"].(map[string]any)
	if state == nil {
		state = map[string]any{}
	}
	if state["claimedToday"] == true {
		return &ClaimOutcome{Kind: "already-claimed", Message: "今天已签到"}, nil
	}
	actions, _ := ctxData["actions"].([]any)
	if !lobsteraiHasAction(actions, lobsteraiCheckInAction) {
		return &ClaimOutcome{Kind: "inactive", Message: "当前不可签到"}, nil
	}

	// 领取：POST check_in，body 带 configRevision + 幂等键。
	claimPayload, err := json.Marshal(map[string]any{
		"configRevision": slot.ConfigRevision,
		"idempotencyKey": lobsteraiRandomID(),
		"payload":        map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	claimBody, err := m.lobsteraiRequest(ctx, cred,
		lobsteraiActivitiesPath+"/"+url.PathEscape(slot.ActivityCode)+"/actions/check_in",
		http.MethodPost, string(claimPayload))
	if err != nil {
		return nil, err
	}
	claimData, code, msg, ok := lobsteraiEnvelope(claimBody)
	if !ok {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("%s（code=%d）", msg, code)}, nil
	}
	result, _ := claimData["result"].(map[string]any)
	if result == nil {
		result = map[string]any{}
	}
	// 积分字段三级回退：creditsGranted → rewardCredits → credits。
	credit := 0.0
	for _, key := range []string{"creditsGranted", "rewardCredits", "credits"} {
		if v := jsonNumberField(result, key); v > 0 {
			credit = v
			break
		}
	}
	out := &ClaimOutcome{Kind: "claimed", Credit: credit}
	if delayed := jsonStringField(result, "message"); delayed != "" {
		out.Message = delayed
	}
	return out, nil
}

// LobsteraiBalance queries the credit balance. Uses profile-summary (NOT
// /quota — the latter misses activity credits: 5297.72 vs 300 on a real
// account). Face-value inference: same-group effective packages share a
// fixed face; the group's max remaining acts as the face value.
func (m *Manager) LobsteraiBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.lobsteraiCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	body, err := m.lobsteraiRequest(ctx, cred, lobsteraiProfilePath, http.MethodGet, "")
	if err != nil {
		return nil, err
	}
	data, _, msg, ok := lobsteraiEnvelope(body)
	if !ok {
		return nil, fmt.Errorf("余额查询失败：%s", msg)
	}
	out := &CreditBalance{Packages: []CreditPackage{}}
	items, _ := data["creditItems"].([]any)
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		label := jsonStringField(record, "label")
		typeCode := jsonStringField(record, "type")
		expiresAt := jsonStringField(record, "expiresAt")
		expMs := int64(0)
		if expiresAt != "" {
			expMs = parseISOTime(strings.Replace(expiresAt, " ", "T", 1))
		}
		// 包名 = label（人看的名字），非 type（机器分类码 "campaign"）。
		out.Packages = append(out.Packages, CreditPackage{
			Name:      firstNonEmpty(label, typeCode, "积分包"),
			Unit:      "credit",
			Remaining: jsonNumberField(record, "creditsRemaining"),
			Total:     0, // LobsterAI 只下发剩余量，不臆造周期总额（0 → UI 显示 ?）
			Used:      0,
			// 无 Status 字段：有 expiresAt 且已过期才算失效。
			Active: !(expMs > 0 && time.Now().UnixMilli() >= expMs),
		})
	}
	// 面值推断（显示 100/100 而非 100/0）：同组有效包剩余量最大值当面值。
	// ⚠️ 只对有效包推断 —— 失效包可能当初面值不同，宁可显示 ?。
	faceByGroup := map[string]float64{}
	for _, pkg := range out.Packages {
		if pkg.Remaining > faceByGroup[pkg.Name] {
			faceByGroup[pkg.Name] = pkg.Remaining
		}
	}
	for i := range out.Packages {
		pkg := &out.Packages[i]
		if face := faceByGroup[pkg.Name]; face > 0 {
			pkg.Total = roundCredits(face)
			if pkg.Used <= 0 {
				pkg.Used = roundCredits(maxFloat(0, face-pkg.Remaining))
			}
		}
	}
	total := roundCredits(maxFloat(0, jsonNumberField(data, "totalCreditsRemaining")))
	// totalCreditsRemaining=0 且无明细 → 「查不到」而非「余额 0」（字段缺失时
	// readNumber 会伪装成 0 积分）。
	if total == 0 && len(out.Packages) == 0 {
		return nil, fmt.Errorf("jethub: lobsterai 余额响应不可解析")
	}
	out.Total = total
	out.IsCredit = true
	return out, nil
}

// lobsteraiCredentialFor resolves + parses a lobsterai credential.
func (m *Manager) lobsteraiCredentialFor(accountID string) (*LobsteraiCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "lobsterai" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("lobsterai", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred LobsteraiCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse lobsterai credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

func lobsteraiHasAction(list []any, target string) bool {
	for _, item := range list {
		if s, ok := item.(string); ok && s == target {
			return true
		}
	}
	return false
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// interface guard: url is referenced through net/url only implicitly here
var _ = url.QueryEscape
