package customheaders

import (
	"net/http"
	"testing"
)

func TestApply_DisabledOrEmptyIsNoOp(t *testing.T) {
	cases := []struct {
		name    string
		enabled bool
		headers map[string]string
	}{
		{"disabled", false, map[string]string{"X-Test": "v"}},
		{"empty map", true, nil},
		{"empty map literal", true, map[string]string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{"Existing": {"keep"}}
			Apply(h, tc.enabled, tc.headers)
			if got := h.Get("X-Test"); got != "" {
				t.Errorf("X-Test = %q, want empty (no-op)", got)
			}
			if got := h.Get("Existing"); got != "keep" {
				t.Errorf("Existing = %q, want keep", got)
			}
		})
	}
}

func TestApply_SetsHeaders(t *testing.T) {
	h := http.Header{}
	Apply(h, true, map[string]string{
		"X-Custom-Header": "custom-value",
		"X-Other":         "other",
	})
	if got := h.Get("X-Custom-Header"); got != "custom-value" {
		t.Errorf("X-Custom-Header = %q, want custom-value", got)
	}
	if got := h.Get("X-Other"); got != "other" {
		t.Errorf("X-Other = %q, want other", got)
	}
}

func TestApply_OverridesExisting(t *testing.T) {
	h := http.Header{"X-Existing": {"old"}}
	Apply(h, true, map[string]string{"X-Existing": "new"})
	if got := h.Get("X-Existing"); got != "new" {
		t.Errorf("X-Existing = %q, want new (override)", got)
	}
}

func TestApply_IgnoresEmptyNames(t *testing.T) {
	h := http.Header{}
	Apply(h, true, map[string]string{
		"   ": "blank-name",
		"":    "empty-name",
	})
	if len(h) != 0 {
		t.Errorf("header map = %v, want empty (blank names ignored)", h)
	}
}

func TestApply_RejectsCRLF(t *testing.T) {
	h := http.Header{}
	Apply(h, true, map[string]string{
		"X-Clean":            "clean",
		"X-Crlf-Name\r\nBad": "value",
		"X-Crlf-Value":       "evil\r\nInjected: yes",
	})
	if got := h.Get("X-Clean"); got != "clean" {
		t.Errorf("X-Clean = %q, want clean", got)
	}
	if h.Get("X-Crlf-Name\r\nBad") != "" || h.Get("X-Crlf-Value") != "" {
		t.Error("CR/LF-bearing entries must be skipped")
	}
	for k := range h {
		if k == "X-Crlf-Name\r\nBad" || k == "X-Crlf-Value" {
			t.Errorf("injected header present: %q", k)
		}
	}
}

func TestApply_RejectsInvalidNames(t *testing.T) {
	h := http.Header{}
	Apply(h, true, map[string]string{
		"X Valid": "bad-name",
		"X-Good":  "good",
	})
	if h.Get("X Valid") != "" {
		t.Error("invalid header name must be skipped")
	}
	if h.Get("X-Good") != "good" {
		t.Error("valid header name must be preserved")
	}
}
