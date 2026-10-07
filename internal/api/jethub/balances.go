package jethub

// 渠道级余额合计端点（Monitor 页 QuotaMonitor 的「Provider · 余额」读数）。
//
//	GET /api/jethub/balances
//
// 与逐账号的 `/jethub/{provider}/balance` 的分工：
//   - 逐账号端点服务 Free Hub 面板（每张账号卡一个数字，含分桶明细）；
//   - 本端点服务**别的页面**（Monitor）：一次拿全部渠道的**渠道级合计**，
//     免得 Monitor 为 13 个渠道 × N 个账号发几十个请求。
//
// 聚合口径（单位归一 / 失败账号不进合计 / `%` 与「通道」不可累加）与 TTL 缓存
// 全在 internal/jethub/balance_summary.go 里，本文件只做「列渠道 + 序列化」。

import (
	"context"
	"net/http"
	"time"

	"github.com/tinylab/tinylab/internal/api/apibase"
	corejethub "github.com/tinylab/tinylab/internal/jethub"
)

// balanceSummaryTimeout caps one aggregate round. 一轮要顺序打十几个上游
// （每渠道 N 个账号），没有上限时一个卡住的上游会把整个请求挂在浏览器里；
// 超时后本轮按失败缓存（15s），下一次轮询即恢复。
const balanceSummaryTimeout = 30 * time.Second

// providerBalances GET — 每个渠道的归一单位余额合计（Monitor 用）。
//
// 响应形状：`{"balances":{"zcode":{"groups":[{"unit":"token","total":30095000}],
// "okCount":2,"failedCount":0}}}`。
//
// 两条跳过规则（都**不发上游请求**）：
//   - `!HasBalance`：该渠道没有余额能力（能力位是唯一门控，见 manager.go）；
//   - `Groups` 为空的渠道（全部账号读取失败 / opencode 的「通道」不可累加 /
//     账号全停用）：没有数字可显示，前端据此留空。
//
// ⚠️ **不可累加单位不需要在这里列名**：聚合层按包单位过滤
// （internal/jethub/balance_summary.go 的 normalizedBalanceUnit —— `%` 与「通道」
// 一律不进合计）。R5 之前这里另有一张 `nonAggregatableProviders` 表，唯一用途是
// 为 gemini 的配额百分比窗口省掉一次必然被丢弃的请求；该渠道删除后表已移除。
func (h *Handler) providerBalances(w http.ResponseWriter, r *http.Request) {
	out := map[string]*corejethub.BalanceSummary{}
	if h.d.Manager != nil {
		ctx, cancel := context.WithTimeout(r.Context(), balanceSummaryTimeout)
		defer cancel()
		for _, meta := range corejethub.Providers() {
			if !meta.HasBalance {
				continue
			}
			sum, err := h.d.Manager.BalanceSummaryOf(ctx, meta.ID)
			if err != nil || sum == nil || len(sum.Groups) == 0 {
				continue
			}
			out[meta.ID] = sum
		}
	}
	apibase.WriteJSON(w, http.StatusOK, map[string]any{"balances": out})
}
