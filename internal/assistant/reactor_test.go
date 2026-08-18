package assistant

import (
	"context"
	"sync/atomic"
	"testing"
)

func TestLoadReactions(t *testing.T) {
	c, err := LoadReactions()
	if err != nil {
		t.Fatalf("LoadReactions failed: %v", err)
	}
	if len(c.Reactions) == 0 {
		t.Fatal("expected non-empty reactions contract")
	}
}

func TestReactorTaskDoneAndModelAlert(t *testing.T) {
	var notified atomic.Int32
	var lastArea string

	notifyFn := func(area, title, message, level string, data map[string]any) {
		notified.Add(1)
		lastArea = area
	}

	reactor := NewReactor(nil, notifyFn, nil)

	// Test task.done
	reactor.HandleTaskDone("download", "My Video", "completed", map[string]any{"id": "123"})
	if notified.Load() != 1 || lastArea != "download" {
		t.Fatalf("expected download task notification, got count=%d, area=%s", notified.Load(), lastArea)
	}

	// Test model alert
	reactor.HandleModelAlert("gpt-4o", false, "quota exceeded")
	if notified.Load() != 2 || lastArea != "model" {
		t.Fatalf("expected model alert, got count=%d, area=%s", notified.Load(), lastArea)
	}

	// Test todo due
	reactor.HandleTodoDue("Buy milk")
	if notified.Load() != 3 || lastArea != "todo" {
		t.Fatalf("expected todo reminder, got count=%d, area=%s", notified.Load(), lastArea)
	}
}

func TestReactorTickLoop(t *testing.T) {
	var notified atomic.Int32

	notifyFn := func(area, title, message, level string, data map[string]any) {
		notified.Add(1)
	}

	reactor := NewReactor(nil, notifyFn, nil)
	reactor.SetTodoChecker(func() []TodoInfo {
		return []TodoInfo{{ID: "1", Text: "Scheduled Task"}}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reactor.Start(ctx)

	// Manually trigger tick for fast verification
	reactor.tick()

	if notified.Load() < 1 {
		t.Fatalf("expected at least 1 notification after tick, got %d", notified.Load())
	}
}
