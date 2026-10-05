package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tinylab/tinylab/internal/combo"
	"github.com/tinylab/tinylab/internal/config"
	"github.com/tinylab/tinylab/internal/console"
	"github.com/tinylab/tinylab/internal/registry"
	"github.com/tinylab/tinylab/internal/rotation"
	"github.com/tinylab/tinylab/internal/usage"
)

// F-06 regression: bodies retained in the in-memory observability surfaces
// (usage rings, EntryTracker) are capped at maxCapturedBodyBytes, and the
// streaming capture buffer no longer accumulates the full upstream body.

func TestCaptureBody_UnderCapPassthrough(t *testing.T) {
	body := []byte(`{"choices":[{"message":{"content":"hello"}}]}`)
	got := captureBody(body)
	if string(got) != string(body) {
		t.Fatalf("valid JSON under cap must pass through unchanged, got %q", got)
	}

	raw := captureBody([]byte("not json"))
	var wrapper map[string]string
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		t.Fatalf("non-JSON body must be wrapped as valid JSON: %v", err)
	}
	if wrapper["raw"] != "not json" || len(wrapper) != 1 {
		t.Fatalf("non-JSON wrapper must be exactly {raw: ...}, got %v", wrapper)
	}
}

func TestCaptureBody_OverCapTruncates(t *testing.T) {
	// A valid-JSON body over the cap is truncated and wrapped; the result must
	// itself be valid JSON carrying the marker.
	big := []byte(`{"d":"` + strings.Repeat("a", maxCapturedBodyBytes*2) + `"}`)
	got := captureBody(big)
	if !json.Valid(got) {
		t.Fatal("truncated capture must remain valid JSON")
	}
	var wrapper struct {
		Raw            string `json:"raw"`
		Truncated      bool   `json:"truncated"`
		TruncatedBytes int64  `json:"truncatedBytes"`
		TotalBytes     int64  `json:"totalBytes"`
	}
	if err := json.Unmarshal(got, &wrapper); err != nil {
		t.Fatalf("unmarshal truncation wrapper: %v", err)
	}
	if !wrapper.Truncated {
		t.Fatal("truncated flag must be set")
	}
	if wrapper.TotalBytes != int64(len(big)) {
		t.Fatalf("totalBytes = %d, want %d", wrapper.TotalBytes, len(big))
	}
	if wrapper.TruncatedBytes != int64(len(big)-maxCapturedBodyBytes) {
		t.Fatalf("truncatedBytes = %d, want %d", wrapper.TruncatedBytes, len(big)-maxCapturedBodyBytes)
	}
	if len(wrapper.Raw) != maxCapturedBodyBytes {
		t.Fatalf("retained head = %d bytes, want %d", len(wrapper.Raw), maxCapturedBodyBytes)
	}
}

func TestCaptureBody_MaskingRunsBeforeTruncation(t *testing.T) {
	// A body that exceeds the cap only because of an embedded base64 image
	// must be masked down under the cap first — not truncated.
	b64 := strings.Repeat("QUJD", maxCapturedBodyBytes/2) // 2*cap bytes of base64
	body := []byte(`{"data":[{"b64_json":"` + b64 + `"}]}`)
	got := captureBody(body)
	var parsed map[string]any
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("masked image body must stay unwrapped valid JSON: %v", err)
	}
	if _, ok := parsed["truncated"]; ok {
		t.Fatal("body under cap after masking must not be truncated")
	}
	if !strings.Contains(string(got), "[image omitted:") {
		t.Fatalf("expected b64_json masking placeholder, got %q", got)
	}
}

func TestCappedBodyBuffer(t *testing.T) {
	b := newCappedBodyBuffer(16)
	if n, _ := b.Write([]byte("0123456789")); n != 10 {
		t.Fatalf("Write must report full input length, got %d", n)
	}
	if b.Truncated() {
		t.Fatal("under cap must not report truncation")
	}
	if n, _ := b.Write([]byte("0123456789abcdefTAIL")); n != 20 {
		t.Fatalf("Write must report full input length even when discarding, got %d", n)
	}
	if got := string(b.Bytes()); got != "0123456789012345" {
		t.Fatalf("retained head = %q, want first 16 bytes", got)
	}
	if b.Total() != 30 {
		t.Fatalf("Total = %d, want 30", b.Total())
	}
	if !b.Truncated() {
		t.Fatal("over cap must report truncation")
	}
}

// newCaptureTestHandler mirrors the stream-timeout harness minus the
// per-provider timeout overrides.
func newCaptureTestHandler(t *testing.T, baseURL string) (*Handler, *usage.RingBuffer) {
	t.Helper()
	provider := config.Provider{
		ID: "test", Name: "Test Provider", Prefix: "test",
		BaseURL: baseURL, IsActive: true,
		Keys: []config.Key{
			{ID: "key1", Key: "sk-test-key-1", Name: "Key One", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "gpt-4", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 5, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	rb := usage.New(100)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, rb, qt, logger, 0), rb
}

// TestStreamCapture_BoundedPayloadTallUsage is the end-to-end F-06 regression:
// a stream larger than the capture cap must (a) reach the client in full,
// (b) leave a bounded, self-describing truncation marker in the ring entry,
// and (c) still record the usage tokens from the terminal usage chunk —
// proving token extraction is incremental and independent of the capped
// capture buffer.
func TestStreamCapture_BoundedPayloadTallUsage(t *testing.T) {
	var serverTotal int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		write := func(s string) {
			fmt.Fprint(w, s)
			fl.Flush()
			serverTotal += int64(len(s))
		}
		// ~1.1 KiB per chunk x 300 chunks ~= 330 KiB > 256 KiB cap.
		chunk := "data: {\"choices\":[{\"delta\":{\"content\":\"" + strings.Repeat("x", 1024) + "\"}}]}\n\n"
		for i := 0; i < 300; i++ {
			write(chunk)
		}
		// Terminal usage chunk lives at the very tail, past the capture cap.
		write("data: {\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":22}}\n\n")
		write("data: [DONE]\n\n")
	}))
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	h, rb := newCaptureTestHandler(t, srv.URL)

	parsed, body := streamRequest()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	w := httptest.NewRecorder()

	done := make(chan bool, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", nil, parsed, true, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
		done <- ok
	}()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("stream request failed")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream request did not finish")
	}

	// (a) The client receives the full stream — the capture cap must not
	// truncate relayed bytes.
	if int64(w.Body.Len()) != serverTotal {
		t.Fatalf("client received %d bytes, want full %d", w.Body.Len(), serverTotal)
	}
	if serverTotal <= maxCapturedBodyBytes {
		t.Fatalf("test stream (%d bytes) must exceed the capture cap (%d)", serverTotal, maxCapturedBodyBytes)
	}

	var successEntry *usage.Entry
	for i := range rb.All() {
		if e := rb.All()[i]; e.Status == "success" {
			entryCopy := e
			successEntry = &entryCopy
			break
		}
	}
	if successEntry == nil {
		t.Fatal("expected a success usage entry")
	}

	// (b) The retained response payload is bounded and self-describing.
	// The wrapper's "raw" string JSON-escapes the retained head, so the bound
	// is cap + escaping overhead (worst case ~2x cap for quote-heavy bodies).
	if len(successEntry.RespPayload) > 2*maxCapturedBodyBytes+4096 {
		t.Fatalf("retained RespPayload = %d bytes, want <= ~%d", len(successEntry.RespPayload), 2*maxCapturedBodyBytes)
	}
	var wrapper struct {
		Raw            string `json:"raw"`
		Truncated      bool   `json:"truncated"`
		TruncatedBytes int64  `json:"truncatedBytes"`
		TotalBytes     int64  `json:"totalBytes"`
	}
	if err := json.Unmarshal(successEntry.RespPayload, &wrapper); err != nil {
		t.Fatalf("stream RespPayload must be the truncation wrapper: %v", err)
	}
	if !wrapper.Truncated {
		t.Fatal("stream RespPayload must carry the truncation marker")
	}
	if wrapper.TotalBytes != serverTotal {
		t.Fatalf("totalBytes = %d, want true stream size %d", wrapper.TotalBytes, serverTotal)
	}
	if wrapper.TruncatedBytes != serverTotal-maxCapturedBodyBytes {
		t.Fatalf("truncatedBytes = %d, want %d", wrapper.TruncatedBytes, serverTotal-maxCapturedBodyBytes)
	}

	// (c) The usage chunk at the tail (beyond the capture cap) is still
	// extracted incrementally.
	if successEntry.InputTokens != 11 || successEntry.OutputTokens != 22 {
		t.Fatalf("tokens = %d/%d, want 11/22 from the tail usage chunk",
			successEntry.InputTokens, successEntry.OutputTokens)
	}
}

// TestStreamCapture_BigRequestCapped covers the request side: a prompt larger
// than the cap must leave a bounded truncation wrapper in the ring entry.
func TestStreamCapture_BigRequestCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fl.Flush()
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	h, rb := newCaptureTestHandler(t, srv.URL)

	parsed, _ := streamRequest()
	parsed["messages"] = []any{map[string]any{"role": "user", "content": strings.Repeat("a", maxCapturedBodyBytes*2)}}
	rawBody, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(string(rawBody)))
	w := httptest.NewRecorder()

	done := make(chan bool, 1)
	go func() {
		ok, _ := h.forwardWithRetry(w, req, "test", "gpt-4", "/v1/chat/completions", rawBody, parsed, true, 1, "", "Test Provider", combo.EntryFormatOpenAI, "", "")
		done <- ok
	}()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("stream request failed")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stream request did not finish")
	}

	var successEntry *usage.Entry
	for i := range rb.All() {
		if e := rb.All()[i]; e.Status == "success" {
			entryCopy := e
			successEntry = &entryCopy
			break
		}
	}
	if successEntry == nil {
		t.Fatal("expected a success usage entry")
	}
	if len(successEntry.ReqPayload) > maxCapturedBodyBytes+4096 {
		t.Fatalf("retained ReqPayload = %d bytes, want <= ~%d", len(successEntry.ReqPayload), maxCapturedBodyBytes)
	}
	var wrapper struct {
		Truncated  bool  `json:"truncated"`
		TotalBytes int64 `json:"totalBytes"`
	}
	if err := json.Unmarshal(successEntry.ReqPayload, &wrapper); err != nil {
		t.Fatalf("request ReqPayload must be the truncation wrapper: %v", err)
	}
	if !wrapper.Truncated || wrapper.TotalBytes < int64(maxCapturedBodyBytes*2) {
		t.Fatalf("request payload marker wrong: truncated=%v totalBytes=%d", wrapper.Truncated, wrapper.TotalBytes)
	}
}
