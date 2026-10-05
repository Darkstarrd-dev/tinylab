package usage

import (
	"encoding/json"
	"net/http"
	"testing"
)

func bigPayloadEntry(id string, payloadBytes int) Entry {
	e := entry("p", "m", "success", 1)
	e.ID = id
	e.ReqPayload = json.RawMessage(`{"d":"` + string(make([]byte, payloadBytes)) + `"}`)
	return e
}

func TestRingBuffer_ByteBudgetEvictsOldest(t *testing.T) {
	// Budget fits roughly three 1 KiB-payload entries plus allowances.
	const budget = 4096
	rb := NewWithByteBudget(100, budget)

	rb.Add(bigPayloadEntry("e1", 1024))
	rb.Add(bigPayloadEntry("e2", 1024))
	rb.Add(bigPayloadEntry("e3", 1024))
	if rb.Size() != 3 {
		t.Fatalf("expected 3 entries under budget, got %d", rb.Size())
	}
	if rb.byteTotal > budget {
		t.Fatalf("byteTotal %d exceeds budget %d", rb.byteTotal, budget)
	}

	// The fourth entry must evict the oldest (e1) to stay within budget.
	rb.Add(bigPayloadEntry("e4", 1024))
	if rb.byteTotal > budget {
		t.Fatalf("byteTotal %d exceeds budget %d after eviction", rb.byteTotal, budget)
	}
	if _, found := rb.ByID("e1"); found {
		t.Fatal("oldest entry e1 must be evicted by the byte budget")
	}
	for _, id := range []string{"e2", "e3", "e4"} {
		if _, found := rb.ByID(id); !found {
			t.Fatalf("entry %s must survive byte-budget eviction", id)
		}
	}

	// Evicted slots must be zeroed so payload memory is released.
	for i, e := range rb.entries {
		if e.ID == "" && (len(e.ReqPayload) != 0 || len(e.RespPayload) != 0) {
			t.Fatalf("slot %d is empty but retains payload bytes", i)
		}
	}
}

func TestRingBuffer_ByteBudgetKeepsNewestOversized(t *testing.T) {
	rb := NewWithByteBudget(100, 1024)
	rb.Add(bigPayloadEntry("huge", 64*1024))
	if rb.Size() != 1 {
		t.Fatalf("newest entry must be kept even over budget, size=%d", rb.Size())
	}
	if _, found := rb.ByID("huge"); !found {
		t.Fatal("oversized newest entry must be retrievable")
	}

	// A subsequent small entry evicts the oversized one.
	rb.Add(entry("p", "m", "success", 2))
	if _, found := rb.ByID("huge"); found {
		t.Fatal("oversized entry must be evicted once a newer entry arrives")
	}
	if rb.Size() != 1 {
		t.Fatalf("expected 1 entry after eviction, got %d", rb.Size())
	}
}

func TestRingBuffer_ByteBudgetCountedInHeaders(t *testing.T) {
	const budget = 2048
	rb := NewWithByteBudget(100, budget)
	e := entry("p", "m", "success", 1)
	e.ID = "h1"
	e.RespHeaders = http.Header{"X-Big": {string(make([]byte, 3000))}}
	rb.Add(e)
	rb.Add(entry("p", "m", "success", 2))
	if _, found := rb.ByID("h1"); found {
		t.Fatal("header-heavy entry must count toward the byte budget and be evicted")
	}
}

func TestRingBuffer_ByteBudgetClearAndResize(t *testing.T) {
	const budget = 4096
	rb := NewWithByteBudget(100, budget)
	for _, id := range []string{"a", "b", "c"} {
		rb.Add(bigPayloadEntry(id, 1024))
	}

	// Clear must reset the byte accounting and release payloads.
	rb.Clear()
	if rb.byteTotal != 0 {
		t.Fatalf("Clear must reset byteTotal, got %d", rb.byteTotal)
	}
	for i, e := range rb.entries {
		if len(e.ReqPayload) != 0 {
			t.Fatalf("Clear must release payload in slot %d", i)
		}
	}

	// Resize recomputes the byte total from the kept entries and enforces the
	// budget across the rebuild.
	for _, id := range []string{"a", "b", "c"} {
		rb.Add(bigPayloadEntry(id, 1024))
	}
	rb.Resize(50)
	if rb.byteTotal > budget {
		t.Fatalf("byteTotal %d exceeds budget %d after Resize", rb.byteTotal, budget)
	}
	var sum int64
	for _, e := range rb.All() {
		sum += entryBytes(e)
	}
	if sum != rb.byteTotal {
		t.Fatalf("byteTotal %d diverges from retained entries %d after Resize", rb.byteTotal, sum)
	}

	// Ring stays consistent for further adds after Resize.
	rb.Add(bigPayloadEntry("d", 1024))
	if rb.byteTotal > budget {
		t.Fatalf("byteTotal %d exceeds budget %d after post-Resize Add", rb.byteTotal, budget)
	}
	if _, found := rb.ByID("d"); !found {
		t.Fatal("newest entry must survive post-Resize eviction")
	}
}
