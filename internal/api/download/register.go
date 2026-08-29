// Package download provides HTTP handlers for download management.
package download

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/download"
	"github.com/tinyrouter/tinyrouter/internal/fsutil"
	"github.com/tinyrouter/tinyrouter/internal/outbound"
)

// Handler implements HTTP handlers for the download API.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a new download Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register registers all download routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/downloads", h.listDownloads)
	r.Post("/downloads", h.createDownload)
	r.Get("/downloads/stream", h.streamDownloadEvents)
	r.Post("/downloads/info", h.getVideoInfo)
	r.Post("/downloads/playlist-info", h.getPlaylistInfo)
	r.Post("/downloads/playlist", h.createPlaylistDownload)
	r.Post("/downloads/clear-completed", h.clearCompletedDownloads)
	r.Get("/downloads/{id}", h.getDownload)
	r.Get("/downloads/{id}/log", h.getDownloadLog)
	r.Get("/downloads/{id}/file", h.playDownloadFile)
	r.Post("/downloads/{id}/cancel", h.cancelDownload)
	r.Post("/downloads/{id}/open", h.openDownloadDir)
	r.Post("/downloads/{id}/retry", h.retryDownloadTask)
	r.Delete("/downloads/{id}", h.removeDownload)
	r.Post("/open-url", h.openExternalURL)
}

// --- Download API Handlers ---

// validateDownloadDir validates that the download directory is non-empty and
// does not traverse outside the allowed root (DefaultDir). It cleans the path
// and rejects ".." traversal. If dir is empty, it returns nil (the caller will
// apply the default).
func validateDownloadDir(dir, defaultDir string) error {
	if dir == "" {
		return nil
	}
	cleaned := filepath.Clean(dir)
	// Reject path traversal: after cleaning, ".." only appears at the start
	// if the path escapes the root.
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return fmt.Errorf("download directory cannot contain path traversal (..)")
	}
	// When a default dir is configured, the download directory must be within
	// its subtree regardless of whether the caller supplied an absolute or
	// relative path. Relative paths are resolved against the default dir
	// before the containment check (so "evil" cannot bypass it).
	if defaultDir != "" {
		absDefault, err := filepath.Abs(defaultDir)
		if err != nil {
			return fmt.Errorf("failed to resolve default download dir: %w", err)
		}
		var absDir string
		if filepath.IsAbs(cleaned) {
			absDir, err = filepath.Abs(cleaned)
			if err != nil {
				return fmt.Errorf("failed to resolve download dir: %w", err)
			}
		} else {
			// Relative: resolve against the allowed root so containment is enforced.
			joined := filepath.Join(absDefault, cleaned)
			absDir, err = filepath.Abs(joined)
			if err != nil {
				return fmt.Errorf("failed to resolve download dir: %w", err)
			}
		}
		if absDir != absDefault && !strings.HasPrefix(absDir, absDefault+string(filepath.Separator)) {
			return fmt.Errorf("download directory must be within %s", absDefault)
		}
	}
	return nil
}

// validateDownloadURL validates a download URL under the outbound SSRF
// policy: http/https only, no userinfo credentials, no blocked ports, and the
// host must not resolve to a private/loopback/link-local/multicast address
// (fail-closed). This pre-flights the initial URL before yt-dlp is spawned;
// redirect hops are delegated to yt-dlp after this initial check.
func validateDownloadURL(rawURL string) error {
	u, err := outbound.ValidateURL(rawURL)
	if err != nil {
		return err
	}
	if err := (outbound.Policy{}).CheckHost(context.Background(), u.Hostname()); err != nil {
		return fmt.Errorf("url host resolves to a blocked address")
	}
	return nil
}

// createDownload 创建下载任务
// POST /api/downloads
// Body: { "url": "...", "type": "video"|"audio", "quality": "best"|"good"|..., "container": "auto"|"mp4"|..., "downloadDir": "..." }
func (h *Handler) createDownload(w http.ResponseWriter, r *http.Request) {
	if !h.d.DownloadMgr.Started() {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "download manager is not started (check config: download.enabled)")
		return
	}
	var input download.CreateTaskInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if input.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url is required")
		return
	}
	if err := validateDownloadURL(input.URL); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.Type == "" {
		input.Type = download.TypeVideo
	}
	if input.Quality == "" {
		input.Quality = download.QualityBest
	}
	if input.Container == "" {
		input.Container = download.ContainerAuto
	}
	if input.DownloadDir == "" {
		input.DownloadDir = h.d.Reg.Config().Download.DefaultDir
	}
	cfg := h.d.Reg.Config()
	if err := validateDownloadDir(input.DownloadDir, cfg.Download.DefaultDir); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	taskID := h.d.DownloadMgr.CreateTask(input)
	task, _ := h.d.DownloadMgr.GetTask(taskID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(task)
}

// getVideoInfo 查询视频信息
// POST /api/downloads/info
// Body: { "url": "..." }
func (h *Handler) getVideoInfo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url is required")
		return
	}
	if err := validateDownloadURL(req.URL); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := h.d.DownloadMgr.GetVideoInfo(r.Context(), req.URL)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("query failed: %v", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

// getPlaylistInfo 查询播放列表信息
// POST /api/downloads/playlist-info
// Body: { "url": "..." }
// 返回 { "title": "...", "entries": [...], "ids": [...] }
func (h *Handler) getPlaylistInfo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url is required")
		return
	}
	if err := validateDownloadURL(req.URL); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := h.d.DownloadMgr.GetPlaylistInfo(r.Context(), req.URL)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("query failed: %v", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"title":   info.Title,
		"entries": info.Entries,
		"ids":     []string{},
	})
}

// createPlaylistDownload 创建播放列表批量下载
// POST /api/downloads/playlist
// Body: { "url": "...", "type": "video"|"audio", "quality": "...", "container": "...", "downloadDir": "..." }
// 返回 { "ids": [...], "title": "..." }
func (h *Handler) createPlaylistDownload(w http.ResponseWriter, r *http.Request) {
	if !h.d.DownloadMgr.Started() {
		apibase.WriteAPIError(w, http.StatusServiceUnavailable, "download manager is not started (check config: download.enabled)")
		return
	}
	var input download.CreateTaskInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if input.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url is required")
		return
	}
	if err := validateDownloadURL(input.URL); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.Type == "" {
		input.Type = download.TypeVideo
	}
	if input.Quality == "" {
		input.Quality = download.QualityBest
	}
	if input.Container == "" {
		input.Container = download.ContainerAuto
	}
	if input.DownloadDir == "" {
		input.DownloadDir = h.d.Reg.Config().Download.DefaultDir
	}
	cfg := h.d.Reg.Config()
	if err := validateDownloadDir(input.DownloadDir, cfg.Download.DefaultDir); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}

	ids, title, err := h.d.DownloadMgr.CreatePlaylistTask(r.Context(), input)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, fmt.Sprintf("playlist query failed: %v", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"ids":   ids,
		"title": title,
	})
}

// listDownloads 列出所有下载任务
// GET /api/downloads
func (h *Handler) listDownloads(w http.ResponseWriter, r *http.Request) {
	tasks := h.d.DownloadMgr.ListTasks()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tasks)
}

// getDownload 获取单个下载任务详情
// GET /api/downloads/{id}
func (h *Handler) getDownload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, ok := h.d.DownloadMgr.GetTask(id)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "task not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

// cancelDownload 取消下载任务
// POST /api/downloads/{id}/cancel
func (h *Handler) cancelDownload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DownloadMgr.CancelTask(id); err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// removeDownload 移除已完成的下载任务
// DELETE /api/downloads/{id}
func (h *Handler) removeDownload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DownloadMgr.RemoveTask(id); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// clearCompletedDownloads 清除所有已完成的任务
// POST /api/downloads/clear-completed
func (h *Handler) clearCompletedDownloads(w http.ResponseWriter, r *http.Request) {
	h.d.DownloadMgr.ClearCompleted()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// streamDownloadEvents SSE 推送下载事件
// GET /api/downloads/stream
func (h *Handler) streamDownloadEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// 先发送当前所有任务快照
	tasks := h.d.DownloadMgr.ListTasks()
	for _, task := range tasks {
		payload, _ := json.Marshal(download.Event{Type: "task-updated", Task: task})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}

	// 订阅事件
	ch := h.d.DownloadMgr.Subscribe()
	defer h.d.DownloadMgr.Unsubscribe(ch)

	ctx := r.Context()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case evt, ok := <-ch:
			if !ok {
				return
			}
			payload, _ := json.Marshal(evt)
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		case <-ctx.Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// getDownloadLog 返回任务的 yt-dlp 日志输出
// GET /api/downloads/{id}/log
func (h *Handler) getDownloadLog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, ok := h.d.DownloadMgr.GetTask(id)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "task not found")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(task.LogTail))
}

// openDownloadDir opens the local directory and selects the file
// POST /api/downloads/{id}/open
func (h *Handler) openDownloadDir(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, ok := h.d.DownloadMgr.GetTask(id)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "task not found")
		return
	}
	path := task.FilePath
	if path == "" {
		path = task.SavedFile
	}
	if path == "" {
		path = task.DownloadDir
	}
	if path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "path empty")
		return
	}

	// PathGuard: ensure the served path is inside the configured download root.
	// Download tasks are created with validateDownloadDir, but SavedFile/FilePath
	// are extracted from yt-dlp stdout and could be traversed if yt-dlp was
	// fed a malicious URL. Reject outside-root resolves.
	cfgDir := h.d.Reg.Config().Download.DefaultDir
	if cfgDir != "" {
		if guarded, err := fsutil.PathGuard(cfgDir, path); err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "file path outside allowed directory")
			return
		} else {
			path = guarded
		}
	} else {
		absPath, err := filepath.Abs(path)
		if err == nil {
			path = absPath
		}
	}

	if err := fsutil.OpenInFileManager(path); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, fmt.Sprintf("open folder: %s", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// retryDownloadTask re-queues a failed or cancelled task in place, reusing the
// original task ID so the task item stays in its current position.
// POST /api/downloads/{id}/retry
func (h *Handler) retryDownloadTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.d.DownloadMgr.RetryTask(id); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// playDownloadFile serves the downloaded media file with HTTP range headers.
// GET /api/downloads/{id}/file
func (h *Handler) playDownloadFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, ok := h.d.DownloadMgr.GetTask(id)
	if !ok {
		apibase.WriteAPIError(w, http.StatusNotFound, "task not found")
		return
	}
	path := task.FilePath
	if path == "" {
		path = task.SavedFile
	}
	if path == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "file path is empty")
		return
	}
	// PathGuard: reject file serves outside the download root (see openDownloadDir).
	cfgDir := h.d.Reg.Config().Download.DefaultDir
	if cfgDir != "" {
		if guarded, err := fsutil.PathGuard(cfgDir, path); err != nil {
			apibase.WriteAPIError(w, http.StatusForbidden, "file path outside allowed directory")
			return
		} else {
			path = guarded
		}
	}
	if _, err := os.Stat(path); err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "file not found on disk")
		return
	}
	http.ServeFile(w, r, path)
}

// openExternalURL opens the given HTTP/HTTPS URL in the default web browser.
// POST /api/open-url
func (h *Handler) openExternalURL(w http.ResponseWriter, r *http.Request) {
	var input struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url")
		return
	}
	parsed, err := url.Parse(input.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url scheme")
		return
	}

	if err := fsutil.OpenInBrowser(input.URL); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, fmt.Sprintf("open url: %s", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

