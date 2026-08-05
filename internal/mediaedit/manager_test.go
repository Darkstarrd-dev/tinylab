package mediaedit

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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

// --- Animated-image integration smoke tests (need real ffmpeg) ---

// makeTestVideo creates a 2-second 160x120@12fps test video using lavfi and
// the always-present mpeg4 encoder.
func makeTestVideo(t *testing.T, ffmpegPath, dir, name string) string {
	t.Helper()
	outPath := filepath.Join(dir, name)
	cmd := exec.Command(ffmpegPath,
		"-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12:duration=2",
		"-c:v", "mpeg4", "-an", outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test video: %v\n%s", err, out)
	}
	return outPath
}

// makeTestGif creates a 2-second animated GIF from a lavfi source.
func makeTestGif(t *testing.T, ffmpegPath, dir, name string) string {
	t.Helper()
	outPath := filepath.Join(dir, name)
	cmd := exec.Command(ffmpegPath,
		"-y", "-f", "lavfi", "-i", "testsrc2=size=120x90:rate=10:duration=2",
		"-loop", "0", outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test gif: %v\n%s", err, out)
	}
	return outPath
}

// makeTestWebp creates a 2-second animated WebP from a lavfi source.
func makeTestWebp(t *testing.T, ffmpegPath, dir, name string) string {
	t.Helper()
	outPath := filepath.Join(dir, name)
	cmd := exec.Command(ffmpegPath,
		"-y", "-f", "lavfi", "-i", "testsrc2=size=120x90:rate=10:duration=2",
		"-c:v", "libwebp_anim", "-quality", "75", "-lossless", "0", "-loop", "0", outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test webp: %v\n%s", err, out)
	}
	return outPath
}

// ffprobeFrameCount decodes the file and returns the number of video frames.
func ffprobeFrameCount(t *testing.T, ffprobePath, path string) int {
	t.Helper()
	out, err := exec.Command(ffprobePath,
		"-v", "error", "-count_frames",
		"-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames",
		"-of", "csv=p=0", path,
	).Output()
	if err != nil {
		t.Fatalf("ffprobe count_frames failed: %v", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("ffprobe count_frames parse %q: %v", string(out), err)
	}
	return n
}

// ffprobeDuration returns the media duration in seconds.
func ffprobeDuration(t *testing.T, ffprobePath, path string) float64 {
	t.Helper()
	out, err := exec.Command(ffprobePath,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0", path,
	).Output()
	if err != nil {
		t.Fatalf("ffprobe duration failed: %v", err)
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		t.Fatalf("ffprobe duration parse %q: %v", string(out), err)
	}
	return d
}

// gifLoopMetadata reads the NETSCAPE loop extension from a GIF file.
// present=false means the file has no loop extension at all (produced by
// -loop -1); otherwise loop is the muxer loop count (0 = infinite).
func gifLoopMetadata(t *testing.T, path string) (present bool, loop int) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	idx := bytes.Index(b, []byte("NETSCAPE2.0"))
	if idx < 0 {
		return false, 0
	}
	if idx+15 > len(b) {
		return true, 0
	}
	// After the 11-byte app ID come 0x03 0x01 then the 2-byte little-endian
	// loop count.
	loop = int(b[idx+13]) | int(b[idx+14])<<8
	return true, loop
}

// webpLoopMetadata reads the ANIM chunk loop count from an animated WebP.
// present=false means no ANIM chunk (static image).
func webpLoopMetadata(t *testing.T, path string) (present bool, loop int) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	idx := bytes.Index(b, []byte("ANIM"))
	if idx < 0 || idx+14 > len(b) {
		return false, 0
	}
	// ANIM chunk: 4-byte "ANIM" FourCC, 4-byte chunk size (=6), 4-byte
	// background color (BGRA), then the 2-byte little-endian loop count
	// (0 = infinite).
	loop = int(b[idx+12]) | int(b[idx+13])<<8
	return true, loop
}

// waitJob polls the manager until the job reaches a terminal state.
func waitJob(t *testing.T, m *Manager, id string) *Job {
	t.Helper()
	job, ok := m.Get(id)
	if !ok {
		t.Fatal("job disappeared")
	}
	for range 300 {
		time.Sleep(100 * time.Millisecond)
		j, ok := m.Get(id)
		if !ok {
			t.Fatal("job disappeared")
		}
		if j.Status == StatusCompleted || j.Status == StatusError || j.Status == StatusCancelled {
			return j
		}
	}
	return job
}

func TestManager_VideoToGif(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	dir := t.TempDir()
	video := makeTestVideo(t, ffmpegPath, dir, "source.mp4")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimParams{
		FPS:           10,
		Width:         120,
		LoopCount:     0,
		PaletteColors: 64,
		Dither:        "sierra2_4a",
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: video,
		Operation: "video_to_gif",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if filepath.Ext(job.OutputPath) != ".gif" {
		t.Errorf("expected .gif output, got %s", job.OutputPath)
	}
	if frames := ffprobeFrameCount(t, ffprobePath, job.OutputPath); frames <= 1 {
		t.Errorf("expected >1 frame, got %d", frames)
	}
	present, loop := gifLoopMetadata(t, job.OutputPath)
	if !present || loop != 0 {
		t.Errorf("expected NETSCAPE loop 0 (infinite), present=%v loop=%d", present, loop)
	}
}

func TestManager_VideoToGif_NoLoop(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	dir := t.TempDir()
	video := makeTestVideo(t, ffmpegPath, dir, "source.mp4")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimParams{
		FPS:       10,
		Width:     120,
		LoopCount: -1, // play once: no NETSCAPE extension
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: video,
		Operation: "video_to_gif",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if present, _ := gifLoopMetadata(t, job.OutputPath); present {
		t.Error("expected no NETSCAPE loop extension for loopCount -1")
	}
}

func TestManager_VideoToWebp(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	caps, err := ProbeFfmpegCaps(ffmpegPath)
	if err != nil || !caps.WebpAnim {
		t.Skipf("libwebp_anim encoder not available: %v", err)
	}
	dir := t.TempDir()
	video := makeTestVideo(t, ffmpegPath, dir, "source.mp4")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimParams{
		FPS:       10,
		Width:     120,
		LoopCount: 0,
		Quality:   80,
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: video,
		Operation: "video_to_webp",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if filepath.Ext(job.OutputPath) != ".webp" {
		t.Errorf("expected .webp output, got %s", job.OutputPath)
	}
	if frames := ffprobeFrameCount(t, ffprobePath, job.OutputPath); frames <= 1 {
		t.Errorf("expected >1 frame, got %d", frames)
	}
	present, loop := webpLoopMetadata(t, job.OutputPath)
	if !present || loop != 0 {
		t.Errorf("expected ANIM chunk with loop 0 (infinite), present=%v loop=%d", present, loop)
	}
}

func TestManager_VideoAnimTrim_Gif(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	dir := t.TempDir()
	anim := makeTestGif(t, ffmpegPath, dir, "anim.gif")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Start:     "0.5",
		Duration:  "1",
		LoopCount: 0,
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: anim,
		Operation: "video_anim_trim",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if filepath.Ext(job.OutputPath) != ".gif" {
		t.Errorf("expected .gif output (same as input), got %s", job.OutputPath)
	}
	// Requested window is 1s; the 10fps source quantizes to 0.1s steps.
	if d := ffprobeDuration(t, ffprobePath, job.OutputPath); d < 0.8 || d > 1.2 {
		t.Errorf("expected output duration ~1s, got %f", d)
	}
}

func TestManager_VideoAnimTrim_Gif_MultiSegment(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	dir := t.TempDir()
	anim := makeTestGif(t, ffmpegPath, dir, "anim.gif")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Segments:  []TrimSegment{{Start: "0", End: "0.5"}, {Start: "1", End: "1.5"}},
		LoopCount: 0,
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: anim,
		Operation: "video_anim_trim",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if filepath.Ext(job.OutputPath) != ".gif" {
		t.Errorf("expected .gif output (same as input), got %s", job.OutputPath)
	}
	// Two 0.5s windows concatenated ≈ 1s.
	if d := ffprobeDuration(t, ffprobePath, job.OutputPath); d < 0.8 || d > 1.2 {
		t.Errorf("expected output duration ~1s, got %f", d)
	}
}

func TestManager_VideoAnimTrim_Webp(t *testing.T) {
	ffmpegPath, ffprobePath := requireFfmpeg(t)
	caps, err := ProbeFfmpegCaps(ffmpegPath)
	if err != nil || !caps.WebpAnim || !caps.WebpAnimDecode {
		t.Skipf("animated WebP encode/decode not available: %v", err)
	}
	dir := t.TempDir()
	anim := makeTestWebp(t, ffmpegPath, dir, "anim.webp")

	m := NewManager()
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Start:     "0.5",
		Duration:  "1",
		LoopCount: 0,
		Quality:   80,
	})
	job, err := m.Start(ffmpegPath, ffprobePath, StartRequest{
		InputPath: anim,
		Operation: "video_anim_trim",
		Params:    raw,
	})
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	job = waitJob(t, m, job.ID)
	if job.Status != StatusCompleted {
		t.Fatalf("expected completed, got %s: %s", job.Status, job.Error)
	}
	if filepath.Ext(job.OutputPath) != ".webp" {
		t.Errorf("expected .webp output (same as input), got %s", job.OutputPath)
	}
	// ffprobe reports format duration N/A for WebP, so verify the ~1s window
	// via decoded frame count (10 fps source → ~10 frames).
	if frames := ffprobeFrameCount(t, ffprobePath, job.OutputPath); frames < 8 || frames > 13 {
		t.Errorf("expected ~10 frames for a 1s window, got %d", frames)
	}
}
