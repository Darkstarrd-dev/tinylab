// Code in this file: gallery media edit (ffmpeg) HTTP handlers (Fix 1 split from register.go). Frontend: web/playground/static-pg/gallery-edit.js + gallery-edit-operations.js + gallery-edit-batch.js.
package gallery

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
)

// resolveFfmpeg resolves ffmpeg and ffprobe paths from config.
func (h *Handler) resolveFfmpeg() (string, string, error) {
	cfg := h.d.Reg.Config()
	ff, err := mediaedit.ResolveFfmpeg(cfg.Download.FfmpegPath)
	if err != nil {
		return "", "", err
	}
	fp, err := mediaedit.ResolveFfprobe(ff)
	if err != nil {
		return ff, "", err
	}
	return ff, fp, nil
}

// --- Media edit handlers ---

// galleryEditFfmpegStatus reports whether ffmpeg is available.
func (h *Handler) galleryEditFfmpegStatus(w http.ResponseWriter, r *http.Request) {
	ffmpegPath, _, err := h.resolveFfmpeg()
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		json.NewEncoder(w).Encode(map[string]any{
			"available": false,
			"path":      "",
			"error":     err.Error(),
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{
		"available": true,
		"path":      ffmpegPath,
		"error":     "",
	})
}

// probeRequest is the body for POST /edit/probe.
type probeRequest struct {
	Path string `json:"path"`
}

// galleryEditProbe probes a media file and returns metadata.
func (h *Handler) galleryEditProbe(w http.ResponseWriter, r *http.Request) {
	var req probeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path is required")
		return
	}

	_, ffprobePath, err := h.resolveFfmpeg()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "ffmpeg/ffprobe not available: "+err.Error())
		return
	}

	result, err := h.media.ProbeMedia(ffprobePath, req.Path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "probe failed: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// galleryEditSubtitleUpload receives a subtitle file and writes it to a temp dir.
func (h *Handler) galleryEditSubtitleUpload(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "subtitle.srt"
	}
	name = filepath.Base(name)
	if name == "." || name == ".." {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid filename")
		return
	}

	ext := filepath.Ext(name)
	if ext != ".srt" && ext != ".ass" && ext != ".ssa" && ext != ".vtt" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "unsupported subtitle format: "+ext)
		return
	}

	// Write to a shared temp dir.
	tmpDir := filepath.Join(os.TempDir(), "tinyrouter-subs")
	if err := os.MkdirAll(tmpDir, 0700); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create temp dir")
		return
	}

	// Generate random prefix to avoid collisions.
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to generate filename")
		return
	}
	outPath := filepath.Join(tmpDir, hex.EncodeToString(b)+ext)

	f, err := os.Create(outPath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create file")
		return
	}
	defer f.Close()

	limited := io.LimitReader(r.Body, 16<<20)
	if _, err := io.Copy(f, limited); err != nil {
		os.Remove(outPath)
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"subtitlePath": outPath,
	})
}

// galleryEditStart starts a media edit job.
func (h *Handler) galleryEditStart(w http.ResponseWriter, r *http.Request) {
	var req mediaedit.StartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.InputPath == "" || req.Operation == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "inputPath and operation are required")
		return
	}

	ffmpegPath, ffprobePath, err := h.resolveFfmpeg()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "ffmpeg not available: "+err.Error())
		return
	}

	job, err := h.media.Start(ffmpegPath, ffprobePath, req)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to start job: "+err.Error())
		return
	}

	h.d.Logger.Info("gallery: started edit job %s (%s, %s)", job.ID, job.Operation, job.InputPath)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jobId": job.ID,
	})
}

// galleryEditStatus returns the status of an edit job.
func (h *Handler) galleryEditStatus(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobId")

	job, ok := h.media.Get(jobID)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "job not found")
		return
	}

	resp := map[string]any{
		"id":         job.ID,
		"status":     job.Status,
		"progress":   job.Progress,
		"operation":  job.Operation,
		"inputPath":  job.InputPath,
		"outputName": job.OutputName,
		"outputPath": job.OutputPath,
		"error":      job.Error,
		"logTail":    job.LogTail,
		"command":    job.Command,
	}
	if job.Status == mediaedit.StatusCompleted && job.OutputPath != "" {
		resp["outputURL"] = "/api/gallery/file?path=" + url.PathEscape(job.OutputPath)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// galleryEditCancel cancels a running edit job.
func (h *Handler) galleryEditCancel(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobId")

	if !h.media.Cancel(jobID) {
		apibase.WriteAPIError(w, http.StatusNotFound, "job not found or already finished")
		return
	}

	h.d.Logger.Info("gallery: cancelled edit job %s", jobID)
	w.WriteHeader(http.StatusNoContent)
}

// galleryEditUploadTemp accepts a raw file body (with optional ?name= query
// param for extension detection) and writes it to a temp file, returning
// {"tempPath": "..."}. Used by the frontend to materialize FSAA/drag-drop
// items that lack a disk path.
// POST /api/gallery/edit/upload-temp?name=video.mp4
func (h *Handler) galleryEditUploadTemp(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = ".bin"
	}
	tmpFile, err := os.CreateTemp("", "gallery-edit-upload-*"+ext)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "temp file: "+err.Error())
		return
	}
	defer tmpFile.Close()
	// Cap the upload at 500MB (matches galleryListZip) so a huge body cannot
	// exhaust disk/temp space.
	r.Body = http.MaxBytesReader(w, r.Body, 500<<20)
	if _, err := io.Copy(tmpFile, r.Body); err != nil {
		os.Remove(tmpFile.Name())
		apibase.WriteAPIError(w, http.StatusBadRequest, "upload too large or write failed: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"tempPath": tmpFile.Name()})
}

// galleryEditExtractZipEntry extracts a single entry from a zip archive to a
// temporary file on disk so that ffmpeg can operate on it directly.
// POST /api/gallery/edit/extract-zip-entry
//
//	{ "zipAbsPath": "...", "zipPath": "entry/inside/zip.png" }
//	or { "sessionId": "...", "zipPath": "entry/inside/zip.png" }
//
// Returns { "tempPath": "..." }.
func (h *Handler) galleryEditExtractZipEntry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ZipAbsPath string `json:"zipAbsPath"`
		SessionID  string `json:"sessionId"`
		ZipPath    string `json:"zipPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ZipPath == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "zipPath is required")
		return
	}
	if req.ZipAbsPath == "" && req.SessionID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "zipAbsPath or sessionId is required")
		return
	}

	var zipData []byte
	if req.ZipAbsPath != "" {
		var err error
		zipData, err = readZipFile(req.ZipAbsPath)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusNotFound, "cannot read zip: "+err.Error())
			return
		}
	} else {
		data, ok := h.sessions.get(req.SessionID)
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
			return
		}
		zipData = data
	}

	reader := bytes.NewReader(zipData)
	entry, _, err := gallerylib.GetZipEntry(reader, int64(len(zipData)), req.ZipPath)
	if err != nil {
		if gallerylib.IsNotFound(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "entry not found in zip")
			return
		}
		apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read entry: "+err.Error())
		return
	}

	// Write to temp file preserving the original extension.
	ext := filepath.Ext(req.ZipPath)
	if ext == "" {
		ext = ".bin"
	}
	tmpFile, err := os.CreateTemp("", "gallery-edit-*"+ext)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create temp file")
		return
	}
	defer tmpFile.Close()

	if _, err := tmpFile.Write(entry); err != nil {
		os.Remove(tmpFile.Name())
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to write temp file")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tempPath": tmpFile.Name(),
	})
}

// galleryEditZipOutputs creates a zip archive containing the specified files
// and optionally deletes the originals. Used by the batch convert + compress
// feature to bundle multiple converted images into a single zip.
// POST /api/gallery/edit/zip-outputs
//
//	{ "paths": ["abs/path1.png", ...], "outputDir": "...", "cleanUp": true }
//
// Returns { "zipPath": "...", "zipName": "...", "outputURL": "..." }.
func (h *Handler) galleryEditZipOutputs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths     []string `json:"paths"`
		OutputDir string   `json:"outputDir"`
		ZipName   string   `json:"zipName"`
		CleanUp   bool     `json:"cleanUp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Paths) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no paths provided")
		return
	}

	outputDir := req.OutputDir
	if outputDir == "" {
		outputDir = h.d.Reg.Config().Download.DefaultDir
	}
	if outputDir == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no output directory")
		return
	}
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create output dir: "+err.Error())
		return
	}

	// Build the zip name. Caller may request a specific name (e.g. the original
	// folder/archive name), otherwise fall back to "converted_images". We only
	// trust the base component and force a .zip suffix so a client cannot
	// escape outputDir or produce a non-zip extension.
	zipName := filepath.Base(req.ZipName)
	if zipName == "" || zipName == "." || zipName == string(filepath.Separator) {
		zipName = "converted_images.zip"
	}
	if strings.ToLower(filepath.Ext(zipName)) != ".zip" {
		zipName = strings.TrimSuffix(zipName, filepath.Ext(zipName)) + ".zip"
	}
	zipPath := filepath.Join(outputDir, zipName)
	if _, err := os.Stat(zipPath); err == nil {
		stem := strings.TrimSuffix(zipName, filepath.Ext(zipName))
		for i := 2; i < 1000; i++ {
			candidate := filepath.Join(outputDir, fmt.Sprintf("%s_%d.zip", stem, i))
			if _, err := os.Stat(candidate); os.IsNotExist(err) {
				zipPath = candidate
				zipName = fmt.Sprintf("%s_%d.zip", stem, i)
				break
			}
		}
	}

	zipFile, err := os.Create(zipPath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to create zip: "+err.Error())
		return
	}

	zipWriter := zip.NewWriter(zipFile)

	for _, p := range req.Paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			continue
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			f.Close()
			continue
		}
		header.Name = filepath.Base(p)
		header.Method = zip.Deflate

		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			f.Close()
			continue
		}
		io.Copy(writer, f)
		f.Close()
	}

	zipWriter.Close()
	zipFile.Close()

	if req.CleanUp {
		for _, p := range req.Paths {
			os.Remove(p)
		}
	}

	zipURL := "/api/gallery/file?path=" + url.PathEscape(zipPath)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"zipPath":   zipPath,
		"zipName":   zipName,
		"outputURL": zipURL,
	})
}

// galleryEditZipWriteback replaces image entries inside an on-disk zip archive
// with their transcoded counterparts and writes the result atomically over the
// original archive path. Used by the "replace original" batch convert flow when
// the source is a backend zip (kind:'zip' with zipAbsPath): each completed
// transcode job contributes its temp output file mapped back to the entry's
// inner zip path, the archive is repacked preserving every untouched entry, and
// the original .zip is replaced in place.
//
// POST /api/gallery/edit/zip-writeback
//
//	{
//	  "archivePath": "<abs .zip path>",
//	  "entries": [ { "zipPath": "...", "filePath": "<abs converted file on disk>" } ]
//	}
//
// -> { "ok": true, "path": archivePath }
//
// An empty entries list is allowed and performs an in-place no-op repack (the
// archive is read and rewritten byte-equivalently, then written back), so a
// batch with zero successful jobs never panics. Each input filePath is
// best-effort removed afterward so temp converted files do not accumulate.
func (h *Handler) galleryEditZipWriteback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ArchivePath string `json:"archivePath"`
		Entries     []struct {
			ZipPath  string `json:"zipPath"`
			FilePath string `json:"filePath"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ArchivePath == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing archivePath")
		return
	}

	data, err := os.ReadFile(req.ArchivePath)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read archive: "+err.Error())
		return
	}

	// Build the replacements map. zipPath is normalized the same way gallery's
	// CleanZipPath does (see internal/gallery/zip.go): collapse backslashes to
	// forward slashes, drop a leading slash, path.Clean, drop a leading slash
	// once more. filePath is read from disk on demand so an unreadable temp file
	// surfaces as an explicit error rather than a silent skip.
	replacements := make(map[string][]byte, len(req.Entries))
	for _, e := range req.Entries {
		if e.ZipPath == "" || e.FilePath == "" {
			continue
		}
		key := gallerylib.CleanZipPath(e.ZipPath)
		if key == "" || key == "." {
			continue
		}
		b, err := os.ReadFile(e.FilePath)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, "read entry file "+e.FilePath+": "+err.Error())
			return
		}
		replacements[key] = b
	}

	result, _, err := gallerylib.ReplaceZipEntries(data, replacements)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "repack zip: "+err.Error())
		return
	}

	if err := fsutil.AtomicWrite(req.ArchivePath, result, 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "writeback failed: "+err.Error())
		return
	}

	// Defer-remove each input filePath best-effort so temp converted files do
	// not accumulate. Failure to remove does not undo the writeback.
	for _, e := range req.Entries {
		if e.FilePath != "" {
			os.Remove(e.FilePath)
		}
	}

	h.d.Logger.Info("gallery: zip edit writeback %q (%d entries replaced)", req.ArchivePath, len(replacements))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": req.ArchivePath})
}
