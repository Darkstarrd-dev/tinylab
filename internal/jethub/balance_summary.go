package jethub

// Provider 级余额聚合（Monitor 页 QuotaMonitor 的「Provider · 余额」读数）。
//
// 对齐 ref deepseek-harness-codearts 用量徽标的口径（plugin-src/client/badge-model.js
// 的 creditGroupsOf / credits-format.js 的 normalizeUnit）：
//
//   - 逐账号查询 → 按归一单位分组求和：只有读到数的账号进合计，读取失败的
//     记 failedCount、**不画成 0**（0 会被读成「额度用光」）；
//   - 单位归一：`token` 一类、`credit`/`credits`/空串/「积分」归一类；
//     **不跨量纲求和**（ZCode 是 token、其余是积分，不可折算）；
//   - `%`（gemini 的配额窗口）**不参与聚合**：窗口是并行百分比，求和没有语义
//     （两个账号各 50% 加起来是 100%？）—— 该渠道整体不进汇总，Monitor 不显示；
//   - opencode 的「通道可用性」（unit=「通道」）同样不是可累加的余额，不进汇总。
//
// ## 为什么必须带 TTL 缓存
//
// Monitor 页的 quota 数据 5 秒轮询一次（refreshQuotaData）。余额若跟着这趟车，
// 每 5s 就会向 13 个渠道的上游各打一轮逐账号请求 —— ref 徽标刻意做了两层节流
// （前端 60s 轮询 + 宿主 120s TTL），本端等价实现：后端缓存成功读数 120s、
// 全失败 15s（失败短 TTL：首次读数失败后能较快重试，而不是卡两个钟）。
//
// ⚠️ 缓存是**整 provider 级**的（不是逐账号）：汇总读数只需要一个答案
// 「这个渠道一共还能用多少」，逐账号明细是 Free Hub 面板的事。

import (
	"context"
	"sync"
	"time"
)

// balanceTTLSuccess / balanceTTLFailure 是汇总读数的缓存寿命（ref 徽标宿主侧
// 同款两档：成功 120s，全部失败 15s）。导出为变量仅供测试改短。
var (
	balanceTTLSuccess = 120 * time.Second
	balanceTTLFailure = 15 * time.Second
)

// BalanceGroup is one normalized-unit subtotal of a provider's balances.
type BalanceGroup struct {
	// Unit is the NORMALIZED unit: "token" or "credit"（与 ref normalizeUnit
	// 的两类展示口径一一对应；`%`/「通道」不进聚合，故不出现在这里）。
	Unit string `json:"unit"`
	// Total is the sum over accounts whose balance was read successfully.
	Total float64 `json:"total"`
}

// BalanceSummary is the provider-level aggregate the Monitor page renders.
type BalanceSummary struct {
	Groups []BalanceGroup `json:"groups"`
	// OKCount is the number of accounts whose balance was read successfully.
	OKCount int `json:"okCount"`
	// FailedCount counts accounts that hold a credential but whose query
	// failed. ⚠️ 它们**不进合计**（少报是显式的，不是伪装成 0）。
	FailedCount int `json:"failedCount"`
}

// balanceCacheEntry is one cached provider summary.
type balanceCacheEntry struct {
	at     time.Time
	failed bool
	sum    *BalanceSummary
}

// balanceSummaries caches per-provider aggregates (guarded by balanceMu).
var (
	balanceMu      sync.Mutex
	balanceSummary = map[string]balanceCacheEntry{}
)

// InvalidateBalanceSummary drops the cached aggregate for one provider (called
// after account/credential changes that alter which accounts are summed;
// empty provider = all providers).
//
// ⚠️ 锁序：本函数只取 balanceMu，且**在 `m.mu` 之外**调用（见 manager.go 的
// AddAccount / SetCredential / DeleteAccount）。全包内都不得「持 balanceMu 调
// 管理方法」或反向嵌套 —— BalanceSummaryOf 也从不这么做（它在两段 balanceMu
// 临界区之间才去调 m.Accounts / 各渠道余额实现）。
func InvalidateBalanceSummary(provider string) {
	balanceMu.Lock()
	defer balanceMu.Unlock()
	if provider == "" {
		balanceSummary = map[string]balanceCacheEntry{}
		return
	}
	delete(balanceSummary, provider)
}

// BalanceSummaryOf aggregates every ENABLED, credentialed account's balance for
// one provider into normalized-unit groups, with a TTL cache (success 120s /
// all-failed 15s).
//
// 返回的 error **只有一种**：该 provider 压根没有账号（未桥接）—— 那种情况下
// 端点应当整体略过它，而不是回一个空读数。**逐账号读取失败不是 error**：它是
// 读数的一部分（`FailedCount`），因为「三个号里坏了一个」与「这个渠道没配」
// 对界面是两件事，前者仍要显示另外两个号的合计。
//
// ⚠️ 有凭据才查：无凭据的账号（登录中断/已失效清理）既不进 ok 也不进 failed
// —— 它不是「读数失败」，是「没有可查的东西」。
func (m *Manager) BalanceSummaryOf(ctx context.Context, provider string) (*BalanceSummary, error) {
	balanceMu.Lock()
	cached, ok := balanceSummary[provider]
	balanceMu.Unlock()
	if ok {
		ttl := balanceTTLSuccess
		if cached.failed {
			ttl = balanceTTLFailure
		}
		if time.Since(cached.at) < ttl {
			return cached.sum, nil
		}
	}

	sum, err := m.balanceSummaryFresh(ctx, provider)
	if err != nil {
		return nil, err // 无账号/未知渠道：不缓存（用户可能刚建好账号，要立刻看到）
	}
	// 「一个能查的账号都没有」（全部停用/无凭据）**不缓存**：这不是读数，是
	// 「还没配好」。缓存它会让刚登录成功的账号在 120s 内仍然不显示余额 ——
	// 登录流程正是「先落账号、后落凭据」，这条路径**每次都会经过**。
	if sum.OKCount == 0 && sum.FailedCount == 0 {
		return sum, nil
	}
	// 「全部失败」才走短 TTL：只要有**一个**账号读到数，这个合计就是可信的
	// 读数，没必要 15 秒后重打一整轮上游。
	failed := sum.OKCount == 0 && sum.FailedCount > 0
	balanceMu.Lock()
	balanceSummary[provider] = balanceCacheEntry{at: time.Now(), failed: failed, sum: sum}
	balanceMu.Unlock()
	return sum, nil
}

// balanceSummaryFresh is the uncached aggregation path.
func (m *Manager) balanceSummaryFresh(ctx context.Context, provider string) (*BalanceSummary, error) {
	accounts := m.Accounts(provider)
	if len(accounts) == 0 {
		return nil, errAccountNotFound(provider)
	}
	sum := &BalanceSummary{Groups: []BalanceGroup{}}
	// 按归一单位分桶求和（token / credit 两类；`%` 与「通道」跳过）。
	totals := map[string]float64{}
	unitOrder := []string{}
	for _, acc := range accounts {
		// 停用账号不参与（与 ref 徽标「仅启用账号」同口径）；无凭据的账号
		// 连查都不查（查必然失败，把它计进 FailedCount 会误导成「读数故障」）。
		if !acc.Enabled || !acc.HasCredential {
			continue
		}
		balance, err := m.balanceForAccount(ctx, provider, acc.ID)
		if err != nil {
			sum.FailedCount++
			continue
		}
		sum.OKCount++
		unit, ok := normalizedBalanceUnit(balance)
		if !ok {
			continue // gemini 的 % / opencode 的「通道」：不可累加，跳过
		}
		if _, seen := totals[unit]; !seen {
			unitOrder = append(unitOrder, unit)
		}
		totals[unit] += balance.Total
	}
	for _, unit := range unitOrder {
		sum.Groups = append(sum.Groups, BalanceGroup{Unit: unit, Total: roundCredits(totals[unit])})
	}
	return sum, nil
}

// balanceForAccount dispatches to the per-provider balance implementation.
//
// ⚠️ 单点分发（ref qoderFamily 注册表同思路）：签名差异（cline 多返 raw、
// opencode 多返 notice）在这里收敛为统一形状 —— 新增 provider 时加一个 case，
// 不要在调用方写平行分支。
func (m *Manager) balanceForAccount(ctx context.Context, provider, accountID string) (*CreditBalance, error) {
	switch provider {
	case "codearts":
		return m.CodeArtsBalance(ctx, accountID)
	case "buddy", "workbuddy":
		return m.BuddyBalance(ctx, provider, accountID)
	case "lobsterai":
		return m.LobsteraiBalance(ctx, accountID)
	case "qoder", "qodercn":
		return m.QoderBalance(ctx, provider, accountID)
	case "trae":
		return m.TraeBalance(ctx, accountID)
	case "cline":
		balance, _, err := m.ClineBalance(ctx, accountID)
		return balance, err
	case "loomy":
		return m.LoomyCreditBalance(ctx, accountID)
	case "raccoon":
		return m.RaccoonBalance(ctx, accountID)
	case "minimax":
		return m.MinimaxBalance(ctx, accountID)
	case "zcode":
		balance, err := m.ZcodeBalance(ctx, accountID)
		if err != nil {
			return nil, err
		}
		return zcodeBalanceToCredit(balance), nil
	case "opencode":
		balance, _, err := m.OpencodeChannelBalance(accountID)
		return balance, err
	default:
		return nil, errAccountNotFound(provider)
	}
}

// zcodeBalanceToCredit converts the zcode bucket result into the unified
// CreditBalance（API 层 zcodeBalance 的同款映射，抽出来供聚合复用；
// ⚠️ expires_at 秒级必须 ×1000，见 zcode.go 的原始注释）。
func zcodeBalanceToCredit(balance *zcodeBalanceResult) *CreditBalance {
	out := &CreditBalance{Total: balance.Remaining}
	for _, bucket := range balance.Buckets {
		remaining := bucket.RemainingUnits
		if bucket.HasAvailable {
			remaining = bucket.AvailableUnits
		}
		pkg := CreditPackage{
			Name:      bucket.ShowName,
			Unit:      bucket.UnitType,
			Remaining: remaining,
			Total:     bucket.TotalUnits,
			Used:      bucket.UsedUnits,
			Active:    remaining > 0,
		}
		if bucket.ExpiresAt > 0 {
			pkg.DeductionEndTime = bucket.ExpiresAt * 1000
		}
		out.Packages = append(out.Packages, pkg)
	}
	return out
}

// normalizedBalanceUnit picks the aggregate unit of one balance and reports
// whether it is summable at all.
//
// ⚠️ 判据与 ref credits-format.js 的 normalizeUnit 逐字等价（展示口径只有两类），
// 且 **`%` 与非余额单位（「通道」）先被排除**：把百分比塞进积分桶求和是语义错误
// （ref badge-model.js 的 QUOTA_UNIT 特判同因）。单位取**首个有效包**的声明
// （同一 provider 的包单位一致；混合单位以第一个为准，避免标签闪烁）。
// Total<=0 且无包（gemini 空窗口 / zcode 企业版）⇒ 不可聚合，跳过。
func normalizedBalanceUnit(balance *CreditBalance) (string, bool) {
	if balance == nil {
		return "", false
	}
	for _, pkg := range balance.Packages {
		switch pkg.Unit {
		case "token":
			return "token", true
		case "%", "通道":
			return "", false
		case "", "credit", "credits", "积分":
			return "credit", true
		}
	}
	// 无包：minimax 只回 Total（包列表恒空）。有数字就按积分聚合。
	if balance.Total > 0 || balance.IsCredit {
		return "credit", true
	}
	return "", false
}

// roundCredits normalizes to two decimals — the shared implementation lives
// in buddy_credits.go and is reused here as the package-wide single definition.
