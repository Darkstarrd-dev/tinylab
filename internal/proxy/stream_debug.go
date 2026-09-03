package proxy

import (
	"strings"

	"github.com/tinylab/tinylab/internal/sse"
)

// parseAndBroadcastChunk extracts delta text from an SSE data: line in debug
// mode and broadcasts request-chunk events through the RequestUpdates
// broadcaster. The line argument is a raw SSE line (e.g. "data: {...}").
// The sb argument is the SSELineBuffer that has already produced this line;
// it is preserved so subsequent calls can continue scanning without losing
// any partial data between calls.
func (h *Handler) parseAndBroadcastChunk(reqID, line string, sb *sse.SSELineBuffer) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return
	}
	payload := strings.TrimSpace(trimmed[5:])
	if payload == "[DONE]" {
		return
	}

	deltas := parseSSEChunkDelta([]byte(payload))
	for _, d := range deltas {
		h.RequestUpdates.Broadcast(RequestEvent{
			Type:    "request-chunk",
			ID:      reqID,
			Section: d.section,
			Delta:   d.delta,
		})
	}
}
