package proxy

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestHardLimiter_SporadicNoWait(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 100 * time.Millisecond
	ctx := context.Background()

	// 第一次调用，无需等待
	start := time.Now()
	ok := hl.WaitAndReserve(ctx, "p1", "req1", 5, 0, 0)
	if !ok {
		t.Fatalf("expected true, got false")
	}
	if d := time.Since(start); d > 50*time.Millisecond {
		t.Fatalf("expected immediate return, took %v", d)
	}

	// 等待窗口过期
	time.Sleep(120 * time.Millisecond)

	// 第二次调用，窗口已重置，依然无需等待
	start = time.Now()
	ok = hl.WaitAndReserve(ctx, "p1", "req2", 5, 0, 0)
	if !ok {
		t.Fatalf("expected true, got false")
	}
	if d := time.Since(start); d > 50*time.Millisecond {
		t.Fatalf("expected immediate return, took %v", d)
	}
}

func TestHardLimiter_RPMThrottle(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 200 * time.Millisecond
	ctx := context.Background()

	// rpm=2，前两次应立即返回
	if !hl.WaitAndReserve(ctx, "p1", "r1", 2, 0, 0) {
		t.Fatal("r1 failed")
	}
	if !hl.WaitAndReserve(ctx, "p1", "r2", 2, 0, 0) {
		t.Fatal("r2 failed")
	}

	// 第 3 次应当等待约 200ms
	start := time.Now()
	if !hl.WaitAndReserve(ctx, "p1", "r3", 2, 0, 0) {
		t.Fatal("r3 failed")
	}
	elapsed := time.Since(start)
	if elapsed < 150*time.Millisecond || elapsed > 350*time.Millisecond {
		t.Fatalf("expected wait ~200ms, got %v", elapsed)
	}
}

func TestHardLimiter_TPMThrottleAndReconcile(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 200 * time.Millisecond
	ctx := context.Background()

	// tpm=100, est=60. 第一次 60 tokens, 无需等待
	if !hl.WaitAndReserve(ctx, "p1", "r1", 0, 100, 60) {
		t.Fatal("r1 failed")
	}

	// 第二次 60 tokens, 60+60=120 > 100, 需要等待 r1 过期 (约 200ms)
	start := time.Now()
	if !hl.WaitAndReserve(ctx, "p1", "r2", 0, 100, 60) {
		t.Fatal("r2 failed")
	}
	elapsed := time.Since(start)
	if elapsed < 150*time.Millisecond {
		t.Fatalf("expected wait > 150ms, got %v", elapsed)
	}

	// 此时 r1 已经过期（因为等了 >= 150ms，且 r1 是在 200ms 前插入的），
	// 窗口内仅剩 r2 (est 60)。
	// 对 r2 Reconcile 为 10 tokens，窗口总和变为 10 tokens。
	hl.Reconcile("p1", "r2", 10)

	// 第三次 est=60, 10 + 60 = 70 <= 100, 应立即返回
	start = time.Now()
	if !hl.WaitAndReserve(ctx, "p1", "r3", 0, 100, 60) {
		t.Fatal("r3 failed")
	}
	if d := time.Since(start); d > 50*time.Millisecond {
		t.Fatalf("expected immediate return after reconcile, took %v", d)
	}
}

func TestHardLimiter_RPMAndTPMMaxWait(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 200 * time.Millisecond
	ctx := context.Background()

	// 构造情况 1：RPM 限制不超，但 TPM 超（TPM 等待 > RPM 等待 0）
	// rpm=5, tpm=100
	if !hl.WaitAndReserve(ctx, "p1", "r1", 5, 100, 80) {
		t.Fatal("r1 failed")
	}
	start := time.Now()
	// len(events)=1 < 5 (RPM wait=0), 但 80+80=160 > 100 (TPM wait ~200ms)
	if !hl.WaitAndReserve(ctx, "p1", "r2", 5, 100, 80) {
		t.Fatal("r2 failed")
	}
	if elapsed := time.Since(start); elapsed < 150*time.Millisecond {
		t.Fatalf("expected TPM wait ~200ms, got %v", elapsed)
	}

	// 构造情况 2：TPM 不超，但 RPM 超（RPM 等待 > TPM 等待 0）
	hl2 := NewHardLimiter()
	hl2.window = 200 * time.Millisecond
	// rpm=2, tpm=10000
	if !hl2.WaitAndReserve(ctx, "p2", "r1", 2, 10000, 10) {
		t.Fatal("r1 failed")
	}
	if !hl2.WaitAndReserve(ctx, "p2", "r2", 2, 10000, 10) {
		t.Fatal("r2 failed")
	}
	start = time.Now()
	// len(events)=2 >= 2 (RPM wait ~200ms), 20+10=30 < 10000 (TPM wait=0)
	if !hl2.WaitAndReserve(ctx, "p2", "r3", 2, 10000, 10) {
		t.Fatal("r3 failed")
	}
	if elapsed := time.Since(start); elapsed < 150*time.Millisecond {
		t.Fatalf("expected RPM wait ~200ms, got %v", elapsed)
	}
}

func TestHardLimiter_Cancel(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 1 * time.Second
	ctx := context.Background()

	// 占满窗口
	if !hl.WaitAndReserve(ctx, "p1", "r1", 1, 0, 0) {
		t.Fatal("r1 failed")
	}

	// 准备触发长等待，并提前取消 ctx
	ctxCancel, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	ok := hl.WaitAndReserve(ctxCancel, "p1", "r2", 1, 0, 0)
	if ok {
		t.Fatal("expected false on canceled context")
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("expected fast exit on cancel, took %v", elapsed)
	}

	// 验证未被成功预留的 r2 没有污染窗口
	w := hl.getWindow("p1")
	w.mu.Lock()
	if len(w.events) != 1 {
		t.Fatalf("expected 1 event in window, got %d", len(w.events))
	}
	w.mu.Unlock()
}

func TestHardLimiter_Concurrent(t *testing.T) {
	hl := NewHardLimiter()
	hl.window = 300 * time.Millisecond
	ctx := context.Background()

	const workers = 8
	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func(id int) {
			defer wg.Done()
			reqID := "req"
			// rpm=100, 保证都能进入
			ok := hl.WaitAndReserve(ctx, "p1", reqID, 100, 0, 10)
			if !ok {
				t.Errorf("worker %d failed", id)
			}
		}(i)
	}

	wg.Wait()

	w := hl.getWindow("p1")
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.events) != workers {
		t.Fatalf("expected %d events, got %d", workers, len(w.events))
	}
}
