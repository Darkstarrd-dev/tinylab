package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tinylab/tinylab/internal/fsutil"
	"github.com/tinylab/tinylab/internal/logredact"
	"github.com/tinylab/tinylab/internal/rotation"
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
// The provenance string comes from the X-TinyLab-Provenance header.
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
	source := reqHeaders.Get("X-TinyLab-Source")
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
	tw := h.traceBuf()
	tw.enqueue(indexPath, indexLine)

	// Write request line once (on the first recordUsage call for this reqID;
	// count==1 identifies it in-process, replacing the previous os.Stat probe
	// which cannot see lines still held in the flush buffer — F-10).
	reqFilePath := filepath.Join(reqDir, reqID+".jsonl")
	if count == 1 {
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

		tw.enqueue(reqFilePath, requestLine)
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

	tw.enqueue(reqFilePath, attemptLine)
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
	tw := h.traceBuf()
	tw.enqueue(indexPath, indexLine)

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
	tw.enqueue(reqFilePath, requestLine)

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
	tw.enqueue(reqFilePath, attemptLine)
}

// SweepTraces runs the trace retention sweep. It deletes index and request
// files older than retainDays and enforces MaxDiskMB by deleting the oldest
// files when the total traces/ dir size exceeds the cap. Whenever a
// req/<reqID>.jsonl detail file is evicted, the matching lines are also
// removed from every index-*.jsonl file. It runs once immediately, then
// every hour until ctx is cancelled.
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
//
// Evicting a req/<reqID>.jsonl detail file also purges that reqID's lines
// from every index-*.jsonl file. Without that step the index keeps
// advertising requests whose detail file is gone, so the Log Reader lists
// ghost rows whose detail view 404s.
func (h *Handler) SweepTracesOnce(retainDays, maxDiskMB int) {
	tracesDir := h.TracesDir()
	now := time.Now()
	cutoff := now.Add(-time.Duration(retainDays) * 24 * time.Hour)

	// reqIDs whose detail file is removed in this pass (age-based or
	// disk-cap based); their index lines are purged after the deletion
	// phases. Index files deleted in this pass are not recorded here.
	deletedReqIDs := make(map[string]struct{})

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
			deletedReqIDs[fe.reqID] = struct{}{}
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
				deletedReqIDs[fe.reqID] = struct{}{}
			}
		}
	}

	purgeIndexLines(tracesDir, deletedReqIDs)
}

// purgeIndexLines rewrites every tracesDir/index-*.jsonl file that contains a
// line for one of the evicted reqIDs (or a line whose detail file no longer
// exists at all — see filterIndexFile), keeping every other line. Lines that
// do not parse as a JSON object carrying a reqID are preserved verbatim, so a
// sweep can never destroy data it cannot understand. The directory is re-read
// here (rather than reusing the sweep's earlier listing) because index files
// may have been deleted in between.
//
// Files with no matching line are left untouched. A rewritten file gets a
// fresh mtime: that is intentional. The file now reflects the surviving req
// files, and the next disk-cap pass orders candidates by mtime, so a fresh
// mtime keeps a still-useful index from being evicted ahead of the detail
// files it describes.
func purgeIndexLines(tracesDir string, deletedReqIDs map[string]struct{}) {
	entries, err := os.ReadDir(tracesDir)
	if err != nil {
		return
	}
	reqDir := filepath.Join(tracesDir, "req")
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "index-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		path := filepath.Join(tracesDir, name)
		kept, changed, err := filterIndexFile(path, reqDir, deletedReqIDs)
		if err != nil || !changed {
			continue
		}
		_ = fsutil.AtomicWrite(path, kept, 0o644)
	}
}

// traceIndexReconcileGrace keeps an index line whose detail file is missing
// while the line is younger than this: writeRequestLog appends the index line
// before the detail file, so a sweep racing a just-started request could
// otherwise drop the index row of a request whose file is about to appear.
// Evictions (age or disk cap) always target older entries, so the grace costs
// nothing for real ghosts.
const traceIndexReconcileGrace = 10 * time.Minute

// filterIndexFile streams an index file line by line and returns its content
// with the lines whose reqID is in deleted removed, plus lines whose detail
// file req/<reqID>.jsonl no longer exists (and whose timestamp is older than
// traceIndexReconcileGrace) — those are ghosts left by earlier evictions or by
// manual file deletion. changed reports whether at least one line was dropped;
// when it is false the caller must not rewrite the file.
func filterIndexFile(path, reqDir string, deleted map[string]struct{}) (kept []byte, changed bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()

	var buf bytes.Buffer
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if reqID, ok := indexLineReqID(line); ok {
			if _, drop := deleted[reqID]; drop {
				changed = true
				continue
			}
			if indexLineIsGhost(reqDir, reqID, line) {
				changed = true
				continue
			}
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	return buf.Bytes(), changed, nil
}

// indexLineReqID extracts the reqID field from a raw index JSONL line. It
// returns ok=false for blank, non-object, or truncated lines, which callers
// preserve verbatim.
func indexLineReqID(line []byte) (string, bool) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return "", false
	}
	var probe struct {
		ReqID string `json:"reqID"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return "", false
	}
	return probe.ReqID, true
}

// indexLineIsGhost reports whether an index line advertises a request whose
// detail file is gone and is old enough that the missing file cannot be a
// write-order race (index line appended before the detail file).
func indexLineIsGhost(reqDir, reqID string, line []byte) bool {
	if reqID == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(reqDir, reqID+".jsonl")); err == nil {
		return false
	} else if !os.IsNotExist(err) {
		return false // unreadable for another reason: keep the line
	}
	ts, ok := indexLineTS(line)
	if !ok {
		return false // no parsable timestamp: preserve rather than guess
	}
	return time.Since(ts) > traceIndexReconcileGrace
}

// indexLineTS extracts and parses the RFC3339Nano timestamp of a raw index
// line. ok=false for missing or unparsable values.
func indexLineTS(line []byte) (time.Time, bool) {
	var probe struct {
		TS string `json:"ts"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &probe); err != nil || probe.TS == "" {
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339Nano, probe.TS)
	if err != nil {
		return time.Time{}, false
	}
	return ts, true
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
