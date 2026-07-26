package mediaedit

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// requireFfmpeg skips the test if ffmpeg is not available.
func requireFfmpeg(t *testing.T) (string, string) {
	t.Helper()
	ffmpegPath, err := ResolveFfmpeg("")
	if err != nil {
		t.Skipf("ffmpeg not found: %v", err)
	}
	ffprobePath, err := ResolveFfprobe(ffmpegPath)
	if err != nil {
		t.Skipf("ffprobe not found: %v", err)
	}
	return ffmpegPath, ffprobePath
}

// makeTestImage creates a tiny (1x1) PNG test image using ffmpeg.
func makeTestImage(t *testing.T, ffmpegPath, dir, name string) string {
	t.Helper()
	outPath := filepath.Join(dir, name)
	// Use lavfi to generate a 1x1 solid color frame encoded as PNG.
	cmd := exec.Command(ffmpegPath,
		"-y", "-f", "lavfi", "-i", "color=c=red:s=1x1:d=1",
		"-frames:v", "1", outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test image: %v\n%s", err, out)
	}
	return outPath
}

func TestManager_Probe(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	dir := t.TempDir()
	imgPath := makeTestImage(t, ffmpegPath, dir, "test.png")

	m := NewManager()
	result, err := m.ProbeMedia(ffprobePath, imgPath)
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if result.Width != 1 {
		t.Errorf("expected width 1, got %d", result.Width)
	}
	if result.Height != 1 {
		t.Errorf("expected height 1, got %d", result.Height)
	}
	if !result.IsImage {
		t.Error("expected IsImage=true for PNG")
	}
	if result.HasAudio {
		t.Error("expected HasAudio=false for image")
	}
}

func TestManager_TranscodeImage(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	dir := t.TempDir()
	imgPath := makeTestImage(t, ffmpegPath, dir, "source.png")

	m := NewManager()

	params := ImageTranscodeParams{Format: "webp", Quality: 80}
	raw, _ := json.Marshal(params)

	req := StartRequest{
		InputPath: imgPath,
		Operation: "image_transcode",
		Overwrite: false,
		Params:    raw,
	}

	job, err := m.Start(ffmpegPath, ffprobePath, req)
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}

	// Wait for completion (max 15s).
	for i := 0; i < 150; i++ {
		time.Sleep(100 * time.Millisecond)
		j, ok := m.Get(job.ID)
		if !ok {
			t.Fatal("job disappeared")
		}
		if j.Status == StatusCompleted || j.Status == StatusError || j.Status == StatusCancelled {
			job = j
			break
		}
	}

	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if _, err := os.Stat(job.OutputPath); err != nil {
		t.Fatalf("output file not found: %v", err)
	}
	if job.OutputName != filepath.Base(job.OutputPath) {
		t.Errorf("outputName mismatch: %s vs %s", job.OutputName, filepath.Base(job.OutputPath))
	}
}

func TestManager_TranscodeImage_Overwrite(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	dir := t.TempDir()
	imgPath := makeTestImage(t, ffmpegPath, dir, "source.png")

	m := NewManager()

	params := ImageTranscodeParams{Format: "webp", Quality: 90}
	raw, _ := json.Marshal(params)

	req := StartRequest{
		InputPath: imgPath,
		Operation: "image_transcode",
		Overwrite: true,
		Params:    raw,
	}

	job, err := m.Start(ffmpegPath, ffprobePath, req)
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}

	for i := 0; i < 150; i++ {
		time.Sleep(100 * time.Millisecond)
		j, ok := m.Get(job.ID)
		if !ok {
			t.Fatal("job disappeared")
		}
		if j.Status == StatusCompleted || j.Status == StatusError || j.Status == StatusCancelled {
			job = j
			break
		}
	}

	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if job.OutputPath != imgPath {
		t.Errorf("expected outputPath = inputPath for overwrite, got %s", job.OutputPath)
	}
}

func TestManager_Cancel(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	dir := t.TempDir()

	// Create a longer test video so we have time to cancel.
	videoPath := filepath.Join(dir, "test.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=30",
		"-c:v", "libx264", "-preset", "ultrafast",
		"-t", "10", videoPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test video: %v\n%s", err, out)
	}

	m := NewManager()

	params := VideoTranscodeParams{
		Codec: "h264", Container: "mp4", QualityTier: "low",
		Preset: "slow", // slow preset to give us time to cancel
	}
	raw, _ := json.Marshal(params)

	req := StartRequest{
		InputPath: videoPath,
		Operation: "video_transcode",
		Overwrite: false,
		Params:    raw,
	}

	job, err := m.Start(ffmpegPath, ffprobePath, req)
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}

	// Cancel shortly after starting.
	time.Sleep(500 * time.Millisecond)
	if !m.Cancel(job.ID) {
		t.Log("cancel returned false (job may have already finished)")
	}

	// Wait for terminal state.
	for i := 0; i < 100; i++ {
		time.Sleep(200 * time.Millisecond)
		j, ok := m.Get(job.ID)
		if !ok {
			t.Fatal("job disappeared")
		}
		if j.Status == StatusCompleted || j.Status == StatusError || j.Status == StatusCancelled {
			job = j
			break
		}
	}

	if job.Status != StatusCancelled && job.Status != StatusCompleted {
		t.Errorf("expected cancelled or completed, got %s", job.Status)
	}
}

func TestManager_GetNotFound(t *testing.T) {
	m := NewManager()
	_, ok := m.Get("nonexistent")
	if ok {
		t.Error("expected false for nonexistent job")
	}
}

func TestManager_CancelNotFound(t *testing.T) {
	m := NewManager()
	if m.Cancel("nonexistent") {
		t.Error("expected false for canceling nonexistent job")
	}
}

func TestStartRequest_InvalidOperation(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	m := NewManager()
	req := StartRequest{
		InputPath: "/tmp/foo.jpg",
		Operation: "nonexistent",
		Params:    json.RawMessage(`{}`),
	}
	_, err := m.Start(ffmpegPath, ffprobePath, req)
	if err == nil {
		t.Fatal("expected error for invalid operation")
	}
}

func TestSnapshot(t *testing.T) {
	j := &Job{
		ID: "test-id", Status: StatusRunning, Progress: 50,
		Operation: "image_transcode", InputPath: "/tmp/in.png",
	}
	s := j.Snapshot()
	if s.ID != "test-id" {
		t.Errorf("expected ID test-id, got %s", s.ID)
	}
	if s.Progress != 50 {
		t.Errorf("expected progress 50, got %d", s.Progress)
	}
	// Ensure cancel is not copied (it would be nil anyway).
}
