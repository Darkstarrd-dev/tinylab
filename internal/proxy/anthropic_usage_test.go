package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/combo"
	"github.com/tinyrouter/tinyrouter/internal/config"
	"github.com/tinyrouter/tinyrouter/internal/console"
	"github.com/tinyrouter/tinyrouter/internal/registry"
	"github.com/tinyrouter/tinyrouter/internal/rotation"
	"github.com/tinyrouter/tinyrouter/internal/usage"
)

// newAnthropicUsageTestHandler builds a handler whose single provider is an
// anthropic-typed provider pointed at baseURL, with a controllable usage buffer
// so token reporting can be asserted.
func newAnthropicUsageTestHandler(t *testing.T, baseURL, version, beta string, usageBuf *usage.RingBuffer) *Handler {
	t.Helper()
	provider := config.Provider{
		ID:               "anth",
		Name:             "Anthropic",
		Prefix:           "anth",
		BaseURL:          baseURL,
		APIType:          "anthropic",
		AnthropicVersion: version,
		AnthropicBeta:    beta,
		IsActive:         true,
		Keys: []config.Key{
			{ID: "k1", Key: "sk-ant-key", Name: "AnthKey", IsActive: true, Priority: 1},
		},
		Models: []config.ModelDef{{ID: "claude-3-5-sonnet", QuotaType: "limited"}},
	}
	cfg := &config.Config{
		Providers: []config.Provider{provider},
		Rotation:  config.RotationConfig{Strategy: "fill-first", MaxRetries: 0, BackoffMaxSec: 300},
	}
	reg := registry.New(cfg)
	sel := rotation.New(reg, &cfg.Rotation)
	comboRes := combo.New(reg)
	qt := usage.NewQuotaTracker()
	logger := console.New(100)
	return New(reg, sel, comboRes, usageBuf, qt, logger, 0)
}

// anthropicSSEStream is a realistic Anthropic Messages SSE response carrying
// usage in the message_start and message_delta events.
const anthropicSSEStream = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_sequence":null,"usage":{"input_tokens":1500,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}

`

// TestAnthropicSSE_UsageExtractedAndReported verifies that an Anthropic SSE
// stream is transparently passed through to the client unchanged while its
// usage (input_tokens from message_start, output_tokens from message_delta) is
// extracted and reported via the usage recorder.
func TestAnthropicSSE_UsageExtractedAndReported(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(anthropicSSEStream))
	}))
	defer mockUpstream.Close()

	usageBuf := usage.New(100)
	h := newAnthropicUsageTestHandler(t, mockUpstream.URL+"/v1/messages", "2023-06-01", "", usageBuf)

	body := `{"model":"anth/claude-3-5-sonnet","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Messages(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	clientBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read client body: %v", err)
	}
	// 1) Transparent passthrough: the client receives the exact upstream bytes.
	if string(clientBody) != anthropicSSEStream {
		t.Errorf("client body was modified; got:\n%q\nwant:\n%q", string(clientBody), anthropicSSEStream)
	}

	// 2) Usage was reported. The accumulator must reflect the extracted tokens.
	summary := usageBuf.Summary()
	if summary.TotalInputTokens != 1500 {
		t.Errorf("expected reported input tokens 1500, got %d", summary.TotalInputTokens)
	}
	if summary.TotalOutputTokens != 42 {
		t.Errorf("expected reported output tokens 42, got %d", summary.TotalOutputTokens)
	}

	// 3) The ring buffer entry carries the same token counts.
	all := usageBuf.All()
	if len(all) == 0 {
		t.Fatal("expected at least one usage entry, got none")
	}
	entry := all[0]
	if entry.InputTokens != 1500 {
		t.Errorf("expected entry input tokens 1500, got %d", entry.InputTokens)
	}
	if entry.OutputTokens != 42 {
		t.Errorf("expected entry output tokens 42, got %d", entry.OutputTokens)
	}
}

// TestParseAnthropicSSEUsage unit-tests the usage-extraction helper against the
// two relevant event shapes, plus a non-usage event.
func TestParseAnthropicSSEUsage(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		wantIn  int
		wantOut int
		wantOK  bool
	}{
		{
			name:    "message_start carries input_tokens",
			payload: `{"type":"message_start","message":{"usage":{"input_tokens":1500,"output_tokens":0}}}`,
			wantIn:  1500,
			wantOut: 0,
			wantOK:  true,
		},
		{
			name:    "message_delta carries output_tokens",
			payload: `{"type":"message_delta","delta":{},"usage":{"output_tokens":42}}`,
			wantIn:  0,
			wantOut: 42,
			wantOK:  true,
		},
		{
			name:    "content_block_delta has no usage",
			payload: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
			wantOK:  false,
		},
		{
			name:    "malformed json",
			payload: `not json`,
			wantOK:  false,
		},
		{
			name:    "message_start missing usage",
			payload: `{"type":"message_start","message":{"id":"x"}}`,
			wantOK:  false,
		},
		{
			name:    "message_delta missing usage",
			payload: `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
			wantOK:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in, out, ok := parseAnthropicSSEUsage([]byte(tc.payload))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (in=%d out=%d)", ok, tc.wantOK, in, out)
			}
			if ok {
				if in != tc.wantIn {
					t.Errorf("input tokens = %d, want %d", in, tc.wantIn)
				}
				if out != tc.wantOut {
					t.Errorf("output tokens = %d, want %d", out, tc.wantOut)
				}
			}
		})
	}
}
