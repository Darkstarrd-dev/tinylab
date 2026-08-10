package imagebatch

import (
	"context"
	"errors"
	"testing"
	"time"
)

type failingBatchGenerator struct{ err error }

func (g failingBatchGenerator) Generate(context.Context, ImageGenerationRequest) (ImageGenerationResult, error) {
	return ImageGenerationResult{}, g.err
}

func TestSchedulerPersistsFailureDetailsAndTerminalStatus(t *testing.T) {
	store, err := NewProjectStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(store, failingBatchGenerator{err: errors.New("provider rejected request: 400")})
	p := validProject()
	p.ProjectID = "imgproj_fail"
	p.Slug = "failure-details"
	p.BatchConfig.MaxRetries = 0
	p.BatchConfig.OnError = OnErrorContinue
	created, err := m.Create(context.Background(), &p)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Shutdown()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, getErr := m.Get(context.Background(), created.ProjectID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if snapshot.Status == ProjectCompletedWithErrors {
			if snapshot.LastError == "" || snapshot.Prompts[0].Variants[0].LastError == "" {
				t.Fatalf("failure details missing: %+v", snapshot)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	snapshot, _ := m.Get(context.Background(), created.ProjectID)
	t.Fatalf("scheduler did not reach completed_with_errors: %+v", snapshot)
}
