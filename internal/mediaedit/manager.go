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

// maxJobs bounds the in-memory job pool: finished jobs beyond this cap are
// evicted so the map cannot grow unbounded across many edits.
const maxJobs = 200

// Manager manages a pool of in-memory ffmpeg edit jobs.
type Manager struct {
	jobs sync.Map // string → *Job

	mu sync.Mutex
	// order tracks job IDs in creation order for FIFO eviction. Guarded by mu.
	order []string
}

// NewManager creates a new Manager.
func NewManager() *Manager {
	return &Manager{}
}

// trimBounds evicts finished jobs so the pool stays ≤ maxJobs entries,
// preferring to keep running jobs (whose goroutines always complete — eviction
// only drops the map entry). Lock order: mu → job.mu; runJob only ever takes
// job.mu, so no cycle is possible.
func (m *Manager) trimBounds() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.order) <= maxJobs {
		return
	}
	over := len(m.order) - maxJobs
	kept := m.order[:0]
	for _, id := range m.order {
		v, ok := m.jobs.Load(id)
		if !ok {
			continue
		}
		job := v.(*Job)
		job.mu.Lock()
		terminal := job.Status == StatusCompleted || job.Status == StatusCancelled || job.Status == StatusError
		job.mu.Unlock()
		if terminal && over > 0 {
			m.jobs.Delete(id)
			over--
			continue
		}
		kept = append(kept, id)
	}
	// Pathological case: more than maxJobs concurrently running jobs. Drop the
	// oldest entries rather than let the map grow without bound.
	for len(kept) > maxJobs {
		m.jobs.Delete(kept[0])
		kept = kept[1:]
	}
	m.order = kept
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
	// True in-place replace: when overwriting with a different format, the
	// output must land at <dir>/<stem><newExt> (ffmpeg picks the encoder by the
	// output file extension, so writing webp bytes into a .png path would
	// silently keep the old format). Same format keeps outputPath == inputPath
	// (BuildOutputPath already returned it), so runJob's temp+rename path
	// handles the byte-level overwrite. On success the original file is removed
	// when the extension changed, leaving the new-format file in its place.
	removeOnSuccess := ""
	if req.Overwrite {
		inputBase := filepath.Base(req.InputPath)
		inputStem := strings.TrimSuffix(inputBase, filepath.Ext(inputBase))
		candidatePath := filepath.Join(filepath.Dir(req.InputPath), inputStem+ext)
		if candidatePath != outputPath {
			outputPath = candidatePath
			removeOnSuccess = req.InputPath
		}
	}

	// If OutputDir is specified and we are not overwriting, place the output
	// in the specified directory using the original filename (with the new
	// extension) so the saved file keeps the same name as the source.
	// OutputName (when provided) overrides the stem so batched/TEMP-input
	// jobs do not leak the temp filename (e.g. "gallery-edit-XXXX") into the
	// saved output; the extension always comes from buildArgs.
	if req.OutputDir != "" && !req.Overwrite {
		outStem := req.OutputName
		if outStem == "" {
			inputBase := filepath.Base(req.InputPath)
			outStem = strings.TrimSuffix(inputBase, filepath.Ext(inputBase))
		}
		outputPath = relocateOutput(req.OutputDir, outStem+ext)
	}
	// Same-directory output with an explicit OutputName (Set Name / Uniform in
	// "Set Path off" mode): place <dir>/<outputName><ext> next to the source
	// instead of the BuildOutputPath "<name>_<desc>" default. relocateOutput
	// avoids clobbering an existing same-named file.
	if req.OutputDir == "" && !req.Overwrite && req.OutputName != "" {
		outputPath = relocateOutput(filepath.Dir(req.InputPath), req.OutputName+ext)
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
	m.mu.Lock()
	m.order = append(m.order, id)
	m.mu.Unlock()
	m.trimBounds()

	go m.runJob(ctx, job, ffmpegPath, args, outputPath, sourceDuration, removeOnSuccess)
	return job.Snapshot(), nil
}

// runJob is the background goroutine that executes ffmpeg and updates the job.
func (m *Manager) runJob(ctx context.Context, job *Job, ffmpegPath string, args []string, outputPath string, sourceDuration float64, removeOnSuccess string) {
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

	job.mu.Lock()
	job.logBuf = stderrTail
	job.Command = FfmpegCommandString(ffmpegPath, args, runOutputPath)
	job.mu.Unlock()

	err := RunFfmpeg(ctx, ffmpegPath, args, runOutputPath, sourceDuration, onProgress, stderrTail)

	job.mu.Lock()
	defer job.mu.Unlock()

	job.LogTail = stderrTail.Read()
	job.logBuf = nil
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
	if removeOnSuccess != "" {
		_ = os.Remove(removeOnSuccess)
	}
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

// relocateOutput builds a path inside destDir using the given baseName.
// If a file with the same name already exists, appends _2, _3, etc.
func relocateOutput(destDir, baseName string) string {
	candidate := filepath.Join(destDir, baseName)
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	ext := filepath.Ext(baseName)
	name := strings.TrimSuffix(baseName, ext)
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
