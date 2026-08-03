package proxy

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
)

func TestStripBase64Images_DataURL(t *testing.T) {
	input := `{"image": "data:image/png;base64,` + strings.Repeat("A", 200) + `"}`
	result := stripBase64Images([]byte(input))
	if !json.Valid(result) {
		t.Fatalf("result is not valid JSON: %s", result)
	}
	var obj map[string]any
	if err := json.Unmarshal(result, &obj); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	img := obj["image"].(string)
	if !strings.Contains(img, "[truncated: 200 bytes]") {
		t.Errorf("expected truncation placeholder, got: %s", img)
	}
	if !strings.HasPrefix(img, "data:image/png;base64,") {
		t.Errorf("expected data URL prefix preserved, got: %s", img)
	}
}

func TestStripBase64Images_b64_json(t *testing.T) {
	input := `{"b64_json": "` + strings.Repeat("B", 200) + `"}`
	result := stripBase64Images([]byte(input))
	var obj map[string]any
	json.Unmarshal(result, &obj)
	b64 := obj["b64_json"].(string)
	if !strings.Contains(b64, "[truncated: 200 bytes]") {
		t.Errorf("expected truncation placeholder for b64_json, got: %s", b64)
	}
}

func TestStripBase64Images_AnthropicBase64(t *testing.T) {
	input := `{"source": {"type": "base64", "data": "` + strings.Repeat("C", 200) + `"}}`
	result := stripBase64Images([]byte(input))
	var obj map[string]any
	json.Unmarshal(result, &obj)
	source := obj["source"].(map[string]any)
	data := source["data"].(string)
	if !strings.Contains(data, "[truncated: 200 bytes]") {
		t.Errorf("expected truncation placeholder for Anthropic data, got: %s", data)
	}
}

func TestStripBase64Images_ShortStringUntouched(t *testing.T) {
	input := `{"short": "data:image/png;base64,abc"}`
	result := stripBase64Images([]byte(input))
	var obj map[string]any
	json.Unmarshal(result, &obj)
	short := obj["short"].(string)
	if short != "data:image/png;base64,abc" {
		t.Errorf("expected short string untouched, got: %s", short)
	}
}

func TestStripBase64Images_NonJSON(t *testing.T) {
	input := []byte("not json at all")
	result := stripBase64Images(input)
	if string(result) != "not json at all" {
		t.Errorf("expected non-JSON input returned unchanged")
	}
}

func TestMaskSecret_Bearer(t *testing.T) {
	result := maskSecret("Bearer sk-abcdefghijklmnopqrstuvwxyz")
	if result != "Bearer ***wxyz" {
		t.Errorf("expected 'Bearer ***wxyz', got: %s", result)
	}
}

func TestMaskSecret_ShortToken(t *testing.T) {
	result := maskSecret("sk-short")
	if result != "***" {
		t.Errorf("expected '***' for short token, got: %s", result)
	}
}

func TestMaskSecret_NoSpace(t *testing.T) {
	result := maskSecret("sk-abcdefghijklmnopqrstuvwxyz")
	if result != "***wxyz" {
		t.Errorf("expected '***wxyz', got: %s", result)
	}
}

// --- JSONL format tests ---

func newTestHandlerForTrace(t *testing.T) (*Handler, string) {
	t.Helper()
	tmpDir := t.TempDir()
	logger := console.New(100)
	h := New(nil, nil, nil, nil, nil, logger, 0)
	h.SetLogRequestsProvider(func() bool { return true })
	h.SetRequestLogDir(tmpDir)
	return h, tmpDir
}

func readJSONLLines(path string) ([]map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			return nil, err
		}
		lines = append(lines, obj)
	}
	return lines, nil
}

// findLastIndexLine returns the last index line matching the given reqID.
func findLastIndexLine(lines []map[string]any, reqID string) (map[string]any, bool) {
	var last map[string]any
	found := false
	for _, line := range lines {
		if line["type"] == "index" && line["reqID"] == reqID {
			last = line
			found = true
		}
	}
	return last, found
}

func findLinesByType(lines []map[string]any, typ string) []map[string]any {
	var result []map[string]any
	for _, line := range lines {
		if line["type"] == typ {
			result = append(result, line)
		}
	}
	return result
}

func TestWriteRequestLog_JSONL(t *testing.T) {
	h, tmpDir := newTestHandlerForTrace(t)

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider"},
		Key:      config.Key{ID: "key1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
	reqHeaders := http.Header{}
	reqHeaders.Set("Authorization", "Bearer sk-abcdefghijklmnopqrstuvwxyz")
	reqHeaders.Set("Content-Type", "application/json")

	respHeaders := http.Header{}
	respHeaders.Set("Content-Type", "application/json")

	reqBody := []byte(`{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}`)
	respBody := []byte(`{"id":"chatcmpl-123","choices":[{"message":{"content":"Hi there"}}]}`)

	h.writeRequestLog(
		"req-abc-123",
		"openai",
		"gpt-4",
		sel,
		"success",
		150,
		50,
		10,
		5,
		"",
		reqBody,
		respBody,
		respHeaders,
		200,
		reqHeaders,
		"http://localhost:8080/v1/chat/completions",
		"gpt-4",
		"session123",
		"success",
		"textreview:clean",
	)

	// Find the index file.
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatalf("failed to read log dir: %v", err)
	}
	var indexFile string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "index-") && strings.HasSuffix(e.Name(), ".jsonl") {
			indexFile = filepath.Join(tmpDir, e.Name())
			break
		}
	}
	if indexFile == "" {
		t.Fatal("expected index-*.jsonl file to exist")
	}

	indexLines, err := readJSONLLines(indexFile)
	if err != nil {
		t.Fatalf("failed to parse index file: %v", err)
	}
	idxLine, found := findLastIndexLine(indexLines, "req-abc-123")
	if !found {
		t.Fatalf("expected index line with reqID=req-abc-123, got: %v", indexLines)
	}
	if idxLine["type"] != "index" {
		t.Errorf("expected type=index, got: %v", idxLine["type"])
	}
	if idxLine["status"] != "success" {
		t.Errorf("expected status=success, got: %v", idxLine["status"])
	}
	if idxLine["decision"] != "success" {
		t.Errorf("expected decision=success, got: %v", idxLine["decision"])
	}
	if idxLine["attempts"] != float64(1) {
		t.Errorf("expected attempts=1, got: %v", idxLine["attempts"])
	}
	if idxLine["finalKey"] != "key1" {
		t.Errorf("expected finalKey=key1, got: %v", idxLine["finalKey"])
	}
	if idxLine["provider"] != "openai" {
		t.Errorf("expected provider=openai, got: %v", idxLine["provider"])
	}

	// Check the req file.
	reqFilePath := filepath.Join(tmpDir, "req", "req-abc-123.jsonl")
	reqLines, err := readJSONLLines(reqFilePath)
	if err != nil {
		t.Fatalf("failed to parse req file: %v", err)
	}

	requestLines := findLinesByType(reqLines, "request")
	if len(requestLines) != 1 {
		t.Fatalf("expected 1 request line, got: %d", len(requestLines))
	}
	reqLine := requestLines[0]
	reqHeadersRaw, ok := reqLine["reqHeaders"].(map[string]any)
	if !ok {
		t.Fatalf("expected reqHeaders to be map[string]any, got: %T", reqLine["reqHeaders"])
	}
	authRaw, ok := reqHeadersRaw["Authorization"].([]any)
	if !ok {
		t.Fatalf("expected Authorization to be []any, got: %T", reqHeadersRaw["Authorization"])
	}
	if len(authRaw) != 1 || authRaw[0] != "Bearer ***wxyz" {
		t.Errorf("expected masked Authorization header, got: %v", authRaw)
	}
	ctRaw, ok := reqHeadersRaw["Content-Type"].([]any)
	if !ok {
		t.Fatalf("expected Content-Type to be []any, got: %T", reqHeadersRaw["Content-Type"])
	}
	if len(ctRaw) != 1 || ctRaw[0] != "application/json" {
		t.Errorf("expected preserved Content-Type header, got: %v", ctRaw)
	}

	attemptLines := findLinesByType(reqLines, "attempt")
	if len(attemptLines) != 1 {
		t.Fatalf("expected 1 attempt line, got: %d", len(attemptLines))
	}
	attemptLine := attemptLines[0]
	if attemptLine["type"] != "attempt" {
		t.Errorf("expected type=attempt, got: %v", attemptLine["type"])
	}
	if attemptLine["n"] != float64(1) {
		t.Errorf("expected n=1, got: %v", attemptLine["n"])
	}
	if attemptLine["decision"] != "success" {
		t.Errorf("expected decision=success, got: %v", attemptLine["decision"])
	}
	respBodyOut, ok := attemptLine["respBody"].(map[string]any)
	if !ok {
		t.Fatalf("expected respBody to be map[string]any, got: %T", attemptLine["respBody"])
	}
	if respBodyOut["id"] != "chatcmpl-123" {
		t.Errorf("expected respBody.id=chatcmpl-123, got: %v", respBodyOut["id"])
	}
}

func TestWriteRequestLog_AppendSecondAttempt(t *testing.T) {
	h, tmpDir := newTestHandlerForTrace(t)

	sel := &rotation.SelectedKey{
		Provider: config.Provider{ID: "test", Name: "Test Provider"},
		Key:      config.Key{ID: "key1", Key: "sk-1", Name: "K1"},
		KeyName:  "K1",
	}
	reqHeaders := http.Header{}
	reqHeaders.Set("Authorization", "Bearer sk-abcdefghijklmnopqrstuvwxyz")
	reqHeaders.Set("Content-Type", "application/json")

	respHeaders := http.Header{}
	respHeaders.Set("Content-Type", "application/json")

	reqBody := []byte(`{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}`)
	respBody := []byte(`{"id":"chatcmpl-123","choices":[{"message":{"content":"Hi there"}}]}`)

	// First call.
	h.writeRequestLog(
		"req-append-1",
		"openai",
		"gpt-4",
		sel,
		"success",
		150,
		50,
		10,
		5,
		"",
		reqBody,
		respBody,
		respHeaders,
		200,
		reqHeaders,
		"http://localhost:8080/v1/chat/completions",
		"gpt-4",
		"session123",
		"success",
		"textreview:clean",
	)

	// Second call with same reqID.
	h.writeRequestLog(
		"req-append-1",
		"openai",
		"gpt-4",
		sel,
		"error",
		200,
		60,
		10,
		5,
		"upstream error",
		reqBody,
		nil,
		respHeaders,
		502,
		reqHeaders,
		"http://localhost:8080/v1/chat/completions",
		"gpt-4",
		"session123",
		"upstream error",
		"textreview:clean",
	)

	reqFilePath := filepath.Join(tmpDir, "req", "req-append-1.jsonl")
	reqLines, err := readJSONLLines(reqFilePath)
	if err != nil {
		t.Fatalf("failed to parse req file: %v", err)
	}

	requestLines := findLinesByType(reqLines, "request")
	if len(requestLines) != 1 {
		t.Fatalf("expected 1 request line (not duplicated), got: %d", len(requestLines))
	}

	attemptLines := findLinesByType(reqLines, "attempt")
	if len(attemptLines) != 2 {
		t.Fatalf("expected 2 attempt lines, got: %d", len(attemptLines))
	}
	if attemptLines[0]["n"] != float64(1) {
		t.Errorf("expected first attempt n=1, got: %v", attemptLines[0]["n"])
	}
	if attemptLines[1]["n"] != float64(2) {
		t.Errorf("expected second attempt n=2, got: %v", attemptLines[1]["n"])
	}
	if attemptLines[1]["error"] != "upstream error" {
		t.Errorf("expected error=upstream error, got: %v", attemptLines[1]["error"])
	}

	// Check index file has attempts=2 in the latest entry.
	entries, _ := os.ReadDir(tmpDir)
	var indexFile string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "index-") && strings.HasSuffix(e.Name(), ".jsonl") {
			indexFile = filepath.Join(tmpDir, e.Name())
			break
		}
	}
	indexLines, _ := readJSONLLines(indexFile)
	idxLine, found := findLastIndexLine(indexLines, "req-append-1")
	if !found {
		t.Fatal("expected index line for req-append-1")
	}
	if idxLine["attempts"] != float64(2) {
		t.Errorf("expected attempts=2 in index, got: %v", idxLine["attempts"])
	}
}

func TestTraceMgmtCall(t *testing.T) {
	h, tmpDir := newTestHandlerForTrace(t)

	reqHeaders := http.Header{}
	reqHeaders.Set("Authorization", "Bearer sk-abcdefghijklmnopqrstuvwxyz")
	reqHeaders.Set("Content-Type", "application/json")

	respHeaders := http.Header{}
	respHeaders.Set("Content-Type", "application/json")

	reqBody := []byte(`{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}`)
	respBody := []byte(`{"id":"chatcmpl-123","choices":[{"message":{"content":"Hi there"}}]}`)

	// Use a label with colons to verify the filename is sanitized to a
	// generated clean id. Regression: the old implementation used the label
	// directly as the filename, and colons are illegal in Windows filenames,
	// silently dropping all management-probe trace data.
	label := "probe:test:provider=openai:model=gpt-4"
	h.TraceMgmtCall(
		label,
		"probe",
		"probe",
		"gpt-4",
		"openai",
		"http://localhost:8080/v1/chat/completions",
		reqHeaders,
		reqBody,
		200,
		respHeaders,
		respBody,
		"",
		100,
	)

	// Find index file.
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		t.Fatalf("failed to read log dir: %v", err)
	}
	var indexFile string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "index-") && strings.HasSuffix(e.Name(), ".jsonl") {
			indexFile = filepath.Join(tmpDir, e.Name())
			break
		}
	}
	if indexFile == "" {
		t.Fatal("expected index-*.jsonl file to exist")
	}

	indexLines, err := readJSONLLines(indexFile)
	if err != nil {
		t.Fatalf("failed to parse index file: %v", err)
	}

	// The req file is named by a generated id (not the colon-laden label).
	// Discover it by listing the req/ dir.
	reqDir := filepath.Join(tmpDir, "req")
	reqEntries, err := os.ReadDir(reqDir)
	if err != nil {
		t.Fatalf("failed to read req dir: %v", err)
	}
	if len(reqEntries) != 1 {
		t.Fatalf("expected 1 req file, got %d", len(reqEntries))
	}
	genReqID := strings.TrimSuffix(reqEntries[0].Name(), ".jsonl")

	// The index line's reqID must match the generated filename stem, and its
	// provenance must carry the descriptive label (not the generic "probe").
	idxLine, found := findLastIndexLine(indexLines, genReqID)
	if !found {
		t.Fatalf("expected index line with reqID=%s, got: %v", genReqID, indexLines)
	}
	if idxLine["type"] != "index" {
		t.Errorf("expected type=index, got: %v", idxLine["type"])
	}
	if idxLine["provenance"] != label {
		t.Errorf("expected provenance=%s, got: %v", label, idxLine["provenance"])
	}
	if idxLine["decision"] != "management probe" {
		t.Errorf("expected decision=management probe, got: %v", idxLine["decision"])
	}
	if idxLine["attempts"] != float64(1) {
		t.Errorf("expected attempts=1, got: %v", idxLine["attempts"])
	}

	// Check req file by the generated name.
	reqFilePath := filepath.Join(reqDir, reqEntries[0].Name())
	reqLines, err := readJSONLLines(reqFilePath)
	if err != nil {
		t.Fatalf("failed to parse req file: %v", err)
	}

	requestLines := findLinesByType(reqLines, "request")
	if len(requestLines) != 1 {
		t.Fatalf("expected 1 request line, got: %d", len(requestLines))
	}
	if requestLines[0]["provenance"] != label {
		t.Errorf("expected request provenance=%s, got: %v", label, requestLines[0]["provenance"])
	}

	attemptLines := findLinesByType(reqLines, "attempt")
	if len(attemptLines) != 1 {
		t.Fatalf("expected 1 attempt line, got: %d", len(attemptLines))
	}
	if attemptLines[0]["decision"] != "management probe" {
		t.Errorf("expected decision=management probe, got: %v", attemptLines[0]["decision"])
	}
	if attemptLines[0]["n"] != float64(1) {
		t.Errorf("expected n=1, got: %v", attemptLines[0]["n"])
	}
	if attemptLines[0]["provenance"] != label {
		t.Errorf("expected attempt provenance=%s, got: %v", label, attemptLines[0]["provenance"])
	}
}

func TestWriteRequestLog_EmptyDir(t *testing.T) {
	logger := console.New(100)
	h := New(nil, nil, nil, nil, nil, logger, 0)
	h.SetLogRequestsProvider(func() bool { return true })
	// requestLogDir is empty — should do nothing without error.
	h.writeRequestLog(
		"req-abc", "openai", "gpt-4", nil, "success", 100, 50,
		10, 5, "", []byte("body"), []byte("resp"), nil, 200, nil,
		"http://localhost", "gpt-4", "", "success", "",
	)
	// No panic = success.
}
