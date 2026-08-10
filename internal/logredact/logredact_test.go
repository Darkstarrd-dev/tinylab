package logredact

import (
	"net/http"
	"testing"
)

func TestMaskHeaderMap(t *testing.T) {
	headers := http.Header{
		"Authorization": {"Bearer sk-secret"},
		"X-Api-Key":     {"sk-secret"},
		"Cookie":        {"session=visible"},
		"X-Trace":       {"sk-secret and visible"},
	}
	got := MaskHTTPHeaders(headers, "sk-secret")
	if got.Get("Authorization") != "Bearer ******" {
		t.Fatalf("authorization = %q", got.Get("Authorization"))
	}
	if got.Get("X-Api-Key") != "******" {
		t.Fatalf("x-api-key = %q", got.Get("X-Api-Key"))
	}
	if got.Get("Cookie") != "session=visible" {
		t.Fatalf("cookie = %q", got.Get("Cookie"))
	}
	if got.Get("X-Trace") != "****** and visible" {
		t.Fatalf("ordinary header = %q", got.Get("X-Trace"))
	}
}

func TestMaskHeaderMapLegacyCredentialHeader(t *testing.T) {
	headers := map[string][]string{
		"Authorization": {"Bearer ***wxyz"},
		"X-Api-Key":     {"***alue"},
		"Cookie":        {"session=visible"},
	}
	got := MaskHeaderMap(headers, "")
	if got["Authorization"][0] != "Bearer ******" {
		t.Fatalf("authorization = %q", got["Authorization"][0])
	}
	if got["X-Api-Key"][0] != "******" {
		t.Fatalf("x-api-key = %q", got["X-Api-Key"][0])
	}
	if got["Cookie"][0] != "session=visible" {
		t.Fatalf("cookie = %q", got["Cookie"][0])
	}
}

func TestMaskURL(t *testing.T) {
	got := MaskURL("https://user:sk-secret@example.com/v1?key=sk-secret&model=gpt-4", "sk-secret")
	want := "https://user:******@example.com/v1?key=******&model=gpt-4"
	if got != want {
		t.Fatalf("url = %q, want %q", got, want)
	}

	legacy := MaskURL("https://user:sekrit@example.com/v1?token=old-secret&model=gpt-4", "")
	wantLegacy := "https://user:******@example.com/v1?model=gpt-4&token=******"
	if legacy != wantLegacy {
		t.Fatalf("legacy url = %q, want %q", legacy, wantLegacy)
	}
}
