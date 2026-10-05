package proxy

import (
	"bytes"
	"encoding/json"
	"os"
	"sync"
	"time"
)

// bufferedTraceWriter batches JSONL trace lines in memory and appends them to
// their target files in one open/write/close cycle per file per flush window,
// instead of one cycle per line (F-10: every attempt produced 2–3 syscalls
// with the whole request/response payload re-buffered by the kernel on each
// append).
//
// Ordering rules that the trace format relies on are preserved:
//   - lines for the same file keep their relative FIFO order (same reqID's
//     "request" line stays ahead of its "attempt" lines);
//   - a line is enqueued at enqueue time with the file it targets, so a
//     flush falling across the daily rotation boundary still writes each
//     line to the file named at enqueue time;
//   - flushes are serialized by a mutex, so appends to one file are never
//     interleaved mid-line, matching the previous appendJSONLine behavior
//     that SweepTracesOnce/filterIndexFile depend on (line-granular reads).
//
// Crash window: lines held in memory for up to traceFlushDebounce are lost
// if the process exits without Flush. Trace data is diagnostic, so this
// tradeoff is accepted (F-10 direction: buffered batching with periodic
// flush). App.Shutdown and the settings handler call Flush to drain.
type bufferedTraceWriter struct {
	mu       sync.Mutex
	pending  []pendingTraceLine
	timer    *time.Timer // nil = no flush scheduled
	debounce time.Duration
	logger   Logger
}

// pendingTraceLine is one queued JSONL record bound to its absolute target
// path. path captures the daily-rotated index file name at enqueue time.
type pendingTraceLine struct {
	path string
	data []byte // complete JSON line, newline-terminated
}

// traceFlushDebounce is how long lines may sit in memory before being
// appended to disk. Small enough that a crash loses at most ~2s of
// diagnostic trace, large enough to collapse a burst of attempts (combo
// fallback chains, retries) into one syscall batch per file.
const traceFlushDebounce = 2 * time.Second

func newBufferedTraceWriter(logger Logger) *bufferedTraceWriter {
	return &bufferedTraceWriter{debounce: traceFlushDebounce, logger: logger}
}

// enqueue queues one JSON-encoded line for delayed append. The buffer is
// bounded by the ring/trace retention semantics of its callers (each line
// corresponds to one recordUsage/TraceMgmtCall); no extra cap is imposed,
// mirroring the unbounded-but-diagnostic nature of the previous direct writes.
func (w *bufferedTraceWriter) enqueue(path string, line any) {
	data, err := json.Marshal(line)
	if err != nil {
		if w.logger != nil {
			w.logger.Warn("trace: failed to marshal line for %s: %v", path, err)
		}
		return
	}
	data = append(data, '\n')

	w.mu.Lock()
	w.pending = append(w.pending, pendingTraceLine{path: path, data: data})
	if w.timer == nil {
		w.timer = time.AfterFunc(w.debounce, w.flush)
	}
	w.mu.Unlock()
}

// flush appends all pending lines, grouped per file, in enqueue order. It
// creates files as needed (O_APPEND|O_CREATE, 0o644 — same mode/flags as the
// previous appendJSONLine) and tolerates partial last lines, like before.
// Safe for concurrent use; a timer-triggered flush and a synchronous flush
// serialize on the mutex.
func (w *bufferedTraceWriter) flush() {
	w.mu.Lock()
	// Take ownership of the queue; late arrivals enqueue after this point and
	// schedule a fresh timer, so no line is ever stranded without a flusher.
	batch := w.pending
	w.pending = nil
	w.timer = nil
	w.mu.Unlock()

	if len(batch) == 0 {
		return
	}

	// Group by path, preserving first-seen order. Every line still reaches
	// disk; grouping only cuts the open/close cycles to one per file.
	order := make([]string, 0, 4)
	idx := make(map[string]int)
	for _, pl := range batch {
		if _, ok := idx[pl.path]; !ok {
			idx[pl.path] = len(order)
			order = append(order, pl.path)
		}
	}

	failed := make(map[string]bool, len(order))
	for _, path := range order {
		var buf bytes.Buffer
		for _, pl := range batch {
			if pl.path == path {
				buf.Write(pl.data)
			}
		}
		if err := appendFileBatch(path, buf.Bytes()); err != nil {
			// Keep the request path unaffected: log and drop, exactly like
			// the previous per-line Warn on appendJSONLine failure.
			if w.logger != nil {
				w.logger.Warn("trace: failed to append batch to %s: %v", path, err)
			}
			failed[path] = true
		}
	}
	if len(failed) > 0 {
		// Drop the failed batch entirely: retrying would reorder lines
		// relative to later flushes and the sweep tolerates missing lines
		// (partial last lines / evicted files are normal states).
		return
	}
}

// appendFileBatch writes one pre-assembled batch of complete JSONL lines to
// path with a single open/write/close cycle.
func appendFileBatch(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

// Flush synchronously appends all pending lines (shutdown drain: App.Shutdown
// and the settings PATCH/reload paths call this before the process state is
// torn down). It cancels any scheduled debounce flush.
func (w *bufferedTraceWriter) Flush() {
	w.mu.Lock()
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.mu.Unlock()
	w.flush()
}

// discard empties the buffer without writing. Unused by the proxy handler
// today (SetRequestLogDir flushes before repointing so lines land in the
// directory they were built for); kept for symmetric lifecycle handling.
func (w *bufferedTraceWriter) discard() {
	w.mu.Lock()
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.pending = nil
	w.mu.Unlock()
}
