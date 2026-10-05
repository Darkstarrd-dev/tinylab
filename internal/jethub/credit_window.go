package jethub

import (
	"os"
	"strconv"
	"strings"
)

// buddyExpiringWindowDefaultDays 是「临时积分」窗口的默认天数。
//
// 语义（ref src/buddy-balance-rank.ts 的 BUDDY_EXPIRING_WINDOW_DAYS）：距
// **扣费截止**（DeductionEndTime）不足该天数的资源包算「临时」（再不用就作废，
// 会被优先消耗），其余算「长期」。
//
// ⚠️ 必须与前端渲染用同一个值：面板由后端回传的 `windowDays` 决定分桶，前端
// **不得**写死 15 —— 那会出现「提示说只烧 15 天内的、实际按别的窗口筛号」。
const buddyExpiringWindowDefaultDays = 15

// buddyExpiringWindowEnv 覆盖窗口天数的环境变量（ref
// DSH_BUDDY_EXPIRING_WINDOW_DAYS）。
const buddyExpiringWindowEnv = "DSH_BUDDY_EXPIRING_WINDOW_DAYS"

// ExpiringWindowDays returns the effective 「临时积分」 window in days.
//
// 供 API 层回传给面板（ref RpcCreditsBalancesResponse.windowDays）：面板据此把
// 资源包分成「长期 / 临时」两桶，**必须由后端给出** —— 前端写死 15 会在窗口被
// DSH_BUDDY_EXPIRING_WINDOW_DAYS 覆盖时与真实判据分叉（表现为「提示说只烧 15 天
// 内的、实际按别的窗口算」）。
func ExpiringWindowDays() int { return buddyExpiringWindowDays() }

// buddyExpiringWindowDays 返回**当前生效**的临时积分窗口（天）。
//
// ⚠️ 本端目前只用它做**展示分桶**：`PermanentLocks` 只落了 provider 级开关的
// 持久化，选号侧的「只烧临时积分」语义尚未移植（见 docs/jethub-architecture.md
// §3.1 与上游同步文档 R1-9）。因此这里如实回传用于面板，**不要**据此声称选号
// 已按该窗口筛号。
func buddyExpiringWindowDays() int {
	raw := strings.TrimSpace(os.Getenv(buddyExpiringWindowEnv))
	if raw == "" {
		return buddyExpiringWindowDefaultDays
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 0 {
		// 非法值（非数字 / 负数）回落默认；`0` 是**合法值**（表示没有临时积分
		// 一档），不能用 `||` 静默换成默认值。
		return buddyExpiringWindowDefaultDays
	}
	return parsed
}
