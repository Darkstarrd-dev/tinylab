package console

import (
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLogger_Info(t *testing.T) {
	l := New(10)
	l.Info("hello %s", "world")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "hello world") {
		t.Errorf("expected 'hello world' in line, got %s", lines[0])
	}
}

func TestLogger_Warn(t *testing.T) {
	l := New(10)
	l.Warn("something suspicious")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "⚠") {
		t.Errorf("expected ⚠ in warn line, got %s", lines[0])
	}
	if !strings.Contains(lines[0], "something suspicious") {
		t.Errorf("expected message in line, got %s", lines[0])
	}
}

func TestLogger_Error(t *testing.T) {
	l := New(10)
	l.Error("something broke")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "[ERROR]") {
		t.Errorf("expected [ERROR] in error line, got %s", lines[0])
	}
}

func TestLogger_Debug(t *testing.T) {
	l := New(10)
	l.Debug("debug info")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "[DEBUG]") {
		t.Errorf("expected [DEBUG] in debug line, got %s", lines[0])
	}
}

func TestLogger_Overflow(t *testing.T) {
	l := New(3)
	for i := 0; i < 5; i++ {
		l.Info("line %d", i)
	}

	lines := l.AllLines()
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if !strings.Contains(lines[0], "line 2") {
		t.Errorf("expected oldest kept 'line 2' at [0], got %s", lines[0])
	}
	if !strings.Contains(lines[2], "line 4") {
		t.Errorf("expected newest 'line 4' at [2], got %s", lines[2])
	}
}

func TestLogger_Clear(t *testing.T) {
	l := New(10)
	l.Info("hello")
	l.Clear()

	lines := l.AllLines()
	if len(lines) != 0 {
		t.Errorf("expected 0 lines after clear, got %d", len(lines))
	}
}

func TestLogger_Subscribe(t *testing.T) {
	l := New(10)
	ch := l.Subscribe()
	defer l.Unsubscribe(ch)

	l.Info("test message")

	select {
	case line := <-ch:
		if !strings.Contains(line, "test message") {
			t.Errorf("expected 'test message' in line, got %s", line)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for subscribed message")
	}
}

func TestLogger_SubscribeMultiple(t *testing.T) {
	l := New(10)
	ch1 := l.Subscribe()
	ch2 := l.Subscribe()
	defer l.Unsubscribe(ch1)
	defer l.Unsubscribe(ch2)

	l.Info("broadcast")

	for i, ch := range []chan string{ch1, ch2} {
		select {
		case line := <-ch:
			if !strings.Contains(line, "broadcast") {
				t.Errorf("subscriber %d: expected 'broadcast', got %s", i, line)
			}
		case <-time.After(100 * time.Millisecond):
			t.Errorf("subscriber %d: timeout", i)
		}
	}
}

func TestLogger_Unsubscribe(t *testing.T) {
	l := New(10)
	ch := l.Subscribe()
	l.Unsubscribe(ch)

	// After unsubscribe, the channel should not receive new messages.
	l.Info("after unsubscribe")

	time.Sleep(20 * time.Millisecond)
	select {
	case <-ch:
		t.Error("expected no messages after unsubscribe")
	case <-time.After(50 * time.Millisecond):
	}
}

// TestLogger_Sanitize_NoLineForging proves a single Log call always yields a
// single buffer line even when the message embeds CR/LF: the raw control
// bytes are replaced with visible escapes, so untrusted input cannot forge
// additional log lines.
func TestLogger_Sanitize_NoLineForging(t *testing.T) {
	l := New(10)
	l.Info("first\nsecond\rthird")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected exactly 1 line (CR/LF must not forge lines), got %d: %q", len(lines), lines)
	}
	if !strings.Contains(lines[0], "first\\nsecond\\rthird") {
		t.Errorf("expected escaped \\n and \\r in line, got %s", lines[0])
	}
	for _, raw := range []byte{'\n', '\r'} {
		if strings.ContainsRune(lines[0], rune(raw)) {
			t.Errorf("line must not contain raw byte %#x, got %q", raw, lines[0])
		}
	}
}

// TestLogger_Sanitize_NoTerminalEscapes proves ESC and the other C0 controls
// are rendered as visible \xNN escapes, so message content cannot inject
// ANSI escape sequences into the terminal or SSE subscribers.
func TestLogger_Sanitize_NoTerminalEscapes(t *testing.T) {
	l := New(10)
	l.Info("status \x1b[31mred\x1b[0m \x00nul\x07bel")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	if strings.ContainsRune(lines[0], 0x1b) {
		t.Errorf("line must not contain raw ESC, got %q", lines[0])
	}
	if !strings.Contains(lines[0], "\\x1b[31mred\\x1b[0m") {
		t.Errorf("expected escaped \\x1b sequences, got %s", lines[0])
	}
	if !strings.Contains(lines[0], "\\x00nul\\x07bel") {
		t.Errorf("expected escaped \\x00 and \\x07, got %s", lines[0])
	}
}

// TestLogger_Sanitize_SubscriberNoControlBytes proves the SSE subscriber
// channel carries the same sanitized line: a subscribed client can never
// receive a raw CR/LF/ESC byte either.
func TestLogger_Sanitize_SubscriberNoControlBytes(t *testing.T) {
	l := New(10)
	ch := l.Subscribe()
	defer l.Unsubscribe(ch)

	l.Error("evil\x1b[2J\npwned")

	select {
	case line := <-ch:
		for _, raw := range []byte{'\n', '\r', 0x1b} {
			if strings.ContainsRune(line, rune(raw)) {
				t.Errorf("subscriber line must not contain raw byte %#x, got %q", raw, line)
			}
		}
		if !strings.Contains(line, "evil\\x1b[2J\\npwned") {
			t.Errorf("expected fully escaped subscriber line, got %s", line)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for subscriber line")
	}
}

// TestLogger_Sanitize_UnicodePreserved proves ordinary Unicode passes through
// the sanitizer untouched — only control characters are escaped.
func TestLogger_Sanitize_UnicodePreserved(t *testing.T) {
	l := New(10)
	l.Log("你好 wörld ⚠ ✓ €")

	lines := l.AllLines()
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	for _, want := range []string{"你好", "wörld", "⚠", "✓", "€"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("expected Unicode %q to survive sanitization, got %s", want, lines[0])
		}
	}
}

// TestSanitize_AllControlBytes exhaustively proves every C0 control byte and
// DEL is escaped and no control byte survives in the output.
func TestSanitize_AllControlBytes(t *testing.T) {
	in := make([]byte, 0, 33)
	for b := byte(0); b < 0x20; b++ {
		in = append(in, b)
	}
	in = append(in, 0x7f)

	out := sanitize(string(in))
	for b := byte(0); b < 0x20; b++ {
		if strings.ContainsRune(out, rune(b)) {
			t.Errorf("control byte %#02x survived sanitization", b)
		}
	}
	if strings.ContainsRune(out, 0x7f) {
		t.Error("DEL survived sanitization")
	}
	for _, esc := range []string{`\x00`, `\x01`, `\x1b`, `\x1f`, `\x7f`, `\n`, `\r`, `\t`} {
		if !strings.Contains(out, esc) {
			t.Errorf("expected escape %q in output, got %q", esc, out)
		}
	}
}

// TestLogger_Sanitize_StdoutNoLineForging captures the printed stdout line to
// prove the terminal output is sanitized exactly like the buffer: one Log
// call prints exactly one physical line with no raw CR/LF/ESC bytes.
func TestLogger_Sanitize_StdoutNoLineForging(t *testing.T) {
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = oldStdout })

	l := New(10)
	l.Warn("terminal\x1b[31m red\nsecond")
	if err := w.Close(); err != nil {
		t.Fatalf("close pipe writer: %v", err)
	}
	os.Stdout = oldStdout
	out, err := io.ReadAll(r)
	r.Close()
	if err != nil {
		t.Fatalf("read pipe: %v", err)
	}
	s := string(out)
	// fmt.Println appends exactly one trailing newline; any additional newline
	// would mean message content forged an extra terminal line.
	if n := strings.Count(s, "\n"); n != 1 {
		t.Errorf("stdout must contain exactly 1 line terminator (no forged lines), got %d: %q", n, s)
	}
	for _, raw := range []byte{'\r', 0x1b} {
		if strings.ContainsRune(s, rune(raw)) {
			t.Errorf("stdout must not contain raw byte %#x, got %q", raw, s)
		}
	}
	if !strings.Contains(s, "terminal\\x1b[31m red\\nsecond") {
		t.Errorf("expected escaped stdout line, got %q", s)
	}
}
