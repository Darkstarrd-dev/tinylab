package assistant

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/tinylab/tinylab/internal/fsutil"
)

const (
	SummarizeSystemPrompt = "你是助手记忆整理器。根据「既有记忆」和「新对话记录」，归纳用户画像记忆：用户的爱好、习惯、偏好、重要个人信息与长期约定。规则：1) 只保留长期有用的信息，丢弃寒暄与一次性事务；2) 与旧记忆冲突时以新对话为准；3) 只输出更新后的 markdown 记忆正文（可用小标题与列表），不输出解释或代码围栏；4) 若无值得记录的内容，原样返回既有记忆；5) 全文不超过 800 字。"
)

// MemorySlug sanitizes a preset name into a safe filename slug.
func MemorySlug(name string) string {
	if name == "" {
		return "default"
	}
	var b strings.Builder
	for _, r := range name {
		if r == '.' || r == '-' || r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	s := b.String()
	if s == "" {
		return "default"
	}
	return s
}

type memState struct {
	timer       *time.Timer
	summarizing bool
	content     string
	mtime       time.Time
}

// MemoryManager manages per-preset memory files and idle-time summarization.
type MemoryManager struct {
	Dir       string
	Idle      time.Duration
	History   func(preset string) []ChatMessage
	Summarize func(ctx context.Context, preset ModelPreset, transcript, existing string) (string, error)
	Logf      func(format string, args ...any)

	mu     sync.Mutex
	states map[string]*memState
}

func (m *MemoryManager) ensure() {
	if m.states == nil {
		m.states = make(map[string]*memState)
	}
}

func (m *MemoryManager) stateFor(preset string) *memState {
	m.ensure()
	st, ok := m.states[preset]
	if !ok {
		st = &memState{}
		m.states[preset] = st
	}
	return st
}

// Read returns the memory content for the preset, re-reading from disk when mtime changed.
func (m *MemoryManager) Read(preset string) string {
	path := filepath.Join(m.Dir, MemorySlug(preset)+".md")
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	mt := fi.ModTime()

	m.mu.Lock()
	st := m.stateFor(preset)
	if !st.mtime.IsZero() && st.mtime.Equal(mt) && st.content != "" {
		c := st.content
		m.mu.Unlock()
		return c
	}
	m.mu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	content := string(data)
	m.mu.Lock()
	st = m.stateFor(preset)
	st.content = content
	st.mtime = mt
	m.mu.Unlock()
	return content
}

// NoteTurn resets the idle timer for the preset. Call after each successful chat turn.
func (m *MemoryManager) NoteTurn(p ModelPreset) {
	preset := p.Name
	if preset == "" {
		preset = "default"
	}
	idle := m.Idle
	if idle <= 0 {
		idle = 10 * time.Minute
	}
	m.mu.Lock()
	st := m.stateFor(preset)
	if st.timer != nil {
		st.timer.Stop()
	}
	// Capture preset snapshot for the timer callback.
	snap := p
	st.timer = time.AfterFunc(idle, func() { m.fire(snap) })
	m.mu.Unlock()
}

// Stop cancels all pending timers (useful in tests).
func (m *MemoryManager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, st := range m.states {
		if st.timer != nil {
			st.timer.Stop()
		}
	}
}

func (m *MemoryManager) fire(preset ModelPreset) {
	name := preset.Name
	if name == "" {
		name = "default"
	}
	m.mu.Lock()
	st := m.stateFor(name)
	if st.summarizing {
		m.mu.Unlock()
		return
	}
	st.summarizing = true
	m.mu.Unlock()

	defer func() {
		m.mu.Lock()
		m.stateFor(name).summarizing = false
		m.mu.Unlock()
	}()

	if m.History == nil || m.Summarize == nil {
		return
	}
	hist := m.History(name)
	if len(hist) == 0 {
		return
	}
	existing := m.Read(name)
	transcript := buildTranscript(hist)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := m.Summarize(ctx, preset, transcript, existing)
	if err != nil {
		if m.Logf != nil {
			m.Logf("assistant memory: summarize %q failed: %v", name, err)
		}
		return
	}
	result = strings.TrimSpace(result)
	if result == "" {
		return
	}
	path := filepath.Join(m.Dir, MemorySlug(name)+".md")
	if err := os.MkdirAll(m.Dir, 0755); err != nil {
		if m.Logf != nil {
			m.Logf("assistant memory: mkdir failed: %v", err)
		}
		return
	}
	if err := fsutil.AtomicWrite(path, []byte(result), 0644); err != nil {
		if m.Logf != nil {
			m.Logf("assistant memory: write %q failed: %v", name, err)
		}
		return
	}
	// Update cache.
	if fi, err := os.Stat(path); err == nil {
		m.mu.Lock()
		cached := m.stateFor(name)
		cached.content = result
		cached.mtime = fi.ModTime()
		m.mu.Unlock()
	}
}

func buildTranscript(hist []ChatMessage) string {
	// Keep last 40, cap total chars to 8000 (drop oldest).
	if len(hist) > 40 {
		hist = hist[len(hist)-40:]
	}
	var b strings.Builder
	for _, m := range hist {
		var prefix string
		switch m.Role {
		case "user":
			prefix = "用户: "
		case "assistant":
			prefix = "助手: "
		default:
			prefix = m.Role + ": "
		}
		line := prefix + m.Content + "\n"
		// If adding this line would exceed 8000, drop oldest lines first.
		if b.Len()+len(line) > 8000 && b.Len() > 0 {
			// Trim from front to make room.
			s := b.String()
			need := b.Len() + len(line) - 8000
			// Find next newline after need.
			cut := need
			if idx := strings.Index(s[need:], "\n"); idx >= 0 {
				cut = need + idx + 1
			}
			b.Reset()
			b.WriteString(s[cut:])
		}
		b.WriteString(line)
	}
	return b.String()
}
