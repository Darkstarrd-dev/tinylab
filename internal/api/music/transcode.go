package music

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"time"
)

const (
	maxTranscodeOutput      = 300 << 20        // 300 MiB output cap
	maxTranscodeDuration    = 5 * time.Minute  // per-transcode deadline
	maxTranscodeConcurrency = 2
)

var transcodeSem = make(chan struct{}, maxTranscodeConcurrency)

// lookupFFmpeg probes PATH for ffmpeg.
func lookupFFmpeg() (string, error) {
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", err
	}
	return p, nil
}

// tryAcquireTranscode reports whether a transcode slot is available.
func tryAcquireTranscode() bool {
	select {
	case transcodeSem <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseTranscode() { <-transcodeSem }

// P0-07: pipe-streamed stdinPipe/stdoutPipe with output cap and deadline; concurrency gated by caller.
func runFFmpegTranscode(ctx context.Context, ffmpegPath string, input []byte, format string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, maxTranscodeDuration)
	defer cancel()
	args := []string{"-hide_banner", "-loglevel", "error", "-i", "pipe:0"}
	switch format {
	case "mp3":
		args = append(args, "-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1")
	case "opus":
		args = append(args, "-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "pipe:1")
	case "ogg":
		args = append(args, "-c:a", "libvorbis", "-q:a", "4", "-f", "ogg", "pipe:1")
	case "wav":
		args = append(args, "-c:a", "pcm_s16le", "-f", "wav", "pipe:1")
	default:
		args = append(args, "-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1")
	}
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg stdout pipe: %w", err)
	}
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Start(); err != nil {
		msg := errBuf.String()
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("ffmpeg: %s", msg)
	}
	// Stream input in background so we do not deadlock on pipe buffer.
	go func() {
		defer stdin.Close()
		_, _ = io.Copy(stdin, bytes.NewReader(input))
	}()
	// Cap output at maxTranscodeOutput+1 so overflow is detectable.
	limited := io.LimitReader(stdout, maxTranscodeOutput+1)
	out, readErr := io.ReadAll(limited)
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, fmt.Errorf("ffmpeg read output: %w", readErr)
	}
	if int64(len(out)) > maxTranscodeOutput {
		return nil, fmt.Errorf("transcoded output too large: %d > %d", len(out), maxTranscodeOutput)
	}
	if waitErr != nil {
		msg := errBuf.String()
		if msg == "" {
			msg = waitErr.Error()
		}
		return nil, fmt.Errorf("ffmpeg: %s", msg)
	}
	return out, nil
}
