package sse

import (
	"strings"
	"testing"
)

func TestSSELineBuffer_Normal(t *testing.T) {
	sb := NewSSELineBuffer(0, 0)
	lines, err := sb.Feed([]byte("line1\nline2\nline3\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "line1" || lines[1] != "line2" || lines[2] != "line3" {
		t.Fatalf("unexpected lines: %v", lines)
	}
}

// TestSSELineBuffer_LineBudget verifies a single oversized line is rejected
// with ErrLineTooLong (F-14: no-newline SSE beyond the line cap must close
// the request instead of growing memory).
func TestSSELineBuffer_LineBudget(t *testing.T) {
	sb := NewSSELineBuffer(16, 0)
	lines, err := sb.Feed([]byte("data: " + strings.Repeat("x", 64) + "\n"))
	if err != ErrLineTooLong {
		t.Fatalf("got err %v, want ErrLineTooLong", err)
	}
	if len(lines) != 0 {
		t.Fatalf("got %d lines, want 0", len(lines))
	}
	// Buffer was cleared: a subsequent valid feed must not wedge.
	lines, err = sb.Feed([]byte("ok\n"))
	if err != nil || len(lines) != 1 || lines[0] != "ok" {
		t.Fatalf("after overflow: lines=%v err=%v, want [ok] nil", lines, err)
	}
}

// TestSSELineBuffer_TotalBudget verifies a partial line growing past the
// total buffer budget is rejected with ErrBufferOverflow.
func TestSSELineBuffer_TotalBudget(t *testing.T) {
	sb := NewSSELineBuffer(0, 32)
	half := strings.Repeat("x", 16)
	if _, err := sb.Feed([]byte(half)); err != nil {
		t.Fatalf("first half errored: %v", err)
	}
	lines, err := sb.Feed([]byte(strings.Repeat("x", 32)))
	if err != ErrBufferOverflow {
		t.Fatalf("got err %v, want ErrBufferOverflow", err)
	}
	if len(lines) != 0 {
		t.Fatalf("got %d lines, want 0", len(lines))
	}
}

// TestSSELineBuffer_LinesBeforeBudgetError verifies lines completed before a
// budget error are still returned so callers can process them before aborting.
func TestSSELineBuffer_LinesBeforeBudgetError(t *testing.T) {
	sb := NewSSELineBuffer(8, 0)
	lines, err := sb.Feed([]byte("ok\n" + strings.Repeat("x", 32) + "\n"))
	if err != ErrLineTooLong {
		t.Fatalf("got err %v, want ErrLineTooLong", err)
	}
	if len(lines) != 1 || lines[0] != "ok" {
		t.Fatalf("got lines %v, want [ok]", lines)
	}
}

func TestSSELineBuffer_CrossChunk(t *testing.T) {
	sb := NewSSELineBuffer(0, 0)

	// Feed first part - incomplete line
	lines, err := sb.Feed([]byte("line"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected 0 lines from incomplete chunk, got %d", len(lines))
	}

	// Feed rest - completes the first line and adds second
	lines, err = sb.Feed([]byte("1 end\nline2\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "line1 end" || lines[1] != "line2" {
		t.Fatalf("unexpected lines: %v", lines)
	}
}

func TestSSELineBuffer_DataAcrossChunks(t *testing.T) {
	sb := NewSSELineBuffer(0, 0)

	// Simulate a data: line split across reads (real SSE scenario)
	chunk1 := `data: {"id":"abc","usage":{"prompt_tokens":123`
	lines, err := sb.Feed([]byte(chunk1))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected 0 lines from partial chunk, got %d", len(lines))
	}

	chunk2 := `,"completion_tokens":456,"total_tokens":579}}

data: [DONE]

`

	lines, err = sb.Feed([]byte(chunk2))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) < 1 {
		t.Fatalf("expected at least 1 line, got %d: %v", len(lines), lines)
	}

	// The first line should be the complete data: line
	if !strings.HasPrefix(lines[0], "data: ") {
		t.Fatalf("expected data: prefix, got: %s", lines[0])
	}

	// Parse the payload after "data: "
	payload := strings.TrimSpace(lines[0][5:])
	if payload == "[DONE]" {
		t.Fatalf("expected usage payload, got [DONE]")
	}
}

func TestSSELineBuffer_Remaining(t *testing.T) {
	sb := NewSSELineBuffer(0, 0)

	if _, err := sb.Feed([]byte("line1\nline")); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rem := sb.Remaining()
	if rem != "line" {
		t.Fatalf("expected remaining 'line', got %q", rem)
	}

	// Second call should be empty
	rem = sb.Remaining()
	if rem != "" {
		t.Fatalf("expected empty remaining, got %q", rem)
	}
}

func TestSSELineBuffer_Empty(t *testing.T) {
	sb := NewSSELineBuffer(0, 0)
	lines, err := sb.Feed([]byte{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected 0 lines, got %d", len(lines))
	}
	rem := sb.Remaining()
	if rem != "" {
		t.Fatalf("expected empty remaining, got %q", rem)
	}
}

func TestSSE_DataWithoutSpace(t *testing.T) {
	line := `data:{"id":"test","object":"chat.completion.chunk","usage":{"input_tokens":100,"output_tokens":50}}`
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		t.Fatal("expected data: prefix")
	}
	payload := strings.TrimSpace(line[5:])
	if payload == "[DONE]" {
		t.Fatal("expected payload, got [DONE]")
	}
}

func TestSSE_DataWithSpace(t *testing.T) {
	line := `data: {"object":"chat.completion","usage":{"prompt_tokens":200,"completion_tokens":300}}`
	line = strings.TrimSpace(line)
	payload := strings.TrimSpace(line[5:])
	if payload == "[DONE]" {
		t.Fatal("expected payload, got [DONE]")
	}
}

func TestNormalizeSSEChunk_ChoicesNull(t *testing.T) {
	// ModelScope-style usage-only preamble chunk: choices is null.
	line := `data: {"id":"","object":"","created":0,"model":"Tencent-Hunyuan/Hy3","system_fingerprint":"","choices":null,"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`
	out := NormalizeSSEChunk(line)
	if !strings.Contains(out, `"choices":[]`) {
		t.Fatalf("expected choices normalized to [], got: %s", out)
	}
	if !strings.Contains(out, `"usage":{`) {
		t.Fatalf("expected usage field preserved, got: %s", out)
	}
}

func TestNormalizeSSEChunk_ErrorPassthrough(t *testing.T) {
	// A chunk with choices:null but an error object must NOT be rewritten.
	line := `data: {"choices":null,"error":{"message":"rate limited","type":"rate_limit_error"}}`
	out := NormalizeSSEChunk(line)
	if strings.Contains(out, `"choices":[]`) {
		t.Fatalf("error chunk must not be normalized, got: %s", out)
	}
	if !strings.Contains(out, `"error":`) {
		t.Fatalf("error chunk must keep error field, got: %s", out)
	}
}

func TestNormalizeSSEChunk_Done(t *testing.T) {
	line := `data: [DONE]`
	out := NormalizeSSEChunk(line)
	if out != line {
		t.Fatalf("expected [DONE] unchanged, got: %s", out)
	}
}

func TestNormalizeSSEChunk_ValidArray(t *testing.T) {
	// A healthy chunk with choices as array must pass through unchanged.
	line := `data: {"id":"x","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`
	out := NormalizeSSEChunk(line)
	if out != line {
		t.Fatalf("expected valid chunk unchanged, got: %s", out)
	}
}

func TestNormalizeSSEChunk_BlankLine(t *testing.T) {
	// Event separator / comment lines must pass through unchanged.
	for _, line := range []string{"", ": keep-alive"} {
		if out := NormalizeSSEChunk(line); out != line {
			t.Fatalf("expected %q unchanged, got %q", line, out)
		}
	}
}

func TestNormalizeSSEChunk_FinalUsageKept(t *testing.T) {
	// Final usage chunk has choices:null but carries real token counts.
	line := `data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"Tencent-Hunyuan/Hy3","system_fingerprint":"","choices":null,"usage":{"prompt_tokens":13,"completion_tokens":39,"total_tokens":52}}`
	out := NormalizeSSEChunk(line)
	if !strings.Contains(out, `"choices":[]`) {
		t.Fatalf("expected choices normalized, got: %s", out)
	}
	if !strings.Contains(out, `"total_tokens":52`) {
		t.Fatalf("expected real usage preserved, got: %s", out)
	}
}
