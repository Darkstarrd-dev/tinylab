package console

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Logger captures application logs into a ring buffer and broadcasts to SSE subscribers.
type Logger struct {
	mu       sync.RWMutex
	buffer   []string
	maxLines int
	head     int
	size     int
	subs     map[chan string]struct{}
}

// New creates a Logger with the given buffer capacity.
func New(maxLines int) *Logger {
	if maxLines <= 0 {
		maxLines = 200
	}
	return &Logger{
		buffer:   make([]string, maxLines),
		maxLines: maxLines,
		subs:     make(map[chan string]struct{}),
	}
}

func (l *Logger) timestamp() string {
	return time.Now().Format("2006-01-02 15:04:05")
}

// sanitize renders control characters in a log line as visible escapes so
// that message content can never forge additional lines (CR/LF) or inject
// terminal escape sequences (ESC/C0 controls). Every C0 control character
// and DEL is replaced with a short textual escape (\n, \r, \t, or \xNN);
// ordinary Unicode (valid UTF-8) passes through untouched.
func sanitize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			b.WriteString(fmt.Sprintf(`\x%02x`, r))
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// emit delivers one fully formatted log line to stdout, the ring buffer, and
// every SSE subscriber. It is the single choke point every log line passes
// through: sanitize runs here, so no caller can bypass it.
func (l *Logger) emit(line string) {
	line = sanitize(line)
	fmt.Println(line)
	l.write(line)
}

func (l *Logger) write(line string) {
	l.mu.Lock()

	l.buffer[l.head] = line
	l.head = (l.head + 1) % l.maxLines
	if l.size < l.maxLines {
		l.size++
	}

	chans := make([]chan string, 0, len(l.subs))
	for ch := range l.subs {
		chans = append(chans, ch)
	}
	l.mu.Unlock()

	for _, ch := range chans {
		select {
		case ch <- line:
		default:
		}
	}
}

// Log writes a log line at info level.
func (l *Logger) Log(format string, args ...any) {
	l.emit(fmt.Sprintf("[%s] %s", l.timestamp(), fmt.Sprintf(format, args...)))
}

// Info writes an info-level log line.
func (l *Logger) Info(format string, args ...any) {
	l.Log(format, args...)
}

// Warn writes a warning-level log line.
func (l *Logger) Warn(format string, args ...any) {
	l.emit(fmt.Sprintf("[%s] ⚠ %s", l.timestamp(), fmt.Sprintf(format, args...)))
}

// Error writes an error-level log line.
func (l *Logger) Error(format string, args ...any) {
	l.emit(fmt.Sprintf("[%s] [ERROR] %s", l.timestamp(), fmt.Sprintf(format, args...)))
}

// Debug writes a debug-level log line.
func (l *Logger) Debug(format string, args ...any) {
	l.emit(fmt.Sprintf("[%s] [DEBUG] %s", l.timestamp(), fmt.Sprintf(format, args...)))
}

// AllLines returns all buffered lines in chronological order.
func (l *Logger) AllLines() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	result := make([]string, l.size)
	for i := 0; i < l.size; i++ {
		idx := (l.head - l.size + i + l.maxLines) % l.maxLines
		result[i] = l.buffer[idx]
	}
	return result
}

// Subscribe returns a channel that receives new log lines.
func (l *Logger) Subscribe() chan string {
	ch := make(chan string, 100)
	l.mu.Lock()
	l.subs[ch] = struct{}{}
	l.mu.Unlock()
	return ch
}

// Unsubscribe removes a subscriber channel.
func (l *Logger) Unsubscribe(ch chan string) {
	l.mu.Lock()
	delete(l.subs, ch)
	l.mu.Unlock()
}

// Clear empties the log buffer.
func (l *Logger) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.head = 0
	l.size = 0
}
