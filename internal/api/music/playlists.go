package music

import (
	"context"
	"time"
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
	"github.com/tinyrouter/tinyrouter/internal/outbound"
)

// Playlist persistence: single JSON file Musics/playlists.json
// Shape: { playlists: [{id,name,tracks:Song[]}] }  — frontend is source of truth, backend is durable mirror.
// Also supports m3u import/export as plain text files in Musics.

func playlistsPath(dir string) string { return filepath.Join(dir, "playlists.json") }

func (h *Handler) listPlaylists(w http.ResponseWriter, r *http.Request) {
	dir := h.musicDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	path := playlistsPath(dir)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"playlists": []any{}})
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

func (h *Handler) savePlaylists(w http.ResponseWriter, r *http.Request) {
	dir := h.musicDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid json")
		return
	}
	path := playlistsPath(dir)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (h *Handler) importPlaylistURL(w http.ResponseWriter, r *http.Request) {
	// Accepts {url} where url is a remote m3u/playlist JSON. Fetches and attempts to parse
	// into a normalized {name,tracks[]} for frontend. This is best-effort.
	var body struct {
		URL  string `json:"url"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "url required")
		return
	}
	// SSRF guard: only http/https
	if !strings.HasPrefix(body.URL, "http://") && !strings.HasPrefix(body.URL, "https://") {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url")
		return
	}
	// P0-02c: SSRF via outbound Policy + timeout + limit
	parsedURL, err := outbound.ValidateURL(body.URL)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid url: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := (outbound.Policy{Timeout: 15 * time.Second}).CheckHost(ctx, parsedURL.Hostname()); err != nil {
		apibase.WriteAPIError(w, http.StatusForbidden, "url resolves to a blocked address")
		return
	}
	client := (outbound.Policy{Timeout: 15 * time.Second}).Client()
	req2, _ := http.NewRequestWithContext(ctx, "GET", body.URL, nil)
	resp, err := client.Do(req2)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.ContentLength > 5<<20 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "response too large")
		return
	}
	bs, _ := io.ReadAll(io.LimitReader(resp.Body, 5<<20+1))
	if int64(len(bs)) > 5<<20 {
		apibase.WriteAPIError(w, http.StatusBadRequest, "response too large")
		return
	}
	ct := resp.Header.Get("Content-Type")
	tracks := []map[string]any{}
	name := body.Name
	if name == "" {
		name = filepath.Base(body.URL)
	}
	if strings.Contains(ct, "json") || (len(bs) > 0 && bs[0] == '{') || (len(bs) > 0 && bs[0] == '[') {
		var j any
		if err := json.Unmarshal(bs, &j); err == nil {
			// try to extract array of tracks
			if arr, ok := j.([]any); ok {
				for _, it := range arr {
					if m, ok := it.(map[string]any); ok {
						tracks = append(tracks, map[string]any{"title": fmt.Sprint(m["title"]), "url": fmt.Sprint(m["url"])})
					}
				}
			} else if m, ok := j.(map[string]any); ok {
				if arr, ok := m["tracks"].([]any); ok {
					for _, it := range arr {
						if mm, ok := it.(map[string]any); ok {
							tracks = append(tracks, map[string]any{"title": fmt.Sprint(mm["title"]), "url": fmt.Sprint(mm["url"])})
						}
					}
				}
			}
		}
	} else {
		// m3u text
		s := bufio.NewScanner(strings.NewReader(string(bs)))
		for s.Scan() {
			line := strings.TrimSpace(s.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			tracks = append(tracks, map[string]any{"title": filepath.Base(line), "url": line})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"name": name, "tracks": tracks})
}

func (h *Handler) exportM3U(w http.ResponseWriter, r *http.Request) {
	// GET /api/music/m3u?name=playlistName — export one playlist from playlists.json as m3u
	name := r.URL.Query().Get("name")
	if name == "" {
		name = r.URL.Query().Get("playlist")
	}
	dir := h.musicDir()
	path := playlistsPath(dir)
	data, err := os.ReadFile(path)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "no playlists")
		return
	}
	var doc map[string]any
	_ = json.Unmarshal(data, &doc)
	var pls []any
	if v, ok := doc["playlists"].([]any); ok {
		pls = v
	} else if v, ok := doc["playlists"]; ok {
		_ = v
	}
	var target map[string]any
	for _, it := range pls {
		if m, ok := it.(map[string]any); ok {
			if fmt.Sprint(m["name"]) == name || fmt.Sprint(m["id"]) == name {
				target = m
				break
			}
		}
	}
	if target == nil && name == "" && len(pls) > 0 {
		if m, ok := pls[0].(map[string]any); ok {
			target = m
			name = fmt.Sprint(m["name"])
		}
	}
	if target == nil {
		apibase.WriteAPIError(w, http.StatusNotFound, "playlist not found")
		return
	}
	var tracks []any
	if v, ok := target["tracks"].([]any); ok {
		tracks = v
	}
	var buf strings.Builder
	buf.WriteString("#EXTM3U\n")
	for _, it := range tracks {
		if m, ok := it.(map[string]any); ok {
			title := fmt.Sprint(m["title"])
			url := fmt.Sprint(m["url"])
			if url == "" {
				url = fmt.Sprint(m["src"])
			}
			if url == "" {
				continue
			}
			buf.WriteString("#EXTINF:-1," + title + "\n")
			buf.WriteString(url + "\n")
		}
	}
	out := buf.String()
	filename := name + ".m3u"
	if !strings.HasSuffix(strings.ToLower(filename), ".m3u") {
		filename += ".m3u"
	}
	filename = filepath.Base(filename)
	w.Header().Set("Content-Type", "audio/x-mpegurl")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
	_, _ = w.Write([]byte(out))
}

func (h *Handler) importM3U(w http.ResponseWriter, r *http.Request) {
	// POST /api/music/m3u — body is m3u text, or {name, m3u}
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	bs, _ := io.ReadAll(r.Body)
	ct := r.Header.Get("Content-Type")
	var m3uText string
	var name string
	if strings.Contains(ct, "application/json") {
		var body struct {
			Name string `json:"name"`
			M3U  string `json:"m3u"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(bs, &body)
		m3uText = body.M3U
		if m3uText == "" {
			m3uText = body.Text
		}
		if m3uText == "" {
			m3uText = string(bs)
		}
		name = body.Name
	} else {
		m3uText = string(bs)
		name = r.URL.Query().Get("name")
	}
	if strings.TrimSpace(m3uText) == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "m3u empty")
		return
	}
	tracks := []map[string]any{}
	s := bufio.NewScanner(strings.NewReader(m3uText))
	pendingTitle := ""
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			// #EXTINF:<dur>,Title
			if idx := strings.Index(line, ","); idx >= 0 {
				pendingTitle = strings.TrimSpace(line[idx+1:])
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		title := pendingTitle
		if title == "" {
			title = filepath.Base(line)
		}
		pendingTitle = ""
		tracks = append(tracks, map[string]any{"title": title, "url": line})
	}
	if name == "" {
		name = fmt.Sprintf("import-%d", len(tracks))
	}
	// Persist into playlists.json as a new entry (append, dedup by name)
	dir := h.musicDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	path := playlistsPath(dir)
	var doc map[string]any
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &doc)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	var pls []any
	if v, ok := doc["playlists"].([]any); ok {
		pls = v
	}
	// merge or append
	replaced := false
	for i, it := range pls {
		if m, ok := it.(map[string]any); ok && fmt.Sprint(m["name"]) == name {
			pls[i] = map[string]any{"id": fmt.Sprint(m["id"]), "name": name, "tracks": tracks}
			replaced = true
			break
		}
	}
	if !replaced {
		id := fmt.Sprintf("pl-%d", len(pls)+1)
		pls = append(pls, map[string]any{"id": id, "name": name, "tracks": tracks})
	}
	doc["playlists"] = pls
	out, _ := json.MarshalIndent(doc, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0644); err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		apibase.WriteAPIError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "name": name, "tracks": tracks, "playlists": pls})
}
