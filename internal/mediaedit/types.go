// Package mediaedit provides a self-contained ffmpeg job runner for
// the Gallery media editor. It receives ffmpeg path and params via method
// args; does NOT import config, registry, or api packages (leaf).
package mediaedit

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// JobStatus represents the lifecycle state of an edit job.
type JobStatus string

const (
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusError     JobStatus = "error"
	StatusCancelled JobStatus = "cancelled"
)

// Job represents a single media edit operation backed by an ffmpeg subprocess.
type Job struct {
	ID         string    `json:"id"`
	Status     JobStatus `json:"status"`
	Progress   int       `json:"progress"`   // 0-100
	Operation  string    `json:"operation"`  // "image_transcode"|"video_transcode"|"video_trim"|"video_subtitle"
	InputPath  string    `json:"inputPath"`
	OutputPath string    `json:"outputPath"` // set on completion
	OutputName string    `json:"outputName"` // basename, set on completion
	Error      string    `json:"error"`      // set on error
	LogTail    string    `json:"logTail"`    // last ~16KB of ffmpeg stderr+progress
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`

	cancel context.CancelFunc
	mu     sync.RWMutex
}

// Snapshot returns a deep-enough copy for JSON serialization (excludes cancel).
func (j *Job) Snapshot() *Job {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return &Job{
		ID:         j.ID,
		Status:     j.Status,
		Progress:   j.Progress,
		Operation:  j.Operation,
		InputPath:  j.InputPath,
		OutputPath: j.OutputPath,
		OutputName: j.OutputName,
		Error:      j.Error,
		LogTail:    j.LogTail,
		StartedAt:  j.StartedAt,
		FinishedAt: j.FinishedAt,
	}
}

// ProbeResult holds media metadata extracted by ffprobe.
type ProbeResult struct {
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Codec     string  `json:"codec"`
	Duration  float64 `json:"duration"`  // seconds; 0 for images
	HasAudio  bool    `json:"hasAudio"`
	FrameRate float64 `json:"frameRate"` // 0 for images
	IsImage   bool    `json:"isImage"`
}

// StartRequest is the JSON body for starting an edit job.
type StartRequest struct {
	InputPath string          `json:"inputPath"`
	Operation string          `json:"operation"`
	Overwrite bool            `json:"overwrite"`
	OutputDir string          `json:"outputDir,omitempty"` // optional; if set and !Overwrite, output goes to this dir
	Params    json.RawMessage `json:"params"`              // operation-specific, parsed by args builder
}

// ImageTranscodeParams holds options for the image_transcode operation.
type ImageTranscodeParams struct {
	Format        string `json:"format"`        // "jpeg"|"png"|"webp"|"bmp"|"tiff"|"gif"
	Quality       int    `json:"quality"`       // 0-100
	ScalePercent  int    `json:"scalePercent"`  // 10-200; 100=original; 0 means 100
	StripMetadata bool   `json:"stripMetadata"`
}

// VideoTranscodeParams holds options for the video_transcode operation.
type VideoTranscodeParams struct {
	Codec         string `json:"codec"`         // "h264"|"h265"|"vp9"|"av1"|"copy"
	Container     string `json:"container"`     // "mp4"|"mkv"|"webm"|"mov"
	QualityTier   string `json:"qualityTier"`   // "high"|"medium"|"low"
	Preset        string `json:"preset"`        // "ultrafast"|"fast"|"medium"|"slow"|"veryslow"
	ScalePercent  int    `json:"scalePercent"`  // 100=original
	AudioCodec    string `json:"audioCodec"`    // "aac"|"opus"|"mp3"|"copy"|"none"
	AudioBitrate  string `json:"audioBitrate"`  // e.g. "128k"
	StripMetadata bool   `json:"stripMetadata"`
}

// VideoTrimParams holds options for the video_trim operation.
type VideoTrimParams struct {
	Start       string `json:"start"`       // "HH:MM:SS" or seconds string
	Duration    string `json:"duration"`    // "HH:MM:SS" or seconds string
	Reencode    bool   `json:"reencode"`
	Codec       string `json:"codec"`       // used when Reencode; default "h264"
	QualityTier string `json:"qualityTier"` // default "medium"
}

// VideoSubtitleParams holds options for the video_subtitle operation.
type VideoSubtitleParams struct {
	SubtitlePath string `json:"subtitlePath"` // abs path to .srt/.ass
	Mode         string `json:"mode"`         // "burn"|"soft"
	Language     string `json:"language"`     // e.g. "eng"; default "und"
	FontSize     int    `json:"fontSize"`     // burn mode; default 24
	FontName     string `json:"fontName"`     // burn mode; default ""
	Container    string `json:"container"`    // "mp4"|"mkv"; default "mkv"
}
