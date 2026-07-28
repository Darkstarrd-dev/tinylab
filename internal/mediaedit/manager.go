package mediaedit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Manager manages a pool of in-memory ffmpeg edit jobs.
type Manager struct {
	jobs sync.Map // string → *Job
}

// NewManager creates a new Manager.
func NewManager() *Manager {
	return &Manager{}
}

// Start launches an ffmpeg edit job based on the request. Returns the job
// snapshot immediately; the job runs in a background goroutine.
func (m *Manager) Start(ffmpegPath, ffprobePath string, req StartRequest) (*Job, error) {
	// Validate input path.
	if _, err := os.Stat(req.InputPath); err != nil {
		return nil, fmt.Errorf("input file not found: %s", req.InputPath)
	}

	// Build operation args.
	args, desc, ext, err := buildArgs(req.InputPath, req.Operation, req.Params)
	if err != nil {
		return nil, fmt.Errorf("building args: %w", err)
	}

	// Resolve output path.
	outputPath, err := BuildOutputPath(req.InputPath, desc, ext, req.Overwrite)
	if err != nil {
		return nil, fmt.Errorf("output path: %w", err)
	}

	// If OutputDir is specified and we are not overwriting, move the output
	// to the specified directory while keeping the generated filename.
	if req.OutputDir != "" && !req.Overwrite {
		outputPath = relocateOutput(outputPath, req.OutputDir)
	}

	// Probe duration for progress tracking (video ops only).
	var sourceDuration float64
	if req.Operation == "video_transcode" || req.Operation == "video_trim" || req.Operation == "video_subtitle" {
		if probe, probeErr := Probe(ffprobePath, req.InputPath); probeErr == nil {
			sourceDuration = probe.Duration
		}
		// Probe failure is non-fatal; progress just won't be percent-based.
	}

	// Generate job ID.
	id := generateID()

	ctx, cancel := context.WithCancel(context.Background())

	job := &Job{
		ID:        id,
		Status:    StatusRunning,
		Operation: req.Operation,
		InputPath: req.InputPath,
		StartedAt: time.Now(),
		cancel:    cancel,
	}

	m.jobs.Store(id, job)

	go m.runJob(ctx, job, ffmpegPath, args, outputPath, sourceDuration)

	return job.Snapshot(), nil
}

// runJob is the background goroutine that executes ffmpeg and updates the job.
func (m *Manager) runJob(ctx context.Context, job *Job, ffmpegPath string, args []string, outputPath string, sourceDuration float64) {
	stderrTail := newTailBuffer(16 * 1024) // 16KB

	onProgress := func(pct int) {
		job.mu.Lock()
		job.Progress = pct
		job.mu.Unlock()
	}

	// If overwriting original file, run ffmpeg into a temp file first to prevent
	// ffmpeg error "Output same as Input #0 - exiting".
	runOutputPath := outputPath
	isOverwrite := (outputPath == job.InputPath)
	if isOverwrite {
		ext := filepath.Ext(outputPath)
		runOutputPath = outputPath + ".mediaedit_tmp" + ext
	}

	err := RunFfmpeg(ctx, ffmpegPath, args, runOutputPath, sourceDuration, onProgress, stderrTail)

	job.mu.Lock()
	defer job.mu.Unlock()

	job.LogTail = stderrTail.Read()
	job.FinishedAt = time.Now()

	if err != nil {
		if isOverwrite {
			_ = os.Remove(runOutputPath)
		}
		if err == ErrCancelled {
			job.Status = StatusCancelled
		} else {
			job.Status = StatusError
			job.Error = err.Error()
		}
		return
	}

	if isOverwrite {
		if renameErr := os.Rename(runOutputPath, outputPath); renameErr != nil {
			// Try removal of target file then rename as fallback on Windows.
			_ = os.Remove(outputPath)
			if renameErr2 := os.Rename(runOutputPath, outputPath); renameErr2 != nil {
				_ = os.Remove(runOutputPath)
				job.Status = StatusError
				job.Error = fmt.Sprintf("replace original file failed: %v", renameErr2)
				return
			}
		}
	}

	// Verify output file exists.
	if _, statErr := os.Stat(outputPath); statErr != nil {
		job.Status = StatusError
		job.Error = fmt.Sprintf("output file not found: %s", outputPath)
		return
	}

	job.Status = StatusCompleted
	job.Progress = 100
	job.OutputPath = outputPath
	job.OutputName = filepath.Base(outputPath)
}

// Get returns a job snapshot by ID. Returns false if not found.
func (m *Manager) Get(id string) (*Job, bool) {
	v, ok := m.jobs.Load(id)
	if !ok {
		return nil, false
	}
	return v.(*Job).Snapshot(), true
}

// Cancel cancels a running job. Returns false if the job was not found or
// is already in a terminal state.
func (m *Manager) Cancel(id string) bool {
	v, ok := m.jobs.Load(id)
	if !ok {
		return false
	}
	job := v.(*Job)
	job.mu.Lock()
	if job.Status != StatusRunning {
		job.mu.Unlock()
		return false
	}
	job.mu.Unlock()

	job.cancel()
	return true
}

// Probe wraps the Probe function with the provided paths.
func (m *Manager) ProbeMedia(ffprobePath, path string) (*ProbeResult, error) {
	return Probe(ffprobePath, path)
}

// generateID returns an 8-byte random hex string (16 hex chars).
func generateID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is extremely rare; fall back to time.
		return hex.EncodeToString([]byte(fmt.Sprintf("%016x", time.Now().UnixNano())))
	}
	return hex.EncodeToString(b)
}


// relocateOutput moves outputPath to directory destDir, preserving the
// base name. If a file with the same name already exists, appends _2, _3, etc.
func relocateOutput(outputPath, destDir string) string {
	base := filepath.Base(outputPath)
	candidate := filepath.Join(destDir, base)
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	ext := filepath.Ext(base)
	name := strings.TrimSuffix(base, ext)
	for i := 2; i < 1000; i++ {
		candidate = filepath.Join(destDir, fmt.Sprintf("%s_%d%s", name, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return candidate
}
// buildArgs dispatches to the correct arg builder based on operation.
func buildArgs(inputPath, operation string, raw json.RawMessage) (args []string, desc, ext string, err error) {
	switch operation {
	case "image_transcode":
		args, desc, ext, err = BuildImageTranscodeArgs(inputPath, raw)
	case "video_transcode":
		args, desc, ext, err = BuildVideoTranscodeArgs(inputPath, raw)
	case "video_trim":
		args, desc, ext, err = BuildVideoTrimArgs(inputPath, raw)
	case "video_subtitle":
		args, desc, ext, err = BuildVideoSubtitleArgs(inputPath, raw)
	default:
		return nil, "", "", fmt.Errorf("unknown operation: %s", operation)
	}
	return
}
