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
	ID         string      `json:"id"`
	Status     JobStatus   `json:"status"`
	Progress   int         `json:"progress"`  // 0-100
	Operation  string      `json:"operation"` // "image_transcode"|"video_transcode"|"video_trim"|"video_subtitle"|"video_to_gif"|"video_to_webp"|"video_anim_trim"
	InputPath  string      `json:"inputPath"`
	OutputPath string      `json:"outputPath"` // set on completion
	OutputName string      `json:"outputName"` // basename, set on completion
	Error      string      `json:"error"`      // set on error
	LogTail    string      `json:"logTail"`    // last ~16KB of ffmpeg stderr+progress
	Command    string      `json:"command"`    // ffmpeg full command line
	logBuf     *tailBuffer // unexported, live log buffer reference (not serialized)
	StartedAt  time.Time   `json:"startedAt"`
	FinishedAt time.Time   `json:"finishedAt"`

	cancel context.CancelFunc
	mu     sync.RWMutex
}

// Snapshot returns a deep-enough copy for JSON serialization (excludes cancel).
func (j *Job) Snapshot() *Job {
	j.mu.RLock()
	defer j.mu.RUnlock()
	snap := &Job{
		ID:         j.ID,
		Status:     j.Status,
		Progress:   j.Progress,
		Operation:  j.Operation,
		InputPath:  j.InputPath,
		OutputPath: j.OutputPath,
		OutputName: j.OutputName,
		Error:      j.Error,
		Command:    j.Command,
		StartedAt:  j.StartedAt,
		FinishedAt: j.FinishedAt,
	}
	if j.logBuf != nil {
		snap.LogTail = j.logBuf.Read()
	} else {
		snap.LogTail = j.LogTail
	}
	return snap
}

// ProbeResult holds media metadata extracted by ffprobe.
type ProbeResult struct {
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Codec     string  `json:"codec"`
	Duration  float64 `json:"duration"` // seconds; 0 for images
	HasAudio  bool    `json:"hasAudio"`
	FrameRate float64 `json:"frameRate"` // 0 for images
	IsImage   bool    `json:"isImage"`
}

// StartRequest is the JSON body for starting an edit job.
type StartRequest struct {
	InputPath  string          `json:"inputPath"`
	Operation  string          `json:"operation"`
	Overwrite  bool            `json:"overwrite"`
	OutputDir  string          `json:"outputDir,omitempty"`  // optional; if set and !Overwrite, output goes to this dir
	OutputName string          `json:"outputName,omitempty"` // optional file stem (no extension); when set and !Overwrite, used as the output filename (buildArgs supplies the extension); avoids leaking the temp/upload filename (e.g. gallery-edit-XXXX) into saved batch outputs
	Params     json.RawMessage `json:"params"`               // operation-specific, parsed by args builder
}

// ImageTranscodeParams holds options for the image_transcode operation.
type ImageTranscodeParams struct {
	Format        string `json:"format"`       // "jpeg"|"png"|"webp"|"bmp"|"tiff"|"gif"
	Quality       int    `json:"quality"`      // 0-100
	ScalePercent  int    `json:"scalePercent"` // 10-200; 100=original; 0 means 100
	StripMetadata bool   `json:"stripMetadata"`
}

// VideoTranscodeParams holds options for the video_transcode operation.
type VideoTranscodeParams struct {
	Codec         string `json:"codec"`        // "h264"|"h265"|"vp9"|"av1"|"copy"
	Container     string `json:"container"`    // "mp4"|"mkv"|"webm"|"mov"
	QualityTier   string `json:"qualityTier"`  // "high"|"medium"|"low"
	Preset        string `json:"preset"`       // "ultrafast"|"fast"|"medium"|"slow"|"veryslow"
	ScalePercent  int    `json:"scalePercent"` // 100=original
	AudioCodec    string `json:"audioCodec"`   // "aac"|"opus"|"mp3"|"copy"|"none"
	AudioBitrate  string `json:"audioBitrate"` // e.g. "128k"
	StripMetadata bool   `json:"stripMetadata"`
}

// TrimSegment represents a single trim range with start and end times
// (seconds as strings, e.g. "90.5").
type TrimSegment struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// VideoTrimParams holds options for the video_trim operation.
type VideoTrimParams struct {
	Start       string        `json:"start"`    // backward compat: single segment start (seconds string)
	Duration    string        `json:"duration"` // backward compat: single segment duration (seconds string)
	Segments    []TrimSegment `json:"segments"` // multi-segment; if non-empty, overrides Start/Duration
	Reencode    bool          `json:"reencode"`
	Codec       string        `json:"codec"`       // used when Reencode; default "h264"
	QualityTier string        `json:"qualityTier"` // default "medium"
	HasAudio    bool          `json:"hasAudio"`    // whether source has audio (for filter_complex)
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

// VideoAnimParams holds options for the video_to_gif / video_to_webp
// operations: a source video clip is re-encoded as an animated GIF or
// animated WebP in a single ffmpeg invocation.
type VideoAnimParams struct {
	Start         string `json:"start"`    // seconds string; "" = from start
	Duration      string `json:"duration"` // seconds string; "" = to end
	FPS           int    `json:"fps"`      // 1-60, default 12
	Width         int    `json:"width"`    // 0 = unspecified
	Height        int    `json:"height"`   // 0 = unspecified
	CropLeft      int    `json:"cropLeft"`
	CropRight     int    `json:"cropRight"`
	CropTop       int    `json:"cropTop"`
	CropBottom    int    `json:"cropBottom"`
	LoopCount     int    `json:"loopCount"`     // 0=infinite; GIF -1=no loop; WebP 0=infinite, positive=muxer semantics
	Quality       int    `json:"quality"`       // 1-100; GIF default palette tier, WebP encoder quality
	PaletteColors int    `json:"paletteColors"` // GIF 2-256, default 256
	Dither        string `json:"dither"`        // none|bayer|floyd_steinberg|sierra2_4a
	Lossless      bool   `json:"lossless"`      // WebP only
}

// VideoAnimTrimParams holds options for the video_anim_trim operation:
// precise time-based trimming of an animated GIF or animated WebP, re-encoded
// into the same container format. Segments (when non-empty) override the
// single Start/Duration pair.
type VideoAnimTrimParams struct {
	Start         string        `json:"start"`
	Duration      string        `json:"duration"`
	Segments      []TrimSegment `json:"segments"` // non-empty overrides Start/Duration
	Quality       int           `json:"quality"`
	PaletteColors int           `json:"paletteColors"`
	Dither        string        `json:"dither"`
	Lossless      bool          `json:"lossless"`
	LoopCount     int           `json:"loopCount"`
}
