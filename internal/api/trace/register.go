package trace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/tinylab/tinylab/internal/api/apibase"
	"github.com/tinylab/tinylab/internal/logredact"
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

// Trace read bounds (F-22). Trace files are append-only and unbounded on disk;
// every read path below streams lines instead of loading a file, caps the
// number of lines and total response bytes, and stops early on cancellation.
const (
	defaultIndexLimit     = 200
	maxIndexLimit         = 1000
	maxReqDetailLines     = 1000
	maxTraceResponseBytes = 16 << 20 // 16 MiB of trace payload per response
	maxTraceLineBytes     = 1 << 20  // per-line scanner cap
	maxQFilterLen         = 256
	maxReqIDLen           = 256
)

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

// normalizeTraceDate validates the date parameter (YYYYMMDD or YYYY-MM-DD)
// and returns the on-disk YYYYMMDD form. Impossible calendar dates such as
// 2026-13-99 are rejected, not just structurally malformed ones.
func normalizeTraceDate(date string) (string, bool) {
	fileDate := strings.ReplaceAll(date, "-", "")
	if !yyyymmddRe.MatchString(fileDate) {
		return "", false
	}
	if !sanitizePathParam(fileDate) {
		return "", false
	}
	if _, err := time.Parse("20060102", fileDate); err != nil {
		return "", false
	}
	return fileDate, true
}

// matchIndexFilters applies the status and q filters to an index line. q is a
// case-insensitive substring match over the same fields the log reader UI
// displays.
func matchIndexFilters(record map[string]any, statusFilter, qLower string) bool {
	if statusFilter != "" && stringField(record, "status") != statusFilter {
		return false
	}
	if qLower != "" {
		if !containsFold(stringField(record, "model"), qLower) &&
			!containsFold(stringField(record, "provider"), qLower) &&
			!containsFold(stringField(record, "provenance"), qLower) &&
			!containsFold(stringField(record, "error"), qLower) &&
			!containsFold(stringField(record, "reqID"), qLower) &&
			!containsFold(stringField(record, "session"), qLower) {
			return false
		}
	}
	return true
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func (h *Handler) normalizeTraceRecord(record map[string]any) map[string]any {
	credentials := h.traceCredentials()
	if masked, ok := maskTraceValue(record, credentials).(map[string]any); ok {
		record = masked
	}
	for _, field := range []string{"reqHeaders", "respHeaders"} {
		if headers, ok := record[field].(map[string]any); ok {
			record[field] = normalizeHeaderRecord(headers)
		}
	}
	for _, field := range []string{"upstreamURL", "upstreamURLBase"} {
		if raw, ok := record[field].(string); ok {
			record[field] = logredact.MaskURL(raw, "")
		}
	}
	return record
}

func (h *Handler) traceCredentials() []string {
	if h.d == nil || h.d.Reg == nil {
		return nil
	}
	cfg := h.d.Reg.Config()
	var credentials []string
	for _, provider := range cfg.Providers {
		for _, key := range provider.Keys {
			if key.Key != "" {
				credentials = append(credentials, key.Key)
			}
		}
	}
	return credentials
}

func maskTraceValue(value any, credentials []string) any {
	switch typed := value.(type) {
	case string:
		for _, credential := range credentials {
			typed = logredact.MaskString(typed, credential)
		}
		return typed
	case map[string]any:
		for key, nested := range typed {
			typed[key] = maskTraceValue(nested, credentials)
		}
	case []any:
		for i, nested := range typed {
			typed[i] = maskTraceValue(nested, credentials)
		}
	}
	return value
}

func normalizeHeaderRecord(headers map[string]any) map[string][]string {
	result := make(map[string][]string, len(headers))
	for name, rawValues := range headers {
		values, ok := rawValues.([]any)
		if !ok {
			result[name] = []string{fmt.Sprint(rawValues)}
			continue
		}
		stringsValues := make([]string, len(values))
		for i, raw := range values {
			stringsValues[i] = fmt.Sprint(raw)
		}
		masked := logredact.MaskHeaderMap(map[string][]string{name: stringsValues}, "")
		result[name] = masked[name]
	}
	return result
}

func containsFold(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), substr)
}

// newTraceScanner returns a scanner with the trace line-size cap. Lines longer
// than the cap terminate the scan with a controlled error (ErrTooLong) instead
// of allocating unbounded memory.
func newTraceScanner(f *os.File) *bufio.Scanner {
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxTraceLineBytes)
	return scanner
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
		// A freshly configured (not-yet-created) traces directory is not an
		// error: it is created on the first trace write. Return an empty date
		// list with the configured dir so the log reader shows an empty state
		// instead of a 500. Any other read failure is a real error.
		if os.IsNotExist(err) {
			json.NewEncoder(w).Encode(map[string]any{
				"dates": []any{},
				"dir":   tracesDir,
			})
			return
		}
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

		// Count lines by streaming the file; never load it into memory.
		count := 0
		f, err := os.Open(filepath.Join(tracesDir, name))
		if err != nil {
			continue
		}
		scanner := newTraceScanner(f)
		for scanner.Scan() {
			if r.Context().Err() != nil {
				f.Close()
				return
			}
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
	// Accept both YYYYMMDD (8 digits) and YYYY-MM-DD (dashed, as emitted by
	// getDates). Normalize to YYYYMMDD for the on-disk filename lookup (files
	// are written as index-20060127.jsonl by the proxy's now.Format("20060102")).
	fileDate, ok := normalizeTraceDate(date)
	if !ok {
		apibase.WriteAPIError(w, http.StatusBadRequest, "invalid date format, expected YYYYMMDD or YYYY-MM-DD")
		return
	}

	limit := defaultIndexLimit
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxIndexLimit {
		limit = maxIndexLimit
	}

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if n, err := strconv.Atoi(o); err == nil && n > 0 {
			offset = n
		}
	}

	statusFilter := r.URL.Query().Get("status")
	qFilter := r.URL.Query().Get("q")
	if len(qFilter) > maxQFilterLen {
		apibase.WriteAPIError(w, http.StatusBadRequest, "q filter too long")
		return
	}
	qLower := strings.ToLower(qFilter)

	indexPath := filepath.Join(tracesDir, "index-"+fileDate+".jsonl")
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

	// Pass 1: count filtered lines by streaming the file. The whole file is
	// never held in memory; only the count survives.
	total, err := h.countIndexMatches(r.Context(), f, statusFilter, qLower)
	if err != nil {
		// On cancellation the client is gone: drop the handle (deferred) and
		// return without writing anything.
		if r.Context().Err() != nil {
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read index file")
		return
	}

	// offset >= total yields an empty page (matches the pre-streaming
	// behavior where the reversed slice was sliced past its end).
	if offset >= total {
		writeIndexEnvelope(w, nil, total, false)
		return
	}

	// Pass 2: rewind and stream again, keeping only the filtered lines whose
	// 1-based match position m falls in (total-offset-limit, total-offset].
	// Those are exactly the lines at reversed positions [offset, offset+limit),
	// i.e. the requested newest-first page. Early-stop once m passes the window.
	lo := total - offset - limit + 1
	hi := total - offset
	if lo < 1 {
		lo = 1
	}
	page, truncated, err := h.collectIndexPage(r.Context(), f, statusFilter, qLower, lo, hi)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read index file")
		return
	}

	// Lines were collected oldest-first within the window; reverse to
	// newest-first for the response.
	for i, j := 0, len(page)-1; i < j; i, j = i+1, j-1 {
		page[i], page[j] = page[j], page[i]
	}

	writeIndexEnvelope(w, page, total, truncated)
}

// countIndexMatches streams the index file once, returning the number of
// lines matching the status/q filters. It checks request cancellation between
// lines.
func (h *Handler) countIndexMatches(ctx context.Context, f *os.File, statusFilter, qLower string) (int, error) {
	total := 0
	scanner := newTraceScanner(f)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			h.d.Logger.Warn("trace index: skipping malformed line: %v", err)
			continue
		}
		if matchIndexFilters(record, statusFilter, qLower) {
			total++
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return total, nil
}

// collectIndexPage streams the index file a second time and returns the
// complete trace records whose 1-based match position falls in [lo, hi], stopping
// early once the window is passed or a response cap is hit. The returned
// pages are in file order (oldest first).
func (h *Handler) collectIndexPage(ctx context.Context, f *os.File, statusFilter, qLower string, lo, hi int) ([][]byte, bool, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, false, err
	}
	var page [][]byte
	var totalBytes int
	truncated := false
	m := 0
	scanner := newTraceScanner(f)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			h.d.Logger.Warn("trace index: skipping malformed line: %v", err)
			continue
		}
		if !matchIndexFilters(record, statusFilter, qLower) {
			continue
		}
		m++
		if m > hi {
			break // past the requested window; nothing newer is needed
		}
		if m < lo {
			continue
		}
		b, err := json.Marshal(h.normalizeTraceRecord(record))
		if err != nil {
			h.d.Logger.Warn("trace index: skipping unmarshalable line: %v", err)
			continue
		}
		if totalBytes+len(b) > maxTraceResponseBytes {
			truncated = true
			break
		}
		page = append(page, b)
		totalBytes += len(b)
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	return page, truncated, nil
}

// writeIndexEnvelope streams the response envelope incrementally instead of
// buffering the full page a second time. The page itself is already bounded by
// the caps enforced during collection.
func writeIndexEnvelope(w http.ResponseWriter, page [][]byte, total int, truncated bool) {
	io.WriteString(w, `{"lines":[`)
	for i, b := range page {
		if i > 0 {
			io.WriteString(w, ",")
		}
		_, _ = w.Write(b)
	}
	io.WriteString(w, "]")
	fmt.Fprintf(w, `,"total":%d`, total)
	if truncated {
		io.WriteString(w, `,"truncated":true`)
	}
	io.WriteString(w, "}")
}

func (h *Handler) getReq(w http.ResponseWriter, r *http.Request) {
	tracesDir := h.d.ProxyHandler.TracesDir()
	w.Header().Set("Content-Type", "application/json")

	if tracesDir == "" {
		apibase.WriteAPIError(w, http.StatusNotFound, "tracing not configured")
		return
	}

	reqID := chi.URLParam(r, "reqID")
	if !sanitizePathParam(reqID) || len(reqID) > maxReqIDLen {
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

	// Stream the file once, keeping at most maxReqDetailLines lines and
	// maxTraceResponseBytes of DTO payload. Chronological order is preserved
	// (request line first, then attempts).
	page, truncated, err := h.collectDetailPage(r.Context(), reqID, f)
	if err != nil {
		// On cancellation the client is gone: drop the handle (deferred) and
		// return without writing anything.
		if r.Context().Err() != nil {
			return
		}
		apibase.WriteAPIError(w, http.StatusInternalServerError, "failed to read request trace file")
		return
	}

	writeReqEnvelope(w, reqID, page, truncated)
}

// collectDetailPage streams a per-request trace file, returning complete
// records in file order. Collection stops early on request cancellation, on the line
// cap, or on the response byte budget (setting truncated).
func (h *Handler) collectDetailPage(ctx context.Context, reqID string, f *os.File) ([][]byte, bool, error) {
	var page [][]byte
	var totalBytes int
	truncated := false
	scanner := newTraceScanner(f)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			h.d.Logger.Warn("trace req %s: skipping malformed line: %v", reqID, err)
			continue
		}
		b, err := json.Marshal(h.normalizeTraceRecord(record))
		if err != nil {
			h.d.Logger.Warn("trace req %s: skipping unmarshalable line: %v", reqID, err)
			continue
		}
		if len(page) >= maxReqDetailLines || totalBytes+len(b) > maxTraceResponseBytes {
			truncated = true
			break
		}
		page = append(page, b)
		totalBytes += len(b)
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	return page, truncated, nil
}

// writeReqEnvelope streams the per-request response envelope incrementally.
func writeReqEnvelope(w http.ResponseWriter, reqID string, page [][]byte, truncated bool) {
	reqIDJSON, _ := json.Marshal(reqID)
	io.WriteString(w, `{"reqID":`)
	_, _ = w.Write(reqIDJSON)
	io.WriteString(w, `,"lines":[`)
	for i, b := range page {
		if i > 0 {
			io.WriteString(w, ",")
		}
		_, _ = w.Write(b)
	}
	io.WriteString(w, "]")
	if truncated {
		io.WriteString(w, `,"truncated":true`)
	}
	io.WriteString(w, "}")
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
