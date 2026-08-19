package usage

import (
	"testing"
	"time"
)

func entry(provider, model, status string, latencyMs int64) Entry {
	return Entry{
		Timestamp:    time.Now(),
		Provider:     provider,
		Model:        model,
		KeyID:        "key1",
		KeyName:      "test-key",
		Status:       status,
		LatencyMs:    latencyMs,
		InputTokens:  100,
		OutputTokens: 50,
	}
}

func TestRingBuffer_AddAndAll(t *testing.T) {
	rb := New(10)
	e1 := entry("p1", "m1", "success", 100)
	e2 := entry("p2", "m2", "success", 200)
	e3 := entry("p3", "m3", "error", 300)

	rb.Add(e1)
	rb.Add(e2)
	rb.Add(e3)

	all := rb.All()
	if len(all) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(all))
	}
	if all[0].Provider != "p3" {
		t.Errorf("expected newest first p3, got %s", all[0].Provider)
	}
	if all[1].Provider != "p2" {
		t.Errorf("expected p2, got %s", all[1].Provider)
	}
	if all[2].Provider != "p1" {
		t.Errorf("expected oldest last p1, got %s", all[2].Provider)
	}
}

func TestRingBuffer_Overflow(t *testing.T) {
	rb := New(3)
	for i := 0; i < 5; i++ {
		rb.Add(entry("p", "m", "success", int64(i*100)))
	}

	all := rb.All()
	if len(all) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(all))
	}
	if all[0].LatencyMs != 400 {
		t.Errorf("expected newest latency 400, got %d", all[0].LatencyMs)
	}
	if all[1].LatencyMs != 300 {
		t.Errorf("expected 300, got %d", all[1].LatencyMs)
	}
	if all[2].LatencyMs != 200 {
		t.Errorf("expected 200, got %d", all[2].LatencyMs)
	}
}

func TestRingBuffer_Summary(t *testing.T) {
	rb := New(10)
	rb.Add(entry("p1", "m1", "success", 100))
	rb.Add(entry("p1", "m2", "success", 200))
	rb.Add(entry("p2", "m1", "error", 300))
	rb.Add(entry("p2", "m2", "error", 400))

	s := rb.Summary()
	if s.Total != 4 {
		t.Errorf("expected total 4, got %d", s.Total)
	}
	if s.Success != 2 {
		t.Errorf("expected success 2, got %d", s.Success)
	}
	if s.Error != 2 {
		t.Errorf("expected error 2, got %d", s.Error)
	}
	if s.AvgLatencyMs != 250 {
		t.Errorf("expected avg latency 250, got %d", s.AvgLatencyMs)
	}
	if s.TotalInputTokens != 400 {
		t.Errorf("expected total input 400, got %d", s.TotalInputTokens)
	}
	if s.TotalOutputTokens != 200 {
		t.Errorf("expected total output 200, got %d", s.TotalOutputTokens)
	}
}

func TestRingBuffer_SummaryCumulativeAcrossOverflow(t *testing.T) {
	rb := New(3)
	for i := 0; i < 5; i++ {
		rb.Add(entry("p", "m", "success", 100))
	}
	s := rb.Summary()
	if s.Total != 5 {
		t.Errorf("expected cumulative total 5 after overflow, got %d", s.Total)
	}
	if s.Success != 5 {
		t.Errorf("expected cumulative success 5, got %d", s.Success)
	}
	if rb.Size() != 3 {
		t.Errorf("expected ring size 3, got %d", rb.Size())
	}
}

func TestRingBuffer_ClearPreservesAccumulator(t *testing.T) {
	rb := New(10)
	rb.Add(entry("p", "m", "success", 100))
	rb.Add(entry("p", "m", "error", 200))

	s1 := rb.Summary()
	if s1.Total != 2 {
		t.Fatalf("expected total 2 before clear, got %d", s1.Total)
	}

	rb.Clear()

	all := rb.All()
	if len(all) != 0 {
		t.Errorf("expected 0 ring entries after clear, got %d", len(all))
	}
	if rb.Size() != 0 {
		t.Errorf("expected Size() 0 after clear, got %d", rb.Size())
	}

	s2 := rb.Summary()
	if s2.Total != 2 {
		t.Errorf("expected cumulative total 2 after clear, got %d", s2.Total)
	}
	if s2.Success != 1 {
		t.Errorf("expected cumulative success 1 after clear, got %d", s2.Success)
	}
	if s2.Error != 1 {
		t.Errorf("expected cumulative error 1 after clear, got %d", s2.Error)
	}
}

func TestRingBuffer_ModelStats(t *testing.T) {
	rb := New(10)
	rb.Add(entry("p1", "m1", "success", 100))
	rb.Add(entry("p1", "m1", "success", 200))
	rb.Add(entry("p1", "m1", "error", 300))
	rb.Add(entry("p2", "m2", "success", 400))

	stats := rb.ModelStats()
	if len(stats) != 2 {
		t.Fatalf("expected 2 model stats, got %d", len(stats))
	}

	byKey := make(map[string]ModelStatEntry)
	for _, s := range stats {
		byKey[s.Provider+"/"+s.Model] = s
	}

	m1 := byKey["p1/m1"]
	if m1.SuccessCount != 2 {
		t.Errorf("expected m1 success 2, got %d", m1.SuccessCount)
	}
	if m1.ErrorCount != 1 {
		t.Errorf("expected m1 error 1, got %d", m1.ErrorCount)
	}
	if m1.InputTokens != 300 {
		t.Errorf("expected m1 input 300, got %d", m1.InputTokens)
	}
	if m1.OutputTokens != 150 {
		t.Errorf("expected m1 output 150, got %d", m1.OutputTokens)
	}

	m2 := byKey["p2/m2"]
	if m2.SuccessCount != 1 {
		t.Errorf("expected m2 success 1, got %d", m2.SuccessCount)
	}
	if m2.ErrorCount != 0 {
		t.Errorf("expected m2 error 0, got %d", m2.ErrorCount)
	}
}

func TestRingBuffer_ModelStatsCumulativeAfterOverflow(t *testing.T) {
	rb := New(2)
	rb.Add(entry("p1", "m1", "success", 100))
	rb.Add(entry("p1", "m1", "success", 200))
	rb.Add(entry("p1", "m1", "error", 300))
	rb.Add(entry("p1", "m1", "success", 400))

	stats := rb.ModelStats()
	if len(stats) != 1 {
		t.Fatalf("expected 1 model stat, got %d", len(stats))
	}
	if stats[0].SuccessCount != 3 {
		t.Errorf("expected cumulative success 3, got %d", stats[0].SuccessCount)
	}
	if stats[0].ErrorCount != 1 {
		t.Errorf("expected cumulative error 1, got %d", stats[0].ErrorCount)
	}
}

func TestRingBuffer_Resize_Grow(t *testing.T) {
	rb := New(3)
	rb.Add(entry("p1", "m1", "success", 100))
	rb.Add(entry("p2", "m2", "success", 200))

	rb.Resize(5)
	if rb.Size() != 2 {
		t.Fatalf("expected size 2 after grow, got %d", rb.Size())
	}
	all := rb.All()
	if all[0].Provider != "p2" {
		t.Errorf("expected newest p2, got %s", all[0].Provider)
	}
	if all[1].Provider != "p1" {
		t.Errorf("expected p1, got %s", all[1].Provider)
	}
}

func TestRingBuffer_Resize_Shrink(t *testing.T) {
	rb := New(5)
	rb.Add(entry("p1", "m1", "success", 100))
	rb.Add(entry("p2", "m2", "success", 200))
	rb.Add(entry("p3", "m3", "success", 300))
	rb.Add(entry("p4", "m4", "success", 400))

	rb.Resize(2)
	if rb.Size() != 2 {
		t.Fatalf("expected size 2 after shrink, got %d", rb.Size())
	}
	all := rb.All()
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}
	if all[0].Provider != "p4" {
		t.Errorf("expected newest p4, got %s", all[0].Provider)
	}
	if all[1].Provider != "p3" {
		t.Errorf("expected p3, got %s", all[1].Provider)
	}
}

func TestRingBuffer_Size(t *testing.T) {
	rb := New(10)
	if rb.Size() != 0 {
		t.Errorf("expected size 0 initially, got %d", rb.Size())
	}
	rb.Add(entry("p", "m", "success", 100))
	if rb.Size() != 1 {
		t.Errorf("expected size 1, got %d", rb.Size())
	}
	rb.Add(entry("p", "m", "success", 100))
	if rb.Size() != 2 {
		t.Errorf("expected size 2, got %d", rb.Size())
	}
}

func TestAccumulator_KeyStatsFor(t *testing.T) {
	rb := New(100)
	// key1: two successes with TTFT
	rb.Add(Entry{
		Provider: "providerA", Model: "modelX", KeyID: "key1", KeyName: "k1",
		Status: "success", LatencyMs: 2000, TTFTMs: 200, InputTokens: 100, OutputTokens: 400,
	})
	rb.Add(Entry{
		Provider: "providerA", Model: "modelX", KeyID: "key1", KeyName: "k1",
		Status: "success", LatencyMs: 3000, TTFTMs: 300, InputTokens: 100, OutputTokens: 500,
	})
	// key2: one failure
	rb.Add(Entry{
		Provider: "providerA", Model: "modelX", KeyID: "key2", KeyName: "k2",
		Status: "error", LatencyMs: 500, TTFTMs: 0, InputTokens: 0, OutputTokens: 0,
	})
	// different model — should be ignored
	rb.Add(Entry{
		Provider: "providerA", Model: "modelY", KeyID: "key1", KeyName: "k1",
		Status: "success", LatencyMs: 1000, TTFTMs: 100, InputTokens: 50, OutputTokens: 200,
	})
	// different provider — should be ignored
	rb.Add(Entry{
		Provider: "providerB", Model: "modelX", KeyID: "key3", KeyName: "k3",
		Status: "success", LatencyMs: 1000, TTFTMs: 100, InputTokens: 50, OutputTokens: 200,
	})

	stats := rb.Accumulator().KeyStatsFor("providerA", "modelX")
	if len(stats) != 2 {
		t.Fatalf("expected 2 key stats, got %d", len(stats))
	}

	byID := make(map[string]KeyStatEntry)
	for _, s := range stats {
		byID[s.KeyID] = s
	}

	ks1 := byID["key1"]
	if ks1.SuccessCount != 2 {
		t.Errorf("expected key1 success 2, got %d", ks1.SuccessCount)
	}
	if ks1.ErrorCount != 0 {
		t.Errorf("expected key1 error 0, got %d", ks1.ErrorCount)
	}
	if ks1.AvgTTFTMs != 250 {
		t.Errorf("expected key1 avg ttft 250, got %d", ks1.AvgTTFTMs)
	}
	// avgSpeed = totalOutput / (totalOutputPhaseMs/1000) = 900 / ((1800+2700)/1000) = 900/4.5 = 200
	if ks1.AvgSpeed < 199 || ks1.AvgSpeed > 201 {
		t.Errorf("expected key1 avg speed ~200, got %f", ks1.AvgSpeed)
	}

	ks2 := byID["key2"]
	if ks2.SuccessCount != 0 {
		t.Errorf("expected key2 success 0, got %d", ks2.SuccessCount)
	}
	if ks2.ErrorCount != 1 {
		t.Errorf("expected key2 error 1, got %d", ks2.ErrorCount)
	}
	if ks2.AvgTTFTMs != 0 {
		t.Errorf("expected key2 avg ttft 0, got %d", ks2.AvgTTFTMs)
	}
	if ks2.AvgSpeed != 0 {
		t.Errorf("expected key2 avg speed 0, got %f", ks2.AvgSpeed)
	}
}

func TestAccumulator_Clear(t *testing.T) {
	acc := NewAccumulator()
	acc.Record(entry("p", "m", "success", 100))
	acc.Record(entry("p", "m", "error", 200))

	s := acc.Summary()
	if s.Total != 2 {
		t.Fatalf("expected total 2 before clear, got %d", s.Total)
	}

	acc.Clear()

	s2 := acc.Summary()
	if s2.Total != 0 {
		t.Errorf("expected total 0 after clear, got %d", s2.Total)
	}
	if s2.Success != 0 {
		t.Errorf("expected success 0 after clear, got %d", s2.Success)
	}
	if s2.Error != 0 {
		t.Errorf("expected error 0 after clear, got %d", s2.Error)
	}
	if s2.TotalInputTokens != 0 {
		t.Errorf("expected input tokens 0 after clear, got %d", s2.TotalInputTokens)
	}

	stats := acc.ModelStats()
	if len(stats) != 0 {
		t.Errorf("expected 0 model stats after clear, got %d", len(stats))
	}
}

func TestRingBuffer_ByID(t *testing.T) {
	rb := New(3)

	// Empty ring
	if _, ok := rb.ByID("non-existent"); ok {
		t.Fatal("expected ByID to return false on empty ring")
	}
	if _, ok := rb.ByID(""); ok {
		t.Fatal("expected ByID to return false for empty id")
	}

	e1 := Entry{ID: "req-1", Provider: "p1", Model: "m1", Status: "success"}
	e2 := Entry{ID: "req-2", Provider: "p2", Model: "m2", Status: "success"}
	e3 := Entry{ID: "req-3", Provider: "p3", Model: "m3", Status: "error"}

	rb.Add(e1)
	rb.Add(e2)
	rb.Add(e3)

	// Find each
	got1, ok := rb.ByID("req-1")
	if !ok || got1.Provider != "p1" {
		t.Fatalf("expected to find req-1, got %+v (ok=%v)", got1, ok)
	}
	got3, ok := rb.ByID("req-3")
	if !ok || got3.Provider != "p3" {
		t.Fatalf("expected to find req-3, got %+v (ok=%v)", got3, ok)
	}

	// Overflow the buffer (capacity 3)
	e4 := Entry{ID: "req-4", Provider: "p4", Model: "m4", Status: "success"}
	rb.Add(e4) // evicts req-1

	if _, ok := rb.ByID("req-1"); ok {
		t.Fatal("expected req-1 to be evicted after overflow")
	}

	got4, ok := rb.ByID("req-4")
	if !ok || got4.Provider != "p4" {
		t.Fatalf("expected to find req-4, got %+v (ok=%v)", got4, ok)
	}
	got2, ok := rb.ByID("req-2")
	if !ok || got2.Provider != "p2" {
		t.Fatalf("expected to find req-2, got %+v (ok=%v)", got2, ok)
	}
}

