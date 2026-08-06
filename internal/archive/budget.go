package archive

import (
	"io"
	"sync"
	"time"
)

// Default budget constants, frozen from archive_compatibility_plan.md §4.3.
// They are code-level defaults only; the Settings surface intentionally does
// not expose them.
const (
	// MaxInputBytesDefault caps a browser-uploaded compressed archive.
	MaxInputBytesDefault = 500 << 20 // 500 MiB
	// MaxLocalInputBytes caps an on-disk archive import (mirrors gallery's
	// maxZipDiskSize = 1 GiB).
	MaxLocalInputBytes = 1 << 30 // 1 GiB
	// MaxEntryBytesDefault caps a single extracted entry.
	MaxEntryBytesDefault = 100 << 20 // 100 MiB
	// MaxEntriesDefault caps the number of entries in one archive.
	MaxEntriesDefault = 20000
	// MaxTotalBytesDefault caps the total uncompressed size of one archive.
	MaxTotalBytesDefault = 2 << 30 // 2 GiB
	// MaxCompressedRatioDefault caps the compression ratio of any entry when
	// both sizes are known.
	MaxCompressedRatioDefault = 100
	// MaxPackFilesDefault caps the number of input assets in one Pack.
	MaxPackFilesDefault = 2000
	// MaxOutputBytesDefault caps the total input/output of one pack or
	// replace operation.
	MaxOutputBytesDefault = 2 << 30 // 2 GiB
	// DefaultAssetBytes caps one TempStore asset when the caller does not
	// pass an explicit cap.
	DefaultAssetBytes = MaxEntryBytesDefault

	// ListTimeoutDefault / ReadTimeoutDefault / WriteTimeoutDefault are the
	// operation timeouts the plan assigns to list / entry read / pack &
	// replace. Callers apply them as context deadlines; the ZIP adapter also
	// applies Budget.MaxDuration when set.
	ListTimeoutDefault  = 15 * time.Second
	ReadTimeoutDefault  = 60 * time.Second
	WriteTimeoutDefault = 5 * time.Minute
	// MaxConcurrencyDefault caps concurrent external archive jobs (P2).
	MaxConcurrencyDefault = 2
)

// DefaultBudget returns the plan §4.3 defaults. MaxDuration is left zero so
// callers pick the operation-specific timeout (ListTimeoutDefault etc.);
// MaxNestedDepth defaults to 0 (no nested-archive recursion).
func DefaultBudget() Budget {
	return Budget{
		MaxEntries:         MaxEntriesDefault,
		MaxEntryBytes:      MaxEntryBytesDefault,
		MaxTotalBytes:      MaxTotalBytesDefault,
		MaxCompressedRatio: MaxCompressedRatioDefault,
		MaxInputBytes:      MaxInputBytesDefault,
		MaxOutputBytes:     MaxOutputBytesDefault,
	}
}

// Tracker accounts budget consumption across one archive operation. It is
// safe for concurrent use; the ZIP adapter uses it during manifest scans.
type Tracker struct {
	mu         sync.Mutex
	budget     Budget
	entries    int
	totalBytes int64
}

// NewTracker returns a Tracker enforcing b.
func NewTracker(b Budget) *Tracker {
	return &Tracker{budget: b}
}

// CheckEntrySize accounts one entry from its declared sizes. It returns a
// *BudgetError when the entry count, the single-entry size, the compression
// ratio (when compressed > 0), or the running total exceeds the budget.
func (t *Tracker) CheckEntrySize(compressed, uncompressed int64) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	b := t.budget
	if b.MaxEntries > 0 && t.entries >= b.MaxEntries {
		return &BudgetError{Dimension: "entries", Limit: int64(b.MaxEntries), Actual: int64(t.entries) + 1}
	}
	if b.MaxEntryBytes > 0 && uncompressed > b.MaxEntryBytes {
		return &BudgetError{Dimension: "entry-bytes", Limit: b.MaxEntryBytes, Actual: uncompressed}
	}
	if b.MaxCompressedRatio > 0 && compressed > 0 && uncompressed > compressed*b.MaxCompressedRatio {
		return &BudgetError{Dimension: "ratio", Limit: compressed * b.MaxCompressedRatio, Actual: uncompressed}
	}
	if b.MaxTotalBytes > 0 && t.totalBytes+uncompressed > b.MaxTotalBytes {
		return &BudgetError{Dimension: "total-bytes", Limit: b.MaxTotalBytes, Actual: t.totalBytes + uncompressed}
	}
	t.entries++
	t.totalBytes += uncompressed
	return nil
}

// Counters returns the entries and total bytes accounted so far.
func (t *Tracker) Counters() (entries int, totalBytes int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.entries, t.totalBytes
}

// CapReader wraps r and fails with a *BudgetError (Dimension
// "entry-bytes") once more than limit bytes have been produced, instead of
// silently truncating at the limit. Reading exactly limit bytes is allowed;
// the limit+1st byte triggers the error, mirroring gallery's
// io.LimitReader(rc, cap+1) detection.
type CapReader struct {
	r     io.Reader
	limit int64 // max bytes allowed; <= 0 means unlimited
	read  int64
}

// NewCapReader wraps r with an n-byte cap. A non-positive n means unlimited.
func NewCapReader(r io.Reader, n int64) *CapReader {
	return &CapReader{r: r, limit: n}
}

func (c *CapReader) Read(p []byte) (int, error) {
	if c.limit > 0 && c.read > c.limit {
		return 0, &BudgetError{Dimension: "entry-bytes", Limit: c.limit, Actual: c.read}
	}
	room := len(p)
	if c.limit > 0 {
		remaining := c.limit + 1 - c.read
		if remaining <= 0 {
			return 0, &BudgetError{Dimension: "entry-bytes", Limit: c.limit, Actual: c.read}
		}
		if int64(room) > remaining {
			room = int(remaining)
		}
	}
	n, err := c.r.Read(p[:room])
	c.read += int64(n)
	if c.limit > 0 && c.read > c.limit {
		return n, &BudgetError{Dimension: "entry-bytes", Limit: c.limit, Actual: c.read}
	}
	return n, err
}

// ReadCapped reads all of r but fails with a *BudgetError once more than
// limit bytes are produced.
func ReadCapped(r io.Reader, limit int64) ([]byte, error) {
	return io.ReadAll(NewCapReader(r, limit))
}

// CountingWriter passes writes through to w and fails with a *BudgetError
// (Dimension "output-bytes") once the total would exceed limit.
type CountingWriter struct {
	w     io.Writer
	limit int64
	n     int64
}

// NewCountingWriter wraps w with an n-byte output cap. A non-positive n means
// unlimited.
func NewCountingWriter(w io.Writer, n int64) *CountingWriter {
	return &CountingWriter{w: w, limit: n}
}

func (c *CountingWriter) Write(p []byte) (int, error) {
	if c.limit > 0 && c.n+int64(len(p)) > c.limit {
		return 0, &BudgetError{Dimension: "output-bytes", Limit: c.limit, Actual: c.n + int64(len(p))}
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// Count returns the total bytes written so far.
func (c *CountingWriter) Count() int64 { return c.n }
