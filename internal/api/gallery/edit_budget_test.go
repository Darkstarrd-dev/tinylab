package gallery

import (
	"errors"
	"net/http"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
)

// TestMediaStartStatus_TooManyJobs verifies the ffmpeg concurrency overload is
// reported as 429 (never a 200 with a job that was not started) — the HTTP
// half of audit_fix.md F-15's mediaedit semaphore contract.
func TestMediaStartStatus_TooManyJobs(t *testing.T) {
	status, msg := mediaStartStatus(mediaedit.ErrTooManyJobs)
	if status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", status)
	}
	if msg == "" {
		t.Fatal("expected a non-empty message")
	}
}

// TestMediaStartStatus_OtherErrors verifies all other Start failures keep the
// existing 400 contract.
func TestMediaStartStatus_OtherErrors(t *testing.T) {
	status, msg := mediaStartStatus(errors.New("boom"))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	if msg != "failed to start job: boom" {
		t.Fatalf("msg = %q, want %q", msg, "failed to start job: boom")
	}
}
