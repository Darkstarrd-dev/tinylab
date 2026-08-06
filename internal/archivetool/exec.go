package archivetool

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

// stderrTailMax bounds how much tool stderr is retained for diagnostics.
const stderrTailMax = 16 << 10

// runTool executes toolPath with the given argv (never through a shell),
// applies the timeout via a child context, runs the command in its own
// process group (killed as a tree on timeout/cancel), and bounds stdout to
// maxStdout and stderr to stderrTailMax bytes.
//
// A stdout overflow (more than maxStdout bytes produced) aborts the child and
// returns an *archive.BudgetError (Dimension "entry-bytes") so callers can
// never be handed truncated entry data. Non-zero exits are classified into
// ToolError kinds from the exit code and the stderr tail.
func runTool(parent context.Context, toolPath string, timeout time.Duration, maxStdout int64, args ...string) ([]byte, string, error) {
	return runToolDir(parent, toolPath, "", timeout, maxStdout, args...)
}

// runToolDir is runTool with an explicit working directory (used for pack so
// archive entry names are the staged relative basenames, never absolute
// paths).
func runToolDir(parent context.Context, toolPath, dir string, timeout time.Duration, maxStdout int64, args ...string) ([]byte, string, error) {
	if parent == nil {
		parent = context.Background()
	}
	ctx := parent
	cancel := func() {}
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(parent, timeout)
	}
	defer cancel()

	cmd := exec.CommandContext(ctx, toolPath, args...)
	cmd.Dir = dir
	if err := procutil.SetProcessGroup(cmd); err != nil {
		return nil, "", err
	}

	stdout := &capBuffer{limit: maxStdout}
	stderr := &tailBuffer{max: stderrTailMax}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return nil, "", err
	}
	// If the deadline fires or the caller cancels, kill the whole process
	// tree, not just the direct child (7z/rar do not normally fork, but a
	// wrapped launcher or future tool might).
	go func() {
		<-ctx.Done()
		_ = procutil.KillProcessGroup(cmd.Process.Pid)
	}()

	err := cmd.Wait()
	if stdout.overflowed {
		// The child may still be alive after the pipe broke; make sure the
		// tree is gone before reporting the budget error.
		_ = procutil.KillProcessGroup(cmd.Process.Pid)
		return nil, stderr.String(), &archive.BudgetError{
			Dimension: "entry-bytes",
			Limit:     maxStdout,
			Actual:    stdout.n,
		}
	}
	return stdout.Bytes(), stderr.String(), classifyToolError(toolPath, err, stderr.String())
}

// classifyToolError maps an exec error into the stable ToolError kinds.
// Exit-code and stderr heuristics distinguish encrypted archives, multi-volume
// archives, corrupt archives and missing entries from generic failures.
func classifyToolError(toolPath string, err error, stderr string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &ToolError{Kind: ErrToolTimeout, Tool: toolPath, Detail: "tool exceeded its deadline", Err: err}
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return &ToolError{Kind: ErrToolFailed, Tool: toolPath, Err: err}
	}
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "password") || strings.Contains(low, "encrypted"):
		return &ToolError{Kind: ErrEncrypted, Tool: toolPath, Detail: "encrypted archives are not supported", Err: err}
	case strings.Contains(low, "volume") || strings.Contains(low, "part "):
		return &ToolError{Kind: ErrMultiVolume, Tool: toolPath, Detail: "multi-volume archives are not supported", Err: err}
	case strings.Contains(low, "no files to process") || strings.Contains(low, "no files to extract") ||
		strings.Contains(low, "no files found"):
		return fmt.Errorf("archive entry not found: %w (tool %s)", archive.ErrEntryNotFound, toolPath)
	case strings.Contains(low, "crc") || strings.Contains(low, "corrupt") ||
		strings.Contains(low, "cannot open") || strings.Contains(low, "not archive") ||
		strings.Contains(low, "format not recognised") || strings.Contains(low, "unsupported method") ||
		strings.Contains(low, "is not rar archive") || strings.Contains(low, "is not 7z archive"):
		return &ToolError{Kind: ErrCorrupt, Tool: toolPath, Detail: "archive is damaged or unreadable", Err: err}
	}
	return &ToolError{Kind: ErrToolFailed, Tool: toolPath, Detail: fmt.Sprintf("tool exited with code %d", exitErr.ExitCode()), Err: err}
}

// capBuffer accumulates stdout up to limit bytes; the limit+1st byte sets
// overflowed (and stops buffering) so the exec copy goroutine observes a
// write error, the pipe breaks, and the child is killed.
type capBuffer struct {
	limit      int64
	n          int64
	overflowed bool
	buf        []byte
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if c.overflowed {
		return 0, errors.New("stdout cap exceeded")
	}
	room := c.limit - c.n
	if room <= 0 {
		c.overflowed = true
		c.buf = nil // drop partial data: it is not a complete entry
		return 0, errors.New("stdout cap exceeded")
	}
	if int64(len(p)) > room {
		c.overflowed = true
		c.buf = nil
		c.n += int64(len(p))
		return 0, errors.New("stdout cap exceeded")
	}
	c.n += int64(len(p))
	c.buf = append(c.buf, p...)
	return len(p), nil
}

func (c *capBuffer) Bytes() []byte { return c.buf }

// tailBuffer keeps only the last max bytes of stderr.
type tailBuffer struct {
	max int
	buf bytes.Buffer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf.Write(p)
	if t.buf.Len() > t.max {
		drop := t.buf.Len() - t.max
		trimmed := t.buf.Bytes()
		trimmed = append([]byte(nil), trimmed[drop:]...)
		t.buf.Reset()
		t.buf.Write(trimmed)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return t.buf.String() }
