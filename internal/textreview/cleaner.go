// Package textreview implements the in-process engine that drives AI
// long-form text cleanup: a session holds chapters to be cleaned against a
// pool of processing nodes, each node backed by a single provider model. The
// engine streams cleaned output chapter-by-chapter via the shared proxy stack
// and supports live SSE subscription, pause/resume/stop, and automatic
// concurrency ramp-down when a node becomes exhausted.
package textreview

import (
	"context"

	"github.com/tinyrouter/tinyrouter/internal/config"
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
}

// Cleaner cleans a single chapter's content against a processing node. The
// implementation streams the cleaned text to onChunk as it arrives; the
// scheduler appends each delta to the chapter's Cleaned field and broadcasts
// it to SSE subscribers. A fake implementation is used in tests.
type Cleaner interface {
	Clean(ctx context.Context, node config.TextReviewNode, systemPrompt, content string, onChunk func(delta string)) CleanResult
}

// ChapterSep is the marker that delimits chapters in a batch clean request and
// in the model's streamed output. Mirrors the novelhelper batch protocol.
const ChapterSep = "<<<|||CHAPTER_SEP|||>>>"

// chapterIDHeader prefixes each chapter block in a batch. The token after it
// (up to the closing "===") is the chapter key, which the stream router uses to
// route chunks back to the originating chapter.
const chapterIDHeader = "===CHAPTER_ID:"

// BatchChapter is one chapter in a batch clean request. Key is the stable
// identifier used to route streamed output back to the chapter (the chapter's
// index as a string).
type BatchChapter struct {
	Key     string `json:"key"`
	Content string `json:"content"`
}

// BatchCleaner cleans a batch of chapters in a single LLM request. The
// implementation merges the chapters into one prompt (separated by ChapterSep,
// each prefixed with an ===CHAPTER_ID:Key=== header) and routes the streamed
// result back per chapter via onChunk(chapterKey, delta). A Cleaner that also
// implements BatchCleaner enables multi-chapter batching when a node's
// BatchChars > 0; otherwise the engine falls back to one Clean call per
// chapter.
type BatchCleaner interface {
	CleanBatch(ctx context.Context, node config.TextReviewNode, systemPrompt string, batch []BatchChapter, onChunk func(chapterKey string, delta string)) CleanResult
}
