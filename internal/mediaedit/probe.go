package mediaedit

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/procutil"
)

// probeOutput matches the ffprobe JSON output structure.
type probeOutput struct {
	Streams []probeStream `json:"streams"`
	Format  probeFormat   `json:"format"`
}

type probeStream struct {
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	CodecName  string `json:"codec_name"`
	Duration   string `json:"duration"`
	RFrameRate string `json:"r_frame_rate"`
	NbFrames   string `json:"nb_frames"`
	CodecType  string `json:"codec_type"`
}

type probeFormat struct {
	Duration string `json:"duration"`
}

// Probe runs ffprobe against a media file and returns structured metadata.
func Probe(ffprobePath, path string) (*ProbeResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,codec_name,codec_type,duration,r_frame_rate:format=duration",
		"-of", "json",
		path,
	)
	_ = procutil.SetProcessGroup(cmd)

	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("ffprobe timed out probing %s", path)
		}
		// stderr captured in err output for exec.Output
		return nil, fmt.Errorf("ffprobe failed: %w", err)
	}

	var po probeOutput
	if err := json.Unmarshal(out, &po); err != nil {
		return nil, fmt.Errorf("failed to parse ffprobe output: %w", err)
	}

	result := &ProbeResult{}

	// Find the first video stream.
	for _, s := range po.Streams {
		if s.CodecType == "video" {
			result.Width = s.Width
			result.Height = s.Height
			result.Codec = s.CodecName
			result.Duration = parseDuration(s.Duration)
			result.FrameRate = parseFrameRate(s.RFrameRate)
			break
		}
	}

	// Determine if this is an image: video stream with no duration (or "N/A")
	// and no frame count → still image.
	// Determine if this is an image: video stream with no duration.
	// Still images may report a nominal frame rate (e.g. "25/1"), so we
	// only check that the stream has no duration. Format-level duration
	// takes precedence when present (video with stream-level duration N/A).
	if result.Codec != "" && result.Duration == 0 {
		result.IsImage = true
		if d := parseDuration(po.Format.Duration); d > 0 {
			result.Duration = d
			result.IsImage = false
		}
	}

	// Check for audio stream.
	result.HasAudio = probeAudio(ctx, ffprobePath, path)

	return result, nil
}

// probeAudio checks whether the media file has an audio stream.
func probeAudio(ctx context.Context, ffprobePath, path string) bool {
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name",
		"-of", "csv=p=0",
		path,
	)
	_ = procutil.SetProcessGroup(cmd)

	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}

// parseDuration parses a duration string (seconds or "N/A") to float64.
func parseDuration(s string) float64 {
	if s == "" || s == "N/A" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}

// parseFrameRate parses r_frame_rate like "30000/1001" to float64.
func parseFrameRate(s string) float64 {
	if s == "" || s == "N/A" {
		return 0
	}
	parts := strings.SplitN(s, "/", 2)
	if len(parts) == 2 {
		num, err1 := strconv.ParseFloat(parts[0], 64)
		den, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 == nil && err2 == nil && den != 0 {
			return num / den
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}
