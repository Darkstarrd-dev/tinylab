package download

import (
	"context"
	"fmt"
	"time"
)

// CancelTask 取消指定任务。
// 如果任务在队列中等待，直接移除。
// 如果任务正在执行，取消其 context。
func (m *Manager) CancelTask(taskID string) error {
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("task not found")
	}
	if isTerminal(task.Status) {
		m.mu.Unlock()
		return nil
	}
	task.Status = StatusCancelled
	task.CompletedAt = time.Now()
	if tc, ok := m.controls[taskID]; ok {
		tc.cancel()
	}
	m.mu.Unlock()
	m.publishEvent(Event{Type: "task-updated", Task: m.snapshot(task)})
	m.publishEvent(Event{Type: "queue-updated"})
	return nil
}

// RetryTask re-queues a failed or cancelled task, reusing the same task ID so
// the task item stays in place in the UI. Only tasks in StatusError or
// StatusCancelled state can be retried.
func (m *Manager) RetryTask(taskID string) error {
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("task not found")
	}
	if task.Status != StatusError && task.Status != StatusCancelled {
		m.mu.Unlock()
		return fmt.Errorf("task is not in a failed or cancelled state")
	}
	// Reset state for re-execution.
	task.Status = StatusPending
	task.Error = ""
	task.Progress = Progress{}
	task.SavedFile = ""
	task.FilePath = ""
	task.FileSize = 0
	task.StartedAt = time.Time{}
	task.CompletedAt = time.Time{}
	task.LogTail = ""
	// Create new context + cancel for the retry.
	ctx, cancel := context.WithCancel(context.Background())
	m.controls[taskID] = &taskControl{ctx: ctx, cancel: cancel}
	m.mu.Unlock()

	// Enqueue (same non-blocking pattern as CreateTask).
	select {
	case m.pendingCh <- taskID:
	default:
		m.mu.Lock()
		delete(m.controls, taskID)
		m.mu.Unlock()
		m.finalizeTask(taskID, StatusError, "download queue is full", 0)
		return fmt.Errorf("download queue is full")
	}
	m.publishEvent(Event{Type: "task-updated", Task: m.snapshot(task)})
	m.publishEvent(Event{Type: "queue-updated"})
	return nil
}

// ClearCompleted 清除所有已完成的任务。
func (m *Manager) ClearCompleted() {
	m.mu.Lock()
	newOrder := m.order[:0]
	for _, id := range m.order {
		t, ok := m.tasks[id]
		if !ok {
			continue
		}
		if isTerminal(t.Status) {
			delete(m.tasks, id)
			delete(m.controls, id)
			delete(m.active, id)
			continue
		}
		newOrder = append(newOrder, id)
	}
	m.order = newOrder
	m.mu.Unlock()
	m.publishEvent(Event{Type: "queue-updated"})
}

// RemoveTask 从列表中移除指定任务（仅允许终态任务）。
func (m *Manager) RemoveTask(taskID string) error {
	m.mu.Lock()
	t, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("task not found")
	}
	if !isTerminal(t.Status) {
		m.mu.Unlock()
		return fmt.Errorf("only completed tasks can be removed")
	}
	delete(m.tasks, taskID)
	delete(m.controls, taskID)
	delete(m.active, taskID)
	newOrder := make([]string, 0, len(m.order))
	for _, id := range m.order {
		if id != taskID {
			newOrder = append(newOrder, id)
		}
	}
	m.order = newOrder
	m.mu.Unlock()
	m.publishEvent(Event{Type: "queue-updated"})
	return nil
}
