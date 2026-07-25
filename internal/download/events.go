package download

// Event 是推送给 SSE 订阅者的事件。
type Event struct {
	Type string `json:"type"` // "task-updated" | "queue-updated"
	Task *Task  `json:"task,omitempty"`
}

// Subscribe 订阅事件流（用于 SSE 推送）。
func (m *Manager) Subscribe() chan Event {
	ch := make(chan Event, 64)
	m.mu.Lock()
	m.eventSubs[ch] = struct{}{}
	m.mu.Unlock()
	return ch
}

// Unsubscribe 取消订阅。
func (m *Manager) Unsubscribe(ch chan Event) {
	m.mu.Lock()
	if _, ok := m.eventSubs[ch]; ok {
		delete(m.eventSubs, ch)
		close(ch)
	}
	m.mu.Unlock()
}

// publishEvent 非阻塞地向所有订阅者发送事件。
func (m *Manager) publishEvent(evt Event) {
	m.mu.RLock()
	subs := make([]chan Event, 0, len(m.eventSubs))
	for ch := range m.eventSubs {
		subs = append(subs, ch)
	}
	m.mu.RUnlock()
	for _, ch := range subs {
		select {
		case ch <- evt:
		default:
			// 订阅者过慢，丢弃事件，避免阻塞 worker。
		}
	}
}
