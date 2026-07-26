package mediaedit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildImageTranscodeArgs_JPEG(t *testing.T) {
	params := ImageTranscodeParams{Format: "jpeg", Quality: 90, ScalePercent: 50}
	raw, _ := json.Marshal(params)
	args, desc, ext, err := BuildImageTranscodeArgs("/tmp/photo.png", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".jpg" {
		t.Errorf("expected ext .jpg, got %s", ext)
	}
	if desc != "jpeg_q90" {
		t.Errorf("expected desc jpeg_q90, got %s", desc)
	}

	hasQ := false
	hasScale := false
	for _, a := range args {
		if a == "-q:v" {
			hasQ = true
		}
		if strings.Contains(a, "scale=") {
			hasScale = true
		}
	}
	if !hasQ {
		t.Error("expected -q:v flag for jpeg")
	}
	if !hasScale {
		t.Error("expected scale filter for ScalePercent=50")
	}
}

func TestBuildImageTranscodeArgs_PNG(t *testing.T) {
	params := ImageTranscodeParams{Format: "png", Quality: 50, StripMetadata: true}
	raw, _ := json.Marshal(params)
	args, _, ext, err := BuildImageTranscodeArgs("/tmp/photo.bmp", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".png" {
		t.Errorf("expected ext .png, got %s", ext)
	}

	hasLevel := false
	hasStrip := false
	for _, a := range args {
		if a == "-compression_level" {
			hasLevel = true
		}
		if a == "-map_metadata" {
			hasStrip = true
		}
	}
	if !hasLevel {
		t.Error("expected -compression_level for PNG with quality")
	}
	if !hasStrip {
		t.Error("expected -map_metadata -1 for strip metadata")
	}
}

func TestBuildImageTranscodeArgs_TIFF(t *testing.T) {
	params := ImageTranscodeParams{Format: "tiff", Quality: 80}
	raw, _ := json.Marshal(params)
	_, _, ext, err := BuildImageTranscodeArgs("/tmp/photo.png", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".tiff" {
		t.Errorf("expected ext .tiff, got %s", ext)
	}
}

func TestJpegQuality(t *testing.T) {
	tests := []struct {
		q    int
		want int
	}{
		{100, 1},
		{90, 4},
		{50, 16},
		{0, 31},
	}
	for _, tt := range tests {
		got := jpegQuality(tt.q)
		if got != tt.want {
			t.Errorf("jpegQuality(%d) = %d, want %d", tt.q, got, tt.want)
		}
	}
}

func TestBuildVideoTranscodeArgs_H264(t *testing.T) {
	params := VideoTranscodeParams{
		Codec: "h264", Container: "mp4", QualityTier: "high",
		Preset: "fast", AudioCodec: "aac", AudioBitrate: "192k",
	}
	raw, _ := json.Marshal(params)
	args, desc, ext, err := BuildVideoTranscodeArgs("/tmp/video.mkv", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".mp4" {
		t.Errorf("expected ext .mp4, got %s", ext)
	}
	if desc != "h264_high" {
		t.Errorf("expected desc h264_high, got %s", desc)
	}

	hasCRF := false
	hasPreset := false
	hasAAC := false
	hasFaststart := false
	for i, a := range args {
		if a == "-crf" && i+1 < len(args) && args[i+1] == "20" {
			hasCRF = true
		}
		if a == "-preset" && i+1 < len(args) && args[i+1] == "fast" {
			hasPreset = true
		}
		if a == "-c:a" && i+1 < len(args) && args[i+1] == "aac" {
			hasAAC = true
		}
		if a == "+faststart" {
			hasFaststart = true
		}
	}
	if !hasCRF {
		t.Error("expected -crf 20 for h264 high")
	}
	if !hasPreset {
		t.Error("expected -preset fast")
	}
	if !hasAAC {
		t.Error("expected -c:a aac")
	}
	if !hasFaststart {
		t.Error("expected +faststart for mp4")
	}
}

func TestBuildVideoTranscodeArgs_Copy(t *testing.T) {
	params := VideoTranscodeParams{
		Codec: "copy", Container: "mkv",
	}
	raw, _ := json.Marshal(params)
	args, desc, _, err := BuildVideoTranscodeArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "remux" {
		t.Errorf("expected desc remux, got %s", desc)
	}

	hasCopy := false
	for _, a := range args {
		if a == "copy" {
			hasCopy = true
		}
	}
	if !hasCopy {
		t.Error("expected -c copy for remux")
	}
}

func TestBuildVideoTranscodeArgs_ContainerValidation(t *testing.T) {
	params := VideoTranscodeParams{
		Codec: "h264", Container: "webm",
	}
	raw, _ := json.Marshal(params)
	_, _, _, err := BuildVideoTranscodeArgs("/tmp/video.mp4", raw)
	if err == nil {
		t.Fatal("expected error for h264+webm")
	}
	if !strings.Contains(err.Error(), "not compatible") {
		t.Errorf("expected compatibility error, got: %v", err)
	}
}

func TestBuildVideoTranscodeArgs_VP9(t *testing.T) {
	params := VideoTranscodeParams{
		Codec: "vp9", Container: "webm", QualityTier: "medium",
		AudioCodec: "opus", AudioBitrate: "128k",
	}
	raw, _ := json.Marshal(params)
	args, _, _, err := BuildVideoTranscodeArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	hasBV0 := false
	for _, a := range args {
		if a == "-b:v" {
			hasBV0 = true
		}
	}
	if !hasBV0 {
		t.Error("expected -b:v 0 for vp9 CRF mode")
	}
}

func TestBuildVideoTrimArgs_Copy(t *testing.T) {
	params := VideoTrimParams{
		Start: "00:01:30", Duration: "60", Reencode: false,
	}
	raw, _ := json.Marshal(params)
	args, desc, _, err := BuildVideoTrimArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "trim_00m01m30" {
		t.Errorf("expected desc trim_00m01m30, got %s", desc)
	}

	hasCopy := false
	hasAvoidNeg := false
	for i, a := range args {
		if a == "-c" && i+1 < len(args) && args[i+1] == "copy" {
			hasCopy = true
		}
		if a == "-avoid_negative_ts" {
			hasAvoidNeg = true
		}
	}
	if !hasCopy {
		t.Error("expected -c copy")
	}
	if !hasAvoidNeg {
		t.Error("expected -avoid_negative_ts make_zero")
	}
}

func TestBuildVideoTrimArgs_Reencode(t *testing.T) {
	params := VideoTrimParams{
		Start: "10", Duration: "30", Reencode: true,
		Codec: "h264", QualityTier: "low",
	}
	raw, _ := json.Marshal(params)
	args, _, _, err := BuildVideoTrimArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	hasCRF := false
	for i, a := range args {
		if a == "-crf" && i+1 < len(args) && args[i+1] == "27" {
			hasCRF = true
		}
	}
	if !hasCRF {
		t.Error("expected -crf 27 for h264 low reencode")
	}
}

func TestBuildVideoTrimArgs_NoStart(t *testing.T) {
	params := VideoTrimParams{Start: "", Duration: "30"}
	raw, _ := json.Marshal(params)
	_, _, _, err := BuildVideoTrimArgs("/tmp/video.mp4", raw)
	if err == nil {
		t.Fatal("expected error for missing start")
	}
}

func TestBuildVideoSubtitleArgs_Burn(t *testing.T) {
	params := VideoSubtitleParams{
		SubtitlePath: "/tmp/sub.srt", Mode: "burn",
		FontSize: 32, FontName: "Arial", Container: "mp4",
	}
	raw, _ := json.Marshal(params)
	args, desc, _, err := BuildVideoSubtitleArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "sub_burn" {
		t.Errorf("expected desc sub_burn, got %s", desc)
	}

	hasSubtitles := false
	hasForceStyle := false
	hasLibx264 := false
	hasCRF23 := false
	hasAAC := false
	hasFaststart := false
	for i, a := range args {
		if strings.Contains(a, "subtitles=") {
			hasSubtitles = true
		}
		if strings.Contains(a, "FontSize=32") && strings.Contains(a, "FontName=Arial") {
			hasForceStyle = true
		}
		if a == "-c:v" && i+1 < len(args) && args[i+1] == "libx264" {
			hasLibx264 = true
		}
		if a == "-crf" && i+1 < len(args) && args[i+1] == "23" {
			hasCRF23 = true
		}
		if a == "-c:a" && i+1 < len(args) && args[i+1] == "aac" {
			hasAAC = true
		}
		if a == "+faststart" {
			hasFaststart = true
		}
	}
	if !hasSubtitles {
		t.Error("expected subtitles= filter")
	}
	if !hasForceStyle {
		t.Error("expected force_style with FontSize=32,FontName=Arial")
	}
	if !hasLibx264 {
		t.Error("expected -c:v libx264 for burn re-encode")
	}
	if !hasCRF23 {
		t.Error("expected -crf 23 for burn re-encode")
	}
	if !hasAAC {
		t.Error("expected -c:a aac for burn re-encode")
	}
	if !hasFaststart {
		t.Error("expected -movflags +faststart for mp4 container")
	}
}

func TestBuildVideoSubtitleArgs_Soft(t *testing.T) {
	params := VideoSubtitleParams{
		SubtitlePath: "/tmp/sub.srt", Mode: "soft",
		Language: "eng", Container: "mkv",
	}
	raw, _ := json.Marshal(params)
	args, desc, _, err := BuildVideoSubtitleArgs("/tmp/video.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "sub_soft" {
		t.Errorf("expected desc sub_soft, got %s", desc)
	}

	hasLanguage := false
	for _, a := range args {
		if strings.Contains(a, "language=eng") {
			hasLanguage = true
		}
	}
	if !hasLanguage {
		t.Error("expected language=eng metadata")
	}
}

func TestBuildOutputPath_Overwrite(t *testing.T) {
	p, err := BuildOutputPath("/tmp/photo.jpg", "jpeg_q90", ".jpg", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != "/tmp/photo.jpg" {
		t.Errorf("expected /tmp/photo.jpg, got %s", p)
	}
}

func TestBuildOutputPath_NonOverwrite(t *testing.T) {
	// Create a temp dir and a file to simulate existence.
	dir := t.TempDir()
	existing := filepath.Join(dir, "photo_jpeg_q90.jpg")
	os.WriteFile(existing, []byte("x"), 0644)

	p, err := BuildOutputPath(filepath.Join(dir, "photo.jpg"), "jpeg_q90", ".jpg", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != filepath.Join(dir, "photo_jpeg_q90_2.jpg") {
		t.Errorf("expected deduped path, got %s", p)
	}
}

func TestBuildOutputPath_NonOverwrite_NoConflict(t *testing.T) {
	dir := t.TempDir()
	p, err := BuildOutputPath(filepath.Join(dir, "photo.jpg"), "jpeg_q90", ".jpg", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != filepath.Join(dir, "photo_jpeg_q90.jpg") {
		t.Errorf("expected non-conflicting path, got %s", p)
	}
}

func TestSanitizeTimestamp(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"00:01:30", "00m01m30"},
		{"1:30", "1m30"},
		{"120", "120"},
	}
	for _, tt := range tests {
		got := sanitizeTimestamp(tt.in)
		if got != tt.want {
			t.Errorf("sanitizeTimestamp(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestEscapeFilterPath(t *testing.T) {
	p := `C:\Users\test:file.srt`
	got := escapeFilterPath(p)
	if !strings.Contains(got, "\\\\") {
		t.Error("expected backslash escaping")
	}
	if !strings.Contains(got, "\\:") {
		t.Error("expected colon escaping")
	}
}

func TestBuildImageTranscodeArgs_ScalePercentZero(t *testing.T) {
	params := ImageTranscodeParams{Format: "webp", ScalePercent: 0}
	raw, _ := json.Marshal(params)
	args, _, _, err := BuildImageTranscodeArgs("/tmp/photo.png", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, a := range args {
		if strings.Contains(a, "scale=") {
			t.Error("expected no scale filter for ScalePercent=0")
		}
	}
}
