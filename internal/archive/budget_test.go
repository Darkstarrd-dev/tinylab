package archive

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestDefaultBudget_PlanValues(t *testing.T) {
	b := DefaultBudget()
	if b.MaxEntries != MaxEntriesDefault {
		t.Errorf("MaxEntries = %d, want %d", b.MaxEntries, MaxEntriesDefault)
	}
	if b.MaxEntryBytes != MaxEntryBytesDefault {
		t.Errorf("MaxEntryBytes = %d, want %d", b.MaxEntryBytes, MaxEntryBytesDefault)
	}
	if b.MaxTotalBytes != MaxTotalBytesDefault {
		t.Errorf("MaxTotalBytes = %d, want %d", b.MaxTotalBytes, MaxTotalBytesDefault)
	}
	if b.MaxCompressedRatio != MaxCompressedRatioDefault {
		t.Errorf("MaxCompressedRatio = %d, want %d", b.MaxCompressedRatio, MaxCompressedRatioDefault)
	}
	if b.MaxInputBytes != MaxInputBytesDefault {
		t.Errorf("MaxInputBytes = %d, want %d", b.MaxInputBytes, MaxInputBytesDefault)
	}
	if b.MaxOutputBytes != MaxOutputBytesDefault {
		t.Errorf("MaxOutputBytes = %d, want %d", b.MaxOutputBytes, MaxOutputBytesDefault)
	}
}

func TestTracker_EntrySizeCaps(t *testing.T) {
	tracker := NewTracker(Budget{MaxEntries: 2, MaxEntryBytes: 100, MaxTotalBytes: 150})
	if err := tracker.CheckEntrySize(10, 60); err != nil {
		t.Fatalf("first entry: %v", err)
	}
	if err := tracker.CheckEntrySize(10, 60); err != nil {
		t.Fatalf("second entry: %v", err)
	}
	if err := tracker.CheckEntrySize(1, 1); !IsBudgetExceeded(err) {
		t.Fatalf("third entry should exceed entries cap, got %v", err)
	}
}

func TestTracker_SingleEntryCap(t *testing.T) {
	tracker := NewTracker(Budget{MaxEntryBytes: 100})
	err := tracker.CheckEntrySize(1, 101)
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error, got %v", err)
	}
	var be *BudgetError
	if !errors.As(err, &be) || be.Dimension != "entry-bytes" {
		t.Fatalf("expected entry-bytes dimension, got %+v", be)
	}
	if err := tracker.CheckEntrySize(1, 100); err != nil {
		t.Fatalf("entry exactly at cap must pass: %v", err)
	}
}

func TestTracker_TotalBytesCap(t *testing.T) {
	tracker := NewTracker(Budget{MaxTotalBytes: 150})
	if err := tracker.CheckEntrySize(1, 100); err != nil {
		t.Fatalf("first: %v", err)
	}
	err := tracker.CheckEntrySize(1, 51)
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected total-bytes budget error, got %v", err)
	}
	var be *BudgetError
	if !errors.As(err, &be) || be.Dimension != "total-bytes" {
		t.Fatalf("expected total-bytes dimension, got %+v", be)
	}
}

func TestTracker_RatioCap(t *testing.T) {
	tracker := NewTracker(Budget{MaxCompressedRatio: 10})
	if err := tracker.CheckEntrySize(10, 100); err != nil {
		t.Fatalf("ratio 10:1 at cap must pass: %v", err)
	}
	err := tracker.CheckEntrySize(10, 101)
	if !IsBudgetExceeded(err) {
		t.Fatalf("ratio 10.1:1 should exceed, got %v", err)
	}
	// Unknown compressed size (-1) skips the ratio check.
	if err := tracker.CheckEntrySize(-1, 1<<20); err != nil {
		t.Fatalf("unknown compressed size must skip ratio check: %v", err)
	}
}

func TestTracker_UnlimitedBudget(t *testing.T) {
	tracker := NewTracker(Budget{})
	if err := tracker.CheckEntrySize(1, 1<<40); err != nil {
		t.Fatalf("zero budget means no caps: %v", err)
	}
	entries, total := tracker.Counters()
	if entries != 1 || total != 1<<40 {
		t.Fatalf("counters = (%d, %d)", entries, total)
	}
}

func TestCapReader_ExactLimitAllowed(t *testing.T) {
	src := strings.Repeat("x", 100)
	data, err := ReadCapped(strings.NewReader(src), 100)
	if err != nil {
		t.Fatalf("exact limit read: %v", err)
	}
	if len(data) != 100 {
		t.Fatalf("read %d bytes, want 100", len(data))
	}
}

func TestCapReader_OverLimitRejected(t *testing.T) {
	src := strings.Repeat("x", 101)
	_, err := ReadCapped(strings.NewReader(src), 100)
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error, got %v", err)
	}
	var be *BudgetError
	if !errors.As(err, &be) || be.Dimension != "entry-bytes" || be.Limit != 100 || be.Actual != 101 {
		t.Fatalf("unexpected budget error %+v", be)
	}
}

func TestCapReader_Streaming(t *testing.T) {
	// A reader that yields one byte per Read: the cap must trip mid-stream.
	rc := NewCapReader(strings.NewReader(strings.Repeat("x", 5)), 3)
	var buf bytes.Buffer
	_, err := io.Copy(&buf, rc)
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected budget error mid-stream, got %v", err)
	}
	// limit+1 probe semantics (same as gallery's LimitReader(rc, cap+1)):
	// the (limit+1)th byte may be delivered with the error, never more.
	if buf.Len() > 4 {
		t.Fatalf("streamed %d bytes before the cap tripped, want <= 4", buf.Len())
	}
}

func TestCountingWriter_Cap(t *testing.T) {
	var buf bytes.Buffer
	cw := NewCountingWriter(&buf, 10)
	if _, err := cw.Write([]byte("12345")); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if _, err := cw.Write([]byte("67890")); err != nil {
		t.Fatalf("second write at cap: %v", err)
	}
	_, err := cw.Write([]byte("1"))
	if !IsBudgetExceeded(err) {
		t.Fatalf("expected output-bytes budget error, got %v", err)
	}
	if cw.Count() != 10 {
		t.Fatalf("count = %d, want 10", cw.Count())
	}
}
