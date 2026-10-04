package jethub

// Gemini 配额窗口查询（R3-3，ref gemini-credits.ts @ ff5e37d）。
//
// ⚠️ 这不是「积分余额」：Gemini 免费线是配额窗口制（5 小时 / 周两个窗口的
// 剩余比例 remainingFraction），不换算成任何积分数字——那会是编造。
//
// ⚠️ 请求体必须带 `project`（ref 2026-10-03 修正）：空对象 {} 对第二个
// Google 账号会 403 SUBSCRIPTION_REQUIRED；字段名是 `project`
//（`cloudaicompanionProject` 会 400 Unknown name）。
//
// ⚠️ 配额走 sandbox 端点（ref baseFor 的路由：loadCodeAssist /
// retrieveQuota 固定 sandbox，推理走 daily），忠实移植不"顺手统一"。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 配额桶 id（⚠️ 判据是 bucketId，不是 displayName——显示名会被上游改文案）。
const (
	geminiBucketFiveHour = "gemini-5h"
	geminiBucketWeekly   = "gemini-weekly"
)

// geminiUnauthorizedMessage 未授权文案（ref GEMINI_UNAUTHORIZED_MESSAGE：
// 面板据此区分「没登录」与「查询失败」；抛成异常会让账号卡片显示成故障）。
const geminiUnauthorizedMessage = "尚未授权 Google 账号"

// geminiQuotaWindow is one normalized quota window.
type geminiQuotaWindow struct {
	BucketID          string
	Window            string
	ResetTime         string
	RemainingFraction float64
}

// parseGeminiQuotaWindow parses one bucket; any hard constraint unmet → nil
// （⚠️ resetTime 不可解析 ⇒ 整条丢弃：编一个空窗口会让面板显示永远不过期）。
func parseGeminiQuotaWindow(raw any) *geminiQuotaWindow {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	bucketID, _ := m["bucketId"].(string)
	if bucketID == "" {
		return nil
	}
	fraction, ok := m["remainingFraction"].(float64)
	if !ok {
		return nil
	}
	resetTime, _ := m["resetTime"].(string)
	if resetTime == "" {
		return nil
	}
	if _, err := time.Parse(time.RFC3339, resetTime); err != nil {
		return nil
	}
	window, _ := m["window"].(string)
	return &geminiQuotaWindow{
		BucketID:          bucketID,
		Window:            window,
		ResetTime:         resetTime,
		RemainingFraction: fraction,
	}
}

// parseGeminiQuotaWindows picks the two Gemini buckets（普通 JSON 非 protobuf；
// 按 bucketId 匹配，不按 displayName / window）。
func parseGeminiQuotaWindows(payload any) (fiveHour, weekly *geminiQuotaWindow) {
	root, ok := payload.(map[string]any)
	if !ok {
		return nil, nil
	}
	groups, ok := root["groups"].([]any)
	if !ok {
		return nil, nil
	}
	for _, g := range groups {
		group, ok := g.(map[string]any)
		if !ok {
			continue
		}
		buckets, ok := group["buckets"].([]any)
		if !ok {
			continue
		}
		for _, b := range buckets {
			parsed := parseGeminiQuotaWindow(b)
			if parsed == nil {
				continue
			}
			if parsed.BucketID == geminiBucketFiveHour && fiveHour == nil {
				fiveHour = parsed
			}
			if parsed.BucketID == geminiBucketWeekly && weekly == nil {
				weekly = parsed
			}
		}
	}
	return fiveHour, weekly
}

// geminiQuotaCache is the 60s TTL cache keyed by access_token（面板 30s 刷一次；
// token 是账号稳定标识且配额按 token 归属）。
var geminiQuotaCache = struct {
	sync.Mutex
	entries map[string]geminiCachedQuota
}{entries: map[string]geminiCachedQuota{}}

type geminiCachedQuota struct {
	at     time.Time
	result *CreditBalance
	err    string
}

// geminiBalanceOf converts two windows → the unified CreditBalance（单位是
// 百分比；total 取两窗口剩余百分比的**平均**——取 min 会把「周 99%/5h 20%」
// 显示成 20%，误导整条线快用完；expiredTotal 恒 0）。
func geminiBalanceOf(fiveHour, weekly *geminiQuotaWindow) *CreditBalance {
	pkgs := []CreditPackage{}
	if fiveHour != nil {
		pkgs = append(pkgs, geminiPackageOf("5 小时窗口", fiveHour))
	}
	if weekly != nil {
		pkgs = append(pkgs, geminiPackageOf("周窗口", weekly))
	}
	if len(pkgs) == 0 {
		return &CreditBalance{Packages: []CreditPackage{}}
	}
	sum := 0.0
	for _, p := range pkgs {
		sum += p.Remaining
	}
	return &CreditBalance{
		Total:    roundCredits(sum / float64(len(pkgs))),
		Packages: pkgs,
	}
}

// geminiPackageOf: one window → one package（percent 0..100 收敛越界）。
func geminiPackageOf(label string, window *geminiQuotaWindow) CreditPackage {
	clamped := window.RemainingFraction
	if clamped < 0 {
		clamped = 0
	}
	if clamped > 1 {
		clamped = 1
	}
	remaining := float64(int64(clamped*100 + 0.5))
	return CreditPackage{
		Name:      label,
		Unit:      "%",
		Remaining: remaining,
		Total:     100,
		Used:      100 - remaining,
		Active:    true,
	}
}

// GeminiBalance queries the quota windows（不抛错的路径走 GeminiBalanceSafe；
// 这里保留 err 语义给 API 层）。缓存命中直接返回。
func (m *Manager) GeminiBalance(ctx context.Context, accountID string) (*CreditBalance, error) {
	cred, err := m.geminiCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, fmt.Errorf("%s", geminiUnauthorizedMessage)
	}
	now := time.Now()
	geminiQuotaCache.Lock()
	if cached, ok := geminiQuotaCache.entries[cred.AccessToken]; ok && now.Sub(cached.at) < geminiCreditsTTL {
		geminiQuotaCache.Unlock()
		if cached.err != "" {
			return nil, fmt.Errorf("%s", cached.err)
		}
		return cached.result, nil
	}
	geminiQuotaCache.Unlock()

	balance, qerr := m.geminiRequestQuota(ctx, cred)
	geminiQuotaCache.Lock()
	if qerr != nil {
		geminiQuotaCache.entries[cred.AccessToken] = geminiCachedQuota{at: now, err: qerr.Error()}
	} else {
		geminiQuotaCache.entries[cred.AccessToken] = geminiCachedQuota{at: now, result: balance}
	}
	geminiQuotaCache.Unlock()
	if qerr != nil {
		return nil, qerr
	}
	return balance, nil
}

// geminiRequestQuota: 配额本体（retrieveUserQuotaSummary，sandbox 端点）。
func (m *Manager) geminiRequestQuota(ctx context.Context, cred *GeminiCredential) (*CreditBalance, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"project": geminiProjectOf(cred)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		geminiEndpointSandbox+geminiQuotaPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range geminiIdentityHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("gemini").Do(req)
	if err != nil {
		return nil, fmt.Errorf("gemini: 配额查询网络失败：%v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("gemini: 配额查询被拒（HTTP %d）%s",
				resp.StatusCode, geminiQuotaRejectionHint(raw))
		}
		return nil, fmt.Errorf("gemini: 配额查询失败（HTTP %d）：%.200s", resp.StatusCode, raw)
	}
	var payload any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, fmt.Errorf("gemini: 配额响应不是 JSON（HTTP %d）", resp.StatusCode)
	}
	fiveHour, weekly := parseGeminiQuotaWindows(payload)
	if fiveHour == nil && weekly == nil {
		// 两个桶都没认出来 ⇒ 真失败，不伪造 100%（空余额会被面板渲染成 0，
		// 比「查询失败」更误导）。
		return nil, fmt.Errorf("gemini: 配额响应里没有 Gemini 配额桶")
	}
	return geminiBalanceOf(fiveHour, weekly), nil
}

// geminiQuotaRejectionHint 从 403/401 响应体挖一句指向真因的话：
// SUBSCRIPTION_REQUIRED 是账号形态差异（不是凭据问题）；凭据真失效通常是
// UNAUTHENTICATED / invalid_grant。挖不出附正文前 160 字，别吞现场。
func geminiQuotaRejectionHint(raw []byte) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
			Status  string `json:"status"`
			Details []struct {
				Reason string `json:"reason"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		for _, d := range payload.Error.Details {
			if d.Reason != "" {
				return fmt.Sprintf("（%s）：%s", d.Reason, truncateRunes(payload.Error.Message, 160))
			}
		}
		if payload.Error.Message != "" {
			return "：" + truncateRunes(payload.Error.Message, 160)
		}
	}
	if len(raw) == 0 {
		return ""
	}
	return "：" + truncateRunes(string(raw), 160)
}

// truncateRunes clips s to at most n runes.
func truncateRunes(s string, n int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= n {
		return string(runes)
	}
	return string(runes[:n])
}
