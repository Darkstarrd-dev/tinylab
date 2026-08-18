package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tinyrouter/tinyrouter/internal/logredact"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
)

// traceLine is the JSON structure for every line written to the
// two-tier JSONL trace files.
type traceLine struct {
	Type            string              `json:"type"`
	TS              string              `json:"ts,omitempty"`
	ReqID           string              `json:"reqID,omitempty"`
	Session         string              `json:"session,omitempty"`
	Provenance      string              `json:"provenance,omitempty"`
	Source          string              `json:"source,omitempty"`
	Model           string              `json:"model,omitempty"`
	OriginalModel   string              `json:"originalModel,omitempty"`
	Provider        string              `json:"provider,omitempty"`
	UpstreamURLBase string              `json:"upstreamURLBase,omitempty"`
	UpstreamURL     string              `json:"upstreamURL,omitempty"`
	ReqHeaders      map[string][]string `json:"reqHeaders,omitempty"`
	ReqBody         any                 `json:"reqBody,omitempty"`
	SentAt          string              `json:"sentAt,omitempty"`
	RespStatus      int                 `json:"respStatus,omitempty"`
	RespHeaders     map[string][]string `json:"respHeaders,omitempty"`
	RespBody        any                 `json:"respBody,omitempty"`
	Error           string              `json:"error,omitempty"`
	Decision        string              `json:"decision,omitempty"`
	LatencyMs       int64               `json:"latencyMs,omitempty"`
	TTFTms          int64               `json:"ttftMs,omitempty"`
	Attempts        int                 `json:"attempts,omitempty"`
	FinalKey        string              `json:"finalKey,omitempty"`
	FinalKeyName    string              `json:"finalKeyName,omitempty"`
	InputTokens     int                 `json:"inputTokens,omitempty"`
	OutputTokens    int                 `json:"outputTokens,omitempty"`
	HTTPStatus      int                 `json:"httpStatus,omitempty"`
	Status          string              `json:"status,omitempty"`
	N               int                 `json:"n,omitempty"`
	Key             string              `json:"key,omitempty"`
	KeyName         string              `json:"keyName,omitempty"`
}

// writeRequestLog writes per-request trace data to the two-tier JSONL
// format: an index line in traces/index-YYYYMMDD.jsonl (daily-rotated)
// and attempt lines in traces/req/<reqID>.jsonl (append-only).
//
// The index line is written/overwritten on every recordUsage call for
// that reqID (last-write-wins on read). The request line is written
// once (on the first call for this reqID). Attempt lines are appended
// on every call.
//
// The decision string describes what the retry state machine did
// (e.g. "success", "backoff 2s, switch key", "daily quota lock").
// The provenance string comes from the X-TinyRouter-Provenance header.
//
// This method never panics or affects the request path.
func (h *Handler) writeRequestLog(reqID, provider, model string, sel *rotation.SelectedKey, status string, latencyMs, ttftMs int64, inputTokens, outputTokens int, errMsg string, reqBody, respBody []byte, respHeaders http.Header, respStatus int, reqHeaders http.Header, upstreamURL, originalModel, sessionKey, decision, provenance string) {
	defer func() {
		if r := recover(); r != nil {
			h.logger.Warn("writeRequestLog panic recovered: %v", r)
		}
	}()

	if h.TracesDir() == "" || !h.logRequests() {
		return
	}

	credential := ""
	if sel != nil {
		credential = sel.Key.Key
	}
	reqBody = []byte(logredact.MaskString(string(reqBody), credential))
	respBody = []byte(logredact.MaskString(string(respBody), credential))
	upstreamURL = redactURL(upstreamURL, credential)

	// Compute source from headers and provenance.
	source := reqHeaders.Get("X-TinyRouter-Source")
	if source == "" {
		if provenance != "" {
			if idx := strings.Index(provenance, ":"); idx > 0 {
				source = provenance[:idx]
			} else {
				source = provenance
			}
		} else {
			source = "client"
		}
	}

	// Determine session ID for the index line.
	sessionID := sessionKey
	if sessionID == "" {
		sessionID = reqID
	}

	// Ensure directories exist.
	tracesDir := h.TracesDir()
	reqDir := filepath.Join(tracesDir, "req")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		h.logger.Warn("writeRequestLog: failed to create req dir %s: %v", reqDir, err)
		return
	}

	now := time.Now()
	ts := now.Format(time.RFC3339Nano)
	dateStr := now.Format("20060102")
	count := h.incAttemptCount(reqID)
	// Build the index line.
	indexLine := traceLine{
		Type:            "index",
		TS:              ts,
		ReqID:           reqID,
		Session:         sessionID,
		Provenance:      provenance,
		Source:          source,
		Model:           model,
		OriginalModel:   originalModel,
		Provider:        provider,
		UpstreamURLBase: upstreamURL,
		Status:          status,
		HTTPStatus:      respStatus,
		LatencyMs:       latencyMs,
		TTFTms:          ttftMs,
		Attempts:        count,
		FinalKey:        sel.Key.ID,
		FinalKeyName:    sel.KeyName,
		InputTokens:     inputTokens,
		OutputTokens:    outputTokens,
		Error:           errMsg,
		Decision:        decision,
	}

	// Write index line to index-YYYYMMDD.jsonl (append).
	indexPath := filepath.Join(tracesDir, "index-"+dateStr+".jsonl")
	if err := appendJSONLine(indexPath, indexLine); err != nil {
		h.logger.Warn("writeRequestLog: failed to append index line: %v", err)
	}

	// Write request line once (on first call for this reqID).
	reqFilePath := filepath.Join(reqDir, reqID+".jsonl")
	if _, err := os.Stat(reqFilePath); os.IsNotExist(err) {
		// Build masked request headers.
		maskedReqHeaders := h.maskHeaderMap(reqHeaders, credential)

		// Build the complete request body.

		requestLine := traceLine{
			Type:            "request",
			TS:              ts,
			ReqID:           reqID,
			Session:         sessionID,
			Provenance:      provenance,
			Source:          source,
			Model:           model,
			OriginalModel:   originalModel,
			Provider:        provider,
			UpstreamURLBase: upstreamURL,
			ReqHeaders:      maskedReqHeaders,
			ReqBody:         parseBodyForJSON(reqBody),
			LatencyMs:       latencyMs,
			TTFTms:          ttftMs,
			InputTokens:     inputTokens,
			OutputTokens:    outputTokens,
		}

		if err := appendJSONLine(reqFilePath, requestLine); err != nil {
			h.logger.Warn("writeRequestLog: failed to write request line: %v", err)
		}
	}

	// Build attempt line.
	maskedRespHeaders := h.maskHeaderMap(respHeaders, credential)

	attemptLine := traceLine{
		Type:          "attempt",
		TS:            ts,
		ReqID:         reqID,
		Session:       sessionID,
		Provenance:    provenance,
		Source:        source,
		Model:         model,
		OriginalModel: originalModel,
		Provider:      provider,
		UpstreamURL:   upstreamURL,
		SentAt:        ts,
		RespStatus:    respStatus,
		RespHeaders:   maskedRespHeaders,
		RespBody:      parseBodyForJSON(respBody),
		Error:         errMsg,
		Decision:      decision,
		LatencyMs:     latencyMs,
		TTFTms:        ttftMs,
		InputTokens:   inputTokens,
		OutputTokens:  outputTokens,
		N:             count,
		Key:           sel.Key.ID,
		KeyName:       sel.KeyName,
	}

	if err := appendJSONLine(reqFilePath, attemptLine); err != nil {
		h.logger.Warn("writeRequestLog: failed to append attempt line: %v", err)
	}
}

// appendJSONLine appends a JSON-encoded line to the file at path.
// It creates the file if it does not exist. Partial last lines are
// tolerated (debug data).
func appendJSONLine(path string, line any) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	data, err := json.Marshal(line)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = f.Write(data)
	return err
}

// parseBodyForJSON returns the body as a parsed JSON value if it is
// valid JSON, or as a raw string otherwise. This allows the trace
// writer to embed structured bodies in the JSONL output.
func parseBodyForJSON(body []byte) any {
	if len(body) == 0 {
		return nil
	}
	var obj any
	if err := json.Unmarshal(body, &obj); err == nil {
		return obj
	}
	return string(body)
}

// maskHeaderMap returns a copy of headers with credential values masked while
// preserving ordinary headers and custom-header values.
func (h *Handler) maskHeaderMap(headers http.Header, credential string) map[string][]string {
	return logredact.MaskHeaderMap(headers, credential)
}

func redactURL(raw, credential string) string {
	return logredact.MaskURL(raw, credential)
}

func credentialFromHeaders(headers http.Header) string {
	for name, values := range headers {
		if !logredact.IsKeyHeader(name) || len(values) == 0 {
			continue
		}
		value := strings.TrimSpace(values[0])
		if idx := strings.IndexAny(value, " \t"); idx > 0 {
			value = strings.TrimSpace(value[idx+1:])
		}
		if value != "" && value != logredact.MaskedValue && !strings.HasPrefix(value, "***") {
			return value
		}
	}
	return ""
}

// attemptCounter tracks the number of recordUsage calls per reqID.
// Used to number attempt lines and compute the attempts count in the index line.
// Entries are removed by SweepTraces when the corresponding req file is
// deleted, so the map does not grow unbounded across requests.
var attemptCounter sync.Map // string (reqID) -> int

func (h *Handler) incAttemptCount(reqID string) int {
	v, _ := attemptCounter.LoadOrStore(reqID, 0)
	count := v.(int) + 1
	attemptCounter.Store(reqID, count)
	return count
}

func (h *Handler) clearAttemptCount(reqID string) {
	if reqID != "" {
		attemptCounter.Delete(reqID)
	}
}

// TraceMgmtCall records a lightweight trace entry for a management probe
// call (e.g. key probe, model fetch, combo speed test) that bypasses the
// normal proxy handler stack. label is a human-readable description of the
// call (e.g. "probe:combo:provider=X:model=Y:key=Z") preserved as the
// provenance value; a clean filesystem-safe unique reqID is generated
// internally for the trace filename, since label may contain colons which
// are illegal in Windows filenames. The provenance param is a legacy
// generic tag ("probe") superseded by label and is not stored. It writes
// the same index + detail JSONL format as writeRequestLog but with a single
// attempt (n=1) and decision="management probe". Like writeRequestLog it
// never panics.
func (h *Handler) TraceMgmtCall(label, provenance, source, model, provider, upstreamURL string, reqHeaders http.Header, reqBody []byte, respStatus int, respHeaders http.Header, respBody []byte, errMsg string, latencyMs int64) {
	defer func() {
		if r := recover(); r != nil {
			h.logger.Warn("TraceMgmtCall panic recovered: %v", r)
		}
	}()

	if h.TracesDir() == "" || !h.logRequests() {
		return
	}

	// Generate a clean filesystem-safe unique id for the filename; the
	// caller's descriptive label (may contain colons) is preserved as the
	// provenance field, not used as the filename.
	reqID := generateRequestID()
	now := time.Now()
	ts := now.Format(time.RFC3339Nano)
	dateStr := now.Format("20060102")
	sessionID := reqID
	credential := credentialFromHeaders(reqHeaders)
	errMsg = logredact.MaskString(errMsg, credential)
	label = logredact.MaskString(label, credential)
	reqBody = []byte(logredact.MaskString(string(reqBody), credential))
	respBody = []byte(logredact.MaskString(string(respBody), credential))
	upstreamURL = redactURL(upstreamURL, credential)

	tracesDir := h.TracesDir()
	reqDir := filepath.Join(tracesDir, "req")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		h.logger.Warn("TraceMgmtCall: failed to create req dir %s: %v", reqDir, err)
		return
	}
	reqFilePath := filepath.Join(reqDir, reqID+".jsonl")

	// Index line.
	indexLine := traceLine{
		Type:            "index",
		TS:              ts,
		ReqID:           reqID,
		Session:         sessionID,
		Provenance:      label,
		Source:          source,
		Model:           model,
		Provider:        provider,
		UpstreamURLBase: upstreamURL,
		Status:          "success",
		HTTPStatus:      respStatus,
		LatencyMs:       latencyMs,
		Attempts:        1,
		Error:           errMsg,
		Decision:        "management probe",
	}

	indexPath := filepath.Join(tracesDir, "index-"+dateStr+".jsonl")
	_ = appendJSONLine(indexPath, indexLine)

	// Request line.
	maskedReqHeaders := h.maskHeaderMap(reqHeaders, credential)
	requestLine := traceLine{
		Type:            "request",
		TS:              ts,
		ReqID:           reqID,
		Session:         sessionID,
		Provenance:      label,
		Source:          source,
		Model:           model,
		Provider:        provider,
		UpstreamURLBase: upstreamURL,
		ReqHeaders:      maskedReqHeaders,
		ReqBody:         parseBodyForJSON(reqBody),
		LatencyMs:       latencyMs,
	}
	_ = appendJSONLine(reqFilePath, requestLine)

	// Attempt line.
	maskedRespHeaders := h.maskHeaderMap(respHeaders, credential)
	attemptLine := traceLine{
		Type:        "attempt",
		TS:          ts,
		ReqID:       reqID,
		Session:     sessionID,
		Provenance:  label,
		Source:      source,
		Model:       model,
		Provider:    provider,
		UpstreamURL: upstreamURL,
		SentAt:      ts,
		RespStatus:  respStatus,
		RespHeaders: maskedRespHeaders,
		RespBody:    parseBodyForJSON(respBody),
		Error:       errMsg,
		Decision:    "management probe",
		LatencyMs:   latencyMs,
		N:           1,
	}
	_ = appendJSONLine(reqFilePath, attemptLine)
}

// SweepTraces runs the trace retention sweep. It deletes index and request
// files older than retainDays and enforces MaxDiskMB by deleting the oldest
// request files when the total traces/ dir size exceeds the cap. It runs
// once immediately, then every hour until ctx is cancelled.
func (h *Handler) SweepTraces(ctx context.Context, retainDays, maxDiskMB int) {
	if h.TracesDir() == "" {
		return
	}

	// Run once immediately.
	h.SweepTracesOnce(retainDays, maxDiskMB)

	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.SweepTracesOnce(retainDays, maxDiskMB)
		}
	}
}

// SweepTracesOnce performs a single retention sweep pass.
func (h *Handler) SweepTracesOnce(retainDays, maxDiskMB int) {
	tracesDir := h.TracesDir()
	now := time.Now()
	cutoff := now.Add(-time.Duration(retainDays) * 24 * time.Hour)

	type fileEntry struct {
		path    string
		modTime time.Time
		size    int64
		reqID   string // base file name for req files; used for attemptCounter cleanup
	}

	var allFiles []fileEntry
	var totalSize int64

	// Collect index files (age-delete here; disk-cap enforcement below covers
	// them too, so MaxDiskMB bounds the whole traces/ tree, not just req/).
	entries, err := os.ReadDir(tracesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "index-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		fe := fileEntry{path: filepath.Join(tracesDir, name), modTime: info.ModTime(), size: info.Size()}
		allFiles = append(allFiles, fe)
		totalSize += info.Size()
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(fe.path)
		}
	}

	// Collect request files.
	reqDir := filepath.Join(tracesDir, "req")
	reqEntries, err := os.ReadDir(reqDir)
	if err != nil {
		return
	}
	for _, e := range reqEntries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		fe := fileEntry{
			path:    filepath.Join(reqDir, e.Name()),
			modTime: info.ModTime(),
			size:    info.Size(),
			reqID:   strings.TrimSuffix(e.Name(), ".jsonl"),
		}
		allFiles = append(allFiles, fe)
		totalSize += info.Size()
	}

	// Delete old request files (by modtime), dropping their attempt counters.
	for _, fe := range allFiles {
		if fe.reqID != "" && fe.modTime.Before(cutoff) {
			_ = os.Remove(fe.path)
			attemptCounter.Delete(fe.reqID)
		}
	}

	// Enforce MaxDiskMB across req AND index files: delete the oldest files
	// until the total traces/ size is under the cap.
	if maxDiskMB > 0 && totalSize > int64(maxDiskMB)*1024*1024 {
		var remaining []fileEntry
		var remainingSize int64
		for _, fe := range allFiles {
			if _, err := os.Stat(fe.path); err != nil {
				continue // already removed by age-based deletion
			}
			remainingSize += fe.size
			remaining = append(remaining, fe)
		}

		// Sort by modtime (oldest first).
		sort.Slice(remaining, func(i, j int) bool {
			return remaining[i].modTime.Before(remaining[j].modTime)
		})

		for _, fe := range remaining {
			if remainingSize <= int64(maxDiskMB)*1024*1024 {
				break
			}
			_ = os.Remove(fe.path)
			remainingSize -= fe.size
			if fe.reqID != "" {
				attemptCounter.Delete(fe.reqID)
			}
		}
	}
}

// maskSecret masks a secret header value. If the value contains a space
// (e.g. "Bearer <token>"), the scheme is preserved and only the token is
// masked. Otherwise the whole value is masked.
func maskSecret(v string) string {
	if idx := strings.IndexAny(v, " \t"); idx > 0 {
		return v[:idx+1] + logredact.MaskedValue
	}
	return logredact.MaskedValue
}
