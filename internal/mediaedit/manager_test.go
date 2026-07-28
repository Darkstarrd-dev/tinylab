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
	// Cross-format overwrite ("replace original"): output lands at
	// <dir>/<stem><newExt> and the original .png is removed on success,
	// leaving the new-format file in its place.
	wantPath := filepath.Join(dir, "source.webp")
	if job.OutputPath != wantPath {
		t.Errorf("expected outputPath = %s for cross-format overwrite, got %s", wantPath, job.OutputPath)
	}
	if _, err := os.Stat(imgPath); !os.IsNotExist(err) {
		t.Errorf("expected original %s removed after cross-format overwrite, stat err=%v", imgPath, err)
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

// TestManager_TranscodeImage_OutputName verifies that when OutputName is set
// (the batch-convert path for FSAA/zip items whose inputPath is a temp file
// like "gallery-edit-XXXX.png"), the saved output uses the requested original
// stem with only the new format's extension — not the temp filename.
func TestManager_TranscodeImage_OutputName(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	srcDir := t.TempDir()
	outDir := t.TempDir()
	// Simulate a temp-resolved input with an opaque name (as upload-temp /
	// extract-zip-entry produce).
	imgPath := makeTestImage(t, ffmpegPath, srcDir, "gallery-edit-upload-1234567890.png")

	m := NewManager()
	params := ImageTranscodeParams{Format: "webp", Quality: 80}
	raw, _ := json.Marshal(params)
	req := StartRequest{
		InputPath:  imgPath,
		Operation:  "image_transcode",
		Overwrite:  false,
		OutputDir:  outDir,
		OutputName: "vacation_photo", // original gallery item name w/o extension
		Params:     raw,
	}

	job, err := m.Start(ffmpegPath, ffprobePath, req)
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	for range 150 {
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
	if job.OutputName != "vacation_photo.webp" {
		t.Errorf("expected OutputName vacation_photo.webp, got %q (OutputPath=%s)", job.OutputName, job.OutputPath)
	}
	if filepath.Base(job.OutputPath) != "vacation_photo.webp" {
		t.Errorf("expected output file vacation_photo.webp, got %q", filepath.Base(job.OutputPath))
	}
}

// TestManager_TranscodeImage_OutputName_Dedup verifies the second conversion of
// the same-named item lands on vacation_photo_2.webp rather than clobbering.
func TestManager_TranscodeImage_OutputName_Dedup(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)

	srcDir := t.TempDir()
	outDir := t.TempDir()
	imgPath := makeTestImage(t, ffmpegPath, srcDir, "gallery-edit-upload-1111111111.png")

	m := NewManager()
	params := ImageTranscodeParams{Format: "png", Quality: 100}
	raw, _ := json.Marshal(params)
	req := StartRequest{
		InputPath:  imgPath,
		Operation:  "image_transcode",
		Overwrite:  false,
		OutputDir:  outDir,
		OutputName: "vacation_photo",
		Params:     raw,
	}
	// Convert twice — identical requested stem, different opaque temp inputs;
	// second conversion must land on <stem>_2 instead of clobbering.
	for k := range 2 {
		if k == 1 {
			imgPath = makeTestImage(t, ffmpegPath, srcDir, "gallery-edit-upload-2222222222.png")
			req.InputPath = imgPath
		}
		job, err := m.Start(ffmpegPath, ffprobePath, req)
		if err != nil {
			t.Fatalf("start[%d] failed: %v", k, err)
		}
		for range 150 {
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
		want := "vacation_photo.png"
		if k == 1 {
			want = "vacation_photo_2.png"
		}
		if filepath.Base(job.OutputPath) != want {
			t.Errorf("pass %d: expected %s, got %q", k, want, filepath.Base(job.OutputPath))
		}
	}
}
