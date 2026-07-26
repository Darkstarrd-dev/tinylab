package proxy

import (
	"strings"
	"testing"
)

// TestSessionKeyFromMessages covers the conversation-root fingerprint used to
// group requests by inferred session.
func TestSessionKeyFromMessages(t *testing.T) {
	// (a) Same root → same key across different msgCount (the conversation grows
	// by appending turns, but the system + first-user root stays fixed).
	root := []any{
		map[string]any{"role": "system", "content": "You are a helpful assistant."},
		map[string]any{"role": "user", "content": "What is 2+2?"},
	}
	turn2 := append([]any{}, root...)
	turn2 = append(turn2, map[string]any{"role": "assistant", "content": "4"})
	turn2 = append(turn2, map[string]any{"role": "user", "content": "And 3+3?"})
	turnBig := append([]any{}, turn2...)
	for range 200 {
		turnBig = append(turnBig, map[string]any{"role": "assistant", "content": "x"})
		turnBig = append(turnBig, map[string]any{"role": "user", "content": "y"})
	}

	k1 := sessionKeyFromMessages(map[string]any{"messages": root})
	k2 := sessionKeyFromMessages(map[string]any{"messages": turn2})
	k3 := sessionKeyFromMessages(map[string]any{"messages": turnBig})
	if k1 == "" {
		t.Fatal("expected non-empty key for root")
	}
	if k1 != k2 || k1 != k3 {
		t.Fatalf("same root must yield same key regardless of msgCount: k1=%s k2=%s k3=%s", k1, k2, k3)
	}
	if len(k1) != 8 {
		t.Fatalf("expected 8-hex-char key, got %d (=%q)", len(k1), k1)
	}

	// (b) Different first-user-message → different key.
	otherRoot := []any{
		map[string]any{"role": "system", "content": "You are a helpful assistant."},
		map[string]any{"role": "user", "content": "Translate this to French."},
	}
	kOther := sessionKeyFromMessages(map[string]any{"messages": otherRoot})
	if kOther == k1 {
		t.Fatalf("different first-user-message must yield different key: both %s", k1)
	}

	// (c) content as array of {type,text} parts handled identically to string.
	arrRoot := []any{
		map[string]any{"role": "system", "content": []any{
			map[string]any{"type": "text", "text": "You are a helpful assistant."},
		}},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "What is 2+2?"},
		}},
	}
	kArr := sessionKeyFromMessages(map[string]any{"messages": arrRoot})
	if kArr != k1 {
		t.Fatalf("array content must hash same as equivalent string: str=%s arr=%s", k1, kArr)
	}

	// (d) No messages / no user message → "".
	if got := sessionKeyFromMessages(map[string]any{}); got != "" {
		t.Fatalf("no messages must yield empty, got %q", got)
	}
	if got := sessionKeyFromMessages(map[string]any{"messages": []any{}}); got != "" {
		t.Fatalf("empty messages must yield empty, got %q", got)
	}
	systemOnly := []any{map[string]any{"role": "system", "content": "system prompt"}}
	if got := sessionKeyFromMessages(map[string]any{"messages": systemOnly}); got != "" {
		t.Fatalf("system-only (no user) must yield empty, got %q", got)
	}
	if got := sessionKeyFromMessages(nil); got != "" {
		t.Fatalf("nil parsed must yield empty, got %q", got)
	}

	// (e) Truncation is deterministic: contents that are identical within the
	// first 4096 runes hash to the same key, regardless of what comes after.
	// A content longer than the bound and a content that is exactly its first
	// 4096 runes (the truncated form) must match; a content differing within the
	// first 4096 runes must not. Uses multi-byte runes to exercise rune-safe
	// (not byte-safe) truncation.
	long := strings.Repeat("α", 4096) + strings.Repeat("β", 1000) // 5096 runes → truncates to 4096 α
	truncatedPrefix := strings.Repeat("α", 4096)                  // exactly the first 4096 runes of long
	kLong := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": long},
	}})
	kPrefix := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": truncatedPrefix},
	}})
	if kLong != kPrefix {
		t.Fatalf("truncation must be deterministic: long key %s != truncated-prefix key %s", kLong, kPrefix)
	}
	// A message that shares the first 4096 runes but differs after still matches
	// (both truncate to the same first 4096 runes).
	longAlt := long + "different tail"
	kLongAlt := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": longAlt},
	}})
	if kLong != kLongAlt {
		t.Fatalf("content identical within first 4096 runes must hash equal: %s != %s", kLong, kLongAlt)
	}
	// A message that differs within the first 4096 runes must NOT match.
	diffEarly := strings.Repeat("γ", 4096)
	kDiff := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": diffEarly},
	}})
	if kDiff == kLong {
		t.Fatal("differing early content must not match the truncated-prefix key")
	}

	// (f) system+user vs user-only differ appropriately: same user content with
	// and without a system message must produce different keys.
	userOnly := []any{map[string]any{"role": "user", "content": "What is 2+2?"}}
	kUserOnly := sessionKeyFromMessages(map[string]any{"messages": userOnly})
	if kUserOnly == k1 {
		t.Fatalf("user-only must differ from system+user (same user): both %s", k1)
	}
	if kUserOnly == "" {
		t.Fatal("user-only must yield a non-empty key")
	}
	// Null separator matters: system="a"+user="bc" must differ from system="ab"+user="c".
	left := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "system", "content": "a"},
		map[string]any{"role": "user", "content": "bc"},
	}})
	right := sessionKeyFromMessages(map[string]any{"messages": []any{
		map[string]any{"role": "system", "content": "ab"},
		map[string]any{"role": "user", "content": "c"},
	}})
	if left == right {
		t.Fatal("null separator must prevent a+bc == ab+c collisions")
	}
}
