package jethub

// Codely 积分余额与每日签到（ref src/codely-credits.ts @ 301f6bc）。
//
// 余额：`GET /api/user/usage/summary` → `remaining_points` 是**字符串**（"2400"），
// 顶层与 details[] 都是；details[] 是逐桶结构（多桶账号不能只看顶层）。
//
// 签到：`POST /api/points/check-in/init` 查状态（不发积分）→ 仅当
// `can_check_in === true` 才 `POST /api/points/check-in`。执行响应**不返回**
// 本次数额，唯一可用数字是 init 里 `levels[status=CURRENT].reward_summary`（"+300"）。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// codelyPoints reads a point value: string-or-number, non-negative only.
// Missing/invalid → ok=false (0 的语义是「已用光」，不能拿来兜底).
func codelyPoints(value any) (float64, bool) {
	n, ok := zcodeJSONNumber(value)
	if !ok || n < 0 {
		return 0, false
	}
	return float64(int64(n)), true
}

// codelyDetailLabel maps measured bucket types; unknown types stay raw.
func codelyDetailLabel(typ string) string {
	if typ == "gift_credit" {
		return "赠送积分"
	}
	return typ
}

// FetchCodelyBalance queries the points wallet.
func (m *Manager) FetchCodelyBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.codelyCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	payload, status, err := m.codelyAuthorizedJSON(ctx, http.MethodGet, codelyAPIBase+codelyUsageSummaryPath, nil, cred.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("Codely 积分查询失败：%w", err)
	}
	if status == 401 {
		return nil, errors.New("Codely 访问令牌无效或已过期（HTTP 401），请重新登录该账号")
	}
	if status < 200 || status >= 300 || payload == nil {
		return nil, fmt.Errorf("Codely 积分查询失败（HTTP %d）", status)
	}
	return codelyParseBalance(payload)
}

// codelyParseBalance is the pure parse step (details first, top-level fallback).
func codelyParseBalance(payload map[string]any) (*CreditBalance, error) {
	top, topOK := codelyPoints(payload["remaining_points"])
	details, _ := payload["details"].([]any)
	packages := make([]CreditPackage, 0, len(details))
	var sum float64
	unreadable := false
	for _, item := range details {
		detail, ok := item.(map[string]any)
		if !ok {
			continue
		}
		remaining, ok := codelyPoints(detail["remaining_points"])
		if !ok {
			unreadable = true
			continue
		}
		typ, _ := detail["type"].(string)
		exhausted, _ := detail["exhausted"].(bool)
		packages = append(packages, CreditPackage{
			Name:      codelyDetailLabel(typ),
			Unit:      "credit",
			Remaining: remaining,
			Active:    !exhausted,
		})
		sum += remaining
	}
	if unreadable {
		return nil, errors.New("Codely 积分响应里有读不出的桶（remaining_points 格式变了），不显示 0")
	}
	total := sum
	if len(packages) == 0 {
		if !topOK {
			return nil, errors.New("Codely 积分响应缺少可解析的 remaining_points")
		}
		total = top
		packages = []CreditPackage{{
			Name: "积分", Unit: "credit", Remaining: top, Active: true,
		}}
	}
	return &CreditBalance{Total: total, Packages: packages, IsCredit: true}, nil
}

// codelyCheckinState is the shared init/execute response shape.
type codelyCheckinState struct {
	ActivityStatus string
	CheckInStatus  string
	Count          float64
	MaxCount       float64
	CanCheckIn     bool
	Error          string
	Reward         float64
	HasReward      bool
}

// codelyParseCheckinState is the pure parse step.
func codelyParseCheckinState(payload map[string]any) codelyCheckinState {
	state := codelyCheckinState{}
	state.ActivityStatus, _ = payload["activity_status"].(string)
	state.CheckInStatus, _ = payload["check_in_status"].(string)
	state.CanCheckIn, _ = payload["can_check_in"].(bool)
	state.Error, _ = payload["error"].(string)
	if n, ok := zcodeJSONNumber(payload["check_in_count"]); ok {
		state.Count = n
	}
	if n, ok := zcodeJSONNumber(payload["max_count"]); ok {
		state.MaxCount = n
	}
	if levels, ok := payload["levels"].([]any); ok {
		for _, item := range levels {
			level, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if status, _ := level["status"].(string); status != "CURRENT" {
				continue
			}
			if summary, _ := level["reward_summary"].(string); summary != "" {
				state.Reward, state.HasReward = codelyReward(summary)
			}
			break
		}
	}
	return state
}

// codelyReward parses "+300" / "300" / "+ 300 积分" into 300.
func codelyReward(summary string) (float64, bool) {
	cleaned := strings.TrimSpace(summary)
	cleaned = strings.TrimPrefix(cleaned, "+")
	cleaned = strings.TrimSpace(cleaned)
	digits := make([]rune, 0, len(cleaned))
	for _, r := range cleaned {
		if r < '0' || r > '9' {
			break
		}
		digits = append(digits, r)
	}
	if len(digits) == 0 {
		return 0, false
	}
	var value float64
	for _, r := range digits {
		value = value*10 + float64(r-'0')
	}
	return value, true
}

// ClaimCodelyDailyCheckIn runs the two-step check-in (init → execute).
func (m *Manager) ClaimCodelyDailyCheckIn(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.codelyCredentialFor(accountID)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	init, status, err := m.codelyAuthorizedJSON(ctx, http.MethodPost, codelyAPIBase+codelyCheckinInitPath, []byte(`{}`), cred.AccessToken)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: "Codely 签到状态查询失败：" + err.Error()}, nil
	}
	if status == 401 || status == 403 {
		return &ClaimOutcome{Kind: "failed", Message: "Codely 访问令牌无效或已过期，请重新登录该账号"}, nil
	}
	if status < 200 || status >= 300 || init == nil {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("Codely 签到状态查询失败（HTTP %d）：响应不是 JSON 或端点改版", status)}, nil
	}
	current := codelyParseCheckinState(init)
	if current.ActivityStatus != "" && current.ActivityStatus != "ACTIVE" {
		return &ClaimOutcome{Kind: "inactive", Message: codelyActivityLabel(current.ActivityStatus)}, nil
	}
	if current.CheckInStatus == "UNAVAILABLE" {
		reason := current.Error
		if reason == "" {
			reason = "签到暂不可用"
		}
		return &ClaimOutcome{Kind: "failed", Message: "Codely 签到暂不可用：" + reason}, nil
	}
	if !current.CanCheckIn {
		if current.Count > 0 && current.MaxCount > 0 {
			return &ClaimOutcome{Kind: "already-claimed", Message: fmt.Sprintf("今天已签到（本月已累计 %d/%d 次）", int64(current.Count), int64(current.MaxCount))}, nil
		}
		return &ClaimOutcome{Kind: "already-claimed", Message: "今天已签到"}, nil
	}

	done, status, err := m.codelyAuthorizedJSON(ctx, http.MethodPost, codelyAPIBase+codelyCheckinPath, []byte(`{}`), cred.AccessToken)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: "Codely 签到执行失败：" + err.Error()}, nil
	}
	if status < 200 || status >= 300 || done == nil {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("Codely 签到执行失败（HTTP %d）：响应不是 JSON 或端点改版", status)}, nil
	}
	final := codelyParseCheckinState(done)
	if final.CheckInStatus != "COMPLETED" {
		return &ClaimOutcome{Kind: "already-claimed", Message: fmt.Sprintf("签到已受理（状态 %s），奖励到账前请勿重复操作", firstNonEmpty(final.CheckInStatus, "未知"))}, nil
	}
	out := &ClaimOutcome{Kind: "claimed", Credit: current.Reward}
	if !current.HasReward {
		out.Message = "签到成功（上游未返回本次积分数额，请查看刷新后的余额）"
	}
	return out, nil
}

// codelyActivityLabel renders measured activity_status values; unknown values
// stay verbatim (never invent an official-looking explanation).
func codelyActivityLabel(status string) string {
	switch status {
	case "ENDED":
		return "签到活动已结束"
	case "NOT_STARTED":
		return "签到活动尚未开始"
	case "PAUSED":
		return "签到活动已暂停"
	}
	return "签到活动状态异常（" + status + "）"
}
