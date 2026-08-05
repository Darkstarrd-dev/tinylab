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

// --- video_to_gif / video_to_webp / video_anim_trim args ---

func TestBuildVideoToGifArgs_Full(t *testing.T) {
	params := VideoAnimParams{
		Start:         "1.5",
		Duration:      "4",
		FPS:           15,
		Width:         480,
		CropLeft:      10,
		CropRight:     20,
		CropTop:       5,
		CropBottom:    5,
		LoopCount:     3,
		Quality:       80,
		PaletteColors: 128,
		Dither:        "bayer",
	}
	raw, _ := json.Marshal(params)
	args, desc, ext, err := BuildVideoToGifArgs(`C:\videos\clip.mp4`, raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".gif" {
		t.Errorf("expected ext .gif, got %s", ext)
	}
	if desc != "gif_fps15" {
		t.Errorf("expected desc gif_fps15, got %s", desc)
	}
	wantFilter := "[0:v]fps=15,crop=iw-10-20:ih-5-5:10:5,scale=480:-2," +
		"split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];" +
		"[b][p]paletteuse=dither=bayer[v]"
	want := []string{
		"-ss", "1.5", "-t", "4",
		"-i", `C:\videos\clip.mp4`,
		"-filter_complex", wantFilter,
		"-map", "[v]",
		"-loop", "3",
	}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoToGifArgs_Defaults(t *testing.T) {
	// All-zero numeric fields → fps 12, palette 256, sierra2_4a, no crop,
	// no scale, no time options, loop 0 (infinite).
	raw, _ := json.Marshal(VideoAnimParams{})
	args, desc, ext, err := BuildVideoToGifArgs("in.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".gif" || desc != "gif_fps12" {
		t.Errorf("unexpected ext/desc: %s / %s", ext, desc)
	}
	wantFilter := "[0:v]fps=12,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a[v]"
	want := []string{"-i", "in.mp4", "-filter_complex", wantFilter, "-map", "[v]", "-loop", "0"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
	for _, a := range args {
		if strings.Contains(a, "scale=") || strings.Contains(a, "crop=") {
			t.Errorf("expected no scale/crop filter for zero sizes, got %q", a)
		}
	}
}

func TestBuildVideoToGifArgs_ScaleVariants(t *testing.T) {
	tests := []struct {
		name          string
		width, height int
		wantScale     string // "" = no scale filter
	}{
		{"width only", 480, 0, "scale=480:-2"},
		{"height only", 0, 270, "scale=-2:270"},
		{"both", 480, 270, "scale=480:270"},
		{"none", 0, 0, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(VideoAnimParams{Width: tt.width, Height: tt.height})
			args, _, _, err := BuildVideoToGifArgs("in.mp4", raw)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var got string
			for i, a := range args {
				if a == "-filter_complex" && i+1 < len(args) {
					for _, part := range strings.Split(args[i+1], ",") {
						if strings.HasPrefix(part, "scale=") {
							got = part
						}
					}
				}
			}
			if got != tt.wantScale {
				t.Errorf("scale = %q, want %q (args %v)", got, tt.wantScale, args)
			}
		})
	}
}

func TestBuildVideoToGifArgs_Invalid(t *testing.T) {
	tests := []struct {
		name   string
		params VideoAnimParams
	}{
		{"fps too high", VideoAnimParams{FPS: 61}},
		{"fps negative", VideoAnimParams{FPS: -1}},
		{"palette too small", VideoAnimParams{PaletteColors: 1}},
		{"palette too large", VideoAnimParams{PaletteColors: 300}},
		{"bad dither", VideoAnimParams{Dither: "ordered;rm -rf /"}},
		{"quality out of range", VideoAnimParams{Quality: 150}},
		{"crop negative", VideoAnimParams{CropTop: -1}},
		{"negative width", VideoAnimParams{Width: -100}},
		{"loop below -1", VideoAnimParams{LoopCount: -2}},
		{"loop above muxer max", VideoAnimParams{LoopCount: 70000}},
		{"negative start", VideoAnimParams{Start: "-5"}},
		{"garbage start", VideoAnimParams{Start: "abc"}},
		{"negative duration", VideoAnimParams{Duration: "-1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			args, _, _, err := BuildVideoToGifArgs("in.mp4", raw)
			if err == nil {
				t.Fatalf("expected error for %s, got args %v", tt.name, args)
			}
			// The rejected user string must never leak into the args.
			for _, a := range args {
				if strings.Contains(a, "rm -rf") {
					t.Errorf("raw user string leaked into args: %q", a)
				}
			}
		})
	}
}

func TestBuildVideoToWebpArgs_Full(t *testing.T) {
	params := VideoAnimParams{
		Start:     "2",
		Duration:  "3.5",
		FPS:       10,
		Height:    240,
		LoopCount: 0,
		Quality:   90,
		Lossless:  true,
	}
	raw, _ := json.Marshal(params)
	args, desc, ext, err := BuildVideoToWebpArgs("in.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".webp" {
		t.Errorf("expected ext .webp, got %s", ext)
	}
	if desc != "webp_q90" {
		t.Errorf("expected desc webp_q90, got %s", desc)
	}
	want := []string{
		"-ss", "2", "-t", "3.5",
		"-i", "in.mp4",
		"-vf", "fps=10,scale=-2:240",
		"-c:v", "libwebp_anim",
		"-quality", "90",
		"-lossless", "1",
		"-loop", "0",
	}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoToWebpArgs_QualityDefaultLosslessFalse(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimParams{LoopCount: 2})
	args, desc, _, err := BuildVideoToWebpArgs("in.mp4", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "webp_q80" {
		t.Errorf("expected default quality 80 in desc, got %s", desc)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"-quality", "80", "-lossless", "0", "-loop", "2"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args missing %q: %v", want, args)
		}
	}
}

func TestBuildVideoToWebpArgs_RejectsBadDither(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimParams{Dither: "sierra2_4a;drawtext=evil"})
	args, _, _, err := BuildVideoToWebpArgs("in.mp4", raw)
	if err == nil {
		t.Fatalf("expected error for non-whitelisted dither, got args %v", args)
	}
	for _, a := range args {
		if strings.Contains(a, "drawtext") {
			t.Errorf("raw user string leaked into args: %q", a)
		}
	}
}

func TestBuildVideoAnimTrimArgs_SingleGif(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Start:     "0.5",
		Duration:  "2",
		LoopCount: 0,
	})
	args, desc, ext, err := BuildVideoAnimTrimArgs("anim.gif", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".gif" {
		t.Errorf("expected ext .gif, got %s", ext)
	}
	if desc != "trim_0.5" {
		t.Errorf("expected desc trim_0.5, got %s", desc)
	}
	// -ss/-t are output options (after -i): input-side -ss fails on the
	// animated WebP demuxer, and the single-segment path is format-uniform.
	want := []string{
		"-i", "anim.gif",
		"-ss", "0.5", "-t", "2",
		"-filter_complex", "[0:v]split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a[v]",
		"-map", "[v]",
		"-loop", "0",
	}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoAnimTrimArgs_SingleGif_DurationOnly(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimTrimParams{Duration: "1.5", LoopCount: 0})
	args, desc, _, err := BuildVideoAnimTrimArgs("anim.gif", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc != "trim_head" {
		t.Errorf("expected desc trim_head for duration-only trim, got %s", desc)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-i anim.gif -t 1.5 ") {
		t.Errorf("expected -t after -i, got %v", args)
	}
	if strings.Contains(joined, "-ss") {
		t.Errorf("unexpected -ss for duration-only trim: %v", args)
	}
}

func TestBuildVideoAnimTrimArgs_SingleWebp(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Start:     "1",
		Duration:  "1.5",
		Quality:   85,
		Lossless:  true,
		LoopCount: 5,
	})
	args, desc, ext, err := BuildVideoAnimTrimArgs("anim.webp", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".webp" || desc != "trim_1" {
		t.Errorf("unexpected ext/desc: %s / %s", ext, desc)
	}
	want := []string{
		"-i", "anim.webp",
		"-ss", "1", "-t", "1.5",
		"-c:v", "libwebp_anim",
		"-quality", "85",
		"-lossless", "1",
		"-loop", "5",
	}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoAnimTrimArgs_MultiSegment(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimTrimParams{
		// Unsorted + one exact duplicate: must be sorted and deduped to
		// [1-2] and [3-4], which are adjacent (allowed).
		Segments: []TrimSegment{
			{Start: "3", End: "4"},
			{Start: "1", End: "2"},
			{Start: "1", End: "2"},
		},
		LoopCount: 0,
	})
	args, desc, ext, err := BuildVideoAnimTrimArgs("anim.gif", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".gif" || desc != "trim_multi" {
		t.Errorf("unexpected ext/desc: %s / %s", ext, desc)
	}
	wantFilter := "[0:v]trim=start=1:end=2,setpts=PTS-STARTPTS[v0];" +
		"[0:v]trim=start=3:end=4,setpts=PTS-STARTPTS[v1];" +
		"[v0][v1]concat=n=2:v=1:a=0[vc];" +
		"[vc]split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];" +
		"[b][p]paletteuse=dither=sierra2_4a[v]"
	want := []string{"-i", "anim.gif", "-filter_complex", wantFilter, "-map", "[v]", "-loop", "0"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoAnimTrimArgs_MultiSegmentWebp(t *testing.T) {
	raw, _ := json.Marshal(VideoAnimTrimParams{
		Segments:  []TrimSegment{{Start: "0", End: "0.5"}, {Start: "1", End: "1.5"}},
		LoopCount: 0,
	})
	args, desc, ext, err := BuildVideoAnimTrimArgs("anim.webp", raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ext != ".webp" || desc != "trim_multi" {
		t.Errorf("unexpected ext/desc: %s / %s", ext, desc)
	}
	wantFilter := "[0:v]trim=start=0:end=0.5,setpts=PTS-STARTPTS[v0];" +
		"[0:v]trim=start=1:end=1.5,setpts=PTS-STARTPTS[v1];" +
		"[v0][v1]concat=n=2:v=1:a=0[vc]"
	want := []string{"-i", "anim.webp", "-filter_complex", wantFilter, "-map", "[vc]",
		"-c:v", "libwebp_anim", "-quality", "80", "-lossless", "0", "-loop", "0"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("unexpected args:\n got: %v\nwant: %v", args, want)
	}
}

func TestBuildVideoAnimTrimArgs_Invalid(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		params VideoAnimTrimParams
	}{
		{"non-animated input", "clip.mp4", VideoAnimTrimParams{Start: "0", Duration: "1"}},
		{"no times at all", "anim.gif", VideoAnimTrimParams{}},
		{"webp loop -1", "anim.webp", VideoAnimTrimParams{Start: "0", Duration: "1", LoopCount: -1}},
		{"gif loop -2", "anim.gif", VideoAnimTrimParams{Start: "0", Duration: "1", LoopCount: -2}},
		{"overlapping segments", "anim.gif", VideoAnimTrimParams{
			Segments: []TrimSegment{{Start: "1", End: "3"}, {Start: "2", End: "4"}},
		}},
		{"empty segment", "anim.gif", VideoAnimTrimParams{
			Segments: []TrimSegment{{Start: "1", End: "1"}},
		}},
		{"reversed segment", "anim.gif", VideoAnimTrimParams{
			Segments: []TrimSegment{{Start: "2", End: "1"}},
		}},
		{"bad segment time", "anim.gif", VideoAnimTrimParams{
			Segments: []TrimSegment{{Start: "abc", End: "4"}},
		}},
		{"negative segment", "anim.gif", VideoAnimTrimParams{
			Segments: []TrimSegment{{Start: "-1", End: "1"}},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			if _, _, _, err := BuildVideoAnimTrimArgs(tt.input, raw); err == nil {
				t.Fatalf("expected error for %s", tt.name)
			}
		})
	}
}
