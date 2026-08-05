package mediaedit

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
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
// Supports single-segment (Start/Duration) and multi-segment (Segments)
// trim. Multi-segment uses filter_complex with trim/atrim/concat filters
// and always re-encodes.
func BuildVideoTrimArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoTrimParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_trim params: %w", err)
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

	// Multi-segment: use filter_complex with trim/atrim/concat.
	if len(p.Segments) > 1 {
		return buildMultiSegmentTrimArgs(inputPath, &p, ext)
	}

	// Single segment from Segments array: convert to Start/Duration.
	if len(p.Segments) == 1 {
		startSec, errS := strconv.ParseFloat(p.Segments[0].Start, 64)
		endSec, errE := strconv.ParseFloat(p.Segments[0].End, 64)
		if errS != nil || errE != nil || endSec <= startSec {
			return nil, "", "", fmt.Errorf("invalid segment start/end times")
		}
		p.Start = p.Segments[0].Start
		p.Duration = strconv.FormatFloat(endSec-startSec, 'f', -1, 64)
	}

	// Validate single-segment params.
	if p.Start == "" || p.Duration == "" {
		return nil, "", "", fmt.Errorf("start and duration are required for video_trim")
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

// buildMultiSegmentTrimArgs constructs ffmpeg args for trimming and
// concatenating multiple segments using filter_complex. Always re-encodes.
func buildMultiSegmentTrimArgs(inputPath string, p *VideoTrimParams, ext string) ([]string, string, string, error) {
	lib, ok := codecToLib[p.Codec]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown codec: %s", p.Codec)
	}
	crf, ok := crfTable[p.Codec][p.QualityTier]
	if !ok {
		return nil, "", "", fmt.Errorf("unknown quality tier: %s for codec %s", p.QualityTier, p.Codec)
	}

	n := len(p.Segments)

	// Build filter_complex graph.
	var filters []string
	for i, seg := range p.Segments {
		startSec, errS := strconv.ParseFloat(seg.Start, 64)
		endSec, errE := strconv.ParseFloat(seg.End, 64)
		if errS != nil || errE != nil || endSec <= startSec {
			return nil, "", "", fmt.Errorf("invalid segment %d start/end times", i)
		}
		filters = append(filters, fmt.Sprintf(
			"[0:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS[v%d]",
			seg.Start, seg.End, i))
		if p.HasAudio {
			filters = append(filters, fmt.Sprintf(
				"[0:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS[a%d]",
				seg.Start, seg.End, i))
		}
	}

	// Concat filter.
	var concatInputs string
	for i := range n {
		concatInputs += fmt.Sprintf("[v%d]", i)
		if p.HasAudio {
			concatInputs += fmt.Sprintf("[a%d]", i)
		}
	}
	if p.HasAudio {
		filters = append(filters, concatInputs+
			fmt.Sprintf("concat=n=%d:v=1:a=1[v][a]", n))
	} else {
		filters = append(filters, concatInputs+
			fmt.Sprintf("concat=n=%d:v=1:a=0[v]", n))
	}

	filterComplex := strings.Join(filters, ";")

	args := []string{
		"-i", inputPath,
		"-filter_complex", filterComplex,
	}

	if p.HasAudio {
		args = append(args, "-map", "[v]", "-map", "[a]")
	} else {
		args = append(args, "-map", "[v]")
	}

	args = append(args, "-c:v", lib, "-crf", strconv.Itoa(crf), "-preset", "medium")
	if p.HasAudio {
		args = append(args, "-c:a", "aac")
	}

	if p.Codec == "vp9" {
		args = append(args, "-b:v", "0")
	}
	if p.Codec == "av1" {
		args = append(args, "-cpu-used", "4")
	}

	desc := "trim_multi"
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

// --- video_to_gif / video_to_webp / video_anim_trim ---

// animDithers is the whitelist of paletteuse dither values accepted from user
// input. Anything outside this set is rejected, never interpolated.
var animDithers = map[string]bool{
	"none":            true,
	"bayer":           true,
	"floyd_steinberg": true,
	"sierra2_4a":      true,
}

// normalizeAnimParams fills in defaults (0 = unspecified) and validates the
// numeric fields shared by the animated-image operations. Explicit
// out-of-range values are rejected rather than silently clamped.
func normalizeAnimParams(fps, quality, paletteColors int, dither string) (int, int, int, string, error) {
	if fps == 0 {
		fps = 12
	}
	if fps < 1 || fps > 60 {
		return 0, 0, 0, "", fmt.Errorf("fps must be 1-60, got %d", fps)
	}
	if quality == 0 {
		quality = 80
	}
	if quality < 1 || quality > 100 {
		return 0, 0, 0, "", fmt.Errorf("quality must be 1-100, got %d", quality)
	}
	if paletteColors == 0 {
		paletteColors = 256
	}
	if paletteColors < 2 || paletteColors > 256 {
		return 0, 0, 0, "", fmt.Errorf("paletteColors must be 2-256, got %d", paletteColors)
	}
	if dither == "" {
		dither = "sierra2_4a"
	}
	if !animDithers[dither] {
		return 0, 0, 0, "", fmt.Errorf("unsupported dither %q (allowed: none, bayer, floyd_steinberg, sierra2_4a)", dither)
	}
	return fps, quality, paletteColors, dither, nil
}

// parseSeconds parses a seconds string and requires a non-negative, finite
// value. The canonical decimal form is used downstream so exotic input forms
// (scientific notation, hex floats) never reach the filter graph.
func parseSeconds(s string) (float64, error) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid seconds %q: %v", s, err)
	}
	if v < 0 || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, fmt.Errorf("invalid seconds %q: must be non-negative", s)
	}
	return v, nil
}

// buildAnimTimeInputOptions validates Start/Duration ("" = omit) and returns
// the input-side options placed before -i: -ss START and/or -t DURATION.
func buildAnimTimeInputOptions(start, duration string) ([]string, error) {
	var opts []string
	if start != "" {
		s, err := parseSeconds(start)
		if err != nil {
			return nil, fmt.Errorf("invalid start: %w", err)
		}
		opts = append(opts, "-ss", strconv.FormatFloat(s, 'f', -1, 64))
	}
	if duration != "" {
		d, err := parseSeconds(duration)
		if err != nil {
			return nil, fmt.Errorf("invalid duration: %w", err)
		}
		opts = append(opts, "-t", strconv.FormatFloat(d, 'f', -1, 64))
	}
	return opts, nil
}

// buildAnimVideoFilterChain builds the common fps/crop/scale filter chain for
// the animated-image export operations. crop is emitted as
// crop=iw-L-R:ih-T-B:L:T only when any edge is non-zero; scale is omitted when
// both dimensions are 0 and preserves aspect ratio when only one is given.
func buildAnimVideoFilterChain(fps, width, height, cropLeft, cropRight, cropTop, cropBottom int) (string, error) {
	if fps < 1 || fps > 60 {
		return "", fmt.Errorf("fps must be 1-60, got %d", fps)
	}
	if width < 0 || height < 0 {
		return "", fmt.Errorf("width/height must be non-negative, got %dx%d", width, height)
	}
	if cropLeft < 0 || cropRight < 0 || cropTop < 0 || cropBottom < 0 {
		return "", fmt.Errorf("crop values must be non-negative, got %d/%d/%d/%d", cropLeft, cropRight, cropTop, cropBottom)
	}

	parts := []string{fmt.Sprintf("fps=%d", fps)}
	if cropLeft != 0 || cropRight != 0 || cropTop != 0 || cropBottom != 0 {
		parts = append(parts, fmt.Sprintf("crop=iw-%d-%d:ih-%d-%d:%d:%d",
			cropLeft, cropRight, cropTop, cropBottom, cropLeft, cropTop))
	}
	switch {
	case width > 0 && height > 0:
		parts = append(parts, fmt.Sprintf("scale=%d:%d", width, height))
	case width > 0:
		parts = append(parts, fmt.Sprintf("scale=%d:-2", width))
	case height > 0:
		parts = append(parts, fmt.Sprintf("scale=-2:%d", height))
	}
	return strings.Join(parts, ","), nil
}

// BuildVideoToGifArgs returns the ffmpeg args for video_to_gif. The GIF is
// produced by a single-pass palettegraph (split → palettegen → paletteuse) so
// the job runner needs only one ffmpeg invocation and no temporary palette
// file. -loop is a GIF muxer option: -1 = no loop, 0 = infinite, positive =
// repeat count (muxer range -1..65535).
func BuildVideoToGifArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoAnimParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_to_gif params: %w", err)
	}
	fps, _, paletteColors, dither, err := normalizeAnimParams(p.FPS, p.Quality, p.PaletteColors, p.Dither)
	if err != nil {
		return nil, "", "", err
	}
	if p.LoopCount < -1 || p.LoopCount > 65535 {
		return nil, "", "", fmt.Errorf("loopCount must be -1 (no loop), 0 (infinite) or 1-65535 (repeat count), got %d", p.LoopCount)
	}
	chain, err := buildAnimVideoFilterChain(fps, p.Width, p.Height, p.CropLeft, p.CropRight, p.CropTop, p.CropBottom)
	if err != nil {
		return nil, "", "", err
	}
	timeOpts, err := buildAnimTimeInputOptions(p.Start, p.Duration)
	if err != nil {
		return nil, "", "", err
	}

	filterComplex := fmt.Sprintf(
		"[0:v]%s,split[a][b];[a]palettegen=stats_mode=diff:max_colors=%d[p];[b][p]paletteuse=dither=%s[v]",
		chain, paletteColors, dither)

	args := append([]string{}, timeOpts...)
	args = append(args, "-i", inputPath, "-filter_complex", filterComplex, "-map", "[v]", "-loop", strconv.Itoa(p.LoopCount))
	desc := fmt.Sprintf("gif_fps%d", fps)
	return args, desc, ".gif", nil
}

// BuildVideoToWebpArgs returns the ffmpeg args for video_to_webp. The output
// uses the libwebp_anim encoder (quality/lossless are its encoder options;
// -loop is a WebP muxer option with range 0..65535 — -1 is rejected because
// the WebP muxer has no "no loop" value).
func BuildVideoToWebpArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoAnimParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_to_webp params: %w", err)
	}
	fps, quality, _, _, err := normalizeAnimParams(p.FPS, p.Quality, p.PaletteColors, p.Dither)
	if err != nil {
		return nil, "", "", err
	}
	if p.LoopCount < 0 || p.LoopCount > 65535 {
		return nil, "", "", fmt.Errorf("webp loopCount must be 0 (infinite) or 1-65535 (repeat count), got %d", p.LoopCount)
	}
	chain, err := buildAnimVideoFilterChain(fps, p.Width, p.Height, p.CropLeft, p.CropRight, p.CropTop, p.CropBottom)
	if err != nil {
		return nil, "", "", err
	}
	timeOpts, err := buildAnimTimeInputOptions(p.Start, p.Duration)
	if err != nil {
		return nil, "", "", err
	}

	lossless := "0"
	if p.Lossless {
		lossless = "1"
	}
	args := append([]string{}, timeOpts...)
	args = append(args, "-i", inputPath, "-vf", chain,
		"-c:v", "libwebp_anim",
		"-quality", strconv.Itoa(quality),
		"-lossless", lossless,
		"-loop", strconv.Itoa(p.LoopCount))
	desc := fmt.Sprintf("webp_q%d", quality)
	return args, desc, ".webp", nil
}

// BuildVideoAnimTrimArgs returns the ffmpeg args for video_anim_trim: precise
// time-based trimming of an animated GIF or WebP, re-encoded into the SAME
// container format as the input. Multi-segment trims use a trim/concat
// filter_complex. Animated inputs must never fall through to the H.264
// video_trim path, so any non-gif/webp input is rejected here.
func BuildVideoAnimTrimArgs(inputPath string, raw json.RawMessage) ([]string, string, string, error) {
	var p VideoAnimTrimParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, "", "", fmt.Errorf("invalid video_anim_trim params: %w", err)
	}
	ext := strings.ToLower(filepath.Ext(inputPath))
	if ext != ".gif" && ext != ".webp" {
		return nil, "", "", fmt.Errorf("video_anim_trim only supports .gif/.webp inputs, got %q", ext)
	}

	_, quality, paletteColors, dither, err := normalizeAnimParams(0, p.Quality, p.PaletteColors, p.Dither)
	if err != nil {
		return nil, "", "", err
	}
	if p.LoopCount < -1 || p.LoopCount > 65535 {
		return nil, "", "", fmt.Errorf("loopCount must be -1 (no loop), 0 (infinite) or 1-65535 (repeat count), got %d", p.LoopCount)
	}
	if ext == ".webp" && p.LoopCount < 0 {
		return nil, "", "", fmt.Errorf("webp loopCount must be non-negative (0=infinite), got %d", p.LoopCount)
	}
	if len(p.Segments) > 0 {
		return buildAnimTrimMultiSegmentArgs(inputPath, &p, ext, quality, paletteColors, dither)
	}
	if p.Start == "" && p.Duration == "" {
		return nil, "", "", fmt.Errorf("start/duration or segments are required for video_anim_trim")
	}
	timeOpts, err := buildAnimTimeInputOptions(p.Start, p.Duration)
	if err != nil {
		return nil, "", "", err
	}
	desc := "trim_" + sanitizeTimestamp(p.Start)
	if p.Start == "" {
		desc = "trim_head"
	}
	// -ss/-t are placed AFTER -i as output options: the animated WebP demuxer
	// cannot seek with input-side -ss (it yields zero frames and libwebp_anim
	// fails), while output-side -ss decodes-and-discards and works for both
	// GIF and WebP inputs.
	var args []string
	switch ext {
	case ".gif":
		args = append(args, "-i", inputPath)
		args = append(args, timeOpts...)
		args = append(args,
			"-filter_complex", fmt.Sprintf("[0:v]split[a][b];[a]palettegen=stats_mode=diff:max_colors=%d[p];[b][p]paletteuse=dither=%s[v]",
				paletteColors, dither),
			"-map", "[v]", "-loop", strconv.Itoa(p.LoopCount))
	case ".webp":
		lossless := "0"
		if p.Lossless {
			lossless = "1"
		}
		args = append(args, "-i", inputPath)
		args = append(args, timeOpts...)
		args = append(args,
			"-c:v", "libwebp_anim",
			"-quality", strconv.Itoa(quality),
			"-lossless", lossless,
			"-loop", strconv.Itoa(p.LoopCount))
	}
	return args, desc, ext, nil
}

// buildAnimTrimMultiSegmentArgs trims multiple disjoint time ranges and
// concatenates them into one animated image via filter_complex. Segments are
// sorted by start time, exact duplicates removed, and empty or overlapping
// ranges rejected (adjacent ranges are allowed). Animated images carry no
// audio, so only the video stream is trimmed/concat'ed.
func buildAnimTrimMultiSegmentArgs(inputPath string, p *VideoAnimTrimParams, ext string, quality, paletteColors int, dither string) ([]string, string, string, error) {
	parsed := make([]TrimSegment, 0, len(p.Segments))
	for i, seg := range p.Segments {
		s, errS := parseSeconds(seg.Start)
		e, errE := parseSeconds(seg.End)
		if errS != nil || errE != nil {
			return nil, "", "", fmt.Errorf("invalid segment %d start/end times", i)
		}
		if e <= s {
			return nil, "", "", fmt.Errorf("invalid segment %d: end must be greater than start", i)
		}
		parsed = append(parsed, TrimSegment{
			Start: strconv.FormatFloat(s, 'f', -1, 64),
			End:   strconv.FormatFloat(e, 'f', -1, 64),
		})
	}

	sort.SliceStable(parsed, func(i, j int) bool { return parsed[i].Start < parsed[j].Start })
	kept := parsed[:0]
	for _, seg := range parsed {
		if len(kept) > 0 && kept[len(kept)-1].Start == seg.Start && kept[len(kept)-1].End == seg.End {
			continue // exact duplicate
		}
		if len(kept) > 0 {
			prevEnd, _ := strconv.ParseFloat(kept[len(kept)-1].End, 64)
			segStart, _ := strconv.ParseFloat(seg.Start, 64)
			if segStart < prevEnd {
				return nil, "", "", fmt.Errorf("segments must not overlap")
			}
		}
		kept = append(kept, seg)
	}

	var filters []string
	for i, seg := range kept {
		filters = append(filters, fmt.Sprintf(
			"[0:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS[v%d]",
			seg.Start, seg.End, i))
	}
	var concatInputs string
	for i := range kept {
		concatInputs += fmt.Sprintf("[v%d]", i)
	}
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vc]", concatInputs, len(kept)))
	filterComplex := strings.Join(filters, ";")

	var args []string
	switch ext {
	case ".gif":
		filterComplex += fmt.Sprintf(";[vc]split[a][b];[a]palettegen=stats_mode=diff:max_colors=%d[p];[b][p]paletteuse=dither=%s[v]",
			paletteColors, dither)
		args = []string{"-i", inputPath, "-filter_complex", filterComplex, "-map", "[v]", "-loop", strconv.Itoa(p.LoopCount)}
	case ".webp":
		lossless := "0"
		if p.Lossless {
			lossless = "1"
		}
		args = []string{"-i", inputPath, "-filter_complex", filterComplex, "-map", "[vc]",
			"-c:v", "libwebp_anim",
			"-quality", strconv.Itoa(quality),
			"-lossless", lossless,
			"-loop", strconv.Itoa(p.LoopCount)}
	}
	return args, "trim_multi", ext, nil
}
