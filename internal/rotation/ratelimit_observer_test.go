package rotation

import (
	"sync"
	"testing"
	"time"
)

// TestRateLimitObserverReceivesLocks: 每次写 key×model 锁都要通知观察者。
//
// 这条链路是 Free Hub 账号卡片「限额重置：<模型> · <解禁时刻>」的**唯一**数据
// 来源（观察者在组合根里映射到 jethub.Manager.UpdateModelRateLimit）。没有它，
// 卡片上那一行**永远是空的** —— 本端此前的真实状态就是如此（唯一写入方是备份
// 导入），用户报障「Zcode，DSH 里会显示限额重置的信息和准确时间，Tinylab 里不
// 会显示」。
//
// 覆盖四条写锁路径：固定时长冷却 / 日配额锁 / 余额锁 / NIM 阶梯。
// 反向验证：把 cooldown.go / nim.go 里的 `s.noteRateLimit(...)` 任一行删掉，
// 对应的子断言立刻变红。
func TestRateLimitObserverReceivesLocks(t *testing.T) {
	reg, sel := setupTest(t)

	type note struct {
		keyID   string
		modelID string
		untilMs int64
	}
	var (
		mu    sync.Mutex
		notes []note
	)
	sel.SetRateLimitObserver(func(keyID, modelID string, untilMs int64) {
		mu.Lock()
		notes = append(notes, note{keyID, modelID, untilMs})
		mu.Unlock()
	})

	take := func() []note {
		mu.Lock()
		defer mu.Unlock()
		out := notes
		notes = nil
		return out
	}

	// ① 固定时长冷却（proxy 的 429 / BillingLockError 都走这里）。
	unlock := sel.MarkRateLimited("test", "a", "gpt-4", 90*time.Second)
	got := take()
	if len(got) != 1 || got[0].keyID != "a" || got[0].modelID != "gpt-4" {
		t.Fatalf("MarkRateLimited must notify: %+v", got)
	}
	if got[0].untilMs != unlock.UnixMilli() {
		t.Fatalf("observer must get the SAME instant that was written: %d vs %d", got[0].untilMs, unlock.UnixMilli())
	}

	// ② 日配额锁（次日 CST 00:05）。
	quotaUnlock := sel.MarkDailyQuotaLocked("test", "a", "gpt-4", "429 daily quota")
	got = take()
	if len(got) != 1 || got[0].untilMs != quotaUnlock.UnixMilli() {
		t.Fatalf("MarkDailyQuotaLocked must notify: %+v (want %d)", got, quotaUnlock.UnixMilli())
	}

	// ③ 余额锁（402 insufficient balance）。
	balanceUnlock := sel.MarkBalanceLocked("test", "b", "gpt-4", "402 insufficient_balance_error")
	got = take()
	if len(got) != 1 || got[0].keyID != "b" || got[0].untilMs != balanceUnlock.UnixMilli() {
		t.Fatalf("MarkBalanceLocked must notify: %+v", got)
	}

	// ④ NIM 429 阶梯。
	nimUnlock := sel.MarkNIM429("test", "a", "nim-model")
	got = take()
	if len(got) != 1 || got[0].modelID != "nim-model" || got[0].untilMs != nimUnlock.UnixMilli() {
		t.Fatalf("MarkNIM429 must notify: %+v (want %d)", got, nimUnlock.UnixMilli())
	}

	// 未安装观察者时必须**安全 no-op**（默认构建里 jethub 可能不可用）。
	sel.SetRateLimitObserver(nil)
	sel.MarkRateLimited("test", "a", "gpt-4", time.Second)
	if got := take(); len(got) != 0 {
		t.Fatalf("a cleared observer must not be called: %+v", got)
	}

	// 未知 key 不产生通知（state 拿不到 ⇒ 没有锁可写）。
	sel.SetRateLimitObserver(func(string, string, int64) {
		t.Error("observer must not fire when no lock was written")
	})
	if unlock := sel.MarkRateLimited("test", "nope", "gpt-4", time.Second); !unlock.IsZero() {
		t.Fatalf("unknown key must not produce a lock: %v", unlock)
	}
	_ = reg
}
