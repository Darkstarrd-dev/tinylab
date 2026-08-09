// Code in this file: gallery media edit (ffmpeg) HTTP handlers. Frontend:
// web/playground/static-pg/gallery-edit.js + gallery-edit-operations.js +
// gallery-edit-batch.js.
//
// Path capability contract (audit_fix.md F-28, B-4): ffmpeg inputs are
// resolved server-side from assetIds (temp assets), or from grantId+rel
// (files inside a granted directory). Subtitle files are uploaded into the
// asset store. Outputs are registered as owner-bound assets and returned as
// assetIds; overwrite-in-place is only allowed for write-granted inputs. Raw
// `path`/`paths`/`outputDir`/`archivePath` fields are rejected with 410.
package gallery

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/archive"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	gallerylib "github.com/tinyrouter/tinyrouter/internal/gallery"
	"github.com/tinyrouter/tinyrouter/internal/mediaedit"
	"github.com/tinyrouter/tinyrouter/internal/owner"
	"github.com/tinyrouter/tinyrouter/internal/pathgrant"
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

// galleryEditFfmpegStatus reports whether ffmpeg is available and which
// animated-image codecs its build provides: {available, path, error, gif,
// webpAnim, webpAnimDecode}. The frontend disables formats by capability;
// galleryEditStart re-checks them server-side regardless.
func (h *Handler) galleryEditFfmpegStatus(w http.ResponseWriter, r *http.Request) {
	ffmpegPath, _, err := h.resolveFfmpeg()
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		json.NewEncoder(w).Encode(map[string]any{
			"available":      false,
			"path":           "",
			"error":          err.Error(),
			"gif":            false,
			"webpAnim":       false,
			"webpAnimDecode": false,
		})
		return
	}
	caps, probeErr := mediaedit.ProbeFfmpegCaps(ffmpegPath)
	if probeErr != nil {
		json.NewEncoder(w).Encode(map[string]any{
			"available":      false,
			"path":           ffmpegPath,
			"error":          probeErr.Error(),
			"gif":            false,
			"webpAnim":       false,
			"webpAnimDecode": false,
		})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{
		"available":      true,
		"path":           ffmpegPath,
		"error":          "",
		"gif":            caps.Gif,
		"webpAnim":       caps.WebpAnim,
		"webpAnimDecode": caps.WebpAnimDecode,
	})
}

// checkAnimCapability verifies the configured ffmpeg provides the codecs the
// requested animated-image operation needs. The backend never trusts the
// frontend disable state: a missing encoder/decoder refuses the job with a
// clear error before any output file is created or job is started.
func (h *Handler) checkAnimCapability(req mediaedit.StartRequest, ffmpegPath, ffprobePath string) error {
	caps, err := mediaedit.ProbeFfmpegCaps(ffmpegPath)
	if err != nil {
		return fmt.Errorf("ffmpeg capability probe failed: %w", err)
	}
	switch req.Operation {
	case "video_to_gif":
		if !caps.Gif {
			return fmt.Errorf("video_to_gif requires the 'gif' encoder but the configured ffmpeg does not provide it")
		}
	case "video_to_webp":
		if !caps.WebpAnim {
			return fmt.Errorf("video_to_webp requires the 'libwebp_anim' encoder but the configured ffmpeg does not provide it")
		}
	case "video_anim_trim":
		switch strings.ToLower(filepath.Ext(req.InputPath)) {
		case ".gif":
			if !caps.Gif {
				return fmt.Errorf("video_anim_trim of a .gif input requires the 'gif' encoder but the configured ffmpeg does not provide it")
			}
		case ".webp":
			if !caps.WebpAnim {
				return fmt.Errorf("video_anim_trim of a .webp input requires the 'libwebp_anim' encoder but the configured ffmpeg does not provide it")
			}
			// Animated WebP input additionally needs the animated WebP
			// decoder. A static WebP (probe duration 0) does not; when the
			// input cannot be probed, fail closed and require the decoder.
			animated := true
			if probe, pErr := h.media.ProbeMedia(ffprobePath, req.InputPath); pErr == nil {
				animated = probe.Duration > 0
			}
			if animated && !caps.WebpAnimDecode {
				return fmt.Errorf("video_anim_trim of an animated .webp input requires the 'webp_anim' decoder but the configured ffmpeg does not provide it")
			}
		}
	}
	return nil
}

// probeRequest is the body for POST /edit/probe.
type probeRequest struct {
	Path    string `json:"path"` // legacy: rejected
	AssetID string `json:"assetId"`
	GrantID string `json:"grantId"`
	Rel     string `json:"rel"`
}

// galleryEditProbe probes a media file and returns metadata.
func (h *Handler) galleryEditProbe(w http.ResponseWriter, r *http.Request) {
	var req probeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "assetId or grantId is required")
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use assetId or grantId+rel")
		return
	}
	input, err := h.resolveMediaInput(r, req.AssetID, req.GrantID, req.Rel, pathgrant.OpRead)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, err.Error())
		return
	}

	_, ffprobePath, err := h.resolveFfmpeg()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "ffmpeg/ffprobe not available: "+err.Error())
		return
	}

	result, err := h.media.ProbeMedia(ffprobePath, input)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "probe failed: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// resolveMediaInput maps an assetId or a grantId+rel pair to a server-side
// path for ffmpeg/ffprobe. Raw paths never reach this point (410 upstream).
func (h *Handler) resolveMediaInput(r *http.Request, assetID, grantID, rel string, op pathgrant.Operation) (string, error) {
	ownerID := owner.From(r.Context())
	if ownerID == "" {
		return "", errors.New("request has no owner identity")
	}
	switch {
	case assetID != "":
		st, err := h.assetStore()
		if err != nil {
			return "", err
		}
		return st.Path(ownerID, assetID)
	case grantID != "":
		if rel == "" {
			return h.grants.Resolve(ownerID, grantID, op)
		}
		return h.grants.ResolveChild(ownerID, grantID, rel, op)
	}
	return "", errors.New("assetId or grantId is required")
}

// galleryEditSubtitleUpload receives a subtitle file, registers it as an
// owner-bound asset, and returns { assetId }.
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

	st, err := h.assetStore()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
		return
	}
	ref, err := st.Create(r.Context(), owner.From(r.Context()), "subtitle", name, "text/plain", io.LimitReader(r.Body, 16<<20), 16<<20)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to store subtitle: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"assetId": ref.ID})
}

// startRequest is the body for POST /edit/start.
type startRequest struct {
	Path            string          `json:"path"` // legacy: rejected
	InputAssetID    string          `json:"inputAssetId"`
	InputGrantID    string          `json:"inputGrantId"`
	InputRel        string          `json:"inputRel"`
	SubtitleAssetID string          `json:"subtitleAssetId,omitempty"`
	Operation       string          `json:"operation"`
	Overwrite       bool            `json:"overwrite"`
	OutputName      string          `json:"outputName,omitempty"`
	Params          json.RawMessage `json:"params"`
}

// galleryEditStart starts a media edit job.
func (h *Handler) galleryEditStart(w http.ResponseWriter, r *http.Request) {
	var req startRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use inputAssetId or inputGrantId+inputRel")
		return
	}
	if req.Operation == "" || (req.InputAssetID == "" && req.InputGrantID == "") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "operation and inputAssetId/inputGrantId are required")
		return
	}
	ownerID := owner.From(r.Context())
	// Overwrite-in-place requires a write grant on the input: an asset input
	// is a server temp copy and must never destroy its source.
	if req.Overwrite && req.InputGrantID == "" {
		apibase.WriteAPIError(w, http.StatusForbidden, "overwrite requires a write grant on the source file")
		return
	}
	input, err := h.resolveMediaInput(r, req.InputAssetID, req.InputGrantID, req.InputRel, pathgrant.OpRead)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, err.Error())
		return
	}

	ffmpegPath, ffprobePath, err := h.resolveFfmpeg()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "ffmpeg not available: "+err.Error())
		return
	}

	mediaReq := mediaedit.StartRequest{
		InputPath:  input,
		Operation:  req.Operation,
		Overwrite:  req.Overwrite,
		OutputName: sanitizeOutputStem(req.OutputName),
		Params:     req.Params,
	}

	// Subtitle: resolve the registered asset to its server path and inject
	// it into the operation params (video_subtitle only).
	if req.SubtitleAssetID != "" && req.Operation == "video_subtitle" {
		st, err := h.assetStore()
		if err != nil {
			apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
			return
		}
		subPath, err := st.Path(ownerID, req.SubtitleAssetID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusNotFound, "subtitle asset not found")
			return
		}
		var params map[string]any
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &params)
		}
		if params == nil {
			params = make(map[string]any)
		}
		params["subtitlePath"] = subPath
		mediaReq.Params, _ = json.Marshal(params)
	}

	// Backend never trusts the frontend disable state: re-check the required
	// codec capabilities before any job starts (or output file is created).
	if err := h.checkAnimCapability(mediaReq, ffmpegPath, ffprobePath); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	job, err := h.media.Start(ffmpegPath, ffprobePath, mediaReq)
	if err != nil {
		status, msg := mediaStartStatus(err)
		apibase.WriteAPIError(w, status, msg)
		return
	}

	h.d.Logger.Info("gallery: started edit job %s (%s)", job.ID, job.Operation)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jobId": job.ID,
	})
}

// mediaStartStatus maps a mediaedit.Start error to an HTTP status and message.
// The ffmpeg concurrency limit (mediaedit.ErrTooManyJobs) is reported as 429
// so an overloaded server never answers 200 with a job that was not started
// (audit_fix.md F-15).
func mediaStartStatus(err error) (int, string) {
	if errors.Is(err, mediaedit.ErrTooManyJobs) {
		return http.StatusTooManyRequests, "too many concurrent media jobs, retry later"
	}
	return http.StatusBadRequest, "failed to start job: " + err.Error()
}

// sanitizeOutputStem restricts an output name to a safe basename stem (no
// separators, no traversal, no extension).
func sanitizeOutputStem(name string) string {
	name = filepath.Base(filepath.ToSlash(name))
	if name == "." || name == ".." || name == "" || strings.ContainsAny(name, `/\`) {
		return ""
	}
	return strings.TrimSuffix(name, filepath.Ext(name))
}

// jobOutputs tracks which edit jobs already had their output registered as an
// asset, so a completed output is registered exactly once.
var jobOutputs sync.Map // jobID -> assetID

// galleryEditStatus returns the status of an edit job. When the job completed
// and the output was not written in place (overwrite), the output file is
// registered as an owner-bound asset and returned as assetId.
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
		"outputName": job.OutputName,
		"error":      job.Error,
		"logTail":    job.LogTail,
		"command":    job.Command,
	}
	if job.Status == mediaedit.StatusCompleted && job.OutputPath != "" {
		if job.OutputPath != job.InputPath {
			if assetID, ok := jobOutputs.Load(jobID); ok {
				resp["assetId"] = assetID
			} else {
				ownerID := owner.From(r.Context())
				st, err := h.assetStore()
				if err == nil {
					f, ferr := os.Open(job.OutputPath)
					if ferr == nil {
						ref, cerr := st.Create(r.Context(), ownerID, "edit", filepath.Base(job.OutputPath), mimeForGallery(job.OutputPath), f, 2<<30)
						f.Close()
						if cerr == nil {
							jobOutputs.Store(jobID, ref.ID)
							resp["assetId"] = ref.ID
							resp["outputName"] = ref.Name
							// Remove the stray output file now that the asset
							// holds a registered copy.
							if job.OutputPath != job.InputPath {
								_ = os.Remove(job.OutputPath)
							}
						}
					}
				}
			}
		} else {
			resp["overwritten"] = true
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func mimeForGallery(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".zip":
		return "application/zip"
	default:
		return "application/octet-stream"
	}
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
// param for extension detection) and registers it as an owner-bound asset,
// returning { assetId }. Used by the frontend to materialize FSAA/drag-drop
// items that lack a disk path.
// POST /api/gallery/edit/upload-temp?name=video.mp4
func (h *Handler) galleryEditUploadTemp(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = ".bin"
	}
	ownerID := owner.From(r.Context())
	st, err := h.assetStore()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
		return
	}
	// Cap the upload at 500MB (matches galleryListZip) so a huge body cannot
	// exhaust disk/temp space.
	ref, err := st.Create(r.Context(), ownerID, "upload", "upload"+ext, mimeForGallery("x"+ext), http.MaxBytesReader(w, r.Body, 500<<20), 500<<20)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "upload too large or write failed: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"assetId": ref.ID})
}

// galleryEditExtractZipEntry extracts a single entry from a zip archive to a
// registered asset so that ffmpeg can operate on it directly.
// POST /api/gallery/edit/extract-zip-entry
//
//	{ "sourceId": "...", "zipPath": "entry/inside/zip.png" }
//	or { "sessionId": "...", "zipPath": "entry/inside/zip.png" }
//	or { "grantId": "...", "zipPath": "entry/inside/zip.png" }
//
// sourceId references a source registered through POST /api/archive/sources;
// grantId references a zip file grant from open-dir/paste-paths. Returns
// { "assetId": "..." }.
func (h *Handler) galleryEditExtractZipEntry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ZipAbsPath string `json:"zipAbsPath"` // legacy: rejected
		Path       string `json:"path"`       // legacy: rejected
		SessionID  string `json:"sessionId"`
		SourceID   string `json:"sourceId"`
		GrantID    string `json:"grantId"`
		ZipPath    string `json:"zipPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ZipPath == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "zipPath is required")
		return
	}
	if req.ZipAbsPath != "" || req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw zip paths are no longer accepted; use sourceId, sessionId, or grantId")
		return
	}
	if req.SessionID == "" && req.SourceID == "" && req.GrantID == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "sourceId, sessionId, or grantId is required")
		return
	}
	ownerID := owner.From(r.Context())

	var entry []byte
	switch {
	case req.SourceID != "":
		if h.archive == nil {
			apibase.WriteAPIError(w, http.StatusServiceUnavailable, "archive source lookup is unavailable")
			return
		}
		src, ok := h.archive.ResolveSource(ownerID, req.SourceID)
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "archive source not found or expired")
			return
		}
		data, _, err := h.archive.ReadEntry(r.Context(), src, req.ZipPath, archive.DefaultBudget())
		if err != nil {
			if archive.IsNotFound(err) {
				apibase.WriteAPIError(w, http.StatusNotFound, "entry not found in source")
				return
			}
			apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read entry: "+err.Error())
			return
		}
		entry = data
	case req.GrantID != "":
		grantedPath, err := h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpRead)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "grant denied or expired; re-open the folder")
			return
		}
		zipData, err := readZipFile(grantedPath)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusNotFound, "cannot read zip: "+err.Error())
			return
		}
		reader := bytes.NewReader(zipData)
		data, _, err := gallerylib.GetZipEntry(reader, int64(len(zipData)), req.ZipPath)
		if err != nil {
			if gallerylib.IsNotFound(err) {
				apibase.WriteAPIError(w, http.StatusNotFound, "entry not found in zip")
				return
			}
			apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read entry: "+err.Error())
			return
		}
		entry = data
	default:
		zipData, ok := h.sessions.get(ownerID, req.SessionID)
		if !ok {
			apibase.WriteAPIError(w, http.StatusNotFound, "zip session not found")
			return
		}
		reader := bytes.NewReader(zipData)
		data, _, err := gallerylib.GetZipEntry(reader, int64(len(zipData)), req.ZipPath)
		if err != nil {
			if gallerylib.IsNotFound(err) {
				apibase.WriteAPIError(w, http.StatusNotFound, "entry not found in zip")
				return
			}
			apibase.WriteAPIError(w, http.StatusBadRequest, "failed to read entry: "+err.Error())
			return
		}
		entry = data
	}

	// Register the extracted bytes as an asset preserving the original
	// extension (server-side name; the extension drives ffmpeg's demuxer).
	ext := filepath.Ext(req.ZipPath)
	if ext == "" {
		ext = ".bin"
	}
	st, err := h.assetStore()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
		return
	}
	ref, err := st.Create(r.Context(), ownerID, "extract", "extract"+ext, mimeForGallery("x"+ext), bytes.NewReader(entry), archive.DefaultBudget().MaxEntryBytes)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to store entry: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"assetId": ref.ID})
}

// galleryEditZipOutputs creates a zip archive from the given registered
// assets and registers it as a new asset. Used by the batch convert +
// compress feature to bundle multiple converted images into a single zip.
// POST /api/gallery/edit/zip-outputs
//
//	{ "assetIds": ["..."], "zipName": "converted", "cleanUp": true }
//
// Returns { "assetId": "...", "name": "...", "size": N }.
func (h *Handler) galleryEditZipOutputs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths     []string `json:"paths"`     // legacy: rejected
		OutputDir string   `json:"outputDir"` // legacy: rejected
		AssetIDs  []string `json:"assetIds"`
		ZipName   string   `json:"zipName"`
		CleanUp   bool     `json:"cleanUp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Paths) > 0 || req.OutputDir != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths/outputDir are no longer accepted; use assetIds")
		return
	}
	if len(req.AssetIDs) == 0 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "no assetIds provided")
		return
	}
	ownerID := owner.From(r.Context())
	st, err := h.assetStore()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
		return
	}

	zipName := filepath.Base(req.ZipName)
	if zipName == "" || zipName == "." || zipName == string(filepath.Separator) {
		zipName = "converted_images"
	}
	if strings.ToLower(filepath.Ext(zipName)) != ".zip" {
		zipName = strings.TrimSuffix(zipName, filepath.Ext(zipName)) + ".zip"
	}

	var buf bytes.Buffer
	zipWriter := zip.NewWriter(&buf)
	seen := make(map[string]int)
	for _, id := range req.AssetIDs {
		rc, ref, err := st.Open(ownerID, id)
		if err != nil {
			zipWriter.Close()
			apibase.WriteAPIError(w, http.StatusNotFound, "asset not found: "+id)
			return
		}
		base := filepath.Base(ref.Name)
		if seen[base] > 0 {
			ext := filepath.Ext(base)
			stem := strings.TrimSuffix(base, ext)
			seen[base]++
			base = fmt.Sprintf("%s_%d%s", stem, seen[base], ext)
		}
		seen[base] = 1
		header := &zip.FileHeader{Name: base, Method: zip.Deflate}
		zw, err := zipWriter.CreateHeader(header)
		if err != nil {
			rc.Close()
			zipWriter.Close()
			apibase.WriteAPIError(w, http.StatusInternalServerError, "zip create: "+err.Error())
			return
		}
		_, copyErr := io.Copy(zw, rc)
		rc.Close()
		if copyErr != nil {
			zipWriter.Close()
			apibase.WriteAPIError(w, http.StatusInternalServerError, "zip write: "+copyErr.Error())
			return
		}
	}
	if err := zipWriter.Close(); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "zip close: "+err.Error())
		return
	}

	ref, err := st.Create(r.Context(), ownerID, "output", zipName, "application/zip", bytes.NewReader(buf.Bytes()), archive.DefaultBudget().MaxOutputBytes)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "register zip asset: "+err.Error())
		return
	}

	if req.CleanUp {
		for _, id := range req.AssetIDs {
			_ = st.Release(ownerID, id)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"assetId": ref.ID,
		"name":    ref.Name,
		"size":    ref.Size,
	})
}

// galleryEditZipWriteback replaces image entries inside a granted on-disk zip
// archive with their transcoded counterparts (registered assets) and writes
// the result atomically over the granted file.
//
// POST /api/gallery/edit/zip-writeback
//
//	{
//	  "sessionId": "...",
//	  "grantId": "...",
//	  "entries": [ { "zipPath": "...", "assetId": "..." } ]
//	}
//
// An empty entries list performs an in-place no-op repack (the archive is
// read and rewritten byte-equivalently, then written back).
func (h *Handler) galleryEditZipWriteback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ArchivePath string `json:"archivePath"` // legacy: rejected
		Path        string `json:"path"`        // legacy: rejected
		SessionID   string `json:"sessionId"`
		GrantID     string `json:"grantId"`
		Entries     []struct {
			ZipPath string `json:"zipPath"`
			AssetID string `json:"assetId"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ArchivePath != "" || req.Path != "" {
		apibase.WriteAPIError(w, http.StatusGone, "raw paths are no longer accepted; use sessionId + grantId")
		return
	}
	ownerID := owner.From(r.Context())
	target, err := h.grants.Resolve(ownerID, req.GrantID, pathgrant.OpWrite)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, "write grant denied or expired; re-open the folder")
		return
	}

	data, err := os.ReadFile(target)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "read archive: "+err.Error())
		return
	}

	st, err := h.assetStore()
	if err != nil {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "asset store unavailable")
		return
	}

	replacements := make(map[string][]byte, len(req.Entries))
	for _, e := range req.Entries {
		if e.ZipPath == "" || e.AssetID == "" {
			continue
		}
		key, err := archive.StrictArchivePath(e.ZipPath)
		if err != nil || key == "" || key == "." {
			continue
		}
		rc, _, err := st.Open(ownerID, e.AssetID)
		if err != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, "read entry asset "+e.AssetID+": "+err.Error())
			return
		}
		b, readErr := io.ReadAll(rc)
		rc.Close()
		if readErr != nil {
			apibase.WriteAPIError(w, http.StatusBadRequest, "read entry asset "+e.AssetID+": "+readErr.Error())
			return
		}
		replacements[key] = b
	}

	result, _, err := gallerylib.ReplaceZipEntries(data, replacements)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "repack zip: "+err.Error())
		return
	}

	if err := fsutil.AtomicWrite(target, result, 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "writeback failed: "+err.Error())
		return
	}

	// Defer-remove each replacement asset so temp converted files do not
	// accumulate (F-27).
	for _, e := range req.Entries {
		if e.AssetID != "" {
			_ = st.Release(ownerID, e.AssetID)
		}
	}

	h.d.Logger.Info("gallery: zip edit writeback (%d entries replaced, grant %s)", len(replacements), req.GrantID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
