package jethub

// ZCode 出站节流测试（ref modelGapMs + serializeUpstream；IKQ4B4）。

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestZcodeModelGapTable(t *testing.T) {
	cases := map[string]time.Duration{
		"GLM-5.3":        350 * time.Millisecond,
		"glm-5.3":        350 * time.Millisecond,
		"GLM-5.3-Flash":  500 * time.Millisecond,
		" glm-5.3-flash": 500 * time.Millisecond,
		"GLM-5.2":        0,
		"":               0,
	}
	for model, want := range cases {
		if got := zcodeModelGap(model); got != want {
			t.Fatalf("gap(%q) = %v, want %v", model, got, want)
		}
	}
}

// TestZcodeWaitModelGapSerializes: 同一 (账号, 模型) 的发送必须铺开至少 gap；
// 不同账号互不阻塞。
func TestZcodeWaitModelGapSerializes(t *testing.T) {
	old := zcodeModelGaps
	zcodeModelGaps = map[string]time.Duration{"test-model": 40 * time.Millisecond}
	t.Cleanup(func() { zcodeModelGaps = old })
	zcodeGates.Lock()
	zcodeGates.m = map[string]*zcodeGateState{}
	zcodeGates.Unlock()

	const calls = 4
	var mu sync.Mutex
	starts := make([]time.Time, 0, calls)
	var wg sync.WaitGroup
	for i := 0; i < calls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			zcodeWaitModelGap(context.Background(), "acct-gap", "test-model")
			mu.Lock()
			starts = append(starts, time.Now())
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(starts) != calls {
		t.Fatalf("starts = %d, want %d", len(starts), calls)
	}
	// 排序后逐对检查（goroutine 完成顺序不定）。
	for i := 1; i < len(starts); i++ {
		for j := i; j > 0 && starts[j].Before(starts[j-1]); j-- {
			starts[j], starts[j-1] = starts[j-1], starts[j]
		}
	}
	for i := 1; i < len(starts); i++ {
		if spacing := starts[i].Sub(starts[i-1]); spacing < 30*time.Millisecond {
			t.Fatalf("call %d spacing = %v, want >= ~40ms (gap must serialize same account+model)", i, spacing)
		}
	}

	// 不同账号不应互相等待：短窗口内两个 key 都能完成。
	zcodeGates.m = map[string]*zcodeGateState{}
	begin := time.Now()
	var wg2 sync.WaitGroup
	for _, key := range []string{"acct-a", "acct-b"} {
		wg2.Add(1)
		go func(k string) {
			defer wg2.Done()
			zcodeWaitModelGap(context.Background(), k, "test-model")
		}(key)
	}
	wg2.Wait()
	if elapsed := time.Since(begin); elapsed > 30*time.Millisecond {
		t.Fatalf("different accounts must not block each other, took %v", elapsed)
	}
}

// TestZcodeWaitModelGapHonorsCancellation: 取消的请求不得把闸门卡住。
func TestZcodeWaitModelGapHonorsCancellation(t *testing.T) {
	old := zcodeModelGaps
	zcodeModelGaps = map[string]time.Duration{"cancel-model": time.Hour}
	t.Cleanup(func() { zcodeModelGaps = old })
	zcodeGates.Lock()
	zcodeGates.m = map[string]*zcodeGateState{}
	zcodeGates.Unlock()

	// 第一次占住闸门（last=now）。
	zcodeWaitModelGap(context.Background(), "acct-c", "cancel-model")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		zcodeWaitModelGap(ctx, "acct-c", "cancel-model")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled request must not wait for the full gap")
	}
}
