package download

import (
	"errors"
	"time"
)

// Start 启动 worker 池。
func (m *Manager) Start() {
	m.mu.Lock()
	m.started = true
	concurrency := m.maxConcurrent
	m.mu.Unlock()

	for range concurrency {
		m.wg.Add(1)
		go m.worker()
	}
	if m.logger != nil {
		m.logger.Info("download workers started (concurrent=%d)", concurrency)
	}
}

// Stop 停止所有 worker 并取消进行中的任务。
func (m *Manager) Stop() {
	m.mu.Lock()
	select {
	case <-m.stopCh:
	default:
		close(m.stopCh)
	}
	// 取消所有进行中的任务。
	for _, tc := range m.controls {
		tc.cancel()
	}
	pending := m.pendingCh
	m.mu.Unlock()
	m.wg.Wait()
	// D-EN-1: drain residual pendingCh so a fresh Manager does not consume stale IDs.
	for {
		select {
		case <-pending:
		default:
			goto reset
		}
	}
reset:
	m.mu.Lock()
	// Recreate channels for next Start().
	m.pendingCh = make(chan string, 100)
	m.stopCh = make(chan struct{})
	m.started = false
	m.mu.Unlock()
}

// worker 从 pendingCh 取任务并执行，直到 stopCh 关闭或 channel 关闭。
func (m *Manager) worker() {
	defer m.wg.Done()
	for {
		select {
		case <-m.stopCh:
			return
		case taskID, ok := <-m.pendingCh:
			if !ok {
				return
			}
			m.processTask(taskID)
		}
	}
}

// processTask 执行单个任务（在 worker goroutine 中调用）。
func (m *Manager) processTask(taskID string) {
	m.mu.RLock()
	task := m.tasks[taskID]
	tc := m.controls[taskID]
	m.mu.RUnlock()
	if task == nil || tc == nil {
		return
	}

	// 已被取消（例如排队期间取消），直接终态处理，跳过执行。
	if tc.ctx.Err() != nil {
		m.finalizeTask(taskID, StatusCancelled, "", 0)
		return
	}

	// 标记开始。
	m.mu.Lock()
	task.Status = StatusDownloading
	task.StartedAt = time.Now()
	m.active[taskID] = true
	m.mu.Unlock()
	m.publishEvent(Event{Type: "task-updated", Task: m.snapshot(task)})

	progressCh := make(chan Progress, 10)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for p := range progressCh {
			m.updateTaskProgress(taskID, p)
		}
	}()

	filePath, log, err := m.executor.Execute(tc.ctx, task, progressCh)
	close(progressCh)
	<-done

	m.mu.Lock()
	delete(m.active, taskID)
	// Only clean up the control entry we own. If RetryTask already replaced
	// it (cancel→retry race), this stale run must not clobber the new run.
	superseded := false
	if cur, ok := m.controls[taskID]; ok {
		if cur == tc {
			delete(m.controls, taskID)
		} else {
			superseded = true
		}
	}
	// Store log output even on error so users can inspect what happened.
	if !superseded {
		if task, ok := m.tasks[taskID]; ok {
			task.LogTail = log
		}
	}
	m.mu.Unlock()

	if superseded {
		return
	}

	switch {
	case err != nil && errors.Is(err, ErrCancelled):
		m.finalizeTask(taskID, StatusCancelled, "", 0)
	case err != nil:
		m.finalizeTask(taskID, StatusError, err.Error(), 0)
	default:
		m.mu.Lock()
		if t, ok := m.tasks[taskID]; ok {
			t.FilePath = filePath
			t.SavedFile = filePath
		}
		m.mu.Unlock()
		if info, statErr := fileSizeOf(filePath); statErr == nil {
			m.finalizeTask(taskID, StatusCompleted, "", info)
		} else {
			m.finalizeTask(taskID, StatusCompleted, "", 0)
		}
	}
}

// finalizeTask 设置任务终态并发布事件。
func (m *Manager) finalizeTask(taskID string, status TaskStatus, errMsg string, fileSize int64) {
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return
	}
	task.Status = status
	task.CompletedAt = time.Now()
	if errMsg != "" {
		task.Error = errMsg
	}
	if fileSize > 0 {
		task.FileSize = fileSize
	}
	m.mu.Unlock()
	m.publishEvent(Event{Type: "task-updated", Task: m.snapshot(task)})
	m.publishEvent(Event{Type: "queue-updated"})
}

// updateTaskProgress 更新任务进度并发送事件。
func (m *Manager) updateTaskProgress(taskID string, p Progress) {
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return
	}
	task.Progress.Percent = p.Percent
	task.Progress.SpeedBytes = p.SpeedBytes
	task.Progress.Downloaded = p.Downloaded
	task.Progress.TotalBytes = p.TotalBytes
	task.Progress.ETASeconds = p.ETASeconds
	task.Progress.Processing = p.Processing

	if p.Processing && task.Status == StatusDownloading {
		task.Status = StatusProcessing
	}

	if p.LogLine != "" {
		task.LogTail += p.LogLine + "\n"
		const maxLogSize = 64 * 1024
		if len(task.LogTail) > maxLogSize {
			task.LogTail = task.LogTail[len(task.LogTail)-maxLogSize:]
		}
	}
	m.mu.Unlock()
	m.publishEvent(Event{Type: "task-updated", Task: m.snapshot(task)})
}
