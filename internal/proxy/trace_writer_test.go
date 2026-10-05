package proxy

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/rotation"
)

// bufferedWriterForTest returns a writer with a long debounce so tests control
// flush timing explicitly via Flush().
func bufferedWriterForTest() *bufferedTraceWriter {
	return &bufferedTraceWriter{debounce: time.Hour, logger: console.New(10)}
}

func twSel() *rotation.SelectedKey {
	return &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider"},
		Key:      config.Key{ID: "key1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
}

// TestBufferedTraceWriter_NoFileUntilFlush pins the batching contract: lines
// are held in memory and nothing touches the filesystem before Flush.
func TestBufferedTraceWriter_NoFileUntilFlush(t *testing.T) {
	dir := t.TempDir()
	w := bufferedWriterForTest()
	path := filepath.Join(dir, "index-20260101.jsonl")

	w.enqueue(path, map[string]string{"line": "1"})
	w.enqueue(path, map[string]string{"line": "2"})

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("file must not exist before Flush")
	}

	w.Flush()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after flush: %v", err)
	}
	got := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(got) != 2 || !strings.Contains(got[0], `"line":"1"`) || !strings.Contains(got[1], `"line":"2"`) {
		t.Fatalf("unexpected file content: %q", string(data))
	}
}

// TestBufferedTraceWriter_BatchesPerFileAndPreservesFIFO pins that one flush
// window produces one append per file with same-file lines in enqueue order
// (request line stays ahead of attempt lines for the same reqID).
func TestBufferedTraceWriter_BatchesPerFileAndPreservesFIFO(t *testing.T) {
	dir := t.TempDir()
	w := bufferedWriterForTest()
	idx := filepath.Join(dir, "index-20260101.jsonl")
	reqA := filepath.Join(dir, "req", "a.jsonl")
	reqB := filepath.Join(dir, "req", "b.jsonl")
	// The writer mirrors the old appendJSONLine contract: callers own MkdirAll.
	if err := os.MkdirAll(filepath.Join(dir, "req"), 0o755); err != nil {
		t.Fatal(err)
	}

	w.enqueue(idx, map[string]string{"f": "idx1"})
	w.enqueue(reqA, map[string]string{"f": "a-request"})
	w.enqueue(reqA, map[string]string{"f": "a-attempt"})
	w.enqueue(idx, map[string]string{"f": "idx2"})
	w.enqueue(reqB, map[string]string{"f": "b-request"})
	w.Flush()
	w.enqueue(reqA, map[string]string{"f": "a-attempt2"})
	w.Flush()

	for path, want := range map[string]string{
		idx:  `"f":"idx1"}` + "\n" + `"f":"idx2"}`,
		reqA: `"f":"a-request"}` + "\n" + `"f":"a-attempt"}` + "\n" + `"f":"a-attempt2"}`,
		reqB: `"f":"b-request"}`,
	} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		// Strip the exact key order produced by json.Marshal of a map: map
		// keys serialize sorted, so match on substrings in order instead.
		content := string(data)
		for _, token := range strings.Split(strings.ReplaceAll(want, "}}", "}"), "\n") {
			if !strings.Contains(content, strings.Trim(token, `{"`)) {
				t.Errorf("%s: missing %s in %q", path, token, content)
			}
		}
		if i := strings.Index(content, "a-attempt2"); i >= 0 && strings.Index(content, "a-request") > i {
			t.Errorf("%s: FIFO order broken: %q", path, content)
		}
	}
}

// TestBufferedTraceWriter_FlushAcrossRotation pins that a line carries the
// index file name captured at enqueue time, so a flush landing after local
// midnight still appends yesterday's line to yesterday's index file.
func TestBufferedTraceWriter_FlushAcrossRotation(t *testing.T) {
	dir := t.TempDir()
	w := bufferedWriterForTest()
	old := filepath.Join(dir, "index-20260101.jsonl")
	now := filepath.Join(dir, "index-20260102.jsonl")

	w.enqueue(old, map[string]string{"f": "old"})
	w.enqueue(now, map[string]string{"f": "new"})
	w.Flush()

	if _, err := os.Stat(old); err != nil {
		t.Fatalf("yesterday's index file missing: %v", err)
	}
	if _, err := os.Stat(now); err != nil {
		t.Fatalf("today's index file missing: %v", err)
	}
}

// TestBufferedTraceWriter_ConcurrentEnqueue is a race-detector workout: many
// goroutines enqueue while Flush runs; afterwards every line must be on disk.
func TestBufferedTraceWriter_ConcurrentEnqueue(t *testing.T) {
	dir := t.TempDir()
	w := bufferedWriterForTest()
	path := filepath.Join(dir, "index-20260101.jsonl")

	const goroutines, per = 8, 50
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < per; i++ {
				w.enqueue(path, map[string]int{"i": i})
			}
		}()
	}
	// Concurrent flusher.
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
				w.Flush()
				time.Sleep(time.Millisecond)
			}
		}
	}()

	wg.Wait()
	close(done)
	w.Flush()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	lines := strings.Count(string(data), "\n")
	if lines != goroutines*per {
		t.Fatalf("expected %d lines on disk, got %d", goroutines*per, lines)
	}
}

// TestWriteRequestLog_BufferedThenFlushed pins the end-to-end contract through
// the Handler: recordUsage-time writes appear on disk only after FlushTraces,
// in the same JSONL shape the reader API and sweep already consume.
func TestWriteRequestLog_BufferedThenFlushed(t *testing.T) {
	h, tmpDir := newTestHandlerForTrace(t)
	sel := twSel()

	h.writeRequestLog("req-buf", "openai", "gpt-4", sel, "success", 10, 5, 1, 1, "",
		[]byte(`{"model":"gpt-4"}`), []byte(`{"ok":true}`), nil, 200, nil,
		"http://localhost", "gpt-4", "sess", "success", "")

	if _, err := os.Stat(filepath.Join(tmpDir, "req", "req-buf.jsonl")); !os.IsNotExist(err) {
		t.Fatal("req file must not exist before FlushTraces")
	}

	h.FlushTraces()

	lines, err := readJSONLLines(filepath.Join(tmpDir, "req", "req-buf.jsonl"))
	if err != nil {
		t.Fatalf("read req file: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("expected request+attempt lines, got %d", len(lines))
	}
}
