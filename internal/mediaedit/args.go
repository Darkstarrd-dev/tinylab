package mediaedit

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// --- Operation arg builders ---

// BuildImageTranscodeArgs returns the ffmpeg args for image_transcode.
// The caller prepends common flags and appends the output path.
func BuildImageTranscodeArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p ImageTranscodeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid image_transcode params: %w", err)
	}
	if p.ScalePercent == 0 {
		p.ScalePercent = 100
	}
	ext := formatExt(p.Format)

	args := []string{"-i", inputPath}

	// Scale filter.
	if p.ScalePercent != 100 && p.ScalePercent > 0 {
		ratio := float64(p.ScalePercent) / 100.0
		vf := fmt.Sprintf("scale='trunc(iw*%g/2)*2':'trunc(ih*%g/2)*2'", ratio, ratio)
		args = append(args, "-vf", vf)
	}

	// Quality.
	switch strings.ToLower(p.Format) {
	case "jpeg":
		q := jpegQuality(p.Quality)
		args = append(args, "-q:v", strconv.Itoa(q))
	case "webp":
		if p.Quality > 0 {
			args = append(args, "-quality", strconv.Itoa(p.Quality))
		}
	case "png":
		if p.Quality > 0 {
			level := clamp(int(math.Round(float64(100-p.Quality)*9.0/100.0)), 0, 9)
			args = append(args, "-compression_level", strconv.Itoa(level))
		}
	}

	// Strip metadata.
	if p.StripMetadata {
		args = append(args, "-map_metadata", "-1")
	}

	// Descriptor for output path.
	desc := strings.ToLower(p.Format)
	if p.Quality > 0 {
		desc = fmt.Sprintf("%s_q%d", desc, p.Quality)
	}

	return args, desc, ext, nil
}

// formatExt returns the file extension for an image format.
func formatExt(format string) string {
	switch strings.ToLower(format) {
	case "jpeg":
		return ".jpg"
	case "tiff":
		return ".tiff"
	default:
		return "." + strings.ToLower(format)
	}
}

// jpegQuality maps 0-100 quality to ffmpeg -q:v (1-31, lower=better).
func jpegQuality(q int) int {
	if q <= 0 {
		return 31
	}
	return clamp(1+int(math.Round(float64(100-q)*30.0/100.0)), 1, 31)
}

// --- video_transcode ---

var codecToLib = map[string]string{
	"h264": "libx264",
	"h265": "libx265",
	"vp9":  "libvpx-vp9",
	"av1":  "libaom-av1",
}

var crfTable = map[string]map[string]int{
	"h264": {"high": 20, "medium": 23, "low": 27},
	"h265": {"high": 22, "medium": 28, "low": 32},
	"vp9":  {"high": 28, "medium": 31, "low": 36},
	"av1":  {"high": 28, "medium": 32, "low": 36},
}

var containerExt = map[string]string{
	"mp4":  ".mp4",
	"mkv":  ".mkv",
	"webm": ".webm",
	"mov":  ".mov",
}

var compatibleCodecs = map[string]map[string]bool{
	"mp4":  {"h264": true, "h265": true},
	"webm": {"vp9": true, "av1": true},
	"mkv":  {"h264": true, "h265": true, "vp9": true, "av1": true},
	"mov":  {"h264": true, "h265": true},
}

// BuildVideoTranscodeArgs returns the ffmpeg args for video_transcode.
func BuildVideoTranscodeArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoTranscodeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_transcode params: %w", err)
	}
	if p.ScalePercent == 0 {
		p.ScalePercent = 100
	}
	if p.Preset == "" {
		p.Preset = "medium"
	}
	if p.AudioCodec == "" {
		p.AudioCodec = "aac"
	}
	if p.AudioBitrate == "" {
		p.AudioBitrate = "128k"
	}
	if p.QualityTier == "" {
		p.QualityTier = "medium"
	}

	ext, ok := containerExt[p.Container]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown container: %s", p.Container)
	}

	args := []string{"-i", inputPath}

	if p.Codec == "copy" {
		args = append(args, "-c", "copy")
		if p.StripMetadata {
			args = append(args, "-map_metadata", "-1")
		}
		desc := "remux"
		return args, desc, ext, nil
	}

	// Validate codec-container compatibility.
	allowed, exists := compatibleCodecs[p.Container]
	if !exists {
		return nil, "", "", fmt.Errorf("unknown container: %s", p.Container)
	}
	if !allowed[p.Codec] {
		return nil, "", "", fmt.Errorf("codec %s is not compatible with container %s", p.Codec, p.Container)
	}

	lib, ok := codecToLib[p.Codec]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown codec: %s", p.Codec)
	}

	crf, ok := crfTable[p.Codec][p.QualityTier]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown quality tier: %s for codec %s", p.QualityTier, p.Codec)
	}

	args = append(args, "-c:v", lib, "-crf", strconv.Itoa(crf))

	if p.Codec == "vp9" {
		args = append(args, "-b:v", "0")
	}

	if p.Codec == "av1" {
		args = append(args, "-cpu-used", "4")
	}

	args = append(args, "-preset", p.Preset)

	if p.ScalePercent != 100 && p.ScalePercent > 0 {
		ratio := float64(p.ScalePercent) / 100.0
		vf := fmt.Sprintf("scale='trunc(iw*%g/2)*2':'trunc(ih*%g/2)*2'", ratio, ratio)
		args = append(args, "-vf", vf)
	}

	switch p.AudioCodec {
	case "aac":
		args = append(args, "-c:a", "aac", "-b:a", p.AudioBitrate)
	case "opus":
		args = append(args, "-c:a", "libopus", "-b:a", p.AudioBitrate)
	case "mp3":
		args = append(args, "-c:a", "libmp3lame", "-b:a", p.AudioBitrate)
	case "copy":
		args = append(args, "-c:a", "copy")
	case "none":
		args = append(args, "-an")
	}

	if p.StripMetadata {
		args = append(args, "-map_metadata", "-1")
	}

	if p.Container == "mp4" {
		args = append(args, "-movflags", "+faststart")
	}

	desc := fmt.Sprintf("%s_%s", p.Codec, p.QualityTier)
	return args, desc, ext, nil
}

// --- video_trim ---

// BuildVideoTrimArgs returns the ffmpeg args for video_trim.
func BuildVideoTrimArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoTrimParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_trim params: %w", err)
	}
	if p.Start == "" || p.Duration == "" {
		return nil, "", "", fmt.Errorf("start and duration are required for video_trim")
	}
	if p.Codec == "" {
		p.Codec = "h264"
	}
	if p.QualityTier == "" {
		p.QualityTier = "medium"
	}

	ext := filepath.Ext(inputPath)
	if ext == "" {
		ext = ".mp4"
	}

	if !p.Reencode {
		args := []string{
			"-ss", p.Start,
			"-i", inputPath,
			"-t", p.Duration,
			"-c", "copy",
			"-avoid_negative_ts", "make_zero",
		}
		desc := "trim_" + sanitizeTimestamp(p.Start)
		return args, desc, ext, nil
	}

	lib, ok := codecToLib[p.Codec]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown codec: %s", p.Codec)
	}
	crf, ok := crfTable[p.Codec][p.QualityTier]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown quality tier: %s for codec %s", p.QualityTier, p.Codec)
	}

	args := []string{
		"-ss", p.Start,
		"-i", inputPath,
		"-t", p.Duration,
		"-c:v", lib, "-crf", strconv.Itoa(crf),
		"-preset", "medium",
		"-c:a", "aac",
	}

	if p.Codec == "vp9" {
		args = append(args, "-b:v", "0")
	}
	if p.Codec == "av1" {
		args = append(args, "-cpu-used", "4")
	}

	desc := "trim_" + sanitizeTimestamp(p.Start)
	return args, desc, ext, nil
}

// sanitizeTimestamp replaces colons and path separators for filename safety.
func sanitizeTimestamp(ts string) string {
	s := strings.ReplaceAll(ts, ":", "m")
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	return s
}

// --- video_subtitle ---

// BuildVideoSubtitleArgs returns the ffmpeg args for video_subtitle.
func BuildVideoSubtitleArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoSubtitleParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_subtitle params: %w", err)
	}
	if p.Container == "" {
		p.Container = "mkv"
	}
	if p.Language == "" {
		p.Language = "und"
	}
	if p.FontSize == 0 {
		p.FontSize = 24
	}

	ext, ok := containerExt[p.Container]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown container: %s", p.Container)
	}

	if p.Mode == "burn" {
		style := fmt.Sprintf("FontSize=%d", p.FontSize)
		if p.FontName != "" {
			style += fmt.Sprintf(",FontName=%s", p.FontName)
		}
		// Strip Windows drive letter prefix from the subtitle path to avoid
		// ffmpeg filter graph colon-parsing issues. On Windows ffmpeg builds,
		// absolute paths without a drive letter resolve relative to the current
		// drive, which is the same drive as the input/output files.
		noDrive := p.SubtitlePath
		if len(noDrive) >= 2 && noDrive[1] == ':' {
			noDrive = noDrive[2:]
		}
		// Use forward slashes and escape backslashes for filter graph safety.
		noDrive = strings.ReplaceAll(noDrive, "\\", "/")
		vf := fmt.Sprintf("subtitles=%s:force_style='%s'", noDrive, style)
		args := []string{
			"-i", inputPath,
			"-vf", vf,
			"-c:v", "libx264",
			"-crf", "23",
			"-preset", "medium",
			"-c:a", "aac",
		}
		if p.Container == "mp4" {
			args = append(args, "-movflags", "+faststart")
		}
		desc := "sub_burn"
		return args, desc, ext, nil
	}

	subCodec := subCodecForContainer(p.Container, p.SubtitlePath)

	args := []string{
		"-i", inputPath,
		"-i", p.SubtitlePath,
		"-c", "copy",
		"-c:s", subCodec,
		"-metadata:s:s:0", fmt.Sprintf("language=%s", p.Language),
	}
	desc := "sub_soft"
	return args, desc, ext, nil
}

// subCodecForContainer picks the subtitle codec.
func subCodecForContainer(container, subPath string) string {
	switch container {
	case "mp4":
		return "mov_text"
	case "mkv":
		if strings.HasSuffix(strings.ToLower(subPath), ".ass") {
			return "ass"
		}
		return "srt"
	default:
		return "srt"
	}
}

// escapeFilterPath escapes special characters for ffmpeg filter graphs.
func escapeFilterPath(p string) string {
	s := strings.ReplaceAll(p, "\\", "\\\\")
	s = strings.ReplaceAll(s, ":", "\\:")
	s = strings.ReplaceAll(s, "'", "\\'")
	return s
}

// --- Output path ---

// BuildOutputPath generates an output path from the input path, a descriptor
// string, and target extension. If overwrite is true, returns the input path
// itself.
func BuildOutputPath(inputPath, desc, ext string, overwrite bool) (string, error) {
	if overwrite {
		return inputPath, nil
	}

	dir := filepath.Dir(inputPath)
	base := filepath.Base(inputPath)
	name := strings.TrimSuffix(base, filepath.Ext(base))

	candidate := filepath.Join(dir, name+"_"+desc+ext)
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate, nil
	}

	for i := 2; i < 1000; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s_%s_%d%s", name, desc, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("could not find a free output path for %s after 999 attempts", inputPath)
}

// clamp returns v constrained to [lo, hi].
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
