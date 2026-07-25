package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// resolveDisplayModel returns the best display name for console logs:
// prefer alias from registry, fall back to originalModel, then upstreamModel.
func resolveDisplayModel(providerName, upstreamModel, originalModel string, reg AliasResolver) string {
	if alias := reg.ResolveModelAliasByID(providerName, upstreamModel); alias != "" {
		return alias
	}
	if originalModel != "" && originalModel != upstreamModel {
		return originalModel
	}
	return upstreamModel
}

// requestCallerTag returns a short, log-safe string identifying the client that
// made r, for inclusion in console log lines so concurrent clients can be told
// apart. It never exposes a full credential. Format example:
// "src=playground ua=OpenCode/1.2 from=127.0.0.1:54321". Fields with no value are
// omitted; the whole tag is bounded to ~80 chars so it fits one console line.
func requestCallerTag(r *http.Request) string {
	if r == nil {
		return ""
	}
	var parts []string
	if src := strings.TrimSpace(r.Header.Get("X-TinyRouter-Source")); src != "" {
		parts = append(parts, "src="+clipStr(src, 16))
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		parts = append(parts, "auth="+maskAuth(auth))
	}
	if ua := strings.TrimSpace(r.Header.Get("User-Agent")); ua != "" {
		parts = append(parts, "ua="+clipStr(ua, 24))
	}
	if from := strings.TrimSpace(r.RemoteAddr); from != "" {
		parts = append(parts, "from="+from)
	}
	tag := strings.Join(parts, " ")
	// Hard bound at 80 bytes so the tag never blows out a console line.
	if len(tag) > 80 {
		tag = tag[:80]
	}
	return tag
}

// maskAuth returns a log-safe rendering of an Authorization header value: the
// first 4 and last 4 characters separated by "…" (e.g. "sk-x…yz"). The common
// "Bearer " scheme prefix is stripped before masking so only the key itself is
// masked. If the key is too short to mask without revealing the whole thing
// (<=8 chars), "<len>chars" is returned instead. The full credential is never
// returned.
func maskAuth(auth string) string {
	v := strings.TrimSpace(auth)
	// Strip a "Bearer" scheme prefix (case-insensitive). Trimming first means a
	// "Bearer " with trailing space collapses to "Bearer", so match the 6-char
	// scheme and trim any whitespace that followed it.
	if len(v) >= 6 && strings.EqualFold(v[:6], "bearer") {
		v = strings.TrimSpace(v[6:])
	}
	if v == "" {
		return "0chars"
	}
	n := len(v)
	if n <= 8 {
		return fmt.Sprintf("%dchars", n)
	}
	return v[:4] + "…" + v[n-4:]
}

// clipStr shortens s to at most n runes, appending "…" if truncated.
func clipStr(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// generateToolCallID creates a unique tool_call id compatible with the
// OpenAI tool-call format (e.g. "call_<hex>"). This is used as a defensive
// fallback when an upstream provider returns an empty tool_call id.
func generateToolCallID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Fallback: timestamp-based, practically unique.
		return fmt.Sprintf("call_%x", time.Now().UnixNano())
	}
	return "call_" + hex.EncodeToString(buf[:])
}

// ensureToolCallIDs scans the parsed request body for tool-call messages
// with empty identifiers and fills in random ones, ensuring that assistant
// tool_calls[].id and the corresponding tool message's tool_call_id match.
//
// Some upstream providers (e.g. Google AI Studio via OpenRouter) return
// empty tool_call ids in SSE deltas, which causes the client's subsequent
// tool messages to carry empty tool_call_id and triggers 400 "Tool message
// must have either name or tool_call_id" errors. This function is a
// defense-in-depth measure that runs for every request, regardless of
// provider. It maintains consistency by pairing tool messages with their
// preceding assistant message's tool calls by position.
func ensureToolCallIDs(parsed map[string]any) {
	msgs, ok := parsed["messages"].([]any)
	if !ok {
		return
	}

	// Pending tool call IDs from the last assistant message, consumed by
	// subsequent tool messages in order. This handles the common case
	// where tool results are returned in the same order as tool calls.
	var pendingIDs []string

	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)

		switch role {
		case "assistant":
			toolCalls, ok := msg["tool_calls"].([]any)
			if !ok {
				continue
			}
			pendingIDs = make([]string, 0, len(toolCalls))
			for _, tc := range toolCalls {
				tcm, ok := tc.(map[string]any)
				if !ok {
					pendingIDs = append(pendingIDs, "")
					continue
				}
				id, _ := tcm["id"].(string)
				if id == "" {
					id = generateToolCallID()
					tcm["id"] = id
				}
				pendingIDs = append(pendingIDs, id)
			}

		case "tool":
			toolCallID, _ := msg["tool_call_id"].(string)
			if toolCallID != "" {
				continue
			}
			// Consume the next pending ID from the preceding assistant message.
			if len(pendingIDs) > 0 {
				msg["tool_call_id"] = pendingIDs[0]
				pendingIDs = pendingIDs[1:]
			} else {
				msg["tool_call_id"] = generateToolCallID()
			}
		}
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    "proxy_error",
		},
	})
}

func maskURL(url string) string {
	if len(url) <= 20 {
		return url
	}
	return url[:20] + "..."
}

// backfillThoughtSignatures injects the cached Gemini thought_signature into
// assistant tool_calls that are missing it, keyed by tool_call id. Google
// rejects tool-call round trips whose tool_calls lack the signature that was
// returned in the prior response; the proxy caches those signatures as it
// streams the first response and replays them here. Existing signatures are
// never overwritten; cache misses are silently skipped (best-effort).
func backfillThoughtSignatures(parsed map[string]any, cache SignatureCacheProvider) {
	msgs, ok := parsed["messages"].([]any)
	if !ok {
		return
	}
	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		if role != "assistant" {
			continue
		}
		toolCalls, ok := msg["tool_calls"].([]any)
		if !ok || len(toolCalls) == 0 {
			continue
		}
		for _, tc := range toolCalls {
			tcm, ok := tc.(map[string]any)
			if !ok {
				continue
			}
			id, _ := tcm["id"].(string)
			if id == "" {
				continue
			}
			if hasThoughtSignature(tcm) {
				continue
			}
			sig, ok := cache.Get(id)
			if !ok || sig == "" {
				continue
			}
			tcm["extra_content"] = map[string]any{
				"google": map[string]any{
					"thought_signature": sig,
				},
			}
		}
	}
}

func hasThoughtSignature(tc map[string]any) bool {
	extra, ok := tc["extra_content"].(map[string]any)
	if !ok {
		return false
	}
	google, ok := extra["google"].(map[string]any)
	if !ok {
		return false
	}
	sig, ok := google["thought_signature"].(string)
	return ok && sig != ""
}
