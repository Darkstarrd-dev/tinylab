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
	r.Get("/music/bilibili/search", h.bilibiliSearch)
	r.Post("/music/bilibili/resolve", h.bilibiliResolve)
	r.Post("/music/transcode", h.transcode)
	r.Get("/music/file", h.serveFile)
	r.Get("/music/playlists", h.listPlaylists)
	r.Put("/music/playlists", h.savePlaylists)
	r.Post("/music/playlists/import", h.importPlaylistURL)
	r.Get("/music/m3u", h.exportM3U)
	r.Post("/music/m3u", h.importM3U)
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

// ===== Bilibili (Azusa extractor) — backend proxy to avoid CORS =====
func (h *Handler) bilibiliSearch(w http.ResponseWriter, r *http.Request) {
	kw := r.URL.Query().Get("keyword")
	if kw == "" { kw = r.URL.Query().Get("q") }
	if kw == "" { kw = r.URL.Query().Get("search") }
	limitStr := r.URL.Query().Get("limit")
	limit := 20
	if limitStr != "" {
		var v int
		if _, err := fmt.Sscanf(limitStr, "%d", &v); err == nil && v > 0 {
			limit = v
			if limit > 50 { limit = 50 }
		}
	}
	if kw == "" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]any{})
		return
	}
	searchURL := fmt.Sprintf("https://api.bilibili.com/x/web-interface/search/type?keyword=%s&search_type=video&order=totalrank&page=1&limit=%d", url.QueryEscape(kw), limit)
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, searchURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("Accept", "application/json")
	cli := &http.Client{Timeout: 15 * time.Second}
	resp, err := cli.Do(req)
	if err != nil { apibase.WriteAPIError(w, http.StatusBadGateway, err.Error()); return }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil { apibase.WriteAPIError(w, http.StatusBadGateway, "bilibili search decode"); return }
	var songs []map[string]any
	if data, ok := raw["data"].(map[string]any); ok {
		var list []any
		if arr, ok := data["result"].([]any); ok { list = arr }
		for _, it := range list {
			m, _ := it.(map[string]any)
			if m == nil { continue }
			bvid, _ := m["bvid"].(string)
			if bvid == "" { bvid, _ = m["bv_id"].(string) }
			if bvid == "" { continue }
			title, _ := m["title"].(string)
			title = strings.ReplaceAll(strings.ReplaceAll(title, "<em class=\"keyword\">", ""), "</em>", "")
			author, _ := m["author"].(string)
			if author == "" {
				if o, ok := m["owner"].(map[string]any); ok { author, _ = o["name"].(string) }
			}
			pic, _ := m["pic"].(string)
			if pic == "" { pic, _ = m["cover"].(string) }
			if strings.HasPrefix(pic, "//") { pic = "https:" + pic }
			var dur float64
			if d, ok := m["duration"].(string); ok {
				parts := strings.Split(d, ":")
				for _, p := range parts {
					var v float64
					fmt.Sscanf(p, "%f", &v)
					dur = dur*60 + v
				}
			} else if v, ok := m["duration"].(float64); ok { dur = v }
			var cid string
			if v, ok := m["cid"].(float64); ok && v != 0 { cid = fmt.Sprintf("%.0f", v) }
			songs = append(songs, map[string]any{
				"id": bvid, "bvid": bvid, "cid": cid, "title": title,
				"artist": author, "album": "", "duration": dur, "cover": pic, "source": "bilibili",
			})
			if len(songs) >= limit { break }
		}
	}
	if songs == nil { songs = []map[string]any{} }
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(songs)
}

func (h *Handler) bilibiliResolve(w http.ResponseWriter, r *http.Request) {
	var body struct { Bvid string `json:"bvid"`; Cid string `json:"cid"`; ID string `json:"id"` }
	_ = json.NewDecoder(r.Body).Decode(&body)
	bvid := body.Bvid
	if bvid == "" { bvid = body.ID }
	if bvid == "" { apibase.WriteAPIError(w, http.StatusBadRequest, "bvid required"); return }
	cid := body.Cid
	if cid == "" {
		viewURL := fmt.Sprintf("https://api.bilibili.com/x/web-interface/view?bvid=%s", url.QueryEscape(bvid))
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, viewURL, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0"); req.Header.Set("Referer", "https://www.bilibili.com/")
		cli := &http.Client{Timeout: 15 * time.Second}
		resp, err := cli.Do(req)
		if err != nil { apibase.WriteAPIError(w, http.StatusBadGateway, err.Error()); return }
		defer resp.Body.Close()
		var j map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&j)
		if data, ok := j["data"].(map[string]any); ok {
			if v, ok := data["cid"].(float64); ok { cid = fmt.Sprintf("%.0f", v) }
			if cid == "" {
				if pgs, ok := data["pages"].([]any); ok && len(pgs) > 0 {
					if m, ok := pgs[0].(map[string]any); ok {
						if v, ok := m["cid"].(float64); ok { cid = fmt.Sprintf("%.0f", v) }
					}
				}
			}
		}
		if cid == "" { apibase.WriteAPIError(w, http.StatusBadGateway, "cid not found"); return }
	}
	playURL := fmt.Sprintf("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%s&fnval=16", url.QueryEscape(bvid), url.QueryEscape(cid))
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, playURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0"); req.Header.Set("Referer", "https://www.bilibili.com/")
	cli := &http.Client{Timeout: 15 * time.Second}
	resp, err := cli.Do(req)
	if err != nil { apibase.WriteAPIError(w, http.StatusBadGateway, err.Error()); return }
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)
	var j map[string]any
	_ = json.Unmarshal(bodyBytes, &j)
	var audioURL string
	if data, ok := j["data"].(map[string]any); ok {
		if durl, ok := data["durl"].([]any); ok && len(durl) > 0 {
			if m, ok := durl[0].(map[string]any); ok { audioURL, _ = m["url"].(string) }
		}
		if audioURL == "" {
			if dash, ok := data["dash"].(map[string]any); ok {
				if audios, ok := dash["audio"].([]any); ok && len(audios) > 0 {
					if m, ok := audios[0].(map[string]any); ok {
						audioURL, _ = m["baseUrl"].(string)
						if audioURL == "" { audioURL, _ = m["base_url"].(string) }
					}
				}
			}
		}
	}
	if audioURL == "" { apibase.WriteAPIError(w, http.StatusBadGateway, "audio url not found (bvid may require login)"); return }
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"url": audioURL, "bvid": bvid, "cid": cid})
}

func (h *Handler) serveFile(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" { name = r.URL.Query().Get("file") }
	if name == "" { apibase.WriteAPIError(w, http.StatusBadRequest, "name required"); return }
	name = filepath.Base(name)
	if name == "" || name == "." { apibase.WriteAPIError(w, http.StatusBadRequest, "invalid name"); return }
	dir := h.musicDir()
	abs := filepath.Join(dir, name)
	f, err := os.Open(abs)
	if err != nil {
		if os.IsNotExist(err) { apibase.WriteAPIError(w, http.StatusNotFound, "not found"); return }
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error()); return
	}
	defer f.Close()
	info, _ := f.Stat()
	ext := strings.ToLower(filepath.Ext(name))
	ctype := "application/octet-stream"
	switch ext {
	case ".mp3": ctype = "audio/mpeg"
	case ".m4a", ".aac": ctype = "audio/mp4"
	case ".ogg", ".oga", ".opus": ctype = "audio/ogg"
	case ".wav": ctype = "audio/wav"
	case ".flac": ctype = "audio/flac"
	case ".wma": ctype = "audio/x-ms-wma"
	case ".ape": ctype = "audio/x-ape"
	case ".m3u", ".m3u8": ctype = "audio/x-mpegurl"
	case ".json": ctype = "application/json"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, name, info.ModTime(), f)
}

func (h *Handler) transcode(w http.ResponseWriter, r *http.Request) {
	cfg := h.deps.Reg.Config()
	ffmpegPath := cfg.Download.FfmpegPath
	if ffmpegPath == "" {
		if p, err := lookupFFmpeg(); err == nil { ffmpegPath = p }
	}
	if ffmpegPath == "" { apibase.WriteAPIError(w, http.StatusServiceUnavailable, "ffmpeg not configured (Settings → Path Settings → ffmpeg Path)"); return }
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" { format = "mp3" }
	if format != "mp3" && format != "opus" && format != "ogg" && format != "wav" { format = "mp3" }
	r.Body = http.MaxBytesReader(w, r.Body, 200<<20)
	data, err := io.ReadAll(r.Body)
	if err != nil { apibase.WriteAPIError(w, http.StatusBadRequest, err.Error()); return }
	if len(data) == 0 { apibase.WriteAPIError(w, http.StatusBadRequest, "empty body"); return }
	out, err := runFFmpegTranscode(r.Context(), ffmpegPath, data, format)
	if err != nil { apibase.WriteAPIError(w, http.StatusUnprocessableEntity, err.Error()); return }
	ctype := "audio/mpeg"
	if format == "opus" { ctype = "audio/ogg" } else if format == "ogg" { ctype = "audio/ogg" } else if format == "wav" { ctype = "audio/wav" }
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

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
