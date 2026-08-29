package music

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// lookupFFmpeg probes PATH for ffmpeg.
func lookupFFmpeg() (string, error) {
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", err
	}
	return p, nil
}

func runFFmpegTranscode(ctx context.Context, ffmpegPath string, input []byte, format string) ([]byte, error) {
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
	cmd.Stdin = bytes.NewReader(input)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		msg := errBuf.String()
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("ffmpeg: %s", msg)
	}
	return outBuf.Bytes(), nil
}
