package assistant

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

//go:embed reactions.json
var reactionsJSON []byte

// Reaction specifies one active perception -> action/notification rule.
type Reaction struct {
	When         string `json:"when"`                   // "task.done", "model.unavailable", "schedule", "todo.due"
	Area         string `json:"area,omitempty"`         // "download", "imagebatch", "model", "todo", etc.
	Status       string `json:"status,omitempty"`       // "completed", "failed"
	ThresholdSec int    `json:"thresholdSec,omitempty"`
	Then         string `json:"then"`                   // "notify", "dispatch:<tool>"
	Msg          string `json:"msg,omitempty"`
	Auto         bool   `json:"auto,omitempty"`
	AutoSwitch   string `json:"autoSwitch,omitempty"`   // "suggest", "auto"
}

// ReactionsContract contains declared reactions.
type ReactionsContract struct {
	Reactions []Reaction `json:"reactions"`
}

// LoadReactions parses the embedded reactions.json contract.
func LoadReactions() (*ReactionsContract, error) {
	var c ReactionsContract
	if err := json.Unmarshal(reactionsJSON, &c); err != nil {
		return nil, fmt.Errorf("parse reactions.json: %w", err)
	}
	return &c, nil
}

// TodoInfo carries essential data for due reminder evaluation.
type TodoInfo struct {
	ID   string
	Text string
}

// Reactor coordinates reactive perception, background sweeps, and assistant events.
type Reactor struct {
	contract     *ReactionsContract
	notifyFn     func(area, title, message, level string, data map[string]any)
	dispatchFn   func(tool string, args map[string]any)
	modelChecker func() map[string]bool // returns model -> isAvailable
	todoChecker  func() []TodoInfo
	mu           sync.RWMutex
	running      bool
}

// NewReactor constructs a new Reactor instance.
func NewReactor(contract *ReactionsContract, notifyFn func(area, title, message, level string, data map[string]any), dispatchFn func(tool string, args map[string]any)) *Reactor {
	if contract == nil {
		contract, _ = LoadReactions()
	}
	return &Reactor{
		contract:   contract,
		notifyFn:   notifyFn,
		dispatchFn: dispatchFn,
	}
}

// SetModelChecker wires the model availability probe.
func (r *Reactor) SetModelChecker(checker func() map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modelChecker = checker
}

// SetTodoChecker wires the due todo retriever.
func (r *Reactor) SetTodoChecker(checker func() []TodoInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.todoChecker = checker
}

// HandleTaskDone evaluates task completion/failure signals (R3).
func (r *Reactor) HandleTaskDone(area, title, status string, data map[string]any) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	level := "info"
	if status == "completed" || status == "success" {
		level = "success"
	} else if status == "failed" || status == "error" {
		level = "error"
	}

	for _, rx := range r.contract.Reactions {
		if rx.When != "task.done" {
			continue
		}
		if rx.Area != "" && !strings.EqualFold(rx.Area, area) {
			continue
		}
		if rx.Status != "" && !strings.EqualFold(rx.Status, status) {
			continue
		}

		msg := rx.Msg
		if msg == "" {
			if status == "completed" {
				msg = fmt.Sprintf("[%s] 任务完成: %s", area, title)
			} else {
				msg = fmt.Sprintf("[%s] 任务异常: %s", area, title)
			}
		} else {
			msg = strings.ReplaceAll(msg, "{title}", title)
		}

		if r.notifyFn != nil {
			r.notifyFn(area, "任务状态更新", msg, level, data)
		}
		break
	}
}

// HandleModelAlert evaluates model unavailability alerts (R4/R5).
func (r *Reactor) HandleModelAlert(model string, available bool, reason string) {
	if available {
		return
	}
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, rx := range r.contract.Reactions {
		if rx.When != "model.unavailable" {
			continue
		}
		title := "模型不可用告警"
		msg := fmt.Sprintf("模型 [%s] 当前持续不可用", model)
		if reason != "" {
			msg += " (" + reason + ")"
		}
		if rx.AutoSwitch == "suggest" {
			msg += "，建议切换到可用模型或检查 Provider 状态"
		}

		if r.notifyFn != nil {
			r.notifyFn("model", title, msg, "warning", map[string]any{
				"model":      model,
				"reason":     reason,
				"autoSwitch": rx.AutoSwitch,
			})
		}
		break
	}
}

// HandleTodoDue fires a reminder when a todo reaches its due date (R2).
func (r *Reactor) HandleTodoDue(text string) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, rx := range r.contract.Reactions {
		if rx.When != "todo.due" {
			continue
		}
		msg := rx.Msg
		if msg == "" {
			msg = "待办提醒: " + text
		} else {
			msg = strings.ReplaceAll(msg, "{text}", text)
		}

		if r.notifyFn != nil {
			r.notifyFn("todo", "待办事项提醒", msg, "info", map[string]any{
				"text": text,
			})
		}
		break
	}
}

// Start begins periodic background checks for todos and model availability.
func (r *Reactor) Start(ctx context.Context) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	r.running = true
	r.mu.Unlock()

	ticker := time.NewTicker(15 * time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.tick()
			}
		}
	}()
}

func (r *Reactor) tick() {
	r.mu.RLock()
	todoChk := r.todoChecker
	modelChk := r.modelChecker
	r.mu.RUnlock()

	// Check due todos (R2)
	if todoChk != nil {
		for _, td := range todoChk() {
			r.HandleTodoDue(td.Text)
		}
	}

	// Check model availability (R4/R5)
	if modelChk != nil {
		statusMap := modelChk()
		for model, avail := range statusMap {
			if !avail {
				r.HandleModelAlert(model, false, "全部 Key 已达到配额或处于冷却锁")
			}
		}
	}
}
