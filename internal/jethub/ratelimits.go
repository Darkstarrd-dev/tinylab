package jethub

import (
	"context"
	"fmt"
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
	ClearedCount int                    `json:"clearedCount"`
	Accounts     []RetestAccountResult  `json:"accounts,omitempty"`
	Skipped      []string               `json:"skipped,omitempty"`
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
	for _, acc := range b.m.Accounts(provider) {
		if accountID != "" && acc.ID != accountID {
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
			out.StillLimited = append(out.StillLimited, RetestStillLimited{ModelID: modelID, Message: probeErr.Error()})
		}
		if len(out.StillLimited) > 0 {
			res.Accounts = append(res.Accounts, out)
		}
	}
	return res, nil
}
