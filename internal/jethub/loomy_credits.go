package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Loomy credits + onboarding + augment (ref loomy-credits.ts /
// loomy-onboarding.ts / loomy-adapter.ts).

// loomyDailyQuotaDescription is the accurate UI wording: the daily grant is a
// RESET (dailyBalance = dailyQuota - dailyConsumed, never re-granted).
const loomyDailyQuotaDescription = "每日赠送额度（消耗后不回补）"

// loomyRequest performs a business-endpoint request. ⚠️ Business failures are
// ALWAYS HTTP 200 + body code; the status code never decides.
func (m *Manager) loomyRequest(ctx context.Context, cred *LoomyCredential, method, path, body string) (map[string]any, error) {
	var reader io.Reader
	if body != "" {
		reader = strReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, loomyProduct.APIBase+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range loomyBusinessHeaders(cred.AccessToken) {
		req.Header.Set(k, v)
	}
	tctx, cancel := context.WithTimeout(ctx, loomyTimeout)
	defer cancel()
	req = req.WithContext(tctx)
	resp, err := m.httpClient("loomy").Do(req)
	if err != nil {
		return nil, fmt.Errorf("loomy: 请求失败（%s）：%w", path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("loomy: 响应不是 JSON（%s，HTTP %d）", path, resp.StatusCode)
	}
	data, _, message, ok := parseLoomyEnvelope(parsed)
	if !ok {
		// 100002 (登录失效) → 明确「请重新登录」，绝不能假装成功。
		if code := jsonStringField(parsed, "code"); code == loomyAuthCode {
			return nil, ErrRefreshTokenExpired
		}
		return nil, fmt.Errorf("loomy: %s", firstNonEmpty(message, "请求失败（"+path+"）"))
	}
	return data, nil
}

// LoomyCreditBalance queries the two pools (read-only points/records — the
// first-login endpoint is a WRITE and would trigger a check-in on every
// panel open). Two packages keep 永久/每日 visibly separate (user requirement).
func (m *Manager) LoomyCreditBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.loomyCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	data, err := m.loomyRequest(ctx, cred, http.MethodGet,
		"/points/records?pageNo=1&pageSize=1&recordType=all", "")
	if err != nil {
		return nil, err
	}
	permanent := jsonNumberField(data, "balance")
	// `balance` is the core field: without it the shape is wrong — never
	// fabricate numbers.
	found := false
	for _, key := range []string{"balance", "dailyBalance", "availableBalance"} {
		if _, ok := data[key]; ok {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("loomy: 余额响应缺少 balance 字段")
	}
	daily := jsonNumberField(data, "dailyBalance")
	total := jsonNumberField(data, "availableBalance")
	if total == 0 {
		total = permanent + daily
	}
	return &CreditBalance{
		Total: total,
		Packages: []CreditPackage{
			{Name: "永久积分", Unit: "积分", Remaining: permanent, Total: permanent, Active: true},
			{Name: "每日赠送", Unit: "积分", Remaining: daily, Total: daily, Active: true},
		},
		IsCredit: true,
		// 无「已失效」概念：两池都视为有效额度。
	}, nil
}

// ClaimLoomyDaily triggers the daily grant. ⚠️ Semantics = RESET trigger,
// NOT +5000: dailyBalance = dailyQuota - dailyConsumed, never re-granted —
// the UI wording must be accurate. ⚠️ Idempotence = body alreadyProcessed
// (repeat calls are HTTP 200) → already-claimed, NOT claimed (the latter
// would tell users credits were re-added). Never throws (batch callers
// must not break on one account).
func (m *Manager) ClaimLoomyDaily(ctx context.Context, accountID string) (*ClaimOutcome, error) {
	cred, err := m.loomyCredentialFor(accountID)
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	data, err := m.loomyRequest(ctx, cred, http.MethodPost, "/points/first-login", "{}")
	if err != nil {
		return &ClaimOutcome{Kind: "failed", Message: err.Error()}, nil
	}
	dailyQuota := jsonNumberField(data, "dailyQuota")
	dailyBalance := jsonNumberField(data, "dailyBalance")
	if data["alreadyProcessed"] == true {
		if dailyQuota == 0 {
			return &ClaimOutcome{Kind: "already-claimed", Message: "今日额度已初始化"}, nil
		}
		return &ClaimOutcome{Kind: "already-claimed",
			Message: fmt.Sprintf("今日额度已初始化（每日 %.0f/%.0f）", dailyBalance, dailyQuota)}, nil
	}
	// 首次处理：`credit` 是本次新发放的额度 = dailyQuota - dailyConsumed；
	// 两者缺一就回 0（不编造）。
	consumed := jsonNumberField(data, "dailyConsumed")
	granted := 0.0
	if dailyQuota > 0 || consumed > 0 {
		granted = dailyQuota - consumed
	}
	return &ClaimOutcome{Kind: "claimed", Credit: granted, Message: loomyDailyQuotaDescription}, nil
}

// loomyRequestData is loomyRequest returning raw data for callers doing
// their own classification. (Currently unused; kept for the onboarding
// extension path.)

// --- 新手任务（一次性，独立于每日签到） ---

// loomyOnboardingTasks is the 8-task table (1:1 from the client
// onboarding-service.js TASK_POINTS — the unit tests assert the sum === 10000;
// keys must NOT be invented, the server accepts only these).
var loomyOnboardingTasks = map[string]struct {
	Title  string
	Points float64
}{
	"first_message":    {"发送你的第一条消息", 500},
	"pick_skill":       {"试试选择一个技能", 1000},
	"generate_ppt":     {"生成第一份 PPT", 1500},
	"set_schedule":     {"设置定时任务", 1000},
	"install_skill":    {"在技能广场安装一个技能", 1500},
	"configure_remote": {"配置远程控制", 1000},
	"create_soul":      {"创建你的第一个搭子", 1500},
	"share_soul":       {"把搭子分享给朋友", 2000},
}

// LoomyOnboardingStatus returns the 8-task completion state + earned total.
func (m *Manager) LoomyOnboardingStatus(ctx context.Context, accountID string) (tasks map[string]bool, earned, total float64, err error) {
	cred, err := m.loomyCredentialFor(accountID)
	if err != nil {
		return nil, 0, 0, err
	}
	data, err := m.loomyRequest(ctx, cred, http.MethodGet, "/onboarding/tasks", "")
	if err != nil {
		return nil, 0, 0, err
	}
	taskState, _ := data["tasks"].(map[string]any)
	tasks = map[string]bool{}
	for key := range loomyOnboardingTasks {
		tasks[key] = taskState[key] == true
	}
	earned = loomyComputeEarned(tasks)
	total = jsonNumberField(data, "total")
	if total == 0 {
		for _, t := range loomyOnboardingTasks {
			total += t.Points
		}
	}
	return tasks, earned, total, nil
}

// loomyComputeEarned sums the completed tasks' points.
func loomyComputeEarned(tasks map[string]bool) float64 {
	var sum float64
	for key, done := range tasks {
		if done {
			if t, ok := loomyOnboardingTasks[key]; ok {
				sum += t.Points
			}
		}
	}
	return sum
}

// ClaimLoomyOnboarding completes all pending tasks (idempotent replays
// tolerated; returns what was claimed vs skipped).
func (m *Manager) ClaimLoomyOnboarding(ctx context.Context, accountID string) (claimed []string, skipped []string, earned, total float64, err error) {
	cred, err := m.loomyCredentialFor(accountID)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	tasks, _, total, err := m.LoomyOnboardingStatus(ctx, accountID)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	for key := range loomyOnboardingTasks {
		if tasks[key] {
			skipped = append(skipped, key)
			continue
		}
		body, _ := json.Marshal(map[string]string{"key": key})
		data, err := m.loomyRequest(ctx, cred, http.MethodPost, "/onboarding/tasks/complete", string(body))
		if err != nil {
			// 单任务失败不中断整批（与每日签到同策略）。
			continue
		}
		_ = data
		claimed = append(claimed, key)
	}
	// 领取后重查 earned（本地现算）。
	tasks, earned, _, err = m.LoomyOnboardingStatus(ctx, accountID)
	if err != nil {
		return claimed, skipped, 0, total, nil
	}
	return claimed, skipped, earned, total, nil
}

// --- augment：标准 OpenAI 兼容 + 标准 SSE（无加密/信封/转换） ---

// loomyAugment: chat 端点只认 Authorization: Bearer（必须带前缀）；
// 官方客户端 session 模式下两个头都发——保持一致防上游改判据。
func (m *Manager) loomyAugment(r *http.Request, body []byte, providerID, keyID, upstreamModel string) ([]byte, error) {
	cred, err := m.loomyCredentialFor(keyID)
	if err != nil {
		return nil, err
	}
	for k, v := range loomyChatHeaders(cred.AccessToken) {
		r.Header.Set(k, v)
	}
	// Body 透传（标准 OpenAI 协议；reasoning_effort 是 loomy 认的顶层字段）。
	return body, nil
}

// loomyCredentialFor resolves + parses a loomy credential.
func (m *Manager) loomyCredentialFor(accountID string) (*LoomyCredential, error) {
	acc, ok := m.FindAccount(accountID)
	if !ok || acc.Provider != "loomy" {
		return nil, errAccountNotFound(accountID)
	}
	raw, ok := m.Credential("loomy", acc.CredentialRef)
	if !ok {
		return nil, errCredentialMissing(accountID)
	}
	var cred LoomyCredential
	if err := jsonUnmarshal(raw, &cred); err != nil {
		return nil, fmt.Errorf("jethub: parse loomy credential %s: %w", accountID, err)
	}
	if cred.AccessToken == "" {
		return nil, errCredentialMissing(accountID)
	}
	return &cred, nil
}

// SubmitLoomySmsLogin completes the SMS login for an account (msgid from the
// send step echoed verbatim) and initializes the daily quota best-effort.
func (m *Manager) SubmitLoomySmsLogin(ctx context.Context, accountID, phone, code, msgid string) error {
	result, err := m.LoginLoomyBySmsCode(ctx, phone, code, msgid)
	if err != nil {
		return err
	}
	cred := BuildLoomyCredential(result.Session, result.UserID, phone, "")
	if err := m.CompleteLoomyLogin(accountID, cred); err != nil {
		return err
	}
	// 尽力初始化每日额度（与官方登录后行为一致；失败不影响登录）。
	if _, err := m.ClaimLoomyDaily(ctx, accountID); err != nil && m.logger != nil {
		m.logger.Warn("[loomy] 登录后初始化每日额度失败（不影响登录）：%v", err)
	}
	return nil
}

// CompleteLoomyLogin persists the credential (SetCredential triggers the
// key-sync hook); refreshable is honestly false.
func (m *Manager) CompleteLoomyLogin(accountID string, cred *LoomyCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, LoomyExpiresAtMs(cred), LoomyRefreshable()); err != nil {
		return err
	}
	_ = m.UpdateAccount(accountID, func(a *Account) {
		a.Nickname = firstNonEmpty(cred.Phone, a.ID)
		a.Refreshable = LoomyRefreshable()
	})
	return nil
}

// ProbeLoomyAccount is the account-card "refresh" button: verify WITHOUT
// renewing (Loomy cannot renew) and reconcile the pool expiry with the
// credential's actual exp.
func (m *Manager) ProbeLoomyAccount(ctx context.Context, accountID string) error {
	cred, err := m.loomyCredentialFor(accountID)
	if err != nil {
		return err
	}
	if err := m.probeLoomyCredential(ctx, cred); err != nil {
		return err
	}
	// 对账：池值可能与凭据 exp 不一致（历史写入偏差）——只回写 expiresAt。
	_ = m.UpdateAccount(accountID, func(a *Account) { a.ExpiresAt = LoomyExpiresAtMs(cred) })
	return nil
}

// interface guard to keep strings imported.
var _ = strings.TrimSpace
