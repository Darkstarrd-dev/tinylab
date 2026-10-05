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
		// 窗口的重置时刻进明细（ref makeQuotaPackage 的 cycleEndTime = resetTime）：
		// 面板 hover 显示「重置于 …」。配额是**滚动重置**的额度，不是按月结算的
		// 套餐周期 —— 用「本周期至」会让人以为要等一个月。
		CycleEndTime: window.ResetTime,
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

// ── 账号规格（loadCodeAssist）─────────────────────────────────────────────────

// GeminiAccountTier 是面板「账号规格」那一行的内容（`Pro` / `Free` / `Ultra`）。
//
// ⚠️ 档位来自 `loadCodeAssist`，与配额是**两个端点**（ref 同款：并行发、搭同一次
// 读数回来）。取不到时整行为空 —— 它是附注信息，不该制造一条无法修复的提示。
type GeminiAccountTier struct {
	// Label 是面板短标签（只放得下一个词）。
	Label string `json:"label"`
	// Title 是上游原文（`Google AI Pro（g1-pro-tier）`），hover 才看得到。
	Title string `json:"title"`
}

// geminiTierLabel: 档位 id/名 → 面板短标签。
//
// ⚠️ 顺序有意义：`Ultra` → `Pro` → `Free`。上游把「Pro 但已降级」也叫
// `free-tier`（`Antigravity Starter Quota`），故不能只看 id 的 `-tier` 后缀。
func geminiTierLabel(id, name string) string {
	combined := strings.ToLower(id + " " + name)
	switch {
	case strings.Contains(combined, "ultra"):
		return "Ultra"
	case strings.Contains(combined, "pro"):
		return "Pro"
	case strings.Contains(combined, "free"):
		return "Free"
	}
	if name != "" {
		return name
	}
	return id
}

// parseGeminiAccountTier 从 loadCodeAssist 响应里解出账号规格。
//
// ⚠️ 只读 `paidTier` / `currentTier` 的 `id` / `name`（`paidTier` 优先：两个档位
// 的 `currentTier` 恒为 `{id:'free-tier',name:'Antigravity'}`，真正区分「有没有
// Google AI Pro」的是 `paidTier`）。响应里的 description、privacyNotice、
// allowedTiers **一个都不要展示**。
func parseGeminiAccountTier(payload any) *GeminiAccountTier {
	root, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	pick := func(raw any) (string, string, bool) {
		m, ok := raw.(map[string]any)
		if !ok {
			return "", "", false
		}
		id, _ := m["id"].(string)
		name, _ := m["name"].(string)
		if id == "" && name == "" {
			return "", "", false
		}
		return id, name, true
	}
	id, name, ok := pick(root["paidTier"])
	if !ok {
		id, name, ok = pick(root["currentTier"])
	}
	if !ok {
		return nil
	}
	title := name
	switch {
	case id != "" && name != "":
		title = name + "（" + id + "）"
	case title == "":
		title = id
	}
	return &GeminiAccountTier{Label: geminiTierLabel(id, name), Title: title}
}

// geminiTierCache 与配额同款 TTL（面板挂载时两条请求都发；档位几乎不变，
// 缓存只为省掉每次切 provider 的那一次往返）。
var geminiTierCache = struct {
	sync.Mutex
	entries map[string]geminiCachedTier
}{entries: map[string]geminiCachedTier{}}

type geminiCachedTier struct {
	at   time.Time
	tier *GeminiAccountTier
}

// GeminiAccountTier reads the account spec (ref requestAccountTier).
//
// ⚠️ 请求体是**逐字常量** geminiLoadAssistBd（对齐抓包，38 字节）—— 不要"顺手"
// 把 project 塞进去，原版抓包明确它不带。
// ⚠️ 任何失败都返回 nil（面板不渲染那一行），**不编造**、也不抛错：档位取不到
// 与「这个账号有问题」是两回事。
func (m *Manager) GeminiAccountTier(ctx context.Context, accountID string) (*GeminiAccountTier, error) {
	cred, err := m.geminiCredentialFor(accountID)
	if err != nil {
		return nil, err
	}
	if cred.AccessToken == "" {
		return nil, fmt.Errorf("%s", geminiUnauthorizedMessage)
	}
	now := time.Now()
	geminiTierCache.Lock()
	if cached, ok := geminiTierCache.entries[cred.AccessToken]; ok && now.Sub(cached.at) < geminiCreditsTTL {
		geminiTierCache.Unlock()
		return cached.tier, nil
	}
	geminiTierCache.Unlock()

	tier := m.geminiRequestAccountTier(ctx, cred)
	geminiTierCache.Lock()
	geminiTierCache.entries[cred.AccessToken] = geminiCachedTier{at: now, tier: tier}
	geminiTierCache.Unlock()
	return tier, nil
}

// geminiRequestAccountTier performs the loadCodeAssist call (best effort).
func (m *Manager) geminiRequestAccountTier(ctx context.Context, cred *GeminiCredential) *GeminiAccountTier {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		geminiEndpointSandbox+geminiLoadAssistP, strings.NewReader(geminiLoadAssistBd))
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range geminiIdentityHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient("gemini").Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if len(raw) == 0 {
		return nil
	}
	var payload any
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	return parseGeminiAccountTier(payload)
}
