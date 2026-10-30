package jethub

// ZCode 出站节流：按 (账号, 模型) 的最小请求间隔（ref zcode-product.ts 的
// modelGapMs + serializeUpstream）。
//
// ## 为什么必须有（2026-10-25，Gitee IKQ4B4「并发开多就全废」）
//
// 上游的并发配额按「模型 + 账号」计量（不是按 session）。`glm-5.3-flash`
// 原先配 0ms，依据是串行单发下的「605 次 0 限流」；一旦开并发（多个 subagent），
// gap=0 只保证「不重叠」、不保证间隔 ⇒ N 个请求首尾相接密集连发 ⇒ 撞
// `429 + 3009` ⇒ 适配器退避重试放大请求数 ⇒ 触发风控 405。
//
// ⚠️ gap 不是「加速节流」，而是**秒回时的下限保护**：正常 1–3s 的响应天然
// 铺开，看不出差别；429/405 都是秒回形态，gap 的价值正在那里。
//
// ⚠️ 不要用「每请求换 x-session-id」规避限流：session id 按 device_mid 派生，
// 每请求换新反而造出「同一账号多个会话」的异常信号（ref 已排除该假设）。

import (
	"context"
	"strings"
	"sync"
	"time"
)

// zcodeModelGaps is the per-model minimum interval (ref modelGapMs).
// Var so tests can shrink it; production values are the measured ones.
var zcodeModelGaps = map[string]time.Duration{
	"glm-5.3":       350 * time.Millisecond,
	"glm-5.3-flash": 500 * time.Millisecond,
}

// zcodeModelGap returns the configured gap for a model (case-insensitive).
// Unknown models get 0 (no evidence ⇒ no artificial slowness).
func zcodeModelGap(model string) time.Duration {
	return zcodeModelGaps[strings.ToLower(strings.TrimSpace(model))]
}

// zcodeGateState serializes sends of one (account, model) pair.
type zcodeGateState struct {
	mu   sync.Mutex
	last time.Time
}

var zcodeGates = struct {
	sync.Mutex
	m map[string]*zcodeGateState
}{m: map[string]*zcodeGateState{}}

func zcodeGateFor(keyID, model string) *zcodeGateState {
	key := keyID + "|" + strings.ToLower(model)
	zcodeGates.Lock()
	defer zcodeGates.Unlock()
	state := zcodeGates.m[key]
	if state == nil {
		state = &zcodeGateState{}
		zcodeGates.m[key] = state
	}
	return state
}

// zcodeWaitModelGap blocks until the next send for (account, model) may start.
// It honors request cancellation so an aborted request does not hold the gate.
func zcodeWaitModelGap(ctx context.Context, keyID, model string) {
	gap := zcodeModelGap(model)
	if gap <= 0 {
		return
	}
	state := zcodeGateFor(keyID, model)
	state.mu.Lock()
	defer state.mu.Unlock()
	if wait := time.Until(state.last.Add(gap)); wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
	state.last = time.Now()
}
