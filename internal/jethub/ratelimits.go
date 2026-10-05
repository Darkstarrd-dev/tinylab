package jethub

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// 限流标记的批量操作（对应原版 account.retest / account.retestAll /
// account.reset / account.resetAll）。

// RetestStillLimited is one model that answered with an error during a retest
// (its marker is kept — the reset window has not actually lifted).
type RetestStillLimited struct {
	ModelID string `json:"modelId"`
	Message string `json:"message"`
}

// RetestAccountResult is the per-account retest outcome.
type RetestAccountResult struct {
	AccountID    string               `json:"accountId"`
	Nickname     string               `json:"nickname,omitempty"`
	StillLimited []RetestStillLimited `json:"stillLimited,omitempty"`
}

// RetestResult aggregates a retest/reset run.
type RetestResult struct {
	ClearedCount int                   `json:"clearedCount"`
	Accounts     []RetestAccountResult `json:"accounts,omitempty"`
	Skipped      []string              `json:"skipped,omitempty"`
}

// ResetRateLimits clears markers without any network traffic (accountID "" =
// every account of the provider). Pure display cleanup, per the original
// RESET_HELP: 「直接清除……标记，不发送任何请求」.
func (b *Bridge) ResetRateLimits(provider, accountID string) (*RetestResult, error) {
	cleared, err := b.m.ClearModelRateLimits(provider, accountID)
	if err != nil {
		return nil, err
	}
	return &RetestResult{ClearedCount: cleared}, nil
}

// RetestRateLimits probes every marked (account, model) pair with one minimal
// real message (accountID "" = all accounts, disabled ones included — the
// original does the same). Success clears the marker; failure keeps it and
// the message is reported back for the UI's details list.
func (b *Bridge) RetestRateLimits(ctx context.Context, provider, accountID string) (*RetestResult, error) {
	if !ProviderExists(provider) {
		return nil, fmt.Errorf("jethub: unknown provider %q", provider)
	}
	res := &RetestResult{}
	for _, acc := range b.m.Accounts(provider) {		if accountID != "" && acc.ID != accountID {
			continue
		}
		if len(acc.ModelRateLimits) == 0 {
			continue
		}
		// Snapshot the ids: clearing during iteration must not reshape the
		// loop's source map.
		modelIDs := make([]string, 0, len(acc.ModelRateLimits))
		for modelID := range acc.ModelRateLimits {
			if isBookkeepingRateLimitKey(modelID) {
				continue
			}
			modelIDs = append(modelIDs, modelID)
		}
		if len(modelIDs) == 0 {
			continue
		}
		out := RetestAccountResult{AccountID: acc.ID, Nickname: acc.Nickname}
		for _, modelID := range modelIDs {
			probeErr := b.ProbeAccountModel(ctx, provider, acc.ID, modelID)
			if probeErr == nil {
				_ = b.m.ClearAccountModelRateLimit(acc.ID, modelID)
				res.ClearedCount++
				continue
			}
			// ⚠️ 仍然受限时要把上游给的**新**解禁时刻写回去（ref ProbeModelResult.
			// resetTimeMs）：限流是**滚动窗口**，每次撞到都会把解禁时刻往后推；
			// 只报「仍受限」而不更新，存储里会一直留着第一次的旧时刻 —— 旧时刻一
			// 过期，卡片就按「只显示未来的标记」把它藏起来，于是出现「重测弹窗说
			// 仍受限、账号卡片却一条都不显示」的矛盾，选号也会误以为该账号可用。
			//
			// 解析不出来（上游没给时间）就保持原值不动 —— 宁可不更新，也不猜。
			if resetAt := parseRateLimitResetTime(probeErr.Error()); resetAt > 0 {
				_ = b.m.UpdateModelRateLimit(acc.ID, modelID, resetAt)
			}
			out.StillLimited = append(out.StillLimited, RetestStillLimited{ModelID: modelID, Message: probeErr.Error()})
		}
		if len(out.StillLimited) > 0 {
			res.Accounts = append(res.Accounts, out)
		}
	}
	return res, nil
}

// rateLimitResetRe 匹配限流文案里的解禁时刻（ref llm-adapter.ts 的
// RESET_TIME_PATTERN，逐字移植）。
//
// 两种句式都被实测过，**缺一不可**：
//   - 中文（CodeBuddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
//   - 英文（WorkBuddy 国际版）："… your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, …"
//
// 早期只列中文句式，导致国际版即使判定为限流也只能走兜底时长，丢掉服务端给出
// 的真实时刻。
// ⚠️ 时区是**捕获**出来的（`UTC±N`），不是写死 UTC+8：写死会在非 UTC+8 的服务端
// 账期上算出差几小时的解禁时刻。
var rateLimitResetRe = regexp.MustCompile(
	`(?:将在|reset at)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s+(UTC([+-])(\d{1,2})(?::(\d{2}))?)`)

// parseRateLimitResetTime extracts the reset instant from a rate-limit message
// (epoch ms; 0 = 文案里没有可解析的时刻).
//
// ⚠️ 只认**明确带时区**的写法：裸时间（没有 `UTC±N`）在不同服务端语义不同，
// 猜错会让用户按错误的时刻等待 —— 返回 0 让调用方保持原值，比猜一个更安全。
func parseRateLimitResetTime(message string) int64 {
	m := rateLimitResetRe.FindStringSubmatch(message)
	if m == nil {
		return 0
	}
	// 墙钟时间按 UTC 解析，再减去声明的偏移 ⇒ 真实瞬间。
	var wall time.Time
	var err error
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if wall, err = time.ParseInLocation(layout, m[1], time.UTC); err == nil {
			break
		}
	}
	if err != nil {
		return 0
	}
	hours, convErr := strconv.Atoi(m[4])
	if convErr != nil {
		return 0
	}
	minutes := 0
	if m[5] != "" {
		minutes, convErr = strconv.Atoi(m[5])
		if convErr != nil {
			return 0
		}
	}
	offset := time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute
	if m[3] == "-" {
		offset = -offset
	}
	return wall.Add(-offset).UnixMilli()
}
