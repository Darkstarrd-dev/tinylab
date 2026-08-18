package textreview

import "encoding/json"

// Event types broadcast over SSE.
const (
	EventChunk  = "chunk"
	EventStatus = "status"
	EventNode   = "node"
	EventRaw    = "raw"
)

// Event is the SSE payload sent to subscribers. Fields are omitempty so each
// event type carries only what it needs. ChapterIdx is a pointer so that
// chapter-level events (including chapter 0) always serialize the field,
// while session-level events (nil) omit it.
type Event struct {
	Type       string        `json:"type"`
	ChapterIdx *int          `json:"chapterIdx,omitempty"`
	Delta      string        `json:"delta,omitempty"`
	Section    string        `json:"section,omitempty"` // "thinking" | "content"
	Status     string        `json:"status,omitempty"`
	NodeID     string        `json:"nodeId,omitempty"`
	Error      string        `json:"error,omitempty"`
	Nodes      []NodeRuntime `json:"nodes,omitempty"`
}

// intPtr returns a pointer to n, used to populate Event.ChapterIdx for
// chapter-level events (including chapter 0).
func intPtr(n int) *int { return &n }

// JSON encodes an Event to JSON bytes.
func (e Event) JSON() []byte {
	b, _ := json.Marshal(e)
	return b
}

// Subscriber holds one SSE client's channel. ch is buffered; broadcast drops
// (non-blocking) when full — the client catches up via GET snapshot on
// reconnect. The SSE handler terminates on r.Context().Done() (client
// disconnect), so no separate done channel is needed.
type Subscriber struct {
	ch chan Event
}

// Events returns the channel the SSE handler reads from.
func (sub *Subscriber) Events() <-chan Event { return sub.ch }

// Subscribe registers a new subscriber for the session. Caller must call
// Unsubscribe when the SSE handler exits (client disconnect or session gone).
func Subscribe(s *Session) *Subscriber {
	sub := &Subscriber{ch: make(chan Event, 64)}
	s.lock()
	s.subs = append(s.subs, sub)
	s.unlock()
	return sub
}

// Unsubscribe removes a subscriber from the session's list.
func Unsubscribe(s *Session, sub *Subscriber) {
	s.lock()
	for i, x := range s.subs {
		if x == sub {
			s.subs = append(s.subs[:i], s.subs[i+1:]...)
			break
		}
	}
	s.unlock()
}

// broadcast sends evt to every subscriber non-blocking: a full channel is
// skipped (the client will reconcile via snapshot on reconnect).
func broadcast(s *Session, evt Event) {
	s.lock()
	subs := make([]*Subscriber, len(s.subs))
	copy(subs, s.subs)
	s.unlock()
	for _, sub := range subs {
		select {
		case sub.ch <- evt:
		default:
			// drop — subscriber too slow; snapshot compensates
		}
	}
}
