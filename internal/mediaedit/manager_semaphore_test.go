package mediaedit

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// slowFakeFFmpeg writes a fake ffmpeg executable that sleeps long enough to
// hold its concurrency slot deterministically (no real ffmpeg required). It
// ignores the ffmpeg-style argv it receives; RunFfmpeg only reads its
// stdout/stderr pipes, which stay open until the process is killed.
func slowFakeFFmpeg(t *testing.T) string {
	t.Helper()
	le := "\n"
	if runtime.GOOS == "windows" {
		le = "\r\n"
	}
	name := "slow-ffmpeg"
	var content string
	if runtime.GOOS == "windows" {
		name += ".bat"
		// ping -n 20 127.0.0.1 sleeps ~19s without requiring a console.
		content = "@echo off" + le +
			"ping -n 20 127.0.0.1 >nul" + le +
			"exit /b 0" + le
	} else {
		content = "#!/bin/sh" + le + "sleep 20" + le
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	return path
}

// semaphoreTestRequest builds a minimal StartRequest whose validation and arg
// building pass without touching real ffmpeg/ffprobe.
func semaphoreTestRequest(t *testing.T) StartRequest {
	t.Helper()
	src := filepath.Join(t.TempDir(), "in.png")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatalf("create input: %v", err)
	}
	raw, err := json.Marshal(ImageTranscodeParams{Format: "webp", Quality: 80})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return StartRequest{InputPath: src, Operation: "image_transcode", Params: raw}
}

// TestManagerConcurrencyLimit_RejectsWhenFull verifies Start returns
// ErrTooManyJobs (never a fake job) once the ffmpeg concurrency limit is
// reached (docs/audit_fix.md F-15).
func TestManagerConcurrencyLimit_RejectsWhenFull(t *testing.T) {
	m := NewManager()
	// Occupy every slot so the next Start must be rejected.
	for range maxConcurrentJobs {
		m.sem <- struct{}{}
	}

	_, err := m.Start("", "", semaphoreTestRequest(t))
	if !errors.Is(err, ErrTooManyJobs) {
		t.Fatalf("Start at capacity: err = %v, want ErrTooManyJobs", err)
	}
	if got := len(m.sem); got != maxConcurrentJobs {
		t.Fatalf("semaphore occupancy = %d, want %d (rejected Start must not take a slot)", got, maxConcurrentJobs)
	}
}

// TestManagerConcurrencyLimit_RejectsWhileBusy verifies a Start that would
// exceed the limit is rejected while a real job holds the last slot. The slow
// fake ffmpeg keeps the slot held for ~19s, so the rejection is deterministic
// (no race with an instantly-exiting process).
func TestManagerConcurrencyLimit_RejectsWhileBusy(t *testing.T) {
	m := NewManager()
	ffmpegPath := slowFakeFFmpeg(t)
	for range maxConcurrentJobs - 1 {
		m.sem <- struct{}{}
	}
	// One free slot left: this Start acquires it and the fake holds it.
	job, err := m.Start(ffmpegPath, "", semaphoreTestRequest(t))
	if err != nil {
		t.Fatalf("Start with a free slot: %v", err)
	}
	if job.Status != StatusRunning {
		t.Fatalf("job status = %s, want running", job.Status)
	}
	t.Cleanup(func() { m.Cancel(job.ID) })

	// All slots are now taken: the next Start must be rejected.
	if _, err := m.Start(ffmpegPath, "", semaphoreTestRequest(t)); !errors.Is(err, ErrTooManyJobs) {
		t.Fatalf("Start while busy: err = %v, want ErrTooManyJobs", err)
	}

	// Cancel the running job; its slot must return so the limit is released.
	if !m.Cancel(job.ID) {
		t.Fatal("Cancel of running job returned false")
	}
	waitFor(t, 10*time.Second, func() bool {
		j, _ := m.Get(job.ID)
		return j != nil && j.Status == StatusCancelled && len(m.sem) == maxConcurrentJobs-1
	})

	// The freed slot must be usable again.
	if _, err := m.Start(ffmpegPath, "", semaphoreTestRequest(t)); err != nil {
		t.Fatalf("Start after slot release: %v, want success", err)
	}
}

// TestManagerConcurrencyLimit_ReleasesSlotOnCancel verifies runJob returns its
// ffmpeg slot when a running job is cancelled — whether the cancel lands
// before the process starts (exec start reports context canceled, classified
// as ErrCancelled) or while it runs (process group killed).
func TestManagerConcurrencyLimit_ReleasesSlotOnCancel(t *testing.T) {
	m := NewManager()
	ffmpegPath := slowFakeFFmpeg(t)
	job, err := m.Start(ffmpegPath, "", semaphoreTestRequest(t))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := len(m.sem); got != 1 {
		t.Fatalf("semaphore occupancy after Start = %d, want 1", got)
	}

	if !m.Cancel(job.ID) {
		t.Fatal("Cancel of running job returned false")
	}
	waitFor(t, 10*time.Second, func() bool {
		j, _ := m.Get(job.ID)
		return j != nil && j.Status == StatusCancelled && len(m.sem) == 0
	})
	if got := len(m.sem); got != 0 {
		t.Fatalf("slot not released after cancel: occupancy %d", got)
	}
}

// TestManagerConcurrencyLimit_CancelImmediatelyReleasesSlot cancels a job the
// instant Start returns, before runJob is guaranteed to have reached
// exec.Cmd.Start. Both interleavings — cancel before the process starts (exec
// reports context canceled, classified as ErrCancelled) and cancel while it
// runs (watchCtx invokes the process-group kill) — must land the job in
// StatusCancelled and return its slot. The fake ffmpeg would otherwise hold
// the slot for ~19s, so the 10s bound deterministically proves the kill fired.
func TestManagerConcurrencyLimit_CancelImmediatelyReleasesSlot(t *testing.T) {
	m := NewManager()
	ffmpegPath := slowFakeFFmpeg(t)
	job, err := m.Start(ffmpegPath, "", semaphoreTestRequest(t))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := len(m.sem); got != 1 {
		t.Fatalf("semaphore occupancy after Start = %d, want 1", got)
	}

	if !m.Cancel(job.ID) {
		t.Fatal("Cancel of running job returned false")
	}
	waitFor(t, 10*time.Second, func() bool {
		j, _ := m.Get(job.ID)
		return j != nil && j.Status == StatusCancelled && len(m.sem) == 0
	})
	if got := len(m.sem); got != 0 {
		t.Fatalf("slot not released after immediate cancel: occupancy %d", got)
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", d)
}
