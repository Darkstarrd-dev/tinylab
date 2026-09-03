// Package textreview implements the in-process engine that drives AI
// long-form text cleanup: a session holds chapters to be cleaned against a
// pool of processing nodes, each node backed by a single provider model. The
// engine streams cleaned output chapter-by-chapter via the shared proxy stack
// and supports live SSE subscription, pause/resume/stop, and automatic
// concurrency ramp-down when a node becomes exhausted.
package textreview

import (
	"context"

	"github.com/tinylab/tinylab/internal/config"
)

// CleanResult is the outcome of a single Cleaner invocation, classified for
// the scheduler's retry/ramp-down logic.
type CleanResult struct {
	// OK reports that the stream completed cleanly (saw [DONE] or ended
	// without an error status). When true, Exhausted/Passed4xx are false.
	OK bool
	// Exhausted reports that the proxy returned 502 with an "all keys
	// exhausted"/"no available keys" body — the whole node's keys are spent.
	// This is the ramp-down signal: the scheduler decrements the node's
	// Target and, at zero, disables the node.
	Exhausted bool
	// Passed4xx reports that the proxy passed through a 4xx (request-shape
	// error such as an over-long prompt or unsupported model). The key is NOT
	// locked, so this is NOT a ramp-down signal — the chapter is simply
	// marked failed.
	Passed4xx bool
	// ErrMsg carries the human-readable error string for non-OK results.
	ErrMsg string

	// 调试字段：携带原始请求/响应供前端 debug 面板展示
	DebugRequest    string // 发送给 LLM 的完整 JSON 请求体
	DebugRawBody    string // 上游原始响应体（SSE 原始文本或错误 JSON）
	DebugStatusCode int    // 上游 HTTP 状态码
}

// Cleaner cleans a single chapter's content against a processing node. The
// implementation streams the cleaned text to onChunk as it arrives; the
// scheduler appends each delta to the chapter's Cleaned field and broadcasts
// it to SSE subscribers. A fake implementation is used in tests.
type Cleaner interface {
	Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult
}

// RawCleaner is an optional extension to Cleaner that also receives unparsed
// raw stream deltas (with section="thinking" or "content") for real-time debug UI.
type RawCleaner interface {
	CleanWithRaw(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string), onRaw func(section, delta string)) CleanResult
}

