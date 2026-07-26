package mediaedit

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
