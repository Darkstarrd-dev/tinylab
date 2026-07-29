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

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

// ErrCancelled is returned when a job is cancelled.
var ErrCancelled = errors.New("cancelled")
var ffmpegCommonFlags = []string{"-y", "-nostdin", "-hide_banner", "-progress", "pipe:1", "-nostats", "-loglevel", "error"}

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

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start ffmpeg: %w", err)
	}

	// Cancel kills the entire process tree.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			procutil.KillProcessGroup(cmd.Process.Pid)
			return nil
		}
		return nil
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
