// Package sse provides generic SSE (Server-Sent Events) line framing,
// data payload extraction, and chunk normalization utilities.
//
// These are extracted from internal/proxy/stream.go and are used by both
// the proxy handler and the API probe/speedtest code.
package sse

import (
	"bytes"
	"encoding/json"
	"strings"
)

// SSELineBuffer buffers raw SSE bytes and splits them into complete lines.
// It handles the common case where a single Read() call returns a partial
// SSE line (e.g. a "data:" payload split across two TCP segments).
type SSELineBuffer struct {
	buf []byte
}

// Feed appends data to the internal buffer and returns all complete lines
// that have been accumulated so far (separated by '\n'). Partial lines remain
// in the buffer for the next call.
func (b *SSELineBuffer) Feed(data []byte) []string {
	b.buf = append(b.buf, data...)
	var lines []string
	for {
		idx := bytes.IndexByte(b.buf, '\n')
		if idx < 0 {
			break
		}
		lines = append(lines, string(b.buf[:idx]))
		b.buf = b.buf[idx+1:]
	}
	return lines
}

// Remaining returns any buffered data that has not yet been split by a '\n',
// and clears the buffer. This is typically called after the stream ends to
// capture any trailing partial line.
func (b *SSELineBuffer) Remaining() string {
	if len(b.buf) > 0 {
		s := string(b.buf)
		b.buf = nil
		return s
	}
	return ""
}

// SSEDataPayloads extracts the JSON payload strings from a batch of SSE lines
// (as produced by SSELineBuffer.Feed). Lines that are not "data:" directives or
// that are the SSE [DONE] sentinel are skipped. Each returned payload is trimmed
// of surrounding whitespace and is ready to be parsed as JSON or scanned for
// tokens. This centralizes the "data:" prefix handling and [DONE] filtering that
// upstream callers (e.g. the API model-probe handlers) previously duplicated
// inline, so there is a single source of truth for line framing.
func SSEDataPayloads(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "data:") {
			continue
		}
		payload := strings.TrimSpace(t[len("data:"):])
		if payload == "" || payload == "[DONE]" {
			continue
		}
		out = append(out, payload)
	}
	return out
}

// NormalizeSSEChunk normalizes a single SSE line coming from an upstream.
// It only rewrites "data:" payloads where "choices" is null and no "error"
// field is present, turning "choices":null into "choices":[] so that strict
// OpenAI-chunk validators (which require choices to be an array) accept the
// usage-only preamble chunks emitted by some providers (e.g. ModelScope).
// All other lines (blank separators, comments, [DONE], error chunks, valid
// chunks) are returned unchanged. Parse failures fall back to the original
// line to avoid dropping data.
func NormalizeSSEChunk(line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	payload := strings.TrimSpace(trimmed[5:])
	if payload == "[DONE]" {
		return line
	}

	var obj map[string]any
	if err := json.Unmarshal([]byte(payload), &obj); err != nil {
		return line
	}
	// Never touch error chunks: they must reach the client as-is.
	if _, hasErr := obj["error"]; hasErr {
		return line
	}
	// Only fix the specific malformed case: choices is explicitly null.
	choices, exists := obj["choices"]
	if !exists {
		return line
	}
	if choices == nil {
		obj["choices"] = []any{}
	} else if arr, ok := choices.([]any); ok && len(arr) == 0 {
		// already an empty array; nothing to do
	} else {
		return line
	}

	out, err := json.Marshal(obj)
	if err != nil {
		return line
	}
	return "data: " + string(out)
}
