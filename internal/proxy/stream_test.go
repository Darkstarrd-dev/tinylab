package proxy

import (
	"strings"
	"testing"

	"github.com/tinyrouter/tinyrouter/internal/util"
)

func TestExtractTokens_MultipleChunks(t *testing.T) {
	// Simulate a stream: first chunk has no usage, second chunk has it
	chunks := []string{
		`data: {"id":"abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}`,
		`data: {"id":"abc","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":55,"completion_tokens":22}}`,
	}

	inputTokens, outputTokens := 0, 0
	for _, line := range chunks {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(line[5:])
			if payload == "[DONE]" {
				continue
			}
			if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
				inputTokens = in
				outputTokens = out
			}
		}
	}

	if inputTokens != 55 || outputTokens != 22 {
		t.Fatalf("expected tokens in=55 out=22, got in=%d out=%d", inputTokens, outputTokens)
	}
}

func TestExtractTokens_NoUsageChunk(t *testing.T) {
	// Simulate a stream with no usage in any chunk
	chunks := []string{
		`data: {"id":"abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}`,
		`data: {"id":"abc","object":"chat.completion.chunk","choices":[]}`,
	}

	inputTokens, outputTokens := 0, 0
	for _, line := range chunks {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(line[5:])
			if payload == "[DONE]" {
				continue
			}
			if in, out := util.ExtractTokens([]byte(payload)); in > 0 || out > 0 {
				inputTokens = in
				outputTokens = out
			}
		}
	}

	if inputTokens != 0 || outputTokens != 0 {
		t.Fatalf("expected tokens 0/0 for stream without usage, got in=%d out=%d", inputTokens, outputTokens)
	}
}

func TestExtractTokens_TotalTokensFallback(t *testing.T) {
	// Provider returns only total_tokens, not individual counts
	line := `data: {"usage":{"total_tokens":500}}`
	line = strings.TrimSpace(line)
	payload := strings.TrimSpace(line[5:])

	in, out := util.ExtractTokens([]byte(payload))
	if in != 500 || out != 0 {
		t.Fatalf("expected in=500 (total_tokens fallback), out=0, got in=%d out=%d", in, out)
	}
}
