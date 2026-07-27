package trace

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tinyrouter/tinyrouter/internal/api/apibase"
)

// Handler wires the trace HTTP handlers to the shared dependencies.
type Handler struct {
	d *apibase.Deps
}

// NewHandler creates a trace Handler.
func NewHandler(d *apibase.Deps) *Handler {
	return &Handler{d: d}
}

// Register mounts the trace routes on the given router.
func (h *Handler) Register(r chi.Router) {
	r.Get("/dates", h.getDates)
	r.Get("/index", h.getIndex)
	r.Get("/req/{reqID}", h.getReq)
	r.Post("/clear", h.clearTraces)
}

var dateFilenameRe = regexp.MustCompile(`^index-(\d{8})\.jsonl$`)
var yyyymmddRe = regexp.MustCompile(`^\d{8}$`)

// sanitizePathParam rejects path traversal attempts in user-supplied
// path parameters used in filepath.Join.
func sanitizePathParam(s string) bool {
	if strings.ContainsAny(s, "/\\") {
		return false
	}
	if strings.Contains(s, "..") {
		return false
	}
	if strings.ContainsRune(s, 0) {
		return false
	}
	return true
}

func (h *Handler) getDates(w http.ResponseWriter, r *http.Request) {
	tracesDir := h.d.ProxyHandler.TracesDir()
	w.Header().Set("Content-Type", "application/json")

	if tracesDir == "" {
		json.NewEncoder(w).Encode(map[string]any{
			"dates": []any{},
			"dir":   "",
		})
		return
	}

	entries, err := os.ReadDir(tracesDir)
	if err != nil {
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read traces directory")
		return
	}

	type dateInfo struct {
		Date      string `json:"date"`
		Count     int    `json:"count"`
		SizeBytes int64  `json:"sizeBytes"`
	}

	var dates []dateInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		m := dateFilenameRe.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		dateStr := m[1] // YYYYMMDD
		formatted := dateStr[:4] + "-" + dateStr[4:6] + "-" + dateStr[6:]

		info, err := entry.Info()
		if err != nil {
			continue
		}

		// Count lines by reading the file.
		count := 0
		f, err := os.Open(filepath.Join(tracesDir, name))
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			count++
		}
		f.Close()

		dates = append(dates, dateInfo{
			Date:      formatted,
			Count:     count,
			SizeBytes: info.Size(),
		})
	}

	// Sort by date DESC.
	sort.Slice(dates, func(i, j int) bool {
		return dates[i].Date > dates[j].Date
	})

	json.NewEncoder(w).Encode(map[string]any{
		"dates": dates,
		"dir":   tracesDir,
	})
}

func (h *Handler) getIndex(w http.ResponseWriter, r *http.Request) {
	tracesDir := h.d.ProxyHandler.TracesDir()
	w.Header().Set("Content-Type", "application/json")

	if tracesDir == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "tracing not configured")
		return
	}

	date := r.URL.Query().Get("date")
	if date == "" {
		apibase.WriteAPIError(w, http.StatusBadRequest, "missing date parameter")
		return
	}
	if !yyyymmddRe.MatchString(date) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid date format, expected YYYYMMDD")
		return
	}
	if !sanitizePathParam(date) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid date parameter")
		return
	}

	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 1000 {
		limit = 1000
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if n, err := strconv.Atoi(o); err == nil && n > 0 {
			offset = n
		}
	}

	statusFilter := r.URL.Query().Get("status")
	qFilter := r.URL.Query().Get("q")

	indexPath := filepath.Join(tracesDir, "index-"+date+".jsonl")
	f, err := os.Open(indexPath)
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, "no index file for date")
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to open index file")
		return
	}
	defer f.Close()

	var lines []map[string]any
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			h.d.Logger.Warn("trace index: skipping malformed line: %v", err)
			continue
		}

		// Filter by status.
		if statusFilter != "" {
			statusVal, ok := parsed["status"].(string)
			if !ok || statusVal != statusFilter {
				continue
			}
		}

		// Filter by q (case-insensitive substring match).
		if qFilter != "" {
			qLower := strings.ToLower(qFilter)
			fields := []string{"model", "provider", "provenance", "error", "reqID", "session"}
			matched := false
			for _, field := range fields {
				val, _ := parsed[field].(string)
				if strings.Contains(strings.ToLower(val), qLower) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}

		lines = append(lines, parsed)
	}

	total := len(lines)

	// Reverse chronological order (newest first).
	// Since the file is append-only, the last lines are newest.
	// Reverse the slice.
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}

	// Apply offset + limit.
	if offset >= total {
		lines = []map[string]any{}
	} else {
		end := offset + limit
		if end > total {
			end = total
		}
		lines = lines[offset:end]
	}

	json.NewEncoder(w).Encode(map[string]any{
		"lines": lines,
		"total": total,
	})
}

func (h *Handler) getReq(w http.ResponseWriter, r *http.Request) {
	tracesDir := h.d.ProxyHandler.TracesDir()
	w.Header().Set("Content-Type", "application/json")

	if tracesDir == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "tracing not configured")
		return
	}

	reqID := chi.URLParam(r, "reqID")
	if !sanitizePathParam(reqID) {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid reqID parameter")
		return
	}

	reqPath := filepath.Join(tracesDir, "req", reqID+".jsonl")
	f, err := os.Open(reqPath)
	if err != nil {
		if os.IsNotExist(err) {
			apibase.WriteAPIError(w, http.StatusNotFound, fmt.Sprintf("no trace file for reqID %s", reqID))
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to open request trace file")
		return
	}
	defer f.Close()

	var lines []map[string]any
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			h.d.Logger.Warn("trace req %s: skipping malformed line: %v", reqID, err)
			continue
		}
		lines = append(lines, parsed)
	}

	json.NewEncoder(w).Encode(map[string]any{
		"reqID": reqID,
		"lines": lines,
	})
}

// clearTraces wipes all trace data (index-*.jsonl files and every file under
// req/) from the traces directory. It keeps the directory structure so
// in-flight and future writes continue to work. Tracing must be stopped or
// allowed to race-best-effort with new writes. Returns the count of removed
// files and their total size in bytes.
func (h *Handler) clearTraces(w http.ResponseWriter, r *http.Request) {
	tracesDir := h.d.ProxyHandler.TracesDir()
	w.Header().Set("Content-Type", "application/json")
	if tracesDir == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "tracing not configured")
		return
	}
	var clearedFiles int
	var clearedBytes int64
	// Remove top-level index-*.jsonl files.
	if entries, err := os.ReadDir(tracesDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !strings.HasPrefix(name, "index-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			if info, err := e.Info(); err == nil {
				clearedBytes += info.Size()
			}
			if os.Remove(filepath.Join(tracesDir, name)) == nil {
				clearedFiles++
			}
		}
	}
	// Remove every file under req/.
	reqDir := filepath.Join(tracesDir, "req")
	if reqEntries, err := os.ReadDir(reqDir); err == nil {
		for _, e := range reqEntries {
			if e.IsDir() {
				continue
			}
			if info, err := e.Info(); err == nil {
				clearedBytes += info.Size()
			}
			if os.Remove(filepath.Join(reqDir, e.Name())) == nil {
				clearedFiles++
			}
		}
	}
	json.NewEncoder(w).Encode(map[string]any{
		"clearedFiles": clearedFiles,
		"clearedBytes": clearedBytes,
	})
}
