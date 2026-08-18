package assistant

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Event represents an assistant proactive notification or progress event.
type Event struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`                // "notify", "task_done", "model_alert", "todo_due", "dispatch_progress"
	Area      string         `json:"area,omitempty"`      // "download", "imagebatch", "model", "todo", "trace", "system"
	Title     string         `json:"title"`
	Message   string         `json:"message"`
	Level     string         `json:"level"`               // "info", "success", "warning", "error"
	Timestamp int64          `json:"timestamp"`
	Data      map[string]any `json:"data,omitempty"`
}

// EventBroadcaster manages active SSE client subscribers for assistant events.
type EventBroadcaster struct {
	mu          sync.RWMutex
	subscribers map[chan Event]struct{}
}

// NewEventBroadcaster creates an initialized EventBroadcaster.
func NewEventBroadcaster() *EventBroadcaster {
	return &EventBroadcaster{
		subscribers: make(map[chan Event]struct{}),
	}
}

// Subscribe returns a channel that receives newly broadcast events, and an unsubscribe func.
func (b *EventBroadcaster) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()

	unsub := func() {
		b.mu.Lock()
		delete(b.subscribers, ch)
		b.mu.Unlock()
		// Drain any remaining items
		for len(ch) > 0 {
			<-ch
		}
	}
	return ch, unsub
}

// Broadcast sends an event to all active subscribers.
func (b *EventBroadcaster) Broadcast(evt Event) {
	if evt.Timestamp == 0 {
		evt.Timestamp = time.Now().UnixMilli()
	}
	b.mu.RLock()
	defer b.mu.RUnlock()

	for ch := range b.subscribers {
		select {
		case ch <- evt:
		default:
			// Subscriber buffer full, drop to avoid blocking
		}
	}
}

// ServeSSE handles the SSE endpoint for clients.
func (b *EventBroadcaster) ServeSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Send initial connection event
	fmt.Fprintf(w, "event: connected\ndata: {}\n\n")
	flusher.Flush()

	events, unsub := b.Subscribe()
	defer unsub()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		case evt, ok := <-events:
			if !ok {
				return
			}
			data, err := json.Marshal(evt)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, string(data))
			flusher.Flush()
		}
	}
}
