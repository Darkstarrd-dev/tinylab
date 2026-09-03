package mediaedit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tinylab/tinylab/internal/procutil"
)

// validateLocalMediaInput rejects non-local inputs (URLs, pipes, devices)
// before they reach ffprobe/ffmpeg: the path must exist and be a regular
// file, and must not carry a URL scheme. Combined with the per-process
// -protocol_whitelist this closes the ffprobe/ffmpeg SSRF vector.
func validateLocalMediaInput(path string) error {
	if strings.Contains(path, "://") {
		return fmt.Errorf("only local files are supported as media inputs")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid input path: %w", err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("input file not found: %s", path)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("input is not a regular file: %s", path)
	}
	return nil
}

// subtitleUploadDir is the server-managed directory that subtitle uploads
// land in. Subtitle inputs must resolve inside it so a client cannot point
// ffmpeg at an arbitrary local file.
func subtitleUploadDir() string {
	return filepath.Join(os.TempDir(), "tinylab-subs")
}

// validateSubtitleInput restricts subtitle inputs to files that were
// server-uploaded into subtitleUploadDir: URL schemes are rejected and the
// resolved path must be contained in the upload directory.
func validateSubtitleInput(path string) error {
	if path == "" {
		return nil
	}
	if strings.Contains(path, "://") {
		return fmt.Errorf("only local subtitle files are supported")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid subtitle path: %w", err)
	}
	root := filepath.Clean(subtitleUploadDir())
	if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return fmt.Errorf("subtitle path is not a server-uploaded file: %s", path)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("subtitle file not found: %s", path)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("subtitle is not a regular file: %s", path)
	}
	return nil
}

// ffprobeProtocolWhitelist restricts ffprobe input protocols to local files.
// A URL passed by mistake (or by an attacker) is refused by ffprobe itself.
const ffprobeProtocolWhitelist = "file"

// Probe runs ffprobe against a local media file and returns structured
// metadata. The input must be an existing regular file: network URLs and
// other protocols are rejected (SSRF via ffprobe).
func Probe(ffprobePath, path string) (*ProbeResult, error) {
	if err := validateLocalMediaInput(path); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-protocol_whitelist", ffprobeProtocolWhitelist,
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
		"-protocol_whitelist", ffprobeProtocolWhitelist,
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
