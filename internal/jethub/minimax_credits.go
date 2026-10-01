package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// MiniMax signin + credits + augment (ref minimax-credits.ts /
// minimax-adapter.ts).

// minimaxEnvelope posts/gets a business request with the base_resp.code
// handling. ⚠️ The business code lives at base_resp.status_code (NOT code),
// and `invalid timezone_id` also arrives as HTTP 200 — status-only reading
// would treat it as success. Never throws (batch callers count by kind).
func (m *Manager) minimaxEnvelope(ctx context.Context, cred *MinimaxCredential, method, url, body string) (map[string]any, int64, string, bool) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if body != "" {
		req, err = http.NewRequestWithContext(ctx, method, url, strReader(body))
	}
	if err != nil {
		return nil, -1, err.Error(), false
	}
	for k, v := range minimaxHeaders(cred, body != "") {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, minimaxRequestTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, -1, err.Error(), false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, int64(resp.StatusCode), fmt.Sprintf("凭据已失效（HTTP %d），请重新登录该账号", resp.StatusCode), false
		}
		return nil, int64(resp.StatusCode), fmt.Sprintf("服务端返回了非 JSON 响应（HTTP %d）", resp.StatusCode), false
	}
	baseResp, _ := payload["base_resp"].(map[string]any)
	if baseResp == nil {
		baseResp = map[string]any{}
	}
	statusCode := jsonNumberField(baseResp, "status_code")
	statusMsg := jsonStringField(baseResp, "status_msg")
	if statusCode != 0 {
		return payload, int64(statusCode), firstNonEmpty(statusMsg, fmt.Sprintf("业务错误 %v", statusCode)), false
	}
	return payload, 0, "", true
}

// unwrapEnvelopeData: signin/status & signin/claim are enveloped (data key),
// but credit/details is FLAT (total_count + base_resp at the top level —
// verified). "Has data object → use it, else the top level": forcing `data`
// would misjudge a legal balance response as "missing data" and turn
// "balance 0" into a query failure.
func unwrapEnvelopeData(payload map[string]any) map[string]any {
	if nested, ok := payload["data"].(map[string]any); ok {
		return nested
	}
	return payload
}

// minimaxWithTimezone appends timezone_id — a REQUIRED query param (measured:
// header placement is invalid, missing errors, illegal zone names error).
func minimaxWithTimezone(path, timezoneID string) string {
	return minimaxProduct.APIHost + path + "?timezone_id=" + urlQueryEscape(timezoneID)
}

// MinimaxTimezoneID: the signin settles by the CLIENT-REPORTED timezone
// (unlike Qoder's fixed UTC+8 — do not cross-apply).
func MinimaxTimezoneID(tz string) string {
	return firstNonEmpty(strings.TrimSpace(tz), "UTC")
}

// minimaxSigninDay is one panel day.
type minimaxSigninDay struct {
	DayNo       int64
	Points      float64
	BonusPoints float64
	Status      int64
	IsToday     bool
}

// parseMinimaxSigninPanel replicates asar validateSigninPanel's hard
// constraints (undefined on violation — never fabricate):
// days exactly 7; day_no 1..7 unique; points/bonus non-negative finite;
// is_today boolean; status ∈ {1,2,3,4}; ≤1 Claimable; ≤1 is_today;
// scene ∈ {0..4}.
func parseMinimaxSigninPanel(data map[string]any) (*[]minimaxSigninDay, int64) {
	if data == nil {
		return nil, 0
	}
	scene := jsonNumberField(data, "scene")
	if !minimaxValidScene(scene) {
		return nil, 0
	}
	rawDays, ok := data["days"].([]any)
	if !ok || len(rawDays) != 7 {
		return nil, 0
	}
	days := make([]minimaxSigninDay, 0, 7)
	seen := map[int64]bool{}
	claimable, today := 0, 0
	for _, raw := range rawDays {
		day, ok := raw.(map[string]any)
		if !ok {
			return nil, 0
		}
		dayNo := jsonNumberField(day, "day_no")
		points := jsonNumberField(day, "points")
		status := jsonNumberField(day, "status")
		bonusPoints := jsonNumberField(day, "bonus_points")
		isToday, isTodayOK := day["is_today"].(bool)
		if dayNo < 1 || dayNo > 7 || dayNo != float64(int64(dayNo)) || seen[int64(dayNo)] {
			return nil, 0
		}
		if points < 0 || bonusPoints < 0 || !isTodayOK {
			return nil, 0
		}
		if !minimaxValidStatus(status) {
			return nil, 0
		}
		seen[int64(dayNo)] = true
		if status == minimaxStatusClaimable {
			claimable++
		}
		if isToday {
			today++
		}
		days = append(days, minimaxSigninDay{
			DayNo: int64(dayNo), Points: points, BonusPoints: bonusPoints,
			Status: int64(status), IsToday: isToday,
		})
	}
	if claimable > 1 || today > 1 {
		return nil, 0
	}
	return &days, int64(scene)
}

func minimaxValidStatus(s float64) bool {
	return s == minimaxStatusActive || s == minimaxStatusClaimable || s == minimaxStatusClaimed || s == minimaxStatusDisabled
}

func minimaxValidScene(s float64) bool {
	return s >= minimaxSceneUnknown && s <= minimaxSceneBroken
}

// minimaxStreak computes the consecutive-claimed count walking back from
// today (today claimed → start at today; today claimable → start at the
// previous day).
func minimaxStreak(days *[]minimaxSigninDay) int64 {
	var todayIdx = -1
	for i, d := range *days {
		if d.IsToday {
			todayIdx = i
			break
		}
	}
	if todayIdx < 0 {
		return 0
	}
	idx := todayIdx
	switch (*days)[todayIdx].Status {
	case minimaxStatusClaimed:
		// start at today
	case minimaxStatusClaimable:
		idx = todayIdx - 1
	default:
		return 0
	}
	streak := int64(0)
	for ; idx >= 0; idx-- {
		if (*days)[idx].Status != minimaxStatusClaimed {
			break
		}
		streak++
	}
	return streak
}

// MinimaxCheckinStatus is the normalized panel snapshot for the UI.
type MinimaxCheckinStatus struct {
	Active         bool
	TodayCheckedIn bool
	StreakDays     int64
	DailyCredit    float64
	TodayCredit    float64
}

// minimaxPanelToStatus maps the panel. ⚠️ dailyCredit = points (800), NOT
// points + bonus_points (1200). ⚠️ active is ALWAYS true (a fetched response
// implies an active activity — "no claimable" does NOT mean "closed"; the
// Qoder lesson: claiming success leaves the list non-empty).
func minimaxPanelToStatus(days *[]minimaxSigninDay) *MinimaxCheckinStatus {
	var today, claimable *minimaxSigninDay
	for i := range *days {
		d := &(*days)[i]
		if d.IsToday {
			today = d
		}
		if d.Status == minimaxStatusClaimable && claimable == nil {
			claimable = d
		}
	}
	claimedToday := today != nil && today.Status == minimaxStatusClaimed
	target := today
	if target == nil {
		target = claimable
	}
	return &MinimaxCheckinStatus{
		Active: true,
		TodayCheckedIn: claimedToday,
		StreakDays:     minimaxStreak(days),
		DailyCredit:    targetPoints(target), // ⚠️ points 总数，不相加 bonus_points
		TodayCredit:    todayPointsIf(claimedToday, today),
	}
}

func targetPoints(d *minimaxSigninDay) float64 {
	if d == nil {
		return 0
	}
	return d.Points
}

func todayPointsIf(claimed bool, today *minimaxSigninDay) float64 {
	if !claimed || today == nil {
		return 0
	}
	return today.Points
}

// MinimaxSigninStatus queries the panel (timezone_id REQUIRED).
func (m *Manager) MinimaxSigninStatus(ctx context.Context, accountID, timezoneID string) (*MinimaxCheckinStatus, error) {
	cred, err := m.minimaxCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	payload, code, msg, ok := m.minimaxEnvelope(ctx, cred, http.MethodGet,
		minimaxWithTimezone(minimaxSigninStatusPath, MinimaxTimezoneID(timezoneID)), "")
	if !ok {
		return nil, fmt.Errorf("minimax: %s（%d）", msg, code)
	}
	days, _ := parseMinimaxSigninPanel(unwrapEnvelopeData(payload))
	if days == nil {
		return nil, fmt.Errorf("minimax: 签到面板响应无法解析")
	}
	return minimaxPanelToStatus(days), nil
}

// ClaimMinimaxDaily claims the daily check-in. ⚠️ Idempotence = claim_result
// (1=claimed, 2=already), NOT the HTTP status (repeat claims are also 200).
func (m *Manager) ClaimMinimaxDaily(ctx context.Context, accountID, timezoneID string) (*ClaimOutcome, error) {
	cred, err := m.minimaxCredentialFor(accountID)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	payload, code, msg, ok := m.minimaxEnvelope(ctx, cred, http.MethodPost,
		minimaxWithTimezone(minimaxSigninClaimPath, MinimaxTimezoneID(timezoneID)), "{}")
	if !ok {
		return &ClaimOutcome{Kind: "failed", Message: fmt.Sprintf("%s（%d）", msg, code)}, nil
	}
	data := unwrapEnvelopeData(payload)
	claimResult := jsonNumberField(data, "claim_result")
	// ⚠️ 幂等：重复领取返回 2。
	if claimResult == minimaxClaimAlready {
		return &ClaimOutcome{Kind: "already-claimed", Message: "今日已签到"}, nil
	}
	if claimResult != minimaxClaimClaimed {
		return &ClaimOutcome{Kind: "failed", Message: "签到响应缺少有效的 claim_result"}, nil
	}
	// credit 取 points（总数，已含 bonus_points）。
	points := jsonNumberField(data, "points")
	if days, _ := parseMinimaxSigninPanel(fieldMap(data, "panel")); days != nil {
		_ = minimaxStreak(days) // streak 属 CheckinStatus 展示域；claim 回执只带 credit
	}
	return &ClaimOutcome{Kind: "claimed", Credit: points}, nil
}

func fieldMap(data map[string]any, key string) map[string]any {
	m, _ := data[key].(map[string]any)
	return m
}

// MinimaxBalance queries the credit balance. ⚠️ total_count is the RECORD
// COUNT of details[], NOT the balance (the production-data-refuted misread:
// after claiming 800, total_count=1 while remaining_amount="800.00" — at
// balance 0 the fields accidentally coincide, which is why the initial misread
// survived its own test). Balance = Σ details[].remaining_amount (STRING
// amounts — looseAmount tolerates both forms). details missing ⇒ 0 (truly
// zero), NOT a failure.
func (m *Manager) MinimaxBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.minimaxCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	payload, code, msg, ok := m.minimaxEnvelope(ctx, cred, http.MethodGet,
		minimaxProduct.APIHost+minimaxCreditDetails, "")
	if !ok {
		return nil, fmt.Errorf("minimax: %s（%d）", msg, code)
	}
	data := unwrapEnvelopeData(payload)
	details, isArr := data["details"].([]any)
	_, hasTotalCount := data["total_count"]
	if !isArr && !hasTotalCount {
		return nil, fmt.Errorf("minimax: 余额响应形状不对") // 不编造 0
	}
	total := 0.0
	for _, entry := range details {
		e, ok2 := entry.(map[string]any)
		if !ok2 {
			continue
		}
		if remaining := looseAmount(e["remaining_amount"]); remaining != nil {
			total += *remaining
		}
	}
	return &CreditBalance{Total: roundCredits(total), Packages: []CreditPackage{}, IsCredit: true}, nil
}

// looseAmount parses money amounts tolerating string forms ("800.00").
// ⚠️ Empty string → nil (Number('') = 0 would misread empty as zero).
func looseAmount(v any) *float64 {
	switch t := v.(type) {
	case float64:
		f := t
		return &f
	case string:
		trimmed := strings.TrimSpace(t)
		if trimmed == "" {
			return nil
		}
		if isAllDigits(trimmed) || strings.Contains(trimmed, ".") && isAllDigits(strings.Replace(trimmed, ".", "", 1)) {
			var f float64
			if err := json.Unmarshal([]byte(trimmed), &f); err == nil {
				return &f
			}
		}
	}
	return nil
}

// minimaxAugment: Anthropic Messages native passthrough — x-api-key family
// is NOT used; only Authorization Bearer + no anthropic-version (verified
// unnecessary). Body unchanged (no protocol conversion — AGENTS.md 纪律).
func (m *Manager) minimaxAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.minimaxCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	for k := range r.Header {
		r.Header.Del(k)
	}
	for k, v := range MinimaxInferHeaders(cred) {
		r.Header.Set(k, v)
	}
	return body, nil
}

// minimaxCredentialFor resolves + parses a minimax credential.
func (m *Manager) minimaxCredentialFor(accountID string) (*MinimaxCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "minimax" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("minimax", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred MinimaxCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse minimax credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// SubmitMinimaxDeviceLogin persists a finished device flow (device-code login
// has no local callback; the UI polls /status with loginId).
func (m *Manager) SubmitMinimaxDeviceLogin(ctx context.Context, accountID string, grant *minimaxDeviceAuthorization) (*MinimaxCredential, error) {
	cred, err := m.PollMinimaxDeviceToken(ctx, grant)
	if err != nil {
		return nil, err
	}
	if err := m.CompleteMinimaxLogin(accountID, cred); err != nil {
		return nil, err
	}
	return cred, nil
}

// CompleteMinimaxLogin persists the credential.
func (m *Manager) CompleteMinimaxLogin(accountID string, cred *MinimaxCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, MinimaxExpiresAtMs(cred), MinimaxRefreshable(cred)); err != nil {
		return err
	}
	return nil
}

// RefreshMinimaxAccount renews one stored credential.
func (m *Manager) RefreshMinimaxAccount(ctx context.Context, accountID string) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	raw, ok := m.Credential(acc.Provider, acc.CredentialRef)
	if !ok {
		return fmt.Errorf("jethub: credential missing for %s", accountID)
	}
	var cred MinimaxCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return fmt.Errorf("jethub: parse minimax credential %s: %w", accountID, err)
	}
	if !MinimaxRefreshable(&cred) {
		return ErrRefreshTokenExpired
	}
	refreshed, err := m.RefreshMinimaxCredential(ctx, &cred)
	if err != nil {
		return err
	}
	credJSON, err := json.Marshal(refreshed)
	if err != nil {
		return err
	}
	return m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, MinimaxExpiresAtMs(refreshed), MinimaxRefreshable(refreshed))
}
