package music

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/config"
)

// Handler implements /api/music endpoints.
type Handler struct {
	deps *apibase.Deps
}

// NewHandler creates a music handler.
func NewHandler(d *apibase.Deps) *Handler { return &Handler{deps: d} }

// Register mounts /api/music routes. Called from router.go under auth middleware.
func (h *Handler) Register(r chi.Router) {
	r.Get("/music/library", h.library)
	r.Post("/music/proxy", h.proxy)
	r.Post("/music/download", h.download)
}

func (h *Handler) musicDir() string {
	cfg := h.deps.Reg.Config()
	return config.ResolveMusicDir(cfg.MusicDir, filepath.Dir(h.deps.ConfigPath))
}

func (h *Handler) library(w http.ResponseWriter, r *http.Request) {
	dir := h.musicDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type fileInfo struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		Mtime string `json:"mtime"`
		Ext   string `json:"ext"`
		IsDir bool   `json:"isDir"`
	}
	var files []fileInfo
	for _, e := range entries {
		info, _ := e.Info()
		files = append(files, fileInfo{
			Name:  e.Name(),
			Size:  info.Size(),
			Mtime: info.ModTime().Format(time.RFC3339),
			Ext:   strings.ToLower(filepath.Ext(e.Name())),
			IsDir: e.IsDir(),
		})
	}
	if files == nil {
		files = []fileInfo{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"dir": dir, "files": files})
}

// proxy fetches a remote audio URL and streams it back to the browser to bypass CORS.
// POST /api/music/proxy  { "url": "https://..." }
func (h *Handler) proxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		// fallback to query ?url=
		body.URL = r.URL.Query().Get("url")
		if body.URL == "" {
			apibase.WriteAPIError(w, http.StatusBadRequest, "url required")
			return
		}
	}
	u, err := url.Parse(body.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, body.URL, nil)
	req.Header.Set("User-Agent", "TinyRouter/1.0 Music")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apibase.WriteAPIError(w, http.StatusBadGateway, fmt.Sprintf("upstream %d", resp.StatusCode))
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "audio/mpeg")
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, resp.Body)
}

// download fetches a remote audio URL and saves it to Musics dir.
// POST /api/music/download  { "url": "https://...", "filename": "foo.mp3" }
func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url required")
		return
	}
	if body.Filename == "" {
		u, _ := url.Parse(body.URL)
		body.Filename = filepath.Base(u.Path)
		if body.Filename == "" || body.Filename == "." || body.Filename == "/" {
			body.Filename = fmt.Sprintf("track-%d.mp3", time.Now().Unix())
		}
	}
	body.Filename = filepath.Base(body.Filename) // prevent traversal
	if body.Filename == "" {
		body.Filename = "track.mp3"
	}
	u, err := url.Parse(body.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, body.URL, nil)
	req.Header.Set("User-Agent", "TinyRouter/1.0 Music")
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apibase.WriteAPIError(w, http.StatusBadGateway, fmt.Sprintf("upstream %d", resp.StatusCode))
		return
	}
	dir := h.musicDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Avoid overwrite: suffix (1),(2)...
	dest := filepath.Join(dir, body.Filename)
	if _, err := os.Stat(dest); err == nil {
		ext := filepath.Ext(body.Filename)
		base := strings.TrimSuffix(body.Filename, ext)
		for i := 1; i < 1000; i++ {
			tryName := fmt.Sprintf("%s (%d)%s", base, i, ext)
			tryPath := filepath.Join(dir, tryName)
			if _, err := os.Stat(tryPath); os.IsNotExist(err) {
				dest = tryPath
				body.Filename = tryName
				break
			}
		}
	}
	tmp := dest + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, err := io.Copy(f, resp.Body)
	_ = f.Close()
	if err != nil {
		_ = os.Remove(tmp)
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "filename": body.Filename, "size": n, "path": dest, "dir": dir})
}
