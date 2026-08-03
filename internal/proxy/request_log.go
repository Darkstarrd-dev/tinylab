package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

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

	// Bound bodies before writing: trace files must not balloon past the ring
	// capture caps (64KB req / 512KB resp), and base64 image payloads are
	// replaced with placeholders so vision requests stay small on disk. The
	// truncation happens HERE, not in the caller: recordUsage truncates only
	// when it stores ring payloads, so the trace writer must not assume its
	// inputs were already bounded.
	reqBody = boundTraceBody(reqBody, 64*1024)
	respBody = boundTraceBody(respBody, 512*1024)

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
		maskedReqHeaders := maskHeaderMap(reqHeaders)

		// Build request body (stripped of base64 images).

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
	maskedRespHeaders := maskHeaderMap(respHeaders)

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

// maskHeaderMap returns a copy of h with secret header values masked.
func maskHeaderMap(h http.Header) map[string][]string {
	if h == nil {
		return nil
	}
	out := make(map[string][]string, len(h))
	for key, values := range h {
		if isSecretHeader(key) {
			masked := make([]string, len(values))
			for i, v := range values {
				masked[i] = maskSecret(v)
			}
			out[key] = masked
		} else {
			out[key] = values
		}
	}
	return out
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

	reqBody = boundTraceBody(reqBody, 64*1024)
	respBody = boundTraceBody(respBody, 512*1024)

	tracesDir := h.TracesDir()
	reqDir := filepath.Join(tracesDir, "req")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		h.logger.Warn("TraceMgmtCall: failed to create req dir %s: %v", reqDir, err)
		return
	}

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
	reqFilePath := filepath.Join(reqDir, reqID+".jsonl")

	maskedReqHeaders := maskHeaderMap(reqHeaders)
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
	maskedRespHeaders := maskHeaderMap(respHeaders)
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
	h.sweepTracesOnce(retainDays, maxDiskMB)

	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sweepTracesOnce(retainDays, maxDiskMB)
		}
	}
}

// sweepTracesOnce performs a single retention sweep pass.
func (h *Handler) sweepTracesOnce(retainDays, maxDiskMB int) {
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

// boundTraceBody caps a body stored in trace JSONL files: base64 image
// payloads are replaced with placeholders first (so a vision request cannot
// bloat the file with megabytes of base64), then the body is truncated to
// maxBytes. Mirrors the ring capture caps (64KB req / 512KB resp).
func boundTraceBody(body []byte, maxBytes int) []byte {
	body = stripBase64Images(body)
	if len(body) > maxBytes {
		body = body[:maxBytes]
	}
	return body
}

// maskSecret masks a secret header value. If the value contains a space
// (e.g. "Bearer <token>"), the scheme is preserved and only the token is
// masked. Otherwise the whole value is masked.
func maskSecret(v string) string {
	if strings.Contains(v, " ") {
		parts := strings.SplitN(v, " ", 2)
		return parts[0] + " " + maskToken(parts[1])
	}
	return maskToken(v)
}

// maskToken masks a token, showing only the last 4 characters for
// debuggability. Tokens of 8 or fewer characters are fully masked.
func maskToken(t string) string {
	if len(t) <= 8 {
		return "***"
	}
	return "***" + t[len(t)-4:]
}

// isSecretHeader reports whether the header key is an API-key header that
// should be masked in request logs.
func isSecretHeader(key string) bool {
	return strings.EqualFold(key, "Authorization") || strings.EqualFold(key, "X-Api-Key")
}

// stripBase64Images walks a JSON tree and replaces base64-encoded image
// payloads with a truncation placeholder. It handles three patterns:
//   - data URLs (data:image/...;base64,<payload>)
//   - b64_json fields
//   - Anthropic image inputs ({"type":"base64","data":"..."})
//
// Only strings longer than 100 bytes are replaced, to avoid touching tiny
// non-image strings. Non-JSON input is returned unchanged.
func stripBase64Images(data []byte) []byte {
	if !json.Valid(data) {
		return data
	}
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return data
	}
	stripBase64InMap(obj)
	out, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return data
	}
	return out
}

// stripBase64InMap recursively walks a JSON value tree and replaces
// base64 image payloads with truncation placeholders.
func stripBase64InMap(m map[string]any) {
	for k, v := range m {
		switch val := v.(type) {
		case string:
			// b64_json key with string value.
			if k == "b64_json" && len(val) > 100 {
				m[k] = "[truncated: " + strconv.Itoa(len(val)) + " bytes]"
				continue
			}
			// Anthropic image input: {"type":"base64","data":"..."}
			// When we encounter a "data" key with a long string value,
			// check if the same map has "type" == "base64".
			if k == "data" && len(val) > 100 {
				if t, ok := m["type"].(string); ok && t == "base64" {
					m[k] = "[truncated: " + strconv.Itoa(len(val)) + " bytes]"
					continue
				}
			}
			// Data URL pattern: data:<mediatype>;base64,<payload>
			if idx := strings.Index(val, ";base64,"); idx > 0 {
				prefix := val[:idx+len(";base64,")]
				payload := val[idx+len(";base64,"):]
				if len(payload) > 100 {
					m[k] = prefix + "[truncated: " + strconv.Itoa(len(payload)) + " bytes]"
				}
			}
		case map[string]any:
			stripBase64InMap(val)
		case []any:
			for _, item := range val {
				if nested, ok := item.(map[string]any); ok {
					stripBase64InMap(nested)
				}
			}
		}
	}
}
