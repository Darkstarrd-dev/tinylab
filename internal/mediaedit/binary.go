package mediaedit

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ResolveFfmpeg resolves the ffmpeg binary path:
//  1. configuredPath (from config Download.FfmpegPath)
//  2. environment variable FFMPEG_PATH
//  3. PATH lookup ("ffmpeg")
func ResolveFfmpeg(configuredPath string) (string, error) {
	if configuredPath != "" {
		return configuredPath, nil
	}
	if env := os.Getenv("FFMPEG_PATH"); env != "" {
		return env, nil
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("ffmpeg not found (set download.ffmpegPath, FFMPEG_PATH, or put ffmpeg in PATH)")
	}
	return path, nil
}

// ResolveFfprobe resolves the ffprobe binary path:
//  1. environment variable FFPROBE_PATH
//  2. derive from ffmpegPath: same dir, replace "ffmpeg" with "ffprobe" in basename
//     (handles .exe on Windows via string replace on the basename)
//  3. fall back to PATH lookup ("ffprobe")
func ResolveFfprobe(ffmpegPath string) (string, error) {
	if env := os.Getenv("FFPROBE_PATH"); env != "" {
		return env, nil
	}

	// Derive from ffmpeg path: same directory, replace ffmpeg→ffprobe.
	dir := filepath.Dir(ffmpegPath)
	base := filepath.Base(ffmpegPath)
	base = strings.Replace(base, "ffmpeg", "ffprobe", 1)
	candidate := filepath.Join(dir, base)
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}

	path, err := exec.LookPath("ffprobe")
	if err != nil {
		return "", fmt.Errorf("ffprobe not found (set FFPROBE_PATH, place ffprobe next to ffmpeg, or put ffprobe in PATH)")
	}
	return path, nil
}

// --- FFmpeg capability probe ---

// FfmpegCaps reports which animated-image codecs the resolved ffmpeg build
// provides. Gif and WebpAnim are encoder capabilities; WebpAnimDecode is a
// decoder capability. A false capability does not imply a broken ffmpeg — the
// build may simply omit the codec.
type FfmpegCaps struct {
	Gif            bool
	WebpAnim       bool
	WebpAnimDecode bool
}

// ffmpegCapsCache caches capability probes per absolute ffmpeg path so a
// Settings-driven ffmpeg path change never reuses a stale result and repeated
// status checks do not spawn ffmpeg on every request.
var ffmpegCapsCache = struct {
	sync.Mutex
	m map[string]*ffmpegCapsEntry
}{m: make(map[string]*ffmpegCapsEntry)}

type ffmpegCapsEntry struct {
	caps FfmpegCaps
	err  error
}

// ProbeFfmpegCaps inspects the ffmpeg build at ffmpegPath and reports which
// animated-image codecs it provides: the gif and libwebp_anim encoders
// (-encoders) and the webp_anim decoder (-decoders). Results (including
// failures) are cached once per absolute path. On exec failure all
// capabilities report false and the error is returned.
func ProbeFfmpegCaps(ffmpegPath string) (FfmpegCaps, error) {
	abs, err := filepath.Abs(ffmpegPath)
	if err != nil {
		abs = ffmpegPath
	}

	ffmpegCapsCache.Lock()
	defer ffmpegCapsCache.Unlock()
	if e, ok := ffmpegCapsCache.m[abs]; ok {
		return e.caps, e.err
	}

	encoders, err := ffmpegListCodecs(ffmpegPath, "-encoders")
	if err != nil {
		e := &ffmpegCapsEntry{err: err}
		ffmpegCapsCache.m[abs] = e
		return e.caps, e.err
	}
	decoders, err := ffmpegListCodecs(ffmpegPath, "-decoders")
	if err != nil {
		e := &ffmpegCapsEntry{err: err}
		ffmpegCapsCache.m[abs] = e
		return e.caps, e.err
	}

	caps := FfmpegCaps{
		Gif:            encoders["gif"],
		WebpAnim:       encoders["libwebp_anim"],
		WebpAnimDecode: decoders["webp_anim"],
	}
	e := &ffmpegCapsEntry{caps: caps}
	ffmpegCapsCache.m[abs] = e
	return e.caps, e.err
}

// ffmpegListCodecs runs `ffmpeg -hide_banner <flag>` (flag = "-encoders" or
// "-decoders") and returns the set of bare codec name tokens present.
func ffmpegListCodecs(ffmpegPath, flag string) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath, "-hide_banner", flag)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", flag, err)
	}
	return parseCodecListOutput(string(out)), nil
}

// parseCodecListOutput extracts codec name tokens from `ffmpeg -hide_banner
// -encoders` / `-decoders` output. Each codec is one line with a leading
// 6-char flag column, e.g. " V....D gif  GIF (Graphics Interchange Format)",
// so the 2nd whitespace-delimited field is the codec name. Legend lines
// ("V..... = Video") and the "Encoders:"/separator headers are skipped.
func parseCodecListOutput(out string) map[string]bool {
	names := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[1] == "=" {
			continue
		}
		names[fields[1]] = true
	}
	return names
}
