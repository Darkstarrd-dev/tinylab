package proxy

import (
	"context"
	"sync"
	"time"
)

const defaultHLWindow = time.Minute

type hlEvent struct {
	reqID  string
	at     time.Time // 计划/实际发送时刻（now+wait）
	tokens int       // 预留估值；完成后 Reconcile 替换为实际值
}

type hlWindow struct {
	mu     sync.Mutex
	events []hlEvent
	sum    int // 窗口内 token 估值/实际值之和
}

// cleanExpired 淘汰窗口内已过期的事件，并同步扣减 sum。必须在持有 w.mu 锁时调用。
func (w *hlWindow) cleanExpired(now time.Time, windowDur time.Duration) {
	cutoff := now.Add(-windowDur)
	i := 0
	for i < len(w.events) && !w.events[i].at.After(cutoff) {
		w.sum -= w.events[i].tokens
		i++
	}
	if i > 0 {
		w.events = w.events[i:]
		if w.sum < 0 {
			w.sum = 0
		}
	}
}

// computeWait 计算满足 RPM 与 TPM 限制所需的等待时间。必须在持有 w.mu 锁且已 cleanExpired 后调用。
func (w *hlWindow) computeWait(now time.Time, windowDur time.Duration, rpm, tpm, estTokens int) time.Duration {
	var rpmWait time.Duration
	if rpm > 0 && len(w.events) >= rpm {
		idx := len(w.events) - rpm
		exp := w.events[idx].at.Add(windowDur)
		if exp.After(now) {
			rpmWait = exp.Sub(now)
		}
	}

	var tpmWait time.Duration
	if tpm > 0 {
		overflow := w.sum + estTokens - tpm
		if overflow > 0 {
			freed := 0
			for _, e := range w.events {
				freed += e.tokens
				if freed >= overflow {
					exp := e.at.Add(windowDur)
					if exp.After(now) {
						tpmWait = exp.Sub(now)
					}
					break
				}
			}
			if freed < overflow && len(w.events) > 0 {
				lastExp := w.events[len(w.events)-1].at.Add(windowDur)
				if lastExp.After(now) {
					tpmWait = lastExp.Sub(now)
				}
			}
		}
	}

	if rpmWait > tpmWait {
		return rpmWait
	}
	return tpmWait
}

// HardLimiter 提供 provider 级别的滑动 60s 窗口请求数（RPM）与 Token 数（TPM）节流引擎。
type HardLimiter struct {
	mu      sync.Mutex
	windows map[string]*hlWindow // key: provider ID
	window  time.Duration        // 默认 defaultHLWindow；测试可注入短窗口
}

func (l *HardLimiter) getWindow(providerID string) *hlWindow {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.windows[providerID]
	if !ok {
		w = &hlWindow{}
		l.windows[providerID] = w
	}
	return w
}

// WaitAndReserve 计算维持两个限制所需的等待时间，在 context 保护下等待，并在发送时插入一条预留事件。
// 成功返回 true；若 ctx 取消则返回 false（不插入预留事件）。
func (l *HardLimiter) WaitAndReserve(ctx context.Context, providerID, reqID string, rpm, tpm, estTokens int) bool {
	if rpm <= 0 && tpm <= 0 {
		return true
	}
	if estTokens < 0 {
		estTokens = 0
	}

	w := l.getWindow(providerID)
	w.mu.Lock()
	defer w.mu.Unlock()

	windowDur := l.window
	if windowDur <= 0 {
		windowDur = defaultHLWindow
	}

	now := time.Now()
	w.cleanExpired(now, windowDur)

	wait := w.computeWait(now, windowDur, rpm, tpm, estTokens)
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()

		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
		}
	}

	now = time.Now()
	w.cleanExpired(now, windowDur)
	w.events = append(w.events, hlEvent{
		reqID:  reqID,
		at:     now,
		tokens: estTokens,
	})
	w.sum += estTokens

	return true
}

// Reconcile 用实际返回的 tokens（inputTokens+outputTokens）替换指定 reqID 最近一条未过期事件的估值，并调整窗口 sum。
func (l *HardLimiter) Reconcile(providerID, reqID string, actualTokens int) {
	if actualTokens < 0 {
		actualTokens = 0
	}
	w := l.getWindow(providerID)
	w.mu.Lock()
	defer w.mu.Unlock()

	windowDur := l.window
	if windowDur <= 0 {
		windowDur = defaultHLWindow
	}

	now := time.Now()
	w.cleanExpired(now, windowDur)

	for i := len(w.events) - 1; i >= 0; i-- {
		if w.events[i].reqID == reqID {
			delta := actualTokens - w.events[i].tokens
			w.events[i].tokens = actualTokens
			w.sum += delta
			if w.sum < 0 {
				w.sum = 0
			}
			break
		}
	}
}

// NewHardLimiter 构造 HardLimiter 实例。
func NewHardLimiter() *HardLimiter {
	return &HardLimiter{
		windows: make(map[string]*hlWindow),
		window:  defaultHLWindow,
	}
}
