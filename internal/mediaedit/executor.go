package mediaedit

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/tinylab/tinylab/internal/procutil"
)

// ErrCancelled is returned when a job is cancelled.
var ErrCancelled = errors.New("cancelled")

// ffmpegCommonFlags are prepended to every ffmpeg invocation. The protocol
// whitelist restricts inputs and outputs to local files plus the stdout
// progress pipe (-progress pipe:1): network URLs (http/https/rtmp/tcp/...)
// are refused by ffmpeg itself, closing the ffmpeg SSRF vector even if a
// hostile path reaches the command line.
var ffmpegCommonFlags = []string{"-y", "-nostdin", "-hide_banner", "-progress", "pipe:1", "-nostats", "-loglevel", "error", "-protocol_whitelist", "file,pipe"}

// --- tailBuffer ---

// tailBuffer is a fixed-size ring buffer for the last N bytes of ffmpeg output.
type tailBuffer struct {
	mu       sync.Mutex
	buf      []byte
	maxBytes int
}

func newTailBuffer(maxBytes int) *tailBuffer {
	if maxBytes <= 0 {
		maxBytes = 8 * 1024
	}
	return &tailBuffer{maxBytes: maxBytes}
}

// Append appends text to the tail buffer, discarding oldest content if over capacity.
func (t *tailBuffer) Append(s string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, s...)
	if len(t.buf) > t.maxBytes {
		t.buf = t.buf[len(t.buf)-t.maxBytes:]
	}
}

// Read returns a copy of the current buffer content.
func (t *tailBuffer) Read() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// --- ffmpeg runner ---

// RunFfmpeg runs ffmpeg with the given args, streaming progress and capturing
// stderr. Returns an error if the process exits non-zero or is cancelled.
//
// The common prefix flags (-y, -nostdin, -hide_banner, -progress pipe:1,
// -nostats, -loglevel error) are prepended automatically. The caller supplies
// the operation-specific args and output path.
func RunFfmpeg(ctx context.Context, ffmpegPath string, args []string, outputPath string, sourceDuration float64, onProgress func(percent int), stderrTail *tailBuffer) error {
	fullArgs := append([]string{}, ffmpegCommonFlags...)
	fullArgs = append(fullArgs, args...)
	fullArgs = append(fullArgs, outputPath)

	cmd := exec.CommandContext(ctx, ffmpegPath, fullArgs...)
	_ = procutil.SetProcessGroup(cmd)

	// Cancel kills the entire process tree. It must be installed before Start:
	// CommandContext already sets a default Cancel, and Start launches the
	// watchCtx goroutine that reads cmd.Cancel (os/exec Start -> watchCtx), so a
	// post-Start assignment races with that read and leaves a window where the
	// default single-process kill can fire instead of the tree kill. watchCtx
	// only invokes Cancel after Start has set cmd.Process, so the nil check is
	// for defensive completeness.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			procutil.KillProcessGroup(cmd.Process.Pid)
		}
		return nil
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		// A cancel that lands before the process starts is a cancellation, not
		// a failure: exec.CommandContext reports "exec: context canceled".
		// Classify it as ErrCancelled so callers surface StatusCancelled and
		// the job is never mislabeled as an ffmpeg error.
		if ctx.Err() == context.Canceled {
			return ErrCancelled
		}
		return fmt.Errorf("start ffmpeg: %w", err)
	}

	// Read stderr into tail buffer.
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			stderrTail.Append(line + "\n")
		}
	}()

	// Read stdout for progress (key=value lines, blocks terminated by "progress=continue" or "progress=end").
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Track parsed fields across lines within a progress block.
	var outTimeUs int64
	for scanner.Scan() {
		line := scanner.Text()

		// Progress lines: key=value
		if eq := strings.IndexByte(line, '='); eq >= 0 {
			key := line[:eq]
			value := line[eq+1:]

			switch key {
			case "out_time_us":
				outTimeUs, _ = strconv.ParseInt(value, 10, 64)
			case "progress":
				// End of progress block; compute percentage.
				if sourceDuration > 0 && outTimeUs > 0 {
					pct := int(float64(outTimeUs) / (sourceDuration * 1_000_000) * 100)
					if pct < 0 {
						pct = 0
					}
					if pct > 100 {
						pct = 100
					}
					onProgress(pct)
				}
				outTimeUs = 0
			}
		}

		// Also capture stdout in the log tail for debugging.
		stderrTail.Append(line + "\n")
	}

	if err := cmd.Wait(); err != nil {
		if ctx.Err() == context.Canceled {
			return ErrCancelled
		}
		tail := stderrTail.Read()
		return fmt.Errorf("ffmpeg error: %s", strings.TrimSpace(tail))
	}

	return nil
}

// FfmpegCommandString returns a human-readable ffmpeg command line string
// for display purposes (not executed).
func FfmpegCommandString(ffmpegPath string, args []string, outputPath string) string {
	full := append(append([]string{}, ffmpegCommonFlags...), args...)
	full = append(full, outputPath)
	return ffmpegPath + " " + strings.Join(full, " ")
}
