package proxy

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- helpers for the retention sweep tests ---

func sweepTestHandler(dir string) *Handler {
	h := &Handler{}
	h.SetRequestLogDir(dir)
	return h
}

// sweepWriteIndex writes an index file with one JSONL line per reqID.
func sweepWriteIndex(t *testing.T, tracesDir, name string, reqIDs ...string) string {
	t.Helper()
	var sb strings.Builder
	for _, id := range reqIDs {
		fmt.Fprintf(&sb, `{"type":"index","reqID":%q,"model":"m","status":"success"}`+"\n", id)
	}
	path := filepath.Join(tracesDir, name)
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("write index %s: %v", name, err)
	}
	return path
}

// sweepWriteReq writes a req/<reqID>.jsonl detail file of the given size.
func sweepWriteReq(t *testing.T, tracesDir, reqID string, size int) string {
	t.Helper()
	reqDir := filepath.Join(tracesDir, "req")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		t.Fatalf("mkdir req: %v", err)
	}
	path := filepath.Join(reqDir, reqID+".jsonl")
	body := fmt.Sprintf(`{"type":"request","reqID":%q,"pad":%q}`+"\n", reqID, strings.Repeat("x", size))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write req %s: %v", reqID, err)
	}
	return path
}

func sweepSetMTime(t *testing.T, path string, ts time.Time) {
	t.Helper()
	if err := os.Chtimes(path, ts, ts); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func sweepExists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	return err == nil
}

// sweepIndexReqIDs returns the set of reqIDs advertised by an index file.
func sweepIndexReqIDs(t *testing.T, path string) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read index %s: %v", path, err)
	}
	ids := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		reqID, ok := indexLineReqID([]byte(line))
		if !ok {
			continue
		}
		ids[reqID] = true
	}
	return ids
}

func sweepRemainingReqIDs(t *testing.T, tracesDir string) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(tracesDir, "req"))
	if err != nil {
		t.Fatalf("read req dir: %v", err)
	}
	ids := make(map[string]bool)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ids[strings.TrimSuffix(e.Name(), ".jsonl")] = true
	}
	return ids
}

// TestSweepTracesOnce_AgeEvictionPurgesIndexLines covers age-based eviction: the
// expired req file disappears AND its index line goes with it, while live rows
// and unparsable lines survive.
func TestSweepTracesOnce_AgeEvictionPurgesIndexLines(t *testing.T) {
	dir := t.TempDir()
	indexPath := sweepWriteIndex(t, dir, "index-20200101.jsonl", "A", "B", "C")

	// A malformed line must be preserved verbatim (never lose data the sweep
	// cannot parse).
	f, err := os.OpenFile(indexPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open index for append: %v", err)
	}
	if _, err := f.WriteString("{not json\n"); err != nil {
		t.Fatalf("append malformed line: %v", err)
	}
	f.Close()

	for _, id := range []string{"A", "B", "C"} {
		sweepWriteReq(t, dir, id, 64)
	}

	old := time.Now().Add(-3 * 24 * time.Hour)
	sweepSetMTime(t, filepath.Join(dir, "req", "B.jsonl"), old)
	// The index itself stays young so only req-file age drives eviction.
	sweepSetMTime(t, indexPath, time.Now())

	h := sweepTestHandler(dir)
	h.SweepTracesOnce(2, 0)

	if sweepExists(t, filepath.Join(dir, "req", "B.jsonl")) {
		t.Error("expired req/B.jsonl should have been deleted")
	}
	for _, id := range []string{"A", "C"} {
		if !sweepExists(t, filepath.Join(dir, "req", id+".jsonl")) {
			t.Errorf("live req/%s.jsonl should have been kept", id)
		}
	}

	ids := sweepIndexReqIDs(t, indexPath)
	if ids["B"] {
		t.Error("index still lists evicted reqID B (ghost row with no detail file)")
	}
	for _, id := range []string{"A", "C"} {
		if !ids[id] {
			t.Errorf("index lost live reqID %s", id)
		}
	}

	data, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	if !strings.Contains(string(data), "{not json") {
		t.Error("malformed index line was dropped; sweep must preserve lines it cannot parse")
	}
}

// TestSweepTracesOnce_DiskCapEvictionPurgesIndexLines covers disk-cap eviction:
// whatever the cap evicts, the index never advertises a reqID whose detail file
// is gone, and every surviving detail file keeps its index row.
func TestSweepTracesOnce_DiskCapEvictionPurgesIndexLines(t *testing.T) {
	dir := t.TempDir()
	ids := []string{"r1", "r2", "r3", "r4"}
	indexPath := sweepWriteIndex(t, dir, "index-20990101.jsonl", ids...)
	sweepSetMTime(t, indexPath, time.Now())

	base := time.Now().Add(-time.Hour)
	for i, id := range ids {
		p := sweepWriteReq(t, dir, id, 400*1024)
		// Distinct mtimes, oldest first, so eviction order is deterministic.
		sweepSetMTime(t, p, base.Add(time.Duration(i)*time.Minute))
	}

	h := sweepTestHandler(dir)
	h.SweepTracesOnce(30, 1) // 30 days retention: nothing expires by age

	remaining := sweepRemainingReqIDs(t, dir)
	if len(remaining) == len(ids) {
		t.Fatalf("disk cap did not evict anything (4x400KB > 1MB): %v", remaining)
	}

	// The oldest file must be the first to go.
	if remaining["r1"] {
		t.Error("oldest req file r1 should have been evicted by the disk cap")
	}

	advertised := sweepIndexReqIDs(t, indexPath)
	for _, id := range ids {
		if remaining[id] && !advertised[id] {
			t.Errorf("index lost line for surviving reqID %s", id)
		}
		if !remaining[id] && advertised[id] {
			t.Errorf("index still lists evicted reqID %s (ghost row with no detail file)", id)
		}
	}
	if len(advertised) != len(remaining) {
		t.Errorf("index advertises %d reqIDs but %d detail files remain", len(advertised), len(remaining))
	}
}

// TestSweepTracesOnce_NoEvictionLeavesIndexUntouched pins the "no change, no
// rewrite" rule: a sweep that deletes nothing must not churn index mtimes
// (the disk-cap pass orders candidates by mtime).
func TestSweepTracesOnce_NoEvictionLeavesIndexUntouched(t *testing.T) {
	dir := t.TempDir()
	indexPath := sweepWriteIndex(t, dir, "index-20990101.jsonl", "A", "B")
	stamp := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	sweepSetMTime(t, indexPath, stamp)
	sweepWriteReq(t, dir, "A", 64)
	sweepWriteReq(t, dir, "B", 64)

	h := sweepTestHandler(dir)
	h.SweepTracesOnce(30, 0)

	info, err := os.Stat(indexPath)
	if err != nil {
		t.Fatalf("stat index: %v", err)
	}
	if !info.ModTime().Equal(stamp) {
		t.Errorf("index rewritten despite no eviction: mtime %v, want %v", info.ModTime(), stamp)
	}
	ids := sweepIndexReqIDs(t, indexPath)
	if !ids["A"] || !ids["B"] {
		t.Errorf("index rows lost without eviction: %v", ids)
	}
}

// TestSweepTracesOnce_ReconcilesGhostIndexLines covers the reconcile path: an
// index line whose detail file is already gone (evicted by an earlier sweep or
// removed by hand) is dropped once it is older than the write-order grace,
// while a just-written line and lines with live detail files survive.
func TestSweepTracesOnce_ReconcilesGhostIndexLines(t *testing.T) {
	dir := t.TempDir()
	oldTS := time.Now().Add(-time.Hour).Format(time.RFC3339Nano)
	freshTS := time.Now().Add(-30 * time.Second).Format(time.RFC3339Nano)

	var sb strings.Builder
	fmt.Fprintf(&sb, `{"type":"index","reqID":"ghost-old","ts":%q}`+"\n", oldTS)
	fmt.Fprintf(&sb, `{"type":"index","reqID":"ghost-fresh","ts":%q}`+"\n", freshTS)
	fmt.Fprintf(&sb, `{"type":"index","reqID":"live","ts":%q}`+"\n", oldTS)
	sb.WriteString("{not json\n")
	indexPath := filepath.Join(dir, "index-20200101.jsonl")
	if err := os.WriteFile(indexPath, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	// Only "live" has a detail file; ghost-old/ghost-fresh are ghosts.
	sweepWriteReq(t, dir, "live", 64)

	h := sweepTestHandler(dir)
	h.SweepTracesOnce(30, 0) // no age eviction, no disk cap: reconcile only

	ids := sweepIndexReqIDs(t, indexPath)
	if ids["ghost-old"] {
		t.Errorf("old ghost index line survived: %v", ids)
	}
	if !ids["ghost-fresh"] {
		t.Errorf("fresh index line dropped inside the write-order grace: %v", ids)
	}
	if !ids["live"] {
		t.Errorf("live index line dropped although its detail file exists: %v", ids)
	}
	data, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	if !strings.Contains(string(data), "{not json") {
		t.Errorf("unparsable line not preserved: %q", string(data))
	}
}
