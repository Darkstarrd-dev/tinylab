package proxy

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRequestCallerTag_Masking verifies that a full API key is NEVER present in
// the tag — only the masked first-4 + last-4 form — and that the "Bearer "
// prefix is stripped before masking.
func TestRequestCallerTag_Masking(t *testing.T) {
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer sk-secret-key-1234567890-abcd")
	req.Header.Set("X-TinyRouter-Source", "playground")
	req.Header.Set("User-Agent", "OpenCode/1.2")
	req.RemoteAddr = "127.0.0.1:54321"

	tag := requestCallerTag(req)

	if strings.Contains(tag, "sk-secret-key-1234567890-abcd") {
		t.Fatalf("full key leaked into tag: %q", tag)
	}
	if !strings.Contains(tag, "auth=") {
		t.Fatalf("expected auth= field in tag: %q", tag)
	}
	// Masked form: first 4 + … + last 4 of the key (Bearer stripped).
	if !strings.Contains(tag, "sk-s…abcd") {
		t.Fatalf("expected masked 'sk-s…abcd' in tag: %q", tag)
	}
	if !strings.Contains(tag, "src=playground") {
		t.Fatalf("expected src=playground in tag: %q", tag)
	}
	if !strings.Contains(tag, "ua=OpenCode/1.2") {
		t.Fatalf("expected ua= in tag: %q", tag)
	}
	if !strings.Contains(tag, "from=127.0.0.1:54321") {
		t.Fatalf("expected from= in tag: %q", tag)
	}
}

// TestRequestCallerTag_EmptyFieldsOmitted verifies that headers with no value
// are skipped entirely (no "src=" placeholder, etc.).
func TestRequestCallerTag_EmptyFieldsOmitted(t *testing.T) {
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("{}"))
	// No Authorization, no X-TinyRouter-Source, no User-Agent.
	req.RemoteAddr = "10.0.0.1:7777"

	tag := requestCallerTag(req)

	if strings.Contains(tag, "src=") {
		t.Fatalf("empty src should be omitted: %q", tag)
	}
	if strings.Contains(tag, "auth=") {
		t.Fatalf("empty auth should be omitted: %q", tag)
	}
	if strings.Contains(tag, "ua=") {
		t.Fatalf("empty ua should be omitted: %q", tag)
	}
	if !strings.Contains(tag, "from=10.0.0.1:7777") {
		t.Fatalf("expected from= in tag: %q", tag)
	}
}

// TestRequestCallerTag_ShortKeyRevealsNothing verifies a too-short credential is
// rendered as "<n>chars" and never reveals the raw value.
func TestRequestCallerTag_ShortKeyRevealsNothing(t *testing.T) {
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("{}"))
	req.Header.Set("Authorization", "abc123") // 6 chars, <=8 → "<n>chars"
	req.RemoteAddr = "1.2.3.4:9"

	tag := requestCallerTag(req)

	if strings.Contains(tag, "abc123") {
		t.Fatalf("short key leaked into tag: %q", tag)
	}
	if !strings.Contains(tag, "auth=6chars") {
		t.Fatalf("expected auth=6chars for 6-char key: %q", tag)
	}
}

// TestRequestCallerTag_Bounded verifies the tag is hard-bounded to 80 bytes
// even with absurdly long field values.
func TestRequestCallerTag_Bounded(t *testing.T) {
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("{}"))
	req.Header.Set("X-TinyRouter-Source", strings.Repeat("x", 200))
	req.Header.Set("User-Agent", strings.Repeat("u", 200))
	req.RemoteAddr = strings.Repeat("z", 200)

	tag := requestCallerTag(req)
	if len(tag) > 80 {
		t.Fatalf("tag length %d exceeds 80-byte bound: %q", len(tag), tag)
	}
}

// TestRequestCallerTag_NilRequest verifies nil request returns "" (used in some
// test/non-request contexts) and never panics.
func TestRequestCallerTag_NilRequest(t *testing.T) {
	if got := requestCallerTag(nil); got != "" {
		t.Fatalf("expected empty tag for nil request, got %q", got)
	}
}

// TestMaskAuth covers the masking helper directly.
func TestMaskAuth(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"bearer prefix stripped", "Bearer sk-1234567890-wxyz", "sk-1…wxyz"},
		{"plain key", "sk-abcdefghijklmnop", "sk-a…mnop"},
		{"too short", "abc", "3chars"},
		{"exactly 8 stays masked", "12345678", "8chars"},
		{"9 chars masks", "123456789", "1234…6789"},
		{"empty bearer", "Bearer ", "0chars"},
		{"empty", "", "0chars"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := maskAuth(c.in)
			if got != c.want {
				t.Fatalf("maskAuth(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
